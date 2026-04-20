"""
Unit tests for builtin_tasks.py action functions.

These tests import the private action functions directly — no Temporal dependency.
"""
import json
import pytest
from unittest.mock import patch, AsyncMock, MagicMock

from tanzen_worker.builtin_tasks import (
    _filter,
    _sort,
    _slice,
    _deduplicate,
    _flatten,
    _map,
    _extract_fields,
    _parse_csv,
    _parse_json,
    _format_json,
    _template,
    _http_request,
)

# ---------------------------------------------------------------------------
# filter
# ---------------------------------------------------------------------------

class TestFilter:
    def test_basic(self):
        data = [{"status": "active", "id": 1}, {"status": "inactive", "id": 2}]
        result = _filter(data, {"field": "status", "value": "active"})
        assert result == [{"status": "active", "id": 1}]

    def test_empty_list(self):
        assert _filter([], {"field": "x", "value": "y"}) == []

    def test_non_list_passthrough(self):
        assert _filter("string", {"field": "x", "value": "y"}) == "string"

    def test_no_matches(self):
        data = [{"status": "active"}]
        assert _filter(data, {"field": "status", "value": "inactive"}) == []


# ---------------------------------------------------------------------------
# sort
# ---------------------------------------------------------------------------

class TestSort:
    def test_asc(self):
        data = [{"n": 3}, {"n": 1}, {"n": 2}]
        assert _sort(data, {"field": "n", "order": "asc"}) == [{"n": 1}, {"n": 2}, {"n": 3}]

    def test_desc(self):
        data = [{"n": 3}, {"n": 1}, {"n": 2}]
        assert _sort(data, {"field": "n", "order": "desc"}) == [{"n": 3}, {"n": 2}, {"n": 1}]

    def test_default_order_is_asc(self):
        data = [{"n": 2}, {"n": 1}]
        assert _sort(data, {"field": "n"}) == [{"n": 1}, {"n": 2}]

    def test_non_list_passthrough(self):
        assert _sort(42, {"field": "n"}) == 42


# ---------------------------------------------------------------------------
# slice
# ---------------------------------------------------------------------------

class TestSlice:
    def test_offset_and_limit(self):
        data = list(range(10))
        assert _slice(data, {"offset": 2, "limit": 3}) == [2, 3, 4]

    def test_offset_only(self):
        assert _slice([1, 2, 3, 4], {"offset": 2}) == [3, 4]

    def test_no_params(self):
        assert _slice([1, 2, 3], {"offset": 0}) == [1, 2, 3]

    def test_non_list_passthrough(self):
        assert _slice("x", {"offset": 0, "limit": 1}) == "x"


# ---------------------------------------------------------------------------
# deduplicate
# ---------------------------------------------------------------------------

class TestDeduplicate:
    def test_by_key(self):
        data = [{"id": 1, "v": "a"}, {"id": 1, "v": "b"}, {"id": 2, "v": "c"}]
        result = _deduplicate(data, {"key": "id"})
        assert len(result) == 2
        assert result[0]["id"] == 1
        assert result[1]["id"] == 2

    def test_no_key(self):
        data = [1, 2, 1, 3]
        assert _deduplicate(data, {}) == [1, 2, 3]

    def test_empty(self):
        assert _deduplicate([], {"key": "id"}) == []

    def test_non_list_passthrough(self):
        assert _deduplicate("x", {}) == "x"


# ---------------------------------------------------------------------------
# flatten
# ---------------------------------------------------------------------------

class TestFlatten:
    def test_flat(self):
        assert _flatten([[1, 2], [3, 4]], {}) == [1, 2, 3, 4]

    def test_mixed(self):
        assert _flatten([[1, 2], 3, [4]], {}) == [1, 2, 3, 4]

    def test_already_flat(self):
        assert _flatten([1, 2, 3], {}) == [1, 2, 3]

    def test_non_list_passthrough(self):
        assert _flatten("x", {}) == "x"


# ---------------------------------------------------------------------------
# map
# ---------------------------------------------------------------------------

