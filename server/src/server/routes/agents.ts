/**
 * Agent CRUD routes.
 *
 * POST   /api/agents          Create agent
 * GET    /api/agents          List agents
 * GET    /api/agents/:id      Get agent detail
 * PUT    /api/agents/:id      Update agent (increments version)
 */
import { Hono } from "hono";
import { sql } from "../db.js";
import { putObject, AGENTS_BUCKET } from "../s3.js";
import type { AuthUser } from "../auth.js";
import { requireRole } from "../auth.js";

type Vars = { Variables: { user: AuthUser } };
const routes = new Hono<Vars>();

type AgentConfigBody = {
  name: string;
  model: string;
  system_prompt: string;
  mcp_servers?: Array<{ url: string }>;
  secrets?: string[];
  max_tokens?: number;
  temperature?: number;
  retries?: number;
};

function nextVersion(current: string): string {
  const parts = current.split(".");
  const minor = parseInt(parts[1] ?? "0", 10) + 1;
  return `${parts[0]}.${minor}`;
}

// POST /api/agents
const ALLOWED_MODELS = new Set([
  "openai:gpt-4o", "openai:gpt-4o-mini", "openai:gpt-4-turbo",
  "anthropic:claude-opus-4-6", "anthropic:claude-sonnet-4-6", "anthropic:claude-haiku-4-5",
  "google:gemini-1.5-pro", "google:gemini-1.5-flash",
  "groq:llama-3.3-70b-versatile", "groq:llama-3.1-8b-instant", "groq:mixtral-8x7b-32768",
  "test",
]);

routes.post("/", requireRole("admin", "author"), async (c) => {
  const body = await c.req.json<AgentConfigBody>();
  if (!body.name || !body.model || !body.system_prompt) {
    return c.json({ error: "name, model, and system_prompt are required" }, 400);
  }
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(body.name)) {
    return c.json({ error: "name must be lowercase alphanumeric/hyphens, 1–63 chars" }, 400);
  }
  if (!ALLOWED_MODELS.has(body.model)) {
    return c.json({ error: `model must be one of: ${[...ALLOWED_MODELS].join(", ")}` }, 400);
  }
  if (body.system_prompt.length > 32_768) {
    return c.json({ error: "system_prompt must be ≤ 32 768 characters" }, 400);
  }
  if (body.max_tokens !== undefined && (body.max_tokens < 1 || body.max_tokens > 128_000)) {
    return c.json({ error: "max_tokens must be 1–128 000" }, 400);
  }
  if (body.temperature !== undefined && (body.temperature < 0 || body.temperature > 2)) {
    return c.json({ error: "temperature must be 0–2" }, 400);
  }

  const id      = crypto.randomUUID();
  const version = "1.0";
  const versionId = crypto.randomUUID();
  const config = {
    id, version, ...body,
    mcp_servers: body.mcp_servers ?? [],
    secrets:     body.secrets ?? [],
    max_tokens:  body.max_tokens ?? 4096,
    temperature: body.temperature ?? 0.1,
    retries:     body.retries ?? 1,
  };
  const configKey = `${id}/${version}.json`;

  await putObject(AGENTS_BUCKET, configKey, JSON.stringify(config));
  await sql`INSERT INTO agents (id, name, current_version, model) VALUES (${id}, ${body.name}, ${version}, ${body.model})`;
  await sql`INSERT INTO agent_versions (id, agent_id, version, config_key) VALUES (${versionId}, ${id}, ${version}, ${configKey})`;

  return c.json({ id, name: body.name, version }, 201);
});

