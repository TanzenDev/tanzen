import { describe, it, expect } from "bun:test";
import { compileBundle } from "../../src/compiler/index.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_ONLY = `
agent clause-extractor {
  model: "anthropic:claude-sonnet-4-6"
  system_prompt: """
    You are a contract analyst.
  """
}
`;

const SCRIPT_ONLY = `
script normalize-dates {
  language: python
  description: "Normalise dates"
  code: """
    output = {"ok": True}
  """
}
`;

const WORKFLOW_ONLY = `
workflow SimpleWorkflow {
  version: "1.0.0"
  step analyze {
    agent: my-agent @ "1.0"
    input: run.input
  }
}
`;

const FULL_BUNDLE = `
agent clause-extractor {
  model: "anthropic:claude-sonnet-4-6"
  system_prompt: """
    You are a contract analyst. Extract obligation clauses.
  """
  mcp: fetch
  mcp: sequential-thinking
}

script normalize-dates {
  language: python
  description: "Normalises ISO date strings"
  max_timeout_seconds: 60
  code: """
    import re
    output = {"dates": re.findall(r'\\d{4}-\\d{2}-\\d{2}', str(input))}
  """
}

workflow LegalReview {
  version: "1.0.0"

  params {
    document: string
  }

  step extract {
    agent: clause-extractor @ "1.0"
    input: { text: params.document }
  }

  script normalize {
    name: "normalize-dates"
    input: extract.output
  }

  output {
    artifact: normalize.output
  }
}
`;

// ---------------------------------------------------------------------------
// Agent declarations
// ---------------------------------------------------------------------------

describe("compileBundle — agent declarations", () => {
  it("parses a standalone agent block", () => {
    const r = compileBundle(AGENT_ONLY);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.bundle.agents).toHaveLength(1);
    expect(r.bundle.agents[0]).toMatchObject({
      name: "clause-extractor",
      model: "anthropic:claude-sonnet-4-6",
    });
    expect(r.bundle.agents[0]!.systemPrompt).toContain("contract analyst");
  });

  it("preserves mcp server names", () => {
    const src = `
agent my-agent {
  model: "openai:gpt-4o"
  system_prompt: """You are helpful."""
  mcp: fetch
  mcp: graphiti
}
`;
    const r = compileBundle(src);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.bundle.agents[0]!.mcpServers).toEqual(["fetch", "graphiti"]);
  });

  it("rejects agent missing model", () => {
    const r = compileBundle(`
agent bad {
  system_prompt: """hello"""
}
`);
    expect(r.ok).toBe(false);
  });

  it("rejects agent missing system_prompt", () => {
    const r = compileBundle(`
agent bad {
  model: "openai:gpt-4o"
}
`);
    expect(r.ok).toBe(false);
  });

  it("rejects duplicate agent names", () => {
    const r = compileBundle(AGENT_ONLY + AGENT_ONLY);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.errors.some(e => e.message.includes("Duplicate agent"))).toBe(true);
  });

  it("rejects model without provider prefix", () => {
    const r = compileBundle(`
agent bad {
  model: "gpt-4o"
  system_prompt: """hello"""
}
`);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.errors.some(e => e.message.includes("provider:name"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Script declarations
// ---------------------------------------------------------------------------

describe("compileBundle — script declarations", () => {
  it("parses a standalone script block", () => {
    const r = compileBundle(SCRIPT_ONLY);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.bundle.scripts).toHaveLength(1);
    expect(r.bundle.scripts[0]).toMatchObject({
      name: "normalize-dates",
      language: "python",
      description: "Normalise dates",
    });
    expect(r.bundle.scripts[0]!.code).toContain('output = {"ok": True}');
  });

  it("defaults language to typescript", () => {
    const r = compileBundle(`
script my-script {
  code: """console.log("hi")"""
}
`);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.bundle.scripts[0]!.language).toBe("typescript");
  });

  it("rejects invalid language", () => {
    const r = compileBundle(`
script bad {
  language: ruby
  code: """puts 'hi'"""
}
`);
    expect(r.ok).toBe(false);
  });

  it("rejects script missing code", () => {
    const r = compileBundle(`
