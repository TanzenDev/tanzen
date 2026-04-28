/**
 * Bundle routes — deploy and export portable .tanzen bundle files.
 *
 * A bundle is a DSL file containing any mix of agent, script, and workflow
 * declarations. Deploying a bundle upserts all declared entities atomically
 * so a workflow can be shared and reproduced on any cluster.
 *
 * POST /api/bundles           Deploy a bundle (compile + upsert all entities)
 * GET  /api/bundles/:id       Export a workflow and all its dependencies as DSL
 */
import { Hono } from "hono";
import { sql } from "../db.js";
import { putObject, getObject, WORKFLOWS_BUCKET, AGENTS_BUCKET, SCRIPTS_BUCKET } from "../s3.js";
import { compileBundle } from "../../compiler/index.js";
import type { ScriptRegistry } from "../../compiler/index.js";
import type { IRAgentDecl, IRScriptDecl, IRStep, IR } from "../../compiler/types.js";
import type { AuthUser } from "../auth.js";
import { requireRole } from "../auth.js";
import * as k8s from "@kubernetes/client-node";

type Vars = { Variables: { user: AuthUser } };
const routes = new Hono<Vars>();

// ---------------------------------------------------------------------------
// Helpers shared with other routes
// ---------------------------------------------------------------------------

function nextVersion(current: string): string {
  const parts = current.split(".").map(Number);
  parts[parts.length - 1]!++;
  return parts.join(".");
}

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

// Resolve MCP server names to in-cluster URLs via kubectl proxy (same approach as mcpServers route).
async function resolveMcpUrls(names: string[]): Promise<Array<{ url: string }>> {
  if (names.length === 0) return [];
  try {
    const kc = new k8s.KubeConfig();
    const proxyUrl = process.env["KUBECTL_PROXY_URL"];
    if (proxyUrl) {
      kc.loadFromOptions({
        clusters: [{ name: "proxy", server: proxyUrl, skipTLSVerify: true }],
        users:    [{ name: "proxy" }],
        contexts: [{ name: "proxy", cluster: "proxy", user: "proxy" }],
        currentContext: "proxy",
      });
    } else {
      kc.loadFromDefault();
      if (!process.env["KUBERNETES_SERVICE_HOST"]) {
        for (const entry of kc.clusters) { Object.assign(entry, { skipTLSVerify: true }); }
      }
    }
    const namespace = process.env["K8S_NAMESPACE"] ?? "tanzen-dev";
    const api = kc.makeApiClient(k8s.CoreV1Api);
    const result = await api.listNamespacedService({ namespace, labelSelector: "tanzen/mcp=true" });
    const services = result.items ?? [];
    const urlByName = new Map<string, string>();
    for (const svc of services) {
      const name = svc.metadata?.annotations?.["tanzen/mcp-name"] ?? svc.metadata?.name ?? "";
      const port = svc.spec?.ports?.[0]?.port ?? 3000;
      const svcName = svc.metadata?.name ?? "";
      urlByName.set(name, `http://${svcName}.${namespace}.svc.cluster.local:${port}/mcp`);
    }
    return names.map(n => ({ url: urlByName.get(n) ?? `http://${n}.${namespace}.svc.cluster.local:3000/mcp` }));
  } catch {
    // If k8s is unreachable, store placeholder URLs; operator can update later.
    const namespace = process.env["K8S_NAMESPACE"] ?? "tanzen-dev";
    return names.map(n => ({ url: `http://${n}.${namespace}.svc.cluster.local:3000/mcp` }));
  }
}

// ---------------------------------------------------------------------------
// Upsert helpers — create or bump version for each entity type
// ---------------------------------------------------------------------------

