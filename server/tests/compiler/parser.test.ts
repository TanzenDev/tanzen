import { describe, it, expect } from "bun:test";
import { lex } from "../../src/compiler/lexer.ts";
import { parse, ParseError } from "../../src/compiler/parser.ts";

function p(source: string) {
  return parse(lex(source));
}

const MINIMAL = `
workflow TrivialWorkflow {
  version: "1.0.0"
  triggers: [manual]
  step analyze {
    agent: document-parser @ "2.1"
  }
}
`;

describe("parser — minimal workflow", () => {
  it("parses name and version", () => {
    const ast = p(MINIMAL);
    expect(ast.name).toBe("TrivialWorkflow");
    expect(ast.version).toBe("1.0.0");
  });

  it("parses manual trigger", () => {
    const ast = p(MINIMAL);
    expect(ast.triggers).toHaveLength(1);
    expect(ast.triggers[0]!.kind).toBe("manual");
  });

  it("parses a basic step", () => {
    const ast = p(MINIMAL);
    expect(ast.items).toHaveLength(1);
    const step = ast.items[0]!;
    expect(step.kind).toBe("step");
    if (step.kind === "step") {
      expect(step.id).toBe("analyze");
      expect(step.agent.agentId).toBe("document-parser");
      expect(step.agent.version).toBe("2.1");
    }
  });
});

describe("parser — triggers", () => {
  it("parses webhook trigger", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [webhook("/api/start")]
        step s { agent: my-agent @ "1.0" }
      }
    `;
    const ast = p(src);
    expect(ast.triggers[0]).toMatchObject({ kind: "webhook", path: "/api/start" });
  });

  it("parses multiple triggers", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual, webhook("/hook")]
        step s { agent: my-agent @ "1.0" }
      }
    `;
    const ast = p(src);
    expect(ast.triggers).toHaveLength(2);
  });
});

describe("parser — params", () => {
  it("parses string param", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        params {
          reviewer_email: string
        }
        step s { agent: my-agent @ "1.0" }
      }
    `;
    const ast = p(src);
    expect(ast.params).toHaveLength(1);
    expect(ast.params[0]).toMatchObject({ name: "reviewer_email", type: "string" });
  });

  it("parses param with default", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        params {
          max_retries: number = 3
        }
        step s { agent: my-agent @ "1.0" }
      }
    `;
    const ast = p(src);
    const p0 = ast.params[0]!;
    expect(p0.name).toBe("max_retries");
    expect(p0.type).toBe("number");
    expect(p0.default).toMatchObject({ kind: "number", value: 3 });
  });
});

