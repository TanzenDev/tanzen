# OSS + Commercial Extension Architecture

## Context

Tanzen is heading toward an open-source core + commercial extensions model ("open core"). The
challenge: keep the OSS and commercial repos fully independent (no private fork, clean merges),
while still allowing the commercial side to add SSO, multi-tenancy, a time machine debugger,
new AI framework workers, CLI extensions, and other enterprise features.

This document covers: (1) the recommended architecture, (2) the minimal OSS changes needed to
make it work, (3) the full commercial feature roadmap, and (4) the repo + build structure.

---

## Architectural Opinion

### The User's Proposed Approach
> "Make extension points in the OSS repo, import binary artifacts of the OSS build,
> plug in different implementations on the commercial side."

This is the **Open Core** model, used successfully by GitLab, Grafana, HashiCorp Vault,
and Temporal itself. It is the right approach. The key question is *how* extension points
are surfaced for each layer of the stack.

### Recommended Architecture: Build-time composition + sidecar services

Each layer is handled differently because the constraints differ:

| Layer | OSS publishes | Commercial extends via |
|-------|--------------|------------------------|
| **Server** (Hono/Bun) | `@tanzen/server-core` npm pkg | Import + register Hono sub-app |
| **Worker** (Python) | `tanzen-worker` PyPI pkg | Subclass/extend, add activities |
| **App** (React/Vite) | `@tanzen/app-core` npm pkg | Slot system + Vite composition |
| **CLI** (Go/Cobra) | Binary + plugin interface | Cobra command auto-discovery |
| **Infra** (Helm) | `tanzen` OCI chart | Superchart with dependencies |
| **DB** (Postgres) | Core migration runner | Register additional migrations |

### Why not a private fork?
Merges become untenable within 6 months — every OSS release requires manual conflict resolution.
The composition model means commercial CI just bumps a version pin and rebuilds.

### Why not runtime plugin loading (DLL-style)?
Dynamic loading at runtime (dlopen, importlib, eval) trades maintainability for flexibility.
Type safety disappears, errors surface in production, and security attack surface grows.
Build-time composition gives full type checking and static analysis.

### Why not a monorepo with all code visible?
Enterprise code in OSS repo (even behind flags) creates GPL compliance complexity,
leaks IP, and forces all users to ship enterprise code they don't use.

---

## OSS Changes Required

These are **minimal, non-breaking** changes to the OSS repo that create clean seams.
The OSS remains fully functional standalone; commercial code is purely additive.

### 1. Auth Abstraction (`server/src/server/auth.ts`)

Replace the hardcoded Clerk client with a pluggable `AuthProvider` interface:

```typescript
export interface AuthProvider {
  /** Verify a request and return the authenticated user, or null to reject. */
  authenticate(req: Request): Promise<AuthUser | null>;
}

// OSS default: Clerk JWT (current behavior, unchanged)
export class ClerkAuthProvider implements AuthProvider { ... }

// Registration (called once at startup):
let _provider: AuthProvider = new ClerkAuthProvider();
export function setAuthProvider(p: AuthProvider) { _provider = p; }
```

Commercial injects: `setAuthProvider(new SamlAuthProvider(...))` before server starts.

**Files:** `server/src/server/auth.ts`, `server/src/server/index.ts`

---

### 2. Server Plugin Registry (`server/src/server/index.ts`)

Add a `TanzenPlugin` interface and `registerPlugin()` called before the server starts:

```typescript
export interface TanzenPlugin {
  name: string;
  /** Mount additional routes on the /api sub-app */
  routes?: Hono;
  /** Run after migrate() and ensureBuckets() */
  onStartup?: () => Promise<void>;
  /** Additional DB migrations to run idempotently */
  migrations?: () => Promise<void>;
}

const _plugins: TanzenPlugin[] = [];
export function registerPlugin(p: TanzenPlugin) { _plugins.push(p); }
```

In startup sequence:
```typescript
for (const p of _plugins) {
  if (p.migrations) await p.migrations();
}
await migrate();
await ensureBuckets();
for (const p of _plugins) {
  if (p.onStartup) await p.onStartup();
  if (p.routes) api.route(`/${p.name}`, p.routes);
}
```

