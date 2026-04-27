"""
Tanzen worker activities.

run_agent_activity: loads agent config from SeaweedFS, instantiates a
PydanticAI agent, runs it against the resolved input, writes input + output
artifacts to SeaweedFS, and publishes step events to Redis pub/sub.

open_gate_activity: M7 stub — auto-approves; real logic in M7.

write_output_activity: writes final run output record to SeaweedFS and
publishes run_completed event.
"""
from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any

import boto3
from botocore.config import Config
from temporalio import activity

from tanzen_worker.agent_config import AgentConfig, load_agent_config_from_s3
from tanzen_worker.events import EventType, RunEvent, publish_event
from tanzen_worker.otel import get_tracer, record_activity_complete, record_llm_usage


# ---------------------------------------------------------------------------
# S3 / SeaweedFS helpers
# ---------------------------------------------------------------------------

def _s3_client() -> Any:
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("S3_ENDPOINT_URL", "http://seaweedfs-s3:8333"),
        aws_access_key_id=os.environ.get("S3_ACCESS_KEY", "tanzen"),
        aws_secret_access_key=os.environ.get("S3_SECRET_KEY", "tanzen"),
        config=Config(signature_version="s3v4"),
        region_name="us-east-1",
    )


ARTIFACTS_BUCKET = os.environ.get("S3_ARTIFACTS_BUCKET", "artifacts")
AGENTS_BUCKET = os.environ.get("S3_AGENTS_BUCKET", "agents")


def _put_artifact(s3: Any, run_id: str, step_id: str, direction: str, payload: Any) -> str:
    label = step_id or "template"
    key = f"runs/{run_id}/{label}/{direction}/{uuid.uuid4()}.json"
    body = json.dumps(payload, default=str).encode()
    s3.put_object(Bucket=ARTIFACTS_BUCKET, Key=key, Body=body, ContentType="application/json")
    return key


# ---------------------------------------------------------------------------
# Activity input / output types
# ---------------------------------------------------------------------------

@dataclass
class AgentActivityInput:
    run_id: str
    step: dict[str, Any]
    resolved_input: Any
    resolved_params: dict[str, Any]
    # Inject config dict directly (used in tests with TestModel)
    agent_config_override: dict[str, Any] | None = None


@dataclass
class AgentActivityOutput:
    step_id: str
    input_artifact_key: str
    output_artifact_key: str
    output: dict[str, Any]
    token_count: int = 0
    cost_usd: float = 0.0


@dataclass
class GateActivityInput:
    run_id: str
    step: dict[str, Any]
    resolved_input: Any


@dataclass
class GateActivityOutput:
    step_id: str
    approved: bool
    rejected: bool
    notes: str
    gate_id: str = ""  # Postgres gate UUID (informational; workflow uses step_id for correlation)


@dataclass
class WriteOutputActivityInput:
    run_id: str
    output_spec: dict[str, Any]
    resolved_artifact_key: str
    retention_days: int | None


# ---------------------------------------------------------------------------
# Postgres write helpers
# ---------------------------------------------------------------------------

async def _pg_connect_with_retry(db_url: str, retries: int = 5, delay: float = 2.0):
    """Connect to Postgres with retries — port-forward can drop and restart."""
    import asyncio, asyncpg  # type: ignore[import]
    for attempt in range(retries):
        try:
            return await asyncpg.connect(db_url, timeout=10)
        except asyncio.CancelledError:
            raise  # propagate task cancellation immediately — don't retry
        except Exception:
            if attempt == retries - 1:
                raise
            await asyncio.sleep(delay)
    raise RuntimeError("unreachable")


async def _update_run_status(run_id: str, status: str, error: str | None = None) -> None:
    """Update run status in Postgres. Best-effort: never raises."""
    try:
        db_url = os.environ.get("DATABASE_URL", "")
        if not db_url:
            return
        conn = await _pg_connect_with_retry(db_url)
        try:
            await conn.execute(
                "UPDATE runs SET status = $1, completed_at = now(), error = $3 WHERE id = $2",
                status, run_id, error,
            )
        finally:
            await conn.close()
    except BaseException:
        pass


