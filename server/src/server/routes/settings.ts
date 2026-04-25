/**
 * Settings routes — operator-controlled feature flags.
 *
 * GET  /api/settings        Return all settings as a flat object
 * PATCH /api/settings       Update one or more settings (admin only)
 */
import { Hono } from "hono";
import { sql } from "../db.js";
import type { AuthUser } from "../auth.js";
import { requireRole } from "../auth.js";

type Vars = { Variables: { user: AuthUser } };
const routes = new Hono<Vars>();

const KNOWN_KEYS = new Set(["scripts_enabled", "agent_code_execution_enabled"]);

async function getAllSettings(): Promise<Record<string, unknown>> {
  const rows = await sql`SELECT key, value FROM settings`;
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    out[row.key as string] = row.value;
  }
  return out;
}

routes.get("/", async (c) => {
  return c.json(await getAllSettings());
});

routes.patch("/", requireRole("admin"), async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  for (const [key, value] of Object.entries(body)) {
    if (!KNOWN_KEYS.has(key)) {
      return c.json({ error: `Unknown setting key: '${key}'` }, 400);
    }
    await sql`
      INSERT INTO settings (key, value, updated_at)
      VALUES (${key}, ${JSON.stringify(value)}::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
    `;
  }
  return c.json(await getAllSettings());
});

export { routes as settingsRoutes };
