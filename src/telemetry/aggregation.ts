import pg from "pg";
import type { TelemetryEvent } from "./types.js";
import type { TelemetryEmitter } from "./emitter.js";
import type { Tier2Repository } from "./tier2-repository.js";

/**
 * VEGA v3.3 Aggregation Jobs
 *
 * Two jobs that read Tier 1 JSONL events and populate Tier 2 PostgreSQL tables:
 * - Hourly: reads previous hour's events → upserts telemetry_agent_hourly
 * - Daily: reads previous day's events → upserts telemetry_cost_daily, telemetry_quality_daily,
 *          runs anomaly detection → inserts telemetry_anomalies
 *
 * Both jobs are idempotent (ON CONFLICT DO UPDATE).
 * Both log execution to Tier 1 event stream.
 * Backfill mode: can be run with explicit time range.
 */

// ─── Cost estimation ────────────────────────────────────────────────────────

/** Per-million-token cost rates by model. */
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "grok-4-1-fast-reasoning": { input: 3.0, output: 15.0 },
  "qwen3:32b": { input: 0, output: 0 },
};
const DEFAULT_MODEL_COST = { input: 1.0, output: 5.0 };

function estimateCost(model: string | null | undefined, tokensIn: number, tokensOut: number): number {
  if (!model) return 0;
  const rates = MODEL_COSTS[model] ?? DEFAULT_MODEL_COST;
  return (tokensIn * rates.input + tokensOut * rates.output) / 1_000_000;
}

// ─── Statistics helpers ─────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, x) => sum + (x - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ─── Result type ────────────────────────────────────────────────────────────

export interface AggregationResult {
  job_type: "hourly" | "daily";
  time_range: { from: Date; to: Date };
  agents_processed: number;
  rows_upserted: number;
  anomalies_detected: number;
}

// ─── Hourly Aggregation ─────────────────────────────────────────────────────

/**
 * Run hourly aggregation for a specific hour.
 *
 * Reads JSONL events for the hour, computes per-agent aggregates,
 * and upserts into telemetry_agent_hourly.
 *
 * Scheduled to run at :15 past each hour via IronClaw.
 * Pass the start of the target hour as `hourBucket`.
 */
export async function runHourlyAggregation(
  emitter: TelemetryEmitter,
  repo: Tier2Repository,
  hourBucket: Date,
  options?: { emitTelemetry?: boolean },
): Promise<AggregationResult> {
  const hourStart = new Date(hourBucket);
  hourStart.setUTCMinutes(0, 0, 0);
  const hourEnd = new Date(hourStart);
  hourEnd.setUTCHours(hourEnd.getUTCHours() + 1);

  // Read events for the day, filter to the target hour
  const dayEvents = await emitter.readEvents(hourStart);
  const hourEvents = dayEvents.filter((e) => {
    const ts = new Date(e.timestamp);
    return ts >= hourStart && ts < hourEnd;
  });

  // Group by agent
  const agentGroups = groupByAgent(hourEvents);
  let rowsUpserted = 0;

  for (const [agentName, events] of agentGroups) {
    const actionCount = events.length;
    const successCount = events.filter((e) => e.outcome === "success").length;
    const errorCount = events.filter((e) => e.outcome === "failure").length;

    // Latency
    const latencies = events
      .map((e) => e.latency_ms)
      .filter((l): l is number => l != null && l > 0);
    const sortedLatencies = [...latencies].sort((a, b) => a - b);
    const avgLatency = latencies.length > 0 ? mean(latencies) : null;
    const p95Latency = sortedLatencies.length > 0 ? percentile(sortedLatencies, 95) : null;
    const p99Latency = sortedLatencies.length > 0 ? percentile(sortedLatencies, 99) : null;

    // Reasoning steps from metadata
    const reasoningSteps = events
      .map((e) => (e.metadata as Record<string, unknown>)?.reasoning_steps)
      .filter((r): r is number => typeof r === "number");
    const reasoningStepsAvg = reasoningSteps.length > 0 ? mean(reasoningSteps) : null;

    // Model distribution (only count events that actually used a model)
    const modelDist: Record<string, number> = {};
    for (const event of events) {
      if (event.model_used) {
        modelDist[event.model_used] = (modelDist[event.model_used] ?? 0) + 1;
      }
    }

    // Tokens
    const tokensIn = events.reduce((sum, e) => sum + (e.tokens_in ?? 0), 0);
    const tokensOut = events.reduce((sum, e) => sum + (e.tokens_out ?? 0), 0);

    // Cost
    let costTotal = 0;
    for (const event of events) {
      costTotal += estimateCost(event.model_used, event.tokens_in ?? 0, event.tokens_out ?? 0);
    }

    // Performance score: weighted composite of success rate and latency efficiency
    const successRate = actionCount > 0 ? successCount / actionCount : 0;
    const latencyScore = avgLatency != null ? Math.max(0, 1 - avgLatency / 10000) : 1;
    const performanceScore = actionCount > 0 ? 0.7 * successRate + 0.3 * latencyScore : null;

    await repo.upsertAgentHourly({
      agent_name: agentName,
      hour_bucket: hourStart,
      action_count: actionCount,
      success_count: successCount,
      error_count: errorCount,
      avg_latency_ms: avgLatency,
      p95_latency_ms: p95Latency,
      p99_latency_ms: p99Latency,
      reasoning_steps_avg: reasoningStepsAvg,
      model_distribution: modelDist,
      tokens_in_total: tokensIn,
      tokens_out_total: tokensOut,
      cost_usd_total: costTotal,
      performance_score: performanceScore,
    });
    rowsUpserted++;
  }

  // Log execution to Tier 1
  if (options?.emitTelemetry !== false) {
    await emitter.emit({
      agent_name: "system",
      event_type: "system_event",
      event_subtype: "aggregation_complete",
      session_id: `agg-hourly-${hourStart.toISOString()}`,
      outcome: "success",
      metadata: {
        job_type: "hourly",
        hour_bucket: hourStart.toISOString(),
        agents_processed: agentGroups.size,
        rows_upserted: rowsUpserted,
      },
    });
  }

  return {
    job_type: "hourly",
    time_range: { from: hourStart, to: hourEnd },
    agents_processed: agentGroups.size,
    rows_upserted: rowsUpserted,
    anomalies_detected: 0,
  };
}

