# Code Execution

How Tanzen runs user-provided TypeScript and Python scripts, how the sandbox
is structured, and what happens at each layer if a layer is compromised.

---

## Overview

Tanzen can execute arbitrary code as workflow steps or as tools available to
agents. Both paths share the same runtime: a Deno subprocess invoked from
inside the Temporal worker pod. The security model is defense-in-depth — four
independent layers that each assume the one above it has already failed.

```
Layer 1  Deno permission flags        --deny-net, --deny-read, --deny-write …
Layer 2  Pyodide WASM sandbox         Python runs inside a V8 isolate (TS only for escape)
Layer 3  Worker pod security context  Non-root, read-only root FS, dropped caps
Layer 4  Cilium NetworkPolicy         eBPF deny-all egress with explicit allow-list
```

---

## Script execution model

### TypeScript scripts

A `script` DSL step that specifies `language: typescript` (the default) is
executed via `deno run`. The worker:

1. Fetches the script source from SeaweedFS (S3-compatible, key `{id}/{version}.ts`).
2. Prepends a stdin-reader wrapper that injects `input` and `params` as typed
   variables and declares `let output: unknown`.
3. Appends `console.log(JSON.stringify(output))` so the last assigned value
   of `output` becomes the step result.
4. Writes the wrapped source to a temp file in `/tmp`.
5. Spawns `deno run` with deny-by-default permission flags (see Layer 1).
6. Pipes `{ input, params }` JSON to the subprocess's stdin.
7. Reads the final stdout line and parses it as the step output JSON.
8. Writes an execution checkpoint to S3 (see Checkpoints).

The user script's contract is simple:

```typescript
// `input` and `params` are pre-declared and typed as `unknown`.
// Assign the result to `output` before the script ends.

const { a, b } = input as { a: number; b: number };
output = { sum: a + b };
```

### Python scripts

A `script` step with `language: python` follows the same path, but instead of
`deno run <user-script>`, the worker invokes `deno run <pyodide_runner.ts>` and
passes the Python source plus input/params as a JSON envelope on stdin. The
Pyodide runner:

1. Loads Pyodide (CPython compiled to WASM, running inside a Deno V8 isolate).
2. Injects `input` and `params` as Python globals via base64-encoded JSON to
   avoid quoting edge-cases.
3. Executes the user code inside the Pyodide sandbox.
4. Reads the Python `output` variable and emits it as a JSON line on stdout.

The user script's contract:

```python
# `input` (dict) and `params` (dict) are pre-injected globals.
# Assign the result to `output` before the script ends.

text = input.get("text", "")
output = {"word_count": len(text.split())}
```

**Cold-start:** Pyodide takes ~30 s on first load (WASM JIT warm-up). A
`deno compile`-built binary pre-loads Pyodide into a V8 startup snapshot,
reducing cold start to ~300 ms. Set `PYODIDE_RUNNER_PATH` on the worker to
point to the compiled binary.

### Agent code execution tools

When an agent has `code_execution: true` in its config and the operator has
enabled `agent_code_execution_enabled` in Settings, the agent is given two
PydanticAI tools at runtime:

- `execute_python(code: str, timeout: int = 30) → CodeOutput`
- `execute_typescript(code: str, timeout: int = 30) → CodeOutput`

Each tool creates an ephemeral working directory at `/tmp/tanzen-exec/{uuid}/`
(mode `0700`), runs the code via the same Deno subprocess path as script steps,
captures stdout/stderr, and deletes the directory in a `finally` block. The
directory is the only location the subprocess can read or write; everything
else is denied.

---

## Defense-in-depth: the four layers

### Layer 1 — Deno permission flags (V8 isolate boundary)

Every Deno subprocess launched by the worker carries an explicit deny-by-default
flag set. For user TypeScript scripts:

```
--no-prompt          never pause to ask for permission interactively
--no-remote          no network imports (JSR, npm, deno.land/x …)
--deny-net           no TCP/UDP sockets
--deny-env           no env var access
--deny-read          no filesystem reads
--deny-write         no filesystem writes
--deny-run           no subprocess spawning
--deny-ffi           no native library loading
--v8-flags=--max-heap-size=256   hard V8 heap cap (256 MB)
```

Exceptions are granted only when the script's `allowed_hosts` or `allowed_env`
fields are set by a platform admin. Both fields are validated server-side
against a blocklist before the script is stored:

```
Blocked env vars: S3_ACCESS_KEY, S3_SECRET_KEY, DATABASE_URL, REDIS_URL,
                  ANTHROPIC_API_KEY, OPENAI_API_KEY, CLERK_SECRET_KEY, …

Blocked hosts:    tanzen-postgres-rw, tanzen-redis-master, temporal-frontend,
                  seaweedfs-* (internal K8s service names)
```

