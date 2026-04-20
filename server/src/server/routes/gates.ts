/**
 * Gate routes — list pending gates, approve/reject, SSE badge stream.
 *
 * GET   /api/gates                   List pending gates
 * GET   /api/gates/stream            SSE stream: pending gate count badge
 * POST  /api/gates/:gateId/approve   Approve gate
 * POST  /api/gates/:gateId/reject    Reject gate
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sql } from "../db.js";
import { createSubscriber, gatesChannel } from "../redis.js";
import type { AuthUser } from "../auth.js";
import { requireRole } from "../auth.js";

const PING_INTERVAL_MS = 20_000;

type Vars = { Variables: { user: AuthUser } };
const routes = new Hono<Vars>();

// GET /api/gates/stream — SSE stream for pending gate count badge
routes.get("/stream", async (c) => {
  const user = c.get("user");

  return streamSSE(c, async (stream) => {
    const sub = createSubscriber();
    const channel = gatesChannel(user.userId);

    let pingTimer: ReturnType<typeof setInterval> | null = null;

    pingTimer = setInterval(async () => {
      try {
        await stream.writeln(": ping");
      } catch {
        // Client disconnected
      }
    }, PING_INTERVAL_MS);

    // Send current count immediately
    const [countRow] = await sql`
      SELECT COUNT(*)::int AS count FROM gates
      WHERE assignee = ${user.userId} AND status = 'pending'
    `;
    try {
      await stream.writeSSE({
        data: JSON.stringify({ pending_gates: countRow?.count ?? 0 }),
        event: "gate_count",
      });
    } catch {
      // ignore
    }

    await new Promise<void>((resolve) => {
      sub.subscribe(channel, (err) => {
        if (err) {
          stream.close();
          resolve();
        }
      });

      sub.on("message", async (_chan: string, message: string) => {
        try {
          await stream.writeSSE({ data: message, event: "gate_count" });
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

// GET /api/gates
routes.get("/", async (c) => {
  const rows = await sql`
    SELECT g.id, g.run_id, g.step_id, g.assignee, g.status, g.opened_at
    FROM gates g
    WHERE g.status = 'pending'
    ORDER BY g.opened_at ASC
  `;
  return c.json({ items: rows });
});

async function signalGate(
  gateId: unknown,
  stepId: unknown,
  runId: unknown,
  userId: string,
  approved: boolean,
  notes: string | undefined,
): Promise<void> {
  await sql`
    UPDATE gates
    SET status = ${approved ? "approved" : "rejected"},
        resolved_at = now(),
        resolved_by = ${userId},
        notes = ${notes ?? null}
    WHERE id = ${gateId as string}
  `;

  const [run] = await sql`SELECT temporal_workflow_id FROM runs WHERE id = ${runId as string}`;
  if (run) {
    try {
      const { getTemporalClient } = await import("../temporal.js");
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(run.temporal_workflow_id as string);
      // step_id is required by the workflow's wait_condition correlation
      await handle.signal("gate_resolution", {
        gate_id: gateId,
        step_id: stepId,
        approved,
        rejected: !approved,
        notes: notes ?? "",
      });
    } catch {
      // Best-effort — workflow may already be complete
    }
  }
}

// POST /api/gates/:gateId/approve
routes.post("/:gateId/approve", requireRole("admin", "reviewer"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ notes?: string }>().catch(() => ({ notes: undefined }));
  const [gate] = await sql`SELECT id, run_id, step_id, status FROM gates WHERE id = ${c.req.param("gateId")!}`;
  if (!gate) return c.json({ error: "Not found" }, 404);
  if (gate.status !== "pending") return c.json({ error: "Gate already resolved" }, 409);

  await signalGate(gate.id, gate.step_id, gate.run_id, user.userId, true, body.notes);
  return c.json({ ok: true });
});

// POST /api/gates/:gateId/reject
routes.post("/:gateId/reject", requireRole("admin", "reviewer"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ notes?: string }>().catch(() => ({ notes: undefined }));
  const [gate] = await sql`SELECT id, run_id, step_id, status FROM gates WHERE id = ${c.req.param("gateId")!}`;
  if (!gate) return c.json({ error: "Not found" }, 404);
  if (gate.status !== "pending") return c.json({ error: "Gate already resolved" }, 409);

  await signalGate(gate.id, gate.step_id, gate.run_id, user.userId, false, body.notes);
  return c.json({ ok: true });
});

export { routes as gateRoutes };
