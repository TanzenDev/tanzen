import { useState, useEffect } from "react";
import { useScripts, useScript, useScriptCode, useCreateScript, useUpdateScript, useDeleteScript } from "../api/hooks.js";
import type { Script } from "../api/client.js";
import { Paginator, PAGE_SIZE } from "../components/Paginator.js";

// ---------------------------------------------------------------------------
// Script form (create or edit)
// ---------------------------------------------------------------------------

interface ScriptFormProps {
  initial?: Script;
  onCancel: () => void;
  onSaved: () => void;
}

const DEFAULT_CODE = `// Tanzen script — receives { input, params } on stdin, writes JSON to stdout.
const raw = await new Response(Deno.stdin.readable).text();
const { input, params } = JSON.parse(raw);

// TODO: implement your logic here
const result = input;

console.log(JSON.stringify({ result }));
`;

function ScriptForm({ initial, onCancel, onSaved }: ScriptFormProps) {
  const createScript = useCreateScript();
  const updateScript = useUpdateScript(initial?.id ?? "");
  const { data: codeData } = useScriptCode(initial?.id ?? "");

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [code, setCode] = useState<string | null>(null); // null = not yet loaded
  const [allowedHosts, setAllowedHosts] = useState(initial?.allowed_hosts ?? "");
  const [allowedEnv, setAllowedEnv] = useState(initial?.allowed_env ?? "");
  const [maxTimeout, setMaxTimeout] = useState(String(initial?.max_timeout_seconds ?? 30));
  const [formError, setFormError] = useState<string | null>(null);

  // Once code is fetched from API, populate editor
  const resolvedCode = code ?? codeData?.code ?? DEFAULT_CODE;

  const isEdit = !!initial;
  const isPending = createScript.isPending || updateScript.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (isEdit) {
      updateScript.mutate(
        {
          description,
          code: resolvedCode,
          allowed_hosts: allowedHosts,
          allowed_env: allowedEnv,
          max_timeout_seconds: Number(maxTimeout),
        },
        {
          onSuccess: () => onSaved(),
          onError: (err) => setFormError(String(err)),
        }
      );
    } else {
      createScript.mutate(
        {
          name,
          description,
          code: resolvedCode,
          allowed_hosts: allowedHosts,
          allowed_env: allowedEnv,
          max_timeout_seconds: Number(maxTimeout),
        },
        {
          onSuccess: () => onSaved(),
          onError: (err) => setFormError(String(err)),
        }
      );
    }
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-6">
      <h2 className="text-lg font-bold mb-4">{isEdit ? `Edit: ${initial.name}` : "New script"}</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        {!isEdit && (
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">Name (slug)</label>
            <input
              className="w-full rounded bg-slate-700 px-3 py-2 text-sm text-white font-mono placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
              placeholder="my-script"
              required
            />
            <p className="mt-1 text-xs text-slate-500">Lowercase letters, numbers, hyphens. Referenced in DSL as <span className="font-mono">name: "{name || "my-script"}"</span>.</p>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">Description</label>
          <input
            className="w-full rounded bg-slate-700 px-3 py-2 text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Short description of what this script does"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">TypeScript code</label>
          <textarea
            className="w-full rounded bg-slate-900 px-3 py-2 text-sm text-white font-mono placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-y"
            rows={16}
            value={code ?? codeData?.code ?? DEFAULT_CODE}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
          />
          <p className="mt-1 text-xs text-slate-500">
            Runs in Deno. Read <span className="font-mono">{"{ input, params }"}</span> from stdin JSON. Write result to stdout as JSON.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">Allowed hosts</label>
            <input
              className="w-full rounded bg-slate-700 px-3 py-2 text-sm text-white font-mono placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
              value={allowedHosts}
              onChange={(e) => setAllowedHosts(e.target.value)}
              placeholder="api.example.com,data.example.org"
            />
            <p className="mt-1 text-xs text-slate-500">Comma-separated. Empty = no network access.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">Allowed env vars</label>
            <input
              className="w-full rounded bg-slate-700 px-3 py-2 text-sm text-white font-mono placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
              value={allowedEnv}
              onChange={(e) => setAllowedEnv(e.target.value)}
              placeholder="API_KEY,REGION"
            />
            <p className="mt-1 text-xs text-slate-500">Comma-separated. Empty = no env access.</p>
          </div>
        </div>

        <div className="w-40">
          <label className="block text-sm font-medium text-slate-300 mb-1">Max timeout (s)</label>
          <input
            type="number"
            min={1}
            max={3600}
            className="w-full rounded bg-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
            value={maxTimeout}
            onChange={(e) => setMaxTimeout(e.target.value)}
          />
        </div>

        {formError && <p className="text-red-400 text-sm">{formError}</p>}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={isPending}
            className="rounded bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
          >
            {isPending ? "Saving…" : isEdit ? "Update script" : "Create script"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded bg-slate-600 px-4 py-2 text-sm font-medium text-white hover:bg-slate-500"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Script detail panel
// ---------------------------------------------------------------------------

interface ScriptDetailProps {
  scriptId: string;
  onEdit: () => void;
  onClose: () => void;
}

function ScriptDetail({ scriptId, onEdit, onClose }: ScriptDetailProps) {
  const { data: script, isLoading } = useScript(scriptId);
  const { data: codeData } = useScriptCode(scriptId);
  const deleteScript = useDeleteScript();

  if (isLoading) return <p className="text-slate-400 text-sm">Loading…</p>;
  if (!script) return null;

  function handleDelete() {
    if (!confirm(`Delete script "${script!.name}"? This cannot be undone.`)) return;
    deleteScript.mutate(scriptId, { onSuccess: onClose });
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold font-mono">{script.name}</h2>
          <p className="text-sm text-slate-400">{script.description || <em>No description</em>}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={onEdit}
            className="rounded bg-slate-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-500"
          >
            Edit
          </button>
          <button
            onClick={handleDelete}
            className="rounded bg-red-900 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-800"
          >
            Delete
          </button>
          <button
            onClick={onClose}
            className="rounded bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-600"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <span className="text-slate-500">Version</span>
          <p className="font-mono text-white">{script.current_version}</p>
        </div>
        <div>
          <span className="text-slate-500">Timeout</span>
          <p className="text-white">{script.max_timeout_seconds}s</p>
        </div>
        <div>
          <span className="text-slate-500">Allowed hosts</span>
          <p className="font-mono text-white break-all">{script.allowed_hosts || <em className="text-slate-500">none</em>}</p>
        </div>
        <div>
          <span className="text-slate-500">Allowed env</span>
          <p className="font-mono text-white break-all">{script.allowed_env || <em className="text-slate-500">none</em>}</p>
        </div>
      </div>

      {codeData?.code && (
        <div>
          <p className="text-xs text-slate-500 mb-1 uppercase tracking-wider">Source</p>
          <pre className="rounded bg-slate-900 px-4 py-3 text-xs text-white font-mono overflow-auto max-h-80 whitespace-pre">{codeData.code}</pre>
        </div>
      )}

      {script.versions && script.versions.length > 0 && (
        <div>
          <p className="text-xs text-slate-500 mb-2 uppercase tracking-wider">Version history</p>
          <div className="space-y-1">
            {[...script.versions].reverse().map((v) => (
              <div key={v.version} className="flex items-center gap-3 text-xs">
                <span className="font-mono text-slate-300">{v.version}</span>
                {v.promoted && <span className="rounded bg-cyan-900 px-1.5 py-0.5 text-cyan-300">promoted</span>}
                <span className="text-slate-500">{new Date(v.created_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="pt-2 border-t border-slate-700">
        <p className="text-xs text-slate-500 font-mono">
          DSL usage: <span className="text-slate-300">script myStep {"{ name: \""}{script.name}{"\""} {"... }"}</span>
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScriptsPage
// ---------------------------------------------------------------------------

export function ScriptsPage() {
  const { data, isLoading, error } = useScripts();
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [search]);

  const { data: selectedScript } = useScript(selectedId ?? "");

  const q = search.toLowerCase();
  const filtered = (data?.items ?? []).filter(
    (s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
  );
  const pageCount = Math.ceil(filtered.length / PAGE_SIZE);
  const scripts = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (isLoading) return <p className="text-slate-400">Loading scripts…</p>;
  if (error) return <p className="text-red-400">Error: {String(error)}</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <div className="shrink-0">
          <h1 className="text-2xl font-bold">Scripts</h1>
          <p className="text-sm text-slate-400 mt-1">
            TypeScript scripts that run as Deno subprocesses inside Temporal activities.
          </p>
        </div>
        <input
          type="search"
          placeholder="Search scripts… (Enter)"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setSearch(searchDraft); }}
          className="flex-1 max-w-xs rounded bg-slate-700 px-3 py-2 text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
        />
        <button
          onClick={() => { setCreating(true); setSelectedId(null); setEditingId(null); }}
          className="rounded bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 shrink-0"
        >
          + New script
        </button>
      </div>

      {creating && (
        <ScriptForm
          onCancel={() => setCreating(false)}
          onSaved={() => setCreating(false)}
        />
      )}

      {editingId && selectedScript && (
        <ScriptForm
          initial={selectedScript}
          onCancel={() => setEditingId(null)}
          onSaved={() => setEditingId(null)}
        />
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        {/* List */}
        <div className={selectedId ? "lg:col-span-2" : "lg:col-span-5"}>
          <div className="overflow-hidden rounded-lg border border-slate-700">
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-slate-400 text-xs uppercase">
                <tr>
                  <th className="px-4 py-3 text-left">Name</th>
                  <th className="px-4 py-3 text-left">Description</th>
                  <th className="px-4 py-3 text-left">Version</th>
                  <th className="px-4 py-3 text-left">Hosts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700 bg-slate-900">
                {scripts.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                      No scripts yet. Create one to use in your workflow DSL.
                    </td>
                  </tr>
                )}
                {scripts.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => { setSelectedId(s.id); setEditingId(null); setCreating(false); }}
                    className={`cursor-pointer transition-colors ${selectedId === s.id ? "bg-slate-800" : "hover:bg-slate-800/60"}`}
                  >
                    <td className="px-4 py-3 font-mono text-cyan-400">{s.name}</td>
                    <td className="px-4 py-3 text-slate-400 max-w-xs truncate">{s.description || "—"}</td>
                    <td className="px-4 py-3 font-mono text-slate-300">{s.current_version}</td>
                    <td className="px-4 py-3 font-mono text-slate-400 text-xs truncate max-w-[160px]">
                      {s.allowed_hosts || <em className="not-italic text-slate-600">none</em>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Paginator page={page} pageCount={pageCount} total={filtered.length} pageSize={PAGE_SIZE} onChange={setPage} />
          </div>
        </div>

        {/* Detail */}
        {selectedId && !editingId && (
          <div className="lg:col-span-3">
            <ScriptDetail
              scriptId={selectedId}
              onEdit={() => setEditingId(selectedId)}
              onClose={() => setSelectedId(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
