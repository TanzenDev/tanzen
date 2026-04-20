# Tanzen DSL Language Reference

## Introduction

The Tanzen DSL is a TypeScript-like workflow definition language that lets domain experts
describe multi-agent workflows without writing code. Source files are compiled by the
Tanzen API server into a JSON Intermediate Representation (IR) that the Temporal dynamic
workflow interpreter executes at runtime.

### Compilation pipeline

```
DSL source text
    │
    ▼  Lexer (lexer.ts)
Token stream
    │
    ▼  Parser (parser.ts)
WorkflowNode AST
    │
    ▼  Semantic analyzer (semantic.ts)
Validated AST  ──► CompileError[] (on failure)
    │
    ▼  Emitter (emitter.ts)
JSON IR document  ──► Temporal DynamicWorkflow
```

The compiler runs in-process inside the Hono/Bun API server (Nearley-style recursive
descent, written in TypeScript). Compilation happens on every `POST /api/workflows` and
`POST /api/workflows/:id/compile` call.

---

## Grammar Reference

### Top-level: `workflow`

Every DSL file is a single workflow declaration.

```
workflow <Name> {
  version: "<semver>"         // required
  triggers: [...]             // optional
  params { ... }              // optional

  step | parallel | gate | output
  ...
}
```

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `version` | yes | string (semver) | Workflow version label. Stored with every run record. |
| `triggers` | no | trigger list | How the workflow can be started. Defaults to empty (manual only). |
| `params` | no | params block | Typed parameters the caller must supply at run time. |
| body items | yes | step/parallel/gate/output | At least one step is expected. |

**Name:** PascalCase identifier. The compiler converts it to kebab-case for the IR `name`
field (e.g. `ContractExtract` → `"contract-extract"`).

---

### `triggers`

```
triggers: [manual, webhook("/path")]
```

| Trigger | Syntax | Description |
|---------|--------|-------------|
| `manual` | `manual` | Workflow can be started via the UI or `POST /api/workflows/:id/runs`. |
| `webhook` | `webhook("/ingest/contract")` | Workflow is also started by an HTTP POST to the given path. |

Multiple triggers may be combined: `triggers: [manual, webhook("/ingest/contract")]`.

---

### `params`

```
params {
  name: type [= default]
  ...
}
```

| Type keyword | IR type | Notes |
|---|---|---|
| `string` | `"string"` | Single string value |
| `string[]` | emits default array | Array of strings |
| `number` | `"number"` | Integer |
| `boolean` | `"boolean"` | `true` / `false` |

Default values use expression syntax (see Expressions below). A param with no default
is required at run invocation time.

```
params {
  reviewer_email: string
  jurisdictions: string[] = ["US", "EU"]
  max_pages: number = 50
}
```

---

### `step`

An agent activity step. Executes a single versioned agent as a Temporal activity.

```
step <id> {
  agent:   <agent-id> @ "<version>"
  input:   <expr>          // optional
  params:  { key: expr }   // optional, agent-specific params
  retry:   <number>        // optional, default 1
  when:    <ref>           // optional conditional
  timeout: <duration>      // optional
}
```

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `agent` | yes | agent reference | Which agent to run and at which version. |
| `input` | no | expression | Data passed to the agent as its primary input. |
| `params` | no | object literal | Additional named parameters for the agent. |
| `retry` | no | number | Max Temporal activity attempts (default: 1). |
| `when` | no | reference | Step only executes if this expression is truthy. Must reference `<gateId>.approved` or `<gateId>.rejected`. |
| `timeout` | no | duration | Temporal start-to-close timeout for the activity. |

**Agent reference syntax:** `agent-name @ "version"`. Agent names are kebab-case. The
version string matches a version stored in the agents table.

---

### `parallel`

Executes multiple agent steps concurrently. Steps within a parallel block fan out
immediately and join when all complete.

**Static form** — fixed set of steps (minimum two):

```
parallel <id> {
  step <stepA> { agent: ... }
  step <stepB> { agent: ... }
}
```

**forEach form** — dynamic fan-out over a parameter array:

```
parallel <id> {
  for <var> in <ref> {
    step {
      agent: <agent-id> @ "<version>"
      params: { key: <var> }
    }
  }
}
```

The `for` variable is available as a bare reference inside the template step body.
Template step IDs may use `${var}` interpolation to produce unique IDs at runtime
(e.g. `analyze_${jurisdiction}`).

