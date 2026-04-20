# Dev Environment Findings

Lessons learned from debugging the local dev setup. Intended to save time on future sessions.

---

## 1. Two Kubernetes namespaces: `tanzen` vs `tanzen-dev`

All kubectl port-forwards and actual runtime resources live in `tanzen-dev`, **not** `tanzen`.

```
kubectl port-forward -n tanzen-dev svc/tanzen-temporal-frontend 7233:7233
kubectl port-forward -n tanzen-dev svc/tanzen-postgres-rw 5432:5432
kubectl port-forward -n tanzen-dev svc/tanzen-redis-master 6379:6379
kubectl port-forward -n tanzen-dev svc/seaweedfs-filer 8333:8333
```

The `tanzen` namespace contains a **separate** Temporal stack that is **not** used by the dev environment. Looking at pods in `tanzen` will give misleading information.

---

## 2. The Python worker runs in Kubernetes, not locally

The Temporal activity/workflow worker is deployed as `tanzen-worker` deployment in `tanzen-dev`. There is normally **no local Python worker** running. Starting a local worker with `TASK_QUEUE=tanzen-worker` will cause it to compete with (and partially intercept) tasks from the k8s worker.

**Do not run a local worker** unless you are intentionally testing something. If you accidentally start one, kill it immediately:

```bash
kill $(pgrep -f tanzen-worker)
```

### Identifying which worker handled a task

The Temporal workflow history (`temporal workflow show`) includes a stack trace that reveals the worker's file path:
- `/app/src/tanzen_worker/...` → k8s worker
- `/Users/scox/dev/conduit/worker/.venv/...` → local worker

---

## 3. Local `.venv` is missing key dependencies

The local worker venv at `/Users/scox/dev/conduit/worker/.venv` does **not** have `asyncpg` or `redis` installed. This means a locally-run worker can execute Temporal activities but silently fails all DB and Redis writes (the `except Exception: pass` best-effort wrappers swallow the `ModuleNotFoundError`).

Symptoms: run stays in `running` status forever; no `step_failed` event in `run_events`.

---

## 4. Updating worker code requires a Docker build + Kind load

The k8s worker runs from the `tanzen-worker:latest` image loaded into the Kind cluster. Source changes are **not** picked up automatically.

```bash
cd /Users/scox/dev/conduit/worker
docker build -t tanzen-worker:latest .
kind load docker-image tanzen-worker:latest --name tanzen
kubectl rollout restart deployment tanzen-worker -n tanzen-dev
```

The cluster name for `kind load` is `tanzen` (context is `kind-tanzen`); the namespace for `kubectl` is `tanzen-dev`.

---

## 5. Task queue names must match

| Component | Config | Default value |
|-----------|--------|---------------|
| API server (`temporal.ts`) | `TEMPORAL_TASK_QUEUE` env | `tanzen-worker` |
| k8s worker deployment | `TASK_QUEUE` env | `tanzen-worker` |
| Local worker (`worker.py`) | `TASK_QUEUE` env | `tanzen-workflows` ← **wrong default** |

If you start a local worker without setting `TASK_QUEUE=tanzen-worker`, it polls a queue no one sends to and processes nothing. Always pass `TASK_QUEUE=tanzen-worker` when running locally.

---

## 6. Activity exception scope bug (fixed Apr 2026)

**Symptom:** `step_failed` event never published; step record never written; run-level error always `"Activity task failed"` (Temporal's generic wrapper).

**Root cause:** The `try/except` in `run_agent_activity` only wrapped `agent.run()`. The S3 config load (`load_agent_config_from_s3`) happened before the `try`, so a `NoSuchKey` exception escaped unhandled. Temporal caught it at the SDK boundary, serialised it as an `ActivityError`, and the workflow's `except` block received only the wrapper message.

**Fix:** Moved the entire activity body (S3 client creation, config load, artifact write, agent build, agent run) inside a single `try/except`. The `except` block now publishes `step_failed`, writes the step record with `status="failed"` and the real error string, then re-raises.

---

## 7. Extracting the real error from a Temporal ActivityError

In the workflow's `except` block, `exc` is `ActivityError("Activity task failed")`. The real error is one level down:

```python
cause = exc.__cause__ or exc          # ApplicationError("NoSuchKey: ...")
error_msg = str(cause.__cause__ or cause)
```

`workflow.logger` and `print(..., file=sys.stderr)` both produce no output inside a Temporal workflow (the sandbox intercepts them). Do not rely on these for debugging; use the Temporal web UI or `temporal workflow show` instead.

---

## 8. Server-side error enrichment

The run-level error stored by `update_run_status_activity` is the Temporal wrapper message when the activity exception escapes before the step record is written. As a fallback, `GET /api/runs/:runId` now checks `run_events` for a `step_failed` event and uses its `data.error` field when the run-level error is the generic string `"Activity task failed"`.

---

## 9. Workflow banner links to /workflows

The Run detail banner now fetches the workflow name via `useWorkflow(detail.workflow_id)` and renders it as a React Router `Link` to `/workflows`. Falls back to the truncated UUID while the query is in-flight. Implemented in `app/src/pages/RunsPage.tsx` (`RunDetail` component).

---

## 10. ArtifactPanel truncates at 20 000 chars

`JSON.stringify(content, null, 2)` output is capped at `ARTIFACT_TRUNCATE_CHARS = 20_000`. Larger payloads show a "Show all (N chars)" button that expands the full content inline. Prevents the browser from allocating and rendering enormous strings into the DOM. The container's existing `max-h-64 overflow-auto` handles scrolling in both collapsed and expanded states.