Commercial `tanzen-enterprise-server` entry point:
```typescript
import { registerPlugin } from "@tanzen/server-core";
import { ssoPlugin } from "./plugins/sso.js";
import { tenancyPlugin } from "./plugins/tenancy.js";
registerPlugin(ssoPlugin);
registerPlugin(tenancyPlugin);
// then start the server normally
```

**Files:** `server/src/server/index.ts`

---

### 3. Worker Activity Extension (`worker/src/tanzen_worker/worker.py`)

Add an extension registry loaded from a Python entry point or env-configured package:

```python
# worker.py
import importlib, os

_extra_activities: list = []
_extra_workflows: list = []

def _load_extensions():
    ext = os.environ.get("TANZEN_WORKER_EXTENSIONS", "")
    for mod_path in (e.strip() for e in ext.split(",") if e.strip()):
        mod = importlib.import_module(mod_path)
        _extra_activities.extend(getattr(mod, "activities", []))
        _extra_workflows.extend(getattr(mod, "workflows", []))

_load_extensions()

worker = Worker(
    client,
    task_queue=TASK_QUEUE,
    workflows=[DynamicWorkflow, *_extra_workflows],
    activities=[*core_activities, *_extra_activities],
)
```

Commercial worker package sets:
`TANZEN_WORKER_EXTENSIONS=tanzen_enterprise.activities,tanzen_enterprise.audit`

**Files:** `worker/src/tanzen_worker/worker.py`

---

### 4. Step Type Extension (`worker/src/tanzen_worker/workflow.py`)

Replace the if/elif chain with a dispatch table + registration API:

```python
_step_handlers: dict[str, Callable] = {}

def register_step_handler(step_type: str, handler: Callable):
    _step_handlers[step_type] = handler

# Built-in registrations:
register_step_handler("agent", DynamicWorkflow._run_agent_step)
register_step_handler("task",  DynamicWorkflow._run_task_step)
# etc.

# Dispatch:
async def _execute(self, ...):
    for step in ir["steps"]:
        handler = _step_handlers.get(step["type"])
        if not handler:
            raise ValueError(f"Unknown step type: {step['type']}")
        result = await handler(self, ...)
```

Commercial registers: `register_step_handler("approval_chain", run_approval_chain)`

**Files:** `worker/src/tanzen_worker/workflow.py`

---

### 5. App Slot System (`app/src/components/`)

Add a React context-based slot/extension registry:

```typescript
// app/src/extensions/registry.ts
interface AppExtension {
  navItems?: Array<{ to: string; label: string; section?: string }>;
  routes?: Array<{ path: string; element: ReactNode }>;
  /** Named UI slots — keyed by slot name, filled by commercial */
  slots?: Record<string, ComponentType>;
}

const registry: AppExtension = { navItems: [], routes: [], slots: {} };
export function registerExtension(ext: AppExtension) { /* merge in */ }
export function useSlot(name: string): ComponentType | null { ... }
```

Commercial app entry:
```typescript
import { registerExtension } from "@tanzen/app-core";
registerExtension({
  navItems: [{ to: "/audit", label: "Audit Log", section: "Config" }],
  routes: [{ path: "/audit", element: <AuditPage /> }],
  slots: { "run-detail-footer": TimeMachineButton },
});
```

Named slots in OSS components: `const Ext = useSlot("run-detail-footer"); {Ext && <Ext run={run} />}`

**Files:** `app/src/extensions/registry.tsx` (new), `app/src/App.tsx`,
`app/src/components/Layout.tsx`, key detail components

---

### 6. CLI Plugin Discovery (`cli/admin/cmd/root.go`)

Auto-discover enterprise commands from binary plugins in PATH (kubectl plugin model):

```go
// root.go: scan PATH for binaries named `tanzenctl-*`
func discoverPlugins(root *cobra.Command) {
    for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
        entries, _ := os.ReadDir(dir)
        for _, e := range entries {
            if strings.HasPrefix(e.Name(), "tanzenctl-") {
                pluginName := strings.TrimPrefix(e.Name(), "tanzenctl-")
                cmd := &cobra.Command{
                    Use: pluginName,
                    RunE: func(cmd *cobra.Command, args []string) error {
                        return exec.Command(e.Name(), args...).Run()
                    },
                }
                root.AddCommand(cmd)
            }
        }
    }
}
```

Commercial ships `tanzenctl-sso`, `tanzenctl-audit`, `tanzenctl-license` binaries.

**Files:** `cli/admin/cmd/root.go`

---

### 7. Published Package Metadata

