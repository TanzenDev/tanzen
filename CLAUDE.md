# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Tanzen

Agent Workflow Orchestration Platform for regulated knowledge-work automation. Multi-component monorepo with an open-core architecture: an OSS core designed to be extended by commercial builds without forking.

## Repository layout

| Directory | Language | Description |
|-----------|----------|-------------|
| `app/` | TypeScript/React | Frontend SPA — also published as `@tanzen/app-core` npm package |
| `server/` | TypeScript/Bun | Hono API server — also published as `@tanzen/server-core` npm package |
| `worker/` | Python | Temporal dynamic workflow worker — published as `tanzen-worker` PyPI package |
| `cli/` | Go | Two binaries: `tanzen` (user CLI) and `tanzenctl` (admin CLI) |
| `mcp/` | Node.js | MCP servers (falkordb, fetch, sequential-thinking) |
| `infra/` | Helm/Shell | Kubernetes deployment (kind + KEDA + CloudNativePG + SeaweedFS + Temporal) |
| `docs/` | Markdown | Design docs, DSL reference, API reference |

## Commands

### App (`app/`)

```bash
cd app
npm install
npm run dev          # dev server on :5173, proxies /api → :3002
npm run build        # production SPA build → dist/
npm run build:lib    # library build → dist-lib/ (for npm publish)
npm run lint
npx vitest           # run all tests
npx vitest run src/extensions/registry.test.tsx   # single test file
```

### Server (`server/`)

```bash
cd server
bun install
bun run src/server/index.ts   # dev server on $PORT (default 3000)
bun run build                 # compile to dist/
bun run typecheck
bun test                      # run tests
```

### Worker (`worker/`)

```bash
cd worker
uv sync
uv run tanzen-worker          # start the Temporal worker
uv run pytest                 # run all tests (requires k8s port-forward, see below)
uv run pytest tests/test_builtin_tasks.py   # single test file
uv run pytest tests/test_agent_activity.py::test_agent_runs_and_writes_artifact  # single test
```

Integration tests port-forward SeaweedFS automatically via kubectl. The cluster must be running (`./infra/scripts/bootstrap.sh`).

### CLI (`cli/`)

```bash
cd cli
make              # build both binaries → cli/bin/
make dev          # build + install to ~/go/bin
make install      # build + install to /usr/local/bin
```

### Infrastructure

```bash
# First time: create kind cluster + deploy everything
./infra/scripts/bootstrap.sh --new-cluster --cluster tanzen-dev --namespace tanzen-dev

# Existing cluster
./infra/scripts/bootstrap.sh --namespace tanzen-dev

# Health check
./infra/scripts/smoke-test.sh --namespace tanzen-dev

# Port-forward services during development
kubectl port-forward -n tanzen-dev svc/temporal-web 8080:8080
kubectl port-forward -n tanzen-dev svc/seaweedfs-filer 8333:8333
```

## Architecture

### Data / control flow

```
User → React app → Hono API server → Temporal (starts DynamicWorkflow)
                                               ↓
                              Python worker polls Temporal task queue
                                               ↓
                              DynamicWorkflow interprets JSON IR step-by-step
                              Each step → activity (agent / gate / task / script)
                                               ↓
                              Artifacts stored in SeaweedFS (S3-compatible)
                              Events published to Redis pub/sub → SSE stream
                              Status written to Postgres
```

### DSL Compiler (server-side, TypeScript)

`server/src/compiler/` is a hand-written recursive descent compiler with four passes:

1. `lexer.ts` — tokenises Tanzen DSL source
2. `parser.ts` — produces a `WorkflowNode` AST
3. `semantic.ts` — validates references, types, and constraints
4. `emitter.ts` — converts validated AST to JSON IR

The JSON IR is the contract between the server and the Python worker. The compiler runs inside the Hono server on every `POST /api/workflows` and `POST /api/workflows/:id/compile`. See `docs/dsl-reference.md` for the full grammar and IR format.

### Dynamic Workflow (Python Temporal worker)

`worker/src/tanzen_worker/workflow.py` — a single `@workflow.defn` class (`DynamicWorkflow`) that receives a JSON IR document and executes it step by step. Step types: `agent`, `gate`, `task`, `script`, `parallel` (static fan-out or `forEach` dynamic fan-out).

Gate steps use Temporal signals: the workflow opens a gate (writes to Postgres, publishes event), then `wait_condition` blocks until the API server sends a `gate_resolution` signal (after a reviewer acts via the UI).

Custom step types are registered via `register_step_handler(step_type, handler)` — this is the commercial extension point.

### Extension / open-core seams

Each layer has a documented extension point for commercial builds:

| Layer | Extension mechanism |
|-------|---------------------|
| Server | `registerPlugin(TanzenPlugin)` in `server/src/server/index.ts` |
| Worker step types | `register_step_handler()` in `workflow.py` |
| Worker activities | `TANZEN_WORKER_EXTENSIONS` env var or `tanzen.worker.extensions` entry points |
| App routes/nav/UI slots | `registerExtension(AppExtension)` in `app/src/extensions/registry.tsx` |
| App UI slots | `useSlot(name)` hook — returns `null` in OSS; commercial fills named slots |
| CLI commands | `tanzenctl-*` binary discovery from PATH |

### API Server (`server/src/server/`)

Hono on Bun. All `/api/*` routes require Clerk JWT auth. Structure:

- `index.ts` — app setup, plugin registry, startup sequence (plugin migrations → core migrations → `ensureBuckets()` → plugin startup hooks)
- `auth.ts` — `authMiddleware` (Clerk), `AuthProvider` interface for commercial override
- `db.ts` — Postgres client + migration runner
- `s3.ts` — SeaweedFS/S3 client + bucket provisioning
- `redis.ts` — ioredis client for pub/sub
- `temporal.ts` — Temporal client
- `routes/` — one file per resource (workflows, agents, runs, gates, secrets, scripts, metrics, mcp-servers, events)

### React App (`app/src/`)

Vite + React 19 + Tailwind v4 + React Query + React Router v7 + Radix UI. The app is also published as a library (`@tanzen/app-core`) — `src/index.ts` is the library surface, `src/main.tsx` is the SPA entrypoint.

- `api/client.ts` — typed fetch wrappers + SSE `RunEvent` stream
- `api/hooks.ts` — React Query hooks (`useRun`, `useWorkflowDsl`)
- `extensions/registry.tsx` — `ExtensionProvider`, `registerExtension`, `useSlot` (open-core slot system)
- `components/WorkflowCanvas.tsx` — React Flow canvas; exports `WorkflowIR` types and `irToGraph`
- `pages/` — one file per route

Tests use Vitest + jsdom + Testing Library. Config is in `vite.config.ts` (`test.environment: "jsdom"`).

### Infrastructure

Kubernetes-based. Kind cluster for local dev. Key dependencies managed via Helm:

- **Temporal** — workflow orchestration
- **CloudNativePG** — Postgres operator
- **SeaweedFS** — S3-compatible artifact storage (master + volume + filer)
- **KEDA** — autoscaling for the worker deployment
- **kube-prometheus-stack** — Prometheus + Grafana
- **Redis** — pub/sub for SSE event streaming