async function upsertAgent(decl: IRAgentDecl, userId: string): Promise<{ id: string; version: string; created: boolean }> {
  const mcpServers = await resolveMcpUrls(decl.mcpServers);
  const config = { system_prompt: decl.systemPrompt, mcp_servers: mcpServers };
  const configJson = JSON.stringify(config);

  const [existing] = await sql`SELECT id, current_version FROM agents WHERE name = ${decl.name}`;
  if (!existing) {
    const id = crypto.randomUUID();
    const version = "1.0.0";
    const versionId = crypto.randomUUID();
    const configKey = `${id}/${version}.json`;
    await putObject(AGENTS_BUCKET, configKey, configJson);
    await sql`INSERT INTO agents (id, name, current_version, model, created_by) VALUES (${id}, ${decl.name}, ${version}, ${decl.model}, ${userId})`;
    await sql`INSERT INTO agent_versions (id, agent_id, version, config_key, created_by) VALUES (${versionId}, ${id}, ${version}, ${configKey}, ${userId})`;
    return { id, version, created: true };
  }

  const agentId = existing.id as string;
  const newVersion = nextVersion(existing.current_version as string);
  const versionId = crypto.randomUUID();
  const configKey = `${agentId}/${newVersion}.json`;
  await putObject(AGENTS_BUCKET, configKey, configJson);
  await sql`UPDATE agents SET current_version = ${newVersion}, model = ${decl.model} WHERE id = ${agentId}`;
  await sql`INSERT INTO agent_versions (id, agent_id, version, config_key, created_by) VALUES (${versionId}, ${agentId}, ${newVersion}, ${configKey}, ${userId})`;
  return { id: agentId, version: newVersion, created: false };
}

async function upsertScript(decl: IRScriptDecl, userId: string): Promise<{ id: string; version: string; created: boolean }> {
  const ext = decl.language === "python" ? "py" : "ts";
  const [existing] = await sql`SELECT id, current_version FROM custom_scripts WHERE name = ${decl.name}`;

  if (!existing) {
    const id = crypto.randomUUID();
    const version = "1.0.0";
    const versionId = crypto.randomUUID();
    const codeKey = `${id}/${version}.${ext}`;
    await putObject(SCRIPTS_BUCKET, codeKey, decl.code);
    await sql`
      INSERT INTO custom_scripts
        (id, name, description, current_version, created_by, allowed_hosts, allowed_env, max_timeout_seconds, language)
      VALUES
        (${id}, ${decl.name}, ${decl.description ?? ""}, ${version}, ${userId},
         ${decl.allowedHosts ?? ""}, ${decl.allowedEnv ?? ""}, ${decl.maxTimeoutSeconds ?? 30}, ${decl.language})
    `;
    await sql`
      INSERT INTO custom_script_versions (id, script_id, version, code_key, created_by, language)
      VALUES (${versionId}, ${id}, ${version}, ${codeKey}, ${userId}, ${decl.language})
    `;
    return { id, version, created: true };
  }

  const scriptId = existing.id as string;
  const newVersion = nextVersion(existing.current_version as string);
  const versionId = crypto.randomUUID();
  const codeKey = `${scriptId}/${newVersion}.${ext}`;
  await putObject(SCRIPTS_BUCKET, codeKey, decl.code);
  await sql`UPDATE custom_scripts SET current_version = ${newVersion}, language = ${decl.language} WHERE id = ${scriptId}`;
  await sql`
    INSERT INTO custom_script_versions (id, script_id, version, code_key, created_by, language)
    VALUES (${versionId}, ${scriptId}, ${newVersion}, ${codeKey}, ${userId}, ${decl.language})
  `;
  return { id: scriptId, version: newVersion, created: false };
}

async function upsertWorkflow(
  workflowIR: IR,
  dslSource: string,
  userId: string,
): Promise<{ id: string; version: string; created: boolean }> {
  const [existing] = await sql`SELECT id, current_version FROM workflows WHERE name = ${workflowIR.name}`;

  if (!existing) {
    const id = crypto.randomUUID();
    const version = "1.0.0";
    const versionId = crypto.randomUUID();
    const dslKey = `${id}/${version}.dsl`;
    const irKey  = `${id}/${version}.ir.json`;
    await putObject(WORKFLOWS_BUCKET, dslKey, dslSource);
    await putObject(WORKFLOWS_BUCKET, irKey, JSON.stringify(workflowIR));
    await sql`INSERT INTO workflows (id, name, current_version, created_by) VALUES (${id}, ${workflowIR.name}, ${version}, ${userId})`;
    await sql`INSERT INTO workflow_versions (id, workflow_id, version, dsl_key, ir_key, created_by) VALUES (${versionId}, ${id}, ${version}, ${dslKey}, ${irKey}, ${userId})`;
    return { id, version, created: true };
  }

  const workflowId = existing.id as string;
  const newVersion = nextVersion(existing.current_version as string);
  const versionId = crypto.randomUUID();
  const dslKey = `${workflowId}/${newVersion}.dsl`;
  const irKey  = `${workflowId}/${newVersion}.ir.json`;
  await putObject(WORKFLOWS_BUCKET, dslKey, dslSource);
  await putObject(WORKFLOWS_BUCKET, irKey, JSON.stringify(workflowIR));
  await sql`UPDATE workflows SET current_version = ${newVersion} WHERE id = ${workflowId}`;
  await sql`INSERT INTO workflow_versions (id, workflow_id, version, dsl_key, ir_key, created_by) VALUES (${versionId}, ${workflowId}, ${newVersion}, ${dslKey}, ${irKey}, ${userId})`;
  return { id: workflowId, version: newVersion, created: false };
}

