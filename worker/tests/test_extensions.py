"""
Tests for Phase 1 worker extension points:
  - _load_extensions() loads activities and workflows from env var modules
  - _load_extensions() registers step_handlers declared by extension modules
  - register_step_handler() adds custom step types to the dispatch table
  - Unknown step types raise ValueError
  - _load_extensions() silently skips missing modules (ImportError)
"""
from __future__ import annotations

import os
import sys
import types
from typing import Any
from unittest.mock import AsyncMock, patch, MagicMock

import pytest

from tanzen_worker.workflow import register_step_handler, _step_handlers, DynamicWorkflow
from tanzen_worker.state import RunState


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_fake_module(name: str, **attrs) -> types.ModuleType:
    """Create an in-memory module with given attributes."""
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod
    return mod


# ---------------------------------------------------------------------------
# register_step_handler / dispatch table
# ---------------------------------------------------------------------------

class TestStepHandlerRegistry:
    def test_registered_handler_is_stored(self):
        async def my_handler(self, run_id, step, state):
            return {"done": True}

        register_step_handler("test-type-123", my_handler)
        assert "test-type-123" in _step_handlers
        assert _step_handlers["test-type-123"] is my_handler

    def test_handler_can_be_overwritten(self):
        async def v1(self, run_id, step, state): return 1
        async def v2(self, run_id, step, state): return 2

        register_step_handler("overwrite-me", v1)
        register_step_handler("overwrite-me", v2)
        assert _step_handlers["overwrite-me"] is v2

    @pytest.mark.asyncio
    async def test_unknown_step_type_raises_value_error(self):
        """The workflow should raise ValueError for unrecognised step types."""
        wf = DynamicWorkflow()
        state = RunState(params={})

        ir = {"steps": [{"type": "definitely-not-registered-xyz", "id": "s1"}]}

        with pytest.raises(ValueError, match="Unknown step type"):
            # We can't run a real Temporal workflow in unit tests, so we call
            # _execute directly.  It reads _step_handlers at call time.
            await wf._execute("run-1", ir, state)

    @pytest.mark.asyncio
    async def test_registered_custom_step_is_called(self):
        """A step type registered via register_step_handler() should be dispatched."""
        called_with: list = []

        async def custom_handler(self, run_id, step, state):
            called_with.append((run_id, step["id"]))
            return {"custom": True}

        register_step_handler("custom-step-test", custom_handler)

        wf = DynamicWorkflow()
        state = RunState(params={})
        ir = {"steps": [{"type": "custom-step-test", "id": "my-step"}]}

        await wf._execute("run-42", ir, state)

        assert called_with == [("run-42", "my-step")]
        assert state.outputs["my-step"] == {"custom": True}


# ---------------------------------------------------------------------------
# _load_extensions()
# ---------------------------------------------------------------------------

class TestLoadExtensions:
    def setup_method(self):
        # Remove any stale test modules from sys.modules
        for key in list(sys.modules.keys()):
            if key.startswith("_test_ext_"):
                del sys.modules[key]

    def test_loads_activities_from_module(self):
        from tanzen_worker.worker import _load_extensions

        async def fake_activity(): pass

        _make_fake_module("_test_ext_acts", activities=[fake_activity])

        with patch.dict(os.environ, {"TANZEN_WORKER_EXTENSIONS": "_test_ext_acts"}):
            extra_acts, extra_wfs = _load_extensions()

        assert fake_activity in extra_acts
        assert extra_wfs == []

    def test_loads_workflows_from_module(self):
        from tanzen_worker.worker import _load_extensions

        class FakeWorkflow: pass

        _make_fake_module("_test_ext_wfs", workflows=[FakeWorkflow])

        with patch.dict(os.environ, {"TANZEN_WORKER_EXTENSIONS": "_test_ext_wfs"}):
            extra_acts, extra_wfs = _load_extensions()

        assert FakeWorkflow in extra_wfs

    def test_registers_step_handlers_from_module(self):
        from tanzen_worker.worker import _load_extensions

        async def my_step(self, run_id, step, state): return {}

        _make_fake_module("_test_ext_steps", step_handlers={"my-custom": my_step})

        with patch.dict(os.environ, {"TANZEN_WORKER_EXTENSIONS": "_test_ext_steps"}):
            _load_extensions()

        assert _step_handlers.get("my-custom") is my_step

    def test_skips_missing_module_gracefully(self, capsys):
        from tanzen_worker.worker import _load_extensions

        with patch.dict(os.environ, {"TANZEN_WORKER_EXTENSIONS": "_test_ext_does_not_exist_xyz"}):
            extra_acts, extra_wfs = _load_extensions()

        assert extra_acts == []
        assert extra_wfs == []
        captured = capsys.readouterr()
        assert "not found" in captured.out.lower() or "skipping" in captured.out.lower()

    def test_empty_env_var_returns_empty_lists(self):
        from tanzen_worker.worker import _load_extensions

        with patch.dict(os.environ, {"TANZEN_WORKER_EXTENSIONS": ""}):
            extra_acts, extra_wfs = _load_extensions()

        assert extra_acts == []
        assert extra_wfs == []

    def test_multiple_modules_comma_separated(self):
        from tanzen_worker.worker import _load_extensions

        async def act_a(): pass
        async def act_b(): pass

        _make_fake_module("_test_ext_multi_a", activities=[act_a])
        _make_fake_module("_test_ext_multi_b", activities=[act_b])

        with patch.dict(os.environ, {"TANZEN_WORKER_EXTENSIONS": "_test_ext_multi_a,_test_ext_multi_b"}):
            extra_acts, _ = _load_extensions()

        assert act_a in extra_acts
        assert act_b in extra_acts

    def test_whitespace_in_module_list_is_trimmed(self):
        from tanzen_worker.worker import _load_extensions

        async def act_ws(): pass
        _make_fake_module("_test_ext_ws", activities=[act_ws])

        with patch.dict(os.environ, {"TANZEN_WORKER_EXTENSIONS": "  _test_ext_ws  "}):
            extra_acts, _ = _load_extensions()

        assert act_ws in extra_acts
