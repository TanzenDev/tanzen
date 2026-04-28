// =============================================================================
// Tanzen DSL Compiler — Semantic Analyzer
// Validates a WorkflowNode AST and returns a list of errors.
//
// Checks performed:
//   - Step/gate/parallel IDs are unique
//   - 'when' expressions reference a step that exists in this workflow
//   - 'when' property must be .approved, .output, or .notes
//   - parallel forEach 'in' references exist in params
//   - parallel with explicit steps has ≥ 2 children
//   - output.artifact references a step that exists
// =============================================================================

import type {
  WorkflowNode, WorkflowItem, StepNode, ParallelNode, GateNode, TaskNode, ScriptNode,
  RefExpr, CompileError, AgentDeclNode, ScriptDeclNode, BundleNode,
} from "./types.ts";

export type ScriptRegistry = Map<string, {
  version: string;
  s3Key: string;
  language?: string;
  allowedHosts?: string;
  allowedEnv?: string;
  maxTimeoutSeconds?: number;
}>;

function err(line: number, col: number, message: string): CompileError {
  return { line, col, column: col, message, severity: "error" } as CompileError & { column: number };
}

const BUILTIN_ACTIONS = new Set([
  "filter", "sort", "slice", "deduplicate", "flatten", "map",
  "extract_fields", "parse_csv", "parse_json", "format_json",
  "template", "http_request",
]);

function collectIds(items: WorkflowItem[]): Map<string, WorkflowItem> {
  const map = new Map<string, WorkflowItem>();
  for (const item of items) {
    if (item.kind === "output") continue;
    map.set(item.id, item);
  }
  return map;
}

function checkRef(
  ref: RefExpr,
  ids: Map<string, WorkflowItem>,
  paramNames: Set<string>,
  errors: CompileError[],
  context: string,
): void {
  const parts = ref.path.split(".");
  const root = parts[0]!;

  // run.* is always valid
  if (root === "run") return;

  // bare loop variable (e.g. forEach var: `jurisdiction`) — valid if in paramNames
  if (parts.length === 1 && paramNames.has(root)) return;

  // params.* — validate param name exists
  if (root === "params") {
    if (parts.length < 2) {
      errors.push(err(ref.loc.line, ref.loc.col,
        `${context}: 'params' reference must include a field name (e.g. params.reviewer_email)`));
      return;
    }
    const paramName = parts[1]!;
    if (!paramNames.has(paramName)) {
      errors.push(err(ref.loc.line, ref.loc.col,
        `${context}: param '${paramName}' is not declared in params block`));
    }
    return;
  }

  // stepId.property — validate step exists and property is valid
  if (!ids.has(root)) {
    errors.push(err(ref.loc.line, ref.loc.col,
      `${context}: references unknown step or variable '${root}'`));
    return;
  }

  if (parts.length > 1) {
    const prop = parts[1]!;
    const item = ids.get(root)!;
    const validProps: Record<string, string[]> = {
      step:     ["output"],
      task:     ["output"],
      script:   ["output"],
      parallel: ["output"],
      gate:     ["approved", "rejected", "notes"],
    };
    const allowed = validProps[item.kind] ?? [];
    if (!allowed.includes(prop)) {
      errors.push(err(ref.loc.line, ref.loc.col,
        `${context}: '${item.kind}' '${root}' does not have property '${prop}' ` +
        `(allowed: ${allowed.join(", ")})`));
    }
  }
}

export function analyze(
  ast: WorkflowNode,
  scriptRegistry?: ScriptRegistry,
): CompileError[] {
  const errors: CompileError[] = [];
  const ids = collectIds(ast.items);
  const paramNames = new Set(ast.params.map(p => p.name));

  // Check for duplicate IDs
  const seen = new Set<string>();
  for (const item of ast.items) {
    if (item.kind === "output") continue;
    if (seen.has(item.id)) {
      errors.push(err(item.loc.line, item.loc.col,
        `Duplicate ID '${item.id}': step, task, parallel, and gate IDs must be unique`));
    }
    seen.add(item.id);
  }

  // Validate each item
  for (const item of ast.items) {
    switch (item.kind) {
      case "step":
        validateStep(item, ids, paramNames, errors);
        break;
      case "task":
        validateTask(item, ids, paramNames, errors);
        break;
      case "script":
        validateScript(item, ids, paramNames, errors, scriptRegistry);
        break;
      case "parallel":
        validateParallel(item, ids, paramNames, errors);
        break;
      case "gate":
        validateGate(item, ids, paramNames, errors);
        break;
      case "output": {
        checkRef(item.artifact, ids, paramNames, errors, "output.artifact");
        break;
      }
    }
  }

  return errors;
}

