// =============================================================================
// Tanzen DSL Compiler — Recursive Descent Parser
// Consumes a token stream and produces a typed WorkflowNode AST.
// =============================================================================

import { type Token, type TokenKind, KEYWORDS } from "./lexer.ts";
import type {
  Loc, Expr, RefExpr, StringExpr, NumberExpr, BooleanExpr, DurationExpr, RetentionExpr,
  ObjectExpr, ArrayExpr, IdentExpr, TemplateExpr,
  Trigger, ParamDecl, AgentRef,
  StepNode, ParallelNode, GateNode, OutputNode, TaskNode, ScriptNode, WorkflowItem, WorkflowNode,
} from "./types.ts";

export class ParseError extends Error {
  constructor(public line: number, public col: number, msg: string) {
    super(msg);
  }
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  // ---------------------------------------------------------------------------
  // Token primitives
  // ---------------------------------------------------------------------------
  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private advance(): Token {
    const t = this.tokens[this.pos]!;
    if (t.kind !== "EOF") this.pos++;
    return t;
  }

  private check(kind: TokenKind, value?: string): boolean {
    const t = this.peek();
    if (t.kind !== kind) return false;
    if (value !== undefined && t.value !== value) return false;
    return true;
  }

  private eat(kind: TokenKind, value?: string): Token {
    const t = this.peek();
    if (t.kind !== kind || (value !== undefined && t.value !== value)) {
      const expected = value ? `'${value}'` : kind;
      throw new ParseError(t.line, t.col,
        `Expected ${expected} but got '${t.value}' (${t.kind})`);
    }
    return this.advance();
  }

  private loc(): Loc {
    const t = this.peek();
    return { line: t.line, col: t.col };
  }

  private ident(): string {
    const t = this.peek();
    if (t.kind !== "IDENT") {
      throw new ParseError(t.line, t.col, `Expected identifier but got '${t.value}'`);
    }
    this.advance();
    return t.value;
  }

  // ---------------------------------------------------------------------------
  // Expression parsing
  // ---------------------------------------------------------------------------

  /** Parse a dotted reference path: stepId.output, params.x, run.input */
  private parseRef(): RefExpr {
    const loc = this.loc();
    let path = this.ident();
    while (this.check("DOT")) {
      this.advance(); // consume dot
      const t = this.peek();
      if (t.kind !== "IDENT") {
        throw new ParseError(t.line, t.col, `Expected identifier after '.'`);
      }
      path += "." + this.advance().value;
    }
    return { kind: "ref", path, loc };
  }

  /** Parse a string literal that may contain ${var} template expressions */
  private parseStringOrTemplate(raw: string, loc: Loc): StringExpr | TemplateExpr {
    // Check for template markers
    if (!raw.includes("${")) {
      return { kind: "string", value: raw, loc };
    }
    // Split into parts
    const parts: Array<string | RefExpr> = [];
    let rest = raw;
    while (rest.length > 0) {
      const idx = rest.indexOf("${");
      if (idx === -1) { parts.push(rest); break; }
      if (idx > 0) parts.push(rest.slice(0, idx));
      const end = rest.indexOf("}", idx);
      if (end === -1) throw new ParseError(loc.line, loc.col, "Unclosed ${ in string");
      const varName = rest.slice(idx + 2, end);
      parts.push({ kind: "ref", path: varName, loc });
      rest = rest.slice(end + 1);
    }
    return { kind: "template", parts, loc };
  }

  /**
   * Parse a retention string like "7y", "90d", "1y" → RetentionExpr.
   * Only valid in output.retention context.
   */
  private parseRetention(raw: string, loc: Loc): RetentionExpr {
    const m = raw.match(/^(\d+)([yd])$/);
    if (!m) throw new ParseError(loc.line, loc.col,
      `Invalid retention value '${raw}': expected format like "7y" or "90d"`);
    const n = parseInt(m[1]!, 10);
    const unit = m[2]!;
    const days = unit === "y" ? n * 365 : n;
    return { kind: "retention", raw, days, loc };
  }

  /** Parse a duration token (already lexed) → DurationExpr */
  private parseDuration(token: Token): DurationExpr {
    const m = token.value.match(/^(\d+)([hmsd])$/);
    if (!m) throw new ParseError(token.line, token.col,
      `Invalid duration '${token.value}'`);
    const n = parseInt(m[1]!, 10);
    const unit = m[2]!;
    const seconds = unit === "h" ? n * 3600
      : unit === "m" ? n * 60
      : unit === "d" ? n * 86400
      : n;
    return { kind: "duration", raw: token.value, seconds, loc: { line: token.line, col: token.col } };
  }

