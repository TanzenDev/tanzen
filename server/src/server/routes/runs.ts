/**
 * Run detail, artifact presign, and event streaming routes.
 *
 * GET  /api/runs                        List all runs
 * GET  /api/runs/:runId                 Get run detail
 * GET  /api/runs/:runId/events          SSE stream for run events
 * GET  /api/runs/:runId/artifacts/:key  Presigned redirect to artifact
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sql } from "../db.js";
import { getObject, ARTIFACTS_BUCKET } from "../s3.js";
import { createSubscriber, runChannel } from "../redis.js";

const PING_INTERVAL_MS = 20_000;

const routes = new Hono();

// GET /api/runs
routes.get("/", async (c) => {
  const limit  = Number(c.req.query("limit")  ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);
  const status = c.req.query("status");

  const rows = status
    ? await sql`
        SELECT id, workflow_id, workflow_version, status, triggered_by, started_at, completed_at
        FROM runs WHERE status = ${status}
        ORDER BY started_at DESC LIMIT ${limit} OFFSET ${offset}
      `
    : await sql`
        SELECT id, workflow_id, workflow_version, status, triggered_by, started_at, completed_at
        FROM runs
        ORDER BY started_at DESC LIMIT ${limit} OFFSET ${offset}
      `;

  return c.json({ items: rows, limit, offset });
});

// GET /api/runs/:runId
routes.get("/:runId", async (c) => {
  const runId = c.req.param("runId")!;
  const [run] = await sql`
    SELECT r.id, r.workflow_id, r.workflow_version, r.status,
           r.triggered_by, r.started_at, r.completed_at,
           r.temporal_workflow_id, r.error,
           COALESCE(json_agg(
             json_build_object(
               'id', rs.id, 'step_id', rs.step_id,
               'agent_id', rs.agent_id, 'agent_version', rs.agent_version,
               'step_type', rs.step_type, 'action', rs.action,
               'status', rs.status,
               'started_at', rs.started_at, 'completed_at', rs.completed_at,
               'input_artifact_key', rs.input_artifact_key,
               'output_artifact_key', rs.output_artifact_key,
               'token_count', rs.token_count, 'cost_usd', rs.cost_usd,
               'duration_ms', rs.duration_ms, 'error', rs.error
             ) ORDER BY rs.started_at
           ) FILTER (WHERE rs.id IS NOT NULL), '[]') AS steps
    FROM runs r
    LEFT JOIN run_steps rs ON rs.run_id = r.id
    WHERE r.id = ${runId}
    GROUP BY r.id
  `;
  if (!run) return c.json({ error: "Not found" }, 404);

  const events = await sql`
    SELECT id, event_type, step_id, data, ts
    FROM run_events
    WHERE run_id = ${runId}
    ORDER BY ts ASC
  `;

  // If the run-level error is Temporal's generic wrapper, surface the real
  // error from the step_failed event or from a failed step record instead.
  let effectiveError: string | null = run.error ?? null;
  if (!effectiveError || effectiveError === "Activity task failed") {
    const stepFailedEvent = (events as unknown as Array<{ event_type: string; data: Record<string, unknown> }>)
      .find(e => e.event_type === "step_failed");
    if (stepFailedEvent?.data?.error) {
      effectiveError = String(stepFailedEvent.data.error);
    } else {
      const failedStep = (run.steps as Array<{ status: string; error?: string | null }>)
        ?.find(s => s.status === "failed" && s.error);
      if (failedStep?.error) effectiveError = failedStep.error;
    }
  }

  return c.json({ ...run, error: effectiveError, events });
});

// GET /api/runs/:runId/events — SSE stream for a single run
routes.get("/:runId/events", async (c) => {
  const runId = c.req.param("runId")!;

  const [run] = await sql`SELECT id FROM runs WHERE id = ${runId}`;
  if (!run) return c.json({ error: "Not found" }, 404);

  return streamSSE(c, async (stream) => {
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

    // Send initial event so the client knows the stream is live
    try {
      await stream.writeSSE({ data: JSON.stringify({ event_type: "connected", run_id: runId }), event: "connected" });
    } catch { /* ignore */ }

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

// GET /api/runs/:runId/artifacts/*
// Proxies artifact JSON from S3 — avoids browser CORS issues with SeaweedFS.
routes.get("/:runId/artifacts/*", async (c) => {
  const runId = c.req.param("runId");
  const [run] = await sql`SELECT id FROM runs WHERE id = ${runId}`;
  if (!run) return c.json({ error: "Not found" }, 404);

  // Extract everything after /artifacts/
  const rawPath = c.req.path;
  const marker = `/artifacts/`;
  const keyStart = rawPath.indexOf(marker);
  if (keyStart === -1) return c.json({ error: "Bad request" }, 400);
  const key = decodeURIComponent(rawPath.slice(keyStart + marker.length));

  // Validate the key belongs to this run
  if (!key.startsWith(`runs/${runId}/`)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const body = await getObject(ARTIFACTS_BUCKET, key);
  return c.json(JSON.parse(body));
});

// DELETE /api/runs/:runId
routes.delete("/:runId", async (c) => {
  const runId = c.req.param("runId")!;
  const [run] = await sql`SELECT id FROM runs WHERE id = ${runId}`;
  if (!run) return c.json({ error: "Not found" }, 404);
  await sql`DELETE FROM run_events WHERE run_id = ${runId}`;
  await sql`DELETE FROM run_steps WHERE run_id = ${runId}`;
  await sql`DELETE FROM gates WHERE run_id = ${runId}`;
  await sql`DELETE FROM runs WHERE id = ${runId}`;
  return c.json({ deleted: true });
});

export { routes as runRoutes };
