import pg from "pg";
import { TelemetryEmitter } from "../telemetry/emitter.js";

const { Pool } = pg;

/**
 * Operational PostgreSQL tables for the Knowledge Agent.
 *
 * Consolidates all 6 table DDLs into a single migration entry point:
 *   1. trust_levels — agent trust level lifecycle tracking
 *   2. knowledge_edit_queue — proposed edits for Bar Raiser review
 *   3. knowledge_sync_ledger — Obsidian ↔ Neo4j sync state
 *   4. bar_raiser_direct — quality gate escalation tracking
 *   5. privacy_audit_log — privacy audit results
 *   6. model_quality_metrics — frontier → local delegation tracking
 *
 * All tables use IF NOT EXISTS for idempotent migrations.
 */

// ── SQL DDL ────────────────────────────────────────────────────────────

export const TRUST_LEVELS_SQL = `
CREATE TABLE IF NOT EXISTS trust_levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name VARCHAR NOT NULL,
  integration VARCHAR NOT NULL,
  trust_level VARCHAR NOT NULL DEFAULT 'observe',
  granted_at TIMESTAMP NOT NULL DEFAULT now(),
  granted_by VARCHAR NOT NULL,
  evidence TEXT,
  revoked_at TIMESTAMP,
  revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_trust_levels_agent
  ON trust_levels(agent_name, integration);
CREATE INDEX IF NOT EXISTS idx_trust_levels_active
  ON trust_levels(granted_at DESC) WHERE revoked_at IS NULL;
`;

