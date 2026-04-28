# Load & Performance Test Plan

Tests the Tanzen API server and worker under realistic and stress conditions.
Tools: **k6** (HTTP scenarios), **Locust** (complex multi-step flows), **k6-operator** (cluster-scale).

---

## Scope

| Layer | What we test |
|-------|-------------|
| API server | Throughput, latency, error rate under concurrent load |
| Compile endpoint | CPU-bound DSL→IR compilation at scale |
| Run submission | Temporal client saturation, Postgres write latency |
| SSE streams | Long-lived connection count; backpressure |
| Worker | Activity concurrency; token throughput with mock LLM |

Excluded from initial plan: LLM provider latency (uncontrollable), SeaweedFS write throughput (separate storage benchmark).

---

## Environments

| Env | Cluster | Workers | Purpose |
|-----|---------|---------|---------|
| Local | kind-tanzen-dev | 1 replica | Smoke, iteration |
| Staging | talos (tanzen0) | 2 replicas | Baseline + stress |
| Prod-like | talos + KEDA | Auto-scale 1–10 | Capacity planning |

---

## Test Scenarios

### Scenario 1 — API baseline (k6)

Measures p50/p95/p99 latency and error rate for common read paths.

```javascript
// k6/baseline.js
import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const TOKEN = __ENV.TOKEN;

export const options = {
  stages: [
    { duration: "30s", target: 10 },
    { duration: "2m",  target: 10 },
    { duration: "30s", target: 0  },
  ],
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed:   ["rate<0.01"],
  },
};

export default function () {
  const headers = { Authorization: `Bearer ${TOKEN}` };

  check(http.get(`${BASE}/api/workflows`, { headers }), {
    "workflows 200": (r) => r.status === 200,
  });
  check(http.get(`${BASE}/api/runs`, { headers }), {
    "runs 200": (r) => r.status === 200,
  });
  check(http.get(`${BASE}/api/agents`, { headers }), {
    "agents 200": (r) => r.status === 200,
  });

  sleep(1);
}
```

**Run:** `k6 run -e BASE_URL=http://tanzen-api:3000 -e TOKEN=<jwt> k6/baseline.js`

**Pass criteria:** p95 < 500 ms, error rate < 1 %.

---

### Scenario 2 — Compile throughput (k6)

The compiler is CPU-bound (recursive descent). This finds the saturation point.

```javascript
// k6/compile.js
import http from "k6/http";
import { check } from "k6";

const BASE  = __ENV.BASE_URL || "http://localhost:3000";
const TOKEN = __ENV.TOKEN;
const WF_ID = __ENV.WF_ID; // pre-existing workflow UUID

const DSL = `
workflow LoadTestWorkflow {
  version: "1.0.0"
  step step1 { agent: echo-agent @ "1.0" input: run.input }
  step step2 { agent: echo-agent @ "1.0" input: step1.output }
  step step3 { agent: echo-agent @ "1.0" input: step2.output }
  output { artifact: step3.output }
}`;

export const options = {
  scenarios: {
    compile_ramp: {
      executor: "ramping-arrival-rate",
      startRate: 1,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      stages: [
        { duration: "1m", target: 20 },
        { duration: "2m", target: 20 },
        { duration: "30s", target: 0  },
      ],
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<2000"],
    http_req_failed:   ["rate<0.02"],
  },
};

export default function () {
  const r = http.post(
    `${BASE}/api/workflows/${WF_ID}/compile`,
    JSON.stringify({ dsl: DSL }),
    { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } },
  );
  check(r, { "compile ok": (r) => r.status === 200 && JSON.parse(r.body).ok === true });
}
```

**Pass criteria:** p95 < 2 s at 20 rps; error rate < 2 %.

---

### Scenario 3 — Run submission burst (k6)

Submits runs rapidly to saturate the Temporal client and Postgres write path.
Uses a workflow pre-loaded with `echo-agent` so runs complete quickly.

```javascript
// k6/run-burst.js
import http from "k6/http";
import { check, sleep } from "k6";

const BASE  = __ENV.BASE_URL || "http://localhost:3000";
const TOKEN = __ENV.TOKEN;
const WF_ID = __ENV.WF_ID;

export const options = {
  scenarios: {
    burst: {
      executor: "constant-arrival-rate",
      rate: 5,            // 5 runs/s
      timeUnit: "1s",
      duration: "3m",
      preAllocatedVUs: 30,
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<3000"],
    http_req_failed:   ["rate<0.05"],
  },
};

export default function () {
  const body = JSON.stringify({ input: { text: "k6 load test" } });
  const r = http.post(
    `${BASE}/api/workflows/${WF_ID}/runs`,
    body,
    { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } },
  );
  check(r, {
    "run created": (r) => r.status === 201 || r.status === 200,
  });
  sleep(0.2);
}
```

**Watch:** Temporal task queue depth in Grafana (`temporal_task_queue_latency`).
**Pass criteria:** p95 < 3 s; no Temporal task queue backup > 100 pending tasks.

---

### Scenario 4 — SSE connection hold (k6 experimental http2)

Validates the Hono SSE endpoint holds 200 concurrent long-lived connections
without memory leak or dropped events.

