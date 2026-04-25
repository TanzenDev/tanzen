"""
PydanticAI tools for agent code execution.

Provides execute_python() and execute_typescript() tools that agents can call
to write and run code. Each invocation gets its own ephemeral directory
(/tmp/tanzen-exec/{uuid}/) with mode 0700, deleted in a finally block.

Security:
  - Python: runs via pyodide_runner (Pyodide WASM sandbox in a Deno V8 isolate)
  - TypeScript: runs via deno run with --no-remote and deny-by-default flags
  - No exec_command() — tools manage their own filesystem setup internally
  - Ephemeral dir is unique per call and cleaned up unconditionally
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
import uuid
from dataclasses import dataclass
from typing import Any

from pydantic_ai import RunContext

from tanzen_worker.script_runner import (
    ScriptActivityInput,
    _PYODIDE_RUNNER_IS_BINARY,
    _PYODIDE_RUNNER_PATH,
    _deno_base_flags,
    _run_subprocess,
    _parse_stdout,
    _MAX_STDOUT_BYTES,
)

_EXEC_BASE = "/tmp/tanzen-exec"


@dataclass
class CodeOutput:
    stdout: str
    exit_code: int
    duration_ms: float


def _make_ephemeral_dir() -> str:
    path = os.path.join(_EXEC_BASE, str(uuid.uuid4()))
    os.makedirs(path, mode=0o700, exist_ok=False)
    return path


def _cleanup(path: str) -> None:
    try:
        shutil.rmtree(path, ignore_errors=True)
    except Exception:
        pass


def build_code_tools(run_id: str, step_id: str) -> list:
    """Return PydanticAI tool functions for code execution.

    These are plain async functions; PydanticAI detects them as tools via
    the @agent.tool decorator pattern when passed to Agent(tools=[...]).
    Returned as a list so activities.py can extend the toolsets list.
    """

    async def execute_python(ctx: RunContext[Any], code: str, timeout: int = 30) -> CodeOutput:
        """Execute Python code in a Pyodide WASM sandbox. Returns stdout and exit code."""
        work_dir = _make_ephemeral_dir()
        t0 = time.monotonic()
        try:
            stdin_payload = json.dumps({
                "code": code,
                "input": None,
                "params": {},
                "capture_state": False,
            }).encode()

            if _PYODIDE_RUNNER_IS_BINARY:
                cmd = [_PYODIDE_RUNNER_PATH]
            else:
                # Dev: construct a minimal ScriptActivityInput for flag building
                fake_inp = _FakeInput(run_id, step_id, timeout)
                flags = _deno_base_flags(fake_inp)
                cmd = ["deno", "run"] + flags + [_PYODIDE_RUNNER_PATH]

            fake_inp_obj = _FakeInput(run_id, step_id, timeout)
            stdout_bytes, _ = await _run_subprocess(cmd, stdin_payload, fake_inp_obj)
            stdout_text = stdout_bytes[:_MAX_STDOUT_BYTES].decode("utf-8", errors="replace")
            return CodeOutput(
                stdout=stdout_text,
                exit_code=0,
                duration_ms=(time.monotonic() - t0) * 1000,
            )
        except RuntimeError as e:
            return CodeOutput(
                stdout=str(e),
                exit_code=1,
                duration_ms=(time.monotonic() - t0) * 1000,
            )
        finally:
            _cleanup(work_dir)

    async def execute_typescript(ctx: RunContext[Any], code: str, timeout: int = 30) -> CodeOutput:
        """Execute TypeScript code in a Deno V8 isolate. Returns stdout and exit code."""
        work_dir = _make_ephemeral_dir()
        script_path = os.path.join(work_dir, "script.ts")
        t0 = time.monotonic()
        try:
            with open(script_path, "w") as f:
                f.write(code)

            fake_inp = _FakeInput(run_id, step_id, timeout)
            flags = _deno_base_flags(fake_inp)
            # Grant read/write access only to the ephemeral working dir.
            flags = [
                f if not f.startswith("--deny-read") else f"--allow-read={work_dir}"
                for f in flags
            ]
            flags = [
                f if not f.startswith("--deny-write") else f"--allow-write={work_dir}"
                for f in flags
            ]
            cmd = ["deno", "run"] + flags + [script_path]

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    proc.communicate(), timeout=timeout
                )
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                return CodeOutput(stdout=f"Timed out after {timeout}s", exit_code=1,
                                  duration_ms=(time.monotonic() - t0) * 1000)

            out = (stdout_bytes[:_MAX_STDOUT_BYTES]).decode("utf-8", errors="replace")
            if proc.returncode != 0:
                err = stderr_bytes.decode("utf-8", errors="replace").strip()
                return CodeOutput(stdout=err, exit_code=proc.returncode or 1,
                                  duration_ms=(time.monotonic() - t0) * 1000)
            return CodeOutput(stdout=out, exit_code=0,
                              duration_ms=(time.monotonic() - t0) * 1000)
        finally:
            _cleanup(work_dir)

    return [execute_python, execute_typescript]


@dataclass
class _FakeInput:
    """Minimal duck-typed stand-in for ScriptActivityInput used only for flag building."""
    run_id: str
    step_id: str
    timeout_seconds: int
    allowed_hosts: str = ""
    allowed_env: str = ""
    script_name: str = "agent-code"