Add package publishing to each component's CI:

| Package | Registry | Trigger |
|---------|----------|---------|
| `@tanzen/server-core` | npm | OSS release tag |
| `@tanzen/app-core` | npm | OSS release tag |
| `tanzen-worker` | PyPI | OSS release tag |
| `tanzen-worker-sdk` | PyPI | OSS release tag |
| `tanzen` | OCI (Helm) | OSS release tag |
| `tanzen/server` | Docker Hub | OSS release tag |
| `tanzen/worker` | Docker Hub | OSS release tag |

`package.json` / `pyproject.toml` need `exports`/`entry_points` so commercial
imports work with tree-shaking.

---

## Enterprise Feature Roadmap

### Tier 1: Essential (blocks deals)

| Feature | Description | OSS Hook Used |
|---------|-------------|---------------|
| **SSO (SAML/OIDC)** | Okta, Azure AD, Google Workspace | `setAuthProvider()` |
| **Multi-tenancy** | Organizations, isolated workspaces | `TanzenPlugin.migrations()` + middleware |
| **Audit Log** | Immutable trail for SOC2 / ISO 27001 | `TanzenPlugin.routes` + DB |
| **Advanced RBAC** | Teams, projects, fine-grained permissions | `setAuthProvider()` + middleware |
| **SSO-provisioned roles** | SCIM group → Tanzen role mapping | Auth plugin |

### Tier 2: High Value (expansion revenue)

| Feature | Description | OSS Hook Used |
|---------|-------------|---------------|
| **Time Machine Debugger** | Visual step-by-step replay with rewind | `useSlot("run-detail-footer")`, new route |
| **Cost Governance** | Per-team AI spend budgets + chargebacks | Worker activity wrapper |
| **SLA Monitoring** | Workflow SLA enforcement + PagerDuty | Gate step hook |
| **Data Residency** | Per-tenant S3 region/bucket isolation | Storage abstraction |
| **Workflow Approval** | Multi-level promote approval chain | Gate plugin |
| **Priority Support** | SLA + dedicated CSM (non-technical) | — |

### Tier 3: Differentiation (sticky / platform)

| Feature | Description | OSS Hook Used |
|---------|-------------|---------------|
| **LangChain Worker** | LangChain agent framework activity | `TANZEN_WORKER_EXTENSIONS` |
| **CrewAI Worker** | CrewAI multi-agent activity | `TANZEN_WORKER_EXTENSIONS` |
| **AutoGen Worker** | Microsoft AutoGen activity | `TANZEN_WORKER_EXTENSIONS` |
| **Enterprise MCP Registry** | Private MCP catalog + ACL | Plugin routes |
| **Connector Library** | Salesforce, ServiceNow, Workday tasks | Builtin task extension |
| **Compliance Packs** | HIPAA, FedRAMP, PCI-DSS config templates | Helm values + policies |

### Time Machine Debugger (detail)

This is a flagship differentiator. The OSS already stores `run_events` (JSONB event
stream per run). The Time Machine:

1. Reads `run_events` for a completed (or failed) run in chronological order
2. Re-renders the `WorkflowCanvas` frame-by-frame, highlighting active step, showing
   intermediate state values at each event boundary
3. "Rewind" seeks backward through events; "step forward" advances one event
4. Shows agent LLM call content, tool calls, gate decisions, artifact values at each moment
5. Allows "re-run from step N" — clones the run up to that point and re-executes forward

Requires no new OSS data collection — all state is already in `run_events`. Needs:
- OSS slot: `useSlot("run-detail-footer")` → commercial mounts `<TimeMachineButton run={run} />`
- New commercial route `/runs/:id/replay` → `<TimeMachinePage />`
- No OSS server changes needed

---

## Commercial Repo Structure

