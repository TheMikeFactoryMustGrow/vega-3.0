import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { createPool, runTier2Migration, dropTier2Tables } from "./database.js";
import { Tier2Repository } from "./tier2-repository.js";
import { MorningBriefHealth } from "./morning-brief-health.js";

const TEST_DB_URL =
  process.env.VEGA_TEST_PG_URL ?? "postgres://localhost/vega_test";

let pool: pg.Pool;
let repo: Tier2Repository;
let brief: MorningBriefHealth;

beforeAll(async () => {
  pool = createPool(TEST_DB_URL);
  await dropTier2Tables(pool);
  await runTier2Migration(pool);
  repo = new Tier2Repository(pool);
  brief = new MorningBriefHealth(pool);
});

afterAll(async () => {
  await dropTier2Tables(pool);
  await pool.end();
});

beforeEach(async () => {
  // Clean all table data between tests
  await pool.query("DELETE FROM telemetry_anomalies");
  await pool.query("DELETE FROM telemetry_quality_daily");
  await pool.query("DELETE FROM telemetry_cost_daily");
  await pool.query("DELETE FROM telemetry_agent_hourly");
});

// ─── Test: empty tables → graceful fallback ─────────────────────────────────

describe("MorningBriefHealth — empty tables", () => {
  it("displays graceful fallback when Tier 2 tables are empty", async () => {
    const targetDate = new Date("2026-03-02T00:00:00Z");
    const result = await brief.generate(targetDate);

    expect(result.data_available).toBe(false);
    expect(result.markdown).toContain("System Health");
    expect(result.markdown).toContain(
      "Telemetry data collecting — system health available tomorrow",
    );
    expect(result.generated_at).toBeInstanceOf(Date);
  });
});

// ─── Test: populated tables → all 6 subsections ────────────────────────────

