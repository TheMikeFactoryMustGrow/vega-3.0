import pg from "pg";

const { Pool } = pg;

/**
 * VEGA v3.3 PostgreSQL Database Client
 *
 * Manages connection pool and provides migration support for Tier 2 tables.
 * Connection string read from VEGA_PG_URL env var, defaults to localhost/vega_db.
 */

export function createPool(connectionString?: string): pg.Pool {
  const connStr =
    connectionString ??
    process.env.VEGA_PG_URL ??
    "postgres://localhost/vega_db";

  return new Pool({ connectionString: connStr, max: 5 });
}

/**
 * SQL DDL for all four Tier 2 aggregation tables.
 * Uses IF NOT EXISTS for idempotent migrations.
 */
const TIER2_MIGRATION_SQL = `
-- ─── telemetry_agent_hourly ───────────────────────────────────────────────────
-- Tracks per-agent hourly aggregates of Tier 1 events.
-- Primary data source for Morning Brief System Health and Bar Raiser analysis.

CREATE TABLE IF NOT EXISTS telemetry_agent_hourly (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name VARCHAR NOT NULL,
  hour_bucket TIMESTAMP NOT NULL,

  -- Action metrics
  action_count INT NOT NULL DEFAULT 0,
  success_count INT NOT NULL DEFAULT 0,
  error_count INT NOT NULL DEFAULT 0,

  -- Latency metrics
  avg_latency_ms FLOAT,
  p95_latency_ms FLOAT,
  p99_latency_ms FLOAT,

  -- Reasoning
  reasoning_steps_avg FLOAT,

  -- Model distribution (JSONB — e.g. {"grok-4": 5, "qwen3:32b": 12})
  model_distribution JSONB NOT NULL DEFAULT '{}',

  -- Token metrics
  tokens_in_total BIGINT NOT NULL DEFAULT 0,
  tokens_out_total BIGINT NOT NULL DEFAULT 0,

  -- Cost
  cost_usd_total DECIMAL(10,4) NOT NULL DEFAULT 0,

  -- Performance score (composite, 0.0–1.0)
  performance_score FLOAT,

  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(agent_name, hour_bucket)
);

CREATE INDEX IF NOT EXISTS idx_agent_hourly_agent
  ON telemetry_agent_hourly(agent_name, hour_bucket DESC);
CREATE INDEX IF NOT EXISTS idx_agent_hourly_hour
  ON telemetry_agent_hourly(hour_bucket DESC);

-- ─── telemetry_cost_daily ─────────────────────────────────────────────────────
-- Breaks down API spending by agent, model, and day.

CREATE TABLE IF NOT EXISTS telemetry_cost_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  agent_name VARCHAR NOT NULL,
  model VARCHAR NOT NULL,

  -- Token metrics
  total_tokens_in BIGINT NOT NULL DEFAULT 0,
  total_tokens_out BIGINT NOT NULL DEFAULT 0,

  -- Cost metrics
  total_cost_usd DECIMAL(10,4) NOT NULL DEFAULT 0,
  avg_cost_per_action DECIMAL(10,6),
  cost_per_mtok DECIMAL(12,8),

  -- Volume
  invocations INT NOT NULL DEFAULT 0,

  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(date, agent_name, model)
);

CREATE INDEX IF NOT EXISTS idx_cost_daily_agent
  ON telemetry_cost_daily(agent_name, date DESC);
CREATE INDEX IF NOT EXISTS idx_cost_daily_date
  ON telemetry_cost_daily(date DESC);
CREATE INDEX IF NOT EXISTS idx_cost_daily_cost
  ON telemetry_cost_daily(total_cost_usd DESC);

-- ─── telemetry_quality_daily ──────────────────────────────────────────────────
-- Tracks quality trends per agent and metric name per day.

CREATE TABLE IF NOT EXISTS telemetry_quality_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  agent_name VARCHAR NOT NULL,
  metric_name VARCHAR NOT NULL,

  -- Metric data
  metric_value FLOAT NOT NULL,
  trend VARCHAR,                     -- 'improving', 'stable', 'declining'
  p50_value FLOAT,
  p95_value FLOAT,
  sample_count INT,

  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(date, agent_name, metric_name)
);

CREATE INDEX IF NOT EXISTS idx_quality_daily_agent
  ON telemetry_quality_daily(agent_name, date DESC);
CREATE INDEX IF NOT EXISTS idx_quality_daily_metric
  ON telemetry_quality_daily(metric_name, date DESC);

-- ─── telemetry_anomalies ──────────────────────────────────────────────────────
-- Captures anomalies detected by threshold rules or statistical methods.
-- Bar Raiser and Morning Brief read from here.

CREATE TABLE IF NOT EXISTS telemetry_anomalies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at TIMESTAMP NOT NULL,
  agent_name VARCHAR NOT NULL,
  anomaly_type VARCHAR NOT NULL,

  -- Severity and description
  severity VARCHAR NOT NULL,           -- 'info', 'warning', 'critical'
  detection_method VARCHAR NOT NULL,
  description TEXT NOT NULL,
  anomaly_details JSONB NOT NULL DEFAULT '{}',

  -- Metric context
  metric_name VARCHAR,
  expected_value FLOAT,
  actual_value FLOAT,
  threshold_value FLOAT,

  -- Lifecycle
  acknowledged_at TIMESTAMP,
  resolved_at TIMESTAMP,

  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_anomalies_agent
  ON telemetry_anomalies(agent_name, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_anomalies_unresolved
  ON telemetry_anomalies(severity, detected_at DESC)
  WHERE resolved_at IS NULL;

-- ─── telemetry_bets ──────────────────────────────────────────────────────────
-- Tracks structural learning proposals as Bet nodes (Loop 3).
-- Bets are hypotheses about system changes, tracked through a lifecycle:
-- pending_approval → active → confirmed | revised | abandoned

CREATE TABLE IF NOT EXISTS telemetry_bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name VARCHAR NOT NULL,

  -- Bet definition
  hypothesis TEXT NOT NULL,
  expected_outcome TEXT NOT NULL,
  measurement_criteria TEXT NOT NULL,
  rollback_trigger TEXT NOT NULL,

  -- Outcome (populated at review time)
  actual_outcome TEXT,

  -- Lifecycle
  status VARCHAR NOT NULL DEFAULT 'pending_approval',
  created_date DATE NOT NULL DEFAULT CURRENT_DATE,
  review_date DATE,
  source_review_month VARCHAR(7) NOT NULL,      -- YYYY-MM format

  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bets_agent
  ON telemetry_bets(agent_name, created_date DESC);
CREATE INDEX IF NOT EXISTS idx_bets_status
  ON telemetry_bets(status);
CREATE INDEX IF NOT EXISTS idx_bets_review_month
  ON telemetry_bets(source_review_month);

-- ─── Retention policy helper ──────────────────────────────────────────────────
-- Call periodically to delete data older than 1 year.

CREATE OR REPLACE FUNCTION telemetry_cleanup_old_data(retention_days INT DEFAULT 365)
RETURNS TABLE(table_name TEXT, deleted_count BIGINT) AS $$
BEGIN
  table_name := 'telemetry_agent_hourly';
  DELETE FROM telemetry_agent_hourly WHERE hour_bucket < now() - (retention_days || ' days')::interval;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN NEXT;

  table_name := 'telemetry_cost_daily';
  DELETE FROM telemetry_cost_daily WHERE date < (CURRENT_DATE - retention_days);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN NEXT;

  table_name := 'telemetry_quality_daily';
  DELETE FROM telemetry_quality_daily WHERE date < (CURRENT_DATE - retention_days);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN NEXT;

  table_name := 'telemetry_anomalies';
  DELETE FROM telemetry_anomalies WHERE detected_at < now() - (retention_days || ' days')::interval;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
`;

/**
 * Run Tier 2 migration — creates all four tables and indexes.
 * Idempotent: safe to run multiple times (IF NOT EXISTS / CREATE OR REPLACE).
 */
export async function runTier2Migration(pool: pg.Pool): Promise<void> {
  await pool.query(TIER2_MIGRATION_SQL);
}

/**
 * Drop all Tier 2 tables. Used for test cleanup only.
 */
export async function dropTier2Tables(pool: pg.Pool): Promise<void> {
  await pool.query(`
    DROP FUNCTION IF EXISTS telemetry_cleanup_old_data(INT);
    DROP TABLE IF EXISTS telemetry_bets CASCADE;
    DROP TABLE IF EXISTS telemetry_anomalies CASCADE;
    DROP TABLE IF EXISTS telemetry_quality_daily CASCADE;
    DROP TABLE IF EXISTS telemetry_cost_daily CASCADE;
    DROP TABLE IF EXISTS telemetry_agent_hourly CASCADE;
  `);
}
