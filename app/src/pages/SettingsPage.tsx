import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.js";
import type { Settings } from "../api/client.js";

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-500 disabled:opacity-50 ${
        checked ? "bg-cyan-600" : "bg-slate-600"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

interface SettingRowProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}

function SettingRow({ label, description, checked, onChange, disabled }: SettingRowProps) {
  return (
    <div className="flex items-start justify-between gap-6 py-4 border-b border-slate-700 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white">{label}</p>
        <p className="text-xs text-slate-400 mt-0.5">{description}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.settings.get(),
  });
  const patch = useMutation({
    mutationFn: (body: Partial<Settings>) => api.settings.patch(body),
    onSuccess: (updated) => qc.setQueryData(["settings"], updated),
  });

  const [error, setError] = useState<string | null>(null);

  function update(key: keyof Settings, value: boolean) {
    setError(null);
    patch.mutate({ [key]: value }, {
      onError: (e) => setError(String(e)),
    });
  }

  if (isLoading) return <p className="text-slate-400">Loading settings…</p>;
  if (!settings) return null;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-slate-400 mt-1">Operator-controlled feature flags. Changes take effect immediately.</p>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <div className="rounded-lg border border-slate-700 bg-slate-800 divide-y divide-slate-700">
        <div className="px-6 py-3">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Code Execution</h2>
        </div>
        <div className="px-6">
          <SettingRow
            label="Scripts"
            description="Allow TypeScript and Python scripts to be registered and used in workflow DSL. When off, existing scripts are preserved but new ones cannot be created and DSL compilation rejects script steps."
            checked={settings.scripts_enabled}
            onChange={(v) => update("scripts_enabled", v)}
            disabled={patch.isPending}
          />
          <SettingRow
            label="Agent code execution"
            description="Allow agents with code_execution: true to call execute_python() and execute_typescript() tools. Each execution runs in a sandboxed Deno V8 isolate with an ephemeral working directory."
            checked={settings.agent_code_execution_enabled}
            onChange={(v) => update("agent_code_execution_enabled", v)}
            disabled={patch.isPending}
          />
        </div>
      </div>
    </div>
  );
}