async def _resolve_agent_config_key(agent_id: str, version: str) -> str | None:
    """Look up the S3 config_key for an agent by name or UUID + version. Best-effort."""
    try:
        import asyncpg  # type: ignore[import]
        db_url = os.environ.get("DATABASE_URL", "")
        if not db_url:
            return None
        conn = await asyncpg.connect(db_url)
        try:
            row = await conn.fetchrow(
                """
                SELECT av.config_key
                FROM agent_versions av
                JOIN agents a ON a.id = av.agent_id
                WHERE (a.name = $1 OR a.id::text = $1)
                  AND av.version = $2
                LIMIT 1
                """,
                agent_id, version,
            )
            return row["config_key"] if row else None
        finally:
            await conn.close()
    except BaseException:
        return None


async def _write_agent_step_record(
    run_id: str,
    step_id: str,
    agent_id: str,
    agent_version: str,
    input_key: str,
    output_key: str,
    token_count: int,
    cost_usd: float,
    duration_ms: float,
    status: str = "succeeded",
    error: str | None = None,
) -> None:
    """Persist agent step record to run_steps. Best-effort: never raises."""
    try:
        import asyncpg  # type: ignore[import]
        db_url = os.environ.get("DATABASE_URL", "")
        if not db_url:
            return
        conn = await asyncpg.connect(db_url)
        try:
            record_id = str(uuid.uuid4())
            await conn.execute(
                """
                INSERT INTO run_steps
                  (id, run_id, step_id, agent_id, agent_version, step_type,
                   status, completed_at, input_artifact_key, output_artifact_key,
                   token_count, cost_usd, duration_ms, error)
                VALUES ($1, $2, $3, $4, $5, 'agent', $6, now(),
                        $7, $8, $9, $10, $11, $12)
                ON CONFLICT (id) DO NOTHING
                """,
                record_id, run_id, step_id, agent_id, agent_version,
                status, input_key, output_key, token_count, cost_usd, duration_ms, error,
            )
        finally:
            await conn.close()
    except BaseException as _exc:
        activity.logger.warning("run_steps write failed", extra={"error": f"{type(_exc).__name__}: {_exc}"})


# ---------------------------------------------------------------------------
# run_agent_activity
# ---------------------------------------------------------------------------

@activity.defn
async def update_run_status_activity(run_id: str, status: str, error: str | None = None) -> None:
    """Temporal activity wrapper around _update_run_status — used for failure path."""
    await _update_run_status(run_id, status, error)