For Python via Pyodide, the `pyodide_runner.ts` itself is trusted code; it
runs with `--allow-read={executor_dir}` (to load the WASM binary from
`node_modules`) and `--deny-net`. User Python code runs _inside_ Pyodide — a
second V8 isolate boundary. Escaping from Python into the Deno host requires
a Pyodide API call; there is no `eval`-style escape.

**What Layer 1 stops:** file exfiltration, credential harvesting via env vars,
downloading additional code at runtime, establishing C2 channels, spawning
subprocesses, loading native extensions.

**What it doesn't stop:** CPU exhaustion within the heap cap, intentional
infinite loops. The `timeout_seconds` setting (default 30 s) and
`asyncio.wait_for` in the worker kill the process on deadline.

**stdout cap:** The worker reads at most 10 MB of stdout. A script attempting
to OOM the worker via output is truncated before the JSON parse.

---

### Layer 2 — Pyodide WASM sandbox (Python only)

Python code runs inside a Pyodide CPython interpreter compiled to WASM. The V8
engine treats WASM as a sandboxed memory region; Python bytecode cannot address
memory outside the WASM linear memory segment without going through Pyodide's
explicit bridge APIs. There is no `ctypes`, no `cffi`, no native extension
loading (`micropip` installs are disabled; only packages bundled with Pyodide
are available).

This adds a second isolation boundary on top of Layer 1. An attacker who found
a Deno V8 vulnerability and escaped the outer isolate would still be inside
the Pyodide WASM environment with no way to reach the host OS directly.

**What Layer 2 stops:** native memory exploits from Python code, arbitrary C
library loading, `ctypes`-based sandbox escapes.

**What it doesn't stop:** CPU exhaustion (same as Layer 1), logic bugs in
user Python that produce incorrect `output` values (that's a workflow-design
concern, not a security concern).

---

### Layer 3 — Worker pod security context

The Temporal worker pod runs with a restrictive Kubernetes security context:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: [ALL]
```

The root filesystem is read-only. Deno subprocesses write to `/tmp` which is
a writable `emptyDir` volume. Even if a script escaped the Deno sandbox
(Layers 1–2), it would land as a non-root process with no filesystem write
access outside `/tmp` and no Linux capabilities to escalate.

**What Layer 3 stops:** privilege escalation via setuid binaries, writes to
system directories, container breakout via kernel exploits that depend on
root or file capabilities.

**What it doesn't stop:** reading any files visible to the worker's UID in
`/tmp` (mitigated by per-execution ephemeral directories with `mode=0700`),
network calls (mitigated by Layer 4).

---

### Layer 4 — Cilium NetworkPolicy (eBPF kernel layer)

A `CiliumNetworkPolicy` applied to the worker pod enforces egress deny-all
with a named allow-list in the Linux kernel via eBPF. This layer operates
completely outside the container — compromised code inside the pod cannot
disable it, modify it, or detect it from userspace.

**Allowed worker egress:**

| Destination | Port | Purpose |
|-------------|------|---------|
| Temporal frontend | 7233 TCP | Workflow polling and activity heartbeats |
| SeaweedFS filer | 8888 TCP, 8333 TCP | Artifact storage (S3-compatible) |
| Redis | 6379 TCP | Event pub/sub for SSE streaming |
| kube-dns (CoreDNS) | 53 UDP/TCP | Service name resolution |

Everything else — Postgres, the Kubernetes API, any external IP, any internal
service not on the list — is silently dropped by the kernel before a TCP
handshake can complete.

The deny-list is enforced even if the worker process is replaced by arbitrary
attacker code. A Deno exploit that gained native code execution would still not
be able to reach Postgres or the external internet.

**Enable on kind/talos:**

```bash
helm upgrade tanzen ./infra/charts/tanzen -n tanzen-dev \
  --set networkPolicies.enabled=true
```

**Verify with a quick connectivity test from the worker pod:**

```bash
kubectl exec -n tanzen-dev deploy/tanzen-worker -- python3 -c "
import socket
for host, port, expect in [
    ('tanzen-temporal-frontend', 7233, 'ALLOWED'),
    ('tanzen-redis-master', 6379, 'ALLOWED'),
    ('tanzen-postgres-rw', 5432, 'BLOCKED'),
    ('8.8.8.8', 80, 'BLOCKED'),
]:
    try:
        socket.create_connection(
            (socket.gethostbyname(host) if not host[0].isdigit() else host, port),
            timeout=3
        ).close()
        print(f'{host}:{port} REACHABLE  (expect {expect})')
    except socket.timeout:
        print(f'{host}:{port} TIMED OUT  (expect {expect})')
    except Exception as e:
        print(f'{host}:{port} {type(e).__name__}  (expect {expect})')
"
```

---

## What the layers look like together

```
User Python code                  ← no access to host
    │  inside
    ▼
Pyodide WASM V8 isolate           ← no native memory, no ctypes        [Layer 2]
    │  inside
    ▼
Deno process (--deny-net, …)      ← no sockets, no FS, no env          [Layer 1]
    │  inside
    ▼
