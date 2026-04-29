FROM python:3.12-slim

# Install git and uv (Graphiti MCP server uses uv, not pip)
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates \
    && curl -LsSf https://astral.sh/uv/install.sh | sh \
    && apt-get purge -y curl \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.local/bin:$PATH"

WORKDIR /app

# Clone only the mcp_server subdirectory (sparse checkout)
RUN git clone --filter=blob:none --sparse https://github.com/getzep/graphiti.git . \
    && git sparse-checkout set mcp_server \
    && mv mcp_server/* . \
    && rm -rf mcp_server .git

# Install dependencies
RUN uv sync

EXPOSE 8000

# ── Graph backend ─────────────────────────────────────────────────────────────
# FalkorDB (preferred — already deployed in the Tanzen infra):
#   DATABASE_PROVIDER=falkordb
#   FALKORDB_HOST=falkordb-db
#   FALKORDB_PORT=6379
#
# Neo4j (alternative):
#   DATABASE_PROVIDER=neo4j
#   NEO4J_URI=bolt://neo4j:7687  NEO4J_USER=neo4j  NEO4J_PASSWORD=<pw>
#
# ── LLM (entity extraction) ──────────────────────────────────────────────────
#   OPENAI_API_KEY=<key>   required
#   MODEL_NAME=gpt-4o-mini optional
#
# Note: Graphiti requires an OpenAI-compatible API key.
# Native Google Gemini support is present in graphiti-core's config schema but
# has bugs in the embedder (uses batchEmbedContents which Google's API doesn't
# support for current embedding models). Enable Gemini when graphiti-core fixes
# this upstream.
#
# ── Namespace ─────────────────────────────────────────────────────────────────
#   GROUP_ID=tanzen

ENV DATABASE_PROVIDER=falkordb \
    FALKORDB_HOST=falkordb-db \
    FALKORDB_PORT=6379 \
    GROUP_ID=tanzen \
    TRANSPORT=http \
    PORT=8000

CMD ["uv", "run", "main.py", "--transport", "http", "--port", "8000"]
