/**
 * k6/baseline.js — API read-path latency and error-rate baseline.
 *
 * Usage:
 *   k6 run -e BASE_URL=http://localhost:3000 -e TOKEN=<jwt> k6/baseline.js
 *
 * Pass criteria: p(95) < 500 ms, error rate < 1 %.
 */
import http from "k6/http";
import { check, sleep } from "k6";

const BASE  = __ENV.BASE_URL || "http://localhost:3000";
const TOKEN = __ENV.TOKEN    || "";

export const options = {
  stages: [
    { duration: "30s", target: 10  },
    { duration: "2m",  target: 10  },
    { duration: "30s", target: 0   },
  ],
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed:   ["rate<0.01"],
  },
};

const headers = () => ({
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
});

export default function () {
  check(http.get(`${BASE}/api/workflows`, { headers: headers() }), {
    "workflows 200": (r) => r.status === 200,
  });
  check(http.get(`${BASE}/api/runs`, { headers: headers() }), {
    "runs 200": (r) => r.status === 200,
  });
  check(http.get(`${BASE}/api/agents`, { headers: headers() }), {
    "agents 200": (r) => r.status === 200,
  });
  sleep(1);
}
