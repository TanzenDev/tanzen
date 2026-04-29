# Tanzen

Agent Workflow Orchestration Platform for knowledge-work automation.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Docker | 24+ | https://docs.docker.com/get-docker/ |
| kind | 0.23+ | `brew install kind` or https://kind.sigs.k8s.io |
| kubectl | 1.29+ | `brew install kubectl` |
| Helm | 3.15+ | `brew install helm` |

---

## Quick Start (new cluster)

```bash
# Clone and enter
git clone <repo-url> tanzen && cd tanzen

# Bootstrap: creates a kind cluster, installs operators, generates secrets,
# and deploys all services into the tanzen-dev namespace.
./infra/scripts/bootstrap.sh --new-cluster --cluster tanzen-dev --namespace tanzen-dev

# Verify with smoke tests
./infra/scripts/smoke-test.sh --namespace tanzen-dev
```

Total time: ~8–12 minutes on first run (operator image pulls dominate).

---

## Use an existing cluster

If you already have a Kind (or other K8s) cluster and want to use a different namespace:

```bash
# Targets your current kubectl context; uses tanzen-dev namespace
./infra/scripts/bootstrap.sh --namespace tanzen-dev
```

The script will NOT create a new cluster — it installs KEDA, CloudNativePG, and the Tanzen chart into the target namespace of your current context.

---

## Upgrade

```bash
helm dependency update infra/charts/tanzen
helm upgrade tanzen infra/charts/tanzen \
  --namespace tanzen-dev \
  --values infra/charts/tanzen/values.yaml \
  --wait
```

---

## Teardown

```bash
# Remove Tanzen workloads (preserves PVCs and secrets)
helm uninstall tanzen --namespace tanzen-dev

# Remove everything including PVCs
kubectl delete namespace tanzen-dev

# Delete the kind cluster entirely (if using --new-cluster)
kind delete cluster --name tanzen-dev
```

---

## Access services (dev)

**Temporal Web UI** (cluster-internal only):
```bash
kubectl port-forward -n tanzen-dev svc/temporal-web 8080:8080
open http://localhost:8080
```

**Grafana**:
```bash
kubectl port-forward -n tanzen-dev svc/tanzen-grafana 3000:80
# Get admin password:
kubectl get secret grafana-admin-credentials -n tanzen-dev \
  -o jsonpath='{.data.admin-password}' | base64 -d && echo
open http://localhost:3000
```

**Prometheus**:
```bash
kubectl port-forward -n tanzen-dev svc/prometheus-operated 9090:9090
open http://localhost:9090
```

---

## Repository layout

```
tanzen/
├── infra/
│   ├── charts/tanzen/        Umbrella Helm chart
│   │   ├── Chart.yaml
│   │   ├── values.yaml       Dev defaults
│   │   ├── values.prod.yaml  Production overrides
│   │   └── templates/
│   │       ├── namespace.yaml
│   │       ├── postgres.yaml       CloudNativePG Cluster + Secrets
│   │       ├── seaweedfs/          Master, Volume, Filer + bucket init Job
│   │       └── keda-scaled-objects/  Worker ScaledObject (wired up in M3)
│   ├── deps/
│   │   ├── temporal/values.yaml    Temporal sub-chart overrides
│   │   ├── grafana/                Dashboard ConfigMaps
│   │   └── prometheus/             (kube-prometheus-stack values live in
│   │                                infra/charts/tanzen/values.yaml)
│   └── scripts/
│       ├── bootstrap.sh      Idempotent full-stack setup
│       ├── smoke-test.sh     10-point health check suite
│       └── kind-config.yaml  Kind cluster spec for --new-cluster
├── tests/infra/              (reserved for extended integration tests, M5+)
├── .github/workflows/
│   └── infra-smoke.yaml      CI: deploy + smoke test on infra/ changes
└── AGENTS.md                 Platform design document
```

---

## Milestones

| # | Title | Status |
|---|---|---|
| 1 | Infrastructure baseline | ✅ In progress |
| 2 | DSL compiler v1 | ⬜ Pending |
| 3 | Dynamic Temporal workflow | ⬜ Pending |
| 4 | Agent activity + PydanticAI | ⬜ Pending |
| 5 | API server scaffold | ⬜ Pending |
| 6 | SSE event streaming | ⬜ Pending |
| 7 | Human review gates | ⬜ Pending |
| 8 | React app — Build section | ⬜ Pending |
| 9 | React app — Review + Config | ⬜ Pending |
| 10 | Versioning | ⬜ Pending |
| 11 | Observability stack | ⬜ Pending |
| 12 | Documentation | ⬜ Pending |
| 13 | Hardening + security review | ⬜ Pending |
