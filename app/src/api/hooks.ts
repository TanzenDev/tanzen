/**
 * TanStack Query hooks for all API resources.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client.js";

// ---------- Workflows ----------

export const useWorkflows = () =>
  useQuery({ queryKey: ["workflows"], queryFn: () => api.workflows.list() });

export const useWorkflow = (id: string) =>
  useQuery({ queryKey: ["workflows", id], queryFn: () => api.workflows.get(id), enabled: !!id });

export const useCreateWorkflow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.workflows.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflows"] }),
  });
};

export const useWorkflowDsl = (id: string) =>
  useQuery({ queryKey: ["workflows", id, "dsl"], queryFn: () => api.workflows.dsl(id), enabled: !!id });

export const useCompile = (id: string) =>
  useMutation({ mutationFn: (dsl: string) => api.workflows.compile(id, dsl) });

export const useStartRun = (workflowId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: Record<string, unknown>) => api.workflows.startRun(workflowId, params),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runs"] }),
  });
};

export const usePromoteWorkflow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.workflows.promote(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflows"] }),
  });
};

export const useDeleteWorkflow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.workflows.delete(id),
    onSuccess: (_data, id) => {
      // Remove the deleted workflow's sub-queries before invalidating to prevent
      // in-flight refetches that would hit the now-deleted resource and 404.
      qc.removeQueries({ queryKey: ["workflows", id] });
      qc.invalidateQueries({ queryKey: ["workflows"], exact: true });
    },
  });
};

// ---------- Agents ----------

export const useAgents = () =>
  useQuery({ queryKey: ["agents"], queryFn: () => api.agents.list() });

export const useAgent = (id: string) =>
  useQuery({ queryKey: ["agents", id], queryFn: () => api.agents.get(id), enabled: !!id });

export const useCreateAgent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.agents.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
};

export const useUpdateAgent = (id: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.agents.update>[1]) => api.agents.update(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents", id] });
      qc.invalidateQueries({ queryKey: ["agents"], exact: true });
    },
  });
};

export const usePromoteAgent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.agents.promote(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
};

export const useDeleteAgent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.agents.delete(id),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: ["agents", id] });
      qc.invalidateQueries({ queryKey: ["agents"], exact: true });
    },
  });
};

// ---------- Runs ----------

export const useRuns = (params?: { status?: string }) =>
  useQuery({ queryKey: ["runs", params], queryFn: () => api.runs.list(params) });

export const useRun = (id: string) =>
  useQuery({ queryKey: ["runs", id], queryFn: () => api.runs.get(id), enabled: !!id,
    refetchInterval: (q) => q.state.data?.status === "running" ? 3000 : false });

export const useDeleteRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      try {
        return await api.runs.delete(id);
      } catch (err: unknown) {
        // Treat 404 as already-deleted — close the panel and refresh the list
        if (err instanceof Error && err.message === "Not found") return { deleted: true };
        throw err;
      }
    },
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: ["runs", id] });
      qc.invalidateQueries({ queryKey: ["runs"], exact: true });
    },
  });
};

// ---------- Gates ----------

export const useGates = () =>
  useQuery({ queryKey: ["gates"], queryFn: () => api.gates.list(),
    refetchInterval: 10_000 });

export const useApproveGate = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, notes }: { id: string; notes?: string }) => api.gates.approve(id, notes),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["gates"] }),
  });
};

export const useRejectGate = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, notes }: { id: string; notes?: string }) => api.gates.reject(id, notes),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["gates"] }),
  });
};

// ---------- Metrics ----------

export const useMetrics = (params?: Parameters<typeof api.metrics.get>[0]) =>
  useQuery({ queryKey: ["metrics", params], queryFn: () => api.metrics.get(params) });

// ---------- Secrets ----------

export const useSecrets = () =>
  useQuery({ queryKey: ["secrets"], queryFn: () => api.secrets.list() });

export const useCreateSecret = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) =>
      api.secrets.create(name, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["secrets"] }),
  });
};

export const useDeleteSecret = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.secrets.delete(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["secrets"] }),
  });
};

// ---------- MCP Servers ----------

export const useMCPServers = () =>
  useQuery({ queryKey: ["mcp-servers"], queryFn: () => api.mcp.list() });

// ---------- Scripts ----------

export const useScripts = () =>
  useQuery({ queryKey: ["scripts"], queryFn: () => api.scripts.list() });

export const useScript = (id: string) =>
  useQuery({ queryKey: ["scripts", id], queryFn: () => api.scripts.get(id), enabled: !!id });

export const useScriptCode = (id: string) =>
  useQuery({ queryKey: ["scripts", id, "code"], queryFn: () => api.scripts.code(id), enabled: !!id });

export const useCreateScript = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.scripts.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scripts"] }),
  });
};

export const useUpdateScript = (id: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.scripts.update>[1]) => api.scripts.update(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scripts", id] });
      qc.invalidateQueries({ queryKey: ["scripts"], exact: true });
    },
  });
};

export const usePromoteScript = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.scripts.promote(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scripts"] }),
  });
};

export const useDeleteScript = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.scripts.delete(id),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: ["scripts", id] });
      qc.invalidateQueries({ queryKey: ["scripts"], exact: true });
    },
  });
};
