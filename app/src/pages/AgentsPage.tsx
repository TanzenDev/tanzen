import { useState, useEffect } from "react";
import { useAgents, useAgent, useCreateAgent, useUpdateAgent, usePromoteAgent, useDeleteAgent, useMCPServers } from "../api/hooks.js";
import type { Agent } from "../api/client.js";
import { Paginator, PAGE_SIZE } from "../components/Paginator.js";

interface AgentFormData {
  name: string;
  model: string;
  system_prompt: string;
  mcp_servers: Array<{ url: string }>;
}

function AgentForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: Partial<AgentFormData>;
  onSubmit: (d: AgentFormData) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [model, setModel] = useState(initial?.model ?? "openai:gpt-4o");
  const [prompt, setPrompt] = useState(initial?.system_prompt ?? "");
  const [selectedMcpUrls, setSelectedMcpUrls] = useState<Set<string>>(
    new Set(initial?.mcp_servers?.map((s) => s.url) ?? [])
  );

  const { data: mcpData } = useMCPServers();
  const mcpServers = mcpData?.items ?? [];

  function toggleMcp(url: string) {
    setSelectedMcpUrls((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          name,
          model,
          system_prompt: prompt,
          mcp_servers: Array.from(selectedMcpUrls).map((url) => ({ url })),
        });
      }}
    >
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1">Name</label>
        <input
          type="text"
          className="w-full rounded bg-slate-700 px-3 py-2 text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="document-parser"
          required
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1">Model</label>
        <select
          className="w-full rounded bg-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        >
          <option value="openai:gpt-4o">openai:gpt-4o</option>
          <option value="openai:gpt-4o-mini">openai:gpt-4o-mini</option>
          <option value="anthropic:claude-sonnet-4-6">anthropic:claude-sonnet-4-6</option>
          <option value="anthropic:claude-haiku-4-5">anthropic:claude-haiku-4-5</option>
          <option value="test">test (no LLM)</option>
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1">System prompt</label>
        <textarea
          className="w-full rounded bg-slate-700 px-3 py-2 text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          rows={6}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="You are a..."
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-300 mb-2">MCP Servers</label>
        {mcpServers.length === 0 ? (
          <p className="text-xs text-slate-500 italic">No MCP servers available in this cluster.</p>
        ) : (
          <div className="space-y-2">
            {mcpServers.map((server) => (
              <label
                key={server.url}
                className="flex items-start gap-3 cursor-pointer group"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 rounded border-slate-500 bg-slate-700 text-blue-500 focus:ring-blue-500"
                  checked={selectedMcpUrls.has(server.url)}
                  onChange={() => toggleMcp(server.url)}
                />
                <div>
                  <span className="text-sm font-medium text-slate-200 group-hover:text-white">
                    {server.name}
                  </span>
                  {server.description && (
                    <p className="text-xs text-slate-400">{server.description}</p>
                  )}
                </div>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <button type="submit" className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500">
          Save
        </button>
        <button type="button" onClick={onCancel} className="rounded bg-slate-600 px-4 py-2 text-sm font-medium text-white hover:bg-slate-500">
          Cancel
        </button>
      </div>
    </form>
  );
}

function AgentDetail({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { data: fullAgent } = useAgent(agent.id);
  const detail = fullAgent ?? agent;
  const update = useUpdateAgent(agent.id);
  const promote = usePromoteAgent();
  const deleteAgent = useDeleteAgent();

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold">{detail.name}</h2>
          <p className="text-sm text-slate-400">v{detail.current_version} · {detail.model}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => promote.mutate(agent.id)}
            className="rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500"
          >
            Promote
          </button>
          <button onClick={() => setEditing(true)} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500">
            Edit
          </button>
          {confirmDelete ? (
            <>
              <button
                onClick={() => deleteAgent.mutate(agent.id, { onSuccess: onClose })}
                disabled={deleteAgent.isPending}
                className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
              >
                {deleteAgent.isPending ? "Deleting…" : "Confirm delete"}
              </button>
              <button onClick={() => setConfirmDelete(false)} className="rounded bg-slate-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-500">
                Cancel
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setConfirmDelete(true)} className="rounded bg-slate-700 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-slate-600">
                Delete
              </button>
              <button onClick={onClose} className="rounded bg-slate-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-500">
                Close
              </button>
            </>
          )}
        </div>
      </div>

      {editing ? (
        <AgentForm
          initial={{
            name: detail.name,
            model: detail.model,
            system_prompt: detail.system_prompt ?? "",
            mcp_servers: detail.mcp_servers ?? [],
          }}
          onSubmit={(d) => { update.mutate(d); setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium text-slate-400 mb-1">Model</p>
            <p className="text-sm">{detail.model}</p>
          </div>
          {(detail.mcp_servers ?? []).length > 0 && (
            <div>
              <p className="text-xs font-medium text-slate-400 mb-1">MCP Servers</p>
              <ul className="space-y-0.5">
                {(detail.mcp_servers ?? []).map((s) => (
                  <li key={s.url} className="text-xs font-mono text-slate-300">{s.url}</li>
                ))}
              </ul>
            </div>
          )}
          {detail.versions && detail.versions.length > 0 && (
            <div>
              <p className="text-xs font-medium text-slate-400 mb-1">Version history</p>
              <ul className="space-y-1">
                {detail.versions!.map((v) => (
                  <li key={v.version} className="flex items-center gap-2 text-xs text-slate-300">
                    <span className="font-mono">v{v.version}</span>
                    {v.promoted && <span className="rounded bg-amber-700 px-1.5 py-0.5 text-amber-200">promoted</span>}
                    <span className="text-slate-500">{new Date(v.created_at).toLocaleDateString()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AgentsPage() {
  const { data, isLoading, error } = useAgents();
  const createAgent = useCreateAgent();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [search]);

  if (isLoading) return <p className="text-slate-400">Loading agents…</p>;
  if (error) return <p className="text-red-400">Error: {String(error)}</p>;

  const q = search.toLowerCase();
  const filtered = (data?.items ?? []).filter(
    (a) => !q || a.name.toLowerCase().includes(q) || a.model.toLowerCase().includes(q)
  );
  const pageCount = Math.ceil(filtered.length / PAGE_SIZE);
  const agents = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">Agents</h1>
        <input
          type="search"
          placeholder="Search agents… (Enter)"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setSearch(searchDraft)}
          className="flex-1 max-w-xs rounded bg-slate-700 px-3 py-2 text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={() => { setCreating(true); setSelected(null); }}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 shrink-0"
        >
          + New agent
        </button>
      </div>

      {creating && (
        <div className="rounded-lg border border-slate-700 bg-slate-800 p-6">
          <h2 className="text-lg font-bold mb-4">Create agent</h2>
          <AgentForm
            onSubmit={(d) => { createAgent.mutate(d); setCreating(false); }}
            onCancel={() => setCreating(false)}
          />
        </div>
      )}

      {selected && <AgentDetail agent={selected} onClose={() => setSelected(null)} />}

      <div className="overflow-hidden rounded-lg border border-slate-700">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-slate-400 text-xs uppercase">
            <tr>
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Model</th>
              <th className="px-4 py-3 text-left">MCP</th>
              <th className="px-4 py-3 text-left">Version</th>
              <th className="px-4 py-3 text-left">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700 bg-slate-900">
            {agents.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">No agents yet</td></tr>
            )}
            {agents.map((a) => (
              <tr
                key={a.id}
                className="cursor-pointer hover:bg-slate-800"
                onClick={() => { setSelected(a); setCreating(false); }}
              >
                <td className="px-4 py-3 font-medium">{a.name}</td>
                <td className="px-4 py-3 text-slate-400">{a.model}</td>
                <td className="px-4 py-3">
                  {(a.mcp_servers ?? []).length > 0 && (
                    <span className="rounded bg-violet-800 px-1.5 py-0.5 text-xs font-medium text-violet-200">
                      MCP ×{a.mcp_servers!.length}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-slate-400">v{a.current_version}</td>
                <td className="px-4 py-3 text-slate-500">{new Date(a.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Paginator page={page} pageCount={pageCount} total={filtered.length} pageSize={PAGE_SIZE} onChange={setPage} />
      </div>
    </div>
  );
}
