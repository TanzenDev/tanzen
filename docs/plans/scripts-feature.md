# Plan: Custom Script Activities

## Context

Tanzen's worker activities are fully static — five hardcoded Python functions, 12 hardcoded
builtin task actions. Admin users need the ability to write short TypeScript scripts that run as
workflow steps without requiring a worker image rebuild. This plan adds a `script` step type to
the DSL, a named script registry, and a Deno-based subprocess executor in the Python worker.

The security model is pragmatic: admin users already have write access to agent configs, MCP
server URLs, and `http_request` task steps that hit arbitrary endpoints. The threat is not a
malicious admin — it is buggy code that hangs or consumes resources. Deno's permission flags
(`--allow-net`, `--deny-run`, etc.) and Temporal activity timeouts provide the right fencing
without the complexity of a second runtime or a separate TypeScript worker.

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Isolation | Deno subprocess per invocation | Process boundary sufficient for admin tier; no second runtime to maintain |
| Code storage | S3 blob (`scripts` bucket) + Postgres metadata | Consistent with agent config and workflow DSL patterns |
| DSL reference | Named script, not inline code | Enables independent versioning and auditing; compiler can validate by name lookup |
| s3Key in IR | Yes — baked in at compile time | Worker needs no DB lookup at runtime; run history is content-addressable |
| Compiler registry | Injected `Map` parameter to `compile()` | Keeps compiler pure/synchronous for unit tests; route handler fetches registry |
| Trust | admin create/edit, admin+author use | Start conservative; expand later |

---

## New Step Type: `script`

### DSL Syntax

```
script fetchJurisdiction {
  name: "fetch-jurisdiction-data"
  input: step1.output
  params: { jurisdiction: params.jurisdiction }
  when: gate1.approved
  timeout: 30s
}
```

`name` is a slug matching a registered script. `version` is optional (default: `latest`, resolved
to a concrete version at compile time). The step `id` is `fetchJurisdiction` (like all other steps).

### IR Schema (added to `types.ts`)

```typescript
export interface IRScriptStep {
  id: string;
  type: "script";
  scriptName: string;
  scriptVersion: string;   // always concrete after compilation
  s3Key: string;           // "scripts/{script_id}/{version}.ts" — embedded at compile time
  input?: IRValue;
  params?: IRObject;
  when?: IRRef;
  timeoutSeconds?: number;
}
```

`IRStep` union gains `IRScriptStep`. `WorkflowItem` AST union gains `ScriptNode`.

---

## Critical Files

| File | Change |
|------|--------|
| `server/src/compiler/types.ts` | Add `ScriptNode` AST type, `IRScriptStep`, update unions |
| `server/src/compiler/lexer.ts` | Add `script` keyword token |
| `server/src/compiler/parser.ts` | Add `parseScript()` producing `ScriptNode` |
| `server/src/compiler/semantic.ts` | Accept `scriptRegistry?: Map<string,{version,s3Key}>` param; add `validateScript()` |
| `server/src/compiler/emitter.ts` | Add `emitScript()` that resolves version/s3Key from registry |
| `server/src/compiler/index.ts` | Make `compile()` accept optional `scriptRegistry`; stays sync (registry pre-fetched) |
| `server/src/server/db.ts` | Add `custom_scripts` + `custom_script_versions` DDL to `migrate()` |
| `server/src/server/routes/scripts.ts` | New file — CRUD routes for script registry |
| `server/src/server/routes/workflows.ts` | `POST /compile` and `POST /` fetch registry before calling `compile()` |
| `server/src/server/index.ts` | Wire `scriptRoutes` at `/api/scripts` |
| `worker/src/tanzen_worker/script_runner.py` | New file — `run_script_activity` with Deno subprocess |
| `worker/src/tanzen_worker/workflow.py` | Add `_run_script_step`, `"script"` branch in `_execute` |
| `worker/src/tanzen_worker/worker.py` | Register `run_script_activity` |
| `worker/Dockerfile` | Install Deno binary |
| `app/src/api/client.ts` | Add `Script` type, `api.scripts.*` methods |
| `app/src/api/hooks.ts` | Add `useScripts`, `useCreateScript`, `useUpdateScript` hooks |
| `app/src/pages/ScriptsPage.tsx` | New file — script list + create/edit with textarea editor |
| `app/src/components/WorkflowCanvas.tsx` | Add `scriptNode` type, `ScriptNode` panel in EditPanel, `graphToDsl` serializer |
| `app/src/App.tsx` | Add `/scripts` route |

---

## DB Schema

