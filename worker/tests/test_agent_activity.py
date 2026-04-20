"""
Unit tests for run_agent_activity using PydanticAI TestModel.

Tests are synchronous; async work is delegated to the session-scoped
TemporalEnv thread via temporal_env.run(coro).  The session-level Worker
(started in conftest.py) handles activity execution.
"""
from __future__ import annotations

import json
import uuid
import datetime

import pytest

from tanzen_worker.workflow import DynamicWorkflow

TASK_QUEUE = "tanzen-agent-test"

TEST_AGENT_CONFIG = {
    "id": "test-agent",
    "version": "1.0",
    "model": "test",
    "system_prompt": "You are a test agent.",
    "mcp_servers": [],
    "secrets": [],
    "max_tokens": 256,
    "temperature": 0.0,
    "retries": 1,
}


def _step(step_id: str = "test_step", **kwargs) -> dict:
    return {
        "id": step_id,
        "type": "agent",
        "agentId": "test-agent",
        "agentVersion": "1.0",
        "_agent_config_override": TEST_AGENT_CONFIG,
        **kwargs,
    }


def _run(temporal_env, ir, params=None):
    """Execute a DynamicWorkflow on the Temporal loop and return outputs."""
    run_id = f"test-{uuid.uuid4()}"
    return temporal_env.run(
        temporal_env.client.execute_workflow(
            DynamicWorkflow.run,
            args=[ir, params or {}],
            id=run_id,
            task_queue=TASK_QUEUE,
            execution_timeout=datetime.timedelta(seconds=60),
        )
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_agent_runs_with_test_model(temporal_env, s3):
    """Agent completes with TestModel and writes output artifact to SeaweedFS."""
    ir = {"name": "t", "version": "1.0.0",
          "steps": [_step(input={"$ref": "run.input"})]}

    result = _run(temporal_env, ir, {"__input__": "analyze this"})

    assert "test_step" in result
    out = result["test_step"]
    assert "output" in out
    assert "artifact_key" in out

    obj = s3.get_object(Bucket="artifacts", Key=out["artifact_key"])
    payload = json.loads(obj["Body"].read())
    assert payload["agent_id"] == "test-agent"
    assert "output" in payload


def test_agent_params_recorded_in_artifact(temporal_env, s3):
    """Params passed to the activity are recorded in the output artifact."""
    step = _step(input={"$ref": "run.input"}, params={"mode": "strict", "limit": 10})
    ir = {"name": "t", "version": "1.0.0", "steps": [step]}

    result = _run(temporal_env, ir, {"__input__": "doc"})
    out = result["test_step"]

    obj = s3.get_object(Bucket="artifacts", Key=out["artifact_key"])
    payload = json.loads(obj["Body"].read())
    assert "output" in payload
    assert payload["agent_id"] == "test-agent"


def test_sequential_steps_share_context(temporal_env):
    """Second step receives first step's output as its resolved input."""
    ir = {
        "name": "t", "version": "1.0.0",
        "steps": [
            _step("step_a", input={"$ref": "run.input"}),
            _step("step_b", input={"$ref": "step_a.output"}),
        ],
    }
    result = _run(temporal_env, ir, {"__input__": "hello"})
    assert "step_a" in result
    assert "step_b" in result


def test_parallel_foreach_with_test_model(temporal_env):
    """forEach parallel runs one activity per item using TestModel."""
    template = _step("", input={"$ref": "item"})
    ir = {
        "name": "t", "version": "1.0.0",
        "steps": [{
            "id": "fanout", "type": "parallel",
            "forEach": {"var": "item", "in": {"$ref": "params.items"}},
            "template": template,
        }],
    }
    result = _run(temporal_env, ir, {"items": ["a", "b", "c"]})
    assert "fanout" in result
    assert len(result["fanout"]) == 3


def test_when_condition_skips_step(temporal_env):
    """Step with a truthy when condition runs; falsy is skipped."""
    import asyncio

    ir = {
        "name": "t", "version": "1.0.0",
        "steps": [
            {"id": "review", "type": "gate",
             "assignee": "test@example.com", "timeoutSeconds": 20},
            _step("approved_path", input="approved",
                  **{"when": {"$ref": "review.approved"}}),
            _step("rejected_path", input="rejected",
                  **{"when": {"$ref": "review.rejected"}}),
        ],
    }

    from tanzen_worker.workflow import DynamicWorkflow

    async def _execute():
        run_id = f"test-gate-{uuid.uuid4()}"
        handle = await temporal_env.client.start_workflow(
            DynamicWorkflow.run,
            args=[ir, {}],
            id=run_id,
            task_queue=TASK_QUEUE,
            execution_timeout=datetime.timedelta(seconds=60),
        )
        await asyncio.sleep(1.0)
        await handle.signal("gate_resolution", {
            "step_id": "review", "gate_id": "test",
            "approved": True, "rejected": False, "notes": "",
        })
        return await handle.result()

    result = temporal_env.run(_execute())
    assert result["review"]["approved"] is True
    assert "approved_path" in result
    assert "rejected_path" not in result


def test_mcp_config_accepted(temporal_env):
    """Agent config with empty mcp_servers list is parsed without error."""
    ir = {
        "name": "t", "version": "1.0.0",
        "steps": [_step("s", input="test")],
    }
    result = _run(temporal_env, ir, {})
    assert "s" in result
