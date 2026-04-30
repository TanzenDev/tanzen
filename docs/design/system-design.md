# Tanzen — Agent Workflow Orchestration Platform

## Objective

Enable scientists, lawyers, and clinicians to author, execute, and audit multi-agent workflows over critical data, reducing the cost of procedurally defensible knowledge-work automation by O(n) labor-hours per workflow class while delivering an auditable artifact chain satisfying compliance requirements for FDA, GxP, and legal privilege contexts.

---

## Background

### State of the market

Large language models have crossed a capability threshold where multi-step agentic pipelines are viable for knowledge-intensive professional work. The tooling landscape has bifurcated: on one side, low-code builders (n8n, Relevance AI, Zapier) that are accessible but produce opaque, unauditable automations unsuitable for critical industries; on the other, SDK-level frameworks (LangGraph, CrewAI, AutoGen) that require developer expertise and offer no operational infrastructure.



Neither serves the legal operations director, the pharmacovigilance scientist, or the clinical research coordinator who needs to automate a process and demonstrate to a regulator that the process ran correctly. 



Parallel to this, workflow orchestration has matured. Temporal has emerged as the de facto standard for durable execution semantics in production systems, offering event-sourced workflow history, saga compensation, and durable human-in-the-loop gates — properties that are not incidental but architecturally necessary for critical use cases.



Kubernetes has become the standard deployment substrate for containerized workloads, with KEDA providing event-driven autoscaling that can respond to queue depth rather than CPU utilization — the right signal for LLM-heavy workloads that are I/O-bound, not compute-bound.

### Key persistent challenges

1. **Auditability gap.** Existing AI workflow tools cannot produce an artifact chain that
   demonstrates procedural correctness to a regulator or court. The execution history is at best a log; at worst it is ephemeral.

2. **Authorship ceiling.** Developer-authored workflows in Python or TypeScript are not accessible to domain experts. GUI builders hit expressiveness ceilings at real-world workflow complexity.

3. **Sovereignty requirements.** Legal privilege, HIPAA, FDA data integrity rules, and
   cross-border data localization requirements collectively disqualify most cloud-hosted AI workflow platforms for the highest-value use cases.

4. **Agent heterogeneity.** No production workflow uses a single agent framework or a single model. Any platform that couples tightly to a framework (LangChain, CrewAI) or a model provider becomes a liability as the landscape evolves.

---

## ROI

### Pain points resolved

| Domain             | Existing pain                                                                           | Resolution                                                                           |
| ------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Legal operations   | Manual contract review at $400–800/hr associate time; no audit trail                    | Parallelized jurisdiction-specific analysis with full artifact provenance            |
| Pharmacovigilance  | Adverse event narrative review bottlenecked on medical writers; FDA expects audit trail | Automated triage and narrative generation with event-sourced execution history       |
| Clinical research  | Cohort curation from EHR exports requires manual ontology mapping                       | Agent pipelines with controlled vocabulary enforcement and reproducible outputs      |
| Regulatory affairs | Submission document assembly is sequential, error-prone, and re-done on each cycle      | DAG-modeled submission workflows with checkpointing and version-pinned agent configs |

### Cost of inaction

Organizations that do not automate these workflows face compounding competitive disadvantage as peers adopt AI tooling. More concretely: the manual processes are not just slow — they are inconsistently executed, producing variability in output quality that increases downstream risk. A platform that enforces procedural consistency is simultaneously an automation tool and a quality management system.

---

## Requirements

### Personas

**Legal operations analyst** — works in-house at an enterprise or within a law firm's legal ops function. Technically literate but not a developer. Needs to build and run workflows that produce artifacts demonstrable as procedurally correct to outside counsel and courts.

**Pharmacovigilance scientist** — works in a critical pharmaceutical or CRO environment. Understands data pipelines; may write SQL or Python. Primary concern is regulatory defensibility of outputs and reproducibility of runs.

**Clinical research coordinator / bioinformatician** — manages data curation and cohort assembly for trials or research programs. Needs controlled vocabulary enforcement, provenance tracking across datasets, and reproducibility for publication.

### Use cases

1. **Legal:** Multi-jurisdiction contract due diligence with human review gate before final
   synthesis. Workflow artifacts constitute the engagement record.

2. **Legal:** Regulatory filing preparation — document retrieval, gap analysis, drafting, and a mandatory review gate before submission package assembly.

