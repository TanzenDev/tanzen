# Tanzen — Milestone 1: Infrastructure Baseline

**Size:** M — 1–2 engineers, 2–3 weeks  
**Exit criteria:** Helm chart successfully deploys all backing services to a Kubernetes cluster; smoke tests confirm each service is reachable and healthy.

---

## Overview

Milestone 1 produces the cluster substrate that every subsequent milestone depends on. Nothing computes yet — no workflow logic, no API server, no UI. The deliverable is a Helm umbrella chart that colocates and configures six services, plus a smoke-test suite that proves the deployment is sound. Every later milestone assumes these services are up and correctly networked.

The six services and their roles:

| Service | Role in Tanzen |
|---|---|
| **Temporal Server** | Durable workflow execution engine; task queues, event history |
| **PostgreSQL** (CloudNativePG) | Metadata store for Temporal + application tables |
| **SeaweedFS** | S3-compatible artifact storage (DSL source, agent configs, run artifacts) |
| **Redis** | Transient pub/sub for SSE fan-out and gate badge counters |
| **KEDA** | Event-driven autoscaler; reads Temporal task queue depth to scale worker pods |
| **Grafana + Prometheus** | Observability stack; Prometheus scrapes all services; Grafana provisioned with dashboards |

---

## Repository Structure

Establish this layout at the start of the milestone. Later milestones add directories alongside `infra/`.

```
tanzen/
├── infra/
│   ├── charts/
│   │   └── tanzen/               # Umbrella Helm chart
│   │       ├── Chart.yaml
│   │       ├── values.yaml       # Default values (local dev profile)
│   │       ├── values.prod.yaml  # Production overrides (resource requests, replicas)
│   │       └── templates/
│   │           ├── namespace.yaml
│   │           ├── seaweedfs/
│   │           ├── redis/
│   │           └── keda-scaled-objects/  # placeholder — populated in M3
│   ├── deps/                     # Sub-chart dependency configs
│   │   ├── temporal/             # Temporal Helm values overlay
│   │   ├── cnpg/                 # CloudNativePG cluster manifest
│   │   ├── prometheus/           # kube-prometheus-stack values overlay
│   │   └── grafana/              # Dashboard ConfigMaps
│   └── scripts/
│       ├── bootstrap.sh          # One-shot cluster bootstrap (kind or real K8s)
│       └── smoke-test.sh         # Post-deploy health checks
├── tests/
│   └── infra/                    # Smoke test suite (bash + curl/psql/redis-cli)
└── AGENTS.md
```

---

## Task Breakdown

Tasks are ordered by dependency. Where tasks have no dependency on each other they can run in parallel.

---

### Phase 1 — Repository and Toolchain Setup (Day 1–2)

#### T1.1 — Initialize repository

- Create the `tanzen/` repository with the directory layout above.
- Add `.gitignore` covering `node_modules/`, `__pycache__/`, `.env`, `*.kubeconfig`.
- Add a root `README.md` with: project purpose, local prerequisites, and the single command to bring up the dev cluster.
- Commit with a meaningful message referencing this milestone.

**Prerequisites:** None  
**Artifact:** Git repository with skeleton structure

---

#### T1.2 — Establish local development cluster

- Choose and document the local K8s runtime. **kind** (Kubernetes in Docker) is recommended: single binary, no VM overhead, works on Linux/macOS/CI.
- Write `infra/scripts/bootstrap.sh`:
  - Creates a kind cluster named `tanzen-dev` if it does not exist.
  - Installs the NGINX ingress controller (kind-specific config) so services are reachable at `localhost`.
  - Installs KEDA via its official Helm chart (`kedacore/keda`).
  - Applies the CloudNativePG operator via its official Helm chart.
  - Prints confirmation that all controller pods are `Running`.
- Script must be idempotent (re-running does not fail or duplicate resources).

**Prerequisites:** T1.1  
**Artifact:** `infra/scripts/bootstrap.sh`; local cluster boots in under 5 minutes

---

### Phase 2 — Backing Service Deployments (Day 3–8)

These four tasks can proceed in parallel once T1.2 is done.

---

#### T2.1 — Deploy PostgreSQL via CloudNativePG

CloudNativePG manages Postgres as a Kubernetes-native custom resource, providing automated failover and backup hooks without a separate operator DSL.

