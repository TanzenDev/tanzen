/**
 * k6/compile.js — DSL compile endpoint throughput (CPU-bound).
 *
 * Usage:
 *   k6 run -e BASE_URL=http://localhost:3000 -e TOKEN=<jwt> -e WF_ID=<uuid> k6/compile.js
 *
 * WF_ID: UUID of any existing workflow (get one with: tanzen workflow list -q | head -1)
 *
 * Pass criteria: p(95) < 2 s at 20 rps, error rate < 2 %.
 */
import http from "k6/http";
import { check } from "k6";

const BASE  = __ENV.BASE_URL || "http://localhost:3000";
const TOKEN = __ENV.TOKEN    || "";
const WF_ID = __ENV.WF_ID   || "";

const DSL = `
workflow LoadTestCompile {
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
        { duration: "1m",  target: 20 },
        { duration: "2m",  target: 20 },
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
  if (!WF_ID) {
    console.error("WF_ID is required — set -e WF_ID=<workflow-uuid>");
    return;
  }
  const r = http.post(
    `${BASE}/api/workflows/${WF_ID}/compile`,
    JSON.stringify({ dsl: DSL }),
    { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } },
  );
  check(r, {
    "compile 200":    (r) => r.status === 200,
    "compile ok":     (r) => { try { return JSON.parse(r.body).ok === true; } catch { return false; } },
  });
}