3. **Clinical:** Drug safety signal monitoring — ingest adverse event reports, classify by
   MedDRA ontology, flag signals exceeding threshold for medical reviewer gate.

4. **Clinical:** Rare disease cohort power analysis — retrieve from EHR, map phenotypes to HPO terms, compute statistical power, produce analysis artifact.

5. **Science:** Ontology-conformant literature curation — retrieve papers, extract entities, map to controlled vocabularies (MeSH, GO, ChEBI), persist structured dataset.

### Must accomplish

- Workflows are versioned, diffable, and replayable against historical inputs.
- Workflow steps execute as durable Temporal activities with checkpointing and retry.
- Parallel steps fan out automatically and join on completion.
- Human review gates block execution durably until a reviewer approves or rejects.
- Every run produces an auditable event log and persisted input/output artifacts.
- Agents are versioned independently of workflows; a run is pinned to specific versions of both.
- Agents are framework-agnostic (PydanticAI in MVP; any Temporal activity worker in future).
- Secrets are referenced by name, never stored in workflow or agent definitions.
- The platform deploys entirely within a customer's Kubernetes cluster with no external data egress required.

### Out of scope (MVP)

- Natural language workflow authoring (LLM-generated DSL from prose description).
- Real-time collaborative editing of workflows.
- Multi-tenant SaaS deployment (single-tenant self-hosted only in v1).
- Integration with external workflow systems (Jira, ServiceNow, etc.).
- Fine-tuning or training of underlying models.
- Support for non-Kubernetes deployment targets.

---

## Design

### Overview

Tanzen consists of four subsystems: a **browser-based authoring and operations console** built in React; a **Hono/Bun API server** that mediates between the console and backend services; a **Temporal orchestration layer** that executes durable workflow runs using a dynamic workflow interpreter; and a **Python worker fleet** that executes individual agent activities, scaled on demand by KEDA. 



Workflows are authored in a TypeScript-like DSL that compiles to a JSON intermediate representation consumed by the dynamic Temporal workflow. Artifacts are persisted to SeaweedFS (S3-compatible). Secrets are stored in Kubernetes Secrets and injected
into worker pods at runtime.



The operational data flow for a run is: user triggers run via console → API server validates and initiates Temporal workflow execution → Temporal schedules activity tasks onto named queues→ KEDA observes queue depth and scales Python worker Deployments → workers execute agent activities, calling LLM APIs and MCP servers, writing artifacts to SeaweedFS → Temporal records activity completions in its event-sourced history → API server streams run events to the browser over SSE → reviewer receives gate notification and approves/rejects via console →Temporal workflow resumes.

### High-level system diagram

```
┌─────────────────────────────────────────────────────────────┐
│  Browser                                                    │
│  React · ReactFlow · Radix/Tailwind · TanStack Query · SSE  │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTPS / SSE
┌────────────────────────────▼────────────────────────────────┐
│  API Server                                                 │
│  Hono on Bun                                                │
│  DSL compiler (Nearley.js) · Auth (Clerk) · RBAC            │
└──────┬──────────────────────────────────────┬───────────────┘
       │ gRPC                                 │ S3 API
┌──────▼──────────────────┐    ┌──────────────▼──────────────┐
│  Temporal Server        │    │  SeaweedFS                  │
│  Task queues            │    │  Artifacts · DSL source     │
│  Execution history      │    │  Agent configs              │
│  Workflow versioning    │    └─────────────────────────────┘
└──────┬──────────────────┘
       │ Temporal SDK (poll)         Redis pub/sub (SSE fan-out)
┌──────▼──────────────────────────────────────────────────────┐
│  Python Worker Pods (K8s Deployment, scaled by KEDA)        │
│  PydanticAI agent execution                                 │
│  MCP client calls · LLM API calls                           │
│  Artifact write to SeaweedFS                                │
└─────────────────────────────────────────────────────────────┘
```

---

## Detailed Design

### User Interface

**Technology:** React 18, ReactFlow 12, Radix UI primitives, Tailwind CSS 4, TanStack Query, Vercel AI SDK (SSE utilities only), Bun dev server, deployed as a static build on the same K8s cluster as the API server.

**Navigation structure:**

```
Build
  Agents
  Workflows
  Runs
Review
  Gates          [badge: pending count, delivered via SSE]
  Metrics
Config
  Secrets
  Settings
```

**Agents view:**

