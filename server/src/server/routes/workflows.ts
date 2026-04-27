/**
 * Workflow CRUD and compile/run routes.
 *
 * POST   /api/workflows                 Create workflow
 * GET    /api/workflows                 List workflows (paginated)
 * GET    /api/workflows/:id             Get workflow detail
 * GET    /api/workflows/:id/dsl         Fetch current DSL text from S3
 * POST   /api/workflows/:id/compile     Validate + compile DSL
 * POST   /api/workflows/:id/runs        Initiate a run
 * GET    /api/workflows/:id/runs        List runs for workflow
 */
import { Hono } from "hono";
import { sql } from "../db.js";
import { putObject, getObject, WORKFLOWS_BUCKET } from "../s3.js";
import { startWorkflowRun } from "../temporal.js";
import { compile } from "../../compiler/index.js";
import type { ScriptRegistry } from "../../compiler/index.js";
import type { AuthUser } from "../auth.js";
import { requireRole } from "../auth.js";

async function loadScriptRegistry(): Promise<ScriptRegistry> {
  const rows = await sql`
    SELECT cs.name, cs.language, cs.allowed_hosts, cs.allowed_env, cs.max_timeout_seconds,
           csv.version, csv.code_key AS s3_key
    FROM custom_scripts cs
    JOIN custom_script_versions csv
      ON csv.script_id = cs.id AND csv.version = cs.current_version
  `;
  return new Map(rows.map((r) => [
    r.name as string,
    {
      version: r.version as string,
      s3Key: r.s3_key as string,
      language: (r.language as string) ?? "typescript",
      allowedHosts: r.allowed_hosts as string,
      allowedEnv: r.allowed_env as string,
      maxTimeoutSeconds: r.max_timeout_seconds as number,
    },
  ]));
}

type Vars = { Variables: { user: AuthUser } };
const routes = new Hono<Vars>();

// POST /api/workflows
routes.post("/", requireRole("admin", "author"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ name: string; dsl: string }>();
  if (!body.name || !body.dsl) return c.json({ error: "name and dsl are required" }, 400);

  const scriptRegistry = await loadScriptRegistry();
  const result = compile(body.dsl, scriptRegistry);
  if (!result.ok) return c.json({ errors: result.errors }, 422);

  const id = crypto.randomUUID();
  const version = "1.0.0";
  const versionId = crypto.randomUUID();

  const dslKey = `${id}/${version}.dsl`;
  const irKey  = `${id}/${version}.ir.json`;

  await putObject(WORKFLOWS_BUCKET, dslKey, body.dsl);
  await putObject(WORKFLOWS_BUCKET, irKey, JSON.stringify(result.ir));

  await sql`
    INSERT INTO workflows (id, name, current_version, created_by)
    VALUES (${id}, ${body.name}, ${version}, ${user.userId})
  `;
  await sql`
    INSERT INTO workflow_versions (id, workflow_id, version, dsl_key, ir_key, created_by)
    VALUES (${versionId}, ${id}, ${version}, ${dslKey}, ${irKey}, ${user.userId})
  `;

  return c.json({ id, name: body.name, version }, 201);
});