// ---------------------------------------------------------------------------
// POST /api/bundles — deploy
// ---------------------------------------------------------------------------

routes.post("/", requireRole("admin", "author"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ dsl: string }>();
  if (!body.dsl) return c.json({ error: "dsl is required" }, 400);

  const scriptRegistry = await loadScriptRegistry();
  const result = compileBundle(body.dsl, scriptRegistry);
  if (!result.ok) return c.json({ errors: result.errors }, 422);

  const { bundle } = result;
  const deployedAgents: Array<{ name: string; id: string; version: string; created: boolean }> = [];
  const deployedScripts: Array<{ name: string; id: string; version: string; created: boolean }> = [];
  const deployedWorkflows: Array<{ name: string; id: string; version: string; created: boolean }> = [];

  for (const agent of bundle.agents) {
    const r = await upsertAgent(agent, user.userId);
    deployedAgents.push({ name: agent.name, ...r });
  }

  for (const script of bundle.scripts) {
    const r = await upsertScript(script, user.userId);
    deployedScripts.push({ name: script.name, ...r });
  }

  // Re-compile workflows against the freshly deployed script versions so IR
  // has correct s3Keys (not the placeholder "bundle" entries from the first pass).
  const freshRegistry = await loadScriptRegistry();
  const freshResult = compileBundle(body.dsl, freshRegistry);
  const freshBundle = freshResult.ok ? freshResult.bundle : bundle;

  for (const workflowIR of freshBundle.workflows) {
    const r = await upsertWorkflow(workflowIR, body.dsl, user.userId);
    deployedWorkflows.push({ name: workflowIR.name, ...r });
  }

  return c.json({ agents: deployedAgents, scripts: deployedScripts, workflows: deployedWorkflows }, 201);
});

// ---------------------------------------------------------------------------
// GET /api/bundles/:id — export a workflow + its agent/script dependencies as DSL
// ---------------------------------------------------------------------------

function collectRefs(steps: IRStep[]): { agentNames: Set<string>; scriptNames: Set<string> } {
  const agentNames = new Set<string>();
  const scriptNames = new Set<string>();
  for (const step of steps) {
    if (step.type === "agent")  agentNames.add(step.agentId);
    if (step.type === "script") scriptNames.add(step.scriptName);
    if (step.type === "parallel") {
      if (step.template) agentNames.add(step.template.agentId);
      for (const s of step.steps ?? []) agentNames.add(s.agentId);
    }
  }
  return { agentNames, scriptNames };
}

