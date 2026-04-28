/**
 * k6/run-burst.js — Run submission burst (Temporal client + Postgres write path).
 *
 * Usage:
 *   k6 run -e BASE_URL=http://localhost:3000 -e TOKEN=<jwt> -e WF_ID=<uuid> k6/run-burst.js
 *
 * WF_ID: UUID of the echo workflow (loads fast; gate/science workflows would block).
 *        tanzen workflow list -q | grep echo | head -1
 *
 * Monitor: Temporal task queue depth in Grafana (temporal_task_queue_latency).
 * Pass criteria: p(95) < 3 s, no queue backup > 100 pending tasks.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

const BASE  = __ENV.BASE_URL || "http://localhost:3000";
const TOKEN = __ENV.TOKEN    || "";
const WF_ID = __ENV.WF_ID   || "";

const runsStarted = new Counter("runs_started");

export const options = {
  scenarios: {
    burst: {
      executor: "constant-arrival-rate",
      rate: 5,
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
  if (!WF_ID) {
    console.error("WF_ID is required");
    return;
  }
  const r = http.post(
    `${BASE}/api/workflows/${WF_ID}/runs`,
    JSON.stringify({ input: { text: "k6 load test", ts: Date.now() } }),
    { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } },
  );
  const ok = check(r, { "run created": (r) => r.status === 200 || r.status === 201 || r.status === 202 });
  if (ok) runsStarted.add(1);
  sleep(0.2);
}