@activity.defn
async def run_agent_activity(inp: AgentActivityInput) -> AgentActivityOutput:
    _t0 = time.monotonic()
    step_id = inp.step.get("id", "")
    agent_id = inp.step.get("agentId", "unknown")
    agent_version = inp.step.get("agentVersion", "0")
    input_key = ""

    await publish_event(RunEvent(
        run_id=inp.run_id, event_type=EventType.STEP_STARTED,
        step_id=step_id, data={"agent_id": agent_id},
    ))

    try:
        s3 = _s3_client()

        # 1. Load agent config
        if inp.agent_config_override is not None:
            from tanzen_worker.agent_config import load_agent_config_from_dict
            cfg = load_agent_config_from_dict(inp.agent_config_override)
        else:
            # Resolve agent name → config_key via DB (DSL uses names, S3 uses UUIDs)
            config_key = await _resolve_agent_config_key(agent_id, agent_version)
            if config_key:
                import json as _json
                obj = s3.get_object(Bucket=AGENTS_BUCKET, Key=config_key)
                from tanzen_worker.agent_config import load_agent_config_from_dict
                cfg = load_agent_config_from_dict(_json.loads(obj["Body"].read()))
            else:
                cfg = load_agent_config_from_s3(s3, AGENTS_BUCKET, agent_id, agent_version)

        # 2. Write input artifact
        input_key = _put_artifact(s3, inp.run_id, step_id, "input", {
            "agent_id": agent_id,
            "agent_version": agent_version,
            "input": inp.resolved_input,
            "params": inp.resolved_params,
        })

        # 3. Build PydanticAI agent
        from pydantic_ai import Agent
        from pydantic_ai.settings import ModelSettings

        toolsets = []
        if cfg.mcp_servers:
            try:
                from pydantic_ai.mcp import MCPServerStreamableHTTP as _MCPServerCls
            except ImportError:
                from pydantic_ai.mcp import MCPServerHTTP as _MCPServerCls  # type: ignore[no-redef]
            for mcp_cfg in cfg.mcp_servers:
                toolsets.append(_MCPServerCls(url=mcp_cfg.url))

        # Inject code execution tools when the agent config opts in and the
        # feature flag is enabled (checked once at worker startup via env var).
        if cfg.code_execution and os.environ.get("AGENT_CODE_EXECUTION_ENABLED", "false") == "true":
            from tanzen_worker.code_tools import build_code_tools
            toolsets.extend(build_code_tools(inp.run_id, step_id))

        for name, value in cfg.resolve_secrets().items():
            os.environ.setdefault(name, value)

        agent: Agent[None, str] = Agent(
            cfg.model,
            system_prompt=cfg.system_prompt,
            toolsets=toolsets,
            retries=cfg.retries,
        )

        settings = ModelSettings(
            max_tokens=cfg.max_tokens,
            temperature=cfg.temperature,
        )

        # 4. Format user prompt
        if isinstance(inp.resolved_input, str):
            user_prompt = inp.resolved_input
        else:
            user_prompt = json.dumps(inp.resolved_input, default=str)
        if inp.resolved_params:
            user_prompt += "\n\nParams: " + json.dumps(inp.resolved_params, default=str)

        # 5. Stream the agent — publish text deltas as step_message events.
        # One Redis connection is opened for the whole streaming session to avoid
        # per-event connection overhead (token rate can exceed 50 events/s).
        output_text = ""
        token_count = 0
        tracer = get_tracer()
        with tracer.start_as_current_span("agent.run_stream") as span:
            span.set_attribute("tanzen.run_id", inp.run_id)
            span.set_attribute("tanzen.step_id", step_id)
            span.set_attribute("tanzen.agent_id", agent_id)

            import redis.asyncio as _aioredis
            stream_redis = None
            stream_channel = f"run:{inp.run_id}"
            try:
                stream_redis = _aioredis.from_url(
                    os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
                    decode_responses=True,
                )
            except Exception:
                pass

            try:
                async with agent.run_stream(user_prompt, model_settings=settings) as stream:
                    async for delta in stream.stream_text(delta=True):
                        if delta:
                            activity.heartbeat()
                            if stream_redis:
                                try:
                                    event = RunEvent(
                                        run_id=inp.run_id,
                                        event_type=EventType.STEP_MESSAGE,
                                        step_id=step_id,
                                        data={"delta": delta},
                                    )
                                    await stream_redis.publish(stream_channel, event.to_json())
                                except Exception:
                                    pass
                    output_text = await stream.get_output()
                    try:
                        usage = stream.usage()
                        token_count = usage.total_tokens or 0
                        span.set_attribute("tanzen.token_count", token_count)
                    except Exception:
                        pass
            finally:
                if stream_redis:
                    try:
                        await stream_redis.aclose()
                    except Exception:
                        pass

    except Exception as exc:
        _duration_ms = (time.monotonic() - _t0) * 1000.0
        error_str = str(exc)
        activity.logger.error("run_agent_activity failed", extra={"error": error_str, "step_id": step_id})
        await publish_event(RunEvent(
            run_id=inp.run_id, event_type=EventType.STEP_FAILED,
            step_id=step_id, data={"error": error_str},
        ))
        await _write_agent_step_record(
            inp.run_id, step_id, agent_id, agent_version,
            input_key, "", 0, 0.0, _duration_ms,
            status="failed", error=error_str,
        )
        raise

    # 6. Write output artifact
    output_key = _put_artifact(s3, inp.run_id, step_id, "output", {
        "agent_id": agent_id,
        "agent_version": agent_version,
        "output": output_text,
        "token_count": token_count,
    })

    await publish_event(RunEvent(
        run_id=inp.run_id, event_type=EventType.STEP_COMPLETED,
        step_id=step_id,
        data={"output_artifact_key": output_key, "token_count": token_count},
    ))

    activity.logger.info("run_agent_activity complete",
                         extra={"step_id": step_id, "tokens": token_count})

    # OTel — wrapped in try/except so metrics never break the activity
    try:
        _duration_ms = (time.monotonic() - _t0) * 1000.0
        record_activity_complete("run_agent_activity", "success", _duration_ms)
        record_llm_usage(
            model=cfg.model,
            agent_id=agent_id,
            tokens=token_count,
            cost_usd=0.0,  # cost_usd calculated externally if needed
        )
    except Exception:
        pass

    await _write_agent_step_record(
        inp.run_id, step_id, agent_id, agent_version,
        input_key, output_key, token_count, 0.0,
        (time.monotonic() - _t0) * 1000.0,
    )

    return AgentActivityOutput(
        step_id=step_id,
        input_artifact_key=input_key,
        output_artifact_key=output_key,
        output={"output": output_text, "artifact_key": output_key},
        token_count=token_count,
    )