describe("parser — step properties", () => {
  it("parses step with input ref", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        step analyze {
          agent: doc-parser @ "1.0"
          input: run.input
        }
      }
    `;
    const ast = p(src);
    const step = ast.items[0]!;
    if (step.kind === "step") {
      expect(step.input).toMatchObject({ kind: "ref", path: "run.input" });
    }
  });

  it("parses step with string input", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        step analyze {
          agent: doc-parser @ "1.0"
          input: "static value"
        }
      }
    `;
    const ast = p(src);
    const step = ast.items[0]!;
    if (step.kind === "step") {
      expect(step.input).toMatchObject({ kind: "string", value: "static value" });
    }
  });

  it("parses step with retry and timeout", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        step analyze {
          agent: doc-parser @ "1.0"
          retry: 3
          timeout: 30m
        }
      }
    `;
    const ast = p(src);
    const step = ast.items[0]!;
    if (step.kind === "step") {
      expect(step.retry).toBe(3);
      expect(step.timeout).toMatchObject({ kind: "duration", seconds: 1800 });
    }
  });

  it("parses step with when condition", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        gate approval {
          assignee: "reviewer@example.com"
        }
        step process {
          agent: proc-agent @ "1.0"
          when: approval.approved
        }
      }
    `;
    const ast = p(src);
    const step = ast.items[1]!;
    if (step.kind === "step") {
      expect(step.when).toMatchObject({ kind: "ref", path: "approval.approved" });
    }
  });

  it("parses step with object params", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        step analyze {
          agent: doc-parser @ "1.0"
          params: { mode: "strict", limit: 10 }
        }
      }
    `;
    const ast = p(src);
    const step = ast.items[0]!;
    if (step.kind === "step") {
      expect(step.params?.kind).toBe("object");
      expect(step.params?.entries).toHaveLength(2);
    }
  });
});

describe("parser — gate", () => {
  it("parses gate with string assignee", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        gate review {
          assignee: "alice@example.com"
          timeout: 72h
        }
      }
    `;
    const ast = p(src);
    const gate = ast.items[0]!;
    if (gate.kind === "gate") {
      expect(gate.id).toBe("review");
      expect(gate.assignee).toMatchObject({ kind: "string", value: "alice@example.com" });
      expect(gate.timeout).toMatchObject({ kind: "duration", seconds: 259200 });
    }
  });

  it("parses gate with ref assignee", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        params { reviewer_email: string }
        gate review {
          assignee: params.reviewer_email
        }
      }
    `;
    const ast = p(src);
    const gate = ast.items[0]!;
    if (gate.kind === "gate") {
      expect(gate.assignee).toMatchObject({ kind: "ref", path: "params.reviewer_email" });
    }
  });
});

describe("parser — parallel", () => {
  it("parses parallel with static steps", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        parallel checks {
          step check_a { agent: checker-a @ "1.0" }
          step check_b { agent: checker-b @ "1.0" }
        }
      }
    `;
    const ast = p(src);
    const par = ast.items[0]!;
    if (par.kind === "parallel") {
      expect(par.steps).toHaveLength(2);
      expect(par.forEach).toBeUndefined();
    }
  });

  it("parses parallel forEach with anonymous template step", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        params { jurisdictions: string[] }
        parallel analyze {
          for jurisdiction in params.jurisdictions {
            step {
              agent: jurisdiction-analyzer @ "1.0"
              input: jurisdiction
            }
          }
        }
      }
    `;
    const ast = p(src);
    const par = ast.items[0]!;
    if (par.kind === "parallel") {
      expect(par.forEach).toBeDefined();
      expect(par.forEach?.var).toBe("jurisdiction");
      expect(par.forEach?.in).toMatchObject({ kind: "ref", path: "params.jurisdictions" });
      expect(par.forEach?.template).toBeDefined();
      expect(par.forEach?.template.id).toBe(""); // anonymous
    }
  });
});

describe("parser — output", () => {
  it("parses output with bare retention (7y)", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        step analyze { agent: doc-parser @ "1.0" }
        output {
          artifact: analyze.output
          retention: 7y
        }
      }
    `;
    const ast = p(src);
    const out = ast.items[1]!;
    if (out.kind === "output") {
      expect(out.artifact).toMatchObject({ kind: "ref", path: "analyze.output" });
      expect(out.retention).toMatchObject({ kind: "retention", days: 2555 });
    }
  });

  it("parses output with quoted retention", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        step analyze { agent: doc-parser @ "1.0" }
        output {
          artifact: analyze.output
          retention: "90d"
        }
      }
    `;
    const ast = p(src);
    const out = ast.items[1]!;
    if (out.kind === "output") {
      expect(out.retention).toMatchObject({ kind: "retention", days: 90 });
    }
  });
});

describe("parser — template strings", () => {
  it("parses template expression", () => {
    // Use string concat to avoid JS template literal interpretation of ${...}
    const src = [
      'workflow W {',
      '  version: "1.0.0"',
      '  triggers: [manual]',
      '  params { jurisdictions: string[] }',
      '  parallel analyze {',
      '    for jurisdiction in params.jurisdictions {',
      '      step {',
      '        agent: jurisdiction-analyzer @ "1.0"',
      '        input: "analyze_${jurisdiction}"',
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const ast = p(src);
    const par = ast.items[0]!;
    if (par.kind === "parallel" && par.forEach) {
      const input = par.forEach.template.input!;
      expect(input.kind).toBe("template");
      if (input.kind === "template") {
        expect(input.parts[0]).toBe("analyze_");
        expect(input.parts[1]).toMatchObject({ kind: "ref", path: "jurisdiction" });
      }
    }
  });
});

describe("parser — errors", () => {
  it("throws ParseError on missing workflow keyword", () => {
    expect(() => p("step foo { agent: a @ \"1\" }")).toThrow(ParseError);
  });

  it("throws ParseError on missing agent @ version", () => {
    expect(() => p(`workflow W { version: "1.0" triggers: [manual] step s { agent: my-agent } }`)).toThrow(ParseError);
  });
});
