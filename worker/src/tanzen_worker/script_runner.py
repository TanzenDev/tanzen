"""
Custom script activity — executes user-provided TypeScript or Python scripts.

TypeScript: runs via `deno run` with explicit deny-by-default permission flags.
Python: runs via the pyodide_runner binary (Pyodide WASM sandbox inside Deno).

Both paths share the same stdin/stdout JSON envelope contract and the same
security hardening: --no-remote, memory cap, stdout size cap, env blocklist.
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

from tanzen_worker.checkpoints import write_checkpoint

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
    language: str = "typescript"       # "typescript" | "python"
    capture_state: bool = False        # M2: write state checkpoint to S3


@dataclass
class ScriptActivityOutput:
    step_id: str
    output: Any
    duration_ms: float
    state_b64: str | None = None       # M2: pickle-serialized Python namespace


# ---------------------------------------------------------------------------
# S3 helper (same pattern as activities.py)
# ---------------------------------------------------------------------------

_S3_ENDPOINT    = os.environ.get("S3_ENDPOINT_URL", "http://localhost:8333")
_S3_ACCESS_KEY  = os.environ.get("S3_ACCESS_KEY", "tanzen")
_S3_SECRET_KEY  = os.environ.get("S3_SECRET_KEY", "tanzen")
_SCRIPTS_BUCKET = os.environ.get("S3_SCRIPTS_BUCKET", "scripts")

# Path to the compiled pyodide_runner binary (or .ts script for dev).
# Set PYODIDE_RUNNER_PATH to a pre-compiled binary for production.
# Default: run pyodide_runner.ts via `deno run` (development mode).
_PYODIDE_RUNNER_PATH = os.environ.get(
    "PYODIDE_RUNNER_PATH",
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "infra", "executor", "pyodide_runner.ts"),
)
_PYODIDE_RUNNER_IS_BINARY = not _PYODIDE_RUNNER_PATH.endswith(".ts")

# Env vars the worker uses for credentials — scripts are never allowed to read these.
_BLOCKED_ENV = frozenset({
    "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_ENDPOINT_URL",
    "DATABASE_URL", "DB_PASSWORD",
    "TEMPORAL_ADDRESS", "TEMPORAL_NAMESPACE",
    "REDIS_URL",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
    "CLERK_SECRET_KEY", "JWT_SECRET",
})

# Max stdout bytes to read — prevents OOM from runaway script output.
_MAX_STDOUT_BYTES = 10 * 1024 * 1024  # 10 MB


def _s3_client():
    return boto3.client(
        "s3",
        endpoint_url=_S3_ENDPOINT,
        aws_access_key_id=_S3_ACCESS_KEY,
        aws_secret_access_key=_S3_SECRET_KEY,
        config=Config(signature_version="s3v4"),
        region_name="us-east-1",
    )


def _validate_allowed_env(allowed_env: str) -> None:
    for name in (n.strip() for n in allowed_env.split(",") if n.strip()):
        if name in _BLOCKED_ENV:
            raise ValueError(f"allowed_env contains forbidden var '{name}'")


# ---------------------------------------------------------------------------
# Activity
# ---------------------------------------------------------------------------

@activity.defn
async def run_script_activity(inp: ScriptActivityInput) -> ScriptActivityOutput:
    _t0 = time.monotonic()

    _validate_allowed_env(inp.allowed_env)

    # 1. Fetch script source from S3
    s3 = _s3_client()
    obj = s3.get_object(Bucket=_SCRIPTS_BUCKET, Key=inp.s3_key)
    source_code: str = obj["Body"].read().decode("utf-8")

    if inp.language == "python":
        output, state_b64 = await _run_python(inp, source_code)
    else:
        output = await _run_typescript(inp, source_code)
        state_b64 = None

    duration_ms = (time.monotonic() - _t0) * 1000.0
    activity.logger.info(
        "run_script_activity complete",
        extra={"step_id": inp.step_id, "script": inp.script_name,
               "language": inp.language, "duration_ms": duration_ms},
    )

    # Write execution checkpoint for time-machine replay.
    try:
        write_checkpoint(
            run_id=inp.run_id,
            step_id=inp.step_id,
            script_key=inp.s3_key,
            language=inp.language,
            input_val=inp.resolved_input,
            params=inp.resolved_params,
            permissions={
                "allowed_hosts": inp.allowed_hosts,
                "allowed_env": inp.allowed_env,
                "timeout_seconds": inp.timeout_seconds,
            },
            output=output,
            duration_ms=duration_ms,
            state_b64=state_b64,
        )
    except Exception as e:
        activity.logger.warning("checkpoint write failed", extra={"error": str(e)})

    return ScriptActivityOutput(
        step_id=inp.step_id,
        output=output,
        duration_ms=duration_ms,
        state_b64=state_b64,
    )


async def _run_typescript(inp: ScriptActivityInput, source_code: str) -> Any:
    suffix = ".ts"
    with tempfile.NamedTemporaryFile(mode="w", suffix=suffix, delete=False, dir="/tmp") as tmp:
        tmp.write(source_code)
        script_path = tmp.name

    try:
        flags = _deno_base_flags(inp)
        cmd = ["deno", "run"] + flags + [script_path]
        stdin_payload = json.dumps({
            "input": inp.resolved_input,
            "params": inp.resolved_params,
        }).encode()
        stdout_bytes, _ = await _run_subprocess(cmd, stdin_payload, inp)
        return _parse_stdout(stdout_bytes, inp.script_name)
    finally:
        _unlink(script_path)


async def _run_python(inp: ScriptActivityInput, source_code: str) -> tuple[Any, str | None]:
    stdin_payload = json.dumps({
        "code": source_code,
        "input": inp.resolved_input,
        "params": inp.resolved_params,
        "capture_state": inp.capture_state,
    }).encode()

    if _PYODIDE_RUNNER_IS_BINARY:
        cmd = [_PYODIDE_RUNNER_PATH]
    else:
        flags = _deno_base_flags(inp)
        cmd = ["deno", "run"] + flags + [_PYODIDE_RUNNER_PATH]

    stdout_bytes, _ = await _run_subprocess(cmd, stdin_payload, inp)
    result = _parse_stdout(stdout_bytes, inp.script_name)

    # Python runner returns { output, state_b64? }
    if isinstance(result, dict) and "output" in result:
        return result["output"], result.get("state_b64")
    return result, None


def _deno_base_flags(inp: ScriptActivityInput) -> list[str]:
    flags = [
        "--no-prompt",
        "--no-remote",
        "--v8-flags=--max-heap-size=256",
    ]
    if inp.allowed_hosts:
        flags.append(f"--allow-net={inp.allowed_hosts}")
    else:
        flags.append("--deny-net")
    if inp.allowed_env:
        flags.append(f"--allow-env={inp.allowed_env}")
    else:
        flags.append("--deny-env")
    flags += ["--deny-read", "--deny-write", "--deny-run", "--deny-ffi"]
    return flags


async def _run_subprocess(
    cmd: list[str],
    stdin_payload: bytes,
    inp: ScriptActivityInput,
) -> tuple[bytes, bytes]:
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
        raise RuntimeError(f"Script '{inp.script_name}' timed out after {inp.timeout_seconds}s")

    stdout_bytes = stdout_bytes[:_MAX_STDOUT_BYTES]

    if proc.returncode != 0:
        stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip()
        raise RuntimeError(
            f"Script '{inp.script_name}' exited with code {proc.returncode}: {stderr_text}"
        )
    return stdout_bytes, stderr_bytes


def _parse_stdout(stdout_bytes: bytes, script_name: str) -> Any:
    stdout_text = stdout_bytes.decode("utf-8", errors="replace").strip()
    try:
        return json.loads(stdout_text) if stdout_text else None
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"Script '{script_name}' stdout is not valid JSON: {e}\nOutput: {stdout_text[:500]}"
        ) from e


def _unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass
