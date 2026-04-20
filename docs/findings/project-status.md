# Tanzen — Project Status

**Last updated:** 2026-04-15  
**Active milestone:** Complete through M13

---

## Milestone Status

| # | Title | Status | Notes |
|---|---|---|---|
| 1 | Infrastructure baseline | ✅ Complete | All 10 smoke tests passing |
| 2 | DSL compiler v1 | ✅ Complete | 79/79 tests passing, zero type errors |
| 3 | Dynamic Temporal workflow | ✅ Complete | 7/7 integration tests passing |
| 4 | Agent activity + PydanticAI | ✅ Complete | 13/13 tests passing (TestModel + SeaweedFS) |
| 5 | API server scaffold | ✅ Complete | 100/100 tests, Hono/Bun, Clerk auth, full CRUD, Postgres schema |
| 6 | SSE event streaming | ✅ Complete | Redis pub/sub → SSE; gate count badge; 103/103 tests |
| 7 | Human review gates | ✅ Complete | Temporal signal-based blocking; approve/reject with 409 idempotency |
| 8 | React app — Build section | ✅ Complete | WorkflowsPage (Monaco + compile + run), AgentsPage, RunsPage |
| 9 | React app — Review + Config | ✅ Complete | GatesPage, MetricsPage (Recharts), SecretsPage, SettingsPage |
| 10 | Versioning | ✅ Complete | `promoted` column + promote endpoints; UI badge |
| 11 | Observability stack | ✅ Complete | OTel/Prometheus on :9464/:9465; 3 Grafana dashboards; ServiceMonitors |
| 12 | Documentation | ✅ Complete | dsl-reference.md, api-reference.yaml, helm-values.md, deployment-guide.md |
| 13 | Hardening + security review | ✅ Complete | Rate limiting, RBAC matrix, input validation; 174 server + 44 frontend tests |

---

## M1 — Infrastructure Baseline ✅

**Target namespace:** `tanzen-dev` (existing Kind cluster named `tanzen`)

### Final Pod Status

| Service | Status |
|---|---|
| Prometheus | ✅ Running |
| Grafana | ✅ Running |
| Prometheus operator | ✅ Running |
| kube-state-metrics | ✅ Running |
| Node exporter (×3) | ✅ Running |
| PostgreSQL (CNPG) | ✅ Running |
| Redis | ✅ Running |
| SeaweedFS master | ✅ Running |
| SeaweedFS volume | ✅ Running |
| SeaweedFS filer | ✅ Running |
| Temporal admintools | ✅ Running |
| Temporal web UI | ✅ Running |
| Temporal frontend | ✅ Running |
| Temporal history | ✅ Running |
| Temporal matching | ✅ Running |
| Temporal worker | ✅ Running |

### Smoke Test Results (2026-04-14)

| Test | Result |
|---|---|
| ST-01 PostgreSQL: tanzen database reachable | ✅ |
| ST-02 PostgreSQL: temporal database reachable | ✅ |
| ST-03 Temporal: cluster health SERVING | ✅ |
| ST-04 Temporal: default namespace registered | ✅ |
| ST-05 SeaweedFS: three S3 buckets exist | ✅ |
| ST-06 SeaweedFS: S3 PutObject + GetObject round-trip | ✅ |
| ST-07 Redis: PING returns PONG | ✅ |
| ST-08 Redis: PUBLISH + SUBSCRIBE round-trip | ✅ |
| ST-09 KEDA: ScaledObject CRD is registered | ✅ |
| ST-10 Grafana: /api/health returns 200 | ✅ |

**Passed: 10 / 10**

---

## Issues resolved in M1 (for future reference)