- Searchable, paginated list (name, model, MCP count, version, last modified).
- Detail panel: form fields for display name, model selector (dropdown populated from configured providers), system prompt (textarea with syntax highlighting), MCP list (add/remove with server URL and transport type), secret references (key-value pairs referencing K8s secret names, never values), version history timeline.
- Create/edit via modal form. Save increments minor version; explicit "Promote" increments major version and locks prior version as immutable.

**Workflows view:**

- Searchable, paginated list (name, version, trigger type, last run status, last run time).
- Detail panel with two tabs:
  - *Source:* Monaco editor instance rendering the TypeScript DSL with syntax highlighting, inline error annotation from the compiler, and a "Validate" button that invokes the compiler API endpoint without executing.
  - *Graph:* ReactFlow canvas rendering the workflow AST as a DAG. Nodes are color-coded by type (agent step, gate, fan-out group, conditional). Read-only in this tab for MVP; graph edits emit DSL mutations in v2.
- Right sidebar: version badge, step list with agent references, trigger configuration,
  30-day run statistics (run count, success rate, gate p50 dwell time, average token cost, p95 step latency).
- "Run now" button opens a parameter input modal and initiates a run.
- "Promote to prod" button on staging-tagged workflows.

**Runs view:**

- Filterable list by workflow name, status (running, succeeded, failed, awaiting gate),
  date range.
- Detail panel:
  - Run header: workflow name + version, triggered by, start time, elapsed time, status pill.
  - Step timeline: vertical event log showing step start/end, gate events, retries, and
    errors in chronological order. Each step is expandable to show agent version, input
    artifact reference, output artifact reference, token counts, latency.
  - Artifacts panel: list of input and output artifacts for the run with download links
    to SeaweedFS presigned URLs.
  - Live updates via SSE while the run is active.

**Gates view:**

- Inbox-style list of pending gate tasks across all workflows, sorted by timeout deadline.
- Each gate item shows: workflow name, run ID, step name, assigned reviewer, deadline, and a preview of the agent output artifact that requires review.
- Approve / Reject buttons with an optional notes field. Rejection optionally triggers a re-run of the preceding step with reviewer notes injected as context.

**Metrics view:**

- Time-series charts (recharts) for: run volume by workflow, success/failure rate, average cost per run by workflow, gate dwell time distribution, token consumption by model and agent.
- Filter by workflow name, date range, agent, model.
- All data served from a metrics API endpoint that queries the Temporal visibility store and the runs metadata table in Postgres.

**Secrets view:**

- Displays secret names only (never values). Each entry shows: name, creation date,
  last rotated date, number of agents referencing it.
- Add / rotate / delete via modal. Values are written directly to K8s Secrets via the API
  server's in-cluster service account; they never pass through the SeaweedFS persistence layer.

---

### Server

**Runtime:** Bun 1.x  
**Framework:** Hono 4.x  
**Auth:** Clerk (JWT verification middleware on all routes; RBAC roles: admin, author, reviewer, viewer)

**API surface:**

```
POST   /api/workflows                   Create workflow (persist DSL source + compiled IR to SeaweedFS)
GET    /api/workflows                   List workflows (paginated, filterable)
GET    /api/workflows/:id               Get workflow detail
POST   /api/workflows/:id/compile       Validate and compile DSL, return IR or errors
POST   /api/workflows/:id/runs          Initiate run (start Temporal workflow)
GET    /api/workflows/:id/runs          List runs for workflow

GET    /api/runs                        List all runs (paginated, filterable)
GET    /api/runs/:runId                 Get run detail
GET    /api/runs/:runId/events          SSE stream of run events
GET    /api/runs/:runId/artifacts/:key  Presigned redirect to SeaweedFS artifact

POST   /api/agents                      Create agent
GET    /api/agents                      List agents
GET    /api/agents/:id                  Get agent detail
PUT    /api/agents/:id                  Update agent (increments version)

GET    /api/gates                       List pending gates (across all runs)
POST   /api/gates/:gateId/approve       Approve gate (sends signal to Temporal workflow)
POST   /api/gates/:gateId/reject        Reject gate (sends signal to Temporal workflow)

GET    /api/metrics                     Aggregate metrics query

POST   /api/secrets                     Write K8s secret (name + value)
GET    /api/secrets                     List secret names
DELETE /api/secrets/:name               Delete K8s secret
```

**DSL compiler subsystem (runs in-process in the API server):**

