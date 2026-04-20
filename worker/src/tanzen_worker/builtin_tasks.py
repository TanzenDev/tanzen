"""
Tanzen built-in task activities.

Pure-Python, non-LLM transformations available as a Temporal activity.
All action functions share the signature: (data: Any, params: dict) -> Any.
"""
from __future__ import annotations

import csv
import io
import json
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any

from temporalio import activity


# ---------------------------------------------------------------------------
# Action implementations
# ---------------------------------------------------------------------------

def _filter(data: Any, params: dict) -> Any:
    field = params["field"]
    value = params["value"]
    if not isinstance(data, list):
        return data
    return [item for item in data if isinstance(item, dict) and item.get(field) == value]


def _sort(data: Any, params: dict) -> Any:
    field = params["field"]
    reverse = params.get("order", "asc") == "desc"
    if not isinstance(data, list):
        return data
    return sorted(data, key=lambda x: x.get(field) if isinstance(x, dict) else x, reverse=reverse)


def _slice(data: Any, params: dict) -> Any:
    offset = int(params.get("offset", 0))
    limit = params.get("limit")
    if not isinstance(data, list):
        return data
    if limit is not None:
        return data[offset: offset + int(limit)]
    return data[offset:]


def _deduplicate(data: Any, params: dict) -> Any:
    key = params.get("key")
    if not isinstance(data, list):
        return data
    if key is None:
        seen: list = []
        result: list = []
        for item in data:
            if item not in seen:
                seen.append(item)
                result.append(item)
        return result
    seen_keys: set = set()
    result2: list = []
    for item in data:
        k = item.get(key) if isinstance(item, dict) else item
        if k not in seen_keys:
            seen_keys.add(k)
            result2.append(item)
    return result2


def _flatten(data: Any, params: dict) -> Any:
    if not isinstance(data, list):
        return data
    result: list = []
    for item in data:
        if isinstance(item, list):
            result.extend(item)
        else:
            result.append(item)
    return result


def _map(data: Any, params: dict) -> Any:
    mapping: dict = params.get("mapping", {})
    if not isinstance(data, list):
        return data
    return [{new_k: item.get(old_k) for new_k, old_k in mapping.items()}
            if isinstance(item, dict) else item
            for item in data]


def _extract_fields(data: Any, params: dict) -> Any:
    fields: list[str] = params.get("fields", [])
    if isinstance(data, dict):
        return {k: v for k, v in data.items() if k in fields}
    if isinstance(data, list):
        return [{k: v for k, v in item.items() if k in fields}
                if isinstance(item, dict) else item
                for item in data]
    return data


def _parse_csv(data: Any, params: dict) -> Any:
    delimiter = params.get("delimiter", ",")
    text = data if isinstance(data, str) else str(data)
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    return [dict(row) for row in reader]


def _parse_json(data: Any, params: dict) -> Any:
    text = data if isinstance(data, str) else str(data)
    return json.loads(text)


def _format_json(data: Any, params: dict) -> Any:
    indent = int(params.get("indent", 2))
    return json.dumps(data, indent=indent, default=str)


def _template(data: Any, params: dict) -> Any:
    from jinja2 import Environment, Undefined  # type: ignore[import]
    env = Environment(undefined=Undefined)
    tmpl_str = params.get("template", "")
    context = data if isinstance(data, dict) else {"data": data}
    return env.from_string(tmpl_str).render(**context)


async def _http_request(data: Any, params: dict) -> Any:
    import httpx  # type: ignore[import]
    url: str = params["url"]
    method: str = params.get("method", "GET").upper()
    headers: dict = params.get("headers", {})
    body = params.get("body")
    timeout: float = float(params.get("timeout_seconds", 30))

    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.request(
            method, url,
            headers=headers,
            json=body if body is not None else None,
        )
    return {
        "status_code": response.status_code,
        "body": response.text,
        "headers": dict(response.headers),
    }


_ACTIONS: dict[str, Any] = {
    "filter":        _filter,
    "sort":          _sort,
    "slice":         _slice,
    "deduplicate":   _deduplicate,
    "flatten":       _flatten,
    "map":           _map,
    "extract_fields": _extract_fields,
    "parse_csv":     _parse_csv,
    "parse_json":    _parse_json,
    "format_json":   _format_json,
    "template":      _template,
    "http_request":  _http_request,
}


# ---------------------------------------------------------------------------
# Activity I/O types
# ---------------------------------------------------------------------------

@dataclass
class TaskActivityInput:
    run_id: str
    step_id: str
    action: str
    resolved_input: Any
    resolved_params: dict[str, Any]


@dataclass
class TaskActivityOutput:
    step_id: str
    output: Any
    duration_ms: float = 0.0


# ---------------------------------------------------------------------------
# Postgres write helper (best-effort, same pattern as gate activity)
# ---------------------------------------------------------------------------

async def _write_step_record(run_id: str, step_id: str, action: str, duration_ms: float) -> None:
    """Record task step in run_steps table. Best-effort: never raises."""
    try:
        import asyncpg  # type: ignore[import]
        db_url = os.environ.get("DATABASE_URL", "")
        if not db_url:
            return
        conn = await asyncpg.connect(db_url)
        try:
            record_id = str(uuid.uuid4())
            await conn.execute(
                """
                INSERT INTO run_steps
                  (id, run_id, step_id, step_type, action, status, completed_at, duration_ms)
                VALUES ($1, $2, $3, 'task', $4, 'succeeded', now(), $5)
                ON CONFLICT (id) DO NOTHING
                """,
                record_id, run_id, step_id, action, duration_ms,
            )
        finally:
            await conn.close()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Activity definition
# ---------------------------------------------------------------------------

@activity.defn
async def run_builtin_task_activity(inp: TaskActivityInput) -> TaskActivityOutput:
    _t0 = time.monotonic()
    action_fn = _ACTIONS.get(inp.action)
    if action_fn is None:
        raise ValueError(f"Unknown builtin action: '{inp.action}'")

    import inspect
    if inspect.iscoroutinefunction(action_fn):
        result = await action_fn(inp.resolved_input, inp.resolved_params)
    else:
        result = action_fn(inp.resolved_input, inp.resolved_params)

    duration_ms = (time.monotonic() - _t0) * 1000.0

    await _write_step_record(inp.run_id, inp.step_id, inp.action, duration_ms)

    activity.logger.info(
        "run_builtin_task_activity complete",
        extra={"step_id": inp.step_id, "action": inp.action, "duration_ms": duration_ms},
    )

    return TaskActivityOutput(
        step_id=inp.step_id,
        output=result,
        duration_ms=duration_ms,
    )
