import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import { useRuns, useRun, useDeleteRun, useWorkflow } from "../api/hooks.js";
import { api } from "../api/client.js";
import type { Run, RunStep, RunEvent } from "../api/client.js";
import { Paginator, PAGE_SIZE } from "../components/Paginator.js";
import { useSlot } from "../extensions/registry.js";

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  running:       "bg-blue-700 text-blue-200",
  succeeded:     "bg-green-800 text-green-200",
  failed:        "bg-red-800 text-red-200",
  awaiting_gate: "bg-amber-700 text-amber-200",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[status] ?? "bg-slate-700 text-slate-300"}`}>
      {status}
    </span>
  );
}

// ─── Event type badge ─────────────────────────────────────────────────────────

const EVENT_COLORS: Record<string, string> = {
  step_started:   "bg-blue-900 text-blue-300",
  step_completed: "bg-green-900 text-green-300",
  step_failed:    "bg-red-900 text-red-300",
  gate_opened:    "bg-amber-900 text-amber-300",
  gate_resolved:  "bg-amber-800 text-amber-200",
  run_completed:  "bg-emerald-900 text-emerald-300",
  run_failed:     "bg-red-900 text-red-300",
  connected:      "bg-slate-700 text-slate-400",
};

function EventBadge({ type }: { type: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-mono font-medium shrink-0 ${EVENT_COLORS[type] ?? "bg-slate-700 text-slate-400"}`}>
      {type}
    </span>
  );
}

// ─── Artifact viewer ──────────────────────────────────────────────────────────

const ARTIFACT_TRUNCATE_CHARS = 20_000;

