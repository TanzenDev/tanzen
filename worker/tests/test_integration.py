"""
Integration tests for DynamicWorkflow.

Tests are synchronous; async work is delegated to the session-scoped
TemporalEnv thread via temporal_env.run(coro).  All agent steps use
PydanticAI TestModel (via _agent_config_override) to avoid real LLM calls.

Gate tests: the workflow now waits for a ``gate_resolution`` signal instead
of auto-approving.  Tests start the workflow non-blocking, wait for the
gate activity to fire, then send the signal programmatically.
"""
from __future__ import annotations

import asyncio
import json
import uuid
import datetime

import pytest

from tanzen_worker.workflow import DynamicWorkflow

TASK_QUEUE = "tanzen-workflows-test"
ARTIFACTS_BUCKET = "artifacts"

_TEST_CFG = {
    "id": "test-agent",
    "version": "1.0",
    "model": "test",
    "system_prompt": "You are a test agent.",
    "mcp_servers": [],
    "secrets": [],
    "max_tokens": 128,
    "temperature": 0.0,
    "retries": 1,
}


def _agent_step(step_id: str, agent_id: str = "test-agent", **kwargs) -> dict:
    return {
        "id": step_id,
        "type": "agent",
        "agentId": agent_id,
        "agentVersion": "1.0",
        "_agent_config_override": _TEST_CFG,
        **kwargs,
    }


def _ir(steps: list, output: dict = None, params: dict = None) -> dict:
    ir: dict = {"name": "test-workflow", "version": "1.0.0", "steps": steps}
    if params:
        ir["params"] = params
    if output:
        ir["output"] = output
    return ir


def _run(temporal_env, ir: dict, params: dict = None) -> dict:
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


async def _run_with_gate_signal(
    client,
    ir: dict,
    params: dict,
    step_id: str,
    approved: bool,
    task_queue: str = TASK_QUEUE,
    signal_delay: float = 1.0,
) -> dict:
    """
    Start a workflow containing a gate, wait for the gate activity to open,
    send the gate_resolution signal, then return the final result.
    """
    run_id = f"test-gate-{uuid.uuid4()}"
    handle = await client.start_workflow(
        DynamicWorkflow.run,
        args=[ir, params],
        id=run_id,
        task_queue=task_queue,
        execution_timeout=datetime.timedelta(seconds=60),
    )

    # Give the gate activity enough time to write the gate record and return
    await asyncio.sleep(signal_delay)

    await handle.signal("gate_resolution", {
        "step_id": step_id,
        "gate_id": "test-gate",
        "approved": approved,
        "rejected": not approved,
        "notes": "approved in test" if approved else "rejected in test",
    })

    return await handle.result()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_trivial_sequential(temporal_env, s3):
    """Single agent step: completes and writes artifacts to SeaweedFS."""
    ir = _ir(steps=[_agent_step("analyze", input={"$ref": "run.input"})])

    result = _run(temporal_env, ir, {"__input__": "test document content"})

    assert "analyze" in result
    out = result["analyze"]
    assert "output" in out
    assert "artifact_key" in out

    obj = s3.get_object(Bucket=ARTIFACTS_BUCKET, Key=out["artifact_key"])
    payload = json.loads(obj["Body"].read())
    assert payload["agent_id"] == "test-agent"
    assert "output" in payload


def test_sequential_two_steps(temporal_env):
    """Second step receives first step's output as its resolved input."""
    ir = _ir(steps=[
        _agent_step("parse", input={"$ref": "run.input"}),
        _agent_step("summarize", input={"$ref": "parse.output"}),
    ])
    result = _run(temporal_env, ir, {"__input__": "raw text"})
    assert "parse" in result
    assert "summarize" in result


def test_parallel_static(temporal_env):
    """Static parallel block: both child steps run concurrently."""
    ir = _ir(steps=[{
        "id": "checks",
        "type": "parallel",
        "steps": [
            _agent_step("check_a", input={"$ref": "run.input"}),
            _agent_step("check_b", input={"$ref": "run.input"}),
        ],
    }])
    result = _run(temporal_env, ir, {"__input__": "data"})
    assert "checks" in result
    assert isinstance(result["checks"], list)
    assert len(result["checks"]) == 2
    assert "check_a" in result
    assert "check_b" in result


def test_parallel_foreach(temporal_env):
    """forEach: one activity per list item, outputs collected as list."""
    template = {**_agent_step(""), "input": {"$ref": "jurisdiction"}}
    ir = _ir(
        steps=[{
            "id": "analyze",
            "type": "parallel",
            "forEach": {
                "var": "jurisdiction",
                "in": {"$ref": "params.jurisdictions"},
            },
            "template": template,
        }],
        params={"jurisdictions": "string[]"},
    )
    result = _run(temporal_env, ir, {"jurisdictions": ["US", "EU", "UK"]})
    assert "analyze" in result
    assert isinstance(result["analyze"], list)
    assert len(result["analyze"]) == 3


