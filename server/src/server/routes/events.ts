/**
 * SSE event streaming routes — mounted at /api/runs.
 *
 * GET /api/runs/:runId/events
 *   Streams run events (step_started, step_completed, gate_opened, …) from
 *   the Redis pub/sub channel `run:{runId}` to the browser as SSE.
 *
 * Both endpoints:
 *   - Send a `ping` comment every 20 s to keep connections alive through
 *     proxies and load balancers.
 *   - Clean up the Redis subscriber when the client disconnects.
 *
 * Note: GET /api/gates/stream lives in gates.ts (mounted at /api/gates).
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sql } from "../db.js";
import { createSubscriber, runChannel } from "../redis.js";
import type { AuthUser } from "../auth.js";

type Vars = { Variables: { user: AuthUser } };
const routes = new Hono<Vars>();

const PING_INTERVAL_MS = 20_000;

// ---------------------------------------------------------------------------
// GET /api/runs/:runId/events — SSE stream for a single run
// ---------------------------------------------------------------------------

routes.get("/:runId/events", async (c) => {
  const runId = c.req.param("runId")!;

  // Validate run exists and get its status
  const [run] = await sql`SELECT id, status FROM runs WHERE id = ${runId}`;
  if (!run) return c.json({ error: "Not found" }, 404);

  const isTerminal = run.status === "succeeded" || run.status === "failed";

  return streamSSE(c, async (stream) => {
    // For completed runs: replay stored events from DB and close immediately.
    if (isTerminal) {
      const events = await sql`
        SELECT event_type, step_id, data, ts
        FROM run_events
        WHERE run_id = ${runId}
        ORDER BY ts ASC
      `;
      for (const ev of events) {
        const payload = JSON.stringify({
          event_type: ev.event_type,
          run_id: runId,
          step_id: ev.step_id ?? undefined,
          ts: ev.ts,
          ...((ev.data as Record<string, unknown>) ?? {}),
        });
        await stream.writeSSE({ data: payload, event: "run_event" });
      }
      stream.close();
      return;
    }

    // For active runs: subscribe to Redis and stream live events.
    const sub = createSubscriber();
    const channel = runChannel(runId);

    let pingTimer: ReturnType<typeof setInterval> | null = null;

    pingTimer = setInterval(async () => {
      try {
        await stream.writeln(": ping");
      } catch {
        // Client disconnected
      }
    }, PING_INTERVAL_MS);

    await new Promise<void>((resolve) => {
      sub.subscribe(channel, (err) => {
        if (err) {
          stream.close();
          resolve();
        }
      });

      sub.on("message", async (_chan: string, message: string) => {
        try {
          await stream.writeSSE({ data: message, event: "run_event" });
          // Close stream on run_completed or run_failed
          const parsed = JSON.parse(message) as { event_type?: string };
          if (parsed.event_type === "run_completed" || parsed.event_type === "run_failed") {
            resolve();
          }
        } catch {
          resolve();
        }
      });

      sub.on("error", () => resolve());
    });

    if (pingTimer) clearInterval(pingTimer);
    await sub.quit().catch(() => {});
  });
});

export { routes as eventRoutes };
