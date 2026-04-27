import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Moon, Sun } from "lucide-react";
import { api } from "../api/client.js";
import type { Settings } from "../api/client.js";
import { useTheme } from "../context/ThemeContext.js";

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
        checked ? "bg-cyan-600" : "dark:bg-slate-600 bg-slate-300"
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
    <div className="flex items-start justify-between gap-6 py-4 border-b dark:border-slate-700 border-slate-200 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium dark:text-white text-slate-900">{label}</p>
        <p className="text-xs dark:text-slate-400 text-slate-500 mt-0.5">{description}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
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

      {/* Appearance */}
      <div className="rounded-lg border dark:border-slate-700 border-slate-200 dark:bg-slate-800 bg-white">
        <div className="px-6 py-3 border-b dark:border-slate-700 border-slate-200">
          <h2 className="text-xs font-semibold dark:text-slate-400 text-slate-500 uppercase tracking-wider">Appearance</h2>
        </div>
        <div className="px-6 py-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium dark:text-white text-slate-900">Theme</p>
            <p className="text-xs dark:text-slate-400 text-slate-500 mt-0.5">Preference is saved in your browser.</p>
          </div>
          <div className="flex gap-1 rounded-lg p-1 dark:bg-slate-700 bg-slate-100">
            {(["dark", "light"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                  theme === t
                    ? "dark:bg-slate-900 bg-white shadow dark:text-white text-slate-900"
                    : "dark:text-slate-400 text-slate-500 dark:hover:text-white hover:text-slate-900"
                }`}
              >
                {t === "dark" ? <Moon size={12} /> : <Sun size={12} />}
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg border dark:border-slate-700 border-slate-200 dark:bg-slate-800 bg-white">
        <div className="px-6 py-3 border-b dark:border-slate-700 border-slate-200">
          <h2 className="text-xs font-semibold dark:text-slate-400 text-slate-500 uppercase tracking-wider">Code Execution</h2>
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
