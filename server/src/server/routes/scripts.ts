/**
 * Custom script registry routes.
 *
 * POST   /api/scripts              Create script (admin only)
 * GET    /api/scripts              List scripts
 * GET    /api/scripts/:id          Detail + version history + current code
 * GET    /api/scripts/:id/code     Current version source code
 * PUT    /api/scripts/:id          Update (creates new version, admin only)
 * POST   /api/scripts/:id/promote  Promote current version (admin only)
 * DELETE /api/scripts/:id          Delete (admin only)
 */
import { Hono } from "hono";
import { sql } from "../db.js";
import { putObject, getObject, SCRIPTS_BUCKET } from "../s3.js";
import type { AuthUser } from "../auth.js";
import { requireRole } from "../auth.js";

type Vars = { Variables: { user: AuthUser } };
const routes = new Hono<Vars>();

function nextVersion(current: string): string {
  const parts = current.split(".");
  const minor = parseInt(parts[1] ?? "0", 10) + 1;
  return `${parts[0]}.${minor}`;
}

// POST /api/scripts
routes.post("/", requireRole("admin"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    name: string;
    description?: string;
    code: string;
    allowed_hosts?: string;
    allowed_env?: string;
    max_timeout_seconds?: number;
  }>();

  if (!body.name || !body.code) {
    return c.json({ error: "name and code are required" }, 400);
  }
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(body.name)) {
    return c.json({ error: "name must be lowercase alphanumeric/hyphens, 1–63 chars" }, 400);
  }
  if (body.code.length > 512_000) {
    return c.json({ error: "code must be ≤ 512 000 characters" }, 400);
  }
  if (body.max_timeout_seconds !== undefined &&
      (body.max_timeout_seconds < 1 || body.max_timeout_seconds > 300)) {
    return c.json({ error: "max_timeout_seconds must be 1–300" }, 400);
  }

  const id = crypto.randomUUID();
  const version = "1.0";
  const versionId = crypto.randomUUID();
  const codeKey = `${id}/${version}.ts`;

  await putObject(SCRIPTS_BUCKET, codeKey, body.code);
  await sql`
    INSERT INTO custom_scripts
      (id, name, description, current_version, created_by, allowed_hosts, allowed_env, max_timeout_seconds)
    VALUES
      (${id}, ${body.name}, ${body.description ?? ""}, ${version}, ${user.userId},
       ${body.allowed_hosts ?? ""}, ${body.allowed_env ?? ""}, ${body.max_timeout_seconds ?? 30})
  `;
  await sql`
    INSERT INTO custom_script_versions (id, script_id, version, code_key, created_by)
    VALUES (${versionId}, ${id}, ${version}, ${codeKey}, ${user.userId})
  `;

  return c.json({ id, name: body.name, version }, 201);
});

