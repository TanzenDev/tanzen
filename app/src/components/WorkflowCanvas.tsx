/**
 * WorkflowCanvas — React Flow visual editor for Tanzen workflows.
 *
 * DSL → compile → IR → graph nodes/edges
 * graph nodes/edges → graphToDsl → DSL text
 */
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  addEdge,
  reconnectEdge,
  Handle,
  Position,
  useReactFlow,
  ReactFlowProvider,
  BackgroundVariant,
  MarkerType,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useScripts } from "../api/hooks.js";
import type { Agent, Script } from "../api/client.js";

// ─── Data shapes ─────────────────────────────────────────────────────────────

export interface StepData extends Record<string, unknown> {
  stepId: string;
  agentId: string;
  agentVersion: string;
  inputExpr: string;
  whenExpr: string;
  timeout: string;
  mcpCount?: number;
}
export interface GateData extends Record<string, unknown> {
  stepId: string;
  assignee: string;
  timeout: string;
  inputExpr: string;
}
export interface OutputData extends Record<string, unknown> {
  artifactRef: string;
}
export interface TaskData extends Record<string, unknown> {
  stepId: string;
  action: string;
  inputExpr: string;
  paramsJson: string;
  whenExpr: string;
}
export interface ScriptData extends Record<string, unknown> {
  stepId: string;
  scriptName: string;
  scriptVersion: string;
  inputExpr: string;
  paramsJson: string;
  whenExpr: string;
  timeout: string;
}

// ─── IR shape (from compile endpoint) ────────────────────────────────────────

interface IrAgentStep {
  type: "agent";
  id: string;
  agentId: string;
  agentVersion: string;
  input?: unknown;
  when?: { $ref: string };
  timeoutSeconds?: number;
}
interface IrGateStep {
  type: "gate";
  id: string;
  assignee: string | { $ref: string };
  timeoutSeconds?: number;
  input?: unknown;
}
interface IrParallelStep { type: "parallel"; id: string }
interface IrTaskStep {
  type: "task";
  id: string;
  action: string;
  input?: unknown;
  params?: Record<string, unknown>;
  when?: { $ref: string };
  timeoutSeconds?: number;
}
interface IrScriptStep {
  type: "script";
  id: string;
  scriptName: string;
  scriptVersion: string;
  s3Key: string;
  input?: unknown;
  params?: Record<string, unknown>;
  when?: { $ref: string };
  timeoutSeconds?: number;
}
type IrStep = IrAgentStep | IrGateStep | IrParallelStep | IrTaskStep | IrScriptStep;