- Lexical analyzer: Nearley.js grammar producing a token stream from DSL source.
- Parser: Nearley grammar rules producing an AST.
- Semantic analyzer: validates agent references exist, secret references exist, step IDs are unique, `condition` expressions reference valid step output paths, parallel blocks have at least two children.
- Emitter: serializes the validated AST to a JSON IR document that the Temporal dynamic workflow can interpret.
- Error format: array of `{ line, column, message, severity }` objects returned on compile failure, rendered as inline annotations in the Monaco editor.

**SSE fan-out:**

- Temporal worker posts run events (step start, step complete, artifact written, gate
  opened, gate resolved, run complete/failed) to a Redis pub/sub channel keyed by run ID.
- API server SSE endpoint subscribes to the channel for the requested run ID and forwards events to the browser connection.
- Gate count badge uses a separate Redis pub/sub channel for the authenticated user's pending gate count; published when gates open or close.

---

### Persistence

**SeaweedFS** (S3-compatible, self-hosted on K8s):

| Bucket      | Contents                                                                                             | Retention                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `workflows` | DSL source (versioned by object key `{id}/{version}.dsl`) and compiled IR (`{id}/{version}.ir.json`) | Indefinite                                                          |
| `agents`    | Agent definition JSON (`{id}/{version}.json`)                                                        | Indefinite                                                          |
| `artifacts` | Run input and output artifacts (`{runId}/{stepId}/{direction}/{filename}`)                           | Configurable per workflow (default 7 years for critical verticals) |

**Postgres** (in-cluster, managed by CloudNativePG operator):

```sql
-- Core metadata tables (abbreviated)
workflows        (id, name, current_version, created_at, created_by)
workflow_versions (workflow_id, version, dsl_key, ir_key, created_at, created_by)
agents           (id, name, current_version, model, created_at)
agent_versions   (agent_id, version, config_key, created_at)
runs             (id, workflow_id, workflow_version, status, triggered_by,
                  started_at, completed_at, temporal_workflow_id)
run_steps        (id, run_id, step_id, agent_id, agent_version, status,
                  started_at, completed_at, input_artifact_key,
                  output_artifact_key, token_count, cost_usd)
gates            (id, run_id, step_id, assignee, status, opened_at,
                  resolved_at, resolved_by, notes)
```

**Redis:** Transient pub/sub only; no persistence required. Runs as a single-replica
Deployment in the cluster for MVP.

---

### Security

| Risk                                          | Approach                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Secret exposure in workflow/agent definitions | Secrets are K8s Secrets only; API returns names not values; worker pods receive secrets as env vars via K8s secret volume mounts, never written to SeaweedFS |
| Unauthorized workflow execution               | Clerk JWT on all API routes; `author` role required to create/edit; `viewer` cannot trigger runs                                                             |
| Artifact exfiltration                         | SeaweedFS presigned URLs are time-limited (15 min); artifacts are not publicly accessible; API server validates run ownership before issuing presigned URL   |
| Prompt injection via artifacts                | Agent worker validates artifact content type before injecting into prompt context; max input size enforced per agent config                                  |
| Temporal server exposure                      | Temporal gRPC port is not exposed outside the cluster; API server communicates via in-cluster service DNS                                                    |
| Reviewer gate bypass                          | Gate approval requires authenticated user with `reviewer` role; Temporal workflow validates the signal source before unblocking                              |
| Supply chain: MCP servers                     | MCP server URLs are admin-configured; authors select from allowlist; workers do not accept arbitrary MCP server URLs from workflow DSL                       |

---

### Observability

**Instrumentation:** All components emit OpenTelemetry traces and metrics to an in-cluster OTel Collector, which fans out to Prometheus (metrics) and an optional Jaeger instance (traces).

**Key metrics:**

| Metric                                         | Source                                                | Use                          |
| ---------------------------------------------- | ----------------------------------------------------- | ---------------------------- |
| `tanzen_run_total{workflow,status}`            | API server on run state change                        | Run volume and success rate  |
| `tanzen_run_duration_seconds{workflow}`        | Temporal activity completion                          | P50/P95 latency per workflow |
| `tanzen_step_token_count{workflow,step,model}` | Python worker on LLM call                             | Cost attribution             |
| `tanzen_gate_dwell_seconds{workflow,step}`     | API server on gate resolution                         | Reviewer responsiveness      |
| `tanzen_worker_queue_depth{queue}`             | KEDA ScaledObject (also used for autoscaling trigger) | Worker scaling visibility    |
| `tanzen_artifact_bytes{bucket}`                | SeaweedFS metrics endpoint                            | Storage growth               |

