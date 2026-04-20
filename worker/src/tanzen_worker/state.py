"""
RunState — holds resolved params and step outputs during a workflow run.
Provides helpers for resolving $ref values and evaluating 'when' conditions.
"""
from __future__ import annotations
from typing import Any


class RunState:
    def __init__(self, params: dict[str, Any]) -> None:
        self.params = params
        self.outputs: dict[str, Any] = {}

    # ------------------------------------------------------------------
    # Ref resolution: $ref strings like "run.input", "params.x", "step.output"
    # ------------------------------------------------------------------

    def resolve(self, value: Any) -> Any:
        """Recursively resolve $ref values in any IR value."""
        if isinstance(value, dict):
            if "$ref" in value:
                return self._resolve_ref(value["$ref"])
            return {k: self.resolve(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self.resolve(v) for v in value]
        if isinstance(value, str) and "${" in value:
            return self._resolve_template(value)
        return value

    def _resolve_ref(self, path: str) -> Any:
        parts = path.split(".", 1)
        root = parts[0]
        rest = parts[1] if len(parts) > 1 else None

        if root == "run":
            if rest == "input":
                return self.params.get("__input__")
            return self.params.get(rest) if rest else self.params

        if root == "params":
            if rest is None:
                return self.params
            return self.params.get(rest)

        # step output: stepId.output, stepId.approved, etc.
        step_out = self.outputs.get(root)
        if step_out is None:
            return None
        if rest is None:
            return step_out
        if isinstance(step_out, dict):
            return step_out.get(rest)
        return step_out

    def _resolve_template(self, template: str) -> str:
        """Resolve ${varName} placeholders in a template string."""
        import re
        def replacer(m: re.Match) -> str:
            path = m.group(1)
            resolved = self._resolve_ref(path)
            return str(resolved) if resolved is not None else m.group(0)
        return re.sub(r"\$\{([^}]+)\}", replacer, template)

    # ------------------------------------------------------------------
    # Condition evaluation: 'when' ref must resolve to truthy
    # ------------------------------------------------------------------

    def evaluate_condition(self, when: dict[str, str] | None) -> bool:
        if when is None:
            return True
        resolved = self.resolve(when)
        return bool(resolved)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def set_output(self, step_id: str, value: Any) -> None:
        if step_id:  # anonymous forEach template steps have empty id
            self.outputs[step_id] = value
