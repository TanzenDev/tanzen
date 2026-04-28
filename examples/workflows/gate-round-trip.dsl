workflow GateRoundTrip {
  version: "1.0.0"

  step draft {
    agent: echo-agent @ "1.0"
    input: run.input
    timeout: 5m
  }

  gate review {
    assignee: "reviewer@example.com"
    input: draft.output
    timeout: 24h
  }

  step finalise {
    agent: echo-agent @ "1.0"
    input: draft.output
    when: review.approved
    timeout: 5m
  }

  output {
    artifact: finalise.output
  }
}