export const KNOWLEDGE_EDIT_QUEUE_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_edit_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposing_agent VARCHAR NOT NULL,
  edit_type VARCHAR NOT NULL,
  target_node_id VARCHAR NOT NULL,
  target_node_type VARCHAR NOT NULL,
  current_value TEXT,
  proposed_value TEXT,
  reasoning TEXT,
  confidence FLOAT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMP,
  reviewed_by VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'pending',
  resolution_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_edit_queue_status
  ON knowledge_edit_queue(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_edit_queue_agent
  ON knowledge_edit_queue(proposing_agent);
CREATE INDEX IF NOT EXISTS idx_edit_queue_pending
  ON knowledge_edit_queue(created_at DESC) WHERE status = 'pending';
`;

export const KNOWLEDGE_SYNC_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_sync_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  obsidian_path TEXT,
  neo4j_node_id TEXT,
  last_synced_at TIMESTAMP NOT NULL DEFAULT now(),
  sync_direction VARCHAR NOT NULL,
  sync_status VARCHAR NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_sync_ledger_path
  ON knowledge_sync_ledger(obsidian_path);
CREATE INDEX IF NOT EXISTS idx_sync_ledger_node
  ON knowledge_sync_ledger(neo4j_node_id);
`;

export const BAR_RAISER_DIRECT_SQL = `
CREATE TABLE IF NOT EXISTS bar_raiser_direct (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  severity VARCHAR NOT NULL,
  flag_type VARCHAR NOT NULL,
  target_agent VARCHAR NOT NULL,
  evidence TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMP,
  resolved_at TIMESTAMP,
  resolution TEXT
);

CREATE INDEX IF NOT EXISTS idx_bar_raiser_direct_severity
  ON bar_raiser_direct(severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bar_raiser_direct_unresolved
  ON bar_raiser_direct(created_at DESC) WHERE resolved_at IS NULL;
`;

export const PRIVACY_AUDIT_LOG_SQL = `
CREATE TABLE IF NOT EXISTS privacy_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_type VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  finding TEXT NOT NULL,
  affected_data TEXT,
  affected_agent VARCHAR,
  recommended_action TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMP,
  resolved_at TIMESTAMP,
  resolution TEXT
);

CREATE INDEX IF NOT EXISTS idx_privacy_audit_log_type
  ON privacy_audit_log(audit_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_privacy_audit_log_status
  ON privacy_audit_log(status);
`;

export const MODEL_QUALITY_METRICS_SQL = `
CREATE TABLE IF NOT EXISTS model_quality_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type VARCHAR NOT NULL,
  model VARCHAR NOT NULL,
  quality_score FLOAT NOT NULL DEFAULT 0,
  sample_count INT NOT NULL DEFAULT 0,
  delegation_status VARCHAR NOT NULL DEFAULT 'frontier_only',
  last_evaluated TIMESTAMP NOT NULL DEFAULT now(),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(task_type, model)
);

CREATE INDEX IF NOT EXISTS idx_model_quality_task
  ON model_quality_metrics(task_type);
CREATE INDEX IF NOT EXISTS idx_model_quality_status
  ON model_quality_metrics(delegation_status);
`;

/** All 6 operational table DDLs in dependency order. */
export const ALL_TABLE_SQLS = [
  { name: "trust_levels", sql: TRUST_LEVELS_SQL },
  { name: "knowledge_edit_queue", sql: KNOWLEDGE_EDIT_QUEUE_SQL },
  { name: "knowledge_sync_ledger", sql: KNOWLEDGE_SYNC_LEDGER_SQL },
  { name: "bar_raiser_direct", sql: BAR_RAISER_DIRECT_SQL },
  { name: "privacy_audit_log", sql: PRIVACY_AUDIT_LOG_SQL },
  { name: "model_quality_metrics", sql: MODEL_QUALITY_METRICS_SQL },
];

/** Expected table names for verification. */
export const EXPECTED_TABLES = [
  "trust_levels",
  "knowledge_edit_queue",
  "knowledge_sync_ledger",
  "bar_raiser_direct",
  "privacy_audit_log",
  "model_quality_metrics",
] as const;

export type OperationalTableName = (typeof EXPECTED_TABLES)[number];

// ── Expected column schemas for verification ────────────────────────────

export const EXPECTED_COLUMNS: Record<OperationalTableName, string[]> = {
  trust_levels: [
    "id",
    "agent_name",
    "integration",
    "trust_level",
    "granted_at",
    "granted_by",
    "evidence",
    "revoked_at",
    "revoked_reason",
  ],
  knowledge_edit_queue: [
    "id",
    "proposing_agent",
    "edit_type",
    "target_node_id",
    "target_node_type",
    "current_value",
    "proposed_value",
    "reasoning",
    "confidence",
    "created_at",
    "reviewed_at",
    "reviewed_by",
    "status",
    "resolution_notes",
  ],
  knowledge_sync_ledger: [
    "id",
    "obsidian_path",
    "neo4j_node_id",
    "last_synced_at",
    "sync_direction",
    "sync_status",
  ],
  bar_raiser_direct: [
    "id",
    "severity",
    "flag_type",
    "target_agent",
    "evidence",
    "recommended_action",
    "created_at",
    "acknowledged_at",
    "resolved_at",
    "resolution",
  ],
  privacy_audit_log: [
    "id",
    "audit_type",
    "status",
    "finding",
    "affected_data",
    "affected_agent",
    "recommended_action",
    "created_at",
    "acknowledged_at",
    "resolved_at",
    "resolution",
  ],
  model_quality_metrics: [
    "id",
    "task_type",
    "model",
    "quality_score",
    "sample_count",
    "delegation_status",
    "last_evaluated",
    "created_at",
    "updated_at",
  ],
};

// ── Migration ──────────────────────────────────────────────────────────

export interface MigrationResult {
  tables_created: string[];
  errors: { table: string; error: string }[];
  already_existed: string[];
  success: boolean;
  latency_ms: number;
}

/**
 * Run the full operational tables migration.
 * Creates all 6 tables idempotently — safe to run multiple times.
 */
export async function runOperationalMigration(
  pool: pg.Pool,
  emitter?: TelemetryEmitter,
): Promise<MigrationResult> {
  const start = Date.now();
  const result: MigrationResult = {
    tables_created: [],
    errors: [],
    already_existed: [],
    success: false,
    latency_ms: 0,
  };

  for (const { name, sql } of ALL_TABLE_SQLS) {
    try {
      // Check if table already exists before creating
      const check = await pool.query(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = $1
        ) AS exists`,
        [name],
      );
      const existed = check.rows[0]?.exists === true;

      await pool.query(sql);

      if (existed) {
        result.already_existed.push(name);
      } else {
        result.tables_created.push(name);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ table: name, error: message });
      console.error(`[knowledge] operational-tables: failed to create ${name}: ${message}`);
    }
  }

  result.success = result.errors.length === 0;
  result.latency_ms = Date.now() - start;

  if (emitter) {
    try {
      emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_write",
        event_subtype: "operational_migration",
        session_id: `op-migration-${Date.now()}`,
        outcome: result.success ? "success" : "partial",
        latency_ms: result.latency_ms,
        metadata: {
          tables_created: result.tables_created,
          already_existed: result.already_existed,
          errors: result.errors,
        },
      });
    } catch {
      // Non-blocking telemetry
    }
  }

  return result;
}

/**
 * Verify all 6 operational tables exist with correct column schemas.
 */
export async function verifyOperationalTables(
  pool: pg.Pool,
): Promise<{
  valid: boolean;
  tables: Record<string, { exists: boolean; columns: string[] }>;
}> {
  const tables: Record<string, { exists: boolean; columns: string[] }> = {};

  for (const name of EXPECTED_TABLES) {
    try {
      const res = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [name],
      );
      const columns = res.rows.map((r: { column_name: string }) => r.column_name);
      tables[name] = { exists: columns.length > 0, columns };
    } catch {
      tables[name] = { exists: false, columns: [] };
    }
  }

  const valid = EXPECTED_TABLES.every((name) => {
    const t = tables[name];
    if (!t?.exists) return false;
    const expected = EXPECTED_COLUMNS[name];
    return expected.every((col) => t.columns.includes(col));
  });

  return { valid, tables };
}
