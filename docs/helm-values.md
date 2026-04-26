# Helm Values Reference

Complete reference for all configurable values in the `tanzen` Helm chart.

## Usage

```bash
helm upgrade --install tanzen ./infra/charts/tanzen \
  -n tanzen-dev \
  -f my-values.yaml
```

---

## Global

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `global.image.registry` | string | `ghcr.io/tanzen` | Container image registry |
| `global.image.pullPolicy` | string | `IfNotPresent` | Image pull policy |
| `global.image.pullSecrets` | list | `[]` | Registry pull secrets |
| `global.namespace` | string | `tanzen-dev` | Kubernetes namespace |
| `global.env` | string | `dev` | Environment tag (`dev`, `staging`, `prod`) |

---

## API Server (`api`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `api.enabled` | bool | `true` | Deploy the API server |
| `api.image.tag` | string | `latest` | Image tag |
| `api.replicas` | int | `2` | Number of pods |
| `api.port` | int | `3000` | HTTP listen port |
| `api.metricsPort` | int | `9464` | Prometheus metrics port |
| `api.resources.requests.cpu` | string | `100m` | CPU request |
| `api.resources.requests.memory` | string | `128Mi` | Memory request |
| `api.resources.limits.cpu` | string | `500m` | CPU limit |
| `api.resources.limits.memory` | string | `512Mi` | Memory limit |
| `api.autoscaling.enabled` | bool | `false` | Enable HPA |
| `api.autoscaling.minReplicas` | int | `2` | HPA minimum replicas |
| `api.autoscaling.maxReplicas` | int | `10` | HPA maximum replicas |
| `api.autoscaling.targetCPU` | int | `70` | HPA target CPU utilization (%) |
| `api.env.ALLOWED_ORIGINS` | string | `*` | CORS allowed origins (comma-separated) |
| `api.env.OTEL_ENABLED` | string | `"false"` | Enable OpenTelemetry export |

### API Probes

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `api.livenessProbe.path` | string | `/health` | Liveness check path |
| `api.livenessProbe.initialDelaySeconds` | int | `10` | Delay before first liveness check |
| `api.readinessProbe.path` | string | `/health` | Readiness check path |
| `api.readinessProbe.initialDelaySeconds` | int | `5` | Delay before first readiness check |

---

## Worker (`worker`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `worker.enabled` | bool | `true` | Deploy the Temporal worker |
| `worker.image.tag` | string | `latest` | Image tag |
| `worker.replicas` | int | `2` | Number of pods |
| `worker.metricsPort` | int | `9465` | Prometheus metrics port |
| `worker.resources.requests.cpu` | string | `250m` | CPU request |
| `worker.resources.requests.memory` | string | `256Mi` | Memory request |
| `worker.resources.limits.cpu` | string | `1000m` | CPU limit |
| `worker.resources.limits.memory` | string | `1Gi` | Memory limit |
| `worker.env.TASK_QUEUE` | string | `tanzen` | Temporal task queue name |
| `worker.env.OTEL_ENABLED` | string | `"false"` | Enable OpenTelemetry export |
| `worker.env.MAX_CONCURRENT_ACTIVITIES` | int | `20` | Max concurrent Temporal activities |

---

## PostgreSQL (`postgresql`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `postgresql.enabled` | bool | `true` | Deploy bundled PostgreSQL (disable for external) |
| `postgresql.image.tag` | string | `16` | PostgreSQL version |
| `postgresql.auth.database` | string | `tanzen` | Database name |
| `postgresql.auth.username` | string | `tanzen_user` | Database user |
| `postgresql.auth.existingSecret` | string | `""` | Existing Secret with `password` key (preferred) |
| `postgresql.auth.password` | string | `""` | Password (use `existingSecret` in production) |
| `postgresql.primary.persistence.enabled` | bool | `true` | Enable PVC |
| `postgresql.primary.persistence.size` | string | `20Gi` | PVC size |
| `postgresql.primary.persistence.storageClass` | string | `""` | Storage class (empty = cluster default) |

For an external database, set `postgresql.enabled: false` and provide `externalDatabase.url` (see below).

### External Database

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `externalDatabase.url` | string | `""` | Full PostgreSQL connection URL |
| `externalDatabase.existingSecret` | string | `""` | Secret name containing `DATABASE_URL` key |

---

## Redis (`redis`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `redis.enabled` | bool | `true` | Deploy bundled Redis |
| `redis.image.tag` | string | `7` | Redis version |
| `redis.auth.enabled` | bool | `false` | Enable Redis password auth |
| `redis.auth.existingSecret` | string | `""` | Existing Secret with `redis-password` key |
| `redis.master.persistence.enabled` | bool | `true` | Enable PVC |
| `redis.master.persistence.size` | string | `8Gi` | PVC size |

---

## SeaweedFS (`seaweedfs`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `seaweedfs.enabled` | bool | `true` | Deploy bundled SeaweedFS (S3-compatible store) |
| `seaweedfs.image.tag` | string | `3.68` | SeaweedFS version |
| `seaweedfs.s3Port` | int | `8333` | S3 API port |
| `seaweedfs.persistence.size` | string | `50Gi` | PVC size for volume server |
| `seaweedfs.auth.existingSecret` | string | `""` | Secret with `accessKeyId` and `secretAccessKey` |

