/**
 * Typed API client — thin wrapper over fetch.
 * All requests go to /api/* (proxied by Vite in dev, served by Hono in prod).
 */

const BASE = "/api";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string; errors?: Array<{ message: string }> };
    if (err.errors?.length) throw new Error(err.errors.map(e => e.message).join("\n"));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

async function requestText(method: string, path: string, body?: unknown): Promise<string> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error ?? res.statusText);
  }
  return res.text();
}

// ---------- Types ----------

export interface Workflow {
  id: string;
  name: string;
  current_version: string;
  created_at: string;
  created_by: string;
  versions?: WorkflowVersion[];
}

export interface WorkflowVersion {
  version: string;
  dsl_key: string;
  ir_key: string;
  created_at: string;
  promoted?: boolean;
}

export interface Agent {
  id: string;
  name: string;
  current_version: string;
  model: string;
  system_prompt?: string;
  mcp_servers?: Array<{ url: string }>;
  created_at: string;
  versions?: AgentVersion[];
}

export interface AgentVersion {
  version: string;
  config_key: string;
  created_at: string;
  promoted?: boolean;
}

export interface Run {
  id: string;
  workflow_id: string;
  workflow_version: string;
  status: "running" | "succeeded" | "failed" | "awaiting_gate";
  triggered_by: string;
  started_at: string;
  completed_at?: string;
  temporal_workflow_id?: string;
  error?: string | null;
  steps?: RunStep[];
  events?: RunEvent[];
}

export interface RunStep {
  id: string;
  step_id: string;
  agent_id?: string;
  agent_version?: string;
  step_type: string;
  action?: string;
  status: string;
  started_at: string;
  completed_at?: string;
  input_artifact_key?: string;
  output_artifact_key?: string;
  token_count: number;
  cost_usd: number;
  duration_ms?: number;
  error?: string | null;
}

export interface RunEvent {
  id: string;
  event_type: string;
  step_id: string | null;
  data: Record<string, unknown>;
  ts: number;
}

export interface Gate {
  id: string;
  run_id: string;
  step_id: string;
  assignee: string;
  status: "pending" | "approved" | "rejected";
  opened_at: string;
}

export interface CompileResult {
  ok: boolean;
  ir?: unknown;
  errors?: Array<{ line: number; column: number; message: string; severity: string }>;
}

export interface Metrics {
  summary: {
    total_runs: number;
    succeeded: number;
    failed: number;
    running: number;
    avg_duration_s: number | null;
  };
  byWorkflow: Array<{ workflow_id: string; run_count: number; succeeded: number }>;
  tokenSummary: Array<{ agent_id: string; total_tokens: number; total_cost: number }>;
  taskMetrics: Array<{ action: string; call_count: number; avg_duration_ms: number | null; max_duration_ms: number | null }>;
  from: string;
  to: string;
}

export interface Secret {
  name: string;
  createdAt?: string;
}

export interface MCPServer {
  name: string;
  url: string;
  description: string;
  transport: string;
}

export interface Script {
  id: string;
  name: string;
  description: string;
  current_version: string;
  created_by: string;
  created_at: string;
  allowed_hosts: string;
  allowed_env: string;
  max_timeout_seconds: number;
  language: "typescript" | "python";
  code?: string;
  versions?: Array<{ version: string; code_key: string; created_at: string; promoted: boolean }>;
}

export interface Settings {
  scripts_enabled: boolean;
  agent_code_execution_enabled: boolean;
}

export interface BundleEntityResult {
  name: string;
  id: string;
  version: string;
  created: boolean;
}

export interface BundleDeployResult {
  agents: BundleEntityResult[];
  scripts: BundleEntityResult[];
  workflows: BundleEntityResult[];
}

export interface StepSnapshot {
  id: string;
  run_id: string;
  step_id: string;
  checkpoint_key: string;
  has_state: boolean;
  created_at: string;
}

// ---------- Workflows ----------

