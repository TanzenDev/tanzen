import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Editor from "@monaco-editor/react";
import {
  useWorkflows,
  useWorkflow,
  useWorkflowDsl,
  useCreateWorkflow,
  useCompile,
  useStartRun,
  usePromoteWorkflow,
  useDeleteWorkflow,
  useAgents,
} from "../api/hooks.js";
import { api } from "../api/client.js";
import type { Workflow } from "../api/client.js";
import { WorkflowCanvas } from "../components/WorkflowCanvas.js";
import type { CompileResult } from "../api/client.js";
import { Paginator, PAGE_SIZE } from "../components/Paginator.js";

function RunModal({
  workflowId,
  onClose,
}: {
  workflowId: string;
  onClose: () => void;
}) {
  const [paramsText, setParamsText] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const startRun = useStartRun(workflowId);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(paramsText);
    } catch {
      setError("Invalid JSON");
      return;
    }
    startRun.mutate(params, { onSuccess: onClose, onError: (err) => setError(String(err)) });
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/60 z-50">
      <div className="rounded-lg border dark:border-slate-700 border-slate-200 dark:bg-slate-800 bg-white p-6 w-full max-w-md">
        <h2 className="text-lg font-bold mb-4">Start run</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium dark:text-slate-300 text-slate-700 mb-1">
              Params (JSON)
            </label>
            <textarea
              className="w-full rounded dark:bg-slate-700 bg-slate-100 px-3 py-2 text-sm dark:text-white text-slate-900 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              rows={6}
              value={paramsText}
              onChange={(e) => setParamsText(e.target.value)}
            />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={startRun.isPending}
              className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50"
            >
              {startRun.isPending ? "Starting…" : "Run"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded dark:bg-slate-600 bg-slate-200 px-4 py-2 text-sm font-medium dark:text-white text-slate-900 dark:hover:bg-slate-500 hover:bg-slate-300"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function WorkflowDetail({
  workflow,
  onClose,
}: {
  workflow: Workflow;
  onClose: () => void;
}) {
  const { data: full } = useWorkflow(workflow.id);
  const { data: dslData } = useWorkflowDsl(workflow.id);
  const compile = useCompile(workflow.id);
  const promote = usePromoteWorkflow();
  const deleteWorkflow = useDeleteWorkflow();
  const { data: agentsData } = useAgents();
  const agents = agentsData?.items ?? [];
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [tab, setTab] = useState<"dsl" | "visual">("dsl");
  const [dsl, setDsl] = useState<string | undefined>(undefined);
  const [runModal, setRunModal] = useState(false);
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null);
  const [visualIr, setVisualIr] = useState<unknown>(null);

  // Populate DSL editor from fetched DSL when first loaded
  if (dsl === undefined && dslData?.dsl) {
    setDsl(dslData.dsl);
  }

  const displayWorkflow = full ?? workflow;

  function handleCompile() {
    if (!dsl) return;
    compile.mutate(dsl, {
      onSuccess: (r) => setCompileResult(r),
    });
  }

  function handleSwitchToVisual() {
    if (!dsl) return;
    compile.mutate(dsl, {
      onSuccess: (r) => {
        if (r.ok) {
          setVisualIr(r.ir ?? null);
          setTab("visual");
        } else {
          setCompileResult(r);
        }
      },
    });
  }

  function handleExportDsl(exported: string) {
    setDsl(exported);
    setTab("dsl");
  }

  return (
    <div className="rounded-lg border dark:border-slate-700 border-slate-200 dark:bg-slate-800 bg-white p-6">
      {runModal && (
        <RunModal workflowId={workflow.id} onClose={() => setRunModal(false)} />
      )}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold">{displayWorkflow.name}</h2>
          <p className="text-sm dark:text-slate-400 text-slate-600">v{displayWorkflow.current_version}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setRunModal(true)}
            className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-500"
          >
            Run
          </button>
          <button
            onClick={() => promote.mutate(workflow.id)}
            className="rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500"
          >
            Promote
          </button>
          {confirmDelete ? (
            <>
              <button
                onClick={() => deleteWorkflow.mutate(workflow.id, { onSuccess: onClose })}
                disabled={deleteWorkflow.isPending}
                className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
              >
                {deleteWorkflow.isPending ? "Deleting…" : "Confirm delete"}
              </button>
              <button onClick={() => setConfirmDelete(false)} className="rounded dark:bg-slate-600 bg-slate-200 px-3 py-1.5 text-xs font-medium dark:text-white text-slate-900 dark:hover:bg-slate-500 hover:bg-slate-300">
                Cancel
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setConfirmDelete(true)} className="rounded dark:bg-slate-700 bg-slate-100 px-3 py-1.5 text-xs font-medium text-red-400 dark:hover:bg-slate-600 hover:bg-slate-200">
                Delete
              </button>
              <button
                onClick={onClose}
                className="rounded dark:bg-slate-600 bg-slate-200 px-3 py-1.5 text-xs font-medium dark:text-white text-slate-900 dark:hover:bg-slate-500 hover:bg-slate-300"
              >
                Close
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b dark:border-slate-700 border-slate-200 mb-4">
        <button
          onClick={() => setTab("dsl")}
          className={`px-3 py-1.5 text-xs font-medium rounded-t ${
            tab === "dsl"
              ? "dark:bg-slate-700 bg-slate-100 dark:text-white text-slate-900"
              : "dark:text-slate-400 text-slate-600 dark:hover:text-white hover:text-slate-900"
          }`}
        >
          DSL
        </button>
        <button
          onClick={handleSwitchToVisual}
          disabled={!dsl || compile.isPending}
          className={`px-3 py-1.5 text-xs font-medium rounded-t disabled:opacity-50 ${
            tab === "visual"
              ? "dark:bg-slate-700 bg-slate-100 dark:text-white text-slate-900"
              : "dark:text-slate-400 text-slate-600 dark:hover:text-white hover:text-slate-900"
          }`}
        >
          {compile.isPending && tab !== "visual" ? "Loading…" : "Visual"}
        </button>
      </div>

      <div className="space-y-4">
        {tab === "dsl" && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-medium dark:text-slate-400 text-slate-600">DSL</p>
              <button
                onClick={handleCompile}
                disabled={!dsl || compile.isPending}
                className="rounded bg-blue-700 px-2 py-1 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
              >
                {compile.isPending ? "Compiling…" : "Compile"}
              </button>
            </div>
            <div className="rounded overflow-hidden border dark:border-slate-700 border-slate-200" style={{ height: 300 }}>
              <Editor
                height="300px"
                defaultLanguage="yaml"
                theme="vs-dark"
                value={dsl}
                onChange={(v) => setDsl(v ?? "")}
                options={{ minimap: { enabled: false }, fontSize: 12 }}
              />
            </div>
            {compileResult && (
              <div
                className={`mt-2 rounded p-3 text-xs ${
                  compileResult.ok
                    ? "bg-green-900 text-green-200"
                    : "bg-red-900 text-red-200"
                }`}
              >
                {compileResult.ok ? (
                  "Compiled successfully"
                ) : (
                  <ul className="space-y-1">
                    {(compileResult.errors ?? []).map((e, i) => (
                      <li key={i}>
                        Line {e.line}:{e.column} — {e.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {tab === "visual" && (
          <div style={{ height: 480 }}>
            <WorkflowCanvas
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              initialIr={visualIr as any}
              onExportDsl={handleExportDsl}
              workflowName={displayWorkflow.name}
              agents={agents}
            />
          </div>
        )}

        {displayWorkflow.versions && displayWorkflow.versions.length > 0 && (
          <div>
            <p className="text-xs font-medium dark:text-slate-400 text-slate-600 mb-1">Version history</p>
            <ul className="space-y-1">
              {displayWorkflow.versions.map((v) => (
                <li key={v.version} className="flex items-center gap-2 text-xs dark:text-slate-300 text-slate-700">
                  <span className="font-mono">v{v.version}</span>
                  {v.promoted && (
                    <span className="rounded bg-amber-700 px-1.5 py-0.5 text-amber-200">
                      promoted
                    </span>
                  )}
                  <span className="text-slate-500">
                    {new Date(v.created_at).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function CreateWorkflowForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [dsl, setDsl] = useState("");
  const [tab, setTab] = useState<"dsl" | "visual">("dsl");
  const createWorkflow = useCreateWorkflow();
  const { data: agentsData } = useAgents();
  const agents = agentsData?.items ?? [];
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createWorkflow.mutate(
      { name, dsl },
      { onSuccess: onDone, onError: (err) => setError(String(err)) }
    );
  }

  function handleExportDsl(exported: string) {
    setDsl(exported);
    setTab("dsl");
  }

  return (
    <div className="rounded-lg border dark:border-slate-700 border-slate-200 dark:bg-slate-800 bg-white p-6">
      <h2 className="text-lg font-bold mb-4">Create workflow</h2>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium dark:text-slate-300 text-slate-700 mb-1">Name</label>
          <input
            className="w-full rounded dark:bg-slate-700 bg-slate-100 px-3 py-2 text-sm dark:text-white text-slate-900 dark:placeholder-slate-400 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-workflow"
            required
          />
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 border-b dark:border-slate-700 border-slate-200">
          <button
            type="button"
            onClick={() => setTab("dsl")}
            className={`px-3 py-1.5 text-xs font-medium rounded-t ${
              tab === "dsl"
                ? "dark:bg-slate-700 bg-slate-100 dark:text-white text-slate-900"
                : "dark:text-slate-400 text-slate-600 dark:hover:text-white hover:text-slate-900"
            }`}
          >
            DSL
          </button>
          <button
            type="button"
            onClick={() => setTab("visual")}
            className={`px-3 py-1.5 text-xs font-medium rounded-t ${
              tab === "visual"
                ? "dark:bg-slate-700 bg-slate-100 dark:text-white text-slate-900"
                : "dark:text-slate-400 text-slate-600 dark:hover:text-white hover:text-slate-900"
            }`}
          >
            Visual
          </button>
        </div>

        {tab === "dsl" && (
          <div>
            <label className="block text-sm font-medium dark:text-slate-300 text-slate-700 mb-1">DSL (YAML)</label>
            <div className="rounded overflow-hidden border dark:border-slate-700 border-slate-200" style={{ height: 240 }}>
              <Editor
                height="240px"
                defaultLanguage="yaml"
                theme="vs-dark"
                value={dsl}
                onChange={(v) => setDsl(v ?? "")}
                options={{ minimap: { enabled: false }, fontSize: 12 }}
              />
            </div>
          </div>
        )}

        {tab === "visual" && (
          <div style={{ height: 400 }}>
            <WorkflowCanvas
              initialIr={null}
              onExportDsl={handleExportDsl}
              workflowName={name || "NewWorkflow"}
              agents={agents}
            />
          </div>
        )}

        {error && <p className="text-red-400 text-sm">{error}</p>}
        <form onSubmit={handleSubmit}>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={createWorkflow.isPending || !name}
              title={!name ? "Enter a workflow name first" : undefined}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {createWorkflow.isPending ? "Creating…" : "Save"}
            </button>
            <button
              type="button"
              onClick={onDone}
              className="rounded dark:bg-slate-600 bg-slate-200 px-4 py-2 text-sm font-medium dark:text-white text-slate-900 dark:hover:bg-slate-500 hover:bg-slate-300"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function WorkflowsPage() {
  const { data, isLoading, error } = useWorkflows();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Workflow | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  const qc = useQueryClient();
  useEffect(() => { setPage(0); setCheckedIds(new Set()); }, [search]);

  async function handleBulkDelete() {
    if (!confirm(`Delete ${checkedIds.size} workflow${checkedIds.size > 1 ? "s" : ""}? This cannot be undone.`)) return;
    setIsDeleting(true);
    try {
      await Promise.all(Array.from(checkedIds).map((id) => api.workflows.delete(id)));
      setCheckedIds(new Set());
      qc.invalidateQueries({ queryKey: ["workflows"] });
    } finally {
      setIsDeleting(false);
    }
  }

  if (isLoading) return <p className="text-slate-400">Loading workflows…</p>;
  if (error) return <p className="text-red-400">Error: {String(error)}</p>;

  const q = search.toLowerCase();
  const filtered = (data?.items ?? []).filter(
    (w) => !q || w.name.toLowerCase().includes(q) || w.created_by.toLowerCase().includes(q)
  );
  const pageCount = Math.ceil(filtered.length / PAGE_SIZE);
  const workflows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const allChecked = workflows.length > 0 && workflows.every((w) => checkedIds.has(w.id));
  const someChecked = workflows.some((w) => checkedIds.has(w.id));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">Workflows</h1>
        <input
          type="search"
          placeholder="Search workflows… (Enter)"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setSearch(searchDraft)}
          className="flex-1 max-w-xs rounded dark:bg-slate-700 bg-slate-100 px-3 py-2 text-sm dark:text-white text-slate-900 dark:placeholder-slate-400 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={() => { setCreating(true); setSelected(null); }}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 shrink-0"
        >
          + New workflow
        </button>
      </div>

      {creating && (
        <CreateWorkflowForm onDone={() => setCreating(false)} />
      )}

      {selected && (
        <WorkflowDetail workflow={selected} onClose={() => setSelected(null)} />
      )}

      {checkedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border dark:border-slate-700 border-slate-200 dark:bg-slate-800 bg-slate-50 px-4 py-2.5">
          <span className="text-sm font-medium dark:text-slate-300 text-slate-700">{checkedIds.size} selected</span>
          <button
            onClick={handleBulkDelete}
            disabled={isDeleting}
            className="rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
          >
            {isDeleting ? "Deleting…" : "Delete selected"}
          </button>
          <button
            onClick={() => setCheckedIds(new Set())}
            className="ml-auto text-xs dark:text-slate-400 text-slate-600 hover:dark:text-white hover:text-slate-900"
          >
            Clear
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border dark:border-slate-700 border-slate-200">
        <table className="w-full text-sm">
          <thead className="dark:bg-slate-800 bg-white dark:text-slate-400 text-slate-600 text-xs uppercase">
            <tr>
              <th className="w-10 pl-4 py-3">
                <input
                  type="checkbox"
                  ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked; }}
                  checked={allChecked}
                  onChange={() => {
                    if (allChecked) {
                      setCheckedIds((prev) => { const n = new Set(prev); workflows.forEach((w) => n.delete(w.id)); return n; });
                    } else {
                      setCheckedIds((prev) => new Set([...prev, ...workflows.map((w) => w.id)]));
                    }
                  }}
                  className="rounded border dark:border-slate-500 border-slate-300 dark:bg-slate-700 bg-white text-blue-500 focus:ring-blue-500 cursor-pointer h-4 w-4"
                />
              </th>
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Version</th>
              <th className="px-4 py-3 text-left">Created by</th>
              <th className="px-4 py-3 text-left">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y dark:divide-slate-700 divide-slate-200 dark:bg-slate-900 bg-white">
            {workflows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                  No workflows yet
                </td>
              </tr>
            )}
            {workflows.map((w) => (
              <tr
                key={w.id}
                className={`cursor-pointer dark:hover:bg-slate-800 hover:bg-slate-50 ${checkedIds.has(w.id) ? "dark:bg-slate-800/60 bg-blue-50" : ""}`}
                onClick={() => { setSelected(w); setCreating(false); }}
              >
                <td className="w-10 pl-4" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={checkedIds.has(w.id)}
                    onChange={() => setCheckedIds((prev) => { const n = new Set(prev); n.has(w.id) ? n.delete(w.id) : n.add(w.id); return n; })}
                    className="rounded border dark:border-slate-500 border-slate-300 dark:bg-slate-700 bg-white text-blue-500 focus:ring-blue-500 cursor-pointer h-4 w-4"
                  />
                </td>
                <td className="px-4 py-3 font-medium">{w.name}</td>
                <td className="px-4 py-3 font-mono dark:text-slate-400 text-slate-600">v{w.current_version}</td>
                <td className="px-4 py-3 dark:text-slate-400 text-slate-600">{w.created_by}</td>
                <td className="px-4 py-3 text-slate-500">
                  {new Date(w.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Paginator page={page} pageCount={pageCount} total={filtered.length} pageSize={PAGE_SIZE} onChange={setPage} />
      </div>
    </div>
  );
}