interface WorkflowIR {
  name: string;
  version: string;
  steps: IrStep[];
  output?: { artifact: { $ref: string }; retentionDays?: number };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimeout(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

// ─── DSL generation (graph → DSL) ────────────────────────────────────────────

export function graphToDsl(nodes: Node[], edges: Edge[], workflowName: string): string {
  const ordered = [...nodes].sort((a, b) => a.position.x - b.position.x);
  const incoming = new Map<string, Edge[]>();
  for (const e of edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push(e);
  }
  const pascal = workflowName
    .replace(/[^a-zA-Z0-9\s_-]/g, "")
    .split(/[-_\s]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");

  let dsl = `workflow ${pascal || "MyWorkflow"} {\n  version: "1.0.0"\n\n`;

  for (const node of ordered) {
    const inEdges = incoming.get(node.id) ?? [];
    const prevId = inEdges[0]?.source;
    const prevNode = prevId ? nodes.find((n) => n.id === prevId) : undefined;

    if (node.type === "stepNode") {
      const d = node.data as StepData;
      const id = d.stepId || node.id;
      dsl += `  step ${id} {\n`;
      dsl += `    agent: ${d.agentId || "my-agent"} @ "${d.agentVersion || "1.0"}"\n`;
      // Prefer stored inputExpr (populated from IR); fall back to graph-derived for new nodes
      if (d.inputExpr) {
        dsl += `    input: ${d.inputExpr}\n`;
      } else if (prevNode?.type === "stepNode" || prevNode?.type === "taskNode") {
        const pd = prevNode.data as StepData | TaskData;
        dsl += `    input: ${(pd as StepData).stepId || prevNode.id}.output\n`;
      } else if (prevNode?.type === "gateNode") {
        const pd = prevNode.data as GateData;
        dsl += `    input: ${pd.stepId || prevNode.id}.input\n`;
      } else {
        dsl += `    input: run.input\n`;
      }
      if (d.whenExpr) dsl += `    when: ${d.whenExpr}\n`;
      if (d.timeout) dsl += `    timeout: ${d.timeout}\n`;
      dsl += `  }\n\n`;
    } else if (node.type === "gateNode") {
      const d = node.data as GateData;
      const id = d.stepId || node.id;
      dsl += `  gate ${id} {\n`;
      dsl += `    assignee: "${d.assignee || "reviewer@example.com"}"\n`;
      if (d.inputExpr) {
        dsl += `    input: ${d.inputExpr}\n`;
      } else if (prevNode?.type === "stepNode" || prevNode?.type === "taskNode") {
        const pd = prevNode.data as StepData | TaskData;
        dsl += `    input: ${(pd as StepData).stepId || prevNode.id}.output\n`;
      }
      if (d.timeout) dsl += `    timeout: ${d.timeout}\n`;
      dsl += `  }\n\n`;
    } else if (node.type === "taskNode") {
      const d = node.data as TaskData;
      const id = d.stepId || node.id;
      dsl += `  task ${id} {\n`;
      dsl += `    action: "${d.action || "filter"}"\n`;
      if (d.inputExpr) {
        dsl += `    input: ${d.inputExpr}\n`;
      } else if (prevNode?.type === "stepNode" || prevNode?.type === "taskNode") {
        const pd = prevNode.data as StepData | TaskData;
        dsl += `    input: ${(pd as StepData).stepId || prevNode.id}.output\n`;
      }
      if (d.paramsJson && d.paramsJson !== "{}") {
        try { JSON.parse(d.paramsJson); dsl += `    params: ${d.paramsJson}\n`; } catch { /* skip invalid */ }
      }
      if (d.whenExpr) dsl += `    when: ${d.whenExpr}\n`;
      dsl += `  }\n\n`;
    } else if (node.type === "scriptNode") {
      const d = node.data as ScriptData;
      const id = d.stepId || node.id;
      dsl += `  script ${id} {\n`;
      dsl += `    name: "${d.scriptName || "my-script"}"\n`;
      if (d.scriptVersion && d.scriptVersion !== "latest") dsl += `    version: "${d.scriptVersion}"\n`;
      if (d.inputExpr) {
        dsl += `    input: ${d.inputExpr}\n`;
      } else if (prevNode?.type === "stepNode" || prevNode?.type === "taskNode" || prevNode?.type === "scriptNode") {
        const pd = prevNode.data as StepData | TaskData | ScriptData;
        dsl += `    input: ${(pd as StepData).stepId || prevNode.id}.output\n`;
      }
      if (d.paramsJson && d.paramsJson !== "{}") {
        try { JSON.parse(d.paramsJson); dsl += `    params: ${d.paramsJson}\n`; } catch { /* skip invalid */ }
      }
      if (d.whenExpr) dsl += `    when: ${d.whenExpr}\n`;
      if (d.timeout) dsl += `    timeout: ${d.timeout}\n`;
      dsl += `  }\n\n`;
    } else if (node.type === "outputNode") {
      const d = node.data as OutputData;
      const ref = d.artifactRef ||
        (prevNode?.type === "stepNode" || prevNode?.type === "taskNode" || prevNode?.type === "scriptNode"
          ? `${(prevNode.data as StepData).stepId || prevNode.id}.output`
          : "step1.output");
      dsl += `  output {\n    artifact: ${ref}\n  }\n`;
    }
  }
  return dsl + `}`;
}

// ─── IR → graph ──────────────────────────────────────────────────────────────

const Y_CENTER = 200;
const X_STEP  = 220;

export function irToGraph(ir: WorkflowIR): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let x = 40;
  let prevId: string | null = null;

  function link(source: string, target: string) {
    edges.push({ id: `e-${source}-${target}`, source, target, markerEnd: { type: MarkerType.ArrowClosed } });
  }

  for (const step of ir.steps) {
    if (step.type === "agent") {
      const s = step as IrAgentStep;
      nodes.push({
        id: s.id, type: "stepNode", position: { x, y: Y_CENTER },
        data: {
          stepId: s.id, agentId: s.agentId ?? "", agentVersion: s.agentVersion ?? "1.0",
          inputExpr: (s.input as { $ref?: string })?.$ref ?? "",
          whenExpr: s.when?.$ref ?? "",
          timeout: s.timeoutSeconds ? formatTimeout(s.timeoutSeconds) : "",
        } satisfies StepData,
      });
      if (prevId) link(prevId, s.id);
      prevId = s.id; x += X_STEP;
    } else if (step.type === "gate") {
      const s = step as IrGateStep;
      const assignee = typeof s.assignee === "string" ? s.assignee : (s.assignee as { $ref: string }).$ref;
      nodes.push({
        id: s.id, type: "gateNode", position: { x, y: Y_CENTER },
        data: {
          stepId: s.id, assignee,
          timeout: s.timeoutSeconds ? formatTimeout(s.timeoutSeconds) : "",
          inputExpr: (s.input as { $ref?: string })?.$ref ?? "",
        } satisfies GateData,
      });
      if (prevId) link(prevId, s.id);
      prevId = s.id; x += X_STEP;
    } else if (step.type === "task") {
      const s = step as IrTaskStep;
      nodes.push({
        id: s.id, type: "taskNode", position: { x, y: Y_CENTER },
        data: {
          stepId: s.id, action: s.action,
          inputExpr: (s.input as { $ref?: string })?.$ref ?? "",
          paramsJson: s.params ? JSON.stringify(s.params) : "{}",
          whenExpr: s.when?.$ref ?? "",
        } satisfies TaskData,
      });
      if (prevId) link(prevId, s.id);
      prevId = s.id; x += X_STEP;
    } else if (step.type === "script") {
      const s = step as IrScriptStep;
      nodes.push({
        id: s.id, type: "scriptNode", position: { x, y: Y_CENTER },
        data: {
          stepId: s.id, scriptName: s.scriptName, scriptVersion: s.scriptVersion,
          inputExpr: (s.input as { $ref?: string })?.$ref ?? "",
          paramsJson: s.params ? JSON.stringify(s.params) : "{}",
          whenExpr: s.when?.$ref ?? "",
          timeout: s.timeoutSeconds ? formatTimeout(s.timeoutSeconds) : "",
        } satisfies ScriptData,
      });
      if (prevId) link(prevId, s.id);
      prevId = s.id; x += X_STEP;
    }
  }
  if (ir.output) {
    const id = "output";
    nodes.push({
      id, type: "outputNode", position: { x, y: Y_CENTER },
      data: { artifactRef: ir.output.artifact.$ref ?? "" } satisfies OutputData,
    });
    if (prevId) link(prevId, id);
  }
  return { nodes, edges };
}

// ─── Custom nodes ─────────────────────────────────────────────────────────────

const H = "!w-2.5 !h-2.5 !rounded-sm !border !border-slate-600";

function StepNode({ data, selected }: NodeProps) {
  const d = data as StepData;
  return (
    <div className={`rounded border-2 px-3 py-2 min-w-[150px] shadow ${selected ? "border-blue-400" : "border-blue-600"} bg-slate-800`}>
      <Handle type="target" position={Position.Top}    id="top"    className={`${H} !bg-blue-500`} />
      <Handle type="target" position={Position.Left}   id="left"   className={`${H} !bg-blue-500`} />
      <Handle type="source" position={Position.Right}  id="right"  className={`${H} !bg-blue-500`} />
      <Handle type="source" position={Position.Bottom} id="bottom" className={`${H} !bg-blue-500`} />
      <div className="flex items-center justify-between gap-1 mb-0.5">
        <p className="text-[10px] font-bold text-blue-400 uppercase tracking-wider leading-none">Step</p>
        {(d.mcpCount ?? 0) > 0 && (
          <span className="rounded bg-violet-800 px-1 py-0.5 text-[9px] font-medium text-violet-200 leading-none">
            MCP ×{d.mcpCount}
          </span>
        )}
      </div>
      <p className="text-xs font-semibold text-white leading-tight">{d.stepId || "step"}</p>
      {d.agentId && <p className="text-[10px] text-slate-400 font-mono leading-tight truncate">{d.agentId} @ {d.agentVersion}</p>}
      {d.whenExpr && <p className="text-[10px] text-slate-500 leading-tight truncate">when: {d.whenExpr}</p>}
    </div>
  );
}

function GateNode({ data, selected }: NodeProps) {
  const d = data as GateData;
  return (
    <div className={`rounded border-2 px-3 py-2 min-w-[150px] shadow ${selected ? "border-amber-400" : "border-amber-600"} bg-slate-800`}>
      <Handle type="target" position={Position.Top}   id="top"      className={`${H} !bg-amber-500`} />
      <Handle type="target" position={Position.Left}  id="left"     className={`${H} !bg-amber-500`} />
      <Handle type="source" position={Position.Right} id="approved" style={{ top: "30%" }} className={`${H} !bg-green-500`} />
      <Handle type="source" position={Position.Right} id="rejected" style={{ top: "70%" }} className={`${H} !bg-red-500`} />
      <p className="text-[10px] font-bold text-amber-400 uppercase tracking-wider leading-none mb-0.5">Gate</p>
      <p className="text-xs font-semibold text-white leading-tight">{d.stepId || "gate"}</p>
      {d.assignee && <p className="text-[10px] text-slate-400 leading-tight truncate">{d.assignee}</p>}
      <div className="flex flex-col items-end mt-1 gap-0.5">
        <span className="text-[9px] text-green-500">✓ approved →</span>
        <span className="text-[9px] text-red-500">✗ rejected →</span>
      </div>
    </div>
  );
}

function OutputNode({ data, selected }: NodeProps) {
  const d = data as OutputData;
  return (
    <div className={`rounded border-2 px-3 py-2 min-w-[150px] shadow ${selected ? "border-emerald-400" : "border-emerald-700"} bg-slate-800`}>
      <Handle type="target" position={Position.Top}  id="top"  className={`${H} !bg-emerald-500`} />
      <Handle type="target" position={Position.Left} id="left" className={`${H} !bg-emerald-500`} />
      <p className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider leading-none mb-0.5">Output</p>
      <p className="text-[10px] text-slate-400 font-mono leading-tight truncate">{d.artifactRef || "step.output"}</p>
    </div>
  );
}

const BUILTIN_ACTIONS = [
  "filter", "sort", "slice", "deduplicate", "flatten", "map",
  "extract_fields", "parse_csv", "parse_json", "format_json",
  "template", "http_request",
] as const;

function TaskNode({ data, selected }: NodeProps) {
  const d = data as TaskData;
  return (
    <div className={`rounded border-2 px-3 py-2 min-w-[150px] shadow ${selected ? "border-violet-400" : "border-violet-600"} bg-slate-800`}>
      <Handle type="target" position={Position.Top}    id="top"    className={`${H} !bg-violet-500`} />
      <Handle type="target" position={Position.Left}   id="left"   className={`${H} !bg-violet-500`} />
      <Handle type="source" position={Position.Right}  id="right"  className={`${H} !bg-violet-500`} />
      <Handle type="source" position={Position.Bottom} id="bottom" className={`${H} !bg-violet-500`} />
      <p className="text-[10px] font-bold text-violet-400 uppercase tracking-wider leading-none mb-0.5">Task</p>
      <p className="text-xs font-semibold text-white leading-tight">{d.stepId || "task"}</p>
      {d.action && <p className="text-[10px] text-slate-400 font-mono leading-tight truncate">{d.action}</p>}
      {d.whenExpr && <p className="text-[10px] text-slate-500 leading-tight truncate">when: {d.whenExpr}</p>}
    </div>
  );
}

function ScriptNode({ data, selected }: NodeProps) {
  const d = data as ScriptData;
  return (
    <div className={`rounded border-2 px-3 py-2 min-w-[150px] shadow ${selected ? "border-cyan-400" : "border-cyan-600"} bg-slate-800`}>
      <Handle type="target" position={Position.Top}    id="top"    className={`${H} !bg-cyan-500`} />
      <Handle type="target" position={Position.Left}   id="left"   className={`${H} !bg-cyan-500`} />
      <Handle type="source" position={Position.Right}  id="right"  className={`${H} !bg-cyan-500`} />
      <Handle type="source" position={Position.Bottom} id="bottom" className={`${H} !bg-cyan-500`} />
      <p className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider leading-none mb-0.5">Script</p>
      <p className="text-xs font-semibold text-white leading-tight">{d.stepId || "script"}</p>
      {d.scriptName && <p className="text-[10px] text-slate-400 font-mono leading-tight truncate">{d.scriptName}</p>}
      {d.whenExpr && <p className="text-[10px] text-slate-500 leading-tight truncate">when: {d.whenExpr}</p>}
    </div>
  );
}

// nodeTypes at module level — stable reference, prevents React Flow warning #002
const nodeTypes = { stepNode: StepNode, gateNode: GateNode, outputNode: OutputNode, taskNode: TaskNode, scriptNode: ScriptNode };

// ─── Edit panel ───────────────────────────────────────────────────────────────

function EditPanel({
  node, agents, onUpdate, onDelete, onDuplicate,
}: {
  node: Node;
  agents: Agent[];
  onUpdate: (id: string, data: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
}) {
  const d = node.data as Record<string, unknown>;
  const { data: scriptsData } = useScripts();
  const scripts: Script[] = scriptsData?.items ?? [];

  function field(label: string, key: string, placeholder = "") {
    return (
      <div key={key}>
        <label className="block text-[10px] text-slate-400 mb-0.5">{label}</label>
        <input
          type="text"
          className="w-full rounded bg-slate-700 px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          value={String(d[key] ?? "")}
          placeholder={placeholder}
          onChange={(e) => onUpdate(node.id, { ...d, [key]: e.target.value })}
        />
      </div>
    );
  }

  return (
    <div className="w-52 shrink-0 border-l border-slate-700 bg-slate-900 p-3 overflow-y-auto space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
          {node.type === "stepNode" ? "Step" : node.type === "gateNode" ? "Gate" : node.type === "taskNode" ? "Task" : node.type === "scriptNode" ? "Script" : "Output"}
        </p>
        <div className="flex gap-1">
          {node.type !== "outputNode" && (
            <button
              onClick={() => onDuplicate(node.id)}
              className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-600"
              title="Duplicate (⌘D)"
            >
              Copy
            </button>
          )}
          <button
            onClick={() => onDelete(node.id)}
            className="rounded bg-red-900 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-700"
            title="Delete (⌫)"
          >
            Delete
          </button>
        </div>
      </div>

      {node.type === "stepNode" && (
        <>
          {field("Step ID", "stepId", "extract")}
          <div>
            <label className="block text-[10px] text-slate-400 mb-0.5">Agent</label>
            <select
              className="w-full rounded bg-slate-700 px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              value={String(d.agentId ?? "")}
              onChange={(e) => {
                const agentName = e.target.value;
                const agent = agents.find((a) => a.name === agentName);
                onUpdate(node.id, { ...d, agentId: agentName, mcpCount: agent?.mcp_servers?.length ?? 0 });
              }}
            >
              <option value="">— select agent —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.name}>{a.name}</option>
              ))}
            </select>
          </div>
          {field("Agent version", "agentVersion", "1.0")}
          {field("Input ref", "inputExpr", "run.input")}
          {field("When (optional)", "whenExpr", "gate1.approved")}
          {field("Timeout (optional)", "timeout", "30m")}
        </>
      )}
      {node.type === "gateNode" && (
        <>
          {field("Gate ID", "stepId", "review")}
          {field("Assignee", "assignee", "reviewer@example.com")}
          {field("Input ref", "inputExpr", "step1.output")}
          {field("Timeout (optional)", "timeout", "72h")}
        </>
      )}
      {node.type === "taskNode" && (
        <>
          {field("Task ID", "stepId", "filterRows")}
          <div>
            <label className="block text-[10px] text-slate-400 mb-0.5">Action</label>
            <select
              className="w-full rounded bg-slate-700 px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-violet-500"
              value={String(d.action ?? "")}
              onChange={(e) => onUpdate(node.id, { ...d, action: e.target.value })}
            >
              <option value="">— select action —</option>
              {BUILTIN_ACTIONS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          {field("Input ref (optional)", "inputExpr", "step1.output")}
          <div>
            <label className="block text-[10px] text-slate-400 mb-0.5">Params (JSON)</label>
            <textarea
              className="w-full rounded bg-slate-700 px-2 py-1 text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-violet-500 resize-none"
              rows={3}
              value={String(d.paramsJson ?? "{}")}
              onChange={(e) => onUpdate(node.id, { ...d, paramsJson: e.target.value })}
            />
          </div>
          {field("When (optional)", "whenExpr", "gate1.approved")}
        </>
      )}
      {node.type === "scriptNode" && (
        <>
          {field("Script ID", "stepId", "runScript")}
          <div>
            <label className="block text-[10px] text-slate-400 mb-0.5">Script name</label>
            <select
              className="w-full rounded bg-slate-700 px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-cyan-500"
              value={String(d.scriptName ?? "")}
              onChange={(e) => onUpdate(node.id, { ...d, scriptName: e.target.value })}
            >
              <option value="">— select script —</option>
              {scripts.map((s) => (
                <option key={s.id} value={s.name}>{s.name}</option>
              ))}
            </select>
          </div>
          {field("Version (optional)", "scriptVersion", "latest")}
          {field("Input ref (optional)", "inputExpr", "step1.output")}
          <div>
            <label className="block text-[10px] text-slate-400 mb-0.5">Params (JSON)</label>
            <textarea
              className="w-full rounded bg-slate-700 px-2 py-1 text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-cyan-500 resize-none"
              rows={3}
              value={String(d.paramsJson ?? "{}")}
              onChange={(e) => onUpdate(node.id, { ...d, paramsJson: e.target.value })}
            />
          </div>
          {field("When (optional)", "whenExpr", "gate1.approved")}
          {field("Timeout (optional)", "timeout", "30s")}
        </>
      )}
      {node.type === "outputNode" && (
        <>{field("Artifact ref", "artifactRef", "step1.output")}</>
      )}
    </div>
  );
}

