# Tanzen Operations Guide

End-to-end reference for provisioning, running, and using the Tanzen platform.

---

## Prerequisites

| Tool | Purpose |
|------|---------|
| `docker` | Kind cluster node images |
| `kind` | Local k8s cluster |
| `kubectl` | Cluster operations |
| `helm` | Chart installs |
| `bun` | API server runtime |
| `go` | Build admin/client CLIs |
| `node` / `npm` | UI dev server |

Build the CLIs once from the repo root:

```bash
# Admin CLI
go build -o ~/go/bin/tanzenctl ./cli/admin

# Client CLI
go build -o ~/go/bin/tanzen ./cli/client
```

---

## Provisioning

### Full setup (first time)

Creates a Kind cluster, installs all operators, generates secrets, deploys the Tanzen Helm chart, and registers the Temporal namespace.

```bash
tanzenctl up
```

This runs sequentially: Kind cluster → Helm repos → operators (KEDA, CNPG, ingress-nginx) → secrets → MCP images → Tanzen chart → Temporal namespace registration. Takes ~10 minutes on first run.

Skip cluster creation if one already exists:

```bash
tanzenctl up --skip-cluster
```

### Applying chart updates

Re-run helm upgrade without touching the cluster:

```bash
tanzenctl install

# With a custom values overlay:
tanzenctl install -f infra/charts/tanzen/my-values.yaml
```

### Checking pod status

```bash
tanzenctl status
```

Shows component name, pod, phase, readiness, and restart count for all pods in the `tanzen-dev` namespace.

### Teardown

```bash
tanzenctl down
```

---

## Port-Forwarding

Services run inside the cluster and need port-forwards for local access:

```bash
tanzenctl forward
```

| Service | Local | Remote | Purpose |
|---------|-------|--------|---------|
| temporal-frontend | 7233 | 7233 | Temporal gRPC |
| postgres-rw | 5432 | 5432 | PostgreSQL |
| redis-master | 6379 | 6379 | Redis |
| seaweedfs-filer | 8333 | 8333 | S3-compatible object store |

To also forward MCP servers (needed for agent tool calls):

```bash
tanzenctl forward --mcp
```

Adds: MCP Sequential Thinking (8081), MCP Fetch (8082), MCP FalkorDB (8083), kubectl proxy (8088).

Press `Ctrl-C` to stop all forwards.

---

## Running the API Server (OSS)

Port-forwards must be running first. The API server needs env vars pointing at the forwarded ports — the defaults are k8s-internal hostnames that won't resolve locally.

Retrieve the S3 credentials:

```bash
kubectl get secret seaweedfs-s3-credentials -n tanzen-dev \
  -o jsonpath='{.data.access_key}' | base64 -d && echo
kubectl get secret seaweedfs-s3-credentials -n tanzen-dev \
  -o jsonpath='{.data.secret_key}' | base64 -d && echo
```

Retrieve the database password:

```bash
kubectl get secret tanzen-db-credentials -n tanzen-dev \
  -o jsonpath='{.data.password}' | base64 -d && echo
```

Start the server:

```bash
S3_ENDPOINT_URL="http://localhost:8333" \
S3_ACCESS_KEY="<access_key>" \
S3_SECRET_KEY="<secret_key>" \
DATABASE_URL="postgres://tanzen_user:<password>@localhost:5432/tanzen" \
TEMPORAL_ADDRESS="localhost:7233" \
KUBECTL_PROXY_URL="http://localhost:8088" \
PORT=3002 \
bun run server/src/server/index.ts
```

`KUBECTL_PROXY_URL` is required for the MCP discovery endpoint — the server proxies k8s API calls through it to avoid TLS compatibility issues with Bun.

---

## Running the OSS UI

```bash
cd app
npm run dev
```

Serves on port 5175 (or 5173 if 5175 is free). Proxies `/api` → `http://localhost:3002`.

---

## Running the Enterprise Server

```bash
cd tanzen-enterprise/server
bun run src/index.ts
```

