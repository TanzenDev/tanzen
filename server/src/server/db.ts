/**
 * Postgres connection and schema setup.
 *
 * Connects to the Postgres instance via DATABASE_URL env var.
 * `migrate()` is idempotent and runs CREATE TABLE IF NOT EXISTS for all tables.
 */
import postgres from "postgres";

const DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://tanzen:tanzen@localhost:5432/tanzen";

export const sql = postgres(DATABASE_URL, { max: 10 });

export async function migrate(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS workflows (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      current_version TEXT NOT NULL DEFAULT '1.0.0',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by  TEXT NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS workflow_versions (
      id          TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      version     TEXT NOT NULL,
      dsl_key     TEXT NOT NULL,
      ir_key      TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by  TEXT NOT NULL,
      promoted    BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE(workflow_id, version)
    )
  `;

  // Idempotent: add promoted column if table already exists without it
  await sql`
    ALTER TABLE workflow_versions ADD COLUMN IF NOT EXISTS promoted BOOLEAN NOT NULL DEFAULT FALSE
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS agents (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      current_version TEXT NOT NULL DEFAULT '1.0',
      model           TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS agent_versions (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      version    TEXT NOT NULL,
      config_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      promoted   BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE(agent_id, version)
    )
  `;

  // Idempotent: add promoted column if table already exists without it
  await sql`
    ALTER TABLE agent_versions ADD COLUMN IF NOT EXISTS promoted BOOLEAN NOT NULL DEFAULT FALSE
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS runs (
      id                  TEXT PRIMARY KEY,
      workflow_id         TEXT NOT NULL REFERENCES workflows(id),
      workflow_version    TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'running',
      triggered_by        TEXT NOT NULL,
      started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at        TIMESTAMPTZ,
      temporal_workflow_id TEXT NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS run_steps (
      id                  TEXT PRIMARY KEY,
      run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      step_id             TEXT NOT NULL,
      agent_id            TEXT,
      agent_version       TEXT,
      status              TEXT NOT NULL DEFAULT 'running',
      started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at        TIMESTAMPTZ,
      input_artifact_key  TEXT,
      output_artifact_key TEXT,
      token_count         INTEGER NOT NULL DEFAULT 0,
      cost_usd            NUMERIC(10,6) NOT NULL DEFAULT 0
    )
  `;

  // Idempotent: add error column to runs
  await sql`
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS error TEXT
  `;

  // Idempotent: add task-related and error columns to run_steps
  await sql`
    ALTER TABLE run_steps ADD COLUMN IF NOT EXISTS step_type TEXT NOT NULL DEFAULT 'agent'
  `;
  await sql`
    ALTER TABLE run_steps ADD COLUMN IF NOT EXISTS action TEXT
  `;
  await sql`
    ALTER TABLE run_steps ADD COLUMN IF NOT EXISTS duration_ms NUMERIC(12,4)
  `;
  await sql`
    ALTER TABLE run_steps ADD COLUMN IF NOT EXISTS error TEXT
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS run_events (
      id          TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      step_id     TEXT,
      data        JSONB NOT NULL DEFAULT '{}',
      ts          DOUBLE PRECISION NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS run_events_run_id_idx ON run_events (run_id, ts)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS gates (
      id          TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      step_id     TEXT NOT NULL,
      assignee    TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      opened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      resolved_by TEXT,
      notes       TEXT
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS custom_scripts (
      id                   TEXT PRIMARY KEY,
      name                 TEXT NOT NULL UNIQUE,
      description          TEXT NOT NULL DEFAULT '',
      current_version      TEXT NOT NULL DEFAULT '1.0',
      created_by           TEXT NOT NULL,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      allowed_hosts        TEXT NOT NULL DEFAULT '',
      allowed_env          TEXT NOT NULL DEFAULT '',
      max_timeout_seconds  INTEGER NOT NULL DEFAULT 30,
      language             TEXT NOT NULL DEFAULT 'typescript'
    )
  `;

  await sql`
    ALTER TABLE custom_scripts ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'typescript'
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS custom_script_versions (
      id          TEXT PRIMARY KEY,
      script_id   TEXT NOT NULL REFERENCES custom_scripts(id) ON DELETE CASCADE,
      version     TEXT NOT NULL,
      code_key    TEXT NOT NULL,
      created_by  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      promoted    BOOLEAN NOT NULL DEFAULT FALSE,
      language    TEXT NOT NULL DEFAULT 'typescript',
      UNIQUE(script_id, version)
    )
  `;

  await sql`
    ALTER TABLE custom_script_versions ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'typescript'
  `;

  // Settings — feature flags and operator-controlled configuration.
  await sql`
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    INSERT INTO settings (key, value) VALUES
      ('scripts_enabled',              'true'),
      ('agent_code_execution_enabled', 'false')
    ON CONFLICT (key) DO NOTHING
  `;

  // Step snapshots — execution checkpoints for time-machine replay.
  await sql`
    CREATE TABLE IF NOT EXISTS step_snapshots (
      id              TEXT PRIMARY KEY,
      run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      step_id         TEXT NOT NULL,
      checkpoint_key  TEXT NOT NULL,
      has_state       BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(run_id, step_id)
    )
  `;
}
