// =============================================================================
// Tanzen DSL Compiler — IR Emitter
// Walks a validated WorkflowNode AST and produces the JSON IR consumed by
// the Temporal dynamic workflow interpreter.
// =============================================================================

import type {
  WorkflowNode, WorkflowItem, StepNode, ParallelNode, GateNode, OutputNode, TaskNode, ScriptNode,
  Expr, RefExpr, StringExpr, BooleanExpr, ObjectExpr,
  IR, IRStep, IRAgentStep, IRParallelStep, IRGateStep, IRTaskStep, IRScriptStep, IROutput,
  IRValue, IRObject, IRRef,
} from "./types.ts";

import type { ScriptRegistry } from "./semantic.ts";

// ---------------------------------------------------------------------------
// Expression → IR value
// ---------------------------------------------------------------------------

function emitRef(ref: RefExpr): IRRef {
  return { $ref: ref.path };
}

function emitExpr(expr: Expr): IRValue {
  switch (expr.kind) {
    case "ref":
      return { $ref: expr.path };
    case "string":
      return expr.value;
    case "number":
      return expr.value;
    case "boolean":
      return expr.value;
    case "duration":
      return expr.seconds;
    case "retention":
      return expr.days;
    case "ident":
      // bare identifier used as a value — treat as string
      return expr.name;
    case "template": {
      // Serialize as a string with ${ } markers preserved — the Temporal
      // runtime resolves these at execution time.
      return expr.parts
        .map(p => typeof p === "string" ? p : `\${${p.path}}`)
        .join("");
    }
    case "object": {
      const obj: IRObject = {};
      for (const { key, value } of expr.entries) {
        obj[key] = emitExpr(value);
      }
      return obj;
    }
    case "array":
      return expr.elements.map(emitExpr);
  }
}

// ---------------------------------------------------------------------------
// Step nodes → IR steps
// ---------------------------------------------------------------------------

function emitStep(step: StepNode): IRAgentStep {
  const out: IRAgentStep = {
    id: step.id,
    type: "agent",
    agentId: step.agent.agentId,
    agentVersion: step.agent.version,
  };
  if (step.input !== undefined)   out.input = emitExpr(step.input);
  if (step.params !== undefined)  out.params = emitExpr(step.params) as IRObject;
  if (step.retry !== undefined)   out.retry = step.retry;
  if (step.when !== undefined)    out.when = emitRef(step.when);
  if (step.timeout !== undefined) out.timeoutSeconds = step.timeout.seconds;
  return out;
}

function emitParallel(par: ParallelNode): IRParallelStep {
  if (par.forEach) {
    const { var: varName, in: inRef, template } = par.forEach;
    const templateIR = emitStep(template);
    return {
      id: par.id,
      type: "parallel",
      forEach: { var: varName, in: emitRef(inRef) },
      template: templateIR,
    };
  }
  return {
    id: par.id,
    type: "parallel",
    steps: (par.steps ?? []).map(emitStep),
  };
}

function emitGate(gate: GateNode): IRGateStep {
  const assignee: IRRef | string =
    gate.assignee.kind === "ref"
      ? emitRef(gate.assignee)
      : (gate.assignee as StringExpr).value;

  const out: IRGateStep = { id: gate.id, type: "gate", assignee };
  if (gate.timeout !== undefined) out.timeoutSeconds = gate.timeout.seconds;
  if (gate.input !== undefined)   out.input = emitExpr(gate.input);
  return out;
}

function emitTask(task: TaskNode): IRTaskStep {
  const out: IRTaskStep = { id: task.id, type: "task", action: task.action };
  if (task.input !== undefined)   out.input = emitExpr(task.input);
  if (task.params !== undefined)  out.params = emitExpr(task.params) as IRObject;
  if (task.when !== undefined)    out.when = emitRef(task.when);
  if (task.timeout !== undefined) out.timeoutSeconds = task.timeout.seconds;
  return out;
}

function emitScript(node: ScriptNode, registry: ScriptRegistry | undefined): IRScriptStep {
  const meta = registry?.get(node.scriptName);
  return {
    id: node.id,
    type: "script",
    scriptName: node.scriptName,
    scriptVersion: node.scriptVersion ?? meta?.version ?? "unknown",
    s3Key: meta?.s3Key ?? "",
    ...(meta?.allowedHosts !== undefined && { allowedHosts: meta.allowedHosts }),
    ...(meta?.allowedEnv !== undefined && { allowedEnv: meta.allowedEnv }),
    ...(node.input !== undefined && { input: emitExpr(node.input) }),
    ...(node.params !== undefined && { params: emitExpr(node.params) as IRObject }),
    ...(node.when !== undefined && { when: emitRef(node.when) }),
    ...(node.timeout !== undefined
      ? { timeoutSeconds: node.timeout.seconds }
      : meta?.maxTimeoutSeconds !== undefined
        ? { timeoutSeconds: meta.maxTimeoutSeconds }
        : undefined),
  };
}

function emitItem(item: WorkflowItem, registry?: ScriptRegistry): IRStep | null {
  switch (item.kind) {
    case "step":     return emitStep(item);
    case "task":     return emitTask(item);
    case "script":   return emitScript(item, registry);
    case "parallel": return emitParallel(item);
    case "gate":     return emitGate(item);
    case "output":   return null; // handled separately
  }
}

// ---------------------------------------------------------------------------
// Workflow name: PascalCase → kebab-case
// ---------------------------------------------------------------------------
function toKebab(name: string): string {
  return name
    .replace(/([A-Z])/g, (_, c, i) => (i > 0 ? "-" : "") + c.toLowerCase())
    .replace(/\s+/g, "-")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Params block → IR params object
// ---------------------------------------------------------------------------
function emitParams(params: WorkflowNode["params"]): IRObject | undefined {
  if (params.length === 0) return undefined;
  const obj: IRObject = {};
  for (const p of params) {
    if (p.default !== undefined) {
      obj[p.name] = emitExpr(p.default);
    } else {
      obj[p.name] = p.type; // emit type string as placeholder
    }
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Top-level emit
// ---------------------------------------------------------------------------
export function emit(ast: WorkflowNode, registry?: ScriptRegistry): IR {
  const steps: IRStep[] = [];
  let output: IROutput | undefined;

  for (const item of ast.items) {
    if (item.kind === "output") {
      const o = item as OutputNode;
      output = { artifact: emitRef(o.artifact) };
      if (o.retention !== undefined) output.retentionDays = o.retention.days;
    } else {
      const ir = emitItem(item, registry);
      if (ir) steps.push(ir);
    }
  }

  const ir: IR = {
    name: toKebab(ast.name),
    version: ast.version,
    steps,
  };

  const params = emitParams(ast.params);
  if (params) ir.params = params;
  if (output) ir.output = output;

  return ir;
}
