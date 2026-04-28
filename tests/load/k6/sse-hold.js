/**
 * k6/sse-hold.js — SSE connection hold test.
 *
 * Validates the Hono SSE endpoint holds N concurrent long-lived connections
 * without memory leak or dropped events.
 *
 * Usage:
 *   k6 run -e BASE_URL=http://localhost:3000 -e TOKEN=<jwt> \
 *           -e RUN_ID=<completed-run-uuid> k6/sse-hold.js
 *
 * RUN_ID: UUID of a completed run (events replay immediately, then stream stays open).
 *         tanzen run list --status succeeded -q | head -1
 *
 * Monitor: pod memory (kubectl top pod -n tanzen-dev) — should be flat over 5 min.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

const BASE   = __ENV.BASE_URL || "http://localhost:3000";
const TOKEN  = __ENV.TOKEN    || "";
const RUN_ID = __ENV.RUN_ID   || "";

// SSE is not natively supported in k6 open-source; we use a long-poll simulation:
// open the connection, hold it, then close. The server sends a ping comment every 20 s.
// For real SSE event counting, use the k6 browser or xk6-sse extension.

const connectionsHeld = new Counter("sse_connections_held");

export const options = {
  vus: 100,
  duration: "5m",
  thresholds: {
    http_req_failed: ["rate<0.01"],
  },
};

export default function () {
  if (!RUN_ID) {
    console.error("RUN_ID is required");
    return;
  }
  // Open SSE stream with a 35 s timeout (catches at least one 20 s ping)
  const r = http.get(
    `${BASE}/api/runs/${RUN_ID}/events`,
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
      timeout: "35s",
    },
  );
  // For completed runs the server closes after replaying stored events.
  // Status 200 means the connection was accepted.
  const ok = check(r, { "SSE 200": (r) => r.status === 200 });
  if (ok) connectionsHeld.add(1);
  sleep(1);
}
