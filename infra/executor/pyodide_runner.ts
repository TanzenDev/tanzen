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
 * `capture_state` (M2 time-machine): if true, pickle-serializes the user
 * namespace and returns it as a base64 string in `state_b64`.
 *
 * Production compile (pre-loads Pyodide into a V8 startup snapshot):
 *   deno compile --no-remote --allow-read --allow-write=/tmp \
 *     --output pyodide_runner pyodide_runner.ts
 */
import { PyodideSandbox } from "jsr:@langchain/pyodide-sandbox";

const raw = await new Response(Deno.stdin.readable).text();
const { code, input, params, capture_state } = JSON.parse(raw) as {
  code: string;
  input: unknown;
  params: Record<string, unknown>;
  capture_state?: boolean;
};

const sandbox = await PyodideSandbox.create({ env: {} });

// Inject `input` and `params` via base64 to avoid quoting/escaping issues.
const inputB64 = btoa(unescape(encodeURIComponent(JSON.stringify(input ?? null))));
const paramsB64 = btoa(unescape(encodeURIComponent(JSON.stringify(params ?? {}))));
await sandbox.runCode(`
import base64 as _b64, json as _json
input = _json.loads(_b64.b64decode("${inputB64}").decode())
params = _json.loads(_b64.b64decode("${paramsB64}").decode())
del _b64, _json
`);

// Run user code.
await sandbox.runCode(code);

// Read the `output` variable the script must set.
const outputResult = await sandbox.runCode(
  `import json as _j; _j.dumps(output) if "output" in dir() else "null"`
);
const outputJson: string = (outputResult?.result ?? outputResult ?? "null") as string;
const output = JSON.parse(outputJson);

// M2: optionally serialize the Python namespace for time-machine checkpoints.
let state_b64: string | null = null;
if (capture_state) {
  const stateResult = await sandbox.runCode(`
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
    _b64.b64encode(_p.dumps(_safe)).decode()
except Exception:
    None
`);
  const raw_state = stateResult?.result ?? stateResult;
  state_b64 = (typeof raw_state === "string" && raw_state !== "None") ? raw_state : null;
}

await sandbox.destroy();
console.log(JSON.stringify({ output, state_b64 }));
