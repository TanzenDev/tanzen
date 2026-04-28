"""
Locust multi-step user journey: create workflow → compile → run → poll → clean up.

Usage:
    locust -f locust/tanzen_flow.py --host http://localhost:3000 \
           --users 50 --spawn-rate 5 --run-time 10m --headless

Environment variables:
    TANZEN_TOKEN   — Bearer JWT (required)
    TANZEN_MODEL   — model for the test agent (default: test)
                     Use 'test' for a mock model that returns instantly without LLM calls.

Pass criteria:
    - Median run completion < 30 s (with 'test' model)
    - p95 run completion < 60 s
    - Failure rate < 2 %
"""
from __future__ import annotations

import json
import os
import time
from locust import HttpUser, task, between, events

TOKEN = os.environ.get("TANZEN_TOKEN", "")
MODEL = os.environ.get("TANZEN_MODEL", "test")

HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
}

ECHO_DSL = f"""
workflow LocustEchoWorkflow {{
  version: "1.0.0"
  step echo {{
    agent: locust-echo-agent @ "1.0"
    input: run.input
    timeout: 2m
  }}
  output {{
    artifact: echo.output
  }}
}}
"""


class TanzenUser(HttpUser):
    wait_time = between(1, 3)

    def on_start(self) -> None:
        """Create a per-VU echo agent and workflow once."""
        # Create agent
        agent_resp = self.client.post(
            "/api/agents",
            data=json.dumps({
                "name": f"locust-echo-agent",
                "model": MODEL,
                "system_prompt": "Repeat the user input verbatim.",
                "max_tokens": 256,
            }),
            headers=HEADERS,
            name="/api/agents [setup]",
        )
        if agent_resp.status_code not in (200, 201, 409):
            agent_resp.failure(f"agent create failed: {agent_resp.status_code}")
            return

        # Create workflow
        wf_resp = self.client.post(
            "/api/workflows",
            data=json.dumps({"name": "locust-echo", "dsl": ECHO_DSL}),
            headers=HEADERS,
            name="/api/workflows [setup]",
        )
        if wf_resp.status_code not in (200, 201, 409):
            wf_resp.failure(f"workflow create failed: {wf_resp.status_code}")
            return

        # If 409 (already exists), look it up
        if wf_resp.status_code == 409 or "id" not in (wf_resp.json() or {}):
            list_resp = self.client.get("/api/workflows?limit=100", headers=HEADERS)
            items = (list_resp.json() or {}).get("items", [])
            match = next((w for w in items if w.get("name") == "locust-echo"), None)
            self.wf_id = match["id"] if match else None
        else:
            self.wf_id = wf_resp.json().get("id")

    # ── Tasks ──────────────────────────────────────────────────────────────────

    @task(5)
    def run_workflow(self) -> None:
        """Submit a run and poll until completion."""
        if not getattr(self, "wf_id", None):
            return

        start = time.monotonic()
        run_resp = self.client.post(
            f"/api/workflows/{self.wf_id}/runs",
            data=json.dumps({"input": {"text": "locust load test", "ts": time.time()}}),
            headers=HEADERS,
            name="/api/workflows/:id/runs",
        )
        if run_resp.status_code not in (200, 201):
            return
        run_id = run_resp.json().get("id") or run_resp.json().get("runId")
        if not run_id:
            return

        # Poll for completion (max 90 s)
        for _ in range(45):
            time.sleep(2)
            poll = self.client.get(
                f"/api/runs/{run_id}",
                headers=HEADERS,
                name="/api/runs/:id [poll]",
            )
            status = (poll.json() or {}).get("status", "")
            if status in ("succeeded", "failed"):
                elapsed_ms = (time.monotonic() - start) * 1000
                # Report as a custom metric via events
                events.request.fire(
                    request_type="RUN",
                    name="run_e2e",
                    response_time=elapsed_ms,
                    response_length=0,
                    exception=None if status == "succeeded" else Exception(status),
                    context={},
                )
                return

    @task(2)
    def list_runs(self) -> None:
        self.client.get("/api/runs", headers=HEADERS)

    @task(1)
    def list_workflows(self) -> None:
        self.client.get("/api/workflows", headers=HEADERS)

    @task(1)
    def compile_dsl(self) -> None:
        if not getattr(self, "wf_id", None):
            return
        self.client.post(
            f"/api/workflows/{self.wf_id}/compile",
            data=json.dumps({"dsl": ECHO_DSL}),
            headers=HEADERS,
            name="/api/workflows/:id/compile",
        )

    @task(1)
    def list_agents(self) -> None:
        self.client.get("/api/agents", headers=HEADERS)
