"""
Custom script activity — executes user-provided TypeScript via Deno subprocess.

The script source is fetched from S3 by its content-addressable key (embedded
in the IR at compile time).  Input is passed via stdin as a JSON envelope;
output is read from stdout as a JSON value.  Permission flags are set per-script
by the admin at registration time.
"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
from dataclasses import dataclass, field
from typing import Any

import boto3
from botocore.config import Config
from temporalio import activity

# ---------------------------------------------------------------------------
# I/O types
# ---------------------------------------------------------------------------

@dataclass
class ScriptActivityInput:
    run_id: str
    step_id: str
    script_name: str
    script_version: str
    s3_key: str                        # direct pointer, no DB lookup needed
    resolved_input: Any
    resolved_params: dict[str, Any] = field(default_factory=dict)
    allowed_hosts: str = ""            # comma-sep hostnames; '' → --deny-net
    allowed_env: str = ""              # comma-sep env var names; '' → --deny-env
    timeout_seconds: int = 30


@dataclass
class ScriptActivityOutput:
    step_id: str
    output: Any
    duration_ms: float


# ---------------------------------------------------------------------------
# S3 helper (same pattern as activities.py)
# ---------------------------------------------------------------------------

_S3_ENDPOINT    = os.environ.get("S3_ENDPOINT_URL", "http://localhost:8333")
_S3_ACCESS_KEY  = os.environ.get("S3_ACCESS_KEY", "tanzen")
_S3_SECRET_KEY  = os.environ.get("S3_SECRET_KEY", "tanzen")
_SCRIPTS_BUCKET = os.environ.get("S3_SCRIPTS_BUCKET", "scripts")


def _s3_client():
    return boto3.client(
        "s3",
        endpoint_url=_S3_ENDPOINT,
        aws_access_key_id=_S3_ACCESS_KEY,
        aws_secret_access_key=_S3_SECRET_KEY,
        config=Config(signature_version="s3v4"),
        region_name="us-east-1",
    )


# ---------------------------------------------------------------------------
# Activity
# ---------------------------------------------------------------------------

@activity.defn
async def run_script_activity(inp: ScriptActivityInput) -> ScriptActivityOutput:
    _t0 = time.monotonic()

    # 1. Fetch script source from S3
    s3 = _s3_client()
    obj = s3.get_object(Bucket=_SCRIPTS_BUCKET, Key=inp.s3_key)
    source_code: str = obj["Body"].read().decode("utf-8")

    # 2. Write source to a temp file
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".ts", delete=False, dir="/tmp"
    ) as tmp:
        tmp.write(source_code)
        script_path = tmp.name

    try:
        # 3. Build Deno permission flags
        deno_flags = ["--no-prompt"]
        if inp.allowed_hosts:
            deno_flags.append(f"--allow-net={inp.allowed_hosts}")
        else:
            deno_flags.append("--deny-net")
        if inp.allowed_env:
            deno_flags.append(f"--allow-env={inp.allowed_env}")
        else:
            deno_flags.append("--deny-env")
        deno_flags += ["--deny-read", "--deny-write", "--deny-run", "--deny-ffi"]

        cmd = ["deno", "run"] + deno_flags + [script_path]

        # 4. Pass input via stdin as JSON envelope
        stdin_payload = json.dumps({
            "input": inp.resolved_input,
            "params": inp.resolved_params,
        }).encode()

        # 5. Launch subprocess and enforce timeout
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(input=stdin_payload),
                timeout=inp.timeout_seconds,
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise RuntimeError(
                f"Script '{inp.script_name}' timed out after {inp.timeout_seconds}s"
            )

        if proc.returncode != 0:
            stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip()
            raise RuntimeError(
                f"Script '{inp.script_name}' exited with code {proc.returncode}: {stderr_text}"
            )

        # 6. Parse stdout as JSON
        stdout_text = stdout_bytes.decode("utf-8", errors="replace").strip()
        try:
            output = json.loads(stdout_text) if stdout_text else None
        except json.JSONDecodeError as e:
            raise RuntimeError(
                f"Script '{inp.script_name}' stdout is not valid JSON: {e}\nOutput: {stdout_text[:500]}"
            ) from e

    finally:
        # Clean up temp file
        try:
            os.unlink(script_path)
        except OSError:
            pass

    duration_ms = (time.monotonic() - _t0) * 1000.0
    activity.logger.info(
        "run_script_activity complete",
        extra={"step_id": inp.step_id, "script": inp.script_name, "duration_ms": duration_ms},
    )

    return ScriptActivityOutput(
        step_id=inp.step_id,
        output=output,
        duration_ms=duration_ms,
    )