function escapeTriple(s: string): string {
  return s.replace(/"""/g, '\\"\\"\\"');
}

function formatAgentDsl(name: string, model: string, systemPrompt: string, mcpNames: string[]): string {
  const mcpLines = mcpNames.map(n => `  mcp: ${n}`).join("\n");
  return [
    `agent ${name} {`,
    `  model: "${model}"`,
    `  system_prompt: """`,
    escapeTriple(systemPrompt),
    `  """`,
    ...(mcpLines ? [mcpLines] : []),
    `}`,
  ].join("\n");
}

function formatScriptDsl(s: IRScriptDecl): string {
  const lines = [
    `script ${s.name} {`,
    `  language: ${s.language}`,
  ];
  if (s.description) lines.push(`  description: "${s.description}"`);
  if (s.allowedHosts) lines.push(`  allowed_hosts: "${s.allowedHosts}"`);
  if (s.allowedEnv)   lines.push(`  allowed_env: "${s.allowedEnv}"`);
  if (s.maxTimeoutSeconds) lines.push(`  max_timeout_seconds: ${s.maxTimeoutSeconds}`);
  lines.push(`  code: """`, escapeTriple(s.code), `  """`);
  lines.push(`}`);
  return lines.join("\n");
}

routes.get("/:id", requireRole("admin", "author"), async (c) => {
  const workflowId = c.req.param("id")!;

  // Load workflow metadata
  const [workflow] = await sql`
    SELECT w.name, wv.ir_key, wv.dsl_key
    FROM workflows w
    JOIN workflow_versions wv ON wv.workflow_id = w.id AND wv.version = w.current_version
    WHERE w.id = ${workflowId}
  `;
  if (!workflow) return c.json({ error: "Not found" }, 404);

  // Load IR to find dependencies
  let ir: IR;
  try {
    ir = JSON.parse(await getObject(WORKFLOWS_BUCKET, workflow.ir_key as string));
  } catch {
    return c.json({ error: "Could not load workflow IR" }, 500);
  }

  const { agentNames, scriptNames } = collectRefs(ir.steps);

  // Reconstruct agent DSL blocks
  const agentDslBlocks: string[] = [];
  for (const agentName of agentNames) {
    const [agent] = await sql`
      SELECT a.name, a.model, av.config_key
      FROM agents a
      JOIN agent_versions av ON av.agent_id = a.id AND av.version = a.current_version
      WHERE a.name = ${agentName}
    `;
    if (!agent) continue;
    try {
      const configJson = await getObject(AGENTS_BUCKET, agent.config_key as string);
      const config = JSON.parse(configJson) as { system_prompt: string; mcp_servers: Array<{ url: string }> };
      // Reverse-resolve MCP URLs to names (best-effort: extract last path segment of hostname)
      const mcpNames = (config.mcp_servers ?? []).map((s: { url: string }) => {
        const host = new URL(s.url).hostname;
        return host.split(".")[0] ?? host;
      });
      agentDslBlocks.push(formatAgentDsl(agent.name as string, agent.model as string, config.system_prompt, mcpNames));
    } catch { /* skip agents whose config can't be loaded */ }
  }

  // Reconstruct script DSL blocks
  const scriptDslBlocks: string[] = [];
  for (const scriptName of scriptNames) {
    const [script] = await sql`
      SELECT s.name, s.language, s.description, s.allowed_hosts, s.allowed_env, s.max_timeout_seconds,
             sv.code_key
      FROM custom_scripts s
      JOIN custom_script_versions sv ON sv.script_id = s.id AND sv.version = s.current_version
      WHERE s.name = ${scriptName}
    `;
    if (!script) continue;
    try {
      const code = await getObject(SCRIPTS_BUCKET, script.code_key as string);
      const decl: IRScriptDecl = {
        name: script.name as string,
        language: (script.language as "typescript" | "python") ?? "typescript",
        code,
      };
      if (script.description)        decl.description = script.description as string;
      if (script.allowed_hosts)      decl.allowedHosts = script.allowed_hosts as string;
      if (script.allowed_env)        decl.allowedEnv = script.allowed_env as string;
      if (script.max_timeout_seconds) decl.maxTimeoutSeconds = script.max_timeout_seconds as number;
      scriptDslBlocks.push(formatScriptDsl(decl));
    } catch { /* skip scripts whose code can't be loaded */ }
  }

  // Workflow DSL (stored verbatim)
  let workflowDsl = "";
  try {
    workflowDsl = await getObject(WORKFLOWS_BUCKET, workflow.dsl_key as string);
  } catch {
    return c.json({ error: "Could not load workflow DSL" }, 500);
  }

  const parts = [...agentDslBlocks, ...scriptDslBlocks, workflowDsl].filter(Boolean);
  const bundleDsl = parts.join("\n\n");

  return c.text(bundleDsl, 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Disposition": `attachment; filename="${workflow.name as string}.tanzen"`,
  });
});

export { routes as bundleRoutes };
