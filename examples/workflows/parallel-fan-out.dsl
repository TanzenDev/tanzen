workflow ParallelFanOut {
  version: "1.0.0"

  parallel branches {
    step branch_a {
      agent: echo-agent @ "1.0"
      input: run.input
      timeout: 2m
    }
    step branch_b {
      agent: echo-agent @ "1.0"
      input: run.input
      timeout: 2m
    }
    step branch_c {
      agent: echo-agent @ "1.0"
      input: run.input
      timeout: 2m
    }
  }

  step collect {
    agent: echo-agent @ "1.0"
    input: run.input
    timeout: 2m
  }

  output {
    artifact: collect.output
  }
}
