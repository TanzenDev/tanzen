/**
 * MCP server discovery route.
 *
 * GET /api/mcp-servers
 *
 * Queries the Kubernetes API for Services labeled `tanzen/mcp=true` in the
 * configured namespace and returns a list of MCP server descriptors including
 * their in-cluster URLs.
 *
 * Falls back to an empty list if the k8s API is unreachable (e.g., local dev
 * without a cluster).
 */
import { Hono } from "hono";
import * as k8s from "@kubernetes/client-node";
import type { AuthUser } from "../auth.js";

type Vars = { Variables: { user: AuthUser } };
const routes = new Hono<Vars>();

const NAMESPACE = process.env["K8S_NAMESPACE"] ?? "tanzen-dev";

function getK8sApi(): k8s.CoreV1Api | null {
  try {
    const kc = new k8s.KubeConfig();
    const proxyUrl = process.env["KUBECTL_PROXY_URL"];
    if (proxyUrl) {
      // Local dev: kubectl proxy runs on an HTTP port, no TLS needed.
      kc.loadFromOptions({
        clusters: [{ name: "proxy", server: proxyUrl, skipTLSVerify: true }],
        users: [{ name: "proxy" }],
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

export interface MCPServerItem {
  name: string;
  url: string;
  description: string;
  transport: string;
}

// GET /api/mcp-servers
routes.get("/", async (c) => {
  const api = getK8sApi();
  if (!api) {
    return c.json({ items: [] });
  }

  try {
    const response = await api.listNamespacedService({
      namespace: NAMESPACE,
      labelSelector: "tanzen/mcp=true",
    });

    const items: MCPServerItem[] = (response.items ?? []).map((svc) => {
      const annotations = svc.metadata?.annotations ?? {};
      const name = annotations["tanzen/mcp-name"] ?? svc.metadata?.name ?? "";
      const description = annotations["tanzen/mcp-description"] ?? "";
      const transport = annotations["tanzen/mcp-transport"] ?? "http";
      const svcName = svc.metadata?.name ?? "";
      const port = svc.spec?.ports?.[0]?.port ?? 8080;
      const url = `http://${svcName}.${NAMESPACE}.svc.cluster.local:${port}/mcp`;
      return { name, url, description, transport };
    });

    return c.json({ items });
  } catch (err) {
    // k8s API unreachable — return empty list rather than 500
    console.warn("MCP discovery: k8s API unavailable:", err instanceof Error ? err.message : err);
    return c.json({ items: [] });
  }
});

export { routes as mcpServerRoutes };
