import pg from "pg";

import {
  AgentHourlySchema,
  CostDailySchema,
  QualityDailySchema,
  AnomalySchema,
  type AgentHourlyInput,
  type AgentHourly,
  type CostDailyInput,
  type CostDaily,
  type QualityDailyInput,
  type QualityDaily,
  type AnomalyInput,
  type Anomaly,
} from "./tier2-types.js";

/**
 * Tier2Repository — CRUD operations for the four Tier 2 aggregation tables.
 *
 * All write operations use ON CONFLICT DO UPDATE (upsert) for idempotency.
 * This ensures that re-running aggregation jobs produces identical results.
 */
export class Tier2Repository {
  constructor(private readonly pool: pg.Pool) {}

  // ─── telemetry_agent_hourly ───────────────────────────────────────────────

  /**
   * Upsert an hourly agent aggregation row.
   * Conflict key: (agent_name, hour_bucket).
   */
  async upsertAgentHourly(input: AgentHourlyInput): Promise<AgentHourly> {
    const row = AgentHourlySchema.omit({ id: true, created_at: true }).parse(input);
    const result = await this.pool.query(
      `INSERT INTO telemetry_agent_hourly (
        agent_name, hour_bucket, action_count, success_count, error_count,
        avg_latency_ms, p95_latency_ms, p99_latency_ms,
        reasoning_steps_avg, model_distribution,
        tokens_in_total, tokens_out_total, cost_usd_total, performance_score
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (agent_name, hour_bucket) DO UPDATE SET
        action_count = EXCLUDED.action_count,
        success_count = EXCLUDED.success_count,
        error_count = EXCLUDED.error_count,
        avg_latency_ms = EXCLUDED.avg_latency_ms,
        p95_latency_ms = EXCLUDED.p95_latency_ms,
        p99_latency_ms = EXCLUDED.p99_latency_ms,
        reasoning_steps_avg = EXCLUDED.reasoning_steps_avg,
        model_distribution = EXCLUDED.model_distribution,
        tokens_in_total = EXCLUDED.tokens_in_total,
        tokens_out_total = EXCLUDED.tokens_out_total,
        cost_usd_total = EXCLUDED.cost_usd_total,
        performance_score = EXCLUDED.performance_score
      RETURNING *`,
      [
        row.agent_name,
        row.hour_bucket,
        row.action_count,
        row.success_count,
        row.error_count,
        row.avg_latency_ms,
        row.p95_latency_ms,
        row.p99_latency_ms,
        row.reasoning_steps_avg,
        JSON.stringify(row.model_distribution),
        row.tokens_in_total,
        row.tokens_out_total,
        row.cost_usd_total,
        row.performance_score,
      ],
    );
    return this.parseAgentHourlyRow(result.rows[0]);
  }

  /** Query hourly rows for an agent within a time range. */
  async queryAgentHourly(
    agentName: string,
    from: Date,
    to: Date,
  ): Promise<AgentHourly[]> {
    const result = await this.pool.query(
      `SELECT * FROM telemetry_agent_hourly
       WHERE agent_name = $1 AND hour_bucket >= $2 AND hour_bucket < $3
       ORDER BY hour_bucket DESC`,
      [agentName, from, to],
    );
    return result.rows.map((r) => this.parseAgentHourlyRow(r));
  }

  private parseAgentHourlyRow(row: Record<string, unknown>): AgentHourly {
    return AgentHourlySchema.parse({
      ...row,
      model_distribution:
        typeof row.model_distribution === "string"
          ? JSON.parse(row.model_distribution)
          : row.model_distribution,
      // pg returns BIGINT and DECIMAL as strings
      tokens_in_total: Number(row.tokens_in_total),
      tokens_out_total: Number(row.tokens_out_total),
      cost_usd_total: Number(row.cost_usd_total),
    });
  }

  // ─── telemetry_cost_daily ─────────────────────────────────────────────────

  /**
   * Upsert a daily cost row.
   * Conflict key: (date, agent_name, model).
   */
  async upsertCostDaily(input: CostDailyInput): Promise<CostDaily> {
    const row = CostDailySchema.omit({ id: true, created_at: true }).parse(input);
    const result = await this.pool.query(
      `INSERT INTO telemetry_cost_daily (
        date, agent_name, model,
        total_tokens_in, total_tokens_out,
        total_cost_usd, avg_cost_per_action, cost_per_mtok,
        invocations
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (date, agent_name, model) DO UPDATE SET
        total_tokens_in = EXCLUDED.total_tokens_in,
        total_tokens_out = EXCLUDED.total_tokens_out,
        total_cost_usd = EXCLUDED.total_cost_usd,
        avg_cost_per_action = EXCLUDED.avg_cost_per_action,
        cost_per_mtok = EXCLUDED.cost_per_mtok,
        invocations = EXCLUDED.invocations
      RETURNING *`,
      [
        row.date,
        row.agent_name,
        row.model,
        row.total_tokens_in,
        row.total_tokens_out,
        row.total_cost_usd,
        row.avg_cost_per_action,
        row.cost_per_mtok,
        row.invocations,
      ],
    );
    return this.parseCostDailyRow(result.rows[0]);
  }

