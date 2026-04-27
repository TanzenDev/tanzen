"""
Tanzen Dynamic Workflow — interprets JSON IR at runtime.

A single Temporal workflow definition that executes any workflow described
by the Tanzen IR. Events are published by activities; the workflow itself
is pure orchestration.

Gate steps: the workflow opens the gate via an activity, then waits for a
`gate_resolution` signal keyed by step_id.  The API server sends this signal
when a reviewer approves or rejects the gate.
"""
from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any, Callable

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import TimeoutError as TemporalTimeoutError

with workflow.unsafe.imports_passed_through():
    from tanzen_worker.state import RunState  # pure Python, no I/O
    from tanzen_worker.activities import (    # activities imported for type refs only
        AgentActivityInput,
        AgentActivityOutput,
        GateActivityInput,
        GateActivityOutput,
        WriteOutputActivityInput,
        run_agent_activity,
        open_gate_activity,
        write_output_activity,
        update_run_status_activity,
    )
    from tanzen_worker.builtin_tasks import (
        TaskActivityInput,
        TaskActivityOutput,
        run_builtin_task_activity,
    )
    from tanzen_worker.script_runner import (
        ScriptActivityInput,
        ScriptActivityOutput,
        run_script_activity,
    )


# ---------------------------------------------------------------------------
# Step handler registry — extension point for commercial builds
# ---------------------------------------------------------------------------

# Maps step type string → coroutine method (unbound, takes self + run_id, step, state)
_step_handlers: dict[str, Callable] = {}


def register_step_handler(step_type: str, handler: Callable) -> None:
    """Register a handler for a custom step type.

    Commercial builds call this at import time to add new step types without
    modifying workflow.py.  Handler signature must match the built-in runners:
        async def handler(self: DynamicWorkflow, run_id: str, step: dict, state: RunState) -> Any
    """
    _step_handlers[step_type] = handler