  /** Parse an object literal: { key: expr, ... } */
  private parseObject(): ObjectExpr {
    const loc = this.loc();
    this.eat("LBRACE");
    const entries: Array<{ key: string; value: Expr }> = [];
    while (!this.check("RBRACE")) {
      const key = this.ident();
      this.eat("COLON");
      const value = this.parseExpr();
      entries.push({ key, value });
      if (this.check("COMMA")) this.advance();
    }
    this.eat("RBRACE");
    return { kind: "object", entries, loc };
  }

  /** Parse an array literal: [expr, ...] */
  private parseArray(): ArrayExpr {
    const loc = this.loc();
    this.eat("LBRACKET");
    const elements: Expr[] = [];
    while (!this.check("RBRACKET")) {
      elements.push(this.parseExpr());
      if (this.check("COMMA")) this.advance();
    }
    this.eat("RBRACKET");
    return { kind: "array", elements, loc };
  }

  /**
   * General expression parser. Dispatches on the leading token:
   *   STRING  → string or template
   *   NUMBER  → number
   *   DURATION → duration
   *   IDENT   → ref (dotted path) or bare ident
   *   LBRACE  → object
   *   LBRACKET → array
   */
  parseExpr(): Expr {
    const t = this.peek();
    const loc = { line: t.line, col: t.col };

    if (t.kind === "STRING") {
      this.advance();
      return this.parseStringOrTemplate(t.value, loc);
    }

    if (t.kind === "NUMBER") {
      this.advance();
      return { kind: "number", value: parseInt(t.value, 10), loc } satisfies NumberExpr;
    }

    if (t.kind === "DURATION") {
      this.advance();
      return this.parseDuration(t);
    }

    if (t.kind === "LBRACE") {
      return this.parseObject();
    }

    if (t.kind === "LBRACKET") {
      return this.parseArray();
    }

    if (t.kind === "IDENT") {
      // Boolean literals
      if (t.value === "true") {
        this.advance();
        return { kind: "boolean", value: true, loc } satisfies BooleanExpr;
      }
      if (t.value === "false") {
        this.advance();
        return { kind: "boolean", value: false, loc } satisfies BooleanExpr;
      }
      // Could be a dotted ref, a keyword used as value (manual), or a bare ident
      return this.parseRef();
    }

    throw new ParseError(t.line, t.col, `Unexpected token '${t.value}' in expression`);
  }

  // ---------------------------------------------------------------------------
  // Agent reference: name @ "version"  (name may be kebab-case)
  // ---------------------------------------------------------------------------
  private parseAgentRef(): AgentRef {
    const loc = this.loc();
    // Agent ID: one or more IDENT tokens joined by hyphens (already lexed as single IDENT with hyphens)
    const agentId = this.ident();
    this.eat("AT");
    const versionTok = this.eat("STRING");
    return { agentId, version: versionTok.value, loc };
  }

  // ---------------------------------------------------------------------------
  // Trigger list: [manual, webhook("/path"), ...]
  // ---------------------------------------------------------------------------
  private parseTriggers(): Trigger[] {
    this.eat("LBRACKET");
    const triggers: Trigger[] = [];
    while (!this.check("RBRACKET")) {
      const loc = this.loc();
      const name = this.ident();
      if (name === "manual") {
        triggers.push({ kind: "manual", loc });
      } else if (name === "webhook") {
        this.eat("LPAREN");
        const path = this.eat("STRING").value;
        this.eat("RPAREN");
        triggers.push({ kind: "webhook", path, loc });
      } else {
        throw new ParseError(loc.line, loc.col, `Unknown trigger type '${name}'`);
      }
      if (this.check("COMMA")) this.advance();
    }
    this.eat("RBRACKET");
    return triggers;
  }

  // ---------------------------------------------------------------------------
  // Params block
  // ---------------------------------------------------------------------------
  private parseParams(): ParamDecl[] {
    this.eat("LBRACE");
    const params: ParamDecl[] = [];
    while (!this.check("RBRACE")) {
      const loc = this.loc();
      const name = this.ident();
      this.eat("COLON");
      const typeTok = this.peek();
      let type: ParamDecl["type"];
      if (typeTok.kind === "IDENT" && typeTok.value === "string") {
        this.advance();
        // Check for [] suffix
        if (this.check("LBRACKET")) {
          this.advance(); this.eat("RBRACKET");
          type = "string[]";
        } else {
          type = "string";
        }
      } else if (typeTok.kind === "IDENT" && typeTok.value === "number") {
        this.advance(); type = "number";
      } else if (typeTok.kind === "IDENT" && typeTok.value === "boolean") {
        this.advance(); type = "boolean";
      } else {
        throw new ParseError(typeTok.line, typeTok.col,
          `Expected param type (string, number, boolean) but got '${typeTok.value}'`);
      }
      let defaultVal: Expr | undefined;
      if (this.check("EQUALS")) {
        this.advance();
        defaultVal = this.parseExpr();
      }
      params.push({
        name, type, loc,
        ...(defaultVal !== undefined && { default: defaultVal }),
      });
    }
    this.eat("RBRACE");
    return params;
  }

