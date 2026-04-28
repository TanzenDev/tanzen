/**
 * Pyodide Python sandbox runner for Tanzen.
 *
 * Reads a JSON envelope from stdin, executes Python code inside a Pyodide V8
 * isolate, and writes the result as JSON to stdout.
 *
 * stdin:  { code, input, params, capture_state? }
 * stdout: { output, state_b64? }
 *
 * The `input` and `params` values are injected as Python globals before the
 * user code runs. The user code must assign to `output`.
 *
 * `capture_state`: if true, pickle-serializes the user namespace and returns
 * it as a base64 string in `state_b64` (time-machine checkpoints).
 *
 * Production compile (pre-loads Pyodide into a V8 startup snapshot):
 *   deno compile --allow-read --allow-write=/tmp --allow-env \
 *     --allow-net=jsr.io,registry.npmjs.org \
 *     --output pyodide_runner pyodide_runner.ts
 */
import { runPython } from "@langchain/pyodide-sandbox";

const raw = await new Response(Deno.stdin.readable).text();
const { code, input, params, capture_state } = JSON.parse(raw) as {
  code: string;
  input: unknown;
  params: Record<string, unknown>;
  capture_state?: boolean;
};

// Inject input/params as Python globals via base64 to avoid quoting issues,
// then run user code, then emit output as a JSON line on stdout.
const inputJson = JSON.stringify(input ?? null);
const paramsJson = JSON.stringify(params ?? {});

const wrappedCode = `
import base64 as _b64, json as _json
input = _json.loads(r"""${inputJson.replace(/\\/g, "\\\\").replace(/"""/g, "\\\"\\\"\\\"" )}""")
params = _json.loads(r"""${paramsJson.replace(/\\/g, "\\\\").replace(/"""/g, "\\\"\\\"\\\"" )}""")
output = None
del _b64, _json

${code}

import json as _j_out
print(_j_out.dumps(output))
`;

const captureCode = capture_state
  ? `
import pickle as _p, base64 as _b64, json as _j
_safe: dict = {}
for _k, _v in dict(globals()).items():
    if _k.startswith("_") or _k in ("input", "params", "output"):
        continue
    try:
        _j.dumps({_k: _v})
        _safe[_k] = _v
    except Exception:
        pass
try:
    print(_b64.b64encode(_p.dumps(_safe)).decode())
except Exception:
    print("")
`
  : null;

const result = await runPython(wrappedCode, { stateful: !!capture_state });

if (!result.success) {
  Deno.stderr.write(new TextEncoder().encode(result.error ?? "Python execution failed"));
  Deno.exit(1);
}

// result.stdout is string[] — the last line is our JSON-serialized output.
const stdoutLines = (result.stdout ?? []).filter((l) => l.trim() !== "");
const outputLine = stdoutLines[stdoutLines.length - 1]?.trim() ?? "null";
let output: unknown;
try {
  output = JSON.parse(outputLine);
} catch {
  Deno.stderr.write(new TextEncoder().encode(`output is not valid JSON: ${outputLine}`));
  Deno.exit(1);
}

let state_b64: string | null = null;
if (capture_state && captureCode) {
  const stateResult = await runPython(captureCode, { stateful: false });
  const stateLines = (stateResult.stdout ?? []).filter((l) => l.trim() !== "");
  const stateLine = stateLines[stateLines.length - 1]?.trim() ?? "";
  state_b64 = stateLine || null;
}

console.log(JSON.stringify({ output, state_b64 }));