```
tanzen-enterprise/
├── server/                    # Hono entry point that imports @tanzen/server-core
│   ├── src/
│   │   ├── index.ts           # registerPlugin() calls, then start server
│   │   └── plugins/
│   │       ├── sso/           # SAML/OIDC AuthProvider
│   │       ├── tenancy/       # org middleware + migrations
│   │       ├── audit/         # audit log routes + DB
│   │       └── rbac/          # permission middleware
│   └── package.json           # peerDep: @tanzen/server-core@^X.Y
├── worker/                    # Python package that imports tanzen-worker
│   ├── src/tanzen_enterprise/
│   │   ├── activities.py      # billing, audit, framework activities
│   │   └── step_handlers.py   # approval_chain, etc.
│   └── pyproject.toml         # dep: tanzen-worker>=X.Y
├── app/                       # React app that imports @tanzen/app-core
│   ├── src/
│   │   ├── main.tsx           # registerExtension() calls
│   │   └── features/
│   │       ├── sso/           # SSO login page, org switcher
│   │       ├── audit/         # AuditPage
│   │       ├── time-machine/  # TimeMachinePage + button slot
│   │       └── cost/          # CostGovernancePage
│   └── package.json           # peerDep: @tanzen/app-core@^X.Y
├── cli/                       # Go binaries: tanzenctl-sso, tanzenctl-audit, etc.
│   ├── cmd/sso/main.go
│   └── cmd/audit/main.go
└── helm/                      # Enterprise superchart
    └── charts/tanzen-enterprise/
        ├── Chart.yaml          # depends on tanzen (OSS chart)
        └── templates/
            ├── sso-config.yaml
            └── audit-db.yaml
```

---

## Critical Files to Change (OSS)

| File | Change |
|------|--------|
| `server/src/server/auth.ts` | Extract `AuthProvider` interface, `setAuthProvider()` |
| `server/src/server/index.ts` | Add `TanzenPlugin` interface, plugin loop in startup |
| `worker/src/tanzen_worker/worker.py` | `_load_extensions()` from `TANZEN_WORKER_EXTENSIONS` |
| `worker/src/tanzen_worker/workflow.py` | Replace if/elif with dispatch table + `register_step_handler()` |
| `app/src/extensions/registry.tsx` | New file — slot registry + `registerExtension()` |
| `app/src/App.tsx` | Read routes from extension registry |
| `app/src/components/Layout.tsx` | Read nav items from extension registry |
| `app/src/pages/RunsPage.tsx` | Add `useSlot("run-detail-footer")` |
| `cli/admin/cmd/root.go` | Add `discoverPlugins()` in `Execute()` |
| `server/package.json` | Add `exports` field for npm package publishing |
| `app/package.json` | Add `exports` field for npm package publishing |
| `worker/pyproject.toml` | Add entry point for SDK |

---

## What NOT to put in OSS

- Any enterprise feature implementations (SSO, audit, tenancy)
- License checks or license key validation
- Any reference to `tanzen-enterprise` package names
- Pricing, tier names, or feature gating logic

The OSS plugin interfaces should be documented as "extension points" without
implying they exist only for commercial purposes.

---

## Sequencing (Phased)

### Phase 1 — Lay the seams (2–3 weeks, no user-facing change)
1. `AuthProvider` interface + `setAuthProvider()` — Clerk becomes one impl
2. `TanzenPlugin` interface + startup plugin loop
3. Worker `_load_extensions()` + step dispatch table refactor
4. App extension registry + slot hook in RunsPage and Layout
5. CLI `discoverPlugins()`
6. Publish `@tanzen/server-core`, `@tanzen/app-core`, `tanzen-worker` to registries

### Phase 2 — First enterprise feature end-to-end (3–4 weeks)
1. Prove the model with SSO in commercial repo
2. Set up commercial CI: import OSS packages, run enterprise tests

### Phase 3 — Tier 1 complete (6–8 weeks)
Multi-tenancy, Audit Log, RBAC

### Phase 4 — Tier 2 (3–4 months)
Time Machine Debugger, Cost Governance, SLA Monitoring

### Phase 5 — Tier 3 (ongoing)
Framework workers, connector library, compliance packs

---

## Verification

For Phase 1 (seam changes), verify:
```bash
# Server: start with a no-op plugin — routes still work, no regression
TANZEN_PLUGIN_PATH="" bun run src/server/index.ts
curl http://localhost:3002/api/workflows   # must return 200

# Worker: env var extension loading
TANZEN_WORKER_EXTENSIONS="tests.fixtures.noop_ext" uv run pytest tests/ -q

# App: build with empty extension registry
cd app && npm run build  # must succeed, no type errors

# CLI: plugin discovery with no binaries in PATH
PATH=/tmp tanzenctl --help  # must work, no panic
```

For Phase 2 (SSO), verify with real IdP:
- Okta SAML assertion → `AuthUser` populated
- Non-enterprise server unaffected (Clerk still default)