- Add CloudNativePG to `infra/charts/tanzen/Chart.yaml` as a dependency.
- Write `infra/deps/cnpg/cluster.yaml` — a `Cluster` custom resource:
  - `instances: 1` for dev; `instances: 3` with streaming replication for prod.
  - Storage: 10Gi PVC in dev, 100Gi in prod.
  - Postgres 16.
  - Bootstrap: create two databases — `temporal` (for Temporal's schema) and `tanzen` (for application tables).
  - Create two Postgres users: `temporal_user` and `tanzen_user`, each with access to their respective database only.
  - Credentials stored as K8s Secrets named `temporal-db-credentials` and `tanzen-db-credentials`.
- Expose Postgres internally via the CloudNativePG-managed Service (`tanzen-postgres-rw`). Do not expose externally.

**Smoke test:** `psql` from within the cluster connects to both databases with the respective credentials and `SELECT 1` returns successfully.

**Prerequisites:** T1.2  
**Artifact:** `infra/deps/cnpg/cluster.yaml`, values additions in umbrella chart

---

#### T2.2 — Deploy Temporal Server

Temporal provides an official Helm chart (`temporalio/temporal`). The configuration surface is wide; constrain it to what Tanzen needs.

- Add `temporalio/temporal` as a sub-chart dependency.
- Write `infra/deps/temporal/values.yaml` overriding:
  - `server.replicaCount: 1` (dev); `3` (prod).
  - Persistence backend: `postgresql`; point at `tanzen-postgres-rw` service using the `temporal_user` credentials secret.
  - Disable Temporal's bundled Cassandra and MySQL dependencies (not needed).
  - Enable the Temporal Web UI (`temporalWeb.enabled: true`), exposed on an internal-only `ClusterIP` service. **Do not expose the Web UI externally** — it is for in-cluster operator debugging only.
  - Task queue namespace: create the `default` namespace in Temporal automatically via a post-install Helm hook that runs `tctl namespace register default`.
  - `frontend.grpc.port: 7233` — the port the API server will connect to.
- Verify Temporal's schema is auto-migrated on install (the Temporal chart handles this by default via an init job).

**Smoke test:** `tctl --address temporal-frontend:7233 cluster health` returns `SERVING` from within the cluster.

**Prerequisites:** T2.1  
**Artifact:** `infra/deps/temporal/values.yaml`

---

#### T2.3 — Deploy SeaweedFS

SeaweedFS is not available in a well-maintained official Helm chart; deploy it via a custom template in the umbrella chart.

- Write `infra/charts/tanzen/templates/seaweedfs/` containing:
  - `master-deployment.yaml` — SeaweedFS master pod (1 replica); port 9333 (HTTP), 19333 (gRPC).
  - `master-service.yaml` — `ClusterIP` service for master.
  - `volume-deployment.yaml` — SeaweedFS volume server pod (1 replica); mounts a PVC (20Gi dev, 500Gi prod); registers with master on startup.
  - `volume-service.yaml` — `ClusterIP` service for volume server.
  - `filer-deployment.yaml` — SeaweedFS filer pod (1 replica); connects to master and Postgres (dedicated `seaweedfs` database and user).
  - `filer-service.yaml` — `ClusterIP` service for filer; port 8888 (HTTP/S3 API).
- On first start, run a post-install Job that creates the three required buckets via the S3 API: `workflows`, `agents`, `artifacts`.
- S3 credentials: generate a static access key/secret and store as K8s Secret `seaweedfs-s3-credentials`. The API server and Python workers will consume this secret.

**Smoke test:** `aws s3 ls --endpoint-url http://seaweedfs-filer:8888` (using the credentials secret) lists the three buckets.

**Prerequisites:** T1.2  
**Artifact:** `infra/charts/tanzen/templates/seaweedfs/` directory

---

#### T2.4 — Deploy Redis

Redis is used only for transient pub/sub; no persistence or clustering needed in MVP.

- Add `bitnami/redis` as a sub-chart dependency.
- Override values:
  - `architecture: standalone` (no replica, no Sentinel).
  - `auth.enabled: false` — internal-only, no password required in dev. For prod values, enable auth and reference a K8s Secret.
  - `persistence.enabled: false` — no RDB/AOF; Redis restarts with empty state, which is acceptable for pub/sub.
  - Expose on `ClusterIP` service `tanzen-redis` at port 6379.

**Smoke test:** `redis-cli -h tanzen-redis ping` returns `PONG`.

**Prerequisites:** T1.2  
**Artifact:** Redis values addition in `values.yaml`

---

### Phase 3 — Autoscaler Configuration (Day 9–11)

#### T3.1 — Install and configure KEDA

KEDA is installed by `bootstrap.sh` (T1.2) via its Helm chart. This task adds the Tanzen-specific `ScaledObject` placeholder and verifies KEDA operates correctly.

- Write `infra/charts/tanzen/templates/keda-scaled-objects/worker-scaledobject.yaml`:
  - `scaleTargetRef`: points to the Python worker `Deployment` (which does not exist yet; KEDA will simply log a warning until Milestone 3).
  - `triggers`: one trigger of type `temporal` using the Temporal task queue depth metric.
  - `minReplicaCount: 0`, `maxReplicaCount: 10`.
  - `pollingInterval: 15` seconds.
- Verify KEDA's `ScaledObject` controller is running and the `ScaledObject` resource is accepted without error (even though the target Deployment is absent).
- Document the KEDA metric source configuration in comments within the manifest — the `temporal` trigger requires the Temporal frontend address and the queue name.

**Note:** Full KEDA autoscaling will be validated in Milestone 3 when the Python worker Deployment exists.

**Prerequisites:** T1.2  
**Artifact:** `infra/charts/tanzen/templates/keda-scaled-objects/worker-scaledobject.yaml`

---

### Phase 4 — Observability Stack (Day 10–12, parallel with Phase 3)

#### T4.1 — Deploy Prometheus and Grafana

- Add `prometheus-community/kube-prometheus-stack` as a sub-chart dependency.
- Write `infra/deps/prometheus/values.yaml` overriding:
  - `grafana.enabled: true`.
  - `grafana.adminPassword`: reference a K8s Secret (pre-created by bootstrap script).
  - `prometheus.prometheusSpec.scrapeInterval: 30s`.
  - Add `additionalScrapeConfigs` entries for: Temporal metrics endpoint, SeaweedFS metrics endpoint, Redis exporter, future API server and Python worker endpoints.
- Write three Grafana dashboard ConfigMaps under `infra/deps/grafana/`:
  - `dashboard-operations.yaml` — skeleton for run volume, success rate, active runs, pending gates. Placeholder panels (no data yet; populated with real queries in Milestone 11).
  - `dashboard-cost-latency.yaml` — skeleton for token cost and step latency.
  - `dashboard-infrastructure.yaml` — worker pod count, SeaweedFS throughput.
- Grafana is exposed via ingress at `grafana.tanzen.local` (resolved by `/etc/hosts` in dev).

**Smoke test:** Grafana UI is reachable and the three dashboards appear (panels show "No data" — acceptable at this stage).

**Prerequisites:** T1.2  
**Artifact:** `infra/deps/prometheus/values.yaml`, three dashboard ConfigMaps

---

### Phase 5 — Smoke Test Suite (Day 12–14)

#### T5.1 — Write and run smoke tests

Write `infra/scripts/smoke-test.sh` and the test suite in `tests/infra/`. The suite runs entirely within the cluster (or via `kubectl exec`/port-forward) and exits non-zero on any failure.

**Tests to include:**

| Test ID | Service | Assertion |
|---|---|---|
| ST-01 | PostgreSQL | `SELECT 1` succeeds on `temporal` and `tanzen` databases |
| ST-02 | Temporal | `tctl cluster health` returns `SERVING` |
| ST-03 | Temporal | `default` namespace exists in Temporal |
| ST-04 | SeaweedFS | S3 `ListBuckets` returns `workflows`, `agents`, `artifacts` |
| ST-05 | SeaweedFS | S3 `PutObject` + `GetObject` round-trip succeeds in `artifacts` bucket |
| ST-06 | Redis | `PING` returns `PONG` |
| ST-07 | Redis | `PUBLISH` + `SUBSCRIBE` round-trip delivers a message |
| ST-08 | KEDA | `ScaledObject` resource exists and is in `Ready` condition |
| ST-09 | Prometheus | Metrics endpoint returns 200 and includes at least one `up` metric |
| ST-10 | Grafana | HTTP 200 on Grafana health endpoint `/api/health` |

The smoke-test script prints a pass/fail table and exits 0 only if all 10 tests pass.

**Prerequisites:** T2.1, T2.2, T2.3, T2.4, T3.1, T4.1  
**Artifact:** `infra/scripts/smoke-test.sh`, `tests/infra/` test files

---

### Phase 6 — CI Integration (Day 14–15)

#### T6.1 — Add CI pipeline for infrastructure

- Add `.github/workflows/infra-smoke.yaml` (or equivalent for your CI provider):
  - Trigger: push or pull request touching `infra/`.
  - Steps: install kind + kubectl + Helm → run `bootstrap.sh` → run `helm upgrade --install` → run `smoke-test.sh`.
  - Cache Helm chart downloads to speed up runs.
- The pipeline must pass before any infrastructure PR is merged.

**Prerequisites:** T5.1  
**Artifact:** `.github/workflows/infra-smoke.yaml`

---

## Dependency Graph

```
T1.1 ──► T1.2 ──┬──► T2.1 ──► T2.2
                 ├──► T2.3
                 ├──► T2.4
                 ├──► T3.1
                 └──► T4.1

T2.1, T2.2, T2.3, T2.4, T3.1, T4.1 ──► T5.1 ──► T6.1
```

---

## Values Strategy

Two values files from day one prevents configuration drift between environments.

**`values.yaml` (dev defaults):**
- All services: 1 replica, minimal resource requests (256Mi RAM, 0.1 CPU).
- PVC sizes: 10–20Gi.
- Redis: no auth.
- Temporal Web UI: enabled.
- Log level: `debug`.

**`values.prod.yaml` (production overrides):**
- PostgreSQL: 3 instances with streaming replication.
- Temporal: 3 frontend replicas.
- SeaweedFS volume server: production PVC size.
- Redis: auth enabled via K8s Secret reference.
- Resource requests/limits set to values derived from load testing (populated in Milestone 13).
- Log level: `info`.

---

## Networking Summary

All services communicate via `ClusterIP` — nothing is externally exposed except Grafana (ingress, dev only). This matches the sovereignty requirement that no data egresses the cluster.

| Service | Internal DNS | Port |
|---|---|---|
| PostgreSQL | `tanzen-postgres-rw` | 5432 |
| Temporal frontend | `temporal-frontend` | 7233 (gRPC) |
| Temporal Web UI | `temporal-web` | 8080 |
| SeaweedFS filer (S3) | `seaweedfs-filer` | 8888 |
| Redis | `tanzen-redis` | 6379 |
| Prometheus | `prometheus-operated` | 9090 |
| Grafana | `tanzen-grafana` | 80 (+ ingress) |

---

## Risks and Mitigations

**SeaweedFS Helm chart maintenance.** No well-maintained community chart exists; the custom templates in this milestone are the authoritative source. Mitigation: pin the SeaweedFS container image version explicitly; add a Renovate / Dependabot rule to track new releases.

**Temporal schema migration on upgrade.** Temporal's Helm chart runs schema migrations as an init job. On version upgrades, the job must complete before pods start. Mitigation: use `helm upgrade --wait` in CI and document the upgrade procedure.

**kind networking on macOS.** kind uses Docker networking; on macOS, port-forwarding is required for host-to-cluster access. The smoke tests are designed to run inside the cluster (via `kubectl exec`) to avoid this variance.

**KEDA `ScaledObject` targeting a missing Deployment.** KEDA logs a warning but does not fail. Mitigation: the warning is documented as expected; the smoke test checks only that the `ScaledObject` resource is accepted, not that scaling is active.

---

## Definition of Done

Milestone 1 is complete when:

1. `bootstrap.sh` runs to completion on a fresh machine with only Docker and `kubectl` installed.
2. `helm upgrade --install tanzen ./infra/charts/tanzen` completes without errors.
3. `smoke-test.sh` exits 0 with all 10 tests passing.
4. The CI pipeline passes on a clean branch.
5. A `values.prod.yaml` exists with production-scale overrides documented.
6. A brief runbook section in `README.md` covers: initial install, upgrade, teardown, and how to access the Temporal Web UI and Grafana from a local machine via port-forward.