// ─── History helpers ──────────────────────────────────────────────────────────

interface Snapshot { nodes: Node[]; edges: Edge[] }

function snapOf(nodes: Node[], edges: Edge[]): Snapshot {
  return { nodes: nodes.map((n) => ({ ...n })), edges: edges.map((e) => ({ ...e })) };
}

// ─── Main canvas (inside ReactFlowProvider) ───────────────────────────────────

interface WorkflowCanvasProps {
  initialIr?: WorkflowIR | null;
  onExportDsl: (dsl: string) => void;
  workflowName: string;
  agents: Agent[];
}

function CanvasWithState({ initialIr, onExportDsl, workflowName, agents }: WorkflowCanvasProps) {
  const { fitView, getNodes, getEdges } = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Stable nodeTypes ref — suppresses React Flow warning #002
  const stableNodeTypes = useMemo(() => nodeTypes, []);

  // ── History ────────────────────────────────────────────────────────────────
  const history  = useRef<Snapshot[]>([snapOf([], [])]);
  const hIdx     = useRef(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const pushHistory = useCallback(() => {
    // Read from React Flow store (Zustand) — always current after setNodes/setEdges
    requestAnimationFrame(() => {
      const snap = snapOf(getNodes(), getEdges());
      history.current = history.current.slice(0, hIdx.current + 1);
      history.current.push(snap);
      if (history.current.length > 60) history.current.shift();
      else hIdx.current++;
      setCanUndo(hIdx.current > 0);
      setCanRedo(false);
    });
  }, [getNodes, getEdges]);

  const undo = useCallback(() => {
    if (hIdx.current <= 0) return;
    hIdx.current--;
    const { nodes: n, edges: e } = history.current[hIdx.current];
    setNodes(n); setEdges(e);
    setCanUndo(hIdx.current > 0);
    setCanRedo(true);
    setSelectedId(null);
  }, [setNodes, setEdges]);

  const redo = useCallback(() => {
    if (hIdx.current >= history.current.length - 1) return;
    hIdx.current++;
    const { nodes: n, edges: e } = history.current[hIdx.current];
    setNodes(n); setEdges(e);
    setCanUndo(true);
    setCanRedo(hIdx.current < history.current.length - 1);
    setSelectedId(null);
  }, [setNodes, setEdges]);

  // ── Load IR ───────────────────────────────────────────────────────────────
  const loaded = useRef(false);
  useEffect(() => {
    if (!initialIr || loaded.current) return;
    loaded.current = true;
    const { nodes: n, edges: e } = irToGraph(initialIr);
    setNodes(n); setEdges(e);
    requestAnimationFrame(() => {
      history.current = [snapOf(getNodes(), getEdges())];
      hIdx.current = 0;
      setCanUndo(false); setCanRedo(false);
    });
  }, [initialIr, setNodes, setEdges, getNodes, getEdges]);

  // ── Node operations ───────────────────────────────────────────────────────
  const addNode = useCallback((newNode: Node) => {
    setNodes((ns) => [...ns, newNode]);
    pushHistory();
    requestAnimationFrame(() => fitView({ padding: 0.25, duration: 200 }));
  }, [setNodes, pushHistory, fitView]);

  const addStep = useCallback(() => {
    const stepNum = nodes.filter((n) => n.type === "stepNode").length + 1;
    addNode({
      id: crypto.randomUUID(),
      type: "stepNode",
      position: { x: maxX(nodes) + X_STEP, y: Y_CENTER },
      data: {
        stepId: `step-${stepNum}`, agentId: agents[0]?.name ?? "",
        agentVersion: "1.0", inputExpr: "", whenExpr: "", timeout: "",
      } satisfies StepData,
    });
  }, [nodes, agents, addNode]);

  const addGate = useCallback(() => {
    const gateNum = nodes.filter((n) => n.type === "gateNode").length + 1;
    addNode({
      id: crypto.randomUUID(),
      type: "gateNode",
      position: { x: maxX(nodes) + X_STEP, y: Y_CENTER },
      data: { stepId: `gate-${gateNum}`, assignee: "", timeout: "", inputExpr: "" } satisfies GateData,
    });
  }, [nodes, addNode]);

  const addTask = useCallback(() => {
    const taskNum = nodes.filter((n) => n.type === "taskNode").length + 1;
    addNode({
      id: crypto.randomUUID(),
      type: "taskNode",
      position: { x: maxX(nodes) + X_STEP, y: Y_CENTER },
      data: {
        stepId: `task-${taskNum}`, action: "filter",
        inputExpr: "", paramsJson: "{}", whenExpr: "",
      } satisfies TaskData,
    });
  }, [nodes, addNode]);

  const addScript = useCallback(() => {
    const scriptNum = nodes.filter((n) => n.type === "scriptNode").length + 1;
    addNode({
      id: crypto.randomUUID(),
      type: "scriptNode",
      position: { x: maxX(nodes) + X_STEP, y: Y_CENTER },
      data: {
        stepId: `script-${scriptNum}`, scriptName: "", scriptVersion: "latest",
        inputExpr: "", paramsJson: "{}", whenExpr: "", timeout: "",
      } satisfies ScriptData,
    });
  }, [nodes, addNode]);

  const addOutput = useCallback(() => {
    if (nodes.some((n) => n.type === "outputNode")) return;
    addNode({
      id: crypto.randomUUID(),
      type: "outputNode",
      position: { x: maxX(nodes) + X_STEP, y: Y_CENTER },
      data: { artifactRef: "" } satisfies OutputData,
    });
  }, [nodes, addNode]);

  const deleteNode = useCallback((nodeId: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== nodeId));
    setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setSelectedId((prev) => (prev === nodeId ? null : prev));
    pushHistory();
  }, [setNodes, setEdges, pushHistory]);

  const duplicateNode = useCallback((nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const newId = crypto.randomUUID();
    addNode({
      ...node,
      id: newId,
      selected: false,
      position: { x: node.position.x + 24, y: node.position.y + 24 },
      data: {
        ...node.data,
        ...(node.data.stepId ? { stepId: `${String(node.data.stepId)}-copy` } : {}),
      },
    });
    setSelectedId(newId);
  }, [nodes, addNode]);

  const updateNodeData = useCallback((nodeId: string, data: Record<string, unknown>) => {
    setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data } : n)));
    pushHistory();
  }, [setNodes, pushHistory]);

  // ── Edge operations ───────────────────────────────────────────────────────
  const onConnect = useCallback((connection: Connection) => {
    setEdges((eds) => addEdge({ ...connection, markerEnd: { type: MarkerType.ArrowClosed } }, eds));
    pushHistory();
  }, [setEdges, pushHistory]);

  const onReconnect = useCallback((oldEdge: Edge, newConnection: Connection) => {
    setEdges((eds) => reconnectEdge(oldEdge, newConnection, eds));
    pushHistory();
  }, [setEdges, pushHistory]);

  const onNodesDelete  = useCallback(() => { pushHistory(); setSelectedId(null); }, [pushHistory]);
  const onEdgesDelete  = useCallback(() => { pushHistory(); }, [pushHistory]);
  const onNodeDragStop = useCallback(() => { pushHistory(); }, [pushHistory]);

  // ── Clipboard ─────────────────────────────────────────────────────────────
  const clipboard = useRef<Node[]>([]);

  const pasteNodes = useCallback(() => {
    if (!clipboard.current.length) return;
    const ts = Date.now();
    const copies: Node[] = clipboard.current.map((n, i) => ({
      ...n,
      id: `${n.type?.replace("Node", "") ?? "node"}-${ts}-${i}`,
      selected: false,
      position: { x: n.position.x + 24, y: n.position.y + 24 },
      data: {
        ...n.data,
        ...(n.data.stepId ? { stepId: `${String(n.data.stepId)}-copy` } : {}),
      },
    }));
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), ...copies]);
    pushHistory();
    requestAnimationFrame(() => fitView({ padding: 0.25, duration: 200 }));
  }, [setNodes, pushHistory, fitView]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  // Keep a ref to selectedId so the keydown handler is never stale
  const selectedIdRef = useRef(selectedId);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const tag = (e.target as HTMLElement).tagName;
      const inInput = ["INPUT", "SELECT", "TEXTAREA"].includes(tag);
      if (meta && e.key === "z" && !e.shiftKey)                   { e.preventDefault(); undo(); }
      else if (meta && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
      else if (meta && e.key === "c") {
        clipboard.current = nodes.filter((n) => n.selected || n.id === selectedIdRef.current);
      }
      else if (meta && e.key === "v")                              { pasteNodes(); }
      else if (meta && e.key === "d")                              { e.preventDefault(); if (selectedIdRef.current) duplicateNode(selectedIdRef.current); }
      else if (!inInput && (e.key === "Backspace" || e.key === "Delete") && selectedIdRef.current) {
        deleteNode(selectedIdRef.current);
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
    // nodes is needed here so clipboard captures current node data
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo, redo, pasteNodes, duplicateNode, deleteNode, nodes]);

  // ── Render ────────────────────────────────────────────────────────────────
  const selectedNode = selectedId ? nodes.find((n) => n.id === selectedId) : null;
  const hasOutput = nodes.some((n) => n.type === "outputNode");

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="flex h-full border border-slate-700 rounded-lg overflow-hidden outline-none focus:ring-1 focus:ring-slate-500"
      // Ensure keyboard events are captured when clicking anywhere in the canvas
      onMouseDown={() => containerRef.current?.focus()}
    >
      {/* Canvas column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div className="flex items-center gap-1 border-b border-slate-700 bg-slate-900 px-2 py-1.5 shrink-0 flex-wrap">
          <button onClick={addStep}   className="rounded bg-blue-700    px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-600">+ Step</button>
          <button onClick={addTask}   className="rounded bg-violet-700  px-2.5 py-1 text-xs font-medium text-white hover:bg-violet-600">+ Task</button>
          <button onClick={addScript} className="rounded bg-cyan-700    px-2.5 py-1 text-xs font-medium text-white hover:bg-cyan-600">+ Script</button>
          <button onClick={addGate}   className="rounded bg-amber-700   px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-600">+ Gate</button>
          <button onClick={addOutput} disabled={hasOutput} className="rounded bg-emerald-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-40">+ Output</button>

          <div className="w-px h-4 bg-slate-700 mx-0.5" />

          <button
            onClick={() => selectedId && duplicateNode(selectedId)}
            disabled={!selectedId}
            title="Duplicate selected (⌘D)"
            className="rounded bg-slate-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-500 disabled:opacity-40"
          >Copy</button>
          <button
            onClick={pasteNodes}
            disabled={clipboard.current.length === 0}
            title="Paste (⌘V)"
            className="rounded bg-slate-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-500 disabled:opacity-40"
          >Paste</button>
          <button
            onClick={() => selectedId && deleteNode(selectedId)}
            disabled={!selectedId}
            title="Delete selected (⌫)"
            className="rounded bg-red-900 px-2.5 py-1 text-xs font-medium text-red-200 hover:bg-red-700 disabled:opacity-40"
          >Delete</button>

          <div className="w-px h-4 bg-slate-700 mx-0.5" />

          <button onClick={undo} disabled={!canUndo} title="Undo (⌘Z)" className="rounded bg-slate-700 px-2 py-1 text-xs font-medium text-white hover:bg-slate-600 disabled:opacity-40">↩ Undo</button>
          <button onClick={redo} disabled={!canRedo} title="Redo (⌘Y)" className="rounded bg-slate-700 px-2 py-1 text-xs font-medium text-white hover:bg-slate-600 disabled:opacity-40">↪ Redo</button>

          <div className="flex-1" />
          <button
            onClick={() => onExportDsl(graphToDsl(nodes, edges, workflowName))}
            className="rounded bg-slate-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-500"
          >Sync → DSL</button>
        </div>

        {/* Flow */}
        <div className="flex-1 relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onReconnect={onReconnect}
            nodeTypes={stableNodeTypes}
            onNodeClick={(_, node) => setSelectedId((prev) => prev === node.id ? null : node.id)}
            onPaneClick={() => setSelectedId(null)}
            onNodesDelete={onNodesDelete}
            onEdgesDelete={onEdgesDelete}
            onNodeDragStop={onNodeDragStop}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            colorMode="dark"
          >
            <Background variant={BackgroundVariant.Dots} color="#334155" gap={16} />
            <Controls showInteractive={false} />
          </ReactFlow>
          {nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <p className="text-slate-600 text-sm select-none">Add steps using the toolbar above</p>
            </div>
          )}
        </div>
      </div>

      {/* Edit panel */}
      {selectedNode && (
        <EditPanel
          node={selectedNode}
          agents={agents}
          onUpdate={updateNodeData}
          onDelete={deleteNode}
          onDuplicate={duplicateNode}
        />
      )}
    </div>
  );
}

function maxX(nodes: Node[]): number {
  return nodes.length === 0 ? -X_STEP : Math.max(...nodes.map((n) => n.position.x));
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasWithState {...props} />
    </ReactFlowProvider>
  );
}
