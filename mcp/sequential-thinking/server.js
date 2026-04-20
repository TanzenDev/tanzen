/**
 * Sequential Thinking MCP server — Streamable HTTP transport.
 *
 * Tool: sequentialthinking
 * Helps models reason step-by-step by recording and returning a chain of
 * thought objects.  Each invocation appends to a session-local history.
 */
import express from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = parseInt(process.env.PORT ?? "8080", 10);

const app = express();
app.use(express.json());

// Active session transports (for GET/DELETE session management).
const sessions = new Map();

function buildServer() {
  const server = new McpServer({
    name: "sequential-thinking",
    version: "1.0.0",
  });

  // Per-server thought history (one server per session).
  const history = [];

  server.tool(
    "sequentialthinking",
    "Record a sequential thought step.  Call repeatedly to build a reasoning chain.",
    {
      thought: z.string().describe("The content of this thinking step"),
      thoughtNumber: z.number().int().min(1).describe("1-based index of this thought"),
      totalThoughts: z.number().int().min(1).describe("Estimated total thoughts needed"),
      nextThoughtNeeded: z.boolean().describe("True if more thought steps are required"),
      isRevision: z.boolean().optional().describe("True if this revises an earlier thought"),
      revisesThought: z.number().int().optional().describe("Index of the thought being revised"),
    },
    async ({ thought, thoughtNumber, totalThoughts, nextThoughtNeeded, isRevision, revisesThought }) => {
      const entry = { thoughtNumber, thought, totalThoughts, isRevision, revisesThought };
      history.push(entry);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            recorded: entry,
            historyLength: history.length,
            nextThoughtNeeded,
            status: nextThoughtNeeded ? "continue" : "complete",
          }, null, 2),
        }],
      };
    },
  );

  return server;
}

// POST /mcp  — stateless or session-resuming
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

// GET /mcp  — SSE stream for session
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) {
    // Stateless GET: spin up a fresh server
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    const server = buildServer();
    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }
  await sessions.get(sessionId).handleRequest(req, res);
});

// DELETE /mcp  — close session
app.delete("/mcp", (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId) sessions.delete(sessionId);
  res.status(200).json({ closed: true });
});

// Health check
app.get("/health", (_req, res) => res.json({ ok: true, server: "sequential-thinking" }));

app.listen(PORT, () =>
  console.log(`Sequential Thinking MCP server listening on :${PORT}`),
);
