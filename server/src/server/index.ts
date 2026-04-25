/**
 * Tanzen API server — Hono on Bun.
 *
 * Mounts all route groups under /api/* behind Clerk JWT auth middleware.
 * Run with: bun run src/server/index.ts
 */
import { initOtel, getMetrics } from "./otel.js";

// OTel must be initialised before any other imports so auto-instrumentation
// can patch Node.js built-ins before they are first used.
initOtel();

import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { authMiddleware } from "./auth.js";
import { workflowRoutes } from "./routes/workflows.js";
import { agentRoutes } from "./routes/agents.js";
import { runRoutes } from "./routes/runs.js";
import { gateRoutes } from "./routes/gates.js";
import { secretRoutes } from "./routes/secrets.js";
import { metricsRoutes } from "./routes/metrics.js";
import { mcpServerRoutes } from "./routes/mcpServers.js";
import { scriptRoutes } from "./routes/scripts.js";
import { settingsRoutes } from "./routes/settings.js";
import { migrate } from "./db.js";
import { ensureBuckets } from "./s3.js";
import { rateLimit, userKey } from "./ratelimit.js";

// ---------------------------------------------------------------------------
// Plugin registry — commercial builds call registerPlugin() before startup
// ---------------------------------------------------------------------------

export interface TanzenPlugin {
  name: string;
  /** Mount additional routes on the /api sub-app */
  routes?: Hono;
  /** Run after migrate() and ensureBuckets() */
  onStartup?: () => Promise<void>;
  /** Additional DB migrations to run idempotently before core migrations */
  migrations?: () => Promise<void>;
}

const _plugins: TanzenPlugin[] = [];

export function registerPlugin(p: TanzenPlugin): void {
  _plugins.push(p);
}

const app = new Hono();

// Global middleware
app.use("*", logger());
app.use("*", cors({
  origin: process.env["ALLOWED_ORIGINS"]?.split(",") ?? "*",
  allowHeaders: ["Authorization", "Content-Type"],
}));

// Global rate limit: 300 req/min per IP (covers unauthenticated endpoints too)
app.use("*", rateLimit({ windowMs: 60_000, max: 300 }));

// Health check — no auth required
app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// Prometheus metrics endpoint — no auth required (scraped by kube-prometheus)
app.get("/metrics", async (c) => {
  const { text, status } = await getMetrics();
  return c.text(text, status as 200 | 501 | 503, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  });
});

// All /api/* routes require auth
const api = new Hono();
api.use("*", authMiddleware);

// Per-user rate limit on mutating operations (60 req/min)
api.use("*", rateLimit({ windowMs: 60_000, max: 60, keyFn: userKey }));

api.route("/workflows", workflowRoutes);
api.route("/agents",   agentRoutes);
api.route("/runs",     runRoutes);
api.route("/gates",    gateRoutes);
api.route("/secrets",  secretRoutes);
api.route("/metrics",     metricsRoutes);
api.route("/mcp-servers", mcpServerRoutes);
api.route("/scripts",  scriptRoutes);
api.route("/settings", settingsRoutes);

app.route("/api", api);

// 404 fallback
app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

const port = parseInt(process.env["PORT"] ?? "3000", 10);

// Run plugin migrations, then core migrations, then startup hooks
for (const p of _plugins) {
  if (p.migrations) await p.migrations();
}
await migrate();
await ensureBuckets();
for (const p of _plugins) {
  if (p.onStartup) await p.onStartup();
  if (p.routes) api.route(`/${p.name}`, p.routes);
}
console.log(`Tanzen API server listening on :${port}`);

export default {
  port,
  fetch: app.fetch,
  // SSE connections are long-lived; disable Bun's 10s default idle timeout
  idleTimeout: 0,
};

export { app };