describe("MorningBriefHealth — populated tables", () => {
  const targetDate = new Date("2026-03-02T00:00:00Z");
  const prevDate = new Date("2026-03-01T00:00:00Z");

  beforeEach(async () => {
    // ── Day 1 (previous day: 2026-03-01) data ──
    // Agent hourly for previous day (needed for day-over-day delta)
    await repo.upsertAgentHourly({
      agent_name: "knowledge_agent",
      hour_bucket: new Date("2026-03-01T10:00:00Z"),
      action_count: 30,
      success_count: 28,
      error_count: 2,
      avg_latency_ms: 400,
      p95_latency_ms: 900,
      p99_latency_ms: 1200,
      reasoning_steps_avg: 3.0,
      model_distribution: { "grok-4-1-fast-reasoning": 20, "qwen3:32b": 10 },
      tokens_in_total: 30000,
      tokens_out_total: 12000,
      cost_usd_total: 0.3,
      performance_score: 0.85,
    });

    await repo.upsertAgentHourly({
      agent_name: "bar_raiser",
      hour_bucket: new Date("2026-03-01T10:00:00Z"),
      action_count: 10,
      success_count: 10,
      error_count: 0,
      avg_latency_ms: 200,
      p95_latency_ms: 400,
      p99_latency_ms: 600,
      reasoning_steps_avg: 2.0,
      model_distribution: { "grok-4-1-fast-reasoning": 10 },
      tokens_in_total: 10000,
      tokens_out_total: 5000,
      cost_usd_total: 0.1,
      performance_score: 0.95,
    });

    // Quality daily for previous day (needed for trend arrows)
    await repo.upsertQualityDaily({
      date: prevDate,
      agent_name: "knowledge_agent",
      metric_name: "success_rate",
      metric_value: 0.93,
      trend: "stable",
      p50_value: 0.93,
      p95_value: 0.97,
      sample_count: 30,
    });

    await repo.upsertQualityDaily({
      date: prevDate,
      agent_name: "knowledge_agent",
      metric_name: "avg_latency_ms",
      metric_value: 400,
      trend: "stable",
      p50_value: 350,
      p95_value: 900,
      sample_count: 30,
    });

    // ── Day 2 (target day: 2026-03-02) data ──
    // Agent hourly — knowledge_agent
    await repo.upsertAgentHourly({
      agent_name: "knowledge_agent",
      hour_bucket: new Date("2026-03-02T08:00:00Z"),
      action_count: 25,
      success_count: 23,
      error_count: 2,
      avg_latency_ms: 350,
      p95_latency_ms: 800,
      p99_latency_ms: 1100,
      reasoning_steps_avg: 3.5,
      model_distribution: { "grok-4-1-fast-reasoning": 15, "qwen3:32b": 10 },
      tokens_in_total: 25000,
      tokens_out_total: 10000,
      cost_usd_total: 0.25,
      performance_score: 0.88,
    });

    await repo.upsertAgentHourly({
      agent_name: "knowledge_agent",
      hour_bucket: new Date("2026-03-02T14:00:00Z"),
      action_count: 20,
      success_count: 19,
      error_count: 1,
      avg_latency_ms: 300,
      p95_latency_ms: 700,
      p99_latency_ms: 950,
      reasoning_steps_avg: 3.2,
      model_distribution: { "grok-4-1-fast-reasoning": 12, "qwen3:32b": 8 },
      tokens_in_total: 20000,
      tokens_out_total: 8000,
      cost_usd_total: 0.2,
      performance_score: 0.9,
    });

    // Agent hourly — bar_raiser
    await repo.upsertAgentHourly({
      agent_name: "bar_raiser",
      hour_bucket: new Date("2026-03-02T09:00:00Z"),
      action_count: 15,
      success_count: 15,
      error_count: 0,
      avg_latency_ms: 180,
      p95_latency_ms: 350,
      p99_latency_ms: 500,
      reasoning_steps_avg: 2.0,
      model_distribution: { "grok-4-1-fast-reasoning": 15 },
      tokens_in_total: 15000,
      tokens_out_total: 7000,
      cost_usd_total: 0.15,
      performance_score: 0.96,
    });

    // Cost daily — target day
    await repo.upsertCostDaily({
      date: targetDate,
      agent_name: "knowledge_agent",
      model: "grok-4-1-fast-reasoning",
      total_tokens_in: 45000,
      total_tokens_out: 18000,
      total_cost_usd: 0.405,
      avg_cost_per_action: 0.009,
      cost_per_mtok: 6.43,
      invocations: 45,
    });

    await repo.upsertCostDaily({
      date: targetDate,
      agent_name: "bar_raiser",
      model: "grok-4-1-fast-reasoning",
      total_tokens_in: 15000,
      total_tokens_out: 7000,
      total_cost_usd: 0.15,
      avg_cost_per_action: 0.01,
      cost_per_mtok: 6.82,
      invocations: 15,
    });

    // Quality daily — target day
    await repo.upsertQualityDaily({
      date: targetDate,
      agent_name: "knowledge_agent",
      metric_name: "success_rate",
      metric_value: 0.93,
      trend: "stable",
      p50_value: 0.93,
      p95_value: 0.97,
      sample_count: 45,
    });

    await repo.upsertQualityDaily({
      date: targetDate,
      agent_name: "knowledge_agent",
      metric_name: "avg_latency_ms",
      metric_value: 325,
      trend: "improving",
      p50_value: 300,
      p95_value: 800,
      sample_count: 45,
    });

    await repo.upsertQualityDaily({
      date: targetDate,
      agent_name: "bar_raiser",
      metric_name: "success_rate",
      metric_value: 1.0,
      trend: "stable",
      p50_value: 1.0,
      p95_value: 1.0,
      sample_count: 15,
    });

    // Anomalies — one unresolved warning, one unresolved critical
    await repo.insertAnomaly({
      detected_at: new Date("2026-03-02T02:15:00Z"),
      agent_name: "knowledge_agent",
      anomaly_type: "latency_spike",
      severity: "warning",
      detection_method: "daily_aggregation_2sigma",
      description: "p95 latency 2.5x above rolling average",
      anomaly_details: { sigma: 2.5 },
      metric_name: "p95_latency_ms",
      expected_value: 500,
      actual_value: 1250,
      threshold_value: 1000,
      acknowledged_at: null,
      resolved_at: null,
    });

    await repo.insertAnomaly({
      detected_at: new Date("2026-03-02T02:15:00Z"),
      agent_name: "vega_core",
      anomaly_type: "error_rate_spike",
      severity: "critical",
      detection_method: "daily_aggregation_2sigma",
      description: "Error rate exceeded threshold",
      anomaly_details: { error_rate: 0.12 },
      metric_name: "error_rate",
      expected_value: 0.02,
      actual_value: 0.12,
      threshold_value: 0.05,
      acknowledged_at: null,
      resolved_at: null,
    });
  });

  it("generates all 6 subsections with correct values", async () => {
    const result = await brief.generate(targetDate);

    expect(result.data_available).toBe(true);
    expect(result.generated_at).toBeInstanceOf(Date);

    const md = result.markdown;

    // 1. System Health header
    expect(md).toContain("### System Health");

    // 2. Active Agents — both agents present with 24h action counts
    expect(md).toContain("**Active Agents (24h)**");
    expect(md).toContain("knowledge_agent: 45 actions");
    expect(md).toContain("bar_raiser: 15 actions");

    // 3. Total Actions — with day-over-day delta
    expect(md).toContain("**Total Actions**");
    expect(md).toContain("Total: 60");
    // Previous day had 40 actions (30+10), today has 60 → +50% increase
    expect(md).toContain("↑ +50.0%");

    // 4. Estimated Cost
    expect(md).toContain("**Estimated Cost**");
    expect(md).toContain("knowledge_agent");
    expect(md).toContain("bar_raiser");
    expect(md).toContain("Daily Total:");

    // 5. Quality Scores — with trend arrows
    expect(md).toContain("**Quality Scores**");
    expect(md).toContain("success_rate");
    // stable trend → →
    expect(md).toMatch(/success_rate.*→/);
    // avg_latency_ms improving → ↑
    expect(md).toMatch(/avg_latency_ms.*↑/);

    // 6. Anomalies — unresolved with severity breakdown
    expect(md).toContain("**Anomalies**");
    expect(md).toContain("2 unresolved anomalies");
    expect(md).toContain("critical");
    expect(md).toContain("warning");

    // 7. Top Performers — ranked by performance_score
    expect(md).toContain("**Top Performers**");
    // bar_raiser (0.96) should be ranked above knowledge_agent (avg of 0.88 and 0.90 = 0.89)
    expect(md).toMatch(/1\.\s*bar_raiser/);
    expect(md).toMatch(/2\.\s*knowledge_agent/);
  });

  it("produces valid markdown renderable in Obsidian", async () => {
    const result = await brief.generate(targetDate);
    const md = result.markdown;

    // Must start with heading
    expect(md.startsWith("### System Health")).toBe(true);

    // No unclosed bold markers (** must come in pairs)
    const boldCount = (md.match(/\*\*/g) ?? []).length;
    expect(boldCount % 2).toBe(0);

    // All list items must use standard markdown syntax
    const listItems = md
      .split("\n")
      .filter((line) => line.trim().startsWith("-") || /^\d+\./.test(line.trim()));
    expect(listItems.length).toBeGreaterThan(0);
  });
});
