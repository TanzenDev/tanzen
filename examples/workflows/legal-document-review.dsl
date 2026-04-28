workflow LegalDocumentReview {
  version: "1.0.0"

  step extract_clauses {
    agent: clause-extractor @ "1.0"
    input: run.input
    timeout: 15m
  }

  step risk_analysis {
    agent: risk-analyst @ "1.0"
    input: extract_clauses.output
    timeout: 15m
  }

  step generate_redlines {
    agent: redline-drafter @ "1.0"
    input: risk_analysis.output
    timeout: 20m
  }

  gate associate_review {
    assignee: "associate@lawfirm.com"
    input: generate_redlines.output
    timeout: 48h
  }

  gate partner_review {
    assignee: "partner@lawfirm.com"
    input: generate_redlines.output
    timeout: 48h
  }

  step escalation_memo {
    agent: echo-agent @ "1.0"
    input: risk_analysis.output
    when: associate_review.rejected
    timeout: 10m
  }

  step client_summary {
    agent: echo-agent @ "1.0"
    input: generate_redlines.output
    when: partner_review.approved
    timeout: 10m
  }

  task audit_record {
    action: "format_json"
    input: client_summary.output
  }

  output {
    artifact: audit_record.output
  }
}
