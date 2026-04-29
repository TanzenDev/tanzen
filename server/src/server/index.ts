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
import { secureHeaders } from "hono/secure-headers";
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
import { bundleRoutes } from "./routes/bundles.js";
import { migrate } from "./db.js";
import { ensureBuckets } from "./s3.js";
import { rateLimit, userKey } from "./ratelimit.js";
import { getPlugins } from "./plugins.js";
import { Scalar } from "@scalar/hono-api-reference";
import { openapiSpec } from "./openapi.js";

export { registerPlugin, type TanzenPlugin } from "./plugins.js";

const app = new Hono();

function resolveAllowedOrigins(): string | string[] {
  if (process.env["ALLOWED_ORIGINS"]) {
    return process.env["ALLOWED_ORIGINS"].split(",").map((o) => o.trim());
  }
  if (process.env["NODE_ENV"] === "production") {
    throw new Error(
      "ALLOWED_ORIGINS must be set in production. " +
      "Example: ALLOWED_ORIGINS=https://app.example.com",
    );
  }
  return ["http://localhost:5173", "http://localhost:3000"];
}

// Global middleware
app.use("*", logger());
app.use("*", secureHeaders());
app.use("*", cors({
  origin: resolveAllowedOrigins(),
  allowHeaders: ["Authorization", "Content-Type"],
  maxAge: 600,
}));

// Global rate limit: 300 req/min per IP (covers unauthenticated endpoints too)
// Override with RATE_LIMIT_GLOBAL / RATE_LIMIT_API env vars for load-test environments.
const RL_GLOBAL = parseInt(process.env["RATE_LIMIT_GLOBAL"] ?? "300", 10);
const RL_API    = parseInt(process.env["RATE_LIMIT_API"]    ?? "60",  10);
app.use("*", rateLimit({ windowMs: 60_000, max: RL_GLOBAL }));

// Health check — no auth required
app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// OpenAPI spec + Scalar UI — public, no auth required
app.get("/openapi.json", (c) => c.json(openapiSpec));
app.get("/docs", Scalar({ url: "/openapi.json" }));

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
api.use("*", rateLimit({ windowMs: 60_000, max: RL_API, keyFn: userKey }));

// Plugin middleware registered here so Hono dispatches to them before route
// handlers. Plugins are pre-registered via plugins.ts before this module runs.
for (const p of getPlugins()) {
  if (p.apiMiddleware) api.use("*", p.apiMiddleware);
}

api.route("/workflows", workflowRoutes);
api.route("/agents",   agentRoutes);
api.route("/runs",     runRoutes);
api.route("/gates",    gateRoutes);
api.route("/secrets",  secretRoutes);
api.route("/metrics",     metricsRoutes);
api.route("/mcp-servers", mcpServerRoutes);
api.route("/scripts",  scriptRoutes);
api.route("/settings", settingsRoutes);
api.route("/bundles",  bundleRoutes);

// 404 fallback
app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

const port = parseInt(process.env["PORT"] ?? "3000", 10);

// Run plugin migrations, then core migrations, then startup hooks.
// Plugin routes are added to `api` before mounting on `app` so Hono's
// route table includes them when app.route() copies the sub-app.
for (const p of getPlugins()) {
  if (p.migrations) await p.migrations();
}
await migrate();
await ensureBuckets();
for (const p of getPlugins()) {
  if (p.onStartup) await p.onStartup();
  if (p.routes) api.route(`/${p.name}`, p.routes);
  if (p.publicRoutes) app.route(`/${p.name}`, p.publicRoutes);
}

// Mount api AFTER all plugin routes have been added.
app.route("/api", api);

console.log(`Tanzen API server listening on :${port}`);

export default {
  port,
  fetch: app.fetch,
  // SSE connections are long-lived; disable Bun's 10s default idle timeout
  idleTimeout: 0,
  maxRequestBodySize: 10 * 1024 * 1024, // 10 MB
};

export { app };