**Temporal built-in visibility:** Temporal's workflow execution history is the canonical
per-run audit log. The Temporal Web UI is exposed within the cluster (not externally) for operator debugging.

**Grafana dashboards (provisioned via ConfigMap):**

1. Operations overview: run volume, success rate, active runs, pending gates.
2. Cost and latency: per-workflow token cost, p95 step latency, model breakdown.
3. Infrastructure: worker pod count vs queue depth, SeaweedFS throughput.

---

### DSL Specification

**Example — trivial:**

```typescript
workflow ContractExtract {
  version: "1.0.0"

  step extract {
    agent: document-parser @ "2.1"
    input: run.input
  }

  output: extract.output
}
```

**Example — parallel fan-out with gate:**

```typescript
workflow ContractDueDiligence {
  version: "1.2.0"
  triggers: [manual, webhook("/ingest/contract")]

  params {
    reviewer_email: string
    jurisdictions: string[] = ["US", "EU"]
  }

  step extract {
    agent: document-parser @ "2.1"
    input: run.input
    retry: 3
  }

  parallel analyze {
    for jurisdiction in params.jurisdictions {
      step analyze_${jurisdiction} {
        agent: legal-analyst @ "1.4"
        params: { jurisdiction: jurisdiction, doc: extract.output }
      }
    }
  }

  gate human_review {
    assignee: params.reviewer_email
    timeout: 72h
    input: analyze.output
  }

  step synthesize {
    agent: synthesis-agent @ "1.0"
    when: human_review.approved
    input: { analyses: analyze.output, notes: human_review.notes }
  }

  output {
    artifact: synthesize.output
    retention: "7y"
  }
}
```

**Grammar constructs (MVP):**

- `workflow Name { ... }` — top-level declaration
- `version`, `triggers`, `params` — workflow metadata
- `step id { agent, input, params, retry, when, timeout }` — agent activity step
- `parallel id { step... | for x in expr { step... } }` — fan-out block
- `gate id { assignee, timeout, input }` — human review gate
- `output { artifact, retention }` — run output declaration
- `when: expr` — conditional execution (step runs only if expression is truthy)
- Template expressions: `${identifier}` in string literals
- Step output references: `stepId.output`, `stepId.approved`, `stepId.notes`

**JSON IR format (emitted by compiler):**

```json
{
  "name": "contract-due-diligence",
  "version": "1.2.0",
  "params": { "reviewer_email": "string", "jurisdictions": ["US", "EU"] },
  "steps": [
    { "id": "extract", "type": "agent", "agentId": "document-parser", "agentVersion": "2.1",
      "input": { "$ref": "run.input" }, "retry": 3 },
    { "id": "analyze", "type": "parallel",
      "forEach": { "var": "jurisdiction", "in": { "$ref": "params.jurisdictions" } },
      "template": {
        "id": "analyze_${jurisdiction}", "type": "agent",
        "agentId": "legal-analyst", "agentVersion": "1.4",
        "input": { "jurisdiction": { "$ref": "jurisdiction" }, "doc": { "$ref": "extract.output" } }
      }
    },
    { "id": "human_review", "type": "gate",
      "assignee": { "$ref": "params.reviewer_email" }, "timeoutSeconds": 259200,
      "input": { "$ref": "analyze.output" } },
    { "id": "synthesize", "type": "agent",
      "agentId": "synthesis-agent", "agentVersion": "1.0",
      "when": { "$ref": "human_review.approved" },
      "input": { "analyses": { "$ref": "analyze.output" }, "notes": { "$ref": "human_review.notes" } }
    }
  ],
  "output": { "artifact": { "$ref": "synthesize.output" }, "retentionDays": 2555 }
}
```

---

### Temporal Dynamic Workflow

The dynamic workflow is a single Temporal workflow definition in Python that interprets the JSON IR at runtime. This means adding new workflow patterns requires only DSL and compiler changes, not new Temporal workflow code.

**Pseudocode:**

