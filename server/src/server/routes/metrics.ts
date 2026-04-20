/**
 * Metrics route — aggregate run statistics from Postgres.
 *
 * GET /api/metrics
 *
 * Query params: workflow_id, from, to (ISO dates)
 */
import { Hono } from "hono";
import { sql } from "../db.js";

const routes = new Hono();

routes.get("/", async (c) => {
  const workflowId = c.req.query("workflow_id");
  const from = c.req.query("from") ?? new Date(Date.now() - 30 * 86400_000).toISOString();
  const to   = c.req.query("to")   ?? new Date().toISOString();

  const baseFilter = workflowId
    ? sql`AND workflow_id = ${workflowId}`
    : sql``;

  const [summary] = await sql`
    SELECT
      COUNT(*)::int                                                        AS total_runs,
      COUNT(*) FILTER (WHERE status = 'succeeded')::int                   AS succeeded,
      COUNT(*) FILTER (WHERE status = 'failed')::int                      AS failed,
      COUNT(*) FILTER (WHERE status = 'running')::int                     AS running,
      AVG(EXTRACT(EPOCH FROM (completed_at - started_at)))::float         AS avg_duration_s
    FROM runs
    WHERE started_at BETWEEN ${from}::timestamptz AND ${to}::timestamptz
    ${baseFilter}
  `;

  const byWorkflow = await sql`
    SELECT workflow_id, COUNT(*)::int AS run_count,
           COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded
    FROM runs
    WHERE started_at BETWEEN ${from}::timestamptz AND ${to}::timestamptz
    GROUP BY workflow_id
    ORDER BY run_count DESC
    LIMIT 20
  `;

  const tokenSummary = await sql`
    SELECT agent_id, SUM(token_count)::int AS total_tokens, SUM(cost_usd)::float AS total_cost
    FROM run_steps rs
    JOIN runs r ON r.id = rs.run_id
    WHERE r.started_at BETWEEN ${from}::timestamptz AND ${to}::timestamptz
    ${workflowId ? sql`AND r.workflow_id = ${workflowId}` : sql``}
    GROUP BY agent_id
    ORDER BY total_tokens DESC
    LIMIT 20
  `;

  const taskMetrics = await sql`
    SELECT rs.action,
           COUNT(*)::int                      AS call_count,
           AVG(rs.duration_ms)::float         AS avg_duration_ms,
           MAX(rs.duration_ms)::float         AS max_duration_ms
    FROM run_steps rs
    JOIN runs r ON r.id = rs.run_id
    WHERE rs.step_type = 'task'
      AND r.started_at BETWEEN ${from}::timestamptz AND ${to}::timestamptz
      ${workflowId ? sql`AND r.workflow_id = ${workflowId}` : sql``}
    GROUP BY rs.action
    ORDER BY call_count DESC
  `;

  return c.json({ summary, byWorkflow, tokenSummary, taskMetrics, from, to });
});

export { routes as metricsRoutes };