export const api = {
  workflows: {
    list: (p = { limit: 50, offset: 0 }) =>
      request<{ items: Workflow[] }>("GET", `/workflows?limit=${p.limit}&offset=${p.offset}`),
    get: (id: string) => request<Workflow>("GET", `/workflows/${id}`),
    create: (body: { name: string; dsl: string }) =>
      request<{ id: string; name: string; version: string }>("POST", "/workflows", body),
    dsl: (id: string) =>
      request<{ dsl: string }>("GET", `/workflows/${id}/dsl`),
    compile: (id: string, dsl: string) =>
      request<CompileResult>("POST", `/workflows/${id}/compile`, { dsl }),
    startRun: (id: string, params: Record<string, unknown> = {}) =>
      request<{ runId: string }>("POST", `/workflows/${id}/runs`, { params }),
    listRuns: (id: string) =>
      request<{ items: Run[] }>("GET", `/workflows/${id}/runs`),
    promote: (id: string) =>
      request<{ version: string }>("POST", `/workflows/${id}/promote`),
    delete: (id: string) => request("DELETE", `/workflows/${id}`),
  },

  agents: {
    list: (p = { limit: 50, offset: 0 }) =>
      request<{ items: Agent[] }>("GET", `/agents?limit=${p.limit}&offset=${p.offset}`),
    get: (id: string) => request<Agent>("GET", `/agents/${id}`),
    create: (body: Omit<Agent, "id" | "current_version" | "created_at">) =>
      request<{ id: string; version: string }>("POST", "/agents", body),
    update: (id: string, body: Partial<Agent>) =>
      request<{ id: string; version: string }>("PUT", `/agents/${id}`, body),
    promote: (id: string) =>
      request<{ version: string }>("POST", `/agents/${id}/promote`),
    delete: (id: string) => request("DELETE", `/agents/${id}`),
  },

  runs: {
    list: (params?: { status?: string; limit?: number }) => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set("status", params.status);
      if (params?.limit) qs.set("limit", String(params.limit));
      return request<{ items: Run[] }>("GET", `/runs?${qs}`);
    },
    get: (id: string) => request<Run>("GET", `/runs/${id}`),
    artifact: (runId: string, key: string) =>
      request<Record<string, unknown>>("GET", `/runs/${runId}/artifacts/${key}`),
    delete: (id: string) => request("DELETE", `/runs/${id}`),
  },

  gates: {
    list: () => request<{ items: Gate[] }>("GET", "/gates"),
    approve: (id: string, notes?: string) =>
      request("POST", `/gates/${id}/approve`, { notes }),
    reject: (id: string, notes?: string) =>
      request("POST", `/gates/${id}/reject`, { notes }),
  },

  metrics: {
    get: (params?: { workflow_id?: string; from?: string; to?: string }) => {
      const qs = new URLSearchParams();
      if (params?.workflow_id) qs.set("workflow_id", params.workflow_id);
      if (params?.from) qs.set("from", params.from);
      if (params?.to) qs.set("to", params.to);
      return request<Metrics>("GET", `/metrics?${qs}`);
    },
  },

  secrets: {
    list: () => request<{ items: Secret[] }>("GET", "/secrets"),
    create: (name: string, value: string) =>
      request("POST", "/secrets", { name, value }),
    delete: (name: string) => request("DELETE", `/secrets/${name}`),
  },

  mcp: {
    list: () => request<{ items: MCPServer[] }>("GET", "/mcp-servers"),
  },

  scripts: {
    list: (p = { limit: 50, offset: 0 }) =>
      request<{ items: Script[] }>("GET", `/scripts?limit=${p.limit}&offset=${p.offset}`),
    get: (id: string) => request<Script>("GET", `/scripts/${id}`),
    code: (id: string) => request<{ code: string }>("GET", `/scripts/${id}/code`),
    create: (body: { name: string; description: string; code: string; language?: "typescript" | "python"; allowed_hosts?: string; allowed_env?: string; max_timeout_seconds?: number }) =>
      request<{ id: string; version: string; language: string }>("POST", "/scripts", body),
    update: (id: string, body: { description?: string; code?: string; allowed_hosts?: string; allowed_env?: string; max_timeout_seconds?: number }) =>
      request<{ id: string; version: string }>("PUT", `/scripts/${id}`, body),
    promote: (id: string) =>
      request<{ version: string }>("POST", `/scripts/${id}/promote`),
    delete: (id: string) => request("DELETE", `/scripts/${id}`),
  },

  bundles: {
    deploy: (dsl: string) =>
      request<BundleDeployResult>("POST", "/bundles", { dsl }),
    export: (workflowId: string) =>
      requestText("GET", `/bundles/${workflowId}`),
  },

  settings: {
    get: () => request<Settings>("GET", "/settings"),
    patch: (body: Partial<Settings>) => request<Settings>("PATCH", "/settings", body),
  },

  snapshots: {
    list: (runId: string) =>
      request<{ items: StepSnapshot[] }>("GET", `/runs/${runId}/snapshots`),
    replay: (runId: string, stepId: string, restoreState = false) =>
      request<{ output: unknown }>("POST", `/runs/${runId}/steps/${stepId}/replay`, { restore_state: restoreState }),
  },
};
