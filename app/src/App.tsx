import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout.js";
import { AgentsPage } from "./pages/AgentsPage.js";
import { WorkflowsPage } from "./pages/WorkflowsPage.js";
import { RunsPage } from "./pages/RunsPage.js";
import { GatesPage } from "./pages/GatesPage.js";
import { MetricsPage } from "./pages/MetricsPage.js";
import { SecretsPage } from "./pages/SecretsPage.js";
import { ScriptsPage } from "./pages/ScriptsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { ExtensionProvider, useExtensionRoutes } from "./extensions/registry.js";
import { ProtectedRoute } from "./components/ProtectedRoute.js";

function AppRoutes() {
  const extRoutes = useExtensionRoutes();
  return (
    <ProtectedRoute>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/agents" replace />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/gates" element={<GatesPage />} />
          <Route path="/metrics" element={<MetricsPage />} />
          <Route path="/secrets" element={<SecretsPage />} />
          <Route path="/scripts" element={<ScriptsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          {extRoutes.map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
        </Route>
      </Routes>
    </ProtectedRoute>
  );
}

export default function App() {
  return (
    <ExtensionProvider>
      <AppRoutes />
    </ExtensionProvider>
  );
}