The `ref` in `for x in ref` must point to a `params.*` array or `run.*` array.

The parallel block's `output` reference resolves to an array of the individual step
outputs, ordered by iteration.

---

### `gate`

A human review gate. Execution pauses until a reviewer approves or rejects via the API
(which sends a Temporal signal to resume the workflow).

```
gate <id> {
  assignee: <ref-or-string>   // required
  timeout:  <duration>        // optional
  input:    <expr>            // optional, shown to the reviewer
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `assignee` | yes | Email or `params.*` reference identifying the reviewer. |
| `timeout` | no | How long to wait before timing out the gate (e.g. `72h`). |
| `input` | no | Artifact or data presented to the reviewer for context. |

After resolution, a gate exposes three properties:

| Reference | Type | Description |
|-----------|------|-------------|
| `gateId.approved` | boolean | `true` if the reviewer approved |
| `gateId.rejected` | boolean | `true` if the reviewer rejected |
| `gateId.notes` | string | Optional reviewer notes (may be empty) |

---

### `output`

Declares the final run artifact and its retention policy.

```
output {
  artifact:  <ref>       // required — must reference a step or gate output
  retention: <duration>  // optional
}
```

Retention accepts year (`y`) or day (`d`) suffixes: `"7y"`, `"90d"`. The compiler
converts to `retentionDays` in the IR (1 year = 365 days).

At most one `output` block is allowed per workflow.

---

### Expressions

Expressions appear as values in `input:`, `params:`, `assignee:`, and default values.

| Form | Example | Description |
|------|---------|-------------|
| String literal | `"hello"` | Quoted string. Newlines not allowed. |
| Number literal | `42` | Integer. |
| Boolean | `true` / `false` | |
| Duration | `72h`, `30m`, `7d`, `60s` | Converted to seconds in the IR. |
| Reference | `run.input`, `params.x`, `stepId.output` | Dotted path resolved at runtime. |
| Object | `{ key: expr, ... }` | Inline object. |
| Array | `["US", "EU"]` | Inline array. |
| Template string | `"analyze_${jurisdiction}"` | String with embedded reference(s). |

**Valid reference roots:**

| Root | Resolves to |
|------|-------------|
| `run.input` | The payload passed to `POST /api/workflows/:id/runs` |
| `params.<name>` | A declared workflow parameter |
| `<stepId>.output` | Output artifact of a completed step or parallel block |
| `<gateId>.approved` | Gate approval boolean |
| `<gateId>.rejected` | Gate rejection boolean |
| `<gateId>.notes` | Gate reviewer notes string |
| `<loopVar>` (bare) | Current iteration value inside a `for` block |

---

### Duration syntax

Durations appear in `retry`, `timeout`, and `gate.timeout` fields.

| Suffix | Meaning | Example | Seconds |
|--------|---------|---------|---------|
| `s` | seconds | `60s` | 60 |
| `m` | minutes | `30m` | 1800 |
| `h` | hours | `72h` | 259200 |
| `d` | days | `7d` | 604800 |

---

### Comments

```
// Single-line comment
/* Multi-line
   comment */