// GET /api/workflows
routes.get("/", async (c) => {
  const limit  = Number(c.req.query("limit")  ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);
  const rows = await sql`
    SELECT id, name, current_version, created_at, created_by
    FROM workflows
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return c.json({ items: rows, limit, offset });
});

// GET /api/workflows/:id
routes.get("/:id", async (c) => {
  const [row] = await sql`
    SELECT w.id, w.name, w.current_version, w.created_at, w.created_by,
           json_agg(
             json_build_object(
               'version', wv.version,
               'dsl_key', wv.dsl_key,
               'ir_key', wv.ir_key,
               'created_at', wv.created_at,
               'promoted', wv.promoted
             ) ORDER BY wv.created_at
           ) AS versions
    FROM workflows w
    LEFT JOIN workflow_versions wv ON wv.workflow_id = w.id
    WHERE w.id = ${c.req.param("id")!}
    GROUP BY w.id
  `;
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

// GET /api/workflows/:id/dsl — fetch current version's DSL text from S3
routes.get("/:id/dsl", async (c) => {
  const [row] = await sql`
    SELECT wv.dsl_key FROM workflow_versions wv
    JOIN workflows w ON w.id = wv.workflow_id AND w.current_version = wv.version
    WHERE wv.workflow_id = ${c.req.param("id")!}
  `;
  if (!row) return c.json({ error: "Not found" }, 404);
  const dsl = await getObject(WORKFLOWS_BUCKET, row.dsl_key as string);
  return c.json({ dsl });
});

// POST /api/workflows/:id/compile
routes.post("/:id/compile", requireRole("admin", "author"), async (c) => {
  const body = await c.req.json<{ dsl: string }>();
  if (!body.dsl) return c.json({ error: "dsl is required" }, 400);

  const scriptRegistry = await loadScriptRegistry();
  const result = compile(body.dsl, scriptRegistry);
  if (!result.ok) return c.json({ ok: false, errors: result.errors }, 422);
  return c.json({ ok: true, ir: result.ir });
});

// POST /api/workflows/:id/runs
routes.post("/:id/runs", requireRole("admin", "author"), async (c) => {
  const user = c.get("user");
  const [workflow] = await sql`SELECT id, current_version FROM workflows WHERE id = ${c.req.param("id")!}`;
  if (!workflow) return c.json({ error: "Not found" }, 404);

  const workflowId = workflow.id as string;
  const workflowVersion = workflow.current_version as string;
  const [wv] = await sql`
    SELECT ir_key FROM workflow_versions
    WHERE workflow_id = ${workflowId} AND version = ${workflowVersion}
  `;
  if (!wv) return c.json({ error: "No compiled version found" }, 409);

  const body = await c.req.json<{ params?: Record<string, unknown> }>().catch(() => ({ params: {} }));
  const runParams = body.params ?? {};

  // Fetch the IR from S3
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { s3 } = await import("../s3.js");
  const obj = await s3.send(new GetObjectCommand({ Bucket: WORKFLOWS_BUCKET, Key: wv.ir_key as string }));
  const irText = await obj.Body?.transformToString() ?? "{}";
  const ir: Record<string, unknown> = JSON.parse(irText);

  const runId = `run-${workflow.id}-${Date.now()}`;

  const temporalId = await startWorkflowRun(runId, ir, runParams);

  await sql`
    INSERT INTO runs (id, workflow_id, workflow_version, triggered_by, temporal_workflow_id)
    VALUES (${runId}, ${workflowId}, ${workflowVersion}, ${user.userId}, ${temporalId})
  `;

  return c.json({ runId, temporalWorkflowId: temporalId }, 202);
});

// GET /api/workflows/:id/runs
routes.get("/:id/runs", async (c) => {
  const limit  = Number(c.req.query("limit")  ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);
  const rows = await sql`
    SELECT id, workflow_version, status, triggered_by, started_at, completed_at
    FROM runs
    WHERE workflow_id = ${c.req.param("id")!}
    ORDER BY started_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return c.json({ items: rows, limit, offset });
});

// POST /api/workflows/:id/promote
routes.post("/:id/promote", requireRole("admin"), async (c) => {
  const workflowId = c.req.param("id")!;
  const [workflow] = await sql`SELECT id, current_version FROM workflows WHERE id = ${workflowId}`;
  if (!workflow) return c.json({ error: "Not found" }, 404);

  const version = workflow.current_version as string;
  const [existing] = await sql`
    SELECT id FROM workflow_versions WHERE workflow_id = ${workflowId} AND version = ${version}
  `;
  if (!existing) return c.json({ error: "Version not found" }, 404);

  // Clear any previous promotion, then promote current version
  await sql`UPDATE workflow_versions SET promoted = FALSE WHERE workflow_id = ${workflowId}`;
  await sql`UPDATE workflow_versions SET promoted = TRUE WHERE workflow_id = ${workflowId} AND version = ${version}`;

  return c.json({ id: workflowId, version, promoted: true });
});

// DELETE /api/workflows/:id
routes.delete("/:id", requireRole("admin"), async (c) => {
  const workflowId = c.req.param("id")!;
  const [wf] = await sql`SELECT id FROM workflows WHERE id = ${workflowId}`;
  if (!wf) return c.json({ error: "Not found" }, 404);
  // Cascade: remove run children before runs, then workflow children
  await sql`DELETE FROM gates      WHERE run_id IN (SELECT id FROM runs WHERE workflow_id = ${workflowId})`;
  await sql`DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE workflow_id = ${workflowId})`;
  await sql`DELETE FROM run_steps  WHERE run_id IN (SELECT id FROM runs WHERE workflow_id = ${workflowId})`;
  await sql`DELETE FROM runs              WHERE workflow_id = ${workflowId}`;
  await sql`DELETE FROM workflow_versions WHERE workflow_id = ${workflowId}`;
  await sql`DELETE FROM workflows         WHERE id          = ${workflowId}`;
  return c.json({ deleted: true });
});

export { routes as workflowRoutes };