// ─── Daily Aggregation ──────────────────────────────────────────────────────

/**
 * Run daily aggregation for a specific date.
 *
 * Computes cost_daily and quality_daily rollups from the day's JSONL events,
 * then runs anomaly detection (>2σ from 7-day rolling average on error_count or latency).
 *
 * Scheduled to run at 01:00 UTC via IronClaw.
 * Pass the target date as `date`.
 */
export async function runDailyAggregation(
  emitter: TelemetryEmitter,
  repo: Tier2Repository,
  _pool: pg.Pool,
  date: Date,
  options?: { emitTelemetry?: boolean },
): Promise<AggregationResult> {
  const dayStart = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const dayEvents = await emitter.readEvents(dayStart);
  let rowsUpserted = 0;
  let anomaliesDetected = 0;

  // ─── Cost daily ─────────────────────────────────────────────────────────
  // Group by (agent_name, model)
  const costGroups = new Map<string, TelemetryEvent[]>();
  for (const event of dayEvents) {
    const model = event.model_used ?? "unknown";
    const key = `${event.agent_name}||${model}`;
    const group = costGroups.get(key) ?? [];
    group.push(event);
    costGroups.set(key, group);
  }

  for (const [key, events] of costGroups) {
    const [agentName, model] = key.split("||");
    const tokensIn = events.reduce((sum, e) => sum + (e.tokens_in ?? 0), 0);
    const tokensOut = events.reduce((sum, e) => sum + (e.tokens_out ?? 0), 0);
    const invocations = events.length;

    let totalCost = 0;
    for (const event of events) {
      totalCost += estimateCost(event.model_used, event.tokens_in ?? 0, event.tokens_out ?? 0);
    }

    const avgCostPerAction = invocations > 0 ? totalCost / invocations : null;
    const totalTokens = tokensIn + tokensOut;
    const costPerMtok = totalTokens > 0 ? (totalCost / totalTokens) * 1_000_000 : null;

    await repo.upsertCostDaily({
      date: dayStart,
      agent_name: agentName,
      model,
      total_tokens_in: tokensIn,
      total_tokens_out: tokensOut,
      total_cost_usd: totalCost,
      avg_cost_per_action: avgCostPerAction,
      cost_per_mtok: costPerMtok,
      invocations,
    });
    rowsUpserted++;
  }

  // ─── Quality daily ──────────────────────────────────────────────────────
  const agentGroups = groupByAgent(dayEvents);

  // Previous day for trend comparison
  const prevDay = new Date(dayStart);
  prevDay.setUTCDate(prevDay.getUTCDate() - 1);

  for (const [agentName, events] of agentGroups) {
    const actionCount = events.length;
    const successCount = events.filter((e) => e.outcome === "success").length;
    const errorCount = events.filter((e) => e.outcome === "failure").length;

    const successRate = actionCount > 0 ? successCount / actionCount : 0;
    const errorRate = actionCount > 0 ? errorCount / actionCount : 0;

    const latencies = events
      .map((e) => e.latency_ms)
      .filter((l): l is number => l != null && l > 0);
    const sortedLatencies = [...latencies].sort((a, b) => a - b);
    const avgLatency = latencies.length > 0 ? mean(latencies) : 0;
    const p50Latency = sortedLatencies.length > 0 ? percentile(sortedLatencies, 50) : null;
    const p95Latency = sortedLatencies.length > 0 ? percentile(sortedLatencies, 95) : null;

    // Get previous day's metrics for trend computation
    const prevMetrics = await repo.queryQualityDaily(agentName, prevDay, prevDay);

    const computeTrend = (
      metricName: string,
      currentValue: number,
    ): "improving" | "stable" | "declining" | null => {
      const prev = prevMetrics.find((m) => m.metric_name === metricName);
      if (!prev) return null;
      const prevValue = prev.metric_value;
      if (prevValue === 0 && currentValue === 0) return "stable";
      const delta = prevValue !== 0 ? (currentValue - prevValue) / Math.abs(prevValue) : 0;
      // For error_rate and latency, lower is better
      if (metricName === "error_rate" || metricName === "avg_latency_ms") {
        if (delta < -0.05) return "improving";
        if (delta > 0.05) return "declining";
        return "stable";
      }
      // For success_rate, higher is better
      if (delta > 0.05) return "improving";
      if (delta < -0.05) return "declining";
      return "stable";
    };

    await repo.upsertQualityDaily({
      date: dayStart,
      agent_name: agentName,
      metric_name: "success_rate",
      metric_value: successRate,
      trend: computeTrend("success_rate", successRate),
      p50_value: successRate,
      p95_value: successRate,
      sample_count: actionCount,
    });
    rowsUpserted++;

    if (latencies.length > 0) {
      await repo.upsertQualityDaily({
        date: dayStart,
        agent_name: agentName,
        metric_name: "avg_latency_ms",
        metric_value: avgLatency,
        trend: computeTrend("avg_latency_ms", avgLatency),
        p50_value: p50Latency,
        p95_value: p95Latency,
        sample_count: latencies.length,
      });
      rowsUpserted++;
    }

    await repo.upsertQualityDaily({
      date: dayStart,
      agent_name: agentName,
      metric_name: "error_rate",
      metric_value: errorRate,
      trend: computeTrend("error_rate", errorRate),
      p50_value: errorRate,
      p95_value: errorRate,
      sample_count: actionCount,
    });
    rowsUpserted++;
  }

  // ─── Anomaly detection ──────────────────────────────────────────────────
  // Flag agents with >2σ deviation from 7-day rolling average on error_count or latency
  const sevenDaysAgo = new Date(dayStart);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);

  for (const [agentName, events] of agentGroups) {
    const todayErrorCount = events.filter((e) => e.outcome === "failure").length;
    const todayLatencies = events
      .map((e) => e.latency_ms)
      .filter((l): l is number => l != null && l > 0);
    const todayAvgLatency = todayLatencies.length > 0 ? mean(todayLatencies) : null;

    // Get 7-day historical hourly data for this agent
    const hourlyRows = await repo.queryAgentHourly(agentName, sevenDaysAgo, dayStart);
    if (hourlyRows.length < 3) continue; // Need minimum data for meaningful statistics

    // Aggregate hourly rows into daily summaries
    const dailyStats = new Map<string, { errorCount: number; latencies: number[] }>();
    for (const row of hourlyRows) {
      const dayKey = row.hour_bucket.toISOString().slice(0, 10);
      const stats = dailyStats.get(dayKey) ?? { errorCount: 0, latencies: [] };
      stats.errorCount += row.error_count;
      if (row.avg_latency_ms != null) {
        stats.latencies.push(row.avg_latency_ms);
      }
      dailyStats.set(dayKey, stats);
    }

    // Check error_count anomaly
    const dailyErrorCounts = [...dailyStats.values()].map((s) => s.errorCount);
    if (dailyErrorCounts.length >= 2) {
      const m = mean(dailyErrorCounts);
      const sd = stddev(dailyErrorCounts);
      if (sd > 0 && Math.abs(todayErrorCount - m) > 2 * sd) {
        const sigma = (todayErrorCount - m) / sd;
        await repo.insertAnomaly({
          detected_at: new Date(),
          agent_name: agentName,
          anomaly_type: "error_count_deviation",
          severity: Math.abs(sigma) > 3 ? "critical" : "warning",
          detection_method: "daily_aggregation_2sigma",
          description: `Error count ${todayErrorCount} deviates ${sigma.toFixed(1)}σ from 7-day rolling average ${m.toFixed(1)}`,
          anomaly_details: {
            current_value: todayErrorCount,
            rolling_mean: m,
            rolling_stddev: sd,
            sigma_deviation: sigma,
          },
          metric_name: "error_count",
          expected_value: m,
          actual_value: todayErrorCount,
          threshold_value: m + 2 * sd,
          acknowledged_at: null,
          resolved_at: null,
        });
        anomaliesDetected++;
      }
    }

    // Check latency anomaly
    const dailyAvgLatencies = [...dailyStats.values()]
      .filter((s) => s.latencies.length > 0)
      .map((s) => mean(s.latencies));
    if (todayAvgLatency != null && dailyAvgLatencies.length >= 2) {
      const m = mean(dailyAvgLatencies);
      const sd = stddev(dailyAvgLatencies);
      if (sd > 0 && Math.abs(todayAvgLatency - m) > 2 * sd) {
        const sigma = (todayAvgLatency - m) / sd;
        await repo.insertAnomaly({
          detected_at: new Date(),
          agent_name: agentName,
          anomaly_type: "latency_deviation",
          severity: Math.abs(sigma) > 3 ? "critical" : "warning",
          detection_method: "daily_aggregation_2sigma",
          description: `Avg latency ${todayAvgLatency.toFixed(0)}ms deviates ${sigma.toFixed(1)}σ from 7-day rolling average ${m.toFixed(0)}ms`,
          anomaly_details: {
            current_value: todayAvgLatency,
            rolling_mean: m,
            rolling_stddev: sd,
            sigma_deviation: sigma,
          },
          metric_name: "avg_latency_ms",
          expected_value: m,
          actual_value: todayAvgLatency,
          threshold_value: m + 2 * sd,
          acknowledged_at: null,
          resolved_at: null,
        });
        anomaliesDetected++;
      }
    }
  }

  // Log execution to Tier 1
  if (options?.emitTelemetry !== false) {
    await emitter.emit({
      agent_name: "system",
      event_type: "system_event",
      event_subtype: "aggregation_complete",
      session_id: `agg-daily-${dayStart.toISOString().slice(0, 10)}`,
      outcome: "success",
      metadata: {
        job_type: "daily",
        date: dayStart.toISOString().slice(0, 10),
        agents_processed: agentGroups.size,
        rows_upserted: rowsUpserted,
        anomalies_detected: anomaliesDetected,
      },
    });
  }

  return {
    job_type: "daily",
    time_range: { from: dayStart, to: dayEnd },
    agents_processed: agentGroups.size,
    rows_upserted: rowsUpserted,
    anomalies_detected: anomaliesDetected,
  };
}

