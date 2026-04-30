# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Tanzen

Agent Workflow Orchestration Platform for critical knowledge-work automation. Multi-component monorepo with an open-core architecture: an OSS core designed to be extended by commercial builds without forking.

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
bun run dev      # dev server on :3000 (reads server/.env automatically)
bun run build    # compile to dist/
bun run typecheck
bun test         # run tests
```

**First-time and after credential rotation** — the server needs credentials pulled from
the cluster. `dev-env.sh` writes `server/.env` (gitignored) and ensures all required
port-forwards are active:

```bash
./infra/scripts/dev-env.sh               # uses namespace tanzen-dev by default
./infra/scripts/dev-env.sh --namespace my-ns   # custom namespace

# If port-forwards are already running (e.g. managed externally):
./infra/scripts/dev-env.sh --no-portforward

# Then start the server:
cd server && bun run dev
```

`dev-env.sh` manages port-forwards for Postgres (:5432), SeaweedFS (:8333),
Redis (:6379), and Temporal (:7233), and also starts `kubectl proxy` on :8001.
It is idempotent — re-running it refreshes `server/.env` without restarting
already-bound port-forwards.

`kubectl proxy` is required for the Secrets and MCP-servers pages. Bun's native
fetch ignores custom HTTPS agents, so `@kubernetes/client-node`'s `skipTLSVerify`
flag has no effect. Routing k8s calls through `kubectl proxy` (plain HTTP on
localhost) bypasses this entirely and is unaffected by cluster cert rotation.

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

# Talos/KVM cluster (uses custom schema job, disables sub-chart schema jobs)
./infra/scripts/bootstrap.sh --namespace tanzen-dev --talos

# Health check
./infra/scripts/smoke-test.sh --namespace tanzen-dev

# Port-forward services during development
kubectl port-forward -n tanzen-dev svc/temporal-web 8080:8080
kubectl port-forward -n tanzen-dev svc/seaweedfs-filer 8333:8333
```

### Talos profile (`tanzenctl up --profile talos --remote-workers tanzen0`)

Provisions a full Talos v1.12.6 cluster (1 CP + 2 workers) as KVM VMs on tanzen0.
All nodes are on `10.17.5.0/24`. The controller holds VIP `10.17.5.9`.

**One-time Mac setup** (survives reboots; add to shell profile or run after boot):
```bash
sudo route add -net 10.17.5.0/24 192.168.1.127   # route to tanzen0's KVM subnet
```

**Restore iptables on tanzen0 after reboot** (libvirt resets its chains on restart;
this rule lets the Mac's LAN reach cluster VMs):
```bash
ssh tanzen0 "sudo iptables -C LIBVIRT_FWI -s 192.168.1.0/24 -d 10.17.5.0/24 -j ACCEPT 2>/dev/null || \
  sudo iptables -I LIBVIRT_FWI 1 -s 192.168.1.0/24 -d 10.17.5.0/24 -j ACCEPT"
```

**Make the iptables rule persistent on tanzen0**:
```bash
ssh tanzen0 "sudo apt-get install -y iptables-persistent && sudo netfilter-persistent save"
```

**kubeconfig**: `~/.kube/config` on tanzen1 points to `https://10.17.5.9:6443` (context: `tanzen`).
The route must be active for `kubectl` to work.

**Destroy cluster**:
```bash
ssh tanzen0 "cd ~/dev/tanzen/infra/talos/terraform && terraform destroy -auto-approve"
```

### Code execution

Scripts and agent code execution run in sandboxed Deno subprocesses inside the worker pod.

**Python scripts** use `infra/executor/pyodide_runner.ts` (Pyodide WASM in a Deno V8 isolate).
In dev, it runs via `deno run`. For production, compile it once:
```bash
cd infra/executor
deno compile --no-remote --allow-read --allow-write=/tmp \
  --output pyodide_runner pyodide_runner.ts
# Set PYODIDE_RUNNER_PATH=/path/to/pyodide_runner on the worker pod
```

**Feature flags** are in the `settings` DB table. Toggle via the Settings page or API:
```bash
# Enable agent code execution
curl -X PATCH http://localhost:3000/api/settings \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_code_execution_enabled": true}'
```

**Cilium NetworkPolicies** are deployed by the Helm chart when `networkPolicies.enabled=true`.
They work on both kind-tanzen and talos (Cilium installed on both). Disabled by default.
```bash
helm upgrade tanzen ./infra/charts/tanzen -n tanzen-dev --set networkPolicies.enabled=true
```

**Execution checkpoints** are written to S3 at `snapshots/{run_id}/{step_id}/checkpoint.json`
after every script step. The replay API re-runs any step with its original inputs:
```bash
GET  /api/runs/:id/snapshots
POST /api/runs/:id/steps/:stepId/replay
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