function ArtifactPanel({ runId, artifactKey, label }: { runId: string; artifactKey: string; label: string }) {
  const [content, setContent] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function load() {
    if (content || loading) return;
    setLoading(true);
    try {
      const data = await api.runs.artifact(runId, artifactKey);
      setContent(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    setOpen((o) => !o);
    if (!open) load();
  }

  return (
    <div className="border border-slate-700 rounded">
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-slate-300 hover:bg-slate-800 rounded"
      >
        <span className="font-medium">{label}</span>
        <span className="text-slate-500 font-mono text-[10px] truncate max-w-[200px] ml-2">{artifactKey.split("/").slice(-2).join("/")}</span>
        <span className="ml-2 shrink-0">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="border-t border-slate-700 bg-slate-950 rounded-b max-h-64 overflow-auto">
          {loading && <p className="px-3 py-2 text-xs text-slate-500">Loading…</p>}
          {error && <p className="px-3 py-2 text-xs text-red-400">{error}</p>}
          {content && (() => {
            const text = JSON.stringify(content, null, 2);
            const truncated = !expanded && text.length > ARTIFACT_TRUNCATE_CHARS;
            const display = truncated ? text.slice(0, ARTIFACT_TRUNCATE_CHARS) : text;
            return (
              <>
                <pre className="px-3 py-2 text-[10px] text-slate-300 font-mono whitespace-pre-wrap leading-relaxed">
                  {display}{truncated ? "…" : ""}
                </pre>
                {text.length > ARTIFACT_TRUNCATE_CHARS && (
                  <button
                    onClick={() => setExpanded((e) => !e)}
                    className="w-full px-3 py-1.5 text-[10px] text-slate-400 hover:text-slate-200 border-t border-slate-700 text-left"
                  >
                    {expanded
                      ? "Collapse"
                      : `Show all (${text.length.toLocaleString()} chars)`}
                  </button>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ─── Step row ─────────────────────────────────────────────────────────────────

function StepRow({ step, runId }: { step: RunStep; runId: string }) {
  const [open, setOpen] = useState(false);
  const isTask = step.step_type === "task";
  const duration = step.duration_ms != null
    ? `${(step.duration_ms / 1000).toFixed(2)}s`
    : step.completed_at
    ? `${((new Date(step.completed_at).getTime() - new Date(step.started_at).getTime()) / 1000).toFixed(1)}s`
    : null;

  return (
    <div className="border border-slate-700 rounded bg-slate-900">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-800 rounded"
      >
        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0 ${isTask ? "bg-violet-900 text-violet-300" : "bg-blue-900 text-blue-300"}`}>
          {isTask ? "task" : "agent"}
        </span>
        <span className="font-mono text-xs text-slate-200 font-medium">{step.step_id}</span>
        {isTask && step.action && (
          <span className="font-mono text-[10px] text-slate-500">{step.action}</span>
        )}
        {!isTask && step.agent_id && (
          <span className="font-mono text-[10px] text-slate-500">{step.agent_id}</span>
        )}
        <StatusBadge status={step.status} />
        <div className="flex-1" />
        {step.token_count > 0 && (
          <span className="text-[10px] text-slate-500">{step.token_count.toLocaleString()} tok</span>
        )}
        {duration && <span className="text-[10px] text-slate-500">{duration}</span>}
        <span className="text-slate-600 text-xs ml-1">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="border-t border-slate-700 p-3 space-y-2">
          {step.status === "failed" && (step as RunStep & { error?: string }).error && (
            <div className="rounded border border-red-800 bg-red-950 px-3 py-2">
              <p className="text-[10px] font-semibold text-red-400 mb-0.5">Error</p>
              <p className="text-[10px] text-red-300 font-mono whitespace-pre-wrap break-all">
                {(step as RunStep & { error?: string }).error}
              </p>
            </div>
          )}
          {step.input_artifact_key && (
            <ArtifactPanel runId={runId} artifactKey={step.input_artifact_key} label="Input" />
          )}
          {step.output_artifact_key && (
            <ArtifactPanel runId={runId} artifactKey={step.output_artifact_key} label="Output" />
          )}
          {!step.input_artifact_key && !step.output_artifact_key && (
            <p className="text-xs text-slate-600 px-1">No artifacts recorded for this step.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Live event hook (SSE) ────────────────────────────────────────────────────

function useLiveEvents(runId: string, active: boolean, onEvent: (e: RunEvent) => void) {
  const onEventRef = useRef(onEvent);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);

  useEffect(() => {
    if (!active) return;
    const es = new EventSource(`/api/runs/${runId}/events`);
    es.addEventListener("run_event", (e) => {
      try {
        const parsed = JSON.parse((e as MessageEvent).data) as {
          event_type: string; step_id: string | null; data: Record<string, unknown>; ts: number;
        };
        onEventRef.current({
          id: `live-${Date.now()}-${Math.random()}`,
          event_type: parsed.event_type,
          step_id: parsed.step_id,
          data: parsed.data,
          ts: parsed.ts,
        });
      } catch { /* ignore */ }
    });
    es.addEventListener("connected", () => {
      onEventRef.current({
        id: `live-connected-${Date.now()}`,
        event_type: "connected",
        step_id: null,
        data: {},
        ts: Date.now() / 1000,
      });
    });
    return () => es.close();
  }, [runId, active]);
}

// ─── Run detail ───────────────────────────────────────────────────────────────

function RunDetail({ run, onClose }: { run: Run; onClose: () => void }) {
  const { data } = useRun(run.id);
  const detail = data ?? run;
  const RunDetailFooter = useSlot("run-detail-footer");
  const { data: workflow } = useWorkflow(detail.workflow_id);
  const isLive = detail.status === "running" || detail.status === "awaiting_gate";
  const deleteRun = useDeleteRun();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [tab, setTab] = useState<"overview" | "events" | "steps">(
    detail.steps?.length ? "steps" : "overview"
  );
  const [liveEvents, setLiveEvents] = useState<RunEvent[]>([]);
  const eventsEndRef = useRef<HTMLDivElement>(null);

  const handleLiveEvent = useCallback((e: RunEvent) => {
    setLiveEvents((prev) => [...prev, e]);
  }, []);

  useLiveEvents(detail.id, isLive, handleLiveEvent);

  // Auto-scroll events list
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [liveEvents]);

  const storedEvents = detail.events ?? [];
  const allEvents: RunEvent[] = [
    ...storedEvents,
    ...liveEvents.filter((le) => !storedEvents.some((se) => se.ts === le.ts && se.event_type === le.event_type)),
  ];

  const steps = detail.steps ?? [];

  const duration = detail.completed_at
    ? ((new Date(detail.completed_at).getTime() - new Date(detail.started_at).getTime()) / 1000).toFixed(1) + "s"
    : isLive
    ? "running…"
    : "—";

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800">
      {/* Header */}
      <div className="flex items-start justify-between p-4 border-b border-slate-700">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-mono text-sm font-bold text-white">{detail.id}</h2>
            <StatusBadge status={detail.status} />
            {isLive && <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />}
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            workflow{" "}
            <Link
              to="/workflows"
              className="font-mono text-blue-400 hover:text-blue-300 hover:underline"
            >
              {workflow?.name ?? detail.workflow_id.slice(0, 12) + "…"}
            </Link>
            {" · "}v{detail.workflow_version}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {confirmDelete ? (
            <>
              <button
                onClick={() => deleteRun.mutate(detail.id, { onSuccess: onClose })}
                disabled={deleteRun.isPending}
                className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
              >
                {deleteRun.isPending ? "Deleting…" : "Confirm delete"}
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
              <button
                onClick={onClose}
                className="rounded bg-slate-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-500"
              >
                Close
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-slate-700 px-4 pt-1">
        {(["overview", "events", "steps"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs font-medium rounded-t capitalize ${
              tab === t ? "bg-slate-700 text-white" : "text-slate-400 hover:text-white"
            }`}
          >
            {t === "steps" ? `Steps ${steps.length > 0 ? `(${steps.length})` : ""}` : t === "events" ? `Events ${allEvents.length > 0 ? `(${allEvents.length})` : ""}` : "Overview"}
          </button>
        ))}
      </div>

      <div className="p-4">
        {/* Overview tab */}
        {tab === "overview" && (
          <div className="space-y-4">
            {detail.status === "failed" && (
              <div className="rounded border border-red-700 bg-red-950 px-4 py-3">
                <p className="text-xs font-semibold text-red-400 mb-1">Run failed</p>
                <p className="text-xs text-red-300 font-mono whitespace-pre-wrap break-all">
                  {detail.error ?? "No error details recorded."}
                </p>
                {steps.length === 0 && (
                  <p className="text-xs text-red-400 mt-2 opacity-75">
                    No steps were executed — the failure occurred before the workflow began processing.
                  </p>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-xs text-slate-500 mb-0.5">Started</p>
                <p className="text-slate-200">{new Date(detail.started_at).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500 mb-0.5">Completed</p>
                <p className="text-slate-200">{detail.completed_at ? new Date(detail.completed_at).toLocaleString() : "—"}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500 mb-0.5">Duration</p>
                <p className="text-slate-200">{duration}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500 mb-0.5">Triggered by</p>
                <p className="text-slate-200">{detail.triggered_by}</p>
              </div>
              {detail.temporal_workflow_id && (
                <div className="col-span-2">
                  <p className="text-xs text-slate-500 mb-0.5">Temporal workflow ID</p>
                  <p className="font-mono text-xs text-slate-400 break-all">{detail.temporal_workflow_id}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Events tab */}
        {tab === "events" && (
          <div className="space-y-1 max-h-96 overflow-y-auto">
            {allEvents.length === 0 && (
              <p className="text-xs text-slate-500 py-4 text-center">
                {isLive ? "Waiting for events…" : "No events recorded for this run."}
              </p>
            )}
            {allEvents.map((ev) => (
              <div key={ev.id} className="flex items-start gap-2 py-1.5 border-b border-slate-700/50 last:border-0">
                <span className="text-[10px] text-slate-600 font-mono shrink-0 mt-0.5 w-20">
                  {new Date(ev.ts * 1000).toLocaleTimeString()}
                </span>
                <EventBadge type={ev.event_type} />
                {ev.step_id && (
                  <span className="text-[10px] font-mono text-slate-400 shrink-0">{ev.step_id}</span>
                )}
                {Object.keys(ev.data).length > 0 && (
                  <span className="text-[10px] text-slate-500 truncate">
                    {Object.entries(ev.data)
                      .filter(([k]) => !["output_artifact_key", "input_artifact_key"].includes(k))
                      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                      .join(" · ")}
                  </span>
                )}
              </div>
            ))}
            <div ref={eventsEndRef} />
          </div>
        )}

        {/* Steps & artifacts tab */}
        {tab === "steps" && (
          <div className="space-y-2">
            {steps.length === 0 && (
              <p className="text-xs text-slate-500 py-4 text-center">
                {isLive ? "Steps will appear as the run progresses." : "No step records for this run."}
              </p>
            )}
            {steps.map((step) => (
              <StepRow key={step.id} step={step} runId={detail.id} />
            ))}
          </div>
        )}
      </div>

      {RunDetailFooter && <RunDetailFooter run={detail as unknown as Record<string, unknown>} />}
    </div>
  );
}

// ─── Runs list page ───────────────────────────────────────────────────────────

export function RunsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const { data, isLoading, error } = useRuns(statusFilter ? { status: statusFilter } : undefined);
  const [selected, setSelected] = useState<Run | null>(null);
  useEffect(() => { setPage(0); }, [search, statusFilter]);

  if (isLoading) return <p className="text-slate-400">Loading runs…</p>;
  if (error) return <p className="text-red-400">Error: {String(error)}</p>;

  const q = search.toLowerCase();
  const filtered = (data?.items ?? []).filter(
    (r) => !q || r.id.toLowerCase().includes(q) || r.workflow_id.toLowerCase().includes(q) || r.triggered_by.toLowerCase().includes(q)
  );
  const pageCount = Math.ceil(filtered.length / PAGE_SIZE);
  const runs = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Runs</h1>
        <input
          type="search"
          placeholder="Search runs… (Enter)"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setSearch(searchDraft)}
          className="flex-1 max-w-xs rounded bg-slate-700 px-3 py-2 text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <select
          className="rounded bg-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="running">Running</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="awaiting_gate">Awaiting gate</option>
        </select>
      </div>

      {selected && <RunDetail run={selected} onClose={() => setSelected(null)} />}

      <div className="overflow-hidden rounded-lg border border-slate-700">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-slate-400 text-xs uppercase">
            <tr>
              <th className="px-4 py-3 text-left">Run ID</th>
              <th className="px-4 py-3 text-left">Workflow</th>
              <th className="px-4 py-3 text-left">Version</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Started</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700 bg-slate-900">
            {runs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                  No runs yet
                </td>
              </tr>
            )}
            {runs.map((r) => (
              <tr
                key={r.id}
                className={`cursor-pointer hover:bg-slate-800 ${selected?.id === r.id ? "bg-slate-800" : ""}`}
                onClick={() => setSelected((prev) => prev?.id === r.id ? null : r)}
              >
                <td className="px-4 py-3 font-mono text-xs">{r.id.slice(0, 20)}…</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-400">
                  {r.workflow_id.slice(0, 8)}
                </td>
                <td className="px-4 py-3 font-mono text-slate-400">v{r.workflow_version}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {new Date(r.started_at).toLocaleString()}
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
