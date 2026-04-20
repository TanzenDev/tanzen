"""
Shared test configuration and fixtures.

Sets env vars and provides session-scoped infrastructure fixtures:
  - SeaweedFS port-forward + S3 client
  - Temporal dev server in a dedicated background thread+event-loop
  - A single long-lived Worker serving both test task queues

Tests are synchronous; async work is delegated to the Temporal loop via
`temporal_env.run(coro)`.
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import threading
import time
from typing import Any, Generator

import boto3
import pytest
from botocore.config import Config

# ------------------------------------------------------------------
# Env vars — set before any module that reads them at import time
# ------------------------------------------------------------------
os.environ.setdefault("S3_ENDPOINT_URL", "http://localhost:8333")
os.environ.setdefault("S3_ACCESS_KEY", "ShB02OxynxWfdctD4a1Y6WcyyrbAwDk")
os.environ.setdefault("S3_SECRET_KEY", "GiTxIBlPwbbvPqzL5fAylZJDNA6vNoO")
os.environ.setdefault("S3_ARTIFACTS_BUCKET", "artifacts")
os.environ.setdefault("S3_AGENTS_BUCKET", "agents")
os.environ.setdefault("S3_SCRIPTS_BUCKET", "scripts")

S3_ENDPOINT      = os.environ["S3_ENDPOINT_URL"]
S3_ACCESS_KEY    = os.environ["S3_ACCESS_KEY"]
S3_SECRET_KEY    = os.environ["S3_SECRET_KEY"]
ARTIFACTS_BUCKET = os.environ["S3_ARTIFACTS_BUCKET"]

# Task queues that tests submit to — must match what tests use
_TASK_QUEUES = ["tanzen-agent-test", "tanzen-workflows-test"]


# ------------------------------------------------------------------
# SeaweedFS port-forward
# ------------------------------------------------------------------

@pytest.fixture(scope="session", autouse=True)
def seaweedfs_pf() -> Generator[None, None, None]:
    proc = subprocess.Popen(
        ["kubectl", "port-forward", "svc/seaweedfs-filer", "8333:8333", "-n", "tanzen-dev"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(2)
    try:
        yield
    finally:
        proc.terminate()


# ------------------------------------------------------------------
# S3 client
# ------------------------------------------------------------------

@pytest.fixture(scope="session")
def s3(seaweedfs_pf):
    return boto3.client(
        "s3",
        endpoint_url=S3_ENDPOINT,
        aws_access_key_id=S3_ACCESS_KEY,
        aws_secret_access_key=S3_SECRET_KEY,
        config=Config(signature_version="s3v4"),
        region_name="us-east-1",
    )


# ------------------------------------------------------------------
# Session-scoped Temporal environment + Worker
# ------------------------------------------------------------------

class TemporalEnv:
    """
    Temporal dev server + single Worker running in a dedicated background
    thread with its own event loop.

    Tests are synchronous and call `env.run(coro)` to execute coroutines on
    the Temporal loop.  `env.client` is the Temporal client connected to the
    dev server.
    """

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._env: Any = None
        self._ready = threading.Event()
        self._stop_event = threading.Event()
        self._thread = threading.Thread(
            target=self._loop_main, daemon=True, name="temporal-loop"
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def start(self) -> None:
        self._thread.start()
        if not self._ready.wait(timeout=30):
            raise RuntimeError("Temporal dev server did not start within 30 s")
        if self._env is None:
            raise RuntimeError("Temporal dev server failed to start")

    def stop(self) -> None:
        self._stop_event.set()
        self._thread.join(timeout=20)

    def run(self, coro, timeout: float = 120) -> Any:
        """Submit a coroutine to the Temporal loop and block until done."""
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=timeout)

    @property
    def client(self):
        return self._env.client

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _loop_main(self) -> None:
        from temporalio.testing import WorkflowEnvironment
        from temporalio.worker import Worker, UnsandboxedWorkflowRunner
        from tanzen_worker.workflow import DynamicWorkflow
        from tanzen_worker.activities import (
            run_agent_activity,
            open_gate_activity,
            write_output_activity,
            update_run_status_activity,
        )
        from tanzen_worker.builtin_tasks import run_builtin_task_activity
        from tanzen_worker.script_runner import run_script_activity

        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)

        async def _server_lifetime():
            async with await WorkflowEnvironment.start_local() as env:
                self._env = env
                # Start one Worker per task queue so the sandbox is only
                # initialized once per process.
                workers = [
                    Worker(
                        env.client,
                        task_queue=tq,
                        workflows=[DynamicWorkflow],
                        activities=[
                            run_agent_activity,
                            open_gate_activity,
                            write_output_activity,
                            update_run_status_activity,
                            run_builtin_task_activity,
                            run_script_activity,
                        ],
                        workflow_runner=UnsandboxedWorkflowRunner(),
                    )
                    for tq in _TASK_QUEUES
                ]
                for w in workers:
                    await w.__aenter__()
                self._ready.set()
                try:
                    await self._loop.run_in_executor(None, self._stop_event.wait)
                finally:
                    for w in reversed(workers):
                        try:
                            await w.__aexit__(None, None, None)
                        except Exception:
                            pass

        try:
            self._loop.run_until_complete(_server_lifetime())
        finally:
            self._loop.close()


@pytest.fixture(scope="session")
def temporal_env(seaweedfs_pf) -> Generator[TemporalEnv, None, None]:
    env = TemporalEnv()
    env.start()
    try:
        yield env
    finally:
        env.stop()
