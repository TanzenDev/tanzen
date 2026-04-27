import { useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useMetrics } from "../api/hooks.js";

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export function MetricsPage() {
  const defaultTo = isoDate(new Date());
  const defaultFrom = isoDate(new Date(Date.now() - 7 * 86400_000));

  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);

  // Append end-of-day time so the `to` date is inclusive (BETWEEN uses midnight otherwise)
  const { data, isLoading, error } = useMetrics({ from, to: `${to}T23:59:59Z` });

  if (isLoading) return <p className="text-slate-400">Loading metrics…</p>;
  if (error) return <p className="text-red-400">Error: {String(error)}</p>;

  const summary = data?.summary;
  const byWorkflow = data?.byWorkflow ?? [];
  const tokenSummary = data?.tokenSummary ?? [];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Metrics</h1>
        <div className="flex items-center gap-3">
          <label className="text-xs dark:text-slate-400 text-slate-600">From</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded dark:bg-slate-700 bg-slate-100 px-2 py-1 text-sm dark:text-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <label className="text-xs dark:text-slate-400 text-slate-600">To</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded dark:bg-slate-700 bg-slate-100 px-2 py-1 text-sm dark:text-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            { label: "Total runs", value: summary.total_runs },
            { label: "Succeeded", value: summary.succeeded },
            { label: "Failed", value: summary.failed },
            {
              label: "Avg duration",
              value:
                summary.avg_duration_s !== null
                  ? `${summary.avg_duration_s.toFixed(1)}s`
                  : "—",
            },
          ].map(({ label, value }) => (
            <div
              key={label}
              className="rounded-lg border dark:border-slate-700 border-slate-200 dark:bg-slate-800 bg-white p-4 text-center"
            >
              <p className="text-2xl font-bold">{value}</p>
              <p className="text-xs dark:text-slate-400 text-slate-600 mt-1">{label}</p>
            </div>
          ))}
        </div>
      )}

      {byWorkflow.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider dark:text-slate-400 text-slate-600 mb-3">
            Runs by workflow
          </h2>
          <div className="rounded-lg border dark:border-slate-700 border-slate-200 dark:bg-slate-800 bg-white p-4">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={byWorkflow} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis
                  dataKey="workflow_id"
                  tick={{ fill: "#94a3b8", fontSize: 10 }}
                  tickFormatter={(v: string) => v.slice(0, 8)}
                />
                <YAxis tick={{ fill: "#94a3b8", fontSize: 10 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: "#1e293b", border: "1px solid #334155" }}
                  labelStyle={{ color: "#cbd5e1" }}
                />
                <Bar dataKey="run_count" fill="#3b82f6" name="Runs" radius={[4, 4, 0, 0]} />
                <Bar dataKey="succeeded" fill="#22c55e" name="Succeeded" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {tokenSummary.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider dark:text-slate-400 text-slate-600 mb-3">
            Token usage by agent
          </h2>
          <div className="overflow-hidden rounded-lg border dark:border-slate-700 border-slate-200">
            <table className="w-full text-sm dark:bg-slate-900 bg-white">
              <thead className="dark:bg-slate-800 bg-white dark:text-slate-400 text-slate-600 text-xs uppercase">
                <tr>
                  <th className="px-4 py-3 text-left">Agent</th>
                  <th className="px-4 py-3 text-right">Tokens</th>
                  <th className="px-4 py-3 text-right">Cost (USD)</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-slate-700 divide-slate-200">
                {tokenSummary.map((row) => (
                  <tr key={row.agent_id}>
                    <td className="px-4 py-3 font-mono text-xs">{row.agent_id.slice(0, 12)}…</td>
                    <td className="px-4 py-3 text-right">{row.total_tokens.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right">${row.total_cost.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!summary && byWorkflow.length === 0 && (
        <p className="text-slate-500">No data for the selected period.</p>
      )}
    </div>
  );
}