  /** Query daily cost rows for an agent. */
  async queryCostDaily(agentName: string, from: Date, to: Date): Promise<CostDaily[]> {
    const result = await this.pool.query(
      `SELECT * FROM telemetry_cost_daily
       WHERE agent_name = $1 AND date >= $2 AND date <= $3
       ORDER BY date DESC`,
      [agentName, from, to],
    );
    return result.rows.map((r) => this.parseCostDailyRow(r));
  }

  private parseCostDailyRow(row: Record<string, unknown>): CostDaily {
    return CostDailySchema.parse({
      ...row,
      // pg returns BIGINT and DECIMAL as strings
      total_tokens_in: Number(row.total_tokens_in),
      total_tokens_out: Number(row.total_tokens_out),
      total_cost_usd: Number(row.total_cost_usd),
      avg_cost_per_action: row.avg_cost_per_action != null ? Number(row.avg_cost_per_action) : null,
      cost_per_mtok: row.cost_per_mtok != null ? Number(row.cost_per_mtok) : null,
    });
  }

  // ─── telemetry_quality_daily ──────────────────────────────────────────────

  /**
   * Upsert a daily quality metric row.
   * Conflict key: (date, agent_name, metric_name).
   */
  async upsertQualityDaily(input: QualityDailyInput): Promise<QualityDaily> {
    const row = QualityDailySchema.omit({ id: true, created_at: true }).parse(input);
    const result = await this.pool.query(
      `INSERT INTO telemetry_quality_daily (
        date, agent_name, metric_name,
        metric_value, trend, p50_value, p95_value, sample_count
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (date, agent_name, metric_name) DO UPDATE SET
        metric_value = EXCLUDED.metric_value,
        trend = EXCLUDED.trend,
        p50_value = EXCLUDED.p50_value,
        p95_value = EXCLUDED.p95_value,
        sample_count = EXCLUDED.sample_count
      RETURNING *`,
      [
        row.date,
        row.agent_name,
        row.metric_name,
        row.metric_value,
        row.trend,
        row.p50_value,
        row.p95_value,
        row.sample_count,
      ],
    );
    return QualityDailySchema.parse(result.rows[0]);
  }

  /** Query daily quality rows for an agent. */
  async queryQualityDaily(
    agentName: string,
    from: Date,
    to: Date,
  ): Promise<QualityDaily[]> {
    const result = await this.pool.query(
      `SELECT * FROM telemetry_quality_daily
       WHERE agent_name = $1 AND date >= $2 AND date <= $3
       ORDER BY date DESC`,
      [agentName, from, to],
    );
    return result.rows.map((r) => QualityDailySchema.parse(r));
  }

  // ─── telemetry_anomalies ──────────────────────────────────────────────────

  /** Insert an anomaly record. Anomalies are event-driven, not time-windowed, so no upsert. */
  async insertAnomaly(input: AnomalyInput): Promise<Anomaly> {
    const row = AnomalySchema.omit({ id: true, created_at: true }).parse(input);
    const result = await this.pool.query(
      `INSERT INTO telemetry_anomalies (
        detected_at, agent_name, anomaly_type,
        severity, detection_method, description, anomaly_details,
        metric_name, expected_value, actual_value, threshold_value,
        acknowledged_at, resolved_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *`,
      [
        row.detected_at,
        row.agent_name,
        row.anomaly_type,
        row.severity,
        row.detection_method,
        row.description,
        JSON.stringify(row.anomaly_details),
        row.metric_name,
        row.expected_value,
        row.actual_value,
        row.threshold_value,
        row.acknowledged_at,
        row.resolved_at,
      ],
    );
    return this.parseAnomalyRow(result.rows[0]);
  }

  /** Query unresolved anomalies, optionally filtered by severity. */
  async queryUnresolvedAnomalies(severity?: string): Promise<Anomaly[]> {
    let query = `SELECT * FROM telemetry_anomalies WHERE resolved_at IS NULL`;
    const params: unknown[] = [];
    if (severity) {
      query += ` AND severity = $1`;
      params.push(severity);
    }
    query += ` ORDER BY detected_at DESC`;
    const result = await this.pool.query(query, params);
    return result.rows.map((r) => this.parseAnomalyRow(r));
  }

  /** Acknowledge an anomaly. */
  async acknowledgeAnomaly(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE telemetry_anomalies SET acknowledged_at = now() WHERE id = $1`,
      [id],
    );
  }

  /** Resolve an anomaly. */
  async resolveAnomaly(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE telemetry_anomalies SET resolved_at = now() WHERE id = $1`,
      [id],
    );
  }

  private parseAnomalyRow(row: Record<string, unknown>): Anomaly {
    return AnomalySchema.parse({
      ...row,
      anomaly_details:
        typeof row.anomaly_details === "string"
          ? JSON.parse(row.anomaly_details)
          : row.anomaly_details,
    });
  }
}