Added to the idempotent `migrate()` in `server/src/server/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS custom_scripts (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL UNIQUE,
  description          TEXT NOT NULL DEFAULT '',
  current_version      TEXT NOT NULL DEFAULT '1.0',
  created_by           TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  allowed_hosts        TEXT NOT NULL DEFAULT '',  -- comma-sep hostnames, '' = --deny-net
  allowed_env          TEXT NOT NULL DEFAULT '',  -- comma-sep env var names
  max_timeout_seconds  INTEGER NOT NULL DEFAULT 30
);

CREATE TABLE IF NOT EXISTS custom_script_versions (
  id          TEXT PRIMARY KEY,
  script_id   TEXT NOT NULL REFERENCES custom_scripts(id) ON DELETE CASCADE,
  version     TEXT NOT NULL,
  code_key    TEXT NOT NULL,   -- S3 key: "scripts/{script_id}/{version}.ts"
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted    BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE(script_id, version)
);
```

---

## Scripts API Routes (`routes/scripts.ts`)

```
POST   /api/scripts              Create (admin only) — stores code in S3, inserts metadata
GET    /api/scripts              List — returns {id, name, description, current_version}[]
GET    /api/scripts/:id          Detail with version history
GET    /api/scripts/:id/code     Get current version source code from S3
PUT    /api/scripts/:id          Update — creates new version, bumps current_version
POST   /api/scripts/:id/promote  Promote (admin only)
DELETE /api/scripts/:id          Delete (admin only; blocked if in-use by any IR — future)
```

S3 bucket: `scripts` (new bucket, created by `tanzenctl up`/`install` like `agents` and `artifacts`).
S3 key pattern: `{script_id}/{version}.ts`.

---

## Compiler Changes

### `compile()` signature

```typescript
// compiler/index.ts
export function compile(
  source: string,
  scriptRegistry?: Map<string, { version: string; s3Key: string }>
): CompileResult
```

Still synchronous. The route handler fetches the registry from Postgres before calling `compile()`:

```typescript
// routes/workflows.ts — shared helper
async function loadScriptRegistry(): Promise<Map<string, { version: string; s3Key: string }>> {
  const rows = await sql`
    SELECT cs.name, csv.version, csv.code_key AS s3_key
    FROM custom_scripts cs
    JOIN custom_script_versions csv
      ON csv.script_id = cs.id AND csv.version = cs.current_version
  `;
  return new Map(rows.map((r) => [r.name as string, { version: r.version as string, s3Key: r.s3_key as string }]));
}
```

Called in both `POST /workflows/:id/compile` and `POST /workflows` (create).

### Semantic validation (`semantic.ts`)

`analyze()` gains optional `scriptRegistry` parameter. New `validateScript()` function:

```typescript
function validateScript(node: ScriptNode, registry: Map<string,...> | undefined, ...): void {
  if (registry && !registry.has(node.scriptName)) {
    errors.push(err(node.loc.line, node.loc.col,
      `script '${node.id}': unknown script '${node.scriptName}'. ` +
      `Available: ${[...registry.keys()].join(", ") || "(none registered)"}`));
  }
  // validate refs same as task
}
```

The existing compile error format (`{line, column, message, severity}`) is already displayed inline
in the DSL editor. No UI changes needed for error display.

### Emitter (`emitter.ts`)

`emitScript()` resolves `latest` to the concrete version from the registry and embeds the `s3Key`:

```typescript
function emitScript(node: ScriptNode, registry: Map<...>): IRScriptStep {
  const meta = registry.get(node.scriptName)!;
  return {
    id: node.id, type: "script",
    scriptName: node.scriptName,
    scriptVersion: meta.version,
    s3Key: meta.s3Key,
    ...(node.input && { input: emitExpr(node.input) }),
    ...(node.params && { params: emitExpr(node.params) as IRObject }),
    ...(node.when && { when: emitRef(node.when) }),
    ...(node.timeout && { timeoutSeconds: node.timeout.seconds }),
  };
}
```

---

## Worker Changes

### `script_runner.py` (new file)

```python
@dataclass
class ScriptActivityInput:
    run_id: str
    step_id: str
    script_name: str
    script_version: str
    s3_key: str
    resolved_input: Any
    resolved_params: dict[str, Any]
    allowed_hosts: str      # comma-sep; '' → --deny-net
    allowed_env: str        # comma-sep env var names
    timeout_seconds: int

@activity.defn
async def run_script_activity(inp: ScriptActivityInput) -> ScriptActivityOutput:
    # 1. Fetch source from S3 by s3_key
    # 2. Write to NamedTemporaryFile in /tmp
    # 3. Build Deno invocation with permission flags
    # 4. Pass {"input": ..., "params": ...} via stdin
    # 5. Parse stdout as JSON → output
    # 6. asyncio.wait_for(proc.wait(), inp.timeout_seconds) — SIGKILL on timeout
    # 7. Write run_steps record
```

