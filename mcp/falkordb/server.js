/**
 * FalkorDB MCP server — Streamable HTTP transport.
 *
 * Connects to a FalkorDB instance (Redis protocol) and exposes Cypher
 * query tools.
 *
 * Tools:
 *   list_graphs     — list all graph databases
 *   query_graph     — execute a read-only Cypher query
 *   write_graph     — execute a write Cypher query
 *   delete_graph    — drop a graph database
 */
import express from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { FalkorDB } from "falkordb";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const FALKORDB_URL = process.env.FALKORDB_URL ?? "redis://localhost:6379";

const app = express();
app.use(express.json());

// Parse redis://host:port
function parseRedisUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: parseInt(u.port || "6379", 10) };
  } catch {
    return { host: "localhost", port: 6379 };
  }
}

const { host, port } = parseRedisUrl(FALKORDB_URL);
console.log(`Connecting to FalkorDB at ${host}:${port}`);

let db;
async function getDB() {
  if (!db) {
    db = await FalkorDB.connect({ socket: { host, port } });
    console.log("FalkorDB connected");
  }
  return db;
}

const sessions = new Map();

function buildServer() {
  const server = new McpServer({ name: "falkordb", version: "1.0.0" });

  server.tool(
    "list_graphs",
    "List all graph databases in the FalkorDB instance.",
    {},
    async () => {
      const client = await getDB();
      const graphs = await client.list();
      return {
        content: [{
          type: "text",
          text: graphs.length === 0
            ? "No graphs found."
            : `Graphs:\n${graphs.map(g => `  - ${g}`).join("\n")}`,
        }],
      };
    },
  );

  server.tool(
    "query_graph",
    "Execute a read-only Cypher query against a FalkorDB graph.",
    {
      graph: z.string().describe("Graph name to query"),
      query: z.string().describe("Cypher query (read-only: MATCH, RETURN, etc.)"),
    },
    async ({ graph, query }) => {
      const client = await getDB();
      const g = client.selectGraph(graph);
      const result = await g.query(query);
      const rows = [];
      for await (const record of result) {
        rows.push(record);
      }
      return {
        content: [{
          type: "text",
          text: rows.length === 0
            ? "Query returned no results."
            : `Results (${rows.length} rows):\n${JSON.stringify(rows, null, 2)}`,
        }],
      };
    },
  );

  server.tool(
    "write_graph",
    "Execute a write Cypher query against a FalkorDB graph (CREATE, MERGE, SET, DELETE).",
    {
      graph: z.string().describe("Graph name"),
      query: z.string().describe("Cypher write query"),
    },
    async ({ graph, query }) => {
      const client = await getDB();
      const g = client.selectGraph(graph);
      const result = await g.query(query);
      const stats = result.statistics ?? {};
      return {
        content: [{
          type: "text",
          text: `Query executed.\nStatistics: ${JSON.stringify(stats, null, 2)}`,
        }],
      };
    },
  );

  server.tool(
    "delete_graph",
    "Drop an entire graph database from FalkorDB.",
    { graph: z.string().describe("Graph name to delete") },
    async ({ graph }) => {
      const client = await getDB();
      await client.selectGraph(graph).delete();
      return {
        content: [{ type: "text", text: `Graph "${graph}" deleted.` }],
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
    await buildServer().connect(transport);
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

app.get("/health", (_req, res) => res.json({ ok: true, server: "falkordb" }));

app.listen(PORT, () => console.log(`FalkorDB MCP server listening on :${PORT}`));
