#!/usr/bin/env bash
# examples/load.sh — seed agents and workflows into a running Tanzen instance.
#
# Usage:
#   ./examples/load.sh                    # uses TANZEN_URL + TANZEN_TOKEN env vars
#   ./examples/load.sh --url http://...   # override API base URL
#
# The script is idempotent: re-running it will update existing agents/workflows
# rather than erroring on duplicates (server 409s are treated as updates).
#
# Requires: tanzen CLI on PATH, jq

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TANZEN="${TANZEN_CLI:-tanzen}"

if [[ "${1:-}" == "--url" && -n "${2:-}" ]]; then
  export TANZEN_URL="$2"
  shift 2
fi

# Validate CLI is available
if ! command -v "$TANZEN" &>/dev/null; then
  echo "error: 'tanzen' CLI not found. Run 'make install' in cli/ or set TANZEN_CLI." >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "error: 'jq' not found. Install it (brew install jq)." >&2
  exit 1
fi

echo "Tanzen endpoint: ${TANZEN_URL:-$(${TANZEN} config get url 2>/dev/null || echo 'not set')}"
echo

# ── Agents ────────────────────────────────────────────────────────────────────

echo "==> Loading agents"

load_agent() {
  local file="$1"
  local name model system_prompt max_tokens temperature retries
  name=$(jq -r '.name' "$file")
  model=$(jq -r '.model' "$file")
  system_prompt=$(jq -r '.system_prompt' "$file")
  max_tokens=$(jq -r '.max_tokens // 4096' "$file")
  temperature=$(jq -r '.temperature // 0.1' "$file")
  retries=$(jq -r '.retries // 1' "$file")

  # Check if agent exists
  existing_id=$(${TANZEN} agent list --output json 2>/dev/null \
    | jq -r --arg n "$name" '.items[] | select(.name == $n) | .id' 2>/dev/null || true)

  if [[ -n "$existing_id" ]]; then
    echo "  updating agent: $name ($existing_id)"
    ${TANZEN} agent update "$existing_id" \
      --model "$model" \
      --system-prompt "$system_prompt" \
      --max-tokens "$max_tokens" \
      --temperature "$temperature" \
      --retries "$retries" \
      --output json > /dev/null
  else
    echo "  creating agent: $name"
    ${TANZEN} agent create \
      --name "$name" \
      --model "$model" \
      --system-prompt "$system_prompt" \
      --max-tokens "$max_tokens" \
      --temperature "$temperature" \
      --retries "$retries" \
      --output json > /dev/null
  fi
}

for agent_file in "${SCRIPT_DIR}/agents/"*.json; do
  load_agent "$agent_file"
done

echo

# ── Workflows ─────────────────────────────────────────────────────────────────

echo "==> Loading workflows"

load_workflow() {
  local file="$1"
  # Derive workflow name from filename (strip .dsl, replace - with spaces for display)
  local filename
  filename="$(basename "$file" .dsl)"

  # Check if a workflow with the same DSL name already exists
  # The name in the DSL header is what matters; we use the filename as the --name arg
  existing_id=$(${TANZEN} workflow list --output json 2>/dev/null \
    | jq -r --arg n "$filename" '.items[] | select(.name | ascii_downcase == ($n | ascii_downcase)) | .id' 2>/dev/null | head -1 || true)

  if [[ -n "$existing_id" ]]; then
    echo "  skipping workflow: $filename (already exists as $existing_id)"
  else
    echo "  creating workflow: $filename"
    ${TANZEN} workflow create \
      --name "$filename" \
      --dsl-file "$file" \
      --output json > /dev/null
  fi
}

for wf_file in "${SCRIPT_DIR}/workflows/"*.dsl; do
  load_workflow "$wf_file"
done

echo
echo "Done. Use 'tanzen workflow list' to verify."
