/**
 * OpenAPI 3.1 spec for the Tanzen API.
 * Served at GET /openapi.json; Scalar UI at GET /docs.
 */
export const openapiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Tanzen API",
    version: "0.1.0",
    description:
      "Agent Workflow Orchestration Platform — REST API for managing workflows, agents, runs, gates, secrets, scripts, and MCP servers.",
    license: { name: "Apache-2.0" },
  },
  servers: [
    { url: "/api", description: "Current server" },
  ],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Clerk JWT token",
      },
    },
    schemas: {
      Error: {
        type: "object",
        properties: { error: { type: "string" } },
        required: ["error"],
      },
      PaginatedMeta: {
        type: "object",
        properties: {
          limit: { type: "integer" },
          offset: { type: "integer" },
        },
        required: ["limit", "offset"],
      },
      Workflow: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          version: { type: "integer" },
          created_by: { type: "string" },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
        required: ["id", "name", "version"],
      },
      Agent: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          version: { type: "integer" },
          model: { type: "string" },
          system_prompt: { type: "string" },
          created_by: { type: "string" },
          created_at: { type: "string", format: "date-time" },
        },
        required: ["id", "name", "version"],
      },
      Run: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          workflow_id: { type: "string", format: "uuid" },
          workflow_version: { type: "integer" },
          status: {
            type: "string",
            enum: ["running", "succeeded", "failed", "awaiting_gate"],
          },
          triggered_by: { type: "string" },
          started_at: { type: "string", format: "date-time" },
          completed_at: { type: ["string", "null"], format: "date-time" },
          error: { type: ["string", "null"] },
          temporal_workflow_id: { type: ["string", "null"] },
        },
        required: ["id", "workflow_id", "status"],
      },
      Gate: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          run_id: { type: "string", format: "uuid" },
          step_id: { type: "string" },
          status: { type: "string", enum: ["pending", "approved", "rejected"] },
          message: { type: ["string", "null"] },
          created_at: { type: "string", format: "date-time" },
          resolved_at: { type: ["string", "null"], format: "date-time" },
          resolved_by: { type: ["string", "null"] },
        },
        required: ["id", "run_id", "step_id", "status"],
      },
      Secret: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: ["string", "null"] },
          created_at: { type: "string", format: "date-time" },
        },
        required: ["name"],
      },
      Script: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          language: { type: "string", enum: ["python", "typescript"] },
          version: { type: "integer" },
          allowed_hosts: { type: "array", items: { type: "string" } },
          max_timeout_seconds: { type: "integer" },
          created_at: { type: "string", format: "date-time" },
        },
        required: ["id", "name", "language"],
      },
      McpServer: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: ["string", "null"] },
          transport: { type: "string" },
          url: { type: "string" },
          status: { type: "string" },
        },
        required: ["name", "url"],
      },
      Settings: {
        type: "object",
        properties: {
          scripts_enabled: { type: "boolean" },
          agent_code_execution_enabled: { type: "boolean" },
        },
      },
      RunEvent: {
        type: "object",
        properties: {
          type: { type: "string" },
          run_id: { type: "string", format: "uuid" },
          step_id: { type: ["string", "null"] },
          payload: { type: "object" },
          ts: { type: "string", format: "date-time" },
        },
        required: ["type", "run_id"],
      },
    },
  },
  paths: {
    "/workflows": {
      get: {
        summary: "List workflows",
        operationId: "listWorkflows",
        tags: ["Workflows"],
        parameters: [
          { name: "limit",  in: "query", schema: { type: "integer", default: 50 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          "200": {
            description: "Paginated list of workflows",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedMeta" },
                    {
                      type: "object",
                      properties: {
                        items: { type: "array", items: { $ref: "#/components/schemas/Workflow" } },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
      post: {
        summary: "Create workflow",
        operationId: "createWorkflow",
        tags: ["Workflows"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  dsl: { type: "string", description: "Tanzen DSL source" },
                },
                required: ["name", "dsl"],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Workflow created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string", format: "uuid" },
                    name: { type: "string" },
                    version: { type: "integer" },
                  },
                },
              },
            },
          },
          "422": { description: "Compile errors", content: { "application/json": { schema: { type: "object", properties: { errors: { type: "array" } } } } } },
        },
      },
    },
    "/workflows/{id}": {
      get: {
        summary: "Get workflow",
        operationId: "getWorkflow",
        tags: ["Workflows"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Workflow detail", content: { "application/json": { schema: { $ref: "#/components/schemas/Workflow" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        summary: "Delete workflow",
        operationId: "deleteWorkflow",
        tags: ["Workflows"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Deleted", content: { "application/json": { schema: { type: "object", properties: { deleted: { type: "boolean" } } } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/workflows/{id}/dsl": {
      get: {
        summary: "Get workflow DSL source",
        operationId: "getWorkflowDsl",
        tags: ["Workflows"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "DSL text", content: { "application/json": { schema: { type: "object", properties: { dsl: { type: "string" } } } } } },
        },
      },
    },
    "/workflows/{id}/compile": {
      post: {
        summary: "Validate and compile DSL",
        operationId: "compileWorkflow",
        tags: ["Workflows"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { dsl: { type: "string" } }, required: ["dsl"] } } },
        },
        responses: {
          "200": { description: "Compiled IR", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, ir: { type: "object" } } } } } },
          "422": { description: "Compile errors" },
        },
      },
    },
    "/workflows/{id}/runs": {
      post: {
        summary: "Trigger a workflow run",
        operationId: "triggerRun",
        tags: ["Workflows", "Runs"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: { "application/json": { schema: { type: "object", properties: { params: { type: "object" } } } } },
        },
        responses: {
          "202": {
            description: "Run started",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    runId: { type: "string", format: "uuid" },
                    temporalWorkflowId: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
      get: {
        summary: "List runs for a workflow",
        operationId: "listWorkflowRuns",
        tags: ["Workflows", "Runs"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "limit",  in: "query", schema: { type: "integer", default: 50 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          "200": { description: "List of runs", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/Run" } } } } } } },
        },
      },
    },
    "/workflows/{id}/promote": {
      post: {
        summary: "Promote workflow to a new version",
        operationId: "promoteWorkflow",
        tags: ["Workflows"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Promoted" },
        },
      },
    },
    "/agents": {
      get: {
        summary: "List agents",
        operationId: "listAgents",
        tags: ["Agents"],
        parameters: [
          { name: "limit",  in: "query", schema: { type: "integer", default: 50 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          "200": { description: "List of agents", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/Agent" } } } } } } },
        },
      },
      post: {
        summary: "Create agent",
        operationId: "createAgent",
        tags: ["Agents"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  model: { type: "string" },
                  system_prompt: { type: "string" },
                  mcp_servers: { type: "array", items: { type: "string" } },
                  tools: { type: "array", items: { type: "string" } },
                },
                required: ["name"],
              },
            },
          },
        },
        responses: {
          "201": { description: "Agent created", content: { "application/json": { schema: { $ref: "#/components/schemas/Agent" } } } },
        },
      },
    },
    "/agents/{id}": {
      get: {
        summary: "Get agent",
        operationId: "getAgent",
        tags: ["Agents"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Agent detail", content: { "application/json": { schema: { $ref: "#/components/schemas/Agent" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      put: {
        summary: "Update agent",
        operationId: "updateAgent",
        tags: ["Agents"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Agent" } } } },
        responses: {
          "200": { description: "Updated agent", content: { "application/json": { schema: { $ref: "#/components/schemas/Agent" } } } },
        },
      },
      delete: {
        summary: "Delete agent",
        operationId: "deleteAgent",
        tags: ["Agents"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Deleted" },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/agents/{id}/promote": {
      post: {
        summary: "Promote agent to a new version",
        operationId: "promoteAgent",
        tags: ["Agents"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Promoted" } },
      },
    },
    "/runs": {
      get: {
        summary: "List all runs",
        operationId: "listRuns",
        tags: ["Runs"],
        parameters: [
          { name: "limit",  in: "query", schema: { type: "integer", default: 50 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          { name: "status", in: "query", schema: { type: "string", enum: ["pending", "running", "completed", "failed", "cancelled"] } },
        ],
        responses: {
          "200": { description: "List of runs", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/Run" } } } } } } },
        },
      },
    },
    "/runs/{runId}": {
      get: {
        summary: "Get run detail (with step results)",
        operationId: "getRun",
        tags: ["Runs"],
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Run with step results", content: { "application/json": { schema: { $ref: "#/components/schemas/Run" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        summary: "Cancel and delete a run",
        operationId: "deleteRun",
        tags: ["Runs"],
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Deleted" } },
      },
    },
    "/runs/{runId}/events": {
      get: {
        summary: "Stream run events (SSE)",
        operationId: "streamRunEvents",
        tags: ["Runs"],
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": {
            description: "Server-sent events stream",
            content: { "text/event-stream": { schema: { $ref: "#/components/schemas/RunEvent" } } },
          },
        },
      },
    },
    "/runs/{runId}/artifacts/{key}": {
      get: {
        summary: "Get presigned redirect to run artifact",
        operationId: "getRunArtifact",
        tags: ["Runs"],
        parameters: [
          { name: "runId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "key",   in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "302": { description: "Redirect to presigned S3 URL" } },
      },
    },
    "/runs/{runId}/snapshots": {
      get: {
        summary: "List execution checkpoints for a run",
        operationId: "listRunSnapshots",
        tags: ["Runs"],
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Snapshot list" } },
      },
    },
    "/runs/{runId}/steps/{stepId}/replay": {
      post: {
        summary: "Replay a run step from its checkpoint",
        operationId: "replayStep",
        tags: ["Runs"],
        parameters: [
          { name: "runId",  in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "stepId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "202": { description: "Replay started" } },
      },
    },
    "/gates": {
      get: {
        summary: "List pending gates",
        operationId: "listGates",
        tags: ["Gates"],
        parameters: [
          { name: "limit",  in: "query", schema: { type: "integer", default: 50 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          "200": { description: "List of gates", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/Gate" } } } } } } },
        },
      },
    },
    "/gates/stream": {
      get: {
        summary: "Stream gate events (SSE)",
        operationId: "streamGates",
        tags: ["Gates"],
        responses: {
          "200": { description: "Server-sent events stream", content: { "text/event-stream": { schema: { $ref: "#/components/schemas/RunEvent" } } } },
        },
      },
    },
    "/gates/{gateId}/approve": {
      post: {
        summary: "Approve a gate",
        operationId: "approveGate",
        tags: ["Gates"],
        parameters: [{ name: "gateId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: { "application/json": { schema: { type: "object", properties: { message: { type: "string" } } } } },
        },
        responses: { "200": { description: "Gate approved" } },
      },
    },
    "/gates/{gateId}/reject": {
      post: {
        summary: "Reject a gate",
        operationId: "rejectGate",
        tags: ["Gates"],
        parameters: [{ name: "gateId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: { "application/json": { schema: { type: "object", properties: { message: { type: "string" } } } } },
        },
        responses: { "200": { description: "Gate rejected" } },
      },
    },
    "/secrets": {
      get: {
        summary: "List secret names",
        operationId: "listSecrets",
        tags: ["Secrets"],
        responses: {
          "200": { description: "Secret names", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/Secret" } } } } } } },
        },
      },
      post: {
        summary: "Create or update a secret",
        operationId: "createSecret",
        tags: ["Secrets"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  value: { type: "string" },
                  description: { type: "string" },
                },
                required: ["name", "value"],
              },
            },
          },
        },
        responses: { "201": { description: "Secret stored" } },
      },
    },
    "/secrets/{name}": {
      delete: {
        summary: "Delete a secret",
        operationId: "deleteSecret",
        tags: ["Secrets"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Deleted" } },
      },
    },
    "/scripts": {
      get: {
        summary: "List scripts",
        operationId: "listScripts",
        tags: ["Scripts"],
        responses: { "200": { description: "List of scripts", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/Script" } } } } } } } },
      },
      post: {
        summary: "Create script",
        operationId: "createScript",
        tags: ["Scripts"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  language: { type: "string", enum: ["python", "typescript"] },
                  code: { type: "string" },
                  allowed_hosts: { type: "array", items: { type: "string" } },
                  max_timeout_seconds: { type: "integer" },
                },
                required: ["name", "language", "code"],
              },
            },
          },
        },
        responses: { "201": { description: "Script created", content: { "application/json": { schema: { $ref: "#/components/schemas/Script" } } } } },
      },
    },
    "/scripts/{id}": {
      get: {
        summary: "Get script",
        operationId: "getScript",
        tags: ["Scripts"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Script detail", content: { "application/json": { schema: { $ref: "#/components/schemas/Script" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      put: {
        summary: "Update script",
        operationId: "updateScript",
        tags: ["Scripts"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Script" } } } },
        responses: { "200": { description: "Updated" } },
      },
      delete: {
        summary: "Delete script",
        operationId: "deleteScript",
        tags: ["Scripts"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Deleted" } },
      },
    },
    "/scripts/{id}/code": {
      get: {
        summary: "Get script source code",
        operationId: "getScriptCode",
        tags: ["Scripts"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Script code", content: { "application/json": { schema: { type: "object", properties: { code: { type: "string" } } } } } } },
      },
    },
    "/scripts/{id}/promote": {
      post: {
        summary: "Promote script to a new version",
        operationId: "promoteScript",
        tags: ["Scripts"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Promoted" } },
      },
    },
    "/mcp-servers": {
      get: {
        summary: "List registered MCP servers",
        operationId: "listMcpServers",
        tags: ["MCP"],
        responses: {
          "200": { description: "MCP server list", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/McpServer" } } } } } } },
        },
      },
    },
    "/settings": {
      get: {
        summary: "Get all settings",
        operationId: "getSettings",
        tags: ["Settings"],
        responses: { "200": { description: "Settings object", content: { "application/json": { schema: { $ref: "#/components/schemas/Settings" } } } } },
      },
      patch: {
        summary: "Update settings (admin only)",
        operationId: "updateSettings",
        tags: ["Settings"],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Settings" } } },
        },
        responses: { "200": { description: "Updated settings", content: { "application/json": { schema: { $ref: "#/components/schemas/Settings" } } } } },
      },
    },
    "/bundles": {
      post: {
        summary: "Create a bundle (packaged workflow + agents)",
        operationId: "createBundle",
        tags: ["Bundles"],
        responses: { "201": { description: "Bundle created" } },
      },
    },
    "/bundles/{id}": {
      get: {
        summary: "Get bundle",
        operationId: "getBundle",
        tags: ["Bundles"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Bundle detail" } },
      },
    },
    "/metrics": {
      get: {
        summary: "Get workflow/run metrics",
        operationId: "getMetrics",
        tags: ["Metrics"],
        responses: { "200": { description: "Metrics summary" } },
      },
    },
  },
  tags: [
    { name: "Workflows", description: "Workflow definitions and DSL management" },
    { name: "Agents",    description: "Agent definitions with model + system prompt" },
    { name: "Runs",      description: "Workflow execution lifecycle and artifacts" },
    { name: "Gates",     description: "Human-in-the-loop approval gates" },
    { name: "Secrets",   description: "Encrypted secret storage (values never returned)" },
    { name: "Scripts",   description: "Sandboxed reusable code scripts" },
    { name: "MCP",       description: "Model Context Protocol server registry" },
    { name: "Settings",  description: "Operator feature flags" },
    { name: "Bundles",   description: "Packaged workflow + agent sets" },
    { name: "Metrics",   description: "Runtime metrics" },
  ],
};