```

---

## JSON IR Format

The compiler emits a JSON IR document that the Temporal `DynamicWorkflow` interpreter
reads at workflow execution time. You will not normally write this directly, but
understanding it aids debugging.

### Top-level IR object

```json
{
  "name": "contract-due-diligence",
  "version": "1.2.0",
  "params": { "reviewer_email": "string", "jurisdictions": ["US", "EU"] },
  "steps": [ ... ],
  "output": { "artifact": { "$ref": "synthesize.output" }, "retentionDays": 2555 }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Kebab-cased workflow name |
| `version` | string | Version from DSL |
| `params` | object | Param names → type string or default value |
| `steps` | IRStep[] | Ordered sequence of steps |
| `output` | IROutput? | Optional output declaration |

### Reference value: `{ "$ref": "path" }`

Wherever the DSL uses a reference expression, the IR emits `{ "$ref": "dotted.path" }`.
The Temporal runtime resolves these against the run state at execution time.

### Agent step IR

```json
{
  "id": "extract",
  "type": "agent",
  "agentId": "document-parser",
  "agentVersion": "2.1",
  "input": { "$ref": "run.input" },
  "retry": 3,
  "when": { "$ref": "human_review.approved" },
  "timeoutSeconds": 1800
}
```

### Parallel step IR (forEach form)

```json
{
  "id": "analyze",
  "type": "parallel",
  "forEach": {
    "var": "jurisdiction",
    "in": { "$ref": "params.jurisdictions" }
  },
  "template": {
    "id": "analyze_${jurisdiction}",
    "type": "agent",
    "agentId": "legal-analyst",
    "agentVersion": "1.4",
    "params": {
      "jurisdiction": { "$ref": "jurisdiction" },
      "doc": { "$ref": "extract.output" }
    }
  }
}
```

### Parallel step IR (static form)

```json
{
  "id": "checks",
  "type": "parallel",
  "steps": [
    { "id": "check-a", "type": "agent", "agentId": "checker-a", "agentVersion": "1.0" },
    { "id": "check-b", "type": "agent", "agentId": "checker-b", "agentVersion": "1.0" }
  ]
}
```

### Gate step IR

```json
{
  "id": "human_review",
  "type": "gate",
  "assignee": { "$ref": "params.reviewer_email" },
  "timeoutSeconds": 259200,
  "input": { "$ref": "analyze.output" }
}
```

### Output IR

```json
{
  "artifact": { "$ref": "synthesize.output" },
  "retentionDays": 2555
}
```

---

## Annotated Examples

### Example 1 — Trivial: single step

The simplest valid workflow: one agent step, no params, no output block.

```typescript
workflow ContractExtract {
  version: "1.0.0"

  step extract {
    agent: document-parser @ "2.1"  // agent ID @ version string
    input: run.input                // pass the run invocation payload directly
  }

  output {
    artifact: extract.output        // publish the step's output as the run artifact
  }
}
```

**What happens at runtime:**
1. The Temporal `DynamicWorkflow` receives the IR and empty params.
2. It dispatches the `run_agent_activity` for the `extract` step.
3. The Python worker loads `document-parser` version `2.1` from SeaweedFS, runs it against
   `run.input`, and writes the output artifact to SeaweedFS.
4. The artifact reference is stored as the run output.

**Compiled IR:**

```json
{
  "name": "contract-extract",
  "version": "1.0.0",
  "steps": [
    {
      "id": "extract",
      "type": "agent",
      "agentId": "document-parser",
      "agentVersion": "2.1",
      "input": { "$ref": "run.input" }
    }
  ],
  "output": {
    "artifact": { "$ref": "extract.output" }
  }
}
```

---

### Example 2 — Simple: two steps with output passing

Two sequential steps where the second receives the first step's output.

```typescript
workflow TriageAndSummarize {
  version: "1.0.0"

  step triage {
    agent: triage-agent @ "1.0"
    input: run.input
    retry: 2                   // retry the Temporal activity up to 2 times on failure
  }

  step summarize {
    agent: summary-agent @ "1.0"
    input: triage.output       // reference the previous step's output
  }

  output {
    artifact: summarize.output
    retention: "90d"           // retain artifact for 90 days
  }
}
```

**Key patterns:**
- `retry: 2` configures the Temporal activity retry policy (2 total attempts).
- `triage.output` is a step output reference — `triage` must be declared before
  `summarize` in the file.
- `retention: "90d"` emits `retentionDays: 90` in the IR output block.

**Compiled IR:**

```json
{
  "name": "triage-and-summarize",
  "version": "1.0.0",
  "steps": [
    {
      "id": "triage",
      "type": "agent",
      "agentId": "triage-agent",
      "agentVersion": "1.0",
      "input": { "$ref": "run.input" },
      "retry": 2
    },
    {
      "id": "summarize",
      "type": "agent",
      "agentId": "summary-agent",
      "agentVersion": "1.0",
      "input": { "$ref": "triage.output" }
    }
  ],
  "output": {
    "artifact": { "$ref": "summarize.output" },
    "retentionDays": 90
  }
}
```

---

### Example 3 — Conditional: step with `when` clause

A step that only runs if a preceding gate was approved.

```typescript
workflow SignalReview {
  version: "2.0.0"
  triggers: [manual]

  params {
    reviewer_email: string
    signal_threshold: number = 5
  }

  step classify {
    agent: signal-classifier @ "1.2"
    input: run.input
    params: { threshold: params.signal_threshold }
  }

  gate medical_review {
    assignee: params.reviewer_email
    timeout: 48h
    input: classify.output
  }

  // Only runs if the reviewer approved the gate.
  // If the gate is rejected, this step is skipped and the workflow completes
  // with no synthesize output.
  step synthesize {
    agent: narrative-agent @ "1.0"
    when: medical_review.approved     // conditional guard
    input: {
      classification: classify.output
      reviewer_notes: medical_review.notes
    }
  }

  output {
    artifact: synthesize.output
    retention: "7y"
  }
}
```

**Key patterns:**
- `when: medical_review.approved` — the step runs only if the gate boolean is truthy.
  The `when` field must reference `.approved` or `.rejected` on a gate.
- `medical_review.notes` — passes the reviewer's optional notes to the next agent.
- Params can have defaults (`signal_threshold: number = 5`) that are overridden at
  invocation time.

---

### Example 4 — Parallel: static fan-out

Two independent checks run in parallel, joined before a synthesis step.

```typescript
workflow ComplianceCheck {
  version: "1.0.0"
  triggers: [manual, webhook("/ingest/compliance")]

  step ingest {
    agent: document-ingest @ "1.0"
    input: run.input
  }

  // Both checks run concurrently. The parallel block completes when
  // BOTH check-hipaa and check-gdpr have finished.
  parallel compliance_checks {
    step check-hipaa {
      agent: hipaa-checker @ "2.0"
      input: ingest.output
    }
    step check-gdpr {
      agent: gdpr-checker @ "1.3"
      input: ingest.output
    }
  }

  step synthesize {
    agent: compliance-synthesis @ "1.0"
    // compliance_checks.output is an array: [hipaa_result, gdpr_result]
    input: compliance_checks.output
  }

  output {
    artifact: synthesize.output
  }
}
```

**Key patterns:**
- Static `parallel` block requires at least two `step` children — the semantic analyzer
  enforces this.
- `compliance_checks.output` resolves to an ordered array of outputs `[hipaa, gdpr]`.
- The `webhook` trigger enables external systems to POST to `/ingest/compliance` to
  trigger a run.

---

### Example 5 — Advanced: forEach parallel + gate + conditional synthesis

The full `ContractDueDiligence` example from the product spec, fully annotated.

```typescript
workflow ContractDueDiligence {
  version: "1.2.0"
  triggers: [manual, webhook("/ingest/contract")]

  // Parameters that callers must (or may) supply at run time.
  params {
    reviewer_email: string              // no default — required
    jurisdictions: string[] = ["US", "EU"]  // optional — defaults to US + EU
  }

  // Step 1: Extract structured data from the contract document.
  step extract {
    agent: document-parser @ "2.1"
    input: run.input
    retry: 3                            // up to 3 Temporal activity attempts
  }

  // Step 2: Fan-out — one analysis per jurisdiction, run in parallel.
  // The `for` loop expands at runtime based on params.jurisdictions length.
  // Each iteration produces a step with ID "analyze_US", "analyze_EU", etc.
  parallel analyze {
    for jurisdiction in params.jurisdictions {
      step {
        agent: legal-analyst @ "1.4"
        params: {
          jurisdiction: jurisdiction    // bare loop variable reference
          doc: extract.output           // outer step reference still valid here
        }
      }
    }
  }

  // Step 3: Human gate — blocks until reviewer approves or rejects.
  gate human_review {
    assignee: params.reviewer_email
    timeout: 72h                        // 259200 seconds in IR
    input: analyze.output               // pass all jurisdiction analyses to reviewer
  }

  // Step 4: Final synthesis — only runs if the reviewer approved.
  step synthesize {
    agent: synthesis-agent @ "1.0"
    when: human_review.approved         // skipped entirely if gate is rejected
    input: {
      analyses: analyze.output          // array of jurisdiction analyses
      notes: human_review.notes         // reviewer commentary
    }
  }

  output {
    artifact: synthesize.output
    retention: "7y"                     // 2555 retentionDays in IR (7 * 365)
  }
}
```

**Runtime execution sequence:**
1. Caller POSTs to `POST /api/workflows/:id/runs` with `{ "params": { "reviewer_email": "...", "jurisdictions": ["US", "EU", "JP"] } }`.
2. Temporal starts `DynamicWorkflow` with the IR and supplied params.
3. `extract` runs as a single activity.
4. `analyze` fans out to three concurrent activities (US, EU, JP).
5. All three must complete before `human_review` gate opens.
6. Gate waits up to 72 hours for a reviewer signal.
7. On approval, `synthesize` runs; on rejection, `synthesize` is skipped.
8. `write_output_activity` writes the final artifact with 7-year retention.

**Compiled IR:**

```json
{
  "name": "contract-due-diligence",
  "version": "1.2.0",
  "params": {
    "reviewer_email": "string",
    "jurisdictions": ["US", "EU"]
  },
  "steps": [
    {
      "id": "extract",
      "type": "agent",
      "agentId": "document-parser",
      "agentVersion": "2.1",
      "input": { "$ref": "run.input" },
      "retry": 3
    },
    {
      "id": "analyze",
      "type": "parallel",
      "forEach": {
        "var": "jurisdiction",
        "in": { "$ref": "params.jurisdictions" }
      },
      "template": {
        "id": "analyze_${jurisdiction}",
        "type": "agent",
        "agentId": "legal-analyst",
        "agentVersion": "1.4",
        "params": {
          "jurisdiction": { "$ref": "jurisdiction" },
          "doc": { "$ref": "extract.output" }
        }
      }
    },
    {
      "id": "human_review",
      "type": "gate",
      "assignee": { "$ref": "params.reviewer_email" },
      "timeoutSeconds": 259200,
      "input": { "$ref": "analyze.output" }
    },
    {
      "id": "synthesize",
      "type": "agent",
      "agentId": "synthesis-agent",
      "agentVersion": "1.0",
      "when": { "$ref": "human_review.approved" },
      "input": {
        "analyses": { "$ref": "analyze.output" },
        "notes": { "$ref": "human_review.notes" }
      }
    }
  ],
  "output": {
    "artifact": { "$ref": "synthesize.output" },
    "retentionDays": 2555
  }
}
```

---

## Error Message Reference

Errors are returned as a JSON array of `CompileError` objects:

```json
[
  {
    "line": 12,
    "column": 5,
    "message": "Step 'extract' is missing 'agent'",
    "severity": "error"
  }
]
```

### Lexer errors

| Message | Cause |
|---------|-------|
| `Unexpected character: '<ch>'` | Character not valid in DSL syntax |
| `Unterminated string literal` | String opened with `"` but not closed before end of line or file |

### Parser errors

| Message | Cause |
|---------|-------|
| `Expected <X> but got '<Y>' (<kind>)` | Token mismatch; common with missing colons or braces |
| `Expected identifier but got '<Y>'` | Keyword used where an identifier was expected |
| `Expected identifier after '.'` | Dotted path has a trailing dot |
| `Unknown trigger type '<name>'` | Trigger is not `manual` or `webhook` |
| `Expected param type (string, number, boolean) but got '<X>'` | Invalid type keyword in params block |
| `Step is missing an ID` | Step in a non-forEach context has no identifier |
| `Step '<id>' is missing 'agent'` | Agent reference omitted from step body |
| `Unknown step field '<key>'` | Unrecognized key inside a step block |
| `'for … in' requires a reference expression` | forEach `in` expression is not a reference |
| `Parallel block '<id>' must contain at least two steps (got N)` | Static parallel has fewer than 2 children |
| `Gate '<id>' is missing 'assignee'` | Gate body has no `assignee` field |
| `Unknown gate field '<key>'` | Unrecognized key inside a gate block |
| `'artifact' must be a reference like stepId.output` | Output artifact is not a reference |
| `Output block is missing 'artifact'` | Output block has no `artifact` field |
| `Unknown workflow field '<key>'` | Unrecognized top-level key inside workflow body |
| `Unknown workflow item '<key>'` | Item is not `step`, `parallel`, `gate`, or `output` |
| `'when' must be a reference expression like stepId.approved` | `when` value is a literal, not a reference |
| `Invalid retention value '<val>'` | Retention string doesn't match `Nd` or `Ny` format |
| `Invalid duration '<val>'` | Duration token doesn't match `N[hmsd]` format |

### Semantic errors

| Message | Cause |
|---------|-------|
| `Duplicate ID '<id>': step, parallel, and gate IDs must be unique` | Two items share the same ID |
| `<context>: references unknown step or variable '<name>'` | Reference root is not a declared step, gate, parallel, or param |
| `<context>: param '<name>' is not declared in params block` | `params.<name>` reference but `<name>` not in the params block |
| `<context>: 'params' reference must include a field name` | Bare `params` reference without a field |
| `<context>: '<kind>' '<id>' does not have property '<prop>' (allowed: ...)` | Property accessed on a step/gate is not valid for that node type |
| `<context> 'when' should reference .approved or .rejected (got .<prop>)` | `when` points to something other than a gate approval/rejection |