  // ---------------------------------------------------------------------------
  // Step block
  // ---------------------------------------------------------------------------
  private parseStep(allowAnonymous = false): StepNode {
    const loc = this.loc();
    this.eat("IDENT", "step");
    // ID is optional for forEach template steps
    let id = "";
    if (this.check("LBRACE")) {
      if (!allowAnonymous) {
        throw new ParseError(loc.line, loc.col, "Step is missing an ID");
      }
    } else {
      id = this.ident();
    }
    this.eat("LBRACE");

    let agent: AgentRef | undefined;
    let input: Expr | undefined;
    let params: ObjectExpr | undefined;
    let retry: number | undefined;
    let when: RefExpr | undefined;
    let timeout: DurationExpr | undefined;

    while (!this.check("RBRACE")) {
      const key = this.ident();
      this.eat("COLON");
      switch (key) {
        case "agent":
          agent = this.parseAgentRef();
          break;
        case "input":
          input = this.parseExpr();
          break;
        case "params":
          params = this.parseObject();
          break;
        case "retry": {
          const n = this.eat("NUMBER");
          retry = parseInt(n.value, 10);
          break;
        }
        case "when": {
          const expr = this.parseExpr();
          if (expr.kind !== "ref") {
            throw new ParseError(expr.loc.line, expr.loc.col,
              "'when' must be a reference expression like stepId.approved");
          }
          when = expr;
          break;
        }
        case "timeout": {
          const t = this.peek();
          if (t.kind !== "DURATION") {
            throw new ParseError(t.line, t.col, `Expected duration for 'timeout'`);
          }
          this.advance();
          timeout = this.parseDuration(t);
          break;
        }
        default:
          throw new ParseError(loc.line, loc.col, `Unknown step field '${key}'`);
      }
    }
    this.eat("RBRACE");

    if (!agent) throw new ParseError(loc.line, loc.col, `Step '${id}' is missing 'agent'`);
    return {
      kind: "step", id, agent, loc,
      ...(input !== undefined && { input }),
      ...(params !== undefined && { params }),
      ...(retry !== undefined && { retry }),
      ...(when !== undefined && { when }),
      ...(timeout !== undefined && { timeout }),
    };
  }

  // ---------------------------------------------------------------------------
  // Parallel block
  // ---------------------------------------------------------------------------
  private parseParallel(): ParallelNode {
    const loc = this.loc();
    this.eat("IDENT", "parallel");
    const id = this.ident();
    this.eat("LBRACE");

    // Two forms:
    //   parallel id { for x in expr { step ... } }
    //   parallel id { step a { ... }  step b { ... } ... }

    let forEach: ParallelNode["forEach"];
    const steps: StepNode[] = [];

    if (this.check("IDENT", "for")) {
      this.advance(); // consume "for"
      const varName = this.ident();
      this.eat("IDENT", "in");
      const inExpr = this.parseExpr();
      if (inExpr.kind !== "ref") {
        throw new ParseError(inExpr.loc.line, inExpr.loc.col,
          "'for … in' requires a reference expression");
      }
      this.eat("LBRACE");
      const template = this.parseStep(true);
      this.eat("RBRACE");
      forEach = { var: varName, in: inExpr, template };
    } else {
      while (this.check("IDENT", "step")) {
        steps.push(this.parseStep());
      }
      if (steps.length < 2) {
        throw new ParseError(loc.line, loc.col,
          `Parallel block '${id}' must contain at least two steps (got ${steps.length})`);
      }
    }

    this.eat("RBRACE");
    return {
      kind: "parallel", id, loc,
      ...(forEach !== undefined ? { forEach } : { steps }),
    };
  }

  // ---------------------------------------------------------------------------
  // Gate block
  // ---------------------------------------------------------------------------
  private parseGate(): GateNode {
    const loc = this.loc();
    this.eat("IDENT", "gate");
    const id = this.ident();
    this.eat("LBRACE");

    let assignee: RefExpr | StringExpr | undefined;
    let timeout: DurationExpr | undefined;
    let input: Expr | undefined;

    while (!this.check("RBRACE")) {
      const key = this.ident();
      this.eat("COLON");
      switch (key) {
        case "assignee": {
          const expr = this.parseExpr();
          if (expr.kind !== "ref" && expr.kind !== "string") {
            throw new ParseError(expr.loc.line, expr.loc.col,
              "'assignee' must be a reference or string");
          }
          assignee = expr as RefExpr | StringExpr;
          break;
        }
        case "timeout": {
          const t = this.peek();
          if (t.kind !== "DURATION") {
            throw new ParseError(t.line, t.col, `Expected duration for 'timeout'`);
          }
          this.advance();
          timeout = this.parseDuration(t);
          break;
        }
        case "input":
          input = this.parseExpr();
          break;
        default:
          throw new ParseError(loc.line, loc.col, `Unknown gate field '${key}'`);
      }
    }
    this.eat("RBRACE");

    if (!assignee) throw new ParseError(loc.line, loc.col, `Gate '${id}' is missing 'assignee'`);
    return {
      kind: "gate", id, assignee, loc,
      ...(timeout !== undefined && { timeout }),
      ...(input !== undefined && { input }),
    };
  }

  // ---------------------------------------------------------------------------
  // Task block
  // ---------------------------------------------------------------------------
  private parseTask(): TaskNode {
    const loc = this.loc();
    this.eat("IDENT", "task");
    const id = this.ident();
    this.eat("LBRACE");

    let action: string | undefined;
    let input: Expr | undefined;
    let params: ObjectExpr | undefined;
    let when: RefExpr | undefined;
    let timeout: DurationExpr | undefined;

    while (!this.check("RBRACE")) {
      const key = this.ident();
      this.eat("COLON");
      switch (key) {
        case "action": {
          const t = this.eat("STRING");
          action = t.value;
          break;
        }
        case "input":
          input = this.parseExpr();
          break;
        case "params":
          params = this.parseObject();
          break;
        case "when": {
          const expr = this.parseExpr();
          if (expr.kind !== "ref") {
            throw new ParseError(expr.loc.line, expr.loc.col,
              "'when' must be a reference expression like gateId.approved");
          }
          when = expr;
          break;
        }
        case "timeout": {
          const t = this.peek();
          if (t.kind !== "DURATION") {
            throw new ParseError(t.line, t.col, `Expected duration for 'timeout'`);
          }
          this.advance();
          timeout = this.parseDuration(t);
          break;
        }
        default:
          throw new ParseError(loc.line, loc.col, `Unknown task field '${key}'`);
      }
    }
    this.eat("RBRACE");

    if (!action) throw new ParseError(loc.line, loc.col, `Task '${id}' is missing 'action'`);
    return {
      kind: "task", id, action, loc,
      ...(input !== undefined && { input }),
      ...(params !== undefined && { params }),
      ...(when !== undefined && { when }),
      ...(timeout !== undefined && { timeout }),
    };
  }

  // ---------------------------------------------------------------------------
  // Script block
  // ---------------------------------------------------------------------------
  private parseScript(): ScriptNode {
    const loc = this.loc();
    this.eat("IDENT", "script");
    const id = this.ident();
    this.eat("LBRACE");

    let scriptName: string | undefined;
    let scriptVersion: string | undefined;
    let input: Expr | undefined;
    let params: ObjectExpr | undefined;
    let when: RefExpr | undefined;
    let timeout: DurationExpr | undefined;

    while (!this.check("RBRACE")) {
      const key = this.ident();
      this.eat("COLON");
      switch (key) {
        case "name": {
          const t = this.eat("STRING");
          scriptName = t.value;
          break;
        }
        case "version": {
          const t = this.eat("STRING");
          scriptVersion = t.value;
          break;
        }
        case "input":
          input = this.parseExpr();
          break;
        case "params":
          params = this.parseObject();
          break;
        case "when": {
          const expr = this.parseExpr();
          if (expr.kind !== "ref") {
            throw new ParseError(expr.loc.line, expr.loc.col,
              "'when' must be a reference expression like gateId.approved");
          }
          when = expr;
          break;
        }
        case "timeout": {
          const t = this.peek();
          if (t.kind !== "DURATION") {
            throw new ParseError(t.line, t.col, `Expected duration for 'timeout'`);
          }
          this.advance();
          timeout = this.parseDuration(t);
          break;
        }
        default:
          throw new ParseError(loc.line, loc.col, `Unknown script field '${key}'`);
      }
    }
    this.eat("RBRACE");

    if (!scriptName) throw new ParseError(loc.line, loc.col, `Script '${id}' is missing 'name'`);
    return {
      kind: "script", id, scriptName, loc,
      ...(scriptVersion !== undefined && { scriptVersion }),
      ...(input !== undefined && { input }),
      ...(params !== undefined && { params }),
      ...(when !== undefined && { when }),
      ...(timeout !== undefined && { timeout }),
    };
  }

  // ---------------------------------------------------------------------------
  // Output block
  // ---------------------------------------------------------------------------
  private parseOutput(): OutputNode {
    const loc = this.loc();
    this.eat("IDENT", "output");
    this.eat("LBRACE");

    let artifact: RefExpr | undefined;
    let retention: RetentionExpr | undefined;

    while (!this.check("RBRACE")) {
      const key = this.ident();
      this.eat("COLON");
      switch (key) {
        case "artifact": {
          const expr = this.parseExpr();
          if (expr.kind !== "ref") {
            throw new ParseError(expr.loc.line, expr.loc.col,
              "'artifact' must be a reference like stepId.output");
          }
          artifact = expr;
          break;
        }
        case "retention": {
          const t = this.peek();
          const retLoc = { line: t.line, col: t.col };
          if (t.kind === "STRING") {
            // Quoted: retention: "7y"
            this.advance();
            retention = this.parseRetention(t.value, retLoc);
          } else if (t.kind === "NUMBER") {
            // Bare: retention: 7y  →  NUMBER("7") IDENT("y")
            const num = this.advance().value;
            const unit = this.peek();
            if (unit.kind !== "IDENT" || (unit.value !== "y" && unit.value !== "d")) {
              throw new ParseError(unit.line, unit.col,
                `Expected retention unit 'y' or 'd' after number, got '${unit.value}'`);
            }
            this.advance();
            retention = this.parseRetention(`${num}${unit.value}`, retLoc);
          } else {
            throw new ParseError(t.line, t.col,
              `Expected retention value like 7y or "7y", got '${t.value}'`);
          }
          break;
        }
        default:
          throw new ParseError(loc.line, loc.col, `Unknown output field '${key}'`);
      }
    }
    this.eat("RBRACE");

    if (!artifact) throw new ParseError(loc.line, loc.col, "Output block is missing 'artifact'");
    return {
      kind: "output", artifact, loc,
      ...(retention !== undefined && { retention }),
    };
  }

  // ---------------------------------------------------------------------------
  // Workflow body item dispatch
  // ---------------------------------------------------------------------------
  private parseItem(): WorkflowItem {
    const t = this.peek();
    if (t.kind !== "IDENT") {
      throw new ParseError(t.line, t.col, `Expected workflow item but got '${t.value}'`);
    }
    switch (t.value) {
      case "step":     return this.parseStep();
      case "task":     return this.parseTask();
      case "script":   return this.parseScript();
      case "parallel": return this.parseParallel();
      case "gate":     return this.parseGate();
      case "output":   return this.parseOutput();
      default:
        throw new ParseError(t.line, t.col,
          `Unknown workflow item '${t.value}': expected step, task, script, parallel, gate, or output`);
    }
  }

  // ---------------------------------------------------------------------------
  // Top-level workflow
  // ---------------------------------------------------------------------------
  parseWorkflow(): WorkflowNode {
    const loc = this.loc();
    this.eat("IDENT", "workflow");
    const name = this.ident();
    this.eat("LBRACE");

    let version = "0.0.0";
    let triggers: Trigger[] = [];
    let params: ParamDecl[] = [];
    const items: WorkflowItem[] = [];

    while (!this.check("RBRACE")) {
      const t = this.peek();
      if (t.kind !== "IDENT") {
        throw new ParseError(t.line, t.col, `Expected workflow field or block but got '${t.value}'`);
      }
      switch (t.value) {
        case "version":
          this.advance();
          this.eat("COLON");
          version = this.eat("STRING").value;
          break;
        case "triggers":
          this.advance();
          this.eat("COLON");
          triggers = this.parseTriggers();
          break;
        case "params":
          this.advance();
          params = this.parseParams();
          break;
        case "step":
        case "task":
        case "script":
        case "parallel":
        case "gate":
        case "output":
          items.push(this.parseItem());
          break;
        default:
          throw new ParseError(t.line, t.col,
            `Unknown workflow field '${t.value}': expected version, triggers, params, step, task, script, parallel, gate, or output`);
      }
    }

    this.eat("RBRACE");
    this.eat("EOF");

    return { kind: "workflow", name, version, triggers, params, items, loc };
  }
}

export function parse(tokens: Token[]): WorkflowNode {
  return new Parser(tokens).parseWorkflow();
}
