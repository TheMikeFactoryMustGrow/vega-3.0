import { z } from "zod";

/**
 * VEGA v3.3 Tier 2 PostgreSQL Aggregation Table Schemas
 *
 * Four tables that roll up Tier 1 JSONL events into queryable time-series data.
 * Used by Morning Brief, learning loops, and Bar Raiser monitors.
 */

// ─── telemetry_agent_hourly ───────────────────────────────────────────────────

export const AgentHourlySchema = z.object({
  id: z.string().uuid().optional(),
  agent_name: z.string().min(1),
  hour_bucket: z.coerce.date(),

  // Action metrics
  action_count: z.number().int().nonnegative().default(0),
  success_count: z.number().int().nonnegative().default(0),
  error_count: z.number().int().nonnegative().default(0),

  // Latency metrics
  avg_latency_ms: z.number().nonnegative().nullable().default(null),
  p95_latency_ms: z.number().nonnegative().nullable().default(null),
  p99_latency_ms: z.number().nonnegative().nullable().default(null),

  // Reasoning
  reasoning_steps_avg: z.number().nonnegative().nullable().default(null),

  // Model distribution (JSONB — e.g. {"grok-4": 5, "qwen3:32b": 12})
  model_distribution: z.record(z.number().int().nonnegative()).default({}),

  // Token metrics
  tokens_in_total: z.number().int().nonnegative().default(0),
  tokens_out_total: z.number().int().nonnegative().default(0),

  // Cost
  cost_usd_total: z.number().nonnegative().default(0),

  // Performance score (composite, 0.0–1.0)
  performance_score: z.number().min(0).max(1).nullable().default(null),

  created_at: z.coerce.date().optional(),
});

export type AgentHourly = z.infer<typeof AgentHourlySchema>;
export type AgentHourlyInput = Omit<AgentHourly, "id" | "created_at">;

// ─── telemetry_cost_daily ─────────────────────────────────────────────────────

export const CostDailySchema = z.object({
  id: z.string().uuid().optional(),
  date: z.coerce.date(),
  agent_name: z.string().min(1),
  model: z.string().min(1),

  // Token metrics
  total_tokens_in: z.number().int().nonnegative().default(0),
  total_tokens_out: z.number().int().nonnegative().default(0),

  // Cost metrics
  total_cost_usd: z.number().nonnegative().default(0),
  avg_cost_per_action: z.number().nonnegative().nullable().default(null),
  cost_per_mtok: z.number().nonnegative().nullable().default(null),

  // Volume
  invocations: z.number().int().nonnegative().default(0),

  created_at: z.coerce.date().optional(),
});

export type CostDaily = z.infer<typeof CostDailySchema>;
export type CostDailyInput = Omit<CostDaily, "id" | "created_at">;

// ─── telemetry_quality_daily ──────────────────────────────────────────────────

export const TrendDirection = z.enum(["improving", "stable", "declining"]);
export type TrendDirection = z.infer<typeof TrendDirection>;

export const QualityDailySchema = z.object({
  id: z.string().uuid().optional(),
  date: z.coerce.date(),
  agent_name: z.string().min(1),
  metric_name: z.string().min(1),

  // Metric data
  metric_value: z.number(),
  trend: TrendDirection.nullable().default(null),
  p50_value: z.number().nullable().default(null),
  p95_value: z.number().nullable().default(null),
  sample_count: z.number().int().nonnegative().nullable().default(null),

  created_at: z.coerce.date().optional(),
});

export type QualityDaily = z.infer<typeof QualityDailySchema>;
export type QualityDailyInput = Omit<QualityDaily, "id" | "created_at">;

// ─── telemetry_anomalies ──────────────────────────────────────────────────────

export const AnomalySeverity = z.enum(["info", "warning", "critical"]);
export type AnomalySeverity = z.infer<typeof AnomalySeverity>;

export const AnomalySchema = z.object({
  id: z.string().uuid().optional(),
  detected_at: z.coerce.date(),
  agent_name: z.string().min(1),
  anomaly_type: z.string().min(1),

  // Severity and description
  severity: AnomalySeverity,
  detection_method: z.string().min(1),
  description: z.string().min(1),
  anomaly_details: z.record(z.unknown()).default({}),

  // Metric context
  metric_name: z.string().nullable().default(null),
  expected_value: z.number().nullable().default(null),
  actual_value: z.number().nullable().default(null),
  threshold_value: z.number().nullable().default(null),

  // Lifecycle
  acknowledged_at: z.coerce.date().nullable().default(null),
  resolved_at: z.coerce.date().nullable().default(null),

  created_at: z.coerce.date().optional(),
});

export type Anomaly = z.infer<typeof AnomalySchema>;
export type AnomalyInput = Omit<Anomaly, "id" | "created_at">;
