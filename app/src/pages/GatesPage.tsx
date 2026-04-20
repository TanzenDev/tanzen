import { useState } from "react";
import { useGates, useApproveGate, useRejectGate } from "../api/hooks.js";
import type { Gate } from "../api/client.js";

function NotesModal({
  gate,
  action,
  onConfirm,
  onCancel,
}: {
  gate: Gate;
  action: "approve" | "reject";
  onConfirm: (notes: string) => void;
  onCancel: () => void;
}) {
  const [notes, setNotes] = useState("");

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/60 z-50">
      <div className="rounded-lg border border-slate-700 bg-slate-800 p-6 w-full max-w-sm">
        <h2 className="text-lg font-bold mb-1">{action === "approve" ? "Approve" : "Reject"} gate</h2>
        <p className="text-sm text-slate-400 mb-4">
          Run {gate.run_id.slice(0, 8)} · step {gate.step_id}
        </p>
        <div className="mb-4">
          <label className="block text-sm font-medium text-slate-300 mb-1">
            Notes (optional)
          </label>
          <textarea
            className="w-full rounded bg-slate-700 px-3 py-2 text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Add a comment…"
          />
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => onConfirm(notes)}
            className={`rounded px-4 py-2 text-sm font-medium text-white ${
              action === "approve"
                ? "bg-green-600 hover:bg-green-500"
                : "bg-red-700 hover:bg-red-600"
            }`}
          >
            Confirm {action}
          </button>
          <button
            onClick={onCancel}
            className="rounded bg-slate-600 px-4 py-2 text-sm font-medium text-white hover:bg-slate-500"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function GatesPage() {
  const { data, isLoading, error } = useGates();
  const approve = useApproveGate();
  const reject = useRejectGate();
  const [modal, setModal] = useState<{ gate: Gate; action: "approve" | "reject" } | null>(null);

  if (isLoading) return <p className="text-slate-400">Loading gates…</p>;
  if (error) return <p className="text-red-400">Error: {String(error)}</p>;

  const gates = data?.items ?? [];
  const pending = gates.filter((g) => g.status === "pending");
  const reviewed = gates.filter((g) => g.status !== "pending");

  function handleConfirm(notes: string) {
    if (!modal) return;
    const { gate, action } = modal;
    const mutate = action === "approve" ? approve.mutate : reject.mutate;
    mutate({ id: gate.id, notes });
    setModal(null);
  }

  function GateRow({ gate }: { gate: Gate }) {
    return (
      <tr className="border-b border-slate-700 last:border-0">
        <td className="px-4 py-3 font-mono text-xs">{gate.run_id.slice(0, 12)}…</td>
        <td className="px-4 py-3 text-sm">{gate.step_id}</td>
        <td className="px-4 py-3 text-sm text-slate-400">{gate.assignee}</td>
        <td className="px-4 py-3 text-slate-500 text-xs">
          {new Date(gate.opened_at).toLocaleString()}
        </td>
        <td className="px-4 py-3">
          {gate.status === "pending" ? (
            <div className="flex gap-2">
              <button
                onClick={() => setModal({ gate, action: "approve" })}
                className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-500"
              >
                Approve
              </button>
              <button
                onClick={() => setModal({ gate, action: "reject" })}
                className="rounded bg-red-700 px-3 py-1 text-xs font-medium text-white hover:bg-red-600"
              >
                Reject
              </button>
            </div>
          ) : (
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                gate.status === "approved"
                  ? "bg-green-800 text-green-200"
                  : "bg-red-800 text-red-200"
              }`}
            >
              {gate.status}
            </span>
          )}
        </td>
      </tr>
    );
  }

  return (
    <div className="space-y-6">
      {modal && (
        <NotesModal
          gate={modal.gate}
          action={modal.action}
          onConfirm={handleConfirm}
          onCancel={() => setModal(null)}
        />
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Gates</h1>
        {pending.length > 0 && (
          <span className="rounded-full bg-amber-500 px-3 py-1 text-xs font-bold text-white">
            {pending.length} pending
          </span>
        )}
      </div>

      {pending.length === 0 && reviewed.length === 0 && (
        <p className="text-slate-500">No gates yet.</p>
      )}

      {pending.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-2">
            Pending
          </h2>
          <div className="overflow-hidden rounded-lg border border-slate-700">
            <table className="w-full text-sm bg-slate-900">
              <thead className="bg-slate-800 text-slate-400 text-xs uppercase">
                <tr>
                  <th className="px-4 py-3 text-left">Run</th>
                  <th className="px-4 py-3 text-left">Step</th>
                  <th className="px-4 py-3 text-left">Assignee</th>
                  <th className="px-4 py-3 text-left">Opened</th>
                  <th className="px-4 py-3 text-left">Action</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((g) => (
                  <GateRow key={g.id} gate={g} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {reviewed.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-2">
            Reviewed
          </h2>
          <div className="overflow-hidden rounded-lg border border-slate-700">
            <table className="w-full text-sm bg-slate-900">
              <thead className="bg-slate-800 text-slate-400 text-xs uppercase">
                <tr>
                  <th className="px-4 py-3 text-left">Run</th>
                  <th className="px-4 py-3 text-left">Step</th>
                  <th className="px-4 py-3 text-left">Assignee</th>
                  <th className="px-4 py-3 text-left">Opened</th>
                  <th className="px-4 py-3 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {reviewed.map((g) => (
                  <GateRow key={g.id} gate={g} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
