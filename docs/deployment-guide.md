# Deployment Guide

This guide covers local development, staging, and production deployments of the Tanzen platform.

## Prerequisites

- **Docker** 24+ and **kubectl** 1.28+
- **Helm** 3.14+
- **Bun** 1.1+ (local development only)
- A running Kubernetes cluster (local: [OrbStack](https://orbstack.dev) or [kind](https://kind.sigs.k8s.io))
- A [Clerk](https://clerk.com) account with an application created

---

## Local Development

### 1. Start Dependencies (in-cluster)

Apply the local dependency manifests:

```bash
kubectl create namespace tanzen-dev --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f infra/deps/
```

Port-forward services to localhost:

```bash
# Run each in a separate terminal (or use a process manager)
kubectl port-forward -n tanzen-dev svc/postgres   5432:5432 &
kubectl port-forward -n tanzen-dev svc/redis      6379:6379 &
kubectl port-forward -n tanzen-dev svc/seaweedfs  8333:8333 &
kubectl port-forward -n tanzen-dev svc/temporal   7233:7233 &
```

### 2. Configure Environment

```bash
cp server/.env.example server/.env
```

Edit `server/.env`:

```env
DATABASE_URL=postgres://tanzen_user:tanzen@localhost:5432/tanzen
REDIS_URL=redis://localhost:6379
S3_ENDPOINT_URL=http://localhost:8333
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=tanzen
AWS_SECRET_ACCESS_KEY=tanzen
AGENTS_BUCKET=tanzen-agents
WORKFLOWS_BUCKET=tanzen-workflows
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=default
CLERK_SECRET_KEY=sk_test_...
CLERK_JWKS_URL=https://clerk.example.com/.well-known/jwks.json
PORT=3001
```

### 3. Start the API Server

```bash
cd server
bun install
bun run src/server/index.ts
```

### 4. Start the Worker

```bash
cd worker
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
python -m tanzen_worker.worker
```

### 5. Start the Frontend

```bash
cd app
bun install
bun run dev
```

The app is available at `http://localhost:5173`. API calls are proxied to `http://localhost:3001`.

---

## Running Tests

### Server

```bash
cd server
bun test                                    # all tests
bun test tests/server/api.test.ts           # API integration
bun test tests/server/hardening.test.ts     # RBAC + rate limit + validation
```

### Frontend

```bash
cd app
bun run test        # Vitest + Testing Library
bun run type-check  # TypeScript
```

### Worker

```bash
cd worker
pytest tests/
```

---

## Staging Deployment

### 1. Build and Push Images

```bash
# Set your registry
export REGISTRY=ghcr.io/your-org/tanzen
export TAG=$(git rev-parse --short HEAD)

docker build -t $REGISTRY/api:$TAG   -f server/Dockerfile  server/
docker build -t $REGISTRY/worker:$TAG -f worker/Dockerfile worker/
docker build -t $REGISTRY/app:$TAG   -f app/Dockerfile     app/

docker push $REGISTRY/api:$TAG
docker push $REGISTRY/worker:$TAG
docker push $REGISTRY/app:$TAG
```

### 2. Create Secrets

```bash
kubectl create namespace tanzen-staging --dry-run=client -o yaml | kubectl apply -f -

# Database URL
kubectl create secret generic tanzen-db-url \
  --namespace tanzen-staging \
  --from-literal=DATABASE_URL="postgres://user:pass@your-rds-host:5432/tanzen" \
  --dry-run=client -o yaml | kubectl apply -f -

# S3 credentials
kubectl create secret generic tanzen-s3-creds \
  --namespace tanzen-staging \
  --from-literal=accessKeyId="AKIA..." \
  --from-literal=secretAccessKey="..." \
  --dry-run=client -o yaml | kubectl apply -f -

# Clerk credentials
kubectl create secret generic tanzen-clerk \
  --namespace tanzen-staging \
  --from-literal=CLERK_SECRET_KEY="sk_test_..." \
  --from-literal=CLERK_JWKS_URL="https://clerk.example.com/.well-known/jwks.json" \
  --dry-run=client -o yaml | kubectl apply -f -
```

### 3. Deploy with Helm

```bash
helm upgrade --install tanzen ./infra/charts/tanzen \
  --namespace tanzen-staging \
  --create-namespace \
  --set global.image.registry=$REGISTRY \
  --set api.image.tag=$TAG \
  --set worker.image.tag=$TAG \
  --set postgresql.enabled=false \
  --set externalDatabase.existingSecret=tanzen-db-url \
  --set seaweedfs.enabled=false \
  --set s3.existingSecret=tanzen-s3-creds \
  --set auth.clerk.existingSecret=tanzen-clerk \
  --set ingress.enabled=true \
  --set ingress.host=tanzen-staging.example.com \
  -f infra/values/staging.yaml \
  --wait --timeout 5m
```

### 4. Verify

```bash
kubectl rollout status deployment/tanzen-api   -n tanzen-staging
kubectl rollout status deployment/tanzen-worker -n tanzen-staging

# Health check
curl https://tanzen-staging.example.com/health
```

---

## Production Deployment

### Additional Checklist Before Deploying

- [ ] All tests pass on CI
- [ ] Docker images built from a tagged commit
- [ ] Database migrations reviewed (they run automatically on API startup)
- [ ] Secrets rotated or verified
- [ ] HPA and resource limits sized for expected traffic
- [ ] OTel enabled (`OTEL_ENABLED=true`) and Grafana dashboards provisioned
- [ ] PodDisruptionBudgets configured for zero-downtime rollouts

### Deploy

```bash
helm upgrade --install tanzen ./infra/charts/tanzen \
  --namespace tanzen-prod \
  --create-namespace \
  -f infra/values/prod.yaml \
  --atomic --timeout 10m
```

`--atomic` rolls back automatically if the rollout fails within the timeout.

### Rollback

```bash
# View release history
helm history tanzen -n tanzen-prod

# Roll back to previous release
helm rollback tanzen -n tanzen-prod

# Roll back to specific revision
helm rollback tanzen 7 -n tanzen-prod
```

---

## Database Migrations

Migrations run automatically when the API server starts, using the `migrate()` function in `server/src/server/db.ts`. They are idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).

To run migrations manually:

```bash
DATABASE_URL="postgres://..." bun run src/server/migrate.ts
```

**Never** delete the `schema_migrations` table — it tracks which migrations have been applied.

---

## Observability

### Enable OpenTelemetry

Set `OTEL_ENABLED=true` in the API and worker environments. This starts a Prometheus exporter on:

- API: `:9464/metrics`
- Worker: `:9465/metrics`

### Prometheus

If using the kube-prometheus-stack Helm chart (release label `kube-prometheus-stack`), apply the ServiceMonitor CRDs:

```bash
kubectl apply -f infra/deps/prometheus/service-monitors.yaml
```

Ensure the `release` label matches your Prometheus Operator selector. The default is `release: tanzen`.

### Grafana Dashboards

Apply the dashboard ConfigMap:

```bash
kubectl apply -f infra/deps/grafana/dashboards-configmap.yaml -n monitoring
```

Grafana auto-discovers dashboards from ConfigMaps labeled `grafana_dashboard: "1"` (configured by `grafana.sidecar.dashboards.enabled: true` in the kube-prometheus-stack values).

Three dashboards are provisioned:
- **Tanzen Ops Overview** — run throughput, error rates, gate queue depth
- **Cost & Latency** — LLM cost by model/agent, p50/p95/p99 step latency
- **Infrastructure** — CPU, memory, pod count, DB connections

---

## Scaling

### Horizontal Pod Autoscaling

Enable HPA via values:

```yaml
api:
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 20
    targetCPU: 70
```

### Worker Concurrency

The worker's `MAX_CONCURRENT_ACTIVITIES` controls how many Temporal activities run in parallel per pod. Default is `20`. For CPU-intensive workloads (LLM calls with local models), reduce to `5–10`. For I/O-bound workloads (cloud LLM APIs), scale up to `50+`.

### Rate Limits

The API enforces two sliding-window rate limits:
- **Global**: 300 requests/minute per IP (covers all endpoints)
- **Per-user**: 60 requests/minute per authenticated user on `/api/*`

Limits are tracked in-process. For multi-replica deployments, consider replacing the in-process store with Redis-backed counters.

---

## Troubleshooting

### API pod CrashLoopBackOff

```bash
kubectl logs -n tanzen-prod deployment/tanzen-api --previous
```

Common causes:
- `DATABASE_URL` secret missing or wrong password
- S3 bucket does not exist (create it manually or via Terraform)
- Clerk JWKS URL unreachable

### Worker not picking up tasks

```bash
kubectl logs -n tanzen-prod deployment/tanzen-worker
```

Check:
- `TEMPORAL_ADDRESS` points to correct frontend
- Temporal namespace exists: `tctl --namespace default namespace describe`
- Worker registered on the correct task queue

### Port-forward drops (local dev)

Port-forwards disconnect after ~1 hour on some setups. Re-establish with:

```bash
pkill -f "kubectl port-forward" 2>/dev/null; sleep 1
kubectl port-forward -n tanzen-dev svc/postgres  5432:5432 &
kubectl port-forward -n tanzen-dev svc/redis     6379:6379 &
kubectl port-forward -n tanzen-dev svc/seaweedfs 8333:8333 &
kubectl port-forward -n tanzen-dev svc/temporal  7233:7233 &
```

### 429 Too Many Requests in development

If hitting rate limits locally, temporarily increase the limit:

```bash
RATE_LIMIT_MAX=10000 bun run src/server/index.ts
```

Or disable per-user rate limiting by not importing `rateLimit` middleware during development.