function validateStep(
  step: StepNode,
  ids: Map<string, WorkflowItem>,
  paramNames: Set<string>,
  errors: CompileError[],
): void {
  const ctx = `step '${step.id}'`;

  if (step.when) {
    checkRef(step.when, ids, paramNames, errors, `${ctx} 'when'`);
    // 'when' must reference a gate's .approved/.rejected
    const parts = step.when.path.split(".");
    const prop = parts[1];
    if (prop && prop !== "approved" && prop !== "rejected") {
      errors.push(err(step.when.loc.line, step.when.loc.col,
        `${ctx} 'when' should reference .approved or .rejected (got .${prop})`));
    }
  }

  if (step.input) validateExprRefs(step.input, ids, paramNames, errors, `${ctx} 'input'`);
  if (step.params) validateExprRefs(step.params, ids, paramNames, errors, `${ctx} 'params'`);
}

function validateTask(
  task: TaskNode,
  ids: Map<string, WorkflowItem>,
  paramNames: Set<string>,
  errors: CompileError[],
): void {
  const ctx = `task '${task.id}'`;

  if (!BUILTIN_ACTIONS.has(task.action)) {
    errors.push(err(task.loc.line, task.loc.col,
      `${ctx}: unknown action '${task.action}'. Valid actions: ${[...BUILTIN_ACTIONS].join(", ")}`));
  }

  if (task.when) {
    checkRef(task.when, ids, paramNames, errors, `${ctx} 'when'`);
    const parts = task.when.path.split(".");
    const prop = parts[1];
    if (prop && prop !== "approved" && prop !== "rejected") {
      errors.push(err(task.when.loc.line, task.when.loc.col,
        `${ctx} 'when' should reference .approved or .rejected (got .${prop})`));
    }
  }

  if (task.input) validateExprRefs(task.input, ids, paramNames, errors, `${ctx} 'input'`);
  if (task.params) validateExprRefs(task.params, ids, paramNames, errors, `${ctx} 'params'`);
}

function validateScript(
  node: ScriptNode,
  ids: Map<string, WorkflowItem>,
  paramNames: Set<string>,
  errors: CompileError[],
  registry: ScriptRegistry | undefined,
): void {
  const ctx = `script '${node.id}'`;

  if (registry !== undefined && !registry.has(node.scriptName)) {
    const available = [...registry.keys()].join(", ") || "(none registered)";
    errors.push(err(node.loc.line, node.loc.col,
      `${ctx}: unknown script '${node.scriptName}'. Available: ${available}`));
  }

  if (node.when) {
    checkRef(node.when, ids, paramNames, errors, `${ctx} 'when'`);
    const parts = node.when.path.split(".");
    const prop = parts[1];
    if (prop && prop !== "approved" && prop !== "rejected") {
      errors.push(err(node.when.loc.line, node.when.loc.col,
        `${ctx} 'when' should reference .approved or .rejected (got .${prop})`));
    }
  }

  if (node.input) validateExprRefs(node.input, ids, paramNames, errors, `${ctx} 'input'`);
  if (node.params) validateExprRefs(node.params, ids, paramNames, errors, `${ctx} 'params'`);
}

function validateParallel(
  par: ParallelNode,
  ids: Map<string, WorkflowItem>,
  paramNames: Set<string>,
  errors: CompileError[],
): void {
  const ctx = `parallel '${par.id}'`;

  if (par.forEach) {
    const { var: varName, in: inRef, template } = par.forEach;
    checkRef(inRef, ids, paramNames, errors, `${ctx} 'for … in'`);

    // Validate template step — extend paramNames with the loop variable
    const extendedParams = new Set([...paramNames, varName]);
    validateStep(template, ids, extendedParams, errors);
  }

  if (par.steps) {
    for (const step of par.steps) {
      validateStep(step, ids, paramNames, errors);
    }
  }
}