// GET /api/scripts
routes.get("/", async (c) => {
  const limit  = Number(c.req.query("limit")  ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);
  const rows = await sql`
    SELECT id, name, description, current_version, created_by, created_at,
           allowed_hosts, allowed_env, max_timeout_seconds
    FROM custom_scripts
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return c.json({ items: rows, limit, offset });
});

// GET /api/scripts/:id
routes.get("/:id", async (c) => {
  const [script] = await sql`
    SELECT s.id, s.name, s.description, s.current_version, s.created_by, s.created_at,
           s.allowed_hosts, s.allowed_env, s.max_timeout_seconds,
           json_agg(
             json_build_object(
               'version', sv.version,
               'code_key', sv.code_key,
               'created_by', sv.created_by,
               'created_at', sv.created_at,
               'promoted', sv.promoted
             ) ORDER BY sv.created_at
           ) AS versions
    FROM custom_scripts s
    LEFT JOIN custom_script_versions sv ON sv.script_id = s.id
    WHERE s.id = ${c.req.param("id")!}
    GROUP BY s.id
  `;
  if (!script) return c.json({ error: "Not found" }, 404);

  // Also fetch current code
  const versions = script.versions as Array<{ version: string; code_key: string }>;
  const current = versions.find((v) => v.version === script.current_version);
  let code = "";
  if (current?.code_key) {
    try { code = await getObject(SCRIPTS_BUCKET, current.code_key); } catch { /* ignore */ }
  }

  return c.json({ ...script, code });
});

// GET /api/scripts/:id/code
routes.get("/:id/code", async (c) => {
  const [sv] = await sql`
    SELECT csv.code_key
    FROM custom_scripts s
    JOIN custom_script_versions csv ON csv.script_id = s.id AND csv.version = s.current_version
    WHERE s.id = ${c.req.param("id")!}
  `;
  if (!sv) return c.json({ error: "Not found" }, 404);
  const code = await getObject(SCRIPTS_BUCKET, sv.code_key as string);
  return c.json({ code });
});

// PUT /api/scripts/:id
routes.put("/:id", requireRole("admin"), async (c) => {
  const user = c.get("user");
  const [script] = await sql`SELECT id, current_version FROM custom_scripts WHERE id = ${c.req.param("id")!}`;
  if (!script) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{
    code?: string;
    description?: string;
    allowed_hosts?: string;
    allowed_env?: string;
    max_timeout_seconds?: number;
  }>();

  const scriptId = script.id as string;
  const newVersion = nextVersion(script.current_version as string);
  const versionId = crypto.randomUUID();
  const codeKey = `${scriptId}/${newVersion}.ts`;

  if (body.code) {
    await putObject(SCRIPTS_BUCKET, codeKey, body.code);
  } else {
    // No code change — copy current version's code key
    const [cv] = await sql`
      SELECT code_key FROM custom_script_versions
      WHERE script_id = ${scriptId} AND version = ${script.current_version as string}
    `;
    if (cv) await putObject(SCRIPTS_BUCKET, codeKey, await getObject(SCRIPTS_BUCKET, cv.code_key as string));
  }

  await sql`
    INSERT INTO custom_script_versions (id, script_id, version, code_key, created_by)
    VALUES (${versionId}, ${scriptId}, ${newVersion}, ${codeKey}, ${user.userId})
  `;
  await sql`UPDATE custom_scripts SET current_version = ${newVersion} WHERE id = ${scriptId}`;

  if (body.description !== undefined) await sql`UPDATE custom_scripts SET description = ${body.description} WHERE id = ${scriptId}`;
  if (body.allowed_hosts !== undefined) await sql`UPDATE custom_scripts SET allowed_hosts = ${body.allowed_hosts} WHERE id = ${scriptId}`;
  if (body.allowed_env !== undefined) await sql`UPDATE custom_scripts SET allowed_env = ${body.allowed_env} WHERE id = ${scriptId}`;
  if (body.max_timeout_seconds !== undefined) await sql`UPDATE custom_scripts SET max_timeout_seconds = ${body.max_timeout_seconds} WHERE id = ${scriptId}`;

  return c.json({ id: scriptId, version: newVersion });
});

// POST /api/scripts/:id/promote
routes.post("/:id/promote", requireRole("admin"), async (c) => {
  const scriptId = c.req.param("id")!;
  const [script] = await sql`SELECT id, current_version FROM custom_scripts WHERE id = ${scriptId}`;
  if (!script) return c.json({ error: "Not found" }, 404);

  await sql`UPDATE custom_script_versions SET promoted = FALSE WHERE script_id = ${scriptId}`;
  await sql`UPDATE custom_script_versions SET promoted = TRUE WHERE script_id = ${scriptId} AND version = ${script.current_version as string}`;

  return c.json({ id: scriptId, version: script.current_version, promoted: true });
});

// DELETE /api/scripts/:id
routes.delete("/:id", requireRole("admin"), async (c) => {
  const scriptId = c.req.param("id")!;
  const [script] = await sql`SELECT id FROM custom_scripts WHERE id = ${scriptId}`;
  if (!script) return c.json({ error: "Not found" }, 404);
  await sql`DELETE FROM custom_script_versions WHERE script_id = ${scriptId}`;
  await sql`DELETE FROM custom_scripts WHERE id = ${scriptId}`;
  return c.json({ deleted: true });
});

export { routes as scriptRoutes };