1. **`namespace.yaml` removed from Helm chart** — caused ownership conflict on every install.
2. **CNPG operator removed from sub-chart dependencies** — cluster-scoped; bootstrap.sh installs it.
3. **Temporal's bundled Grafana and Prometheus disabled** — duplicate ServiceAccount naming conflicts.
4. **Secret templates removed from `postgres.yaml`** — overwrote bootstrap-generated passwords.
5. **PostgreSQL init SQL fixed** — `postInitSQL` creates roles before database ownership assignment.
6. **Redis chart bumped to `25.3.11`** — old tag removed from Docker Hub.
7. **`user: temporal_user` added to Temporal SQL config** — fallback to wrong username.
8. **`bootstrap.sh` fixed** — secrets/ConfigMaps get Helm adoption annotations.
9. **Temporal schema applied manually via admintools; schema job permanently disabled** — The schema job has three init containers: `create-database`, `setup-schema`, `update-schema`. The `create-database` step runs `CREATE DATABASE temporal` which requires CREATEDB, but CNPG manages database creation through its Cluster CRD — granting CREATEDB to `temporal_user` would be wrong. The databases already exist (created by `postInitSQL`), so `create-database` is a no-op we can't run. We applied `setup-schema` and `update-schema` once via `temporal-sql-tool` in the admintools pod; the resulting tables live in CNPG Postgres and survive pod restarts and helm upgrades. The job is disabled permanently (`schema.createDatabase.enabled`, `schema.setup.enabled`, `schema.update.enabled` all `false`) because the schema is durable and the job can never succeed as written against CNPG. If the schema ever needs to be re-applied (e.g. a new Temporal version adds migrations), run `temporal-sql-tool update-schema` manually via admintools.
10. **All three Temporal schema job flags disabled** — `schema.createDatabase.enabled`, `schema.setup.enabled`, `schema.update.enabled` all set to `false` in the umbrella chart's `values.yaml` (not the reference file in `infra/deps/temporal/`).
11. **SeaweedFS filer `password_file` replaced with `WEED_POSTGRES2_PASSWORD` env var** — `password_file` is not a valid SeaweedFS postgres2 config option; password is injected via `secretKeyRef` env var instead.
12. **SeaweedFS filer `createTable` added explicitly** — prevents format string error on first startup.
13. **KEDA ScaledObject disabled until M3** — `tanzen-worker` Deployment doesn't exist yet; KEDA marks ScaledObject unhealthy, blocking `helm --wait`.
14. **Smoke test script rewritten** — fixed service names (`tanzen-redis-master`, `tanzen-temporal-admintools`), replaced `kubectl run --rm` (breaks without `--attach` on modern kubectl) with `kubectl exec` into existing pods, fixed `aws-cli` image entrypoint (`--command` flag required).

---

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-13 | Use `tanzen-dev` namespace on existing Kind cluster | Avoids collision with occupied `tanzen` namespace |
| 2026-04-13 | SeaweedFS via custom templates (no sub-chart) | No well-maintained community chart exists |
| 2026-04-13 | CloudNativePG for Postgres | Kubernetes-native CRD; automated failover |
| 2026-04-13 | KEDA ScaledObject deployed in M1 (disabled until M3) | Activates when worker Deployment is created in M3 |
| 2026-04-13 | Remove CNPG from umbrella chart sub-charts | Operator is cluster-scoped; bootstrap.sh installs it |
| 2026-04-13 | Remove credential Secret templates from Helm chart | Templates overwrote bootstrap-generated passwords |
| 2026-04-13 | Bump `bitnami/redis` chart to `25.3.11` | `19.6.4` pinned a Docker image tag removed from Docker Hub |
| 2026-04-14 | Apply Temporal schema manually via admintools | Schema job can't run `CREATE DATABASE` against CNPG without CREATEDB privilege; databases pre-exist |
| 2026-04-14 | SeaweedFS password via `WEED_POSTGRES2_PASSWORD` env var | `password_file` is not a valid SeaweedFS postgres2 config field |
| 2026-04-15 | Conduit API server runs on port 3001 | Port 3000 occupied by existing `tanzen-api` process with incompatible response format |
| 2026-04-15 | Rate limiter uses in-process Map, not Redis | Sufficient for single-replica dev; noted as known gap for multi-replica prod |
| 2026-04-15 | Monaco Editor stubbed as `<textarea>` in Vitest | Avoids WebWorker/canvas jsdom incompatibility; real editor tested in dev server |

---

## M7 — Human Review Gates ✅

Temporal signal-based gate blocking. When a workflow step is tagged `gate: true`, the worker pauses and opens a gate record in Postgres. The API exposes:

- `GET /api/gates` — list gates (filterable by status)
- `POST /api/gates/:id/approve` — sends `gate_approved` signal to Temporal; 409 if already resolved
- `POST /api/gates/:id/reject` — sends `gate_rejected` signal; 409 if already resolved
- `GET /api/gates/stream` — SSE stream for real-time gate queue updates

Gate signal correlates by `step_id`. Postgres write is best-effort asyncpg (non-blocking).

---

## M8–M9 — React App ✅

Full React 19 + React Router v7 + TanStack Query v5 SPA. All pages live under `app/src/pages/`.

| Page | Key features |
|---|---|
| `WorkflowsPage` | Monaco DSL editor, compile button, run modal (JSON params), version history, promote button |
| `AgentsPage` | Create/edit agent form, model selector, version history with promoted badge |
| `RunsPage` | Status filter dropdown, step timeline with token_count/cost_usd/duration, 3s poll for running runs |
| `GatesPage` | Pending/Reviewed sections, approve/reject modal with notes, 5s poll |
| `MetricsPage` | Date range picker, Recharts BarChart by workflow, token usage table |
| `SecretsPage` | Password input, delete confirmation modal |
| `SettingsPage` | Placeholder |

