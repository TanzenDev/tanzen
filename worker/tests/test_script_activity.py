"""
Unit and integration tests for run_script_activity.

Unit tests mock S3 and asyncio subprocess — no Deno or k8s needed.
The integration test (test_deno_*) is skipped if `deno` is not in PATH.
"""
from __future__ import annotations

import asyncio
import json
import shutil
from io import BytesIO
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tanzen_worker.script_runner import ScriptActivityInput, run_script_activity

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_DENO_AVAILABLE = shutil.which("deno") is not None


def _make_input(
    *,
    source: str = 'const r=await new Response(Deno.stdin.readable).text();console.log(JSON.stringify({result:"ok"}));',
    allowed_hosts: str = "",
    allowed_env: str = "",
    timeout_seconds: int = 10,
) -> ScriptActivityInput:
    return ScriptActivityInput(
        run_id="run-test",
        step_id="step-test",
        script_name="test-script",
        script_version="1.0",
        s3_key="test-script/1.0.ts",
        resolved_input={"data": "hello"},
        resolved_params={},
        allowed_hosts=allowed_hosts,
        allowed_env=allowed_env,
        timeout_seconds=timeout_seconds,
    )


def _mock_s3(source: str):
    """Return a mock S3 client whose get_object yields the given source code."""
    mock_s3 = MagicMock()
    mock_s3.get_object.return_value = {"Body": BytesIO(source.encode())}
    return mock_s3


def _make_proc(stdout: bytes = b'{"result":"ok"}', returncode: int = 0):
    """Build a fake asyncio subprocess whose communicate() returns fixed output."""
    proc = AsyncMock()
    proc.returncode = returncode
    proc.communicate = AsyncMock(return_value=(stdout, b""))
    proc.kill = MagicMock()
    proc.wait = AsyncMock()
    return proc


# ---------------------------------------------------------------------------
# Unit tests — S3 and Deno subprocess are both mocked
# ---------------------------------------------------------------------------

