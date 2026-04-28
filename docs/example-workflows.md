# Example Workflows

Three categories: smoke-test harness, translational science, and legal document review.

---

## 1. Testing Workflows

### 1a. Echo (minimal smoke test)

Verifies the runtime can start a run, execute a single agent step, and record output.
Requires an agent named `echo-agent` whose system prompt instructs it to repeat its input verbatim.

```
workflow Echo {
  version: "1.0.0"

  step echo {
    agent: echo-agent @ "1.0"
    input: run.input
    timeout: 2m
  }

  output {
    artifact: echo.output
  }
}
```

**Run with:** `{"text": "hello world"}`
**Expected:** output artifact contains `"hello world"`.

---

### 1b. Gate round-trip

Tests the full gate signal path: agent → gate (human review) → agent continues on approval.

```
workflow GateRoundTrip {
  version: "1.0.0"

  step draft {
    agent: drafting-agent @ "1.0"
    input: run.input
    timeout: 5m
  }

  gate review {
    assignee: "reviewer@example.com"
    input: draft.output
    timeout: 24h
  }

  step finalise {
    agent: drafting-agent @ "1.0"
    input: draft.output
    when: review.approved
    timeout: 5m
  }

  output {
    artifact: finalise.output
  }
}
```

**Run with:** `{"text": "Draft a one-paragraph summary of the water cycle."}`
**Approve via:** `POST /api/gates/<gate_id>/resolve` `{"approved": true, "notes": "LGTM"}`

---

### 1c. Parallel fan-out

Tests static parallel execution — all branches must complete before output is written.

```
workflow ParallelFanOut {
  version: "1.0.0"

  parallel branches {
    step branch_a {
      agent: echo-agent @ "1.0"
      input: run.input
    }
    step branch_b {
      agent: echo-agent @ "1.0"
      input: run.input
    }
    step branch_c {
      agent: echo-agent @ "1.0"
      input: run.input
    }
  }

  task merge {
    action: "format_json"
    input: branch_a.output
  }

  output {
    artifact: merge.output
  }
}
```

---

### 1d. Script step smoke test

Verifies Pyodide/Deno sandboxed code execution. Requires `AGENT_CODE_EXECUTION_ENABLED=true`
and a script named `transform` uploaded via `POST /api/scripts`.

```
workflow ScriptSmokeTest {
  version: "1.0.0"

  script transform_step {
    name: "transform"
    input: run.input
    params: {"operation": "uppercase"}
    timeout: 30s
  }

  output {
    artifact: transform_step.output
  }
}
```

---

## 2. Translational Science Workflow

Models the translational pipeline from literature discovery through target prioritisation
and protocol synthesis, with a regulatory gate before final output.

```
workflow TranslationalSciencePipeline {
  version: "1.0.0"

  # Stage 1: structured literature extraction
  step extract_evidence {
    agent: literature-extractor @ "1.0"
    input: run.input
    timeout: 30m
  }

  # Stage 2: identify and score candidate targets
  step prioritise_targets {
    agent: target-prioritiser @ "1.0"
    input: extract_evidence.output
    timeout: 20m
  }

  # Stage 3: cross-reference with safety databases
  step safety_screen {
    agent: safety-screener @ "1.0"
    input: prioritise_targets.output
    timeout: 15m
  }

  # Stage 4: scientific review gate before protocol generation
  gate scientific_review {
    assignee: "pi@research.org"
    input: safety_screen.output
    timeout: 72h
  }

  # Stage 5: generate experimental protocol (only on approval)
  step synthesise_protocol {
    agent: protocol-writer @ "1.0"
    input: safety_screen.output
    when: scientific_review.approved
    timeout: 20m
  }

  # Stage 6: format deliverable
  task format_report {
    action: "format_json"
    input: synthesise_protocol.output
  }

  output {
    artifact: format_report.output
    retention_days: 365
  }
}
```

**Input schema:**
```json
{
  "query": "KRAS G12C inhibitors in non-small-cell lung cancer",
  "date_range": "2020-2024",
  "databases": ["PubMed", "ClinicalTrials.gov"],
  "target_indication": "NSCLC",
  "safety_flags": ["cardiotoxicity", "hepatotoxicity"]
}
```

**Agents required:**

| Agent | Role | Suggested model | MCP servers |
|-------|------|-----------------|-------------|
| `literature-extractor` | PubMed / EuropePMC retrieval and structured extraction | claude-3-5-sonnet | fetch, graphiti |
| `target-prioritiser` | Ranks targets by novelty, druggability, and evidence quality | claude-3-5-sonnet | graphiti |
| `safety-screener` | Cross-references FDA FAERS, ChEMBL, known off-targets | claude-3-5-sonnet | fetch |
| `protocol-writer` | Generates structured assay/in-vivo protocol | claude-opus-4 | — |

---

## 3. Legal Document Review Workflow

Automates multi-stage contract review: clause extraction → risk analysis → redline generation
→ partner sign-off → client-ready summary.

```
workflow LegalDocumentReview {
  version: "1.0.0"

  # Stage 1: extract and classify all clauses
  step extract_clauses {
    agent: clause-extractor @ "1.0"
    input: run.input
    timeout: 15m
  }

  # Stage 2: flag non-standard and high-risk clauses
  step risk_analysis {
    agent: risk-analyst @ "1.0"
    input: extract_clauses.output
    timeout: 15m
  }

  # Stage 3: generate redline suggestions
  step generate_redlines {
    agent: redline-drafter @ "1.0"
    input: risk_analysis.output
    timeout: 20m
  }

  # Stage 4: senior associate review gate
  gate associate_review {
    assignee: "associate@lawfirm.com"
    input: generate_redlines.output
    timeout: 48h
  }

  # Stage 5a: partner review (only if associate approved)
  gate partner_review {
    assignee: "partner@lawfirm.com"
    input: generate_redlines.output
    when: associate_review.approved
    timeout: 48h
  }

  # Stage 5b: escalation path on associate rejection
  step escalation_memo {
    agent: memo-writer @ "1.0"
    input: risk_analysis.output
    when: associate_review.rejected
    timeout: 10m
  }

  # Stage 6: client-ready summary (only after partner approval)
  step client_summary {
    agent: summary-writer @ "1.0"
    input: generate_redlines.output
    when: partner_review.approved
    timeout: 10m
  }

  # Stage 7: metadata / housekeeping
  task audit_record {
    action: "format_json"
    input: client_summary.output
    params: {"include_metadata": true}
  }

  output {
    artifact: audit_record.output
    retention_days: 2555
  }
}
```

**Input schema:**
```json
{
  "document_type": "Master Services Agreement",
  "party": "Acme Corp",
  "counterparty": "Vendor Ltd",
  "jurisdiction": "England and Wales",
  "document_text": "<full contract text or S3 key>",
  "risk_threshold": "medium",
  "firm_playbook": "standard-msa-v3"
}
```

**Agents required:**

| Agent | Role | Suggested model | Notes |
|-------|------|-----------------|-------|
| `clause-extractor` | Structured extraction of clause type, text, and party obligations | claude-3-5-sonnet | System prompt includes firm clause taxonomy |
| `risk-analyst` | Scores each clause against firm playbook; flags deviations | claude-3-5-sonnet | Provide playbook as system prompt context |
| `redline-drafter` | Generates tracked-changes text for flagged clauses | claude-opus-4 | Output format: JSON array of `{original, suggested, rationale}` |
| `memo-writer` | Escalation summary for partner when associate rejects | claude-3-5-haiku | Short output, fast |
| `summary-writer` | Plain-English client-facing summary of key commercial terms | claude-3-5-sonnet | — |