# ---------------------------------------------------------------------------
# open_gate_activity  (M7 — real implementation)
# ---------------------------------------------------------------------------

async def _write_gate_to_postgres(gate_id: str, run_id: str, step_id: str, assignee: str) -> None:
    """Write gate record to Postgres.  Best-effort: never raises."""
    try:
        import asyncpg  # type: ignore[import]
        db_url = os.environ.get("DATABASE_URL", "")
        if not db_url:
            return
        conn = await asyncpg.connect(db_url)
        try:
            await conn.execute(
                """
                INSERT INTO gates (id, run_id, step_id, assignee, status, opened_at)
                VALUES ($1, $2, $3, $4, 'pending', now())
                ON CONFLICT (id) DO NOTHING
                """,
                gate_id, run_id, step_id, assignee,
            )
        finally:
            await conn.close()
    except BaseException:
        pass  # best-effort; gate resolution via Temporal signal regardless


@activity.defn
async def open_gate_activity(inp: GateActivityInput) -> GateActivityOutput:
    """
    Opens a human-review gate.

    Writes the gate record to Postgres (best-effort), publishes a GATE_OPENED
    event to Redis, and returns immediately.  The *workflow* waits for the
    ``gate_resolution`` signal — this activity does NOT block on reviewer input.
    """
    _t0 = time.monotonic()
    step_id = inp.step.get("id", "")
    assignee = inp.step.get("assignee", "")
    gate_id = str(uuid.uuid4())

    # Write to Postgres (best-effort — silently skipped if DB not configured)
    await _write_gate_to_postgres(gate_id, inp.run_id, step_id, str(assignee))

    await publish_event(RunEvent(
        run_id=inp.run_id, event_type=EventType.GATE_OPENED,
        step_id=step_id,
        data={
            "gate_id": gate_id,
            "assignee": assignee,
            "input": str(inp.resolved_input)[:500],
        },
    ))

    activity.logger.info(
        "open_gate_activity: gate opened, awaiting signal",
        extra={"step_id": step_id, "gate_id": gate_id},
    )

    # OTel — best-effort
    try:
        record_activity_complete(
            "open_gate_activity", "success", (time.monotonic() - _t0) * 1000.0
        )
    except Exception:
        pass

    # Return the gate_id so callers can reference it; approved/rejected/notes
    # are filled in by the workflow after the signal arrives.
    return GateActivityOutput(
        step_id=step_id,
        approved=False,
        rejected=False,
        notes="",
        gate_id=gate_id,
    )


# ---------------------------------------------------------------------------
# write_output_activity
# ---------------------------------------------------------------------------

@activity.defn
async def write_output_activity(inp: WriteOutputActivityInput) -> str:
    _t0 = time.monotonic()
    s3 = _s3_client()
    payload = {
        "run_id": inp.run_id,
        "artifact_key": inp.resolved_artifact_key,
        "retention_days": inp.retention_days,
    }
    key = _put_artifact(s3, inp.run_id, "output", "final", payload)

    await publish_event(RunEvent(
        run_id=inp.run_id, event_type=EventType.RUN_COMPLETED,
        step_id=None,
        data={"output_key": key},
    ))
    await _update_run_status(inp.run_id, "succeeded")

    activity.logger.info("write_output_activity complete", extra={"key": key})

    # OTel — best-effort
    try:
        record_activity_complete(
            "write_output_activity", "success", (time.monotonic() - _t0) * 1000.0
        )
    except Exception:
        pass

    return key