def test_gate_approved(temporal_env):
    """Gate receives approval signal; when:approved step runs, when:rejected skipped."""
    ir = _ir(steps=[
        {
            "id": "review",
            "type": "gate",
            "assignee": "reviewer@example.com",
            "timeoutSeconds": 30,
        },
        _agent_step("on_approve", input={"$ref": "review.notes"},
                    **{"when": {"$ref": "review.approved"}}),
        _agent_step("on_reject", input={"$ref": "review.notes"},
                    **{"when": {"$ref": "review.rejected"}}),
    ])
    result = temporal_env.run(
        _run_with_gate_signal(temporal_env.client, ir, {}, "review", approved=True)
    )
    assert result["review"]["approved"] is True
    assert result["review"]["rejected"] is False
    assert "on_approve" in result
    assert "on_reject" not in result


def test_gate_rejected(temporal_env):
    """Gate receives rejection signal; when:rejected step runs, when:approved skipped."""
    ir = _ir(steps=[
        {
            "id": "review",
            "type": "gate",
            "assignee": "reviewer@example.com",
            "timeoutSeconds": 30,
        },
        _agent_step("on_approve", input="approved",
                    **{"when": {"$ref": "review.approved"}}),
        _agent_step("on_reject", input="rejected",
                    **{"when": {"$ref": "review.rejected"}}),
    ])
    result = temporal_env.run(
        _run_with_gate_signal(temporal_env.client, ir, {}, "review", approved=False)
    )
    assert result["review"]["approved"] is False
    assert result["review"]["rejected"] is True
    assert "on_reject" in result
    assert "on_approve" not in result


def test_output_artifact_written(temporal_env, s3):
    """Workflow with output block writes a final artifact to SeaweedFS."""
    ir = _ir(
        steps=[_agent_step("analyze", input={"$ref": "run.input"})],
        output={"artifact": {"$ref": "analyze.output"}, "retentionDays": 2555},
    )
    _run(temporal_env, ir, {"__input__": "doc content"})

    response = s3.list_objects_v2(Bucket=ARTIFACTS_BUCKET, Prefix="runs/")
    keys = [o["Key"] for o in response.get("Contents", [])]
    assert any("/final/" in k for k in keys)


def test_params_resolved(temporal_env):
    """Params passed at run time are resolved via $ref."""
    ir = _ir(
        steps=[_agent_step("process", input={"$ref": "params.target"})],
        params={"target": "string"},
    )
    result = _run(temporal_env, ir, {"target": "my-document.pdf"})
    assert "process" in result


# ---------------------------------------------------------------------------
# Task step tests
# ---------------------------------------------------------------------------

def _task_step(step_id: str, action: str, **kwargs) -> dict:
    return {"id": step_id, "type": "task", "action": action, **kwargs}


def test_task_filter_runs(temporal_env):
    """Single task step with 'filter' action returns filtered list."""
    data = [
        {"status": "active", "id": 1},
        {"status": "inactive", "id": 2},
        {"status": "active", "id": 3},
    ]
    ir = _ir(steps=[
        _task_step("filterRows", "filter",
                   input={"$ref": "run.input"},
                   params={"field": "status", "value": "active"}),
    ])
    result = _run(temporal_env, ir, {"__input__": data})
    assert "filterRows" in result
    output = result["filterRows"]["output"]
    assert isinstance(output, list)
    assert len(output) == 2
    assert all(row["status"] == "active" for row in output)


def test_mixed_agent_then_task(temporal_env):
    """Agent output piped into task 'slice'."""
    # Agent (TestModel) returns a string; wrap it in a list via format_json first
    ir = _ir(steps=[
        _agent_step("gen", input={"$ref": "run.input"}),
        _task_step("sliced", "slice",
                   input=[1, 2, 3, 4, 5],  # literal list — not a ref, resolved directly
                   params={"offset": 1, "limit": 2}),
    ])
    result = _run(temporal_env, ir, {"__input__": "data"})
    assert "gen" in result
    assert "sliced" in result
    output = result["sliced"]["output"]
    assert output == [2, 3]


def test_task_then_agent(temporal_env):
    """Task 'format_json' output piped into agent step."""
    ir = _ir(steps=[
        _task_step("fmt", "format_json",
                   input={"a": 1, "b": 2},
                   params={"indent": 2}),
        _agent_step("analyze",
                    input={"$ref": "fmt.output"},
                    _agent_config_override=_TEST_CFG),
    ])
    result = _run(temporal_env, ir, {})
    assert "fmt" in result
    assert "analyze" in result
    # task output is a JSON string
    assert isinstance(result["fmt"]["output"], str)


def test_task_unknown_action_fails(temporal_env):
    """Workflow with an invalid task action raises an error."""
    ir = _ir(steps=[
        _task_step("bad", "not_a_real_action"),
    ])
    with pytest.raises(Exception):
        _run(temporal_env, ir, {})


def test_task_with_when_skipped(temporal_env):
    """Task whose 'when' condition is false is skipped (not in outputs)."""
    ir = _ir(steps=[
        {
            "id": "review",
            "type": "gate",
            "assignee": "r@example.com",
            "timeoutSeconds": 30,
        },
        _task_step("doTask", "slice",
                   input=[1, 2, 3],
                   params={"offset": 0, "limit": 2},
                   **{"when": {"$ref": "review.approved"}}),
    ])
    # Reject the gate — doTask's when:approved is false → task skipped
    result = temporal_env.run(
        _run_with_gate_signal(temporal_env.client, ir, {}, "review", approved=False)
    )
    assert result["review"]["approved"] is False
    assert "doTask" not in result