```python
@workflow.defn
class DynamicWorkflow:
    async def run(self, ir: dict, params: dict) -> dict:
        state = RunState(params=params, outputs={})

        for step in ir["steps"]:
            if not evaluate_condition(step.get("when"), state):
                continue

            if step["type"] == "agent":
                result = await workflow.execute_activity(
                    run_agent_activity,
                    AgentActivityInput(step=step, state=state),
                    start_to_close_timeout=timedelta(minutes=30),
                    retry_policy=RetryPolicy(maximum_attempts=step.get("retry", 1))
                )
                state.outputs[step["id"]] = result

            elif step["type"] == "parallel":
                items = resolve_ref(step["forEach"]["in"], state)
                tasks = [
                    workflow.execute_activity(run_agent_activity, ...)
                    for item in items
                ]
                results = await asyncio.gather(*tasks)
                state.outputs[step["id"]] = results

            elif step["type"] == "gate":
                await workflow.execute_activity(open_gate_activity, ...)
                signal = await workflow.wait_for_signal("gate_resolution")
                state.outputs[step["id"]] = signal

        await workflow.execute_activity(write_output_activity, ...)
        return state.outputs
```

**Python worker activities:**

- `run_agent_activity`: instantiates a PydanticAI agent from the versioned agent config, resolves secret references from env vars, calls the model, calls MCP tools as needed, writes input and output artifacts to SeaweedFS, emits step events to Redis pub/sub.
- `open_gate_activity`: writes gate record to Postgres, publishes gate-opened event to Redis.
- `write_output_activity`: writes final output artifact to SeaweedFS with retention tag, writes run completion record to Postgres.

---

## Alternatives Considered

### Workflow orchestration: Temporal vs Argo Workflows

| Axis                   | Temporal                                                    | Argo Workflows                                                                         |
| ---------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Execution model        | Event-sourced durable execution; survives worker crashes    | Kubernetes Job DAG; state in etcd; no replay                                           |
| Long-running workflows | Native; can sleep for days awaiting signals                 | Requires external tooling to manage pod lifecycle                                      |
| Human-in-the-loop      | First-class signal primitive                                | Not natively supported; requires custom webhook polling                                |
| Audit trail            | Execution history is the audit log; immutable and queryable | Pod logs; not event-sourced; gaps on pod failure                                       |
| Saga / compensation    | Supported natively                                          | Not supported                                                                          |
| Autoscaling            | KEDA on Temporal task queue depth                           | KEDA on Argo queue depth or Kubernetes HPA                                             |
| Operational complexity | Temporal server deployment (Helm); Postgres dependency      | Argo controller only; no separate persistence layer                                    |
| **Verdict**            | **Correct for this domain**                                 | Appropriate for bounded batch pipelines; not for critical human-in-the-loop workflows |

### DSL format: TypeScript-like DSL vs YAML vs Python DSL

| Axis                   | TypeScript-like DSL                                       | YAML                                   | Python DSL                                                |
| ---------------------- | --------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------- |
| Readability            | High; familiar syntax for technical authors               | Medium; verbose, indentation-sensitive | High; familiar to scientists                              |
| Toolability            | Excellent; Monaco editor, type inference, Nearley grammar | Limited; schema validation only        | Excellent; LSP, linters, mypy                             |
| Compilation target     | JSON IR via Nearley.js in API server                      | JSON IR directly                       | JSON IR via AST walk                                      |
| Execution leakage risk | None; DSL has no runtime; compiles to data                | None                                   | High; Python DSL is executable; security boundary unclear |
| Version diffability    | Line-by-line text diff                                    | Line-by-line text diff                 | Line-by-line text diff                                    |
| Author persona fit     | Lawyers, regulatory affairs, coordinators                 | Config-minded operators                | Scientists, bioinformaticians                             |
| **Verdict**            | **Selected for MVP; safest security boundary**            | Rejected; brittle, less readable       | Consider as v2 extension for scientist persona            |

### Frontend component system: Chakra UI v3 vs Radix + Tailwind

| Axis               | Chakra UI v3                                | Radix UI + Tailwind                                   |
| ------------------ | ------------------------------------------- | ----------------------------------------------------- |
| Accessibility      | Excellent (Ark UI foundation)               | Excellent (Radix primitives are headless)             |
| Design flexibility | Moderate; theme tokens constrain divergence | High; Tailwind utilities override everything          |
| Bundle size        | Larger; full component library              | Smaller; only primitives imported                     |
| Data-dense UI fit  | Moderate; designed for app-like surfaces    | High; easier to achieve clinical/legal tool aesthetic |
| **Verdict**        | Viable; simpler for rapid iteration         | **Selected; better long-term flexibility**            |

