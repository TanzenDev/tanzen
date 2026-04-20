"""
AgentConfig — describes a versioned agent definition.

Stored in SeaweedFS bucket `agents` at key `{agentId}/{version}.json`.
Loaded by run_agent_activity before each invocation.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any


@dataclass
class MCPToolConfig:
    """An MCP server that provides tools to this agent."""
    url: str                        # HTTP MCP server URL
    tool_filter: list[str] = field(default_factory=list)  # empty = all tools


@dataclass
class AgentConfig:
    id: str
    version: str
    model: str                      # e.g. "anthropic:claude-haiku-4-5-20251001"
    system_prompt: str
    mcp_servers: list[MCPToolConfig] = field(default_factory=list)
    secrets: list[str] = field(default_factory=list)   # env var names to resolve
    max_tokens: int = 4096
    temperature: float = 0.1
    retries: int = 1

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "AgentConfig":
        mcp = [MCPToolConfig(**m) for m in d.get("mcp_servers", [])]
        return cls(
            id=d["id"],
            version=d["version"],
            model=d["model"],
            system_prompt=d["system_prompt"],
            mcp_servers=mcp,
            secrets=d.get("secrets", []),
            max_tokens=d.get("max_tokens", 4096),
            temperature=d.get("temperature", 0.1),
            retries=d.get("retries", 1),
        )

    def resolve_secrets(self) -> dict[str, str]:
        """Return a mapping of secret-name → env-var value for this agent's secrets."""
        resolved: dict[str, str] = {}
        for name in self.secrets:
            val = os.environ.get(name)
            if val is not None:
                resolved[name] = val
        return resolved


def load_agent_config_from_dict(raw: dict[str, Any]) -> AgentConfig:
    return AgentConfig.from_dict(raw)


def load_agent_config_from_s3(s3_client: Any, bucket: str, agent_id: str, version: str) -> AgentConfig:
    key = f"{agent_id}/{version}.json"
    obj = s3_client.get_object(Bucket=bucket, Key=key)
    raw = json.loads(obj["Body"].read())
    return AgentConfig.from_dict(raw)
