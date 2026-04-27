"""
Execution checkpoints — write and read step execution state to S3.

Each checkpoint stores the full execution context: inputs, outputs, permissions,
timing, and (for Python) a pickle-serialized namespace. The time-machine
debugger can replay any step by fetching its checkpoint and re-running with
the original inputs.

S3 layout:
  snapshots/{run_id}/{step_id}/checkpoint.json   — always written
  snapshots/{run_id}/{step_id}/state.pkl          — Python executions only
"""
from __future__ import annotations

import base64
import json
import os
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.config import Config

_S3_ENDPOINT   = os.environ.get("S3_ENDPOINT_URL", "http://localhost:8333")
_S3_ACCESS_KEY = os.environ.get("S3_ACCESS_KEY", "tanzen")
_S3_SECRET_KEY = os.environ.get("S3_SECRET_KEY", "tanzen")
_ARTIFACTS_BUCKET = os.environ.get("S3_ARTIFACTS_BUCKET", "artifacts")

_WORKER_VERSION = os.environ.get("TANZEN_WORKER_VERSION", "dev")


def _s3():
    return boto3.client(
        "s3",
        endpoint_url=_S3_ENDPOINT,
        aws_access_key_id=_S3_ACCESS_KEY,
        aws_secret_access_key=_S3_SECRET_KEY,
        config=Config(signature_version="s3v4"),
        region_name="us-east-1",
    )


@dataclass
class Checkpoint:
    run_id: str
    step_id: str
    script_key: str
    language: str
    input: Any
    params: dict[str, Any]
    permissions: dict[str, Any]   # allowed_hosts, allowed_env, timeout_seconds
    output: Any
    duration_ms: float
    worker_version: str
    timestamp: str                # ISO 8601
    has_state: bool = False


async def write_checkpoint(
    run_id: str,
    step_id: str,
    script_key: str,
    language: str,
    input_val: Any,
    params: dict[str, Any],
    permissions: dict[str, Any],
    output: Any,
    duration_ms: float,
    state_b64: str | None = None,
) -> str:
    """Write checkpoint to S3. Returns the checkpoint S3 key."""
    s3 = _s3()
    cp = Checkpoint(
        run_id=run_id,
        step_id=step_id,
        script_key=script_key,
        language=language,
        input=input_val,
        params=params,
        permissions=permissions,
        output=output,
        duration_ms=duration_ms,
        worker_version=_WORKER_VERSION,
        timestamp=datetime.now(timezone.utc).isoformat(),
        has_state=state_b64 is not None,
    )

    key = f"snapshots/{run_id}/{step_id}/checkpoint.json"
    body = json.dumps(asdict(cp), default=str).encode()
    s3.put_object(Bucket=_ARTIFACTS_BUCKET, Key=key, Body=body, ContentType="application/json")

    if state_b64:
        state_key = f"snapshots/{run_id}/{step_id}/state.pkl"
        state_bytes = base64.b64decode(state_b64)
        s3.put_object(Bucket=_ARTIFACTS_BUCKET, Key=state_key, Body=state_bytes,
                      ContentType="application/octet-stream")

    # Record the snapshot in Postgres so the API can list it.
    try:
        import asyncio, asyncpg  # type: ignore[import]
        db_url = os.environ.get("DATABASE_URL", "")
        if db_url:
            conn = None
            for _attempt in range(5):
                try:
                    conn = await asyncpg.connect(db_url, timeout=10)
                    break
                except asyncio.CancelledError:
                    raise
                except Exception:
                    if _attempt == 4:
                        raise
                    await asyncio.sleep(2.0)
            assert conn is not None
            try:
                await conn.execute(
                    """
                    INSERT INTO step_snapshots (id, run_id, step_id, checkpoint_key, has_state)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (run_id, step_id) DO UPDATE
                      SET checkpoint_key = excluded.checkpoint_key,
                          has_state = excluded.has_state
                    """,
                    str(uuid.uuid4()), run_id, step_id, key, state_b64 is not None,
                )
            finally:
                await conn.close()
    except BaseException:
        pass  # checkpoint in S3 is the source of truth; DB row is best-effort

    return key


def read_checkpoint(run_id: str, step_id: str) -> Checkpoint:
    """Read a checkpoint from S3."""
    s3 = _s3()
    key = f"snapshots/{run_id}/{step_id}/checkpoint.json"
    obj = s3.get_object(Bucket=_ARTIFACTS_BUCKET, Key=key)
    data = json.loads(obj["Body"].read())
    return Checkpoint(**data)


def read_state_b64(run_id: str, step_id: str) -> str | None:
    """Read the pickle state blob (base64-encoded) for a Python checkpoint."""
    s3 = _s3()
    key = f"snapshots/{run_id}/{step_id}/state.pkl"
    try:
        obj = s3.get_object(Bucket=_ARTIFACTS_BUCKET, Key=key)
        return base64.b64encode(obj["Body"].read()).decode()
    except s3.exceptions.NoSuchKey:
        return None
    except Exception:
        return None