For AWS S3 or compatible stores, set `seaweedfs.enabled: false` and configure `s3.*` (see below).

### External S3

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `s3.endpointUrl` | string | `""` | S3 endpoint URL (empty = AWS) |
| `s3.region` | string | `us-east-1` | S3 region |
| `s3.agentsBucket` | string | `tanzen-agents` | Bucket for agent configs |
| `s3.workflowsBucket` | string | `tanzen-workflows` | Bucket for workflow DSL |
| `s3.existingSecret` | string | `""` | Secret with `accessKeyId` and `secretAccessKey` |

---

## Temporal (`temporal`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `temporal.enabled` | bool | `true` | Deploy bundled Temporal (disable for managed) |
| `temporal.image.tag` | string | `1.24` | Temporal server version |
| `temporal.host` | string | `temporal:7233` | Temporal frontend address (override for external) |
| `temporal.namespace` | string | `default` | Temporal namespace |
| `temporal.persistence.size` | string | `10Gi` | PVC for Temporal Cassandra/PostgreSQL |

---

## Auth (`auth`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `auth.provider` | string | `clerk` | Auth provider (`clerk`) |
| `auth.clerk.existingSecret` | string | `""` | Secret with `CLERK_SECRET_KEY` and `CLERK_JWKS_URL` |
| `auth.clerk.secretKey` | string | `""` | Clerk secret key (use `existingSecret` in production) |
| `auth.clerk.jwksUrl` | string | `""` | Clerk JWKS URL for JWT verification |

---

## Ingress (`ingress`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `ingress.enabled` | bool | `false` | Deploy Ingress resource |
| `ingress.className` | string | `nginx` | Ingress class |
| `ingress.host` | string | `tanzen.example.com` | Hostname |
| `ingress.tls.enabled` | bool | `false` | Enable TLS |
| `ingress.tls.secretName` | string | `tanzen-tls` | TLS certificate Secret name |
| `ingress.annotations` | object | `{}` | Additional Ingress annotations |

---

## Observability (`monitoring`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `monitoring.enabled` | bool | `false` | Enable ServiceMonitor and Grafana dashboards |
| `monitoring.prometheusRelease` | string | `kube-prometheus-stack` | Release label on Prometheus Operator |
| `monitoring.serviceMonitor.interval` | string | `30s` | Prometheus scrape interval |
| `monitoring.serviceMonitor.scrapeTimeout` | string | `10s` | Prometheus scrape timeout |
| `monitoring.grafana.enabled` | bool | `false` | Provision Grafana dashboards via ConfigMap |
| `monitoring.grafana.namespace` | string | `monitoring` | Namespace where Grafana is running |

---

## Network Policies (`networkPolicies`)

Cilium `CiliumNetworkPolicy` resources that implement deny-all-by-default egress
for the worker and API pods. Works on both kind-tanzen and talos clusters (Cilium
is installed on both). Disabled by default to avoid breaking clusters without
the expected pod labels; enable once you've verified labels match.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `networkPolicies.enabled` | bool | `false` | Deploy CiliumNetworkPolicy resources |

Enable on talos:
```bash
tanzenctl up --profile talos ... --set networkPolicies.enabled=true
```

Enable on kind:
```bash
helm upgrade tanzen ./infra/charts/tanzen -n tanzen-dev --set networkPolicies.enabled=true
```

---

## Code Execution

Runtime feature flags are stored in the `settings` DB table and exposed via
`GET /PATCH /api/settings`. They do not require a Helm values change to toggle.

| Setting key | Default | Description |
|-------------|---------|-------------|
| `scripts_enabled` | `true` | Allow script registration and use in DSL |
| `agent_code_execution_enabled` | `false` | Allow agents to call `execute_python`/`execute_typescript` tools |

The `PYODIDE_RUNNER_PATH` env var on the worker controls the Python executor:
- Dev (default): path to `infra/executor/pyodide_runner.ts` (runs via `deno run`)
- Prod: path to pre-compiled `pyodide_runner` binary (runs as standalone; ~300 ms cold start)

---

## Production Example

```yaml
# values-prod.yaml
global:
  env: prod
  image:
    pullPolicy: Always

api:
  replicas: 3
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 20
    targetCPU: 70
  env:
    ALLOWED_ORIGINS: "https://app.example.com"
    OTEL_ENABLED: "true"
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 1000m
      memory: 1Gi

worker:
  replicas: 4
  env:
    OTEL_ENABLED: "true"
    MAX_CONCURRENT_ACTIVITIES: "40"

postgresql:
  enabled: false

externalDatabase:
  existingSecret: tanzen-db-url   # key: DATABASE_URL

redis:
  enabled: false
  # configure externalRedis similarly

seaweedfs:
  enabled: false

s3:
  region: us-east-1
  agentsBucket: acme-tanzen-agents
  workflowsBucket: acme-tanzen-workflows
  existingSecret: tanzen-s3-creds  # keys: accessKeyId, secretAccessKey

auth:
  clerk:
    existingSecret: tanzen-clerk   # keys: CLERK_SECRET_KEY, CLERK_JWKS_URL

ingress:
  enabled: true
  className: nginx
  host: tanzen.example.com
  tls:
    enabled: true
    secretName: tanzen-tls

monitoring:
  enabled: true
  grafana:
    enabled: true
```
