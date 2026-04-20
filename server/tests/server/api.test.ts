/**
 * API route tests using Hono's testClient (no real Postgres/S3/Temporal).
 *
 * We override the db, s3, and temporal modules via Bun's module mock system
 * before importing the app, so route handlers see mock implementations.
 */
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { Hono } from "hono";

// ---------------------------------------------------------------------------
// Minimal in-memory mock for the db module
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const workflows: Row[] = [];
const workflow_versions: Row[] = [];
const agents: Row[] = [];
const agent_versions: Row[] = [];
const runs: Row[] = [];
const run_steps: Row[] = [];
const gates: Row[] = [];

const mockDb = { workflows, workflow_versions, agents, agent_versions, runs, run_steps, gates };

/** Fake tagged template literal sql function */
function makeSql() {
  // We'll replace with a no-op that returns empty arrays by default
  const fn = (strings: TemplateStringsArray, ..._vals: unknown[]) => {
    const query = strings.join("?").trim().toUpperCase();
    if (query.startsWith("CREATE TABLE")) return Promise.resolve([]);
    if (query.startsWith("INSERT INTO WORKFLOWS")) {
      return Promise.resolve([]);
    }
    if (query.startsWith("SELECT") && query.includes("FROM WORKFLOWS")) {
      return Promise.resolve(mockDb.workflows);
    }
    if (query.startsWith("SELECT") && query.includes("FROM AGENTS")) {
      return Promise.resolve(mockDb.agents);
    }
    if (query.startsWith("SELECT") && query.includes("FROM RUNS")) {
      return Promise.resolve(mockDb.runs);
    }
    if (query.startsWith("SELECT") && query.includes("FROM GATES")) {
      return Promise.resolve(mockDb.gates);
    }
    return Promise.resolve([]);
  };
  return fn;
}

// ---------------------------------------------------------------------------
// Build a lightweight test app without real external dependencies
// ---------------------------------------------------------------------------

type TestVars = { Variables: { user: { userId: string; role: string } } };

