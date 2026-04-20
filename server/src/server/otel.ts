/**
 * OpenTelemetry instrumentation for the Tanzen API server.
 *
 * Only initialises when OTEL_ENABLED=true so that tests and local dev
 * continue to work without a running Prometheus scrape target.
 *
 * Exports:
 *   initOtel()                              — call once before app setup
 *   recordRunStarted(workflowId)            — increment tanzen_run_started_total
 *   recordStepCompleted(workflowId, stepId, durationMs) — record step duration
 *   getMetricsHandler()                     — Hono handler for GET /metrics
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { Resource } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import {
  metrics,
  type Counter,
  type Histogram,
} from "@opentelemetry/api";

// Read service version from package.json at module load time
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const pkg = _require("../../package.json") as { version: string };

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let _exporter: PrometheusExporter | null = null;
let _sdk: NodeSDK | null = null;
let _runStartedCounter: Counter | null = null;
let _stepDurationHistogram: Histogram | null = null;
let _initialised = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise OTel SDK.  No-op unless OTEL_ENABLED=true.
 */
export function initOtel(): void {
  if (process.env["OTEL_ENABLED"] !== "true") {
    return;
  }
  if (_initialised) {
    return;
  }
  _initialised = true;

  _exporter = new PrometheusExporter(
    { port: 9464, endpoint: "/metrics" },
    () => {
      console.log("Prometheus metrics server listening on :9464/metrics");
    },
  );

  _sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: "tanzen-api",
      [ATTR_SERVICE_VERSION]: pkg.version,
    }),
    metricReader: _exporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Reduce noise from internal node internals
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  _sdk.start();

  // Build application meters after SDK is started
  const meter = metrics.getMeter("tanzen-api", pkg.version);

  _runStartedCounter = meter.createCounter("tanzen_run_started_total", {
    description: "Number of workflow runs started",
    unit: "{run}",
  });

  _stepDurationHistogram = meter.createHistogram(
    "tanzen_step_duration_milliseconds",
    {
      description: "Duration of individual workflow steps",
      unit: "ms",
      advice: {
        explicitBucketBoundaries: [
          50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
        ],
      },
    },
  );

  // Graceful shutdown
  process.on("SIGTERM", () => {
    _sdk?.shutdown().catch(console.error);
  });
}

/**
 * Increment the run-started counter.
 * Safe to call even when OTel is disabled — records are silently dropped.
 */
export function recordRunStarted(workflowId: string): void {
  _runStartedCounter?.add(1, { "workflow.id": workflowId });
}

/**
 * Record a completed workflow step with its duration.
 * Safe to call even when OTel is disabled.
 */
export function recordStepCompleted(
  workflowId: string,
  stepId: string,
  durationMs: number,
): void {
  _stepDurationHistogram?.record(durationMs, {
    "workflow.id": workflowId,
    "step.id": stepId,
  });
}

/**
 * Returns a Hono-compatible handler that serves the raw Prometheus text.
 * When OTel is disabled (no exporter) it returns a 501 Not Implemented.
 */
export async function getMetrics(): Promise<{ text: string; status: number }> {
  if (!_exporter) {
    return { text: "# OTel not enabled\n", status: 501 };
  }
  // PrometheusExporter exposes a collect() method that returns the metrics text
  return new Promise((resolve) => {
    _exporter!.collect().then(({ resourceMetrics }) => {
      // The exporter handles serialisation internally via its HTTP server;
      // for the Hono route we ask the registry directly.
      // Fall back to a delegated HTTP fetch to the exporter's own port.
      import("node:http").then(({ request }) => {
        const req = request(
          { hostname: "127.0.0.1", port: 9464, path: "/metrics", method: "GET" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () =>
              resolve({ text: Buffer.concat(chunks).toString(), status: 200 }),
            );
          },
        );
        req.on("error", () =>
          resolve({ text: "# metrics unavailable\n", status: 503 }),
        );
        req.end();
      });
    });
  });
}
