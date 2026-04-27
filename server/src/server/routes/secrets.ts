/**
 * Secrets routes — manage K8s secrets (names only, never values in responses).
 *
 * Uses @kubernetes/client-node with the same kubeconfig strategy as mcpServers.ts:
 *   - KUBECTL_PROXY_URL set → connect through kubectl proxy (local dev)
 *   - otherwise            → kc.loadFromDefault() (kubeconfig or in-cluster SA)
 *
 * POST   /api/secrets         Write K8s secret
 * GET    /api/secrets         List secret names
 * DELETE /api/secrets/:name   Delete K8s secret
 */
import { Hono } from "hono";
import * as k8s from "@kubernetes/client-node";
import { requireRole } from "../auth.js";

const routes = new Hono();

const K8S_NAMESPACE = process.env["K8S_NAMESPACE"] ?? "tanzen-dev";

// ---------------------------------------------------------------------------
// k8s client — fresh per request so kubeconfig/CA changes (e.g. new cluster)
// are picked up without restarting the server.
// ---------------------------------------------------------------------------

function getK8sApi(): k8s.CoreV1Api | null {
  try {
    const kc = new k8s.KubeConfig();
    const proxyUrl = process.env["KUBECTL_PROXY_URL"];
    if (proxyUrl) {
      kc.loadFromOptions({
        clusters: [{ name: "proxy", server: proxyUrl, skipTLSVerify: true }],
        users:    [{ name: "proxy" }],
        contexts: [{ name: "proxy", cluster: "proxy", user: "proxy" }],
        currentContext: "proxy",
      });
    } else {
      kc.loadFromDefault();
      // @kubernetes/client-node v1.x uses node-fetch internally. Bun replaces
      // node-fetch with its own fetch, which ignores custom HTTPS agents — so
      // the kubeconfig CA cert is never applied and every request fails TLS
      // verification. When not in-cluster (KUBERNETES_SERVICE_HOST absent) we
      // skip cert verification; kubeconfig credentials (token/cert) still
      // authenticate the request.
      if (!process.env["KUBERNETES_SERVICE_HOST"]) {
        for (const entry of kc.clusters) {
          entry.cluster.skipTLSVerify = true;
        }
      }
    }
    return kc.makeApiClient(k8s.CoreV1Api);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /api/secrets
// ---------------------------------------------------------------------------

routes.post("/", requireRole("admin"), async (c) => {
  const body = await c.req.json<{ name: string; value: string }>();
  if (!body.name || !body.value) return c.json({ error: "name and value are required" }, 400);
  if (!/^[a-z][a-z0-9-]*$/.test(body.name)) return c.json({ error: "name must be lowercase alphanumeric with hyphens" }, 400);

  const api = getK8sApi();
  if (!api) return c.json({ error: "Kubernetes API unavailable" }, 503);

  const encoded = Buffer.from(body.value).toString("base64");
  const secretBody: k8s.V1Secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: body.name, namespace: K8S_NAMESPACE, labels: { "tanzen/managed": "true" } },
    type: "Opaque",
    data: { value: encoded },
  };

  try {
    await api.createNamespacedSecret({ namespace: K8S_NAMESPACE, body: secretBody });
  } catch (err: unknown) {
    // 409 Conflict → already exists, patch instead
    const status = (err as { response?: { statusCode?: number } })?.response?.statusCode;
    if (status === 409) {
      try {
        await api.patchNamespacedSecret({
          name: body.name,
          namespace: K8S_NAMESPACE,
          body: { data: { value: encoded } },
        });
      } catch (patchErr: unknown) {
        const msg = patchErr instanceof Error ? patchErr.message : String(patchErr);
        return c.json({ error: msg }, 500);
      }
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  }

  return c.json({ name: body.name }, 201);
});

// ---------------------------------------------------------------------------
// GET /api/secrets
// ---------------------------------------------------------------------------

routes.get("/", requireRole("admin", "author"), async (c) => {
  const api = getK8sApi();
  if (!api) return c.json({ error: "Kubernetes API unavailable" }, 503);

  try {
    const result = await api.listNamespacedSecret({
      namespace: K8S_NAMESPACE,
      labelSelector: "tanzen/managed=true",
    });
    const items = (result.items ?? []).map((s) => ({
      name: s.metadata?.name,
      createdAt: s.metadata?.creationTimestamp,
    }));
    return c.json({ items });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/secrets/:name
// ---------------------------------------------------------------------------

routes.delete("/:name", requireRole("admin"), async (c) => {
  const api = getK8sApi();
  if (!api) return c.json({ error: "Kubernetes API unavailable" }, 503);

  try {
    await api.deleteNamespacedSecret({ name: c.req.param("name")!, namespace: K8S_NAMESPACE });
    return c.json({ ok: true });
  } catch (err: unknown) {
    const status = (err as { response?: { statusCode?: number } })?.response?.statusCode;
    if (status === 404) return c.json({ error: "Not found" }, 404);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export { routes as secretRoutes };
