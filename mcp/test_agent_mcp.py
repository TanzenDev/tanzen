"""
Layer 2 MCP smoke test — PydanticAI agent invocation.

Each test creates a PydanticAI agent wired to a port-forwarded MCP server
and uses a prompt engineered to force tool use.  It then inspects
result.all_messages() and asserts at least one ToolCallPart appears.

Pre-requisites:
  tanzenctl forward --mcp     # port-forwards 8081/8082/8083
  GROQ_API_KEY=...            # or any provider key the model needs

Run:
  python mcp/test_agent_mcp.py
"""
import asyncio
import os
import sys

from pydantic_ai import Agent
from pydantic_ai.messages import ToolCallPart
try:
    from pydantic_ai.mcp import MCPServerStreamableHTTP as _MCPServer
except ImportError:
    try:
        from pydantic_ai.mcp import MCPServerHTTP as _MCPServer  # type: ignore[no-redef]
    except ImportError:
        from pydantic_ai.mcp import MCPServerSSE as _MCPServer  # type: ignore[no-redef]


# ── Test targets ──────────────────────────────────────────────────────────────

MODEL = os.environ.get("TANZEN_TEST_MODEL", "groq:llama-3.3-70b-versatile")

TESTS = [
    {
        "name": "sequential-thinking",
        "url": "http://localhost:8081/mcp",
        "prompt": (
            "Use the sequentialthinking tool to plan exactly three steps to bake bread. "
            "Call the tool once per step with thoughtNumber 1, 2, and 3."
        ),
    },
    {
        "name": "fetch",
        "url": "http://localhost:8082/mcp",
        "prompt": (
            "Use the fetch_html tool to retrieve https://example.com "
            "and summarise what the page says in one sentence."
        ),
    },
    {
        "name": "falkordb",
        "url": "http://localhost:8083/mcp",
        "prompt": (
            "Use the list_graphs tool to show all graph databases available."
        ),
    },
]


# ── Runner ────────────────────────────────────────────────────────────────────

async def run_test(name: str, url: str, prompt: str) -> bool:
    print(f"\n{'─' * 60}")
    print(f"  Testing: {name}")
    print(f"  MCP URL: {url}")
    print(f"  Prompt:  {prompt[:80]}…")
    print(f"{'─' * 60}")

    mcp_server = _MCPServer(url=url)
    agent = Agent(MODEL, toolsets=[mcp_server])

    try:
        async with agent.run_mcp_servers():
            result = await agent.run(prompt)
    except BaseException as exc:
        # Unwrap ExceptionGroup (Python 3.11+) or report directly
        if hasattr(exc, "exceptions"):
            for sub in exc.exceptions:  # type: ignore[attr-defined]
                print(f"  FAIL — sub-exception: {type(sub).__name__}: {sub}")
        else:
            print(f"  FAIL — agent raised: {type(exc).__name__}: {exc}")
        return False

    # Inspect message history for at least one ToolCallPart
    tool_calls = []
    for msg in result.all_messages():
        for part in getattr(msg, "parts", []):
            if isinstance(part, ToolCallPart):
                tool_calls.append(part.tool_name)

    if tool_calls:
        print(f"  PASS — tool calls observed: {tool_calls}")
        return True
    else:
        print("  FAIL — no ToolCallPart found in message history")
        print("         (LLM may have answered without calling the tool)")
        return False


async def main() -> None:
    target = sys.argv[1] if len(sys.argv) > 1 else "all"
    tests = [t for t in TESTS if target == "all" or t["name"] == target]
    if not tests:
        print(f"Unknown test target: {target!r}. Available: all, {', '.join(t['name'] for t in TESTS)}")
        sys.exit(1)

    results = []
    for t in tests:
        ok = await run_test(t["name"], t["url"], t["prompt"])
        results.append((t["name"], ok))

    print(f"\n{'═' * 60}")
    print("  Results:")
    all_passed = True
    for name, ok in results:
        status = "PASS" if ok else "FAIL"
        icon = "✓" if ok else "✗"
        print(f"    {icon}  {name}: {status}")
        if not ok:
            all_passed = False
    print(f"{'═' * 60}")

    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    asyncio.run(main())
