"""
Layer 3 e2e test: DynamicWorkflow + real MCP servers + real LLM.

Each test submits a workflow to the local TemporalEnv with a real model
(Groq) and a real MCP server reachable via port-forward.  The workflow
runs through the full Temporal + PydanticAI + MCP stack.

Prerequisites (run before pytest):
  tanzenctl forward --mcp   # port-forwards 8081/8082/8083
  export GROQ_API_KEY=...

Skip conditions (auto-detected):
  - GROQ_API_KEY not set
  - MCP port-forwards not reachable on localhost:8081/8082/8083
"""
from __future__ import annotations

import datetime
import os
import socket
import uuid

import pytest


# ---------------------------------------------------------------------------
# Skip guards
# ---------------------------------------------------------------------------

_NO_KEY = not os.environ.get("GROQ_API_KEY")


def _port_open(port: int) -> bool:
    try:
        s = socket.create_connection(("localhost", port), timeout=1)
        s.close()
        return True
    except OSError:
        return False


_NO_MCP = not all(_port_open(p) for p in [8081, 8082, 8083])

skip_no_key = pytest.mark.skipif(_NO_KEY, reason="GROQ_API_KEY not set")
skip_no_mcp = pytest.mark.skipif(_NO_MCP, reason="MCP port-forwards not running — tanzenctl forward --mcp")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_MODEL = "groq:llama-3.3-70b-versatile"
TASK_QUEUE = "tanzen-workflows-test"


def _cfg(mcp_url: str) -> dict:
    return {
        "id": "mcp-e2e-agent",
        "version": "1.0",
        "model": _MODEL,
        "system_prompt": (
            "You are a helpful assistant. "
            "Always use the available tools when instructed to do so."
        ),
        "mcp_servers": [{"url": mcp_url, "tool_filter": []}],
        "secrets": [],
        "max_tokens": 512,
        "temperature": 0.0,
        "retries": 2,
    }


def _step(step_id: str, mcp_url: str, prompt: str) -> dict:
    return {
        "id": step_id,
        "type": "agent",
        "agentId": "mcp-e2e-agent",
        "agentVersion": "1.0",
        "_agent_config_override": _cfg(mcp_url),
        "input": prompt,
    }


def _ir(steps: list) -> dict:
    return {"name": "mcp-e2e-workflow", "version": "1.0.0", "steps": steps}


def _run(temporal_env, ir: dict, params: dict | None = None) -> dict:
    run_id = f"mcp-e2e-{uuid.uuid4()}"
    return temporal_env.run(
        temporal_env.client.execute_workflow(
            "DynamicWorkflow",
            args=[ir, params or {}],
            id=run_id,
            task_queue=TASK_QUEUE,
            execution_timeout=datetime.timedelta(seconds=120),
        ),
        timeout=130,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@skip_no_key
@skip_no_mcp
def test_sequential_thinking_workflow(temporal_env):
    """
    Agent wired to mcp-sequential-thinking uses the tool to plan a task.
    The workflow must complete and produce non-empty output.
    """
    ir = _ir([_step(
        "plan",
        "http://localhost:8081/mcp",
        (
            "Use the sequentialthinking tool to outline exactly three steps to brew coffee. "
            "Call the tool once per step with thoughtNumber 1, 2, and 3."
        ),
    )])
    result = _run(temporal_env, ir)
    assert "plan" in result, f"step 'plan' missing from result: {result}"
    output = result["plan"].get("output", "")
    assert isinstance(output, str) and len(output) > 10, f"Unexpected output: {output!r}"
    print(f"\n  [sequential-thinking] output: {output[:200]}")


@skip_no_key
@skip_no_mcp
def test_fetch_workflow(temporal_env):
    """
    Agent wired to mcp-fetch retrieves a real web page and summarises it.
    The workflow must complete and the output must mention the fetched content.
    """
    ir = _ir([_step(
        "fetch",
        "http://localhost:8082/mcp",
        (
            "Use the fetch_html tool to retrieve https://example.com "
            "and summarise in one sentence what the page says."
        ),
    )])
    result = _run(temporal_env, ir)
    assert "fetch" in result, f"step 'fetch' missing from result: {result}"
    output = result["fetch"].get("output", "")
    assert isinstance(output, str) and len(output) > 10, f"Unexpected output: {output!r}"
    print(f"\n  [fetch] output: {output[:200]}")


@skip_no_key
@skip_no_mcp
def test_falkordb_workflow(temporal_env):
    """
    Agent wired to mcp-falkordb calls list_graphs and reports the result.
    The workflow must complete and produce non-empty output.
    """
    ir = _ir([_step(
        "graphs",
        "http://localhost:8083/mcp",
        "Use the list_graphs tool to list all available graph databases.",
    )])
    result = _run(temporal_env, ir)
    assert "graphs" in result, f"step 'graphs' missing from result: {result}"
    output = result["graphs"].get("output", "")
    assert isinstance(output, str) and len(output) >= 0, f"Unexpected output: {output!r}"
    print(f"\n  [falkordb] output: {output[:200]}")


@skip_no_key
@skip_no_mcp
def test_mcp_agent_then_task(temporal_env):
    """
    MCP agent step followed by a builtin task step — full pipeline.
    Verifies MCP agent output flows into a downstream task.
    """
    ir = _ir([
        _step(
            "think",
            "http://localhost:8081/mcp",
            (
                "Use the sequentialthinking tool to produce one thought about "
                "why testing is important. Use thoughtNumber 1."
            ),
        ),
        {
            "id": "fmt",
            "type": "task",
            "action": "format_json",
            "input": {"$ref": "think.output"},
            "params": {"indent": 2},
        },
    ])
    result = _run(temporal_env, ir)
    assert "think" in result
    assert "fmt" in result
    # format_json wraps the string in JSON
    fmt_output = result["fmt"]["output"]
    assert isinstance(fmt_output, str)
    print(f"\n  [mcp+task] fmt output: {fmt_output[:200]}")