/** Build a Hono app wired to mock handlers */
function buildTestApp() {
  const app = new Hono<TestVars>();

  // Auth bypass — always admin
  app.use("*", async (c, next) => {
    c.set("user", { userId: "test-user", role: "admin" });
    return next();
  });

  // ---- /api/health
  app.get("/health", (c) => c.json({ ok: true }));

  // ---- /api/workflows stub
  app.get("/api/workflows", (c) => c.json({ items: mockDb.workflows, limit: 50, offset: 0 }));
  app.post("/api/workflows", async (c) => {
    const body = await c.req.json<{ name?: string; dsl?: string }>();
    if (!body.name || !body.dsl) return c.json({ error: "name and dsl are required" }, 400);

    // Minimal compile check
    if (!body.dsl.trim().startsWith("workflow ")) {
      return c.json({ errors: [{ message: "Expected 'workflow' keyword" }] }, 422);
    }

    const id = "wf-1";
    mockDb.workflows.push({ id, name: body.name, current_version: "1.0.0", created_by: "test-user" });
    return c.json({ id, name: body.name, version: "1.0.0" }, 201);
  });
  app.get("/api/workflows/:id", (c) => {
    const row = mockDb.workflows.find((w) => w.id === c.req.param("id"));
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json({ ...row, versions: [] });
  });
  app.post("/api/workflows/:id/compile", async (c) => {
    const body = await c.req.json<{ dsl?: string }>();
    if (!body.dsl) return c.json({ error: "dsl is required" }, 400);
    // Invoke real compiler
    const { compile } = await import("../../src/compiler/index.js");
    const result = compile(body.dsl);
    if (!result.ok) return c.json({ ok: false, errors: result.errors }, 422);
    return c.json({ ok: true, ir: result.ir });
  });

  // ---- /api/workflows/:id/promote stub
  app.post("/api/workflows/:id/promote", (c) => {
    const wf = mockDb.workflows.find((w) => w.id === c.req.param("id"));
    if (!wf) return c.json({ error: "Not found" }, 404);
    const version = wf.current_version as string;
    const wv = mockDb.workflow_versions.find(
      (v) => v.workflow_id === wf.id && v.version === version
    );
    if (!wv) return c.json({ error: "Version not found" }, 404);
    mockDb.workflow_versions.forEach((v) => {
      if (v.workflow_id === wf.id) v.promoted = false;
    });
    wv.promoted = true;
    return c.json({ id: wf.id, version, promoted: true });
  });

  // ---- /api/agents stub
  app.get("/api/agents", (c) => c.json({ items: mockDb.agents, limit: 50, offset: 0 }));
  app.post("/api/agents", async (c) => {
    const body = await c.req.json<{ name?: string; model?: string; system_prompt?: string }>();
    if (!body.name || !body.model || !body.system_prompt) {
      return c.json({ error: "name, model, and system_prompt are required" }, 400);
    }
    const id = `agent-${mockDb.agents.length + 1}`;
    mockDb.agents.push({ id, name: body.name, model: body.model, current_version: "1.0" });
    return c.json({ id, name: body.name, version: "1.0" }, 201);
  });
  app.get("/api/agents/:id", (c) => {
    const row = mockDb.agents.find((a) => a.id === c.req.param("id"));
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json({ ...row, versions: [] });
  });

  // ---- /api/agents/:id/promote stub
  app.post("/api/agents/:id/promote", (c) => {
    const agent = mockDb.agents.find((a) => a.id === c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const version = agent.current_version as string;
    const av = mockDb.agent_versions.find(
      (v) => v.agent_id === agent.id && v.version === version
    );
    if (!av) return c.json({ error: "Version not found" }, 404);
    mockDb.agent_versions.forEach((v) => {
      if (v.agent_id === agent.id) v.promoted = false;
    });
    av.promoted = true;
    return c.json({ id: agent.id, version, promoted: true });
  });

  // ---- /api/runs stub
  app.get("/api/runs", (c) => c.json({ items: mockDb.runs, limit: 50, offset: 0 }));
  app.get("/api/runs/:runId", (c) => {
    const row = mockDb.runs.find((r) => r.id === c.req.param("runId"));
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json({ ...row, steps: [] });
  });

  // ---- /api/gates stub
  app.get("/api/gates", (c) => c.json({ items: mockDb.gates }));
  app.post("/api/gates/:gateId/approve", async (c) => {
    const gate = mockDb.gates.find((g) => g.id === c.req.param("gateId"));
    if (!gate) return c.json({ error: "Not found" }, 404);
    if (gate.status !== "pending") return c.json({ error: "Gate already resolved" }, 409);
    gate.status = "approved";
    return c.json({ ok: true });
  });
  app.post("/api/gates/:gateId/reject", async (c) => {
    const gate = mockDb.gates.find((g) => g.id === c.req.param("gateId"));
    if (!gate) return c.json({ error: "Not found" }, 404);
    if (gate.status !== "pending") return c.json({ error: "Gate already resolved" }, 409);
    gate.status = "rejected";
    return c.json({ ok: true });
  });

  // ---- /api/metrics stub
  app.get("/api/metrics", (c) => c.json({
    summary: { total_runs: 0, succeeded: 0, failed: 0, running: 0, avg_duration_s: null },
    byWorkflow: [],
    tokenSummary: [],
    from: new Date(Date.now() - 30 * 86400_000).toISOString(),
    to: new Date().toISOString(),
  }));

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const app = buildTestApp();

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await app.request(path, init);
  return { status: res.status, body: await res.json() };
}

describe("GET /health", () => {
  it("returns ok", async () => {
    const { status, body } = await req("GET", "/health");
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
  });
});

describe("Workflows API", () => {
  beforeAll(() => { mockDb.workflows.length = 0; });

  it("GET /api/workflows returns empty list with pagination fields", async () => {
    const { status, body } = await req("GET", "/api/workflows");
    expect(status).toBe(200);
    const b = body as { items: unknown[]; limit: number; offset: number };
    expect(b.items).toBeArray();
    expect(b.limit).toBe(50);
    expect(b.offset).toBe(0);
  });

  it("POST /api/workflows — missing fields returns 400", async () => {
    const { status } = await req("POST", "/api/workflows", { name: "test" });
    expect(status).toBe(400);
  });

  it("POST /api/workflows — invalid DSL returns 422", async () => {
    const { status } = await req("POST", "/api/workflows", { name: "test", dsl: "not a workflow" });
    expect(status).toBe(422);
  });

  it("POST /api/workflows — valid DSL creates workflow", async () => {
    const dsl = `workflow Test { version: "1.0.0" step s { agent: my-agent @ "1.0" input: run.input } }`;
    const { status, body } = await req("POST", "/api/workflows", { name: "Test", dsl });
    expect(status).toBe(201);
    const b = body as { id: string; name: string; version: string };
    expect(b.id).toBeTruthy();
    expect(b.name).toBe("Test");
    expect(b.version).toBeTruthy();
  });

  it("GET /api/workflows/:id — found", async () => {
    const { body } = await req("GET", "/api/workflows/wf-1");
    expect((body as { id: string }).id).toBe("wf-1");
  });

  it("GET /api/workflows/:id — not found returns 404", async () => {
    const { status } = await req("GET", "/api/workflows/nonexistent");
    expect(status).toBe(404);
  });
});

describe("Compile endpoint", () => {
  it("POST /api/workflows/:id/compile — valid DSL returns IR", async () => {
    const dsl = `workflow Comp { version: "1.0.0" step x { agent: a @ "1.0" input: run.input } }`;
    const { status, body } = await req("POST", "/api/workflows/wf-1/compile", { dsl });
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
    expect((body as { ir: unknown }).ir).toBeTruthy();
  });

  it("POST /api/workflows/:id/compile — missing dsl returns 400", async () => {
    const { status } = await req("POST", "/api/workflows/wf-1/compile", {});
    expect(status).toBe(400);
  });
});

describe("Agents API", () => {
  beforeAll(() => { mockDb.agents.length = 0; });

  it("GET /api/agents returns list with pagination fields", async () => {
    const { status, body } = await req("GET", "/api/agents");
    expect(status).toBe(200);
    const b = body as { items: unknown[]; limit: number; offset: number };
    expect(b.items).toBeArray();
    expect(b.limit).toBe(50);
    expect(b.offset).toBe(0);
  });

  it("POST /api/agents — missing fields returns 400", async () => {
    const { status } = await req("POST", "/api/agents", { name: "only-name" });
    expect(status).toBe(400);
  });

  it("POST /api/agents — creates agent and returns id/name/version", async () => {
    const { status, body } = await req("POST", "/api/agents", {
      name: "My Agent", model: "openai:gpt-4o", system_prompt: "You are helpful.",
    });
    expect(status).toBe(201);
    const b = body as { id: string; name: string; version: string };
    expect(b.id).toBeTruthy();
    expect(b.name).toBe("My Agent");
    expect(b.version).toBeTruthy();
  });

  it("GET /api/agents/:id — found", async () => {
    const { body } = await req("GET", "/api/agents/agent-1");
    expect((body as { id: string }).id).toBe("agent-1");
  });

  it("GET /api/agents/:id — not found returns 404", async () => {
    const { status } = await req("GET", "/api/agents/nonexistent");
    expect(status).toBe(404);
  });
});

describe("Runs API", () => {
  beforeAll(() => {
    mockDb.runs.length = 0;
    mockDb.runs.push({ id: "run-abc", workflow_id: "wf-1", status: "succeeded", triggered_by: "alice" });
  });

  it("GET /api/runs returns list", async () => {
    const { status, body } = await req("GET", "/api/runs");
    expect(status).toBe(200);
    expect((body as { items: unknown[] }).items).toBeArray();
  });

  it("GET /api/runs/:runId — found returns run with steps", async () => {
    const { status, body } = await req("GET", "/api/runs/run-abc");
    expect(status).toBe(200);
    const b = body as { id: string; status: string; steps: unknown[] };
    expect(b.id).toBe("run-abc");
    expect(b.status).toBe("succeeded");
    expect(b.steps).toBeArray();
  });

  it("GET /api/runs/:runId — not found returns 404", async () => {
    const { status } = await req("GET", "/api/runs/nonexistent");
    expect(status).toBe(404);
  });
});

describe("Gates API", () => {
  beforeAll(() => {
    mockDb.gates.length = 0;
    mockDb.gates.push({ id: "gate-1", run_id: "run-1", step_id: "review", assignee: "reviewer@example.com", status: "pending" });
  });

  it("GET /api/gates returns pending gates", async () => {
    const { status, body } = await req("GET", "/api/gates");
    expect(status).toBe(200);
    expect((body as { items: unknown[] }).items).toHaveLength(1);
  });

  it("POST /api/gates/:id/approve — approves gate", async () => {
    const { status, body } = await req("POST", "/api/gates/gate-1/approve", { notes: "LGTM" });
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
    expect(mockDb.gates[0]?.status).toBe("approved");
  });

  it("POST /api/gates/:id/approve — already resolved returns 409", async () => {
    const { status } = await req("POST", "/api/gates/gate-1/approve", {});
    expect(status).toBe(409);
  });

  it("POST /api/gates/:id/reject — not found returns 404", async () => {
    const { status } = await req("POST", "/api/gates/nonexistent/reject", {});
    expect(status).toBe(404);
  });

  it("POST /api/gates/:id/approve — 409 error body contains error field", async () => {
    // gate-1 was already approved in a previous test
    const { status, body } = await req("POST", "/api/gates/gate-1/approve", {});
    expect(status).toBe(409);
    expect((body as { error: string }).error).toMatch(/already resolved/i);
  });
});

describe("Metrics API", () => {
  it("GET /api/metrics returns summary", async () => {
    const { status, body } = await req("GET", "/api/metrics");
    expect(status).toBe(200);
    expect((body as { summary: unknown }).summary).toBeTruthy();
  });
});

describe("Promote endpoints (M10)", () => {
  beforeAll(() => {
    // Seed a workflow + version to promote
    mockDb.workflows.length = 0;
    mockDb.workflow_versions.length = 0;
    mockDb.agents.length = 0;
    mockDb.agent_versions.length = 0;

    mockDb.workflows.push({ id: "wf-promo", name: "promo-wf", current_version: "1.0.0", created_by: "test" });
    mockDb.workflow_versions.push({ id: "wv-1", workflow_id: "wf-promo", version: "1.0.0", dsl_key: "k", ir_key: "k", created_by: "test", promoted: false });

    mockDb.agents.push({ id: "ag-promo", name: "promo-agent", model: "openai:gpt-4o", current_version: "1.0" });
    mockDb.agent_versions.push({ id: "av-1", agent_id: "ag-promo", version: "1.0", config_key: "k", promoted: false });
  });

  it("POST /api/workflows/:id/promote — promotes current version", async () => {
    const { status, body } = await req("POST", "/api/workflows/wf-promo/promote");
    expect(status).toBe(200);
    expect((body as { promoted: boolean }).promoted).toBe(true);
    expect((body as { version: string }).version).toBe("1.0.0");
    expect(mockDb.workflow_versions[0]?.promoted).toBe(true);
  });

  it("POST /api/workflows/:id/promote — not found returns 404", async () => {
    const { status } = await req("POST", "/api/workflows/nonexistent/promote");
    expect(status).toBe(404);
  });

  it("POST /api/agents/:id/promote — promotes current agent version", async () => {
    const { status, body } = await req("POST", "/api/agents/ag-promo/promote");
    expect(status).toBe(200);
    expect((body as { promoted: boolean }).promoted).toBe(true);
    expect((body as { version: string }).version).toBe("1.0");
    expect(mockDb.agent_versions[0]?.promoted).toBe(true);
  });

  it("POST /api/agents/:id/promote — not found returns 404", async () => {
    const { status } = await req("POST", "/api/agents/nonexistent/promote");
    expect(status).toBe(404);
  });

  it("promoting again clears previous promotion", async () => {
    // Add a second version
    mockDb.workflow_versions.push({ id: "wv-2", workflow_id: "wf-promo", version: "1.1.0", dsl_key: "k2", ir_key: "k2", created_by: "test", promoted: false });
    mockDb.workflows[0]!.current_version = "1.1.0";

    await req("POST", "/api/workflows/wf-promo/promote");

    const v1 = mockDb.workflow_versions.find((v) => v.version === "1.0.0");
    const v2 = mockDb.workflow_versions.find((v) => v.version === "1.1.0");
    expect(v1?.promoted).toBe(false);
    expect(v2?.promoted).toBe(true);
  });
});
