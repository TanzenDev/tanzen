import { useState, useEffect } from "react";
import { useSecrets, useCreateSecret, useDeleteSecret } from "../api/hooks.js";
import { Paginator, PAGE_SIZE } from "../components/Paginator.js";

export function SecretsPage() {
  const { data, isLoading, error } = useSecrets();
  const createSecret = useCreateSecret();
  const deleteSecret = useDeleteSecret();

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [search]);

  const q = search.toLowerCase();
  const filtered = (data?.items ?? []).filter((s) => !q || s.name?.toLowerCase().includes(q));
  const pageCount = Math.ceil(filtered.length / PAGE_SIZE);
  const secrets = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    createSecret.mutate(
      { name, value },
      {
        onSuccess: () => {
          setName("");
          setValue("");
          setCreating(false);
        },
        onError: (err) => setFormError(String(err)),
      }
    );
  }

  if (isLoading) return <p className="text-slate-400">Loading secrets…</p>;
  if (error) return <p className="text-red-400">Error: {String(error)}</p>;

  return (
    <div className="space-y-6">
      {deleteTarget && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/60 z-50">
          <div className="rounded-lg border border-slate-700 bg-slate-800 p-6 w-full max-w-sm">
            <h2 className="text-lg font-bold mb-2">Delete secret</h2>
            <p className="text-sm text-slate-400 mb-4">
              Delete <span className="font-mono text-white">{deleteTarget}</span>? This cannot be undone.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  deleteSecret.mutate(deleteTarget);
                  setDeleteTarget(null);
                }}
                className="rounded bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
              >
                Delete
              </button>
              <button
                onClick={() => setDeleteTarget(null)}
                className="rounded bg-slate-600 px-4 py-2 text-sm font-medium text-white hover:bg-slate-500"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">Secrets</h1>
        <input
          type="search"
          placeholder="Search secrets… (Enter)"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setSearch(searchDraft); }}
          className="flex-1 max-w-xs rounded bg-slate-700 px-3 py-2 text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={() => setCreating(true)}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 shrink-0"
        >
          + New secret
        </button>
      </div>

      {creating && (
        <div className="rounded-lg border border-slate-700 bg-slate-800 p-6">
          <h2 className="text-lg font-bold mb-4">Add secret</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">Name</label>
              <input
                className="w-full rounded bg-slate-700 px-3 py-2 text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="MY_API_KEY"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">Value</label>
              <input
                type="password"
                className="w-full rounded bg-slate-700 px-3 py-2 text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="sk-…"
                required
              />
            </div>
            {formError && <p className="text-red-400 text-sm">{formError}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={createSecret.isPending}
                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {createSecret.isPending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="rounded bg-slate-600 px-4 py-2 text-sm font-medium text-white hover:bg-slate-500"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-700">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-slate-400 text-xs uppercase">
            <tr>
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Created</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700 bg-slate-900">
            {secrets.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-slate-500">
                  No secrets yet
                </td>
              </tr>
            )}
            {secrets.map((s) => (
              <tr key={s.name}>
                <td className="px-4 py-3 font-mono">{s.name}</td>
                <td className="px-4 py-3 text-slate-500">
                  {s.createdAt ? new Date(s.createdAt).toLocaleDateString() : "—"}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => setDeleteTarget(s.name)}
                    className="rounded bg-red-900 px-3 py-1 text-xs font-medium text-red-300 hover:bg-red-800"
                  >
                    Delete
                  </button>
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
