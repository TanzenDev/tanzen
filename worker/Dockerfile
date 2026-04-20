FROM python:3.12-slim

WORKDIR /app

# Install Deno (pinned) for running custom script activities
ENV DENO_VERSION=2.3.3
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && curl -fsSL "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" \
       -o /tmp/deno.zip \
    && unzip /tmp/deno.zip -d /usr/local/bin \
    && rm /tmp/deno.zip \
    && chmod +x /usr/local/bin/deno \
    && apt-get purge -y curl unzip \
    && rm -rf /var/lib/apt/lists/*

# Install uv for fast dependency installation
RUN pip install --no-cache-dir uv

# Copy dependency files first for layer caching
COPY pyproject.toml uv.lock ./

# Install dependencies into the system Python (no venv needed in container)
RUN uv sync --no-dev --no-install-project

# Copy source
COPY src/ ./src/

# Install the package itself
RUN uv sync --no-dev

ENV PYTHONUNBUFFERED=1

ENTRYPOINT ["uv", "run", "tanzen-worker"]