// ─── Backfill ───────────────────────────────────────────────────────────────

/**
 * Backfill hourly aggregations for a range of hours.
 * Iterates hour-by-hour from `from` to `to` (exclusive).
 */
export async function backfillHourly(
  emitter: TelemetryEmitter,
  repo: Tier2Repository,
  from: Date,
  to: Date,
  options?: { emitTelemetry?: boolean },
): Promise<AggregationResult[]> {
  const results: AggregationResult[] = [];
  const current = new Date(from);
  current.setUTCMinutes(0, 0, 0);

  while (current < to) {
    const result = await runHourlyAggregation(emitter, repo, current, options);
    results.push(result);
    current.setUTCHours(current.getUTCHours() + 1);
  }

  return results;
}

/**
 * Backfill daily aggregations for a range of dates.
 * Iterates day-by-day from `from` to `to` (inclusive).
 */
export async function backfillDaily(
  emitter: TelemetryEmitter,
  repo: Tier2Repository,
  pool: pg.Pool,
  from: Date,
  to: Date,
  options?: { emitTelemetry?: boolean },
): Promise<AggregationResult[]> {
  const results: AggregationResult[] = [];
  const current = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );
  const end = new Date(
    Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()),
  );

  while (current <= end) {
    const result = await runDailyAggregation(emitter, repo, pool, current, options);
    results.push(result);
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return results;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function groupByAgent(events: TelemetryEvent[]): Map<string, TelemetryEvent[]> {
  const groups = new Map<string, TelemetryEvent[]>();
  for (const event of events) {
    const group = groups.get(event.agent_name) ?? [];
    group.push(event);
    groups.set(event.agent_name, group);
  }
  return groups;
}