class TestRunScriptActivity:

    @pytest.mark.asyncio
    async def test_successful_run_returns_output(self):
        """Happy-path: script writes JSON to stdout, activity returns it."""
        source = 'console.log(JSON.stringify({result:"transformed"}));'
        proc = _make_proc(stdout=json.dumps({"result": "transformed"}).encode())

        with patch("tanzen_worker.script_runner._s3_client", return_value=_mock_s3(source)), \
             patch("asyncio.create_subprocess_exec", return_value=proc):
            result = await run_script_activity(_make_input(source=source))

        assert result.output == {"result": "transformed"}
        assert result.step_id == "step-test"
        assert result.duration_ms >= 0

    @pytest.mark.asyncio
    async def test_nonzero_exit_raises_runtime_error(self):
        """Script that exits non-zero → RuntimeError with exit code and stderr."""
        source = "throw new Error('boom');"
        proc = _make_proc(stdout=b"", returncode=1)
        proc.communicate = AsyncMock(return_value=(b"", b"Error: boom"))

        with patch("tanzen_worker.script_runner._s3_client", return_value=_mock_s3(source)), \
             patch("asyncio.create_subprocess_exec", return_value=proc):
            with pytest.raises(RuntimeError, match="exited with code 1"):
                await run_script_activity(_make_input(source=source))

    @pytest.mark.asyncio
    async def test_invalid_json_stdout_raises_runtime_error(self):
        """Script that writes non-JSON to stdout → RuntimeError."""
        source = "console.log('not json');"
        proc = _make_proc(stdout=b"not json")

        with patch("tanzen_worker.script_runner._s3_client", return_value=_mock_s3(source)), \
             patch("asyncio.create_subprocess_exec", return_value=proc):
            with pytest.raises(RuntimeError, match="not valid JSON"):
                await run_script_activity(_make_input(source=source))

    @pytest.mark.asyncio
    async def test_timeout_kills_process_and_raises(self):
        """Script that hangs past timeout → process is killed, RuntimeError raised."""
        source = "await new Promise(() => {});"  # hangs forever

        proc = AsyncMock()
        proc.returncode = None
        proc.kill = MagicMock()
        proc.wait = AsyncMock()

        async def _slow_communicate(input=None):
            await asyncio.sleep(9999)
            return (b"", b"")

        proc.communicate = _slow_communicate

        with patch("tanzen_worker.script_runner._s3_client", return_value=_mock_s3(source)), \
             patch("asyncio.create_subprocess_exec", return_value=proc), \
             patch("asyncio.wait_for", side_effect=asyncio.TimeoutError):
            with pytest.raises(RuntimeError, match="timed out"):
                await run_script_activity(_make_input(source=source, timeout_seconds=1))

        proc.kill.assert_called_once()

    @pytest.mark.asyncio
    async def test_empty_stdout_returns_none_output(self):
        """Script that produces no output → output is None (not an error)."""
        source = "// no output"
        proc = _make_proc(stdout=b"")

        with patch("tanzen_worker.script_runner._s3_client", return_value=_mock_s3(source)), \
             patch("asyncio.create_subprocess_exec", return_value=proc):
            result = await run_script_activity(_make_input(source=source))

        assert result.output is None

    @pytest.mark.asyncio
    async def test_allowed_hosts_flag_included(self):
        """When allowed_hosts is set, Deno receives --allow-net=<hosts>."""
        source = "console.log('{}');"
        proc = _make_proc(stdout=b"{}")
        captured_cmd: list[str] = []

        async def _capture(*args, **kwargs):
            captured_cmd.extend(args)
            return proc

        with patch("tanzen_worker.script_runner._s3_client", return_value=_mock_s3(source)), \
             patch("asyncio.create_subprocess_exec", side_effect=_capture):
            await run_script_activity(_make_input(source=source, allowed_hosts="api.example.com"))

        cmd = " ".join(captured_cmd)
        assert "--allow-net=api.example.com" in cmd
        assert "--deny-net" not in cmd

    @pytest.mark.asyncio
    async def test_no_allowed_hosts_uses_deny_net(self):
        """When allowed_hosts is empty, Deno receives --deny-net."""
        source = "console.log('{}');"
        proc = _make_proc(stdout=b"{}")
        captured_cmd: list[str] = []

        async def _capture(*args, **kwargs):
            captured_cmd.extend(args)
            return proc

        with patch("tanzen_worker.script_runner._s3_client", return_value=_mock_s3(source)), \
             patch("asyncio.create_subprocess_exec", side_effect=_capture):
            await run_script_activity(_make_input(source=source, allowed_hosts=""))

        cmd = " ".join(captured_cmd)
        assert "--deny-net" in cmd
        assert "--allow-net" not in cmd

    @pytest.mark.asyncio
    async def test_deny_run_always_present(self):
        """--deny-run is always passed regardless of other permissions."""
        source = "console.log('{}');"
        proc = _make_proc(stdout=b"{}")
        captured_cmd: list[str] = []

        async def _capture(*args, **kwargs):
            captured_cmd.extend(args)
            return proc

        with patch("tanzen_worker.script_runner._s3_client", return_value=_mock_s3(source)), \
             patch("asyncio.create_subprocess_exec", side_effect=_capture):
            await run_script_activity(_make_input(source=source))

        cmd = " ".join(captured_cmd)
        assert "--deny-run" in cmd
        assert "--deny-ffi" in cmd
        assert "--deny-write" in cmd
        assert "--deny-read" in cmd


# ---------------------------------------------------------------------------
# Integration test — requires Deno in PATH
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not _DENO_AVAILABLE, reason="deno not in PATH")
class TestRunScriptActivityIntegration:

    @pytest.mark.asyncio
    async def test_deno_uppercase(self, s3):
        """Actual Deno subprocess transforms input string to upper-case."""
        source = (
            'const raw = await new Response(Deno.stdin.readable).text();\n'
            'const { input } = JSON.parse(raw);\n'
            'console.log(JSON.stringify({ result: input.toUpperCase() }));\n'
        )
        bucket = "scripts"
        key = "test-uppercase/1.0.ts"

        try:
            s3.create_bucket(Bucket=bucket)
        except Exception:
            pass  # bucket may already exist
        s3.put_object(Bucket=bucket, Key=key, Body=source.encode())

        inp = ScriptActivityInput(
            run_id="run-deno-test",
            step_id="step-deno",
            script_name="test-uppercase",
            script_version="1.0",
            s3_key=key,
            resolved_input="hello world",
            resolved_params={},
            allowed_hosts="",
            allowed_env="",
            timeout_seconds=15,
        )
        result = await run_script_activity(inp)
        assert result.output == {"result": "HELLO WORLD"}
        assert result.step_id == "step-deno"
