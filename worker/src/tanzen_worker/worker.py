"""
Tanzen worker entrypoint.

Registers DynamicWorkflow and all activities, then connects to Temporal
and starts polling the task queue.

Extension points (both are supported and merged):

1. Environment variable: TANZEN_WORKER_EXTENSIONS=mod_a,mod_b
   Each module may export:
     activities: list   — activity functions to register
     workflows:  list   — workflow classes to register
     step_handlers: dict[str, Callable] — registered via register_step_handler()

2. Python packaging entry points (group "tanzen.worker.extensions"):
   Packages declare their extension module in pyproject.toml:
     [project.entry-points."tanzen.worker.extensions"]
     my-ext = "my_package.worker_ext"
   The referenced module is loaded with the same protocol as #1.
"""
from __future__ import annotations

import asyncio
import importlib
import importlib.metadata
import os

from grpc import RpcError
from temporalio.client import Client
from temporalio.worker import Worker

from tanzen_worker.workflow import DynamicWorkflow, register_step_handler
from tanzen_worker.activities import (
    run_agent_activity,
    open_gate_activity,
    write_output_activity,
    update_run_status_activity,
)
from tanzen_worker.builtin_tasks import run_builtin_task_activity
from tanzen_worker.script_runner import run_script_activity
from tanzen_worker.otel import init_worker_otel, init_worker_traces

TEMPORAL_HOST = os.environ.get("TEMPORAL_HOST", "localhost:7233")
TEMPORAL_NAMESPACE = os.environ.get("TEMPORAL_NAMESPACE", "default")
TASK_QUEUE = os.environ.get("TASK_QUEUE", "tanzen-workflows")

_CORE_ACTIVITIES = [
    run_agent_activity,
    open_gate_activity,
    write_output_activity,
    update_run_status_activity,
    run_builtin_task_activity,
    run_script_activity,
]
_CORE_WORKFLOWS = [DynamicWorkflow]


def _load_extension_module(mod_path: str, extra_activities: list, extra_workflows: list) -> None:
    """Import one extension module and merge its exports into the provided lists."""
    try:
        mod = importlib.import_module(mod_path)
        extra_activities.extend(getattr(mod, "activities", []))
        extra_workflows.extend(getattr(mod, "workflows", []))
        for step_type, handler in getattr(mod, "step_handlers", {}).items():
            register_step_handler(step_type, handler)
        print(f"Worker extension loaded: {mod_path}")
    except ImportError as exc:
        print(f"Worker extension not found (skipping): {mod_path} — {exc}")


def _load_extensions() -> tuple[list, list]:
    """Load extension modules from env var and installed entry points."""
    extra_activities: list = []
    extra_workflows: list = []

    # 1. Env-var based extensions (explicit module paths)
    ext_env = os.environ.get("TANZEN_WORKER_EXTENSIONS", "")
    for mod_path in (e.strip() for e in ext_env.split(",") if e.strip()):
        _load_extension_module(mod_path, extra_activities, extra_workflows)

    # 2. Entry-point based extensions (installed packages that declare
    #    [project.entry-points."tanzen.worker.extensions"])
    try:
        eps = importlib.metadata.entry_points(group="tanzen.worker.extensions")
        for ep in eps:
            _load_extension_module(ep.value, extra_activities, extra_workflows)
    except Exception as exc:  # noqa: BLE001
        print(f"Worker: entry-point discovery failed (skipping): {exc}")

    return extra_activities, extra_workflows


async def _connect_with_retry(host: str, namespace: str, max_attempts: int = 20, delay: float = 5.0) -> Client:
    for attempt in range(1, max_attempts + 1):
        try:
            return await Client.connect(host, namespace=namespace)
        except (RpcError, Exception) as exc:
            if attempt == max_attempts:
                raise
            print(f"Temporal not ready (attempt {attempt}/{max_attempts}): {exc}. Retrying in {delay}s…")
            await asyncio.sleep(delay)
    raise RuntimeError("unreachable")


async def _run():
    init_worker_otel()
    init_worker_traces()
    extra_activities, extra_workflows = _load_extensions()
    client = await _connect_with_retry(TEMPORAL_HOST, TEMPORAL_NAMESPACE)
    worker = Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[*_CORE_WORKFLOWS, *extra_workflows],
        activities=[*_CORE_ACTIVITIES, *extra_activities],
    )
    print(f"Worker started — queue={TASK_QUEUE} host={TEMPORAL_HOST}")
    await worker.run()


def main():
    asyncio.run(_run())


if __name__ == "__main__":
    main()