Serves on port 3003 (or as configured). Extends the OSS server with audit, RBAC, org, and SSO routes.

---

## Running the Enterprise UI

```bash
cd tanzen-enterprise/app
npm run dev
```

Serves on port 5174. Proxies `/api` → `http://localhost:3002`. Imports the OSS app shell via the `@tanzen/app-core` Vite alias and mounts enterprise extensions (Orgs, RBAC, Audit, Time Machine, SSO callback).

---

## Configuring the Client CLI

```bash
tanzen config set-url http://localhost:3002
tanzen config set-token <your-api-token>
tanzen config show
```

Config is stored at `~/.tanzen/config.yaml`.

---

## Managing Secrets

There are two secret namespaces: **k8s secrets** (available to workers at runtime) and **API secrets** (stored via the API, scoped to the authenticated user).

### K8s secrets — `tanzenctl secret`

```bash
# Create or update a k8s secret
tanzenctl secret set MY_API_KEY "sk-abc123"

# List all Tanzen-managed k8s secrets
tanzenctl secret list

# Delete a secret
tanzenctl secret delete MY_API_KEY --yes
```

### API secrets — `tanzen secret`

```bash
# Create or update a secret (stored in the API, injected into agent runs)
tanzen secret set OPENAI_API_KEY "sk-abc123"

# List secret names (values are never returned)
tanzen secret list

# Delete a secret
tanzen secret delete OPENAI_API_KEY --yes
```

---

## Uploading Input Data to S3

SeaweedFS provides an S3-compatible API on port 8333. Use the standard AWS CLI pointed at the local endpoint:

```bash
aws s3 cp my-data.json s3://tanzen-inputs/my-data.json \
  --endpoint-url http://localhost:8333 \
  --no-verify-ssl
```

Or create a bucket first:

```bash
aws s3 mb s3://tanzen-inputs \
  --endpoint-url http://localhost:8333

aws s3 cp dataset/ s3://tanzen-inputs/dataset/ \
  --endpoint-url http://localhost:8333 \
  --recursive
```

Reference files in workflow DSL with `s3://tanzen-inputs/<key>`.

---

## Creating Agents

```bash
tanzen agent create \
  --name "summarizer" \
  --model "claude-opus-4-7" \
  --system-prompt "You are a summarization assistant."

# With optional parameters:
tanzen agent create \
  --name "analyst" \
  --model "claude-sonnet-4-6" \
  --system-prompt "Analyze the provided data." \
  --max-tokens 4096 \
  --temperature 0.3 \
  --retries 2 \
  --secret OPENAI_API_KEY \
  --mcp-server "mcp-fetch"
```

Other agent commands:

```bash
tanzen agent update <id>          # update fields
tanzen agent promote <id>         # promote to production
tanzen agent delete <id> --yes    # delete
tanzen agent models               # list available models
```

---

## Creating and Managing Workflows

### Create a workflow

```bash
tanzen workflow create \
  --name "my-pipeline" \
  --dsl-file workflow.dsl
```

### Validate DSL without running

```bash
tanzen workflow compile <workflow-id> --dsl-file workflow.dsl
```

Returns the compiled IR or validation errors.

### Run a workflow

```bash
# Basic run
tanzen workflow run <workflow-id>

# With inline params
tanzen workflow run <workflow-id> --params '{"input_key": "s3://tanzen-inputs/data.json"}'

# With params from file
tanzen workflow run <workflow-id> --params-file params.json

# Stream run events until completion
tanzen workflow run <workflow-id> --params-file params.json --watch
```

### View runs for a workflow

```bash
tanzen workflow runs <workflow-id>
```

### Promote / delete a workflow

```bash
tanzen workflow promote <workflow-id>
tanzen workflow delete <workflow-id> --yes
```

---

## Monitoring Runs

```bash
# List all runs (optionally filter by status)
tanzen run list
tanzen run list --status running
tanzen run list --status failed --limit 20

# Get details for a specific run
tanzen run get <run-id>

# Stream live events for a run
tanzen run watch <run-id>

# Delete a run record
tanzen run delete <run-id> --yes
```

