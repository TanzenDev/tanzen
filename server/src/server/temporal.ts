/**
 * Temporal client — connects to the in-cluster Temporal server.
 */
import { Client, Connection } from "@temporalio/client";

const TEMPORAL_ADDRESS = process.env["TEMPORAL_ADDRESS"] ?? "temporal-frontend:7233";
const TEMPORAL_NAMESPACE = process.env["TEMPORAL_NAMESPACE"] ?? "default";
const TASK_QUEUE = process.env["TEMPORAL_TASK_QUEUE"] ?? "tanzen-worker";

let _client: Client | null = null;

export async function getTemporalClient(): Promise<Client> {
  if (_client) return _client;
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  _client = new Client({ connection, namespace: TEMPORAL_NAMESPACE });
  return _client;
}

export async function startWorkflowRun(
  runId: string,
  ir: Record<string, unknown>,
  params: Record<string, unknown>,
): Promise<string> {
  const client = await getTemporalClient();
  const handle = await client.workflow.start("DynamicWorkflow", {
    taskQueue: TASK_QUEUE,
    workflowId: runId,
    args: [ir, params],
  });
  return handle.workflowId;
}