Worker pod (non-root, cap-drop)   ← no privilege escalation             [Layer 3]
    │  inside
    ▼
Cilium eBPF egress filter         ← no Postgres, no internet            [Layer 4]
```

An attacker must break out of every layer. A zero-day in Pyodide's WASM
bridge still can't reach the network (Layer 4). A Deno V8 escape still can't
write to the filesystem outside `/tmp` (Layer 3). Network-level isolation
holds even if the worker binary is fully replaced (Layer 4 is in the kernel).

---

## Execution checkpoints

After every script step, the worker writes a structured checkpoint to S3:

```
s3://artifacts/snapshots/{run_id}/{step_id}/checkpoint.json
s3://artifacts/snapshots/{run_id}/{step_id}/state.pkl   ← Python only, optional
```

`checkpoint.json` contains the full execution context:

```json
{
  "run_id": "run-abc123",
  "step_id": "normalize",
  "script_key": "uuid/1.0.py",
  "language": "python",
  "input": { "text": "..." },
  "params": {},
  "permissions": { "allowed_hosts": "", "allowed_env": "", "timeout_seconds": 30 },
  "output": { "word_count": 42 },
  "duration_ms": 748.2,
  "worker_version": "dev",
  "timestamp": "2026-04-26T10:56:32Z",
  "has_state": false
}
```

For Python scripts run with `capture_state: true`, the worker also pickles the
Python namespace (user-defined variables) and stores it as `state.pkl`. This
enables full state restore on replay.

### Listing snapshots

```bash
GET /api/runs/:runId/snapshots
```

Returns all step checkpoints recorded for the run.

### Replay

```bash
POST /api/runs/:runId/steps/:stepId/replay
# Body: { "restore_state": true }   # optional, Python only
```

Returns the original checkpoint package — script key, language, input, params,
permissions — so the caller can re-execute the step with identical inputs. With
`restore_state: true`, the response also includes the base64-encoded `state.pkl`
blob for Python namespace restoration.

Full server-side re-execution via Temporal (kick off a new workflow activity
from a checkpoint) is planned but not yet implemented; the current API returns
the data needed for the caller to replay locally or in a new step.

---

## Feature flags

Two runtime toggles are stored in the `settings` DB table and exposed via
`GET /PATCH /api/settings`. Changes take effect immediately — no restart
required.

| Key | Default | Description |
|-----|---------|-------------|
| `scripts_enabled` | `true` | Allows script registration and use in DSL. When `false`, `POST /api/scripts` returns 403 and the DSL compiler rejects `script` steps. |
| `agent_code_execution_enabled` | `false` | Allows agents with `code_execution: true` in their config to call `execute_python()` and `execute_typescript()` tools. |

Toggle via the Settings page or directly:

```bash
curl -X PATCH http://localhost:3000/api/settings \
  -H "Content-Type: application/json" \
  -d '{"agent_code_execution_enabled": true}'
```

Both flags are checked at execution time, not compile time. Disabling scripts
mid-flight does not cancel running steps.

---

## What belongs in OSS vs commercial

Everything described in this document is part of the open-source core. The
reasoning:

**Security must be universal.** Sandboxing, deny-by-default networking, and
Cilium policies are not premium features — they are the baseline that every
deployment needs. Putting them behind a commercial wall would mean OSS
deployments are inherently less safe, which is a poor foundation for an
open-core product.

**Scripts are a core workflow primitive.** The DSL `script` step fills the gap
between pure agent steps and external integrations. Without it, OSS users have
to choose between writing a full agent (expensive, non-deterministic) or an
entirely external service (operational burden). Scripts belong in the core.

**Checkpoints are structured observability.** Writing checkpoint.json to S3
after each step is a natural extension of the artifact model already in place.
The data is there whether or not anything reads it.

**The replay API is OSS.** Returning checkpoint data so a step can be re-run
is useful for debugging in any context.

The commercial tier is the right place for:

| Capability | Why commercial |
|------------|---------------|
| **Time-machine UI** — visual step timeline with snapshot browser, side-by-side output diff, one-click replay in the workflow canvas | High engineering cost; strong enterprise appeal for post-incident review |
| **Server-side replay** — re-running a step as a new Temporal activity from a saved checkpoint, with full state restore, wired into the run history | Requires careful Temporal workflow history management; niche use case that justifies paid tier |
| **Managed Kata VM layer** — running each Deno subprocess inside a Kata microVM (hardware-isolated, separate kernel) for environments that need VM-level isolation | Infrastructure cost (Kata overhead ~100 ms/exec); only relevant for high-compliance deployments |
| **Execution audit trail** — signed, append-only log of every script execution with content-addressed checkpoint hashes; exportable for compliance | Adds storage and signing infrastructure; typically required by critical industries |

The line: OSS provides the sandbox and the data. Commercial provides the
polished tooling on top of that data and the higher-assurance isolation options
for critical environments.