---

## Working with Gates

Gates are manual approval checkpoints in a workflow. When a workflow reaches a gate step it pauses and waits for human action.

```bash
# List all pending gates
tanzen gate list

# Approve a gate (run continues)
tanzen gate approve <gate-id>
tanzen gate approve <gate-id> --notes "Looks good, proceeding."

# Reject a gate (run fails at this step)
tanzen gate reject <gate-id>
tanzen gate reject <gate-id> --notes "Data quality insufficient."
```

The UI also shows pending gate count as a badge on the Gates nav item.

---

## End-to-End Worked Example

This walks through provisioning, uploading data, creating an agent and workflow, running it, and approving a gate.

### 1. Provision

```bash
tanzenctl up
# wait ~10 minutes

tanzenctl status   # confirm all pods Running
```

### 2. Start port-forwards and servers

```bash
# Terminal 1 — keep running
tanzenctl forward

# Terminal 2 — API server (fill in actual credentials from kubectl)
S3_ENDPOINT_URL="http://localhost:8333" \
S3_ACCESS_KEY="..." \
S3_SECRET_KEY="..." \
DATABASE_URL="postgres://tanzen_user:...@localhost:5432/tanzen" \
TEMPORAL_ADDRESS="localhost:7233" \
KUBECTL_PROXY_URL="http://localhost:8088" \
PORT=3002 \
bun run server/src/server/index.ts

# Terminal 3 — UI (optional)
cd app && npm run dev
```

### 3. Configure the client

```bash
tanzen config set-url http://localhost:3002
tanzen config set-token <your-token>
```

### 4. Add a secret

```bash
tanzen secret set OPENAI_API_KEY "sk-..."
```

### 5. Upload input data

```bash
aws s3 mb s3://tanzen-inputs --endpoint-url http://localhost:8333
aws s3 cp articles.json s3://tanzen-inputs/articles.json \
  --endpoint-url http://localhost:8333
```

### 6. Create an agent

```bash
tanzen agent create \
  --name "article-summarizer" \
  --model "claude-sonnet-4-6" \
  --system-prompt "Summarize each article in 3 sentences. Be concise and factual." \
  --secret OPENAI_API_KEY
```

Note the returned agent ID, e.g. `agt_abc123`.

### 7. Write a workflow DSL

```
// summarize-workflow.dsl
workflow ArticleSummarization {
  version: "1.0.0"
  triggers: [manual]

  params {
    input_key: string
    reviewer_email: string
  }

  step summarize {
    agent: article-summarizer @ "1.0"
    input: run.input
  }

  gate humanReview {
    assignee: params.reviewer_email
    timeout: 24h
    input: summarize.output
  }

  step format {
    agent: article-summarizer @ "1.0"
    input: summarize.output
    when: humanReview.approved
  }

  output {
    artifact: format.output
    retention: 1y
  }
}
```

### 8. Create and run the workflow

```bash
tanzen workflow create \
  --name "article-summarization" \
  --dsl-file summarize-workflow.dsl

# Note the returned workflow ID, e.g. wf_xyz789

tanzen workflow run wf_xyz789 \
  --params '{"input_key": "articles.json"}' \
  --watch
```

The run will pause at the gate step.

### 9. Approve the gate

```bash
tanzen gate list
# shows: gate_id  wf_xyz789  review-gate  pending

tanzen gate approve <gate-id> --notes "Article count looks right."
```

The workflow resumes and completes. Output is written to `s3://tanzen-inputs/summaries.json`.

### 10. Retrieve results

```bash
aws s3 cp s3://tanzen-inputs/summaries.json ./summaries.json \
  --endpoint-url http://localhost:8333

cat summaries.json
```

---

## Logs

```bash
# Tail logs for a specific component
tanzenctl logs <component>

# Examples
tanzenctl logs api
tanzenctl logs worker
tanzenctl logs temporal
```