```javascript
// k6/sse-hold.js
import { EventSource } from "k6/experimental/streams";
import { check, sleep } from "k6";

const BASE  = __ENV.BASE_URL || "http://localhost:3000";
const TOKEN = __ENV.TOKEN;

export const options = {
  vus: 200,
  duration: "5m",
  thresholds: {
    // Custom counter incremented per event received
    "events_received": ["count>0"],
  },
};

export default function () {
  // Each VU opens a stream for a pre-existing completed run (replays stored events)
  const runId = __ENV.COMPLETED_RUN_ID;
  const es = new EventSource(`${BASE}/api/runs/${runId}/events`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  let received = 0;
  es.onmessage = () => { received++; };

  sleep(30); // hold for 30 s
  es.close();

  check(null, { "received at least 1 event": () => received > 0 });
}
```

**Monitor:** Pod memory (should be flat); `kubectl top pod -n tanzen-dev`.

---

### Scenario 5 — Multi-step flow (Locust)

Locust models the full user journey: create workflow → compile → run → poll status.
More realistic than k6 for stateful flows.

```python
# locust/tanzen_flow.py
import json, time
from locust import HttpUser, task, between

TOKEN   = "Bearer <jwt>"
HEADERS = {"Authorization": TOKEN, "Content-Type": "application/json"}

DSL = """
workflow LocustTestWorkflow {
  version: "1.0.0"
  step echo { agent: echo-agent @ "1.0" input: run.input timeout: 2m }
  output { artifact: echo.output }
}
"""


class TanzenUser(HttpUser):
    wait_time = between(1, 3)

    def on_start(self):
        # Create a workflow once per VU
        r = self.client.post("/api/workflows",
                             json={"name": f"locust-wf-{id(self)}", "dsl": DSL},
                             headers=HEADERS)
        r.raise_for_status()
        self.wf_id = r.json()["id"]

    @task(3)
    def run_workflow(self):
        r = self.client.post(f"/api/workflows/{self.wf_id}/runs",
                             json={"input": {"text": "locust test"}},
                             headers=HEADERS)
        if r.status_code not in (200, 201):
            return
        run_id = r.json()["id"]

        # Poll for completion (max 60 s)
        for _ in range(30):
            time.sleep(2)
            poll = self.client.get(f"/api/runs/{run_id}", headers=HEADERS)
            if poll.json().get("status") in ("succeeded", "failed"):
                break

    @task(1)
    def list_runs(self):
        self.client.get("/api/runs", headers=HEADERS)

    @task(1)
    def compile_dsl(self):
        self.client.post(f"/api/workflows/{self.wf_id}/compile",
                         json={"dsl": DSL}, headers=HEADERS)
```

**Run:** `locust -f locust/tanzen_flow.py --host http://tanzen-api:3000 --users 50 --spawn-rate 5`

**Pass criteria:** median run completion < 30 s (echo-agent is fast); p95 < 60 s; failure rate < 2 %.

---

### Scenario 6 — Worker concurrency (k6 + mock LLM)

Isolates worker throughput from LLM latency by pointing agents at a mock model.
Deploy a `TestModel` shim as a local HTTP server returning instant responses.

1. Set env `ANTHROPIC_BASE_URL=http://mock-llm:8001` on the worker pod.
2. Submit 100 runs in parallel.
3. Measure worker throughput (runs/minute) and activity failure rate.

```bash
# Run 100 parallel submissions
k6 run --vus 100 --iterations 100 \
  -e BASE_URL=http://tanzen-api:3000 \
  -e TOKEN=<jwt> \
  -e WF_ID=<echo-wf-id> \
  k6/run-burst.js
```

Monitor `tanzen_activity_total` and `tanzen_activity_duration_seconds` in Grafana.

---

## Metrics to Track

| Metric | Source | Target |
|--------|--------|--------|
| API p95 latency | k6 / Grafana | < 500 ms |
| Compile p95 | k6 | < 2 s |
| Run submit p95 | k6 | < 3 s |
| Temporal queue depth | Temporal UI / Prometheus | < 100 pending |
| Worker activity error rate | `tanzen_activity_total{status="failed"}` | < 1 % |
| API pod memory | `kubectl top` | < 512 Mi steady-state |
| Worker pod memory | `kubectl top` | < 1 Gi steady-state |
| SSE connection memory growth | Pod metrics over 5 min hold | Flat (< 5 % drift) |

---

## Running on the Talos Cluster

```bash
# Port-forward the API
kubectl port-forward -n tanzen-dev svc/tanzen-api 3000:3000 &

# Baseline
k6 run -e BASE_URL=http://localhost:3000 -e TOKEN=$(tanzen auth token) k6/baseline.js

# Run burst
k6 run -e BASE_URL=http://localhost:3000 -e TOKEN=$(tanzen auth token) \
  -e WF_ID=<echo-wf-uuid> k6/run-burst.js

# Locust (50 users, 10 min)
locust -f locust/tanzen_flow.py --host http://localhost:3000 \
  --users 50 --spawn-rate 5 --run-time 10m --headless
```

## Cluster-Scale with k6-operator

For production-capacity testing, use k6-operator to distribute load across the cluster:

```yaml
# k6/k6run.yaml
apiVersion: k6.io/v1alpha1
kind: TestRun
metadata:
  name: tanzen-baseline
  namespace: tanzen-dev
spec:
  parallelism: 4
  script:
    configMap:
      name: k6-baseline-script
      file: baseline.js
  arguments: "-e BASE_URL=http://tanzen-api:3000 -e TOKEN=<jwt>"
```

---

## Directory Layout

```
k6/
  baseline.js
  compile.js
  run-burst.js
  sse-hold.js
locust/
  tanzen_flow.py
```

Create these as `docs/load-tests/` or a top-level `tests/load/` directory.
