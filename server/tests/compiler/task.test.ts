/**
 * Tests for the `task` keyword: lexer, parser, semantic analyzer, emitter.
 */
import { describe, it, expect } from "bun:test";
import { lex, KEYWORDS } from "../../src/compiler/lexer.ts";
import { parse } from "../../src/compiler/parser.ts";
import { analyze } from "../../src/compiler/semantic.ts";
import { emit } from "../../src/compiler/emitter.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compile(source: string) {
  const tokens = lex(source);
  const ast = parse(tokens);
  const errors = analyze(ast);
  const ir = emit(ast);
  return { ast, errors, ir };
}

function wf(body: string) {
  return `workflow Test { version: "1.0.0" triggers: [manual]\n${body}\n}`;
}

// ---------------------------------------------------------------------------
// 1. Lexer
// ---------------------------------------------------------------------------

describe("lexer — task keyword", () => {
  it("'task' is in the KEYWORDS set", () => {
    expect(KEYWORDS.has("task")).toBe(true);
  });

  it("lexes 'task' as an IDENT token", () => {
    const tokens = lex("task foo {}");
    expect(tokens[0]!.kind).toBe("IDENT");
    expect(tokens[0]!.value).toBe("task");
  });
});

// ---------------------------------------------------------------------------
// 2. Parser + Emitter — valid programs
// ---------------------------------------------------------------------------

describe("parser/emitter — valid task DSL", () => {
  it("parses a minimal task (action only)", () => {
    const { errors, ir } = compile(wf(`task t1 { action: "parse_json" }`));
    expect(errors).toHaveLength(0);
    expect(ir.steps).toHaveLength(1);
    expect(ir.steps[0]!.type).toBe("task");
    expect((ir.steps[0] as { action: string }).action).toBe("parse_json");
  });

  it("parses a task with input ref", () => {
    const { errors, ir } = compile(wf(`
      step s1 { agent: my-agent @ "1.0" }
      task t1 { action: "filter" input: s1.output params: { field: "status", value: "active" } }
    `));
    expect(errors).toHaveLength(0);
    const task = ir.steps[1]!;
    expect(task.type).toBe("task");
    expect((task as { input?: { $ref: string } }).input?.$ref).toBe("s1.output");
  });

  it("parses a task with when condition", () => {
    const { errors, ir } = compile(wf(`
      step s1 { agent: my-agent @ "1.0" }
      gate g1 { assignee: "reviewer@example.com" }
      task t1 { action: "slice" input: s1.output when: g1.approved }
    `));
    expect(errors).toHaveLength(0);
    const task = ir.steps[2]!;
    expect((task as { when?: { $ref: string } }).when?.$ref).toBe("g1.approved");
  });

  it("parses a task with timeout", () => {
    const { errors, ir } = compile(wf(`task t1 { action: "http_request" timeout: 30s }`));
    expect(errors).toHaveLength(0);
    expect((ir.steps[0] as { timeoutSeconds?: number }).timeoutSeconds).toBe(30);
  });

  it("parses mixed step + task workflow", () => {
    const { errors, ir } = compile(wf(`
      step s1 { agent: my-agent @ "1.0" }
      task t1 { action: "format_json" input: s1.output }
      step s2 { agent: my-agent @ "2.0" input: t1.output }
    `));
    expect(errors).toHaveLength(0);
    expect(ir.steps).toHaveLength(3);
    expect(ir.steps.map(s => s.type)).toEqual(["agent", "task", "agent"]);
  });

  it("task output is reachable by downstream step", () => {
    const { errors } = compile(wf(`
      step s1 { agent: a @ "1.0" }
      task t1 { action: "filter" input: s1.output }
      step s2 { agent: a @ "1.0" input: t1.output }
    `));
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Semantic errors
// ---------------------------------------------------------------------------

describe("semantic — task error cases", () => {
  it("rejects unknown action name", () => {
    const { errors } = compile(wf(`task t1 { action: "not_a_real_action" }`));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toMatch(/unknown action/i);
  });

  it("rejects duplicate step/task ID", () => {
    const { errors } = compile(wf(`
      step s1 { agent: a @ "1.0" }
      task s1 { action: "filter" }
    `));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toMatch(/duplicate id/i);
  });

  it("rejects when referencing .output instead of .approved/.rejected", () => {
    const { errors } = compile(wf(`
      gate g1 { assignee: "r@example.com" }
      task t1 { action: "filter" when: g1.output }
    `));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects input referencing nonexistent step", () => {
    const { errors } = compile(wf(`task t1 { action: "filter" input: ghost.output }`));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toMatch(/unknown step/i);
  });
});

// ---------------------------------------------------------------------------
// 4. IR shape — mixed step → task → gate → step
// ---------------------------------------------------------------------------

describe("IR shape — mixed workflow", () => {
  it("produces correct IR for step → task → gate → step", () => {
    const { errors, ir } = compile(wf(`
      step s1 { agent: my-agent @ "1.0" }
      task t1 { action: "filter" input: s1.output params: { field: "status", value: "ok" } }
      gate g1 { assignee: "r@example.com" input: t1.output }
      step s2 { agent: my-agent @ "1.0" input: t1.output when: g1.approved }
    `));
    expect(errors).toHaveLength(0);
    expect(ir.steps).toHaveLength(4);
    const [step1, task1, gate1, step2] = ir.steps;
    expect(step1!.type).toBe("agent");
    expect(task1!.type).toBe("task");
    expect(gate1!.type).toBe("gate");
    expect(step2!.type).toBe("agent");
    // task has correct action
    expect((task1 as { action: string }).action).toBe("filter");
    // downstream $ref resolves correctly
    expect((step2 as { when?: { $ref: string } }).when?.$ref).toBe("g1.approved");
  });
});
