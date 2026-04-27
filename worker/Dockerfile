FROM python:3.12-slim

WORKDIR /app

# Install Deno (pinned) — selects aarch64 or x86_64 binary based on build platform
ENV DENO_VERSION=2.3.3
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && DENO_ARCH=$([ "$(uname -m)" = "aarch64" ] && echo "aarch64" || echo "x86_64") \
    && curl -fsSL "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-${DENO_ARCH}-unknown-linux-gnu.zip" \
       -o /tmp/deno.zip \
    && unzip /tmp/deno.zip -d /usr/local/bin \
    && rm /tmp/deno.zip \
    && chmod +x /usr/local/bin/deno \
    && apt-get purge -y curl unzip \
    && rm -rf /var/lib/apt/lists/*

# Install uv for fast dependency installation
RUN pip install --no-cache-dir uv

# Copy dependency files first for layer caching
COPY worker/pyproject.toml worker/uv.lock ./

# Install dependencies into the system Python (no venv needed in container)
RUN uv sync --no-dev --no-install-project

# Copy source (paths relative to repo root build context)
COPY worker/src/ ./src/

# Copy the Pyodide runner for Python script execution.
# Build context must be the repo root: docker build -f worker/Dockerfile .
COPY infra/executor/ ./infra/executor/

# Install the package itself
RUN uv sync --no-dev

ENV PYTHONUNBUFFERED=1
# Explicit path to the Pyodide runner (avoids broken ../../../ relative calculation)
ENV PYODIDE_RUNNER_PATH=/app/infra/executor/pyodide_runner.ts

ENTRYPOINT ["uv", "run", "tanzen-worker"]