@workflow.defn
class DynamicWorkflow:
    """
    Interprets a Tanzen JSON IR document and executes its steps sequentially
    (agent, gate) or in parallel (parallel/forEach).
    """

    def __init__(self) -> None:
        # Stores gate_resolution signal payloads keyed by step_id.
        # Written by the signal handler; read by _run_gate_step.
        self._gate_resolutions: dict[str, dict[str, Any]] = {}

    # ------------------------------------------------------------------
    # Signal handler — called by the API server after a reviewer acts
    # ------------------------------------------------------------------

    @workflow.signal
    def gate_resolution(self, data: dict[str, Any]) -> None:
        """
        Receive a gate resolution from the API server.

        Expected payload::

            {
              "step_id":  "review",
              "gate_id":  "<uuid>",
              "approved": true,
              "rejected": false,
              "notes":    "Looks good"
            }
        """
        step_id: str = data.get("step_id", "")
        if step_id:
            self._gate_resolutions[step_id] = data

    # ------------------------------------------------------------------
    # Main entrypoint
    # ------------------------------------------------------------------

    @workflow.run
    async def run(self, ir: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        run_id = workflow.info().workflow_id
        state = RunState(params=params)
        try:
            result = await self._execute(run_id, ir, state)
            await workflow.execute_activity(
                update_run_status_activity,
                args=[run_id, "succeeded", None],
                start_to_close_timeout=timedelta(seconds=10),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
            return result
        except Exception as exc:
            # Unwrap Temporal's ActivityError (__cause__ = ApplicationError w/ real msg)
            cause = exc.__cause__ or exc
            error_msg = str(cause.__cause__ or cause)
            await workflow.execute_activity(
                update_run_status_activity,
                args=[run_id, "failed", error_msg],
                start_to_close_timeout=timedelta(seconds=10),
                retry_policy=RetryPolicy(maximum_attempts=1),
            )
            raise

    async def _execute(self, run_id: str, ir: dict[str, Any], state: RunState) -> dict[str, Any]:
        for step in ir.get("steps", []):
            step_type = step["type"]
            step_id = step.get("id", "")

            if not state.evaluate_condition(step.get("when")):
                workflow.logger.info(f"Skipping step '{step_id}': when condition false")
                continue

            if step_type == "agent":
                result = await self._run_agent_step(run_id, step, state)
                state.set_output(step_id, result.output)

            elif step_type == "parallel":
                outputs = await self._run_parallel_step(run_id, step, state)
                state.set_output(step_id, outputs)

            elif step_type == "task":
                result = await self._run_task_step(run_id, step, state)
                state.set_output(step_id, {"output": result.output})

            elif step_type == "gate":
                result = await self._run_gate_step(run_id, step, state)
                state.set_output(step_id, {
                    "approved": result.approved,
                    "rejected": result.rejected,
                    "notes":    result.notes,
                })

            elif step_type == "script":
                result = await self._run_script_step(run_id, step, state)
                state.set_output(step_id, {"output": result.output})

            elif step_type in _step_handlers:
                result = await _step_handlers[step_type](self, run_id, step, state)
                state.set_output(step_id, result)

            else:
                raise ValueError(f"Unknown step type: '{step_type}'")

        output_spec = ir.get("output")
        if output_spec:
            artifact_ref = output_spec.get("artifact")
            resolved_key = state.resolve(artifact_ref)
            if isinstance(resolved_key, dict):
                resolved_key = resolved_key.get("artifact_key", str(resolved_key))
            await workflow.execute_activity(
                write_output_activity,
                WriteOutputActivityInput(
                    run_id=run_id,
                    output_spec=output_spec,
                    resolved_artifact_key=str(resolved_key) if resolved_key else "",
                    retention_days=output_spec.get("retentionDays"),
                ),
                start_to_close_timeout=timedelta(seconds=30),
            )

        return state.outputs

    # ------------------------------------------------------------------
    # Step runners
    # ------------------------------------------------------------------

    async def _run_agent_step(
        self,
        run_id: str,
        step: dict[str, Any],
        state: RunState,
    ) -> AgentActivityOutput:
        resolved_input = state.resolve(step.get("input"))
        raw_params = step.get("params", {})
        resolved_params = state.resolve(raw_params) if raw_params else {}

        return await workflow.execute_activity(
            run_agent_activity,
            AgentActivityInput(
                run_id=run_id,
                step=step,
                resolved_input=resolved_input,
                resolved_params=resolved_params if isinstance(resolved_params, dict) else {},
                agent_config_override=step.get("_agent_config_override"),
            ),
            start_to_close_timeout=timedelta(seconds=step.get("timeoutSeconds", 1800)),
            retry_policy=RetryPolicy(maximum_attempts=step.get("retry", 1)),
        )

    async def _run_parallel_step(
        self,
        run_id: str,
        step: dict[str, Any],
        state: RunState,
    ) -> list[Any]:
        for_each = step.get("forEach")

        if for_each:
            items = state.resolve(for_each["in"])
            if not isinstance(items, list):
                items = [items] if items is not None else []

            template = step["template"]
            var_name = for_each["var"]

            async def run_for_item(item: Any) -> Any:
                item_state = RunState(params={**state.params, var_name: item})
                item_state.outputs = dict(state.outputs)
                result = await self._run_agent_step(run_id, template, item_state)
                return result.output

            return list(await asyncio.gather(*[run_for_item(item) for item in items]))

        else:
            steps = step.get("steps", [])

            async def run_static(sub_step: dict) -> tuple[str, Any]:
                result = await self._run_agent_step(run_id, sub_step, state)
                return sub_step["id"], result.output

            pairs = await asyncio.gather(*[run_static(s) for s in steps])
            outputs = []
            for sid, out in pairs:
                state.set_output(sid, out)
                outputs.append(out)
            return outputs

    async def _run_task_step(
        self,
        run_id: str,
        step: dict[str, Any],
        state: RunState,
    ) -> TaskActivityOutput:
        return await workflow.execute_activity(
            run_builtin_task_activity,
            TaskActivityInput(
                run_id=run_id,
                step_id=step.get("id", ""),
                action=step["action"],
                resolved_input=state.resolve(step.get("input")),
                resolved_params=state.resolve(step.get("params") or {}) or {},
            ),
            start_to_close_timeout=timedelta(seconds=step.get("timeoutSeconds", 60)),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )

    async def _run_script_step(
        self,
        run_id: str,
        step: dict[str, Any],
        state: RunState,
    ) -> ScriptActivityOutput:
        return await workflow.execute_activity(
            run_script_activity,
            ScriptActivityInput(
                run_id=run_id,
                step_id=step.get("id", ""),
                script_name=step.get("scriptName", ""),
                script_version=step.get("scriptVersion", "unknown"),
                s3_key=step.get("s3Key", ""),
                resolved_input=state.resolve(step.get("input")),
                resolved_params=state.resolve(step.get("params") or {}) or {},
                allowed_hosts=step.get("allowedHosts", ""),
                allowed_env=step.get("allowedEnv", ""),
                timeout_seconds=step.get("timeoutSeconds", 30),
                language=step.get("language", "typescript"),
            ),
            start_to_close_timeout=timedelta(seconds=step.get("timeoutSeconds", 30) + 10),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )

    async def _run_gate_step(
        self,
        run_id: str,
        step: dict[str, Any],
        state: RunState,
    ) -> GateActivityOutput:
        step_id = step.get("id", "")
        timeout_seconds = step.get("timeoutSeconds", 259200)
        resolved_input = state.resolve(step.get("input"))

        # 1. Open the gate — writes to Postgres, publishes GATE_OPENED event
        await workflow.execute_activity(
            open_gate_activity,
            GateActivityInput(
                run_id=run_id,
                step=step,
                resolved_input=resolved_input,
            ),
            start_to_close_timeout=timedelta(seconds=30),
        )

        # 2. Wait for the gate_resolution signal (keyed by step_id)
        try:
            await workflow.wait_condition(
                lambda: step_id in self._gate_resolutions,
                timeout=timedelta(seconds=timeout_seconds),
            )
        except TemporalTimeoutError:
            workflow.logger.warning(f"Gate '{step_id}' timed out after {timeout_seconds}s")
            return GateActivityOutput(
                step_id=step_id,
                approved=False,
                rejected=True,
                notes="[gate timed out]",
            )

        # 3. Consume the resolution
        resolution = self._gate_resolutions.pop(step_id)
        return GateActivityOutput(
            step_id=step_id,
            approved=bool(resolution.get("approved", False)),
            rejected=bool(resolution.get("rejected", True)),
            notes=str(resolution.get("notes", "")),
        )
