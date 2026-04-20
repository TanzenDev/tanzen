import { describe, it, expect } from "bun:test";
import { lex } from "../../src/compiler/lexer.ts";
import { parse } from "../../src/compiler/parser.ts";
import { emit } from "../../src/compiler/emitter.ts";

function e(source: string) {
  return emit(parse(lex(source)));
}

describe("emitter — toKebab", () => {
  it("converts PascalCase to kebab-case", () => {
    const ir = e(`
      workflow MyWorkflow {
        version: "1.0.0"
        triggers: [manual]
        step s { agent: a @ "1.0" }
      }
    `);
    expect(ir.name).toBe("my-workflow");
  });

  it("handles multi-word PascalCase", () => {
    const ir = e(`
      workflow JurisdictionReviewWorkflow {
        version: "1.0.0"
        triggers: [manual]
        step s { agent: a @ "1.0" }
      }
    `);
    expect(ir.name).toBe("jurisdiction-review-workflow");
  });
});

describe("emitter — basic IR", () => {
  it("emits version", () => {
    const ir = e(`
      workflow W {
        version: "2.3.1"
        triggers: [manual]
        step s { agent: a @ "1.0" }
      }
    `);
    expect(ir.version).toBe("2.3.1");
  });

  it("emits agent step", () => {
    const ir = e(`
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        step analyze {
          agent: document-parser @ "2.1"
          input: run.input
          retry: 3
          timeout: 30m
        }
      }
    `);
    expect(ir.steps).toHaveLength(1);
    const step = ir.steps[0]!;
    expect(step).toMatchObject({
      id: "analyze",
      type: "agent",
      agentId: "document-parser",
      agentVersion: "2.1",
      input: { $ref: "run.input" },
      retry: 3,
      timeoutSeconds: 1800,
    });
  });

  it("emits gate step", () => {
    const ir = e(`
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        gate review {
          assignee: "alice@example.com"
          timeout: 72h
          input: run.input
        }
      }
    `);
    const step = ir.steps[0]!;
    expect(step).toMatchObject({
      id: "review",
      type: "gate",
      assignee: "alice@example.com",
      timeoutSeconds: 259200,
      input: { $ref: "run.input" },
    });
  });

  it("emits gate step with ref assignee", () => {
    const ir = e(`
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        params { reviewer_email: string }
        gate review {
          assignee: params.reviewer_email
        }
      }
    `);
    const step = ir.steps[0]!;
    if (step.type === "gate") {
      expect(step.assignee).toEqual({ $ref: "params.reviewer_email" });
    }
  });

  it("emits step with when condition", () => {
    const ir = e(`
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        gate review { assignee: "reviewer@example.com" }
        step process {
          agent: proc-agent @ "1.0"
          when: review.approved
        }
      }
    `);
    const step = ir.steps[1]!;
    if (step.type === "agent") {
      expect(step.when).toEqual({ $ref: "review.approved" });
    }
  });
});

describe("emitter — parallel", () => {
  it("emits parallel with static steps", () => {
    const ir = e(`
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        parallel checks {
          step check_a { agent: checker-a @ "1.0" }
          step check_b { agent: checker-b @ "1.0" }
        }
      }
    `);
    const par = ir.steps[0]!;
    expect(par.type).toBe("parallel");
    if (par.type === "parallel") {
      expect(par.steps).toHaveLength(2);
      expect(par.forEach).toBeUndefined();
    }
  });

  it("emits parallel forEach with anonymous template step", () => {
    const ir = e(`
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        params { jurisdictions: string[] }
        parallel analyze {
          for jurisdiction in params.jurisdictions {
            step {
              agent: jur-analyzer @ "1.0"
              input: jurisdiction
            }
          }
        }
      }
    `);
    const par = ir.steps[0]!;
    expect(par.type).toBe("parallel");
    if (par.type === "parallel") {
      expect(par.forEach).toMatchObject({
        var: "jurisdiction",
        in: { $ref: "params.jurisdictions" },
      });
      expect(par.template).toBeDefined();
    }
  });
});

describe("emitter — output", () => {
  it("emits output with retention", () => {
    const ir = e(`
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        step analyze { agent: doc-parser @ "1.0" }
        output {
          artifact: analyze.output
          retention: 7y
        }
      }
    `);
    expect(ir.output).toMatchObject({
      artifact: { $ref: "analyze.output" },
      retentionDays: 2555,
    });
  });

  it("emits output without retention", () => {
    const ir = e(`
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        step analyze { agent: doc-parser @ "1.0" }
        output {
          artifact: analyze.output
        }
      }
    `);
    expect(ir.output).toMatchObject({ artifact: { $ref: "analyze.output" } });
    expect(ir.output!.retentionDays).toBeUndefined();
  });
});

describe("emitter — params", () => {
  it("emits params with defaults", () => {
    const ir = e(`
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        params {
          max_retries: number = 3
          strict: boolean = true
        }
        step s { agent: a @ "1.0" }
      }
    `);
    expect(ir.params).toMatchObject({ max_retries: 3, strict: true });
  });

  it("emits params type string as placeholder when no default", () => {
    const ir = e(`
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        params {
          reviewer_email: string
        }
        step s { agent: a @ "1.0" }
      }
    `);
    expect(ir.params).toMatchObject({ reviewer_email: "string" });
  });

  it("omits params block when no params", () => {
    const ir = e(`
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        step s { agent: a @ "1.0" }
      }
    `);
    expect(ir.params).toBeUndefined();
  });
});

describe("emitter — template strings", () => {
  it("serializes template refs as ${path} strings", () => {
    const src = [
      'workflow W {',
      '  version: "1.0.0"',
      '  triggers: [manual]',
      '  params { jurisdictions: string[] }',
      '  parallel analyze {',
      '    for jurisdiction in params.jurisdictions {',
      '      step {',
      '        agent: jur-analyzer @ "1.0"',
      '        input: "analyze_${jurisdiction}"',
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const ir = e(src);
    const par = ir.steps[0]!;
    if (par.type === "parallel" && par.template) {
      expect(par.template.input).toBe("analyze_${jurisdiction}");
    }
  });
});
