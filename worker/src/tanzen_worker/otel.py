"""
OpenTelemetry instrumentation for the Tanzen Temporal worker.

Metrics (Prometheus):  enabled when OTEL_ENABLED=true
Traces (OTLP/HTTP):    enabled when OTEL_TRACE_ENDPOINT is set
                       e.g. http://grafana-tempo:4318
                       Traces appear in Grafana → Explore → Tempo.

Public API
----------
init_worker_otel()       Call once at worker startup (metrics).
init_worker_traces()     Call once at worker startup (traces).
get_tracer()             Return the module tracer (no-op when disabled).
record_activity_complete(activity_name, status, duration_ms)
record_llm_usage(model, agent_id, tokens, cost_usd)
"""
from __future__ import annotations

import os
from typing import Optional

# These are module-level singletons populated by init_worker_otel().
_activity_counter: Optional[object] = None
_activity_duration: Optional[object] = None
_llm_tokens_counter: Optional[object] = None
_llm_cost_histogram: Optional[object] = None
_initialised: bool = False
_traces_initialised: bool = False


def init_worker_otel() -> None:
    """Initialise OTel MeterProvider with a Prometheus exporter on port 9465.

    No-op unless ``OTEL_ENABLED=true``.
    """
    global _activity_counter, _activity_duration
    global _llm_tokens_counter, _llm_cost_histogram, _initialised

    if os.environ.get("OTEL_ENABLED", "").lower() != "true":
        return
    if _initialised:
        return
    _initialised = True

    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import (
        ConsoleMetricExporter,  # noqa: F401 — kept for reference
    )
    from opentelemetry.sdk.resources import Resource, SERVICE_NAME, SERVICE_VERSION
    from opentelemetry.exporter.prometheus import PrometheusMetricReader
    from prometheus_client import start_http_server  # bundled with exporter

    # Start the Prometheus HTTP server on the worker metrics port
    start_http_server(9465)

    resource = Resource.create({
        SERVICE_NAME: "tanzen-worker",
        SERVICE_VERSION: "0.1.0",
    })

    reader = PrometheusMetricReader()
    provider = MeterProvider(resource=resource, metric_readers=[reader])

    # Register as global meter provider
    from opentelemetry import metrics
    metrics.set_meter_provider(provider)

    meter = metrics.get_meter("tanzen-worker", "0.1.0")

    _activity_counter = meter.create_counter(
        name="tanzen_activity_total",
        description="Total number of Temporal activities executed",
        unit="{activity}",
    )

    _activity_duration = meter.create_histogram(
        name="tanzen_activity_duration_seconds",
        description="Duration of Temporal activity execution",
        unit="s",
    )

    _llm_tokens_counter = meter.create_counter(
        name="tanzen_llm_tokens_total",
        description="Total LLM tokens consumed",
        unit="{token}",
    )

    _llm_cost_histogram = meter.create_histogram(
        name="tanzen_llm_cost_usd",
        description="LLM inference cost in USD",
        unit="USD",
    )

    print("Worker OTel initialised — Prometheus metrics on :9465/metrics")


def init_worker_traces() -> None:
    """Initialise OTel TracerProvider with OTLP HTTP export.

    No-op unless ``OTEL_TRACE_ENDPOINT`` is set, e.g.:
        OTEL_TRACE_ENDPOINT=http://grafana-tempo:4318

    Traces appear in Grafana → Explore → Tempo.
    Requires: opentelemetry-exporter-otlp-proto-http (installed by default).
    """
    global _traces_initialised
    endpoint = os.environ.get("OTEL_TRACE_ENDPOINT", "")
    if not endpoint or _traces_initialised:
        return
    _traces_initialised = True

    try:
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry import trace as otel_trace
        from opentelemetry.sdk.resources import Resource, SERVICE_NAME, SERVICE_VERSION

        resource = Resource.create({
            SERVICE_NAME: "tanzen-worker",
            SERVICE_VERSION: "0.1.0",
        })
        provider = TracerProvider(resource=resource)
        # Append /v1/traces if the endpoint is a bare base URL
        trace_endpoint = endpoint.rstrip("/")
        if not trace_endpoint.endswith("/traces"):
            trace_endpoint += "/v1/traces"
        exporter = OTLPSpanExporter(endpoint=trace_endpoint)
        provider.add_span_processor(BatchSpanProcessor(exporter))
        otel_trace.set_tracer_provider(provider)
        print(f"Worker OTel traces → {trace_endpoint}")
    except ImportError:
        print(
            "Warning: OTEL_TRACE_ENDPOINT set but opentelemetry-exporter-otlp-proto-http "
            "is not installed. Install it or remove OTEL_TRACE_ENDPOINT."
        )
    except Exception as exc:
        print(f"Warning: OTel trace init failed: {exc}")


def get_tracer():
    """Return the tanzen-worker OTel tracer.

    Always safe to call — returns a no-op tracer when tracing is disabled.
    """
    from opentelemetry import trace
    return trace.get_tracer("tanzen-worker", "0.1.0")


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def record_activity_complete(
    activity_name: str,
    status: str,
    duration_ms: float,
) -> None:
    """Record a completed activity.  Safe to call when OTel is disabled."""
    if _activity_counter is not None:
        try:
            _activity_counter.add(  # type: ignore[union-attr]
                1,
                {"activity_name": activity_name, "status": status},
            )
        except Exception:
            pass

    if _activity_duration is not None:
        try:
            _activity_duration.record(  # type: ignore[union-attr]
                duration_ms / 1000.0,
                {"activity_name": activity_name},
            )
        except Exception:
            pass


def record_llm_usage(
    model: str,
    agent_id: str,
    tokens: int,
    cost_usd: float,
) -> None:
    """Record LLM token and cost metrics.  Safe to call when OTel is disabled."""
    if _llm_tokens_counter is not None:
        try:
            _llm_tokens_counter.add(  # type: ignore[union-attr]
                tokens,
                {"model": model, "agent_id": agent_id},
            )
        except Exception:
            pass

    if _llm_cost_histogram is not None:
        try:
            _llm_cost_histogram.record(  # type: ignore[union-attr]
                cost_usd,
                {"model": model, "agent_id": agent_id},
            )
        except Exception:
            pass
