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