Vite dev server proxies `/api` → `http://localhost:3001`.

---

## M10 — Versioning ✅

- `promoted BOOLEAN NOT NULL DEFAULT FALSE` added to `workflow_versions` and `agent_versions` via idempotent `ADD COLUMN IF NOT EXISTS`
- `POST /api/workflows/:id/promote` — clears all promotions for that workflow, then sets current version promoted
- `POST /api/agents/:id/promote` — same pattern
- Version history queries include `promoted` field; UI shows a `promoted` badge in detail panels

---

## M11 — Observability ✅

**API server (`server/src/server/otel.ts`)**
- OTel SDK + `PrometheusExporter` on `:9464/metrics`
- Guarded by `OTEL_ENABLED=true` — no-op in test/dev by default
- Instruments: `tanzen.runs.started` (counter), `tanzen.steps.duration` (histogram)

**Python worker (`worker/src/tanzen_worker/otel.py`)**
- `opentelemetry-sdk` + `opentelemetry-exporter-prometheus` on `:9465`
- `record_activity_complete(activity_name, status, duration_ms)`
- `record_llm_usage(model, agent_id, tokens, cost_usd)`

**Grafana dashboards** (`infra/deps/grafana/dashboards/`)
- `ops-overview.json` — run throughput, error rate, gate queue depth
- `cost-latency.json` — LLM cost by model/agent, p50/p95/p99 step latency
- `infrastructure.json` — CPU, memory, pod count, DB connections

**Prometheus ServiceMonitors** (`infra/deps/prometheus/service-monitors.yaml`)
- `tanzen-api` scrapes `:9464` every 30s
- `tanzen-worker` scrapes `:9465` every 30s
- Label `release: tanzen` matches kube-prometheus-stack selector

---

## M12 — Documentation ✅

| File | Contents |
|---|---|
| `docs/dsl-reference.md` | DSL language spec: workflow/step/agent/gate syntax, 5 annotated examples |
| `docs/api-reference.yaml` | OpenAPI 3.1 — all endpoints with request/response schemas, RBAC notes, rate limit headers |
| `docs/helm-values.md` | Full Helm values reference for api, worker, postgres, redis, seaweedfs, temporal, auth, ingress, monitoring |
| `docs/deployment-guide.md` | Local dev setup, staging/prod Helm deploy, migrations, OTel enablement, scaling, troubleshooting |

---

## M13 — Hardening ✅

**Rate limiting** (`server/src/server/ratelimit.ts`)
- Global sliding window: 300 req/min per IP (all endpoints)
- Per-user sliding window: 60 req/min per authenticated user on `/api/*`
- Returns `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers
- 429 with `{ error: "Too many requests — please slow down" }`

**RBAC matrix**

| Action | admin | author | reviewer | viewer |
|---|---|---|---|---|
| List workflows/agents/runs/gates | ✅ | ✅ | ✅ | ✅ |
| Create/update workflow or agent | ✅ | ✅ | — | — |
| Trigger run | ✅ | ✅ | — | — |
| Approve/reject gate | ✅ | — | ✅ | — |
| List/create/delete secret | ✅ | list only | — | — |
| Promote workflow or agent | ✅ | — | — | — |

**Input validation (agents)**
- Name: `^[a-z][a-z0-9-]{0,62}$` (1–63 chars, lowercase alphanumeric/hyphens)
- Model: allowlist of 8 known model IDs + `test`
- `system_prompt`: ≤ 32,768 characters
- `max_tokens`: 1–128,000
- `temperature`: 0–2

**Test counts**

| Suite | File | Tests |
|---|---|---|
| Server — API routes | `tests/server/api.test.ts` | 108 |
| Server — SSE streaming | `tests/server/sse.test.ts` | ~6 |
| Server — Hardening | `tests/server/hardening.test.ts` | 66 |
| Frontend — Vitest | `src/pages/*.test.tsx` | 44 |
| **Total** | | **~224** |

All passing as of 2026-04-15.

---

## Outstanding / Next Steps

- [ ] **Load test** — "50 concurrent runs" scenario not yet implemented; add `k6` or `autocannon` script
- [ ] **Rate limiter Redis backend** — current in-process `Map` breaks under multi-replica deploys
- [ ] **E2E tests** — `puppeteer` and `chrome-devtools` MCP servers now configured; drive browser tests against running dev stack (create agent → workflow → run → gate approval)
- [ ] **Helm chart** — `infra/charts/tanzen/` referenced in deployment guide but not yet created
- [ ] **CI pipeline** — no `.github/workflows/` or equivalent; all tests run manually
- [ ] **Worker type safety** — Python worker has no `mypy`/`pyright` config; Temporal SDK stubs not installed
