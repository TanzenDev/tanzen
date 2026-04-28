workflow TranslationalSciencePipeline {
  version: "1.0.0"

  step extract_evidence {
    agent: literature-extractor @ "1.0"
    input: run.input
    timeout: 30m
  }

  step prioritise_targets {
    agent: target-prioritiser @ "1.0"
    input: extract_evidence.output
    timeout: 20m
  }

  step safety_screen {
    agent: safety-screener @ "1.0"
    input: prioritise_targets.output
    timeout: 15m
  }

  gate scientific_review {
    assignee: "pi@research.org"
    input: safety_screen.output
    timeout: 72h
  }

  step synthesise_protocol {
    agent: protocol-writer @ "1.0"
    input: safety_screen.output
    when: scientific_review.approved
    timeout: 20m
  }

  task format_report {
    action: "format_json"
    input: synthesise_protocol.output
  }

  output {
    artifact: format_report.output
  }
}
