/**
 * k6/worker-concurrency.js — Worker activity concurrency test.
 *
 * Submits N runs in parallel to saturate the worker, then polls until all
 * complete. Designed to run against a mock LLM (set ANTHROPIC_BASE_URL on
 * the worker pod) so latency is not LLM-bound.
 *
 * Usage:
 *   k6 run -e BASE_URL=http://localhost:3000 -e TOKEN=<jwt> \
 *           -e WF_ID=<echo-wf-uuid> -e CONCURRENCY=20 k6/worker-concurrency.js
 *
 * Monitor: tanzen_activity_total and tanzen_activity_duration_seconds in Grafana.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE        = __ENV.BASE_URL    || "http://localhost:3000";
const TOKEN       = __ENV.TOKEN       || "";
const WF_ID       = __ENV.WF_ID       || "";
const CONCURRENCY = parseInt(__ENV.CONCURRENCY || "20", 10);

const runsCompleted = new Counter("runs_completed");
const runDuration   = new Trend("run_duration_ms");

export const options = {
  scenarios: {
    concurrent_runs: {
      executor: "shared-iterations",
      vus: CONCURRENCY,
      iterations: CONCURRENCY,
      maxDuration: "10m",
    },
  },
  thresholds: {
    run_duration_ms: ["p(95)<60000"],  // 95th percentile < 60 s (echo agent is fast)
    http_req_failed: ["rate<0.05"],
  },
};

export default function () {
  if (!WF_ID) {
    console.error("WF_ID required");
    return;
  }

  // Submit run
  const startMs = Date.now();
  const startResp = http.post(
    `${BASE}/api/workflows/${WF_ID}/runs`,
    JSON.stringify({ input: { text: "concurrency test", vu: __VU } }),
    { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } },
  );
  if (!check(startResp, { "run created": (r) => r.status === 200 || r.status === 201 || r.status === 202 })) {
    return;
  }
  const runId = startResp.json("id") || startResp.json("runId");
  if (!runId) return;

  // Poll until completed (max 120 s)
  for (let i = 0; i < 60; i++) {
    sleep(2);
    const pollResp = http.get(
      `${BASE}/api/runs/${runId}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    const status = pollResp.json("status");
    if (status === "succeeded" || status === "failed") {
      runsCompleted.add(1);
      runDuration.add(Date.now() - startMs);
      break;
    }
  }
}