class TestMap:
    def test_basic_projection(self):
        data = [{"old_key": "value", "other": "x"}]
        result = _map(data, {"mapping": {"new_key": "old_key"}})
        assert result == [{"new_key": "value"}]

    def test_empty(self):
        assert _map([], {"mapping": {"a": "b"}}) == []

    def test_missing_key_gives_none(self):
        data = [{"x": 1}]
        result = _map(data, {"mapping": {"y": "missing"}})
        assert result == [{"y": None}]


# ---------------------------------------------------------------------------
# extract_fields
# ---------------------------------------------------------------------------

class TestExtractFields:
    def test_dict(self):
        data = {"a": 1, "b": 2, "c": 3}
        assert _extract_fields(data, {"fields": ["a", "c"]}) == {"a": 1, "c": 3}

    def test_list_of_dicts(self):
        data = [{"a": 1, "b": 2}, {"a": 3, "b": 4}]
        result = _extract_fields(data, {"fields": ["a"]})
        assert result == [{"a": 1}, {"a": 3}]

    def test_empty_fields(self):
        assert _extract_fields({"a": 1}, {"fields": []}) == {}


# ---------------------------------------------------------------------------
# parse_csv
# ---------------------------------------------------------------------------

class TestParseCsv:
    def test_basic(self):
        csv_text = "name,age\nAlice,30\nBob,25"
        result = _parse_csv(csv_text, {})
        assert result == [{"name": "Alice", "age": "30"}, {"name": "Bob", "age": "25"}]

    def test_custom_delimiter(self):
        csv_text = "name;age\nAlice;30"
        result = _parse_csv(csv_text, {"delimiter": ";"})
        assert result == [{"name": "Alice", "age": "30"}]

    def test_empty(self):
        assert _parse_csv("", {}) == []


# ---------------------------------------------------------------------------
# parse_json
# ---------------------------------------------------------------------------

class TestParseJson:
    def test_object(self):
        assert _parse_json('{"a": 1}', {}) == {"a": 1}

    def test_array(self):
        assert _parse_json("[1, 2, 3]", {}) == [1, 2, 3]

    def test_invalid_raises(self):
        with pytest.raises(Exception):
            _parse_json("not json", {})


# ---------------------------------------------------------------------------
# format_json
# ---------------------------------------------------------------------------

class TestFormatJson:
    def test_basic(self):
        result = _format_json({"a": 1}, {"indent": 2})
        assert result == '{\n  "a": 1\n}'

    def test_default_indent(self):
        result = _format_json({"a": 1}, {})
        parsed = json.loads(result)
        assert parsed == {"a": 1}


# ---------------------------------------------------------------------------
# template
# ---------------------------------------------------------------------------

class TestTemplate:
    def test_basic_render(self):
        result = _template({"name": "Alice"}, {"template": "Hello, {{ name }}!"})
        assert result == "Hello, Alice!"

    def test_missing_var_renders_empty(self):
        result = _template({}, {"template": "Hello, {{ name }}!"})
        assert "Hello," in result

    def test_data_not_dict(self):
        result = _template("ignored", {"template": "Hello"})
        assert result == "Hello"


# ---------------------------------------------------------------------------
# http_request (mocked)
# ---------------------------------------------------------------------------

class TestHttpRequest:
    @pytest.mark.asyncio
    async def test_get_request(self):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = '{"ok": true}'
        mock_response.headers = {"content-type": "application/json"}

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.request = AsyncMock(return_value=mock_response)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await _http_request(None, {"url": "http://example.com", "method": "GET"})

        assert result["status_code"] == 200
        assert result["body"] == '{"ok": true}'

    @pytest.mark.asyncio
    async def test_post_with_body(self):
        mock_response = MagicMock()
        mock_response.status_code = 201
        mock_response.text = "created"
        mock_response.headers = {}

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.request = AsyncMock(return_value=mock_response)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await _http_request(
                None, {"url": "http://example.com", "method": "POST", "body": {"key": "value"}}
            )

        assert result["status_code"] == 201
        call_kwargs = mock_client.request.call_args
        assert call_kwargs.kwargs["json"] == {"key": "value"}
