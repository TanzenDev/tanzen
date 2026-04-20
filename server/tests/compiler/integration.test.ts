import { describe, it, expect } from "bun:test";
import { compile } from "../../src/compiler/index.ts";

// ---------------------------------------------------------------------------
// Trivial workflow
// ---------------------------------------------------------------------------
const TRIVIAL_SRC = `
workflow TrivialWorkflow {
  version: "1.0.0"
  triggers: [manual]

  step analyze {
    agent: document-parser @ "2.1"
    input: run.input
    retry: 3
    timeout: 30m
  }
}
`;

describe("integration — trivial workflow", () => {
  it("compiles successfully", () => {
    const result = compile(TRIVIAL_SRC);
    expect(result.ok).toBe(true);
  });

  it("emits correct IR shape", () => {
    const result = compile(TRIVIAL_SRC);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));

    expect(result.ir).toMatchObject({
      name: "trivial-workflow",
      version: "1.0.0",
      steps: [
        {
          id: "analyze",
          type: "agent",
          agentId: "document-parser",
          agentVersion: "2.1",
          input: { $ref: "run.input" },
          retry: 3,
          timeoutSeconds: 1800,
        },
      ],
    });
    expect(result.ir.params).toBeUndefined();
    expect(result.ir.output).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Full parallel-gate workflow (regulatory review example)
// ---------------------------------------------------------------------------
const FULL_SRC = `
workflow RegulatoryReview {
  version: "2.0.0"
  triggers: [manual, webhook("/hooks/regulatory")]

  params {
    jurisdictions: string[]
    reviewer_email: string
    max_pages: number = 100
  }

  // Parse the submitted document
  step parse {
    agent: document-parser @ "2.1"
    input: run.input
    retry: 3
    timeout: 30m
  }

  // Analyze each jurisdiction in parallel
  parallel analyze {
    for jurisdiction in params.jurisdictions {
      step {
        agent: jurisdiction-analyzer @ "1.4"
        input: "analyze_\${jurisdiction}"
        params: { source: parse.output, pages: params.max_pages }
      }
    }
  }

  // Human review gate
  gate legalReview {
    assignee: params.reviewer_email
    timeout: 72h
    input: analyze.output
  }

  // Conditional steps based on gate outcome
  step approve {
    agent: approval-notifier @ "1.0"
    input: legalReview.notes
    when: legalReview.approved
  }

  step reject {
    agent: rejection-notifier @ "1.0"
    input: legalReview.notes
    when: legalReview.rejected
  }

  output {
    artifact: analyze.output
    retention: 7y
  }
}
`;

describe("integration — full parallel-gate workflow", () => {
  it("compiles successfully", () => {
    const result = compile(FULL_SRC);
    if (!result.ok) {
      console.error("Compile errors:", result.errors);
    }
    expect(result.ok).toBe(true);
  });

  it("emits correct workflow name and version", () => {
    const result = compile(FULL_SRC);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.ir.name).toBe("regulatory-review");
    expect(result.ir.version).toBe("2.0.0");
  });

  it("emits params with types and defaults", () => {
    const result = compile(FULL_SRC);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.ir.params).toMatchObject({
      jurisdictions: "string[]",
      reviewer_email: "string",
      max_pages: 100,
    });
  });

  it("emits 5 steps in correct order", () => {
    const result = compile(FULL_SRC);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.ir.steps).toHaveLength(5);
    const [parse, analyze, gate, approve, reject] = result.ir.steps;
    expect(parse!.id).toBe("parse");
    expect(analyze!.id).toBe("analyze");
    expect(gate!.id).toBe("legalReview");
    expect(approve!.id).toBe("approve");
    expect(reject!.id).toBe("reject");
  });

  it("emits parse step correctly", () => {
    const result = compile(FULL_SRC);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.ir.steps[0]).toMatchObject({
      id: "parse",
      type: "agent",
      agentId: "document-parser",
      agentVersion: "2.1",
      input: { $ref: "run.input" },
      retry: 3,
      timeoutSeconds: 1800,
    });
  });

  it("emits parallel forEach step correctly", () => {
    const result = compile(FULL_SRC);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const par = result.ir.steps[1]!;
    expect(par.type).toBe("parallel");
    if (par.type === "parallel") {
      expect(par.forEach).toMatchObject({
        var: "jurisdiction",
        in: { $ref: "params.jurisdictions" },
      });
      expect(par.template).toMatchObject({
        type: "agent",
        agentId: "jurisdiction-analyzer",
        agentVersion: "1.4",
        input: "analyze_${jurisdiction}",
      });
      expect((par.template as any).params).toMatchObject({
        source: { $ref: "parse.output" },
        pages: { $ref: "params.max_pages" },
      });
    }
  });

  it("emits gate step correctly", () => {
    const result = compile(FULL_SRC);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const gate = result.ir.steps[2]!;
    expect(gate).toMatchObject({
      id: "legalReview",
      type: "gate",
      assignee: { $ref: "params.reviewer_email" },
      timeoutSeconds: 259200, // 72h
      input: { $ref: "analyze.output" },
    });
  });

  it("emits conditional steps with when refs", () => {
    const result = compile(FULL_SRC);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const approve = result.ir.steps[3]!;
    const reject = result.ir.steps[4]!;
    if (approve.type === "agent") {
      expect(approve.when).toEqual({ $ref: "legalReview.approved" });
      expect(approve.input).toEqual({ $ref: "legalReview.notes" });
    }
    if (reject.type === "agent") {
      expect(reject.when).toEqual({ $ref: "legalReview.rejected" });
      expect(reject.input).toEqual({ $ref: "legalReview.notes" });
    }
  });

  it("emits output with 7-year retention", () => {
    const result = compile(FULL_SRC);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.ir.output).toMatchObject({
      artifact: { $ref: "analyze.output" },
      retentionDays: 2555,
    });
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
describe("integration — error handling", () => {
  it("returns lex error for invalid characters", () => {
    const result = compile("workflow W { # bad }");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.message).toContain("#");
    }
  });

  it("returns parse error for malformed input", () => {
    const result = compile("workflow { }");
    expect(result.ok).toBe(false);
  });

  it("returns semantic error for duplicate IDs", () => {
    const result = compile(`
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        step analyze { agent: doc-parser @ "1.0" }
        step analyze { agent: doc-parser @ "1.0" }
      }
    `);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.message.includes("Duplicate"))).toBe(true);
    }
  });

  it("returns semantic error for unknown step reference", () => {
    const result = compile(`
      workflow W {
        version: "1.0.0"
        triggers: [manual]
        step process {
          agent: proc-agent @ "1.0"
          when: nonexistent.approved
        }
      }
    `);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.message.includes("nonexistent"))).toBe(true);
    }
  });

  it("includes line and column in errors", () => {
    const result = compile("workflow { }");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.line).toBeGreaterThan(0);
    }
  });
});
