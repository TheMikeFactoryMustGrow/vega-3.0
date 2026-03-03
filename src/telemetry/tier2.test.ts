import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createPool, runTier2Migration, dropTier2Tables } from "./database.js";
import { Tier2Repository } from "./tier2-repository.js";
import {
  AgentHourlySchema,
  CostDailySchema,
  QualityDailySchema,
  AnomalySchema,
} from "./tier2-types.js";

const TEST_DB_URL =
  process.env.VEGA_TEST_PG_URL ?? "postgres://localhost/vega_test";

let pool: pg.Pool;
let repo: Tier2Repository;

beforeAll(async () => {
  pool = createPool(TEST_DB_URL);
  // Ensure clean state
  await dropTier2Tables(pool);
  await runTier2Migration(pool);
  repo = new Tier2Repository(pool);
});

afterAll(async () => {
  await dropTier2Tables(pool);
  await pool.end();
});

// ─── telemetry_agent_hourly ───────────────────────────────────────────────────

describe("telemetry_agent_hourly", () => {
  it("INSERT sample row → SELECT returns expected values", async () => {
    const hourBucket = new Date("2026-03-03T10:00:00.000Z");

    const result = await repo.upsertAgentHourly({
      agent_name: "knowledge_agent",
      hour_bucket: hourBucket,
      action_count: 42,
      success_count: 40,
      error_count: 2,
      avg_latency_ms: 350.5,
      p95_latency_ms: 1200.0,
      p99_latency_ms: 2500.0,
      reasoning_steps_avg: 3.7,
      model_distribution: { "grok-4": 30, "qwen3:32b": 12 },
      tokens_in_total: 52000,
      tokens_out_total: 18000,
      cost_usd_total: 0.42,
      performance_score: 0.87,
    });

    expect(result.id).toBeDefined();
    expect(result.agent_name).toBe("knowledge_agent");
    expect(result.action_count).toBe(42);
    expect(result.error_count).toBe(2);
    expect(result.avg_latency_ms).toBeCloseTo(350.5);
    expect(result.p95_latency_ms).toBeCloseTo(1200.0);
    expect(result.reasoning_steps_avg).toBeCloseTo(3.7);
    expect(result.model_distribution).toEqual({ "grok-4": 30, "qwen3:32b": 12 });
    expect(result.performance_score).toBeCloseTo(0.87);

    // Validate against Zod schema
    const parsed = AgentHourlySchema.safeParse(result);
    expect(parsed.success).toBe(true);

    // Verify query returns the row
    const rows = await repo.queryAgentHourly(
      "knowledge_agent",
      new Date("2026-03-03T00:00:00Z"),
      new Date("2026-03-04T00:00:00Z"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action_count).toBe(42);
  });

  it("ON CONFLICT upsert: re-inserting same (agent, hour) updates instead of duplicating", async () => {
    const hourBucket = new Date("2026-03-03T11:00:00.000Z");

    // First insert
    await repo.upsertAgentHourly({
      agent_name: "bar_raiser",
      hour_bucket: hourBucket,
      action_count: 10,
      success_count: 10,
      error_count: 0,
      avg_latency_ms: 200,
      p95_latency_ms: 500,
      p99_latency_ms: null,
      reasoning_steps_avg: 2.0,
      model_distribution: { "grok-4": 10 },
      tokens_in_total: 5000,
      tokens_out_total: 2000,
      cost_usd_total: 0.1,
      performance_score: 0.95,
    });

    // Second insert with updated values — same agent + hour
    const updated = await repo.upsertAgentHourly({
      agent_name: "bar_raiser",
      hour_bucket: hourBucket,
      action_count: 20,
      success_count: 18,
      error_count: 2,
      avg_latency_ms: 250,
      p95_latency_ms: 600,
      p99_latency_ms: 1000,
      reasoning_steps_avg: 2.5,
      model_distribution: { "grok-4": 15, "qwen3:32b": 5 },
      tokens_in_total: 10000,
      tokens_out_total: 4000,
      cost_usd_total: 0.2,
      performance_score: 0.9,
    });

    // Verify upsert updated (not duplicated)
    expect(updated.action_count).toBe(20);
    expect(updated.error_count).toBe(2);

    // Verify only 1 row exists for this agent+hour
    const rows = await repo.queryAgentHourly(
      "bar_raiser",
      new Date("2026-03-03T11:00:00Z"),
      new Date("2026-03-03T12:00:00Z"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action_count).toBe(20);
  });
});

// ─── telemetry_cost_daily ─────────────────────────────────────────────────────

describe("telemetry_cost_daily", () => {
  it("INSERT sample row → SELECT returns expected values", async () => {
    const date = new Date("2026-03-03");

    const result = await repo.upsertCostDaily({
      date,
      agent_name: "knowledge_agent",
      model: "grok-4-1-fast-reasoning",
      total_tokens_in: 120000,
      total_tokens_out: 45000,
      total_cost_usd: 2.15,
      avg_cost_per_action: 0.043,
      cost_per_mtok: 13.03,
      invocations: 50,
    });

    expect(result.id).toBeDefined();
    expect(result.agent_name).toBe("knowledge_agent");
    expect(result.model).toBe("grok-4-1-fast-reasoning");
    expect(result.total_tokens_in).toBe(120000);
    expect(result.total_tokens_out).toBe(45000);
    expect(result.total_cost_usd).toBeCloseTo(2.15);
    expect(result.avg_cost_per_action).toBeCloseTo(0.043);
    expect(result.cost_per_mtok).toBeCloseTo(13.03);
    expect(result.invocations).toBe(50);

    // Validate against Zod schema
    const parsed = CostDailySchema.safeParse(result);
    expect(parsed.success).toBe(true);

    // Verify query
    const rows = await repo.queryCostDaily(
      "knowledge_agent",
      new Date("2026-03-03"),
      new Date("2026-03-03"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].total_cost_usd).toBeCloseTo(2.15);
  });

  it("ON CONFLICT upsert: same (date, agent, model) updates instead of duplicating", async () => {
    const date = new Date("2026-03-02");

    // First insert
    await repo.upsertCostDaily({
      date,
      agent_name: "vega_core",
      model: "qwen3:32b",
      total_tokens_in: 50000,
      total_tokens_out: 20000,
      total_cost_usd: 0.0, // local model, no cost
      avg_cost_per_action: 0.0,
      cost_per_mtok: 0.0,
      invocations: 30,
    });

    // Second insert — updated invocations
    const updated = await repo.upsertCostDaily({
      date,
      agent_name: "vega_core",
      model: "qwen3:32b",
      total_tokens_in: 80000,
      total_tokens_out: 35000,
      total_cost_usd: 0.0,
      avg_cost_per_action: 0.0,
      cost_per_mtok: 0.0,
      invocations: 55,
    });

    expect(updated.invocations).toBe(55);
    expect(updated.total_tokens_in).toBe(80000);

    // Verify only 1 row
    const rows = await repo.queryCostDaily(
      "vega_core",
      new Date("2026-03-02"),
      new Date("2026-03-02"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].invocations).toBe(55);
  });
});

// ─── telemetry_quality_daily ──────────────────────────────────────────────────

describe("telemetry_quality_daily", () => {
  it("INSERT sample row → SELECT returns expected values", async () => {
    const date = new Date("2026-03-03");

    const result = await repo.upsertQualityDaily({
      date,
      agent_name: "knowledge_agent",
      metric_name: "claim_accuracy",
      metric_value: 0.92,
      trend: "improving",
      p50_value: 0.88,
      p95_value: 0.97,
      sample_count: 150,
    });

    expect(result.id).toBeDefined();
    expect(result.agent_name).toBe("knowledge_agent");
    expect(result.metric_name).toBe("claim_accuracy");
    expect(result.metric_value).toBeCloseTo(0.92);
    expect(result.trend).toBe("improving");
    expect(result.p50_value).toBeCloseTo(0.88);
    expect(result.p95_value).toBeCloseTo(0.97);
    expect(result.sample_count).toBe(150);

    // Validate against Zod schema
    const parsed = QualityDailySchema.safeParse(result);
    expect(parsed.success).toBe(true);

    // Verify query
    const rows = await repo.queryQualityDaily(
      "knowledge_agent",
      new Date("2026-03-03"),
      new Date("2026-03-03"),
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const qualityRow = rows.find((r) => r.metric_name === "claim_accuracy");
    expect(qualityRow).toBeDefined();
    expect(qualityRow!.metric_value).toBeCloseTo(0.92);
  });

  it("ON CONFLICT upsert: same (date, agent, metric) updates instead of duplicating", async () => {
    const date = new Date("2026-03-02");

    // First insert
    await repo.upsertQualityDaily({
      date,
      agent_name: "bar_raiser",
      metric_name: "review_thoroughness",
      metric_value: 0.85,
      trend: "stable",
      p50_value: 0.82,
      p95_value: 0.93,
      sample_count: 40,
    });

    // Second insert — metric declined
    const updated = await repo.upsertQualityDaily({
      date,
      agent_name: "bar_raiser",
      metric_name: "review_thoroughness",
      metric_value: 0.78,
      trend: "declining",
      p50_value: 0.75,
      p95_value: 0.90,
      sample_count: 45,
    });

    expect(updated.metric_value).toBeCloseTo(0.78);
    expect(updated.trend).toBe("declining");

    // Verify only 1 row
    const rows = await repo.queryQualityDaily(
      "bar_raiser",
      new Date("2026-03-02"),
      new Date("2026-03-02"),
    );
    const matchingRows = rows.filter((r) => r.metric_name === "review_thoroughness");
    expect(matchingRows).toHaveLength(1);
    expect(matchingRows[0].metric_value).toBeCloseTo(0.78);
  });
});

// ─── telemetry_anomalies ──────────────────────────────────────────────────────

describe("telemetry_anomalies", () => {
  it("INSERT sample anomaly → query returns expected values", async () => {
    const result = await repo.insertAnomaly({
      detected_at: new Date("2026-03-03T02:15:00Z"),
      agent_name: "knowledge_agent",
      anomaly_type: "latency_spike",
      severity: "warning",
      detection_method: "statistical_threshold",
      description: "p95 latency 3.2x above 7-day rolling average",
      anomaly_details: {
        current_p95: 3800,
        rolling_avg_p95: 1188,
        sigma_deviation: 3.2,
      },
      metric_name: "p95_latency_ms",
      expected_value: 1188,
      actual_value: 3800,
      threshold_value: 2376,
      acknowledged_at: null,
      resolved_at: null,
    });

    expect(result.id).toBeDefined();
    expect(result.agent_name).toBe("knowledge_agent");
    expect(result.severity).toBe("warning");
    expect(result.detection_method).toBe("statistical_threshold");
    expect(result.anomaly_details).toEqual({
      current_p95: 3800,
      rolling_avg_p95: 1188,
      sigma_deviation: 3.2,
    });

    // Validate against Zod schema
    const parsed = AnomalySchema.safeParse(result);
    expect(parsed.success).toBe(true);

    // Verify query — should appear in unresolved
    const unresolved = await repo.queryUnresolvedAnomalies();
    expect(unresolved.length).toBeGreaterThanOrEqual(1);
    const found = unresolved.find((a) => a.id === result.id);
    expect(found).toBeDefined();
    expect(found!.severity).toBe("warning");
  });

  it("acknowledge and resolve lifecycle works correctly", async () => {
    const anomaly = await repo.insertAnomaly({
      detected_at: new Date("2026-03-03T03:00:00Z"),
      agent_name: "vega_core",
      anomaly_type: "error_rate_spike",
      severity: "critical",
      detection_method: "threshold_check",
      description: "Error rate exceeded 5% threshold",
      anomaly_details: { error_rate: 0.08, threshold: 0.05 },
      metric_name: "error_rate",
      expected_value: 0.02,
      actual_value: 0.08,
      threshold_value: 0.05,
      acknowledged_at: null,
      resolved_at: null,
    });

    // Should be in unresolved
    let unresolved = await repo.queryUnresolvedAnomalies("critical");
    let found = unresolved.find((a) => a.id === anomaly.id);
    expect(found).toBeDefined();

    // Acknowledge
    await repo.acknowledgeAnomaly(anomaly.id!);

    // Should still be in unresolved (acknowledged but not resolved)
    unresolved = await repo.queryUnresolvedAnomalies("critical");
    found = unresolved.find((a) => a.id === anomaly.id);
    expect(found).toBeDefined();

    // Resolve
    await repo.resolveAnomaly(anomaly.id!);

    // Should no longer be in unresolved
    unresolved = await repo.queryUnresolvedAnomalies("critical");
    found = unresolved.find((a) => a.id === anomaly.id);
    expect(found).toBeUndefined();
  });

  it("filters by severity when querying unresolved anomalies", async () => {
    // Insert an info anomaly
    await repo.insertAnomaly({
      detected_at: new Date("2026-03-03T04:00:00Z"),
      agent_name: "test_agent",
      anomaly_type: "minor_deviation",
      severity: "info",
      detection_method: "bar_raiser_monitor",
      description: "Slight increase in reasoning steps",
      anomaly_details: {},
      metric_name: "reasoning_steps",
      expected_value: 3.0,
      actual_value: 3.5,
      threshold_value: 4.0,
      acknowledged_at: null,
      resolved_at: null,
    });

    const infoOnly = await repo.queryUnresolvedAnomalies("info");
    for (const a of infoOnly) {
      expect(a.severity).toBe("info");
    }
  });
});

// ─── Migration idempotency ──────────────────────────────────────────────────

describe("Migration", () => {
  it("is idempotent — running migration twice does not fail", async () => {
    // Migration was already run in beforeAll. Running again should succeed.
    await expect(runTier2Migration(pool)).resolves.not.toThrow();
  });
});

// ─── Schema validation ──────────────────────────────────────────────────────

describe("Zod schema validation", () => {
  it("AgentHourlySchema rejects invalid data", () => {
    expect(() =>
      AgentHourlySchema.parse({
        agent_name: "",
        hour_bucket: "not-a-date",
        action_count: -1,
      }),
    ).toThrow();
  });

  it("CostDailySchema rejects missing required fields", () => {
    expect(() =>
      CostDailySchema.parse({
        date: "2026-03-03",
        // missing agent_name and model
      }),
    ).toThrow();
  });

  it("QualityDailySchema validates trend enum", () => {
    const valid = QualityDailySchema.safeParse({
      date: "2026-03-03",
      agent_name: "test",
      metric_name: "accuracy",
      metric_value: 0.9,
      trend: "improving",
    });
    expect(valid.success).toBe(true);

    const invalid = QualityDailySchema.safeParse({
      date: "2026-03-03",
      agent_name: "test",
      metric_name: "accuracy",
      metric_value: 0.9,
      trend: "bad_trend",
    });
    expect(invalid.success).toBe(false);
  });

  it("AnomalySchema validates severity enum", () => {
    const valid = AnomalySchema.safeParse({
      detected_at: new Date(),
      agent_name: "test",
      anomaly_type: "test",
      severity: "critical",
      detection_method: "test",
      description: "test",
    });
    expect(valid.success).toBe(true);

    const invalid = AnomalySchema.safeParse({
      detected_at: new Date(),
      agent_name: "test",
      anomaly_type: "test",
      severity: "extreme",
      detection_method: "test",
      description: "test",
    });
    expect(invalid.success).toBe(false);
  });
});