**Deno permission flags:**
```python
deno_flags = [
    "--no-prompt",
    f"--allow-net={inp.allowed_hosts}" if inp.allowed_hosts else "--deny-net",
    f"--allow-env={inp.allowed_env}" if inp.allowed_env else "--deny-env",
    "--deny-read", "--deny-write", "--deny-run", "--deny-ffi",
]
cmd = ["deno", "run", *deno_flags, script_path]
```

### User script contract (stdin/stdout JSON)

```typescript
// User script receives on stdin:
const { input, params } = JSON.parse(await new Response(Deno.stdin.readable).text());
// User script must write to stdout:
console.log(JSON.stringify({ result: processedData }));
```

### `workflow.py`

New branch in `_execute()`:
```python
elif step_type == "script":
    result = await self._run_script_step(run_id, step, state)
    state.set_output(step_id, {"output": result.output})
```

`_run_script_step` follows the `_run_task_step` pattern.

### `worker/Dockerfile`

```dockerfile
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh
```

Deno is a single ~85MB static binary. No dependency chain. Pin a specific version for reproducibility.

---

## UI Changes

### `ScriptsPage.tsx`

- List table: name, description, version, allowed_hosts
- Create/edit form: name slug, description, `<textarea>` for TypeScript code (CodeMirror Phase 2),
  `allowed_hosts` input (comma-sep), `max_timeout_seconds` number input
- Version history (read-only)

### `WorkflowCanvas.tsx`

- New `scriptNode` type (teal/cyan color — distinct from violet task, blue agent)
- `ScriptData`: `{ stepId, scriptName, scriptVersion, inputExpr, paramsJson, whenExpr }`
- EditPanel: script name dropdown from `useScripts()`, version field (default `"latest"`)
- `graphToDsl()`: serialize `scriptNode` → `script <id> { name: "..." ... }` DSL text
- `irToGraph()`: deserialize `type: "script"` IR → `scriptNode`

### `App.tsx` / `Layout.tsx`

Add `/scripts` route and nav item (admin-only visibility).

---

## Phased Delivery

### Phase 1 — End-to-end proof (~5 days)

1. DB migration (`custom_scripts`, `custom_script_versions`)
2. `routes/scripts.ts` CRUD + S3 storage
3. `script_runner.py` with Deno subprocess
4. `workflow.py` `"script"` branch + `worker.py` registration
5. Deno in `worker/Dockerfile`
6. Compiler: `ScriptNode` AST/IR types, lexer keyword, parser, semantic validation, emitter
7. `compile()` / route: registry injection into both compile and create endpoints
8. `ScriptsPage.tsx` (textarea editor), `WorkflowCanvas.tsx` script node, nav wiring

**End-to-end test**: admin creates a TypeScript script that transforms input, references it in a
workflow DSL, compiles (getting "unknown script" error if mistyped), runs workflow, inspects step
output in run detail page.

### Phase 2 — Polish

- CodeMirror TypeScript editor on ScriptsPage
- "Test script" button: `POST /api/scripts/:id/test` with sample payload → stdout/stderr in ≤10s
- Script usage index (which workflows reference a script — block accidental deletion)
- Separate Kubernetes worker Deployment for script activities (lower memory limits, isolated)
- Thin Tanzen SDK for Deno: typed `getInput()` / `setOutput()` helpers importable from a URL

---

## Verification

```bash
# 1. Create a script via API
curl -X POST http://localhost:3002/api/scripts \
  -H "Content-Type: application/json" \
  -d '{"name":"uppercase","description":"uppercases input","code":"const {input}=JSON.parse(await new Response(Deno.stdin.readable).text());console.log(JSON.stringify(input.toUpperCase()));"}'

# 2. Compile a workflow referencing it
curl -X POST http://localhost:3002/api/workflows/<id>/compile \
  -d '{"dsl":"workflow test {\n  script up {\n    name: \"uppercase\"\n    input: run.input\n  }\n}"}'
# Expected: {ok: true, ir: {...}} — no "unknown script" error

# 3. Run workflow and check step output in run detail
tanzen workflow run <id>
# Expected: step "up" shows uppercased string in artifact output

# 4. Typo test — compile with wrong script name
# Expected: {"ok":false,"errors":[{"line":3,"message":"script 'up': unknown script 'uppercaze'. Available: uppercase"}]}

# 5. Worker test suite
cd worker && GROQ_API_KEY=... .venv/bin/pytest tests/ -v
# All existing tests should still pass; new test_script_activity.py added
```