function validateGate(
  gate: GateNode,
  ids: Map<string, WorkflowItem>,
  paramNames: Set<string>,
  errors: CompileError[],
): void {
  const ctx = `gate '${gate.id}'`;
  if (gate.assignee.kind === "ref") {
    checkRef(gate.assignee, ids, paramNames, errors, `${ctx} 'assignee'`);
  }
  if (gate.input) validateExprRefs(gate.input, ids, paramNames, errors, `${ctx} 'input'`);
}

// ---------------------------------------------------------------------------
// Bundle-level analysis
// ---------------------------------------------------------------------------

function analyzeAgentDecl(node: AgentDeclNode, errors: CompileError[]): void {
  if (!node.model.includes(":")) {
    errors.push(err(node.loc.line, node.loc.col,
      `Agent '${node.name}': model must be in 'provider:name' format (e.g. "anthropic:claude-sonnet-4-6"), got '${node.model}'`));
  }
  if (!node.systemPrompt.trim()) {
    errors.push(err(node.loc.line, node.loc.col, `Agent '${node.name}': system_prompt must not be empty`));
  }
}

function analyzeScriptDecl(node: ScriptDeclNode, errors: CompileError[]): void {
  if (!node.code.trim()) {
    errors.push(err(node.loc.line, node.loc.col, `Script '${node.name}': code must not be empty`));
  }
  if (node.maxTimeoutSeconds !== undefined && node.maxTimeoutSeconds < 1) {
    errors.push(err(node.loc.line, node.loc.col,
      `Script '${node.name}': max_timeout_seconds must be ≥ 1`));
  }
}

export function analyzeBundle(
  bundle: BundleNode,
  externalScriptRegistry?: ScriptRegistry,
): CompileError[] {
  const errors: CompileError[] = [];

  // Check for duplicate agent names
  const agentNames = new Set<string>();
  for (const a of bundle.agents) {
    if (agentNames.has(a.name)) {
      errors.push(err(a.loc.line, a.loc.col, `Duplicate agent name '${a.name}'`));
    }
    agentNames.add(a.name);
    analyzeAgentDecl(a, errors);
  }

  // Check for duplicate script names
  const scriptNames = new Set<string>();
  for (const s of bundle.scripts) {
    if (scriptNames.has(s.name)) {
      errors.push(err(s.loc.line, s.loc.col, `Duplicate script name '${s.name}'`));
    }
    scriptNames.add(s.name);
    analyzeScriptDecl(s, errors);
  }

  // Check for duplicate workflow names
  const workflowNames = new Set<string>();
  for (const w of bundle.workflows) {
    if (workflowNames.has(w.name)) {
      errors.push(err(w.loc.line, w.loc.col, `Duplicate workflow name '${w.name}'`));
    }
    workflowNames.add(w.name);
  }

  // Build a combined script registry: local decls take precedence over external
  const combinedRegistry: ScriptRegistry = new Map(externalScriptRegistry ?? []);
  for (const s of bundle.scripts) {
    combinedRegistry.set(s.name, {
      version: "bundle",
      s3Key: "",              // filled in by deploy endpoint after upload
      language: s.language,
      ...(s.allowedHosts !== undefined && { allowedHosts: s.allowedHosts }),
      ...(s.allowedEnv !== undefined && { allowedEnv: s.allowedEnv }),
      ...(s.maxTimeoutSeconds !== undefined && { maxTimeoutSeconds: s.maxTimeoutSeconds }),
    });
  }

  // Validate each workflow using the combined registry
  for (const w of bundle.workflows) {
    const wErrors = analyze(w, combinedRegistry);
    errors.push(...wErrors);
  }

  return errors;
}

import type { Expr } from "./types.ts";

function validateExprRefs(
  expr: Expr,
  ids: Map<string, WorkflowItem>,
  paramNames: Set<string>,
  errors: CompileError[],
  context: string,
): void {
  switch (expr.kind) {
    case "ref":
      checkRef(expr, ids, paramNames, errors, context);
      break;
    case "object":
      for (const { value } of expr.entries) {
        validateExprRefs(value, ids, paramNames, errors, context);
      }
      break;
    case "array":
      for (const el of expr.elements) {
        validateExprRefs(el, ids, paramNames, errors, context);
      }
      break;
    case "template":
      for (const part of expr.parts) {
        if (typeof part !== "string") {
          checkRef(part, ids, paramNames, errors, context);
        }
      }
      break;
    default:
      break; // string, number, duration, retention — no refs to validate
  }
}
