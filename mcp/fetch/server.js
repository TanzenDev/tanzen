/**
 * Fetch MCP server — Streamable HTTP transport.
 *
 * Tools:
 *   fetch        — retrieve raw content from a URL
 *   fetch_html   — retrieve and return the text body of an HTML page (strips tags)
 */
import express from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const MAX_BYTES = parseInt(process.env.MAX_RESPONSE_BYTES ?? String(512 * 1024), 10);
const TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS ?? "10000", 10);

const app = express();
app.use(express.json());

const sessions = new Map();

// Minimal HTML tag stripper — avoids a heavy dependency.
function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function doFetch(url, raw) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "TanzenMCP/1.0" },
    });
    if (!resp.ok) {
      return { error: `HTTP ${resp.status} ${resp.statusText}` };
    }
    const contentType = resp.headers.get("content-type") ?? "";
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const truncated = bytes.length > MAX_BYTES;
    const text = new TextDecoder().decode(truncated ? bytes.slice(0, MAX_BYTES) : bytes);
    const body = (!raw && contentType.includes("html")) ? stripTags(text) : text;
    return { url, contentType, body, truncated, byteLength: bytes.length };
  } finally {
    clearTimeout(timer);
  }
}

function buildServer() {
  const server = new McpServer({ name: "fetch", version: "1.0.0" });

  server.tool(
    "fetch",
    "Fetch the raw content of a URL (returned as-is, up to 512 KB).",
    { url: z.string().url().describe("The URL to fetch") },
    async ({ url }) => {
      const result = await doFetch(url, true);
      return {
        content: [{
          type: "text",
          text: result.error
            ? `Error fetching ${url}: ${result.error}`
            : `URL: ${result.url}\nContent-Type: ${result.contentType}\nSize: ${result.byteLength} bytes${result.truncated ? " (truncated)" : ""}\n\n${result.body}`,
        }],
      };
    },
  );

  server.tool(
    "fetch_html",
    "Fetch a web page and return its visible text content (HTML tags stripped).",
    { url: z.string().url().describe("The URL of the web page") },
    async ({ url }) => {
      const result = await doFetch(url, false);
      return {
        content: [{
          type: "text",
          text: result.error
            ? `Error fetching ${url}: ${result.error}`
            : `URL: ${result.url}\n\n${result.body}`,
        }],
      };
    },
  );

  return server;
}

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport;
  if (sessionId && sessions.has(sessionId)) {
    transport = sessions.get(sessionId);
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => { sessions.set(sid, transport); },
    });
    const server = buildServer();
    await server.connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && sessions.has(sessionId)) {
    await sessions.get(sessionId).handleRequest(req, res);
    return;
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await buildServer().connect(transport);
  await transport.handleRequest(req, res);
});

app.delete("/mcp", (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId) sessions.delete(sessionId);
  res.status(200).json({ closed: true });
});

app.get("/health", (_req, res) => res.json({ ok: true, server: "fetch" }));

app.listen(PORT, () => console.log(`Fetch MCP server listening on :${PORT}`));