### Artifact storage: SeaweedFS vs MinIO vs PostgreSQL large objects

| Axis                   | SeaweedFS                                       | MinIO                                     | Postgres large objects   |
| ---------------------- | ----------------------------------------------- | ----------------------------------------- | ------------------------ |
| S3 API compatibility   | Full                                            | Full                                      | N/A                      |
| Operational simplicity | Moderate (master + volume servers)              | Simple (single binary)                    | Simple (already present) |
| Scale                  | Excellent; designed for billions of small files | Good                                      | Poor beyond ~10GB        |
| Streaming reads        | Supported                                       | Supported                                 | Limited                  |
| **Verdict**            | **Selected** for long-term scale                | Valid alternative for smaller deployments | Rejected                 |

---

## Milestones

Size definitions:

- **S** — 1 engineer, ~1 week
- **M** — 1–2 engineers, 2–3 weeks
- **L** — 2 engineers, 4–6 weeks

| #   | Title                       | Outcomes                                                                                                                                                                                          | Size |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | Infrastructure baseline     | Helm chart deploys Temporal, SeaweedFS, Postgres, Redis, KEDA to a K8s cluster. Smoke tests pass.                                                                                                 | M    |
| 2   | DSL compiler v1             | Nearley.js grammar parses workflow DSL. Compiler emits JSON IR for sequential and parallel steps. Error objects with line/column returned on invalid input. Unit tests cover grammar and emitter. | L    |
| 3   | Dynamic Temporal workflow   | Python Temporal workflow interprets JSON IR. Executes sequential and parallel agent steps as activities. Writes stub artifacts to SeaweedFS. Integration test against real Temporal dev server.   | L    |
| 4   | Agent activity + PydanticAI | `run_agent_activity` instantiates PydanticAI agent from config, calls LLM, resolves secrets from env, writes artifacts to SeaweedFS. MCP tool call supported.                                     | M    |
| 5   | API server scaffold         | Hono/Bun server with Clerk auth. CRUD endpoints for workflows and agents. Compile endpoint. Run initiation endpoint calling Temporal SDK. Postgres schema migrated.                               | M    |
| 6   | SSE event streaming         | Python worker emits step events to Redis pub/sub. API server SSE endpoint subscribes and forwards to browser. Gate-opened events increment badge counter.                                         | S    |
| 7   | Human review gates          | `open_gate_activity` writes gate to Postgres. Temporal workflow awaits signal. API gate approve/reject endpoints send Temporal signal. Gate record updated in Postgres.                           | M    |
| 8   | React app — Build section   | Agents list and detail form. Workflows list, DSL editor (Monaco), ReactFlow graph view (read-only). Run initiation modal. Runs list and detail with event timeline.                               | L    |
| 9   | React app — Review + Config | Gates inbox with approve/reject. Metrics dashboard (recharts). Secrets CRUD. Settings page.                                                                                                       | M    |
| 10  | Versioning                  | Agent and workflow versions immutable after promotion. Run records pin workflow_version and agent_version. Version history UI in detail panels.                                                   | M    |
| 11  | Observability stack         | OTel instrumentation in API server and Python worker. Prometheus scrape config. Three Grafana dashboards provisioned via ConfigMap.                                                               | S    |
| 12  | Documentation               | DSL language reference with 5 annotated examples (trivial to advanced). Helm values reference. API reference (OpenAPI spec auto-generated from Hono routes). Deployment guide for air-gapped K8s. | M    |
| 13  | Hardening + security review | Secret injection audit. Presigned URL TTL enforcement. RBAC role tests. Rate limiting on API. Dependency audit. Load test: 50 concurrent runs.                                                    | M    |

## Work Ethic

* **Flow**:
  
  * Avoid getting stuck.
  
  * Background processes with sighup. Other models often block the UI.
  
  * Avoid interactive shells (ssh, kubectl) you wont be able to interact with.

* **Persevere**: 
  
  * Execute commands you're able to execute rather than delegating to the user.
  
  * Use a local tmp rather than one you don't have access to.
  
  * Read the logs of running processes (in terminal, docker, k8s, etc)

* **Verify**: 
  
  * Test all work. Untested work is not completed.
  
  * Save tests

Plan to add a dozen standard temporal activities to the worker.
/Users/scox/.claude/plans/piped-stirring-noodle.md