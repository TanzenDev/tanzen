// =============================================================================
// Tanzen DSL Compiler — Type Definitions
// AST node types and JSON IR types.
// =============================================================================

// ---------------------------------------------------------------------------
// Source location (attached to every AST node)
// ---------------------------------------------------------------------------
export interface Loc {
  line: number;
  col: number;
}

// ---------------------------------------------------------------------------
// Compiler error / warning
// ---------------------------------------------------------------------------
export type Severity = "error" | "warning";

export interface CompileError {
  line: number;
  column: number;
  message: string;
  severity: Severity;
}

// ---------------------------------------------------------------------------
// AST — Expression types
// ---------------------------------------------------------------------------

/** A dotted reference: run.input, params.x, stepId.output, etc. */
export interface RefExpr {
  kind: "ref";
  path: string; // e.g. "run.input", "params.jurisdictions"
  loc: Loc;
}

/** A string literal: "1.2.0" */
export interface StringExpr {
  kind: "string";
  value: string;
  loc: Loc;
}

/** A number literal: 3 */
export interface NumberExpr {
  kind: "number";
  value: number;
  loc: Loc;
}

/** A duration literal: 72h, 30m, 7d */
export interface DurationExpr {
  kind: "duration";
  raw: string;        // "72h"
  seconds: number;
  loc: Loc;
}

/** A retention literal: "7y", "1y", "90d" */
export interface RetentionExpr {
  kind: "retention";
  raw: string;       // "7y"
  days: number;
  loc: Loc;
}

/** A boolean literal: true / false */
export interface BooleanExpr {
  kind: "boolean";
  value: boolean;
  loc: Loc;
}

/** An object literal: { key: expr, ... } */
export interface ObjectExpr {
  kind: "object";
  entries: Array<{ key: string; value: Expr }>;
  loc: Loc;
}

/** An array literal: ["US", "EU"] */
export interface ArrayExpr {
  kind: "array";
  elements: Expr[];
  loc: Loc;
}

/** A bare identifier (used in trigger lists, type annotations) */
export interface IdentExpr {
  kind: "ident";
  name: string;
  loc: Loc;
}

/** A template string: "analyze_${jurisdiction}" */
export interface TemplateExpr {
  kind: "template";
  parts: Array<string | RefExpr>;
  loc: Loc;
}

export type Expr =
  | RefExpr
  | StringExpr
  | NumberExpr
  | BooleanExpr
  | DurationExpr
  | RetentionExpr
  | ObjectExpr
  | ArrayExpr
  | IdentExpr
  | TemplateExpr;

// ---------------------------------------------------------------------------
// AST — Trigger types
// ---------------------------------------------------------------------------
export interface ManualTrigger {
  kind: "manual";
  loc: Loc;
}

export interface WebhookTrigger {
  kind: "webhook";
  path: string;
  loc: Loc;
}

export type Trigger = ManualTrigger | WebhookTrigger;

// ---------------------------------------------------------------------------
// AST — Param declaration
// ---------------------------------------------------------------------------
export interface ParamDecl {
  name: string;
  type: "string" | "string[]" | "number" | "boolean";
  default?: Expr;
  loc: Loc;
}

// ---------------------------------------------------------------------------
// AST — Step nodes
// ---------------------------------------------------------------------------

export interface AgentRef {
  agentId: string;    // "document-parser"
  version: string;    // "2.1"
  loc: Loc;
}

export interface StepNode {
  kind: "step";
  id: string;
  agent: AgentRef;
  input?: Expr;
  params?: ObjectExpr;
  retry?: number;
  when?: RefExpr;
  timeout?: DurationExpr;
  loc: Loc;
}

export interface ParallelNode {
  kind: "parallel";
  id: string;
  // Either a static list of steps or a forEach loop
  forEach?: {
    var: string;
    in: RefExpr;
    template: StepNode;
  };
  steps?: StepNode[];
  loc: Loc;
}

export interface GateNode {
  kind: "gate";
  id: string;
  assignee: RefExpr | StringExpr;
  timeout?: DurationExpr;
  input?: Expr;
  loc: Loc;
}

export interface OutputNode {
  kind: "output";
  artifact: RefExpr;
  retention?: RetentionExpr;
  loc: Loc;
}

export interface TaskNode {
  kind: "task";
  id: string;
  action: string;
  input?: Expr;
  params?: ObjectExpr;
  when?: RefExpr;
  timeout?: DurationExpr;
  loc: Loc;
}

export interface ScriptNode {
  kind: "script";
  id: string;
  scriptName: string;
  scriptVersion?: string;  // undefined → "latest" resolved at compile time
  input?: Expr;
  params?: ObjectExpr;
  when?: RefExpr;
  timeout?: DurationExpr;
  loc: Loc;
}

export type WorkflowItem = StepNode | ParallelNode | GateNode | OutputNode | TaskNode | ScriptNode;

// ---------------------------------------------------------------------------
// AST — Top-level Workflow
// ---------------------------------------------------------------------------
export interface WorkflowNode {
  kind: "workflow";
  name: string;
  version: string;
  triggers: Trigger[];
  params: ParamDecl[];
  items: WorkflowItem[];
  loc: Loc;
}

// ---------------------------------------------------------------------------
// JSON IR — emitted by the compiler, consumed by Temporal dynamic workflow
// ---------------------------------------------------------------------------

export interface IRRef {
  $ref: string;
}

export type IRValue = IRRef | string | number | boolean | IRObject | IRArray;
export interface IRObject { [key: string]: IRValue }
export type IRArray = IRValue[];

export interface IRAgentStep {
  id: string;
  type: "agent";
  agentId: string;
  agentVersion: string;
  input?: IRValue;
  params?: IRObject;
  retry?: number;
  when?: IRRef;
  timeoutSeconds?: number;
}

export interface IRParallelStep {
  id: string;
  type: "parallel";
  forEach?: { var: string; in: IRRef };
  template?: Omit<IRAgentStep, "type"> & { type: "agent" };
  steps?: IRAgentStep[];
}

export interface IRGateStep {
  id: string;
  type: "gate";
  assignee: IRRef | string;
  timeoutSeconds?: number;
  input?: IRValue;
}

export interface IRTaskStep {
  id: string;
  type: "task";
  action: string;
  input?: IRValue;
  params?: IRObject;
  when?: IRRef;
  timeoutSeconds?: number;
}

export interface IRScriptStep {
  id: string;
  type: "script";
  scriptName: string;
  scriptVersion: string;   // always concrete after compilation
  s3Key: string;           // content-addressable pointer baked in at compile time
  allowedHosts?: string;   // baked in from registry at compile time
  allowedEnv?: string;
  input?: IRValue;
  params?: IRObject;
  when?: IRRef;
  timeoutSeconds?: number;
}

export type IRStep = IRAgentStep | IRParallelStep | IRGateStep | IRTaskStep | IRScriptStep;

export interface IROutput {
  artifact: IRRef;
  retentionDays?: number;
}

export interface IR {
  name: string;
  version: string;
  params?: IRObject;
  steps: IRStep[];
  output?: IROutput;
}

// ---------------------------------------------------------------------------
// Compiler result
// ---------------------------------------------------------------------------
export type CompileResult =
  | { ok: true; ir: IR }
  | { ok: false; errors: CompileError[] };