script bad {
  language: python
}
`);
    expect(r.ok).toBe(false);
  });

  it("rejects duplicate script names", () => {
    const r = compileBundle(SCRIPT_ONLY + SCRIPT_ONLY);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.errors.some(e => e.message.includes("Duplicate script"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Triple-quoted strings
// ---------------------------------------------------------------------------

describe("compileBundle — triple-quoted strings", () => {
  it("strips leading newline after opening triple-quote", () => {
    const r = compileBundle(`
agent a {
  model: "openai:gpt-4o"
  system_prompt: """
    Hello world.
  """
}
`);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.bundle.agents[0]!.systemPrompt).toBe("    Hello world.");
  });

  it("handles triple-quote on same line as key", () => {
    const r = compileBundle(`
agent a {
  model: "openai:gpt-4o"
  system_prompt: """Hello."""
}
`);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.bundle.agents[0]!.systemPrompt).toBe("Hello.");
  });
});

// ---------------------------------------------------------------------------
// Full bundle with workflow
// ---------------------------------------------------------------------------

describe("compileBundle — full bundle", () => {
  it("compiles a bundle with agent, script, and workflow", () => {
    const r = compileBundle(FULL_BUNDLE);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const { bundle } = r;
    expect(bundle.agents).toHaveLength(1);
    expect(bundle.scripts).toHaveLength(1);
    expect(bundle.workflows).toHaveLength(1);
  });

  it("workflow IR references locally-declared script correctly", () => {
    const r = compileBundle(FULL_BUNDLE);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const wf = r.bundle.workflows[0]!;
    const scriptStep = wf.steps.find(s => s.type === "script");
    expect(scriptStep).toBeDefined();
    expect(scriptStep).toMatchObject({
      scriptName: "normalize-dates",
      language: "python",
    });
  });

  it("workflow IR emits correct name (kebab-case)", () => {
    const r = compileBundle(FULL_BUNDLE);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.bundle.workflows[0]!.name).toBe("legal-review");
  });

  it("workflow-only file compiles in bundle mode", () => {
    // Agent IDs are not validated at compile time — they're resolved at deploy/runtime.
    // Only script names are checked against the registry.
    const r = compileBundle(WORKFLOW_ONLY);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.bundle.agents).toHaveLength(0);
    expect(r.bundle.scripts).toHaveLength(0);
    expect(r.bundle.workflows).toHaveLength(1);
  });

  it("bundle with multiple workflows", () => {
    const twoWorkflows = `
workflow Alpha {
  version: "1.0.0"
  step a { agent: my-agent @ "1.0" input: run.input }
}

workflow Beta {
  version: "1.0.0"
  step b { agent: my-agent @ "1.0" input: run.input }
}
`;
    const r = compileBundle(twoWorkflows);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.bundle.workflows).toHaveLength(2);
    expect(r.bundle.workflows.map(w => w.name)).toEqual(["alpha", "beta"]);
  });

  it("rejects duplicate workflow names", () => {
    const r = compileBundle(WORKFLOW_ONLY + WORKFLOW_ONLY);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.errors.some(e => e.message.includes("Duplicate workflow"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Locally-declared scripts resolve in workflow semantic pass
// ---------------------------------------------------------------------------

describe("compileBundle — local script resolution", () => {
  it("workflow step referencing a locally-declared script passes semantic", () => {
    const src = `
script my-script {
  language: typescript
  code: """const x = 1; output = x;"""
}

workflow UseScript {
  version: "1.0.0"
  script step1 {
    name: "my-script"
    input: run.input
  }
}
`;
    const r = compileBundle(src);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
  });

  it("workflow step referencing unknown script fails semantic", () => {
    const src = `
workflow UseScript {
  version: "1.0.0"
  script step1 {
    name: "no-such-script"
    input: run.input
  }
}
`;
    // Pass an empty external registry so the script is definitely unknown
    const r = compileBundle(src, new Map());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.errors.some(e => e.message.includes("no-such-script"))).toBe(true);
  });
});
