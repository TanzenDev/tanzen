"""
Tanzen run event publishing — Redis pub/sub.

Workers publish structured events to a channel keyed by run_id.
The API server subscribes and fans out to browser SSE connections.

Channel naming:
  run:{run_id}        — per-run step events
  gates:{user_id}     — pending gate count for a user (published on gate open/close)
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, dataclass
from enum import StrEnum
from typing import Any

import redis.asyncio as aioredis


class EventType(StrEnum):
    STEP_STARTED   = "step_started"
    STEP_COMPLETED = "step_completed"
    STEP_FAILED    = "step_failed"
    STEP_MESSAGE   = "step_message"   # streaming LLM text delta — Redis-only, not persisted
    GATE_OPENED    = "gate_opened"
    GATE_RESOLVED  = "gate_resolved"
    RUN_COMPLETED  = "run_completed"
    RUN_FAILED     = "run_failed"


@dataclass
class RunEvent:
    run_id: str
    event_type: str           # EventType value
    step_id: str | None
    data: dict[str, Any]
    ts: float = 0.0

    def __post_init__(self) -> None:
        if self.ts == 0.0:
            self.ts = time.time()

    def to_json(self) -> str:
        return json.dumps(asdict(self))


def _redis_url() -> str:
    return os.environ.get("REDIS_URL", "redis://localhost:6379/0")


def _run_channel(run_id: str) -> str:
    return f"run:{run_id}"


async def publish_event(event: RunEvent) -> None:
    """Publish a run event to the per-run Redis channel and persist to DB.

    STEP_MESSAGE events are Redis-only (high-frequency streaming deltas;
    the completed artifact holds the full text).
    """
    # Redis pub/sub — best-effort, for live SSE
    try:
        r = aioredis.from_url(_redis_url(), decode_responses=True)
        async with r:
            await r.publish(_run_channel(event.run_id), event.to_json())
    except BaseException:
        pass

    # step_message events are not persisted — too frequent, full text in artifact
    if event.event_type == EventType.STEP_MESSAGE:
        return

    # Persist to run_events for historical replay — best-effort
    try:
        import uuid as _uuid
        import asyncpg  # type: ignore[import]
        db_url = os.environ.get("DATABASE_URL", "")
        if db_url:
            conn = await asyncpg.connect(db_url)
            try:
                await conn.execute(
                    """
                    INSERT INTO run_events (id, run_id, event_type, step_id, data, ts)
                    VALUES ($1, $2, $3, $4, $5::jsonb, $6)
                    ON CONFLICT (id) DO NOTHING
                    """,
                    str(_uuid.uuid4()), event.run_id, event.event_type,
                    event.step_id, json.dumps(event.data), event.ts,
                )
            finally:
                await conn.close()
    except BaseException:
        pass


async def publish_gate_count(user_id: str, count: int) -> None:
    """Publish updated pending gate count for a user."""
    try:
        r = aioredis.from_url(_redis_url(), decode_responses=True)
        async with r:
            payload = json.dumps({"user_id": user_id, "pending_gates": count})
            await r.publish(f"gates:{user_id}", payload)
    except Exception:
        pass