// GET /api/agents
routes.get("/", async (c) => {
  const limit  = Number(c.req.query("limit")  ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);
  const rows = await sql`
    SELECT a.id, a.name, a.current_version, a.model, a.created_at, av.config_key
    FROM agents a
    LEFT JOIN agent_versions av ON av.agent_id = a.id AND av.version = a.current_version
    ORDER BY a.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { s3, AGENTS_BUCKET: bucket } = await import("../s3.js");

  const items = await Promise.all(rows.map(async (row) => {
    const { config_key, ...agent } = row as Record<string, unknown>;
    if (!config_key) return agent;
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket as string, Key: config_key as string }));
      const cfg = JSON.parse(await (obj.Body as { transformToString(): Promise<string> }).transformToString() ?? "{}");
      return { ...agent, mcp_servers: cfg.mcp_servers ?? [] };
    } catch {
      return agent;
    }
  }));

  return c.json({ items, limit, offset });
});

// GET /api/agents/:id
routes.get("/:id", async (c) => {
  const [agent] = await sql`
    SELECT a.id, a.name, a.current_version, a.model, a.created_at,
           json_agg(
             json_build_object(
               'version', av.version,
               'config_key', av.config_key,
               'created_at', av.created_at,
               'promoted', av.promoted
             ) ORDER BY av.created_at
           ) AS versions
    FROM agents a
    LEFT JOIN agent_versions av ON av.agent_id = a.id
    WHERE a.id = ${c.req.param("id")!}
    GROUP BY a.id
  `;
  if (!agent) return c.json({ error: "Not found" }, 404);

  // Read system_prompt and mcp_servers from the current version's S3 config
  const versions = agent.versions as Array<{ version: string; config_key: string }>;
  const currentEntry = versions.find((v) => v.version === agent.current_version);
  if (currentEntry?.config_key) {
    try {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const { s3, AGENTS_BUCKET: bucket } = await import("../s3.js");
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: currentEntry.config_key }));
      const cfg = JSON.parse(await (obj.Body as { transformToString(): Promise<string> }).transformToString() ?? "{}");
      return c.json({ ...agent, system_prompt: cfg.system_prompt ?? "", mcp_servers: cfg.mcp_servers ?? [] });
    } catch {
      // fall through and return without config fields
    }
  }
  return c.json(agent);
});

// PUT /api/agents/:id
routes.put("/:id", requireRole("admin", "author"), async (c) => {
  const [agent] = await sql`SELECT id, current_version FROM agents WHERE id = ${c.req.param("id")!}`;
  if (!agent) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<Partial<AgentConfigBody>>();
  const agentId = agent.id as string;
  const currentVersion = agent.current_version as string;
  const newVersion = nextVersion(currentVersion);
  const versionId  = crypto.randomUUID();

  // Fetch existing config to merge
  const [av] = await sql`SELECT config_key FROM agent_versions WHERE agent_id = ${agentId} AND version = ${currentVersion}`;
  if (!av) return c.json({ error: "Current version config not found" }, 500);
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { s3, AGENTS_BUCKET: bucket } = await import("../s3.js");
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: av.config_key as string }));
  const existing = JSON.parse(await obj.Body?.transformToString() ?? "{}");

  const updated = { ...existing, ...body, id: agentId, version: newVersion };
  const configKey = `${agentId}/${newVersion}.json`;

  await putObject(AGENTS_BUCKET, configKey, JSON.stringify(updated));
  await sql`INSERT INTO agent_versions (id, agent_id, version, config_key) VALUES (${versionId}, ${agentId}, ${newVersion}, ${configKey})`;
  await sql`UPDATE agents SET current_version = ${newVersion} WHERE id = ${agentId}`;

  return c.json({ id: agentId, version: newVersion });
});

// POST /api/agents/:id/promote
routes.post("/:id/promote", requireRole("admin"), async (c) => {
  const agentId = c.req.param("id")!;
  const [agent] = await sql`SELECT id, current_version FROM agents WHERE id = ${agentId}`;
  if (!agent) return c.json({ error: "Not found" }, 404);

  const version = agent.current_version as string;
  const [existing] = await sql`
    SELECT id FROM agent_versions WHERE agent_id = ${agentId} AND version = ${version}
  `;
  if (!existing) return c.json({ error: "Version not found" }, 404);

  // Clear any previous promotion, then promote current version
  await sql`UPDATE agent_versions SET promoted = FALSE WHERE agent_id = ${agentId}`;
  await sql`UPDATE agent_versions SET promoted = TRUE WHERE agent_id = ${agentId} AND version = ${version}`;

  return c.json({ id: agentId, version, promoted: true });
});

// DELETE /api/agents/:id
routes.delete("/:id", requireRole("admin"), async (c) => {
  const agentId = c.req.param("id")!;
  const [agent] = await sql`SELECT id FROM agents WHERE id = ${agentId}`;
  if (!agent) return c.json({ error: "Not found" }, 404);
  await sql`DELETE FROM agent_versions WHERE agent_id = ${agentId}`;
  await sql`DELETE FROM agents WHERE id = ${agentId}`;
  return c.json({ deleted: true });
});

export { routes as agentRoutes };
