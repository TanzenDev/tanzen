import { describe, it, expect } from "bun:test";
import { lex } from "../../src/compiler/lexer.ts";
import { parse } from "../../src/compiler/parser.ts";
import { analyze } from "../../src/compiler/semantic.ts";

function check(source: string) {
  return analyze(parse(lex(source)));
}

function errors(source: string) {
  return check(source).map(e => e.message);
}

describe("semantic — valid workflows produce no errors", () => {
  it("trivial workflow", () => {
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
    expect(check(src)).toHaveLength(0);
  });

  it("workflow with gate and when condition", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        gate review {
          assignee: "alice@example.com"
        }
        step process {
          agent: proc-agent @ "1.0"
          when: review.approved
        }
      }
    `;
    expect(check(src)).toHaveLength(0);
  });

  it("workflow with params reference", () => {
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
    expect(check(src)).toHaveLength(0);
  });

  it("workflow with parallel forEach (anonymous template step)", () => {
    const src = `
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
    `;
    expect(check(src)).toHaveLength(0);
  });

  it("workflow with output artifact and retention", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        step analyze {
          agent: doc-parser @ "1.0"
        }
        output {
          artifact: analyze.output
          retention: 7y
        }
      }
    `;
    expect(check(src)).toHaveLength(0);
  });

  it("when: rejected is valid", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        gate review { assignee: "reviewer@example.com" }
        step onReject {
          agent: notify-agent @ "1.0"
          when: review.rejected
        }
      }
    `;
    expect(check(src)).toHaveLength(0);
  });
});

describe("semantic — error cases", () => {
  it("duplicate step IDs", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        step analyze { agent: doc-parser @ "1.0" }
        step analyze { agent: doc-parser @ "1.0" }
      }
    `;
    const errs = errors(src);
    expect(errs.some(e => e.includes("Duplicate ID"))).toBe(true);
  });

  it("when references unknown step", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        step process {
          agent: proc-agent @ "1.0"
          when: nonexistent.approved
        }
      }
    `;
    const errs = errors(src);
    expect(errs.some(e => e.includes("nonexistent"))).toBe(true);
  });

  it("when references invalid property (.output instead of .approved)", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        gate review { assignee: "reviewer@example.com" }
        step process {
          agent: proc-agent @ "1.0"
          when: review.output
        }
      }
    `;
    const errs = errors(src);
    expect(errs.some(e => e.includes("output") && e.includes("approved"))).toBe(true);
  });

  it("input references step.approved (invalid for step node)", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        step analyze { agent: doc-parser @ "1.0" }
        step process {
          agent: proc-agent @ "1.0"
          input: analyze.approved
        }
      }
    `;
    const errs = errors(src);
    expect(errs.some(e => e.includes("approved"))).toBe(true);
  });

  it("params reference without field name", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        gate review { assignee: params }
      }
    `;
    // "params" alone as a ref would fail to parse as a dotted path with field
    // This triggers semantic error: params reference must include a field name
    const errs = errors(src);
    // The gate assignee "params" is a ref with path "params" — no field
    expect(errs.some(e => e.includes("field name"))).toBe(true);
  });

  it("params reference to undeclared param", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        gate review {
          assignee: params.reviewer_email
        }
      }
    `;
    const errs = errors(src);
    expect(errs.some(e => e.includes("reviewer_email") && e.includes("not declared"))).toBe(true);
  });

  it("output artifact references unknown step", () => {
    const src = `
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        step analyze { agent: doc-parser @ "1.0" }
        output {
          artifact: nonexistent.output
        }
      }
    `;
    const errs = errors(src);
    expect(errs.some(e => e.includes("nonexistent"))).toBe(true);
  });
});
