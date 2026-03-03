import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createPool, runTier2Migration, dropTier2Tables } from "./database.js";
import { Tier2Repository } from "./tier2-repository.js";
import { TelemetryEmitter } from "./emitter.js";
import {
  runHourlyAggregation,
  runDailyAggregation,
  backfillHourly,
  backfillDaily,
} from "./aggregation.js";

const TEST_DB_URL =
  process.env.VEGA_TEST_PG_URL ?? "postgres://localhost/vega_test";

let pool: pg.Pool;
let repo: Tier2Repository;
let tmpDir: string;
let emitter: TelemetryEmitter;

beforeAll(async () => {
  pool = createPool(TEST_DB_URL);
  await dropTier2Tables(pool);
  await runTier2Migration(pool);
  repo = new Tier2Repository(pool);
});

afterAll(async () => {
  await dropTier2Tables(pool);
  await pool.end();
});

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "vega-agg-test-"));
  emitter = new TelemetryEmitter(tmpDir);
  // Clean Tier 2 tables between tests
  await pool.query("DELETE FROM telemetry_anomalies");
  await pool.query("DELETE FROM telemetry_quality_daily");
  await pool.query("DELETE FROM telemetry_cost_daily");
  await pool.query("DELETE FROM telemetry_agent_hourly");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── Hourly Aggregation ─────────────────────────────────────────────────────

describe("Hourly Aggregation", () => {
  it("emit 50 events across 3 agents → run hourly → verify 3 rows with correct counts", async () => {
    const hourBucket = new Date("2026-03-03T10:00:00Z");
    const hourEnd = new Date("2026-03-03T11:00:00Z");

    // 20 for knowledge_agent (18 success, 2 failure)
    const events = [];
    for (let i = 0; i < 20; i++) {
      events.push({
        agent_name: "knowledge_agent",
        event_type: "agent_action" as const,
        event_subtype: "neo4j_write",
        session_id: "s1",
        model_used: "grok-4-1-fast-reasoning",
        tokens_in: 100,
        tokens_out: 50,
        latency_ms: 200 + i * 10,
        outcome: (i < 18 ? "success" : "failure") as "success" | "failure",
        timestamp: new Date(hourBucket.getTime() + i * 60000).toISOString(),
      });
    }
    // 20 for vega_core (all success)
    for (let i = 0; i < 20; i++) {
      events.push({
        agent_name: "vega_core",
        event_type: "model_call" as const,
        event_subtype: "frontier_call",
        session_id: "s1",
        model_used: "grok-4-1-fast-reasoning",
        tokens_in: 500,
        tokens_out: 200,
        latency_ms: 1000 + i * 50,
        outcome: "success" as const,
        timestamp: new Date(hourBucket.getTime() + i * 60000).toISOString(),
      });
    }
    // 10 for bar_raiser (9 success, 1 failure)
    for (let i = 0; i < 10; i++) {
      events.push({
        agent_name: "bar_raiser",
        event_type: "knowledge_query" as const,
        event_subtype: "aqm_query",
        session_id: "s1",
        model_used: "qwen3:32b",
        tokens_in: 200,
        tokens_out: 100,
        latency_ms: 500 + i * 20,
        outcome: (i < 9 ? "success" : "failure") as "success" | "failure",
        timestamp: new Date(hourBucket.getTime() + i * 60000).toISOString(),
      });
    }

    await emitter.emitBatch(events);

    const result = await runHourlyAggregation(emitter, repo, hourBucket, {
      emitTelemetry: false,
    });

    expect(result.agents_processed).toBe(3);
    expect(result.rows_upserted).toBe(3);

    // Verify knowledge_agent
    const kaRows = await repo.queryAgentHourly("knowledge_agent", hourBucket, hourEnd);
    expect(kaRows).toHaveLength(1);
    expect(kaRows[0].action_count).toBe(20);
    expect(kaRows[0].success_count).toBe(18);
    expect(kaRows[0].error_count).toBe(2);
    expect(kaRows[0].avg_latency_ms).toBeGreaterThan(0);
    expect(kaRows[0].p95_latency_ms).toBeGreaterThan(0);
    expect(kaRows[0].tokens_in_total).toBe(2000);
    expect(kaRows[0].tokens_out_total).toBe(1000);
    expect(kaRows[0].model_distribution).toEqual({ "grok-4-1-fast-reasoning": 20 });
    expect(kaRows[0].performance_score).toBeGreaterThan(0);
    expect(kaRows[0].performance_score).toBeLessThanOrEqual(1);

    // Verify vega_core
    const vcRows = await repo.queryAgentHourly("vega_core", hourBucket, hourEnd);
    expect(vcRows).toHaveLength(1);
    expect(vcRows[0].action_count).toBe(20);
    expect(vcRows[0].success_count).toBe(20);
    expect(vcRows[0].error_count).toBe(0);

    // Verify bar_raiser
    const brRows = await repo.queryAgentHourly("bar_raiser", hourBucket, hourEnd);
    expect(brRows).toHaveLength(1);
    expect(brRows[0].action_count).toBe(10);
    expect(brRows[0].success_count).toBe(9);
    expect(brRows[0].error_count).toBe(1);
  });

  it("is idempotent — running twice produces identical results, no duplicates", async () => {
    const hourBucket = new Date("2026-03-03T14:00:00Z");
    const hourEnd = new Date("2026-03-03T15:00:00Z");

    for (let i = 0; i < 5; i++) {
      await emitter.emit({
        agent_name: "test_agent",
        event_type: "agent_action",
        event_subtype: "test",
        session_id: "s1",
        latency_ms: 100 + i * 10,
        outcome: "success",
        timestamp: new Date(hourBucket.getTime() + i * 60000).toISOString(),
      });
    }

    // Run twice
    await runHourlyAggregation(emitter, repo, hourBucket, { emitTelemetry: false });
    await runHourlyAggregation(emitter, repo, hourBucket, { emitTelemetry: false });

    // Should have exactly 1 row
    const rows = await repo.queryAgentHourly("test_agent", hourBucket, hourEnd);
    expect(rows).toHaveLength(1);
    expect(rows[0].action_count).toBe(5);
  });

  it("computes p95 and p99 latency correctly", async () => {
    const hourBucket = new Date("2026-03-03T12:00:00Z");
    const hourEnd = new Date("2026-03-03T13:00:00Z");

    // Emit 20 events with known latencies
    for (let i = 0; i < 20; i++) {
      await emitter.emit({
        agent_name: "latency_test",
        event_type: "agent_action",
        event_subtype: "test",
        session_id: "s1",
        latency_ms: (i + 1) * 100, // 100, 200, ..., 2000
        outcome: "success",
        timestamp: new Date(hourBucket.getTime() + i * 60000).toISOString(),
      });
    }

    await runHourlyAggregation(emitter, repo, hourBucket, { emitTelemetry: false });

    const rows = await repo.queryAgentHourly("latency_test", hourBucket, hourEnd);
    expect(rows).toHaveLength(1);
    expect(rows[0].avg_latency_ms).toBeCloseTo(1050); // mean of 100..2000
    expect(rows[0].p95_latency_ms).toBeGreaterThan(1800);
    expect(rows[0].p99_latency_ms).toBeGreaterThan(1900);
  });

  it("handles empty hour gracefully", async () => {
    const hourBucket = new Date("2026-03-03T08:00:00Z");

    const result = await runHourlyAggregation(emitter, repo, hourBucket, {
      emitTelemetry: false,
    });

    expect(result.agents_processed).toBe(0);
    expect(result.rows_upserted).toBe(0);
  });
});

// ─── Daily Aggregation ──────────────────────────────────────────────────────

describe("Daily Aggregation", () => {
  it("run daily aggregation twice for same date → verify no duplicate rows", async () => {
    const date = new Date("2026-03-03T00:00:00Z");

    // Emit 10 events for one agent+model
    for (let i = 0; i < 10; i++) {
      await emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "model_call",
        event_subtype: "frontier_call",
        session_id: "s1",
        model_used: "grok-4-1-fast-reasoning",
        tokens_in: 1000,
        tokens_out: 500,
        latency_ms: 200 + i * 50,
        outcome: i < 8 ? "success" : "failure",
        timestamp: new Date(date.getTime() + i * 3600000).toISOString(),
      });
    }

    // Run twice
    await runDailyAggregation(emitter, repo, pool, date, { emitTelemetry: false });
    await runDailyAggregation(emitter, repo, pool, date, { emitTelemetry: false });

    // Verify cost_daily: 1 row (one agent+model combo)
    const costRows = await repo.queryCostDaily("knowledge_agent", date, date);
    expect(costRows).toHaveLength(1);
    expect(costRows[0].invocations).toBe(10);
    expect(costRows[0].total_tokens_in).toBe(10000);
    expect(costRows[0].total_tokens_out).toBe(5000);

    // Verify quality_daily: 3 metrics (success_rate, avg_latency_ms, error_rate)
    const qualityRows = await repo.queryQualityDaily("knowledge_agent", date, date);
    expect(qualityRows).toHaveLength(3);
    const metricNames = qualityRows.map((r) => r.metric_name).sort();
    expect(metricNames).toEqual(["avg_latency_ms", "error_rate", "success_rate"]);
  });

  it("computes correct quality metrics", async () => {
    const date = new Date("2026-03-03T00:00:00Z");

    // 10 events: 8 success, 2 failure, latencies 100..1000
    for (let i = 0; i < 10; i++) {
      await emitter.emit({
        agent_name: "test_agent",
        event_type: "agent_action",
        event_subtype: "test",
        session_id: "s1",
        latency_ms: 100 * (i + 1),
        outcome: i < 8 ? "success" : "failure",
        timestamp: new Date(date.getTime() + i * 60000).toISOString(),
      });
    }

    await runDailyAggregation(emitter, repo, pool, date, { emitTelemetry: false });

    const qualityRows = await repo.queryQualityDaily("test_agent", date, date);

    const successRate = qualityRows.find((r) => r.metric_name === "success_rate");
    expect(successRate).toBeDefined();
    expect(successRate!.metric_value).toBeCloseTo(0.8);
    expect(successRate!.sample_count).toBe(10);

    const errorRate = qualityRows.find((r) => r.metric_name === "error_rate");
    expect(errorRate).toBeDefined();
    expect(errorRate!.metric_value).toBeCloseTo(0.2);

    const latency = qualityRows.find((r) => r.metric_name === "avg_latency_ms");
    expect(latency).toBeDefined();
    expect(latency!.metric_value).toBeCloseTo(550); // mean of 100..1000
    expect(latency!.p50_value).toBeGreaterThan(0);
    expect(latency!.p95_value).toBeGreaterThan(0);
  });

  it("computes cost_daily correctly per agent per model", async () => {
    const date = new Date("2026-03-03T00:00:00Z");

    // Emit events with different models for the same agent
    for (let i = 0; i < 5; i++) {
      await emitter.emit({
        agent_name: "multi_model_agent",
        event_type: "model_call",
        event_subtype: "call",
        session_id: "s1",
        model_used: "grok-4-1-fast-reasoning",
        tokens_in: 1000,
        tokens_out: 500,
        outcome: "success",
        timestamp: new Date(date.getTime() + i * 60000).toISOString(),
      });
    }
    for (let i = 0; i < 3; i++) {
      await emitter.emit({
        agent_name: "multi_model_agent",
        event_type: "model_call",
        event_subtype: "local_call",
        session_id: "s1",
        model_used: "qwen3:32b",
        tokens_in: 2000,
        tokens_out: 1000,
        outcome: "success",
        timestamp: new Date(date.getTime() + (i + 5) * 60000).toISOString(),
      });
    }

    await runDailyAggregation(emitter, repo, pool, date, { emitTelemetry: false });

    // Should have 2 cost rows (one per model)
    const costRows = await repo.queryCostDaily("multi_model_agent", date, date);
    expect(costRows).toHaveLength(2);

    const grokRow = costRows.find((r) => r.model === "grok-4-1-fast-reasoning");
    expect(grokRow).toBeDefined();
    expect(grokRow!.invocations).toBe(5);
    expect(grokRow!.total_tokens_in).toBe(5000);
    expect(grokRow!.total_cost_usd).toBeGreaterThan(0);

    const qwenRow = costRows.find((r) => r.model === "qwen3:32b");
    expect(qwenRow).toBeDefined();
    expect(qwenRow!.invocations).toBe(3);
    expect(qwenRow!.total_tokens_in).toBe(6000);
    expect(qwenRow!.total_cost_usd).toBe(0); // local model, free
  });

  it("handles empty day gracefully (no events)", async () => {
    const date = new Date("2026-03-03T00:00:00Z");

    const result = await runDailyAggregation(emitter, repo, pool, date, {
      emitTelemetry: false,
    });

    expect(result.agents_processed).toBe(0);
    expect(result.rows_upserted).toBe(0);
    expect(result.anomalies_detected).toBe(0);
  });
});

// ─── Anomaly Detection ──────────────────────────────────────────────────────

describe("Anomaly Detection", () => {
  it("detects error_count anomaly with >2σ deviation", async () => {
    // Set up 7 days of historical hourly data with low error counts (slight variance)
    const baseDate = new Date("2026-03-03T10:00:00Z");
    const historicalErrors = [1, 2, 0, 1, 2, 1, 0]; // mean ≈ 1, stddev ≈ 0.76
    for (let day = 1; day <= 7; day++) {
      const hourBucket = new Date(baseDate);
      hourBucket.setUTCDate(hourBucket.getUTCDate() - day);
      await repo.upsertAgentHourly({
        agent_name: "anomaly_test_agent",
        hour_bucket: hourBucket,
        action_count: 50,
        success_count: 50 - historicalErrors[day - 1],
        error_count: historicalErrors[day - 1],
        avg_latency_ms: 300,
        p95_latency_ms: 600,
        p99_latency_ms: 800,
        reasoning_steps_avg: null,
        model_distribution: { "grok-4": 50 },
        tokens_in_total: 5000,
        tokens_out_total: 2000,
        cost_usd_total: 0.1,
        performance_score: 0.95,
      });
    }

    // Now emit today's events with HIGH error count (anomalous)
    const today = new Date("2026-03-03T00:00:00Z");
    for (let i = 0; i < 20; i++) {
      await emitter.emit({
        agent_name: "anomaly_test_agent",
        event_type: "agent_action",
        event_subtype: "test",
        session_id: "s1",
        latency_ms: 300,
        outcome: i < 5 ? "success" : "failure", // 15 failures!
        timestamp: new Date(today.getTime() + i * 60000).toISOString(),
      });
    }

    const result = await runDailyAggregation(emitter, repo, pool, today, {
      emitTelemetry: false,
    });

    expect(result.anomalies_detected).toBeGreaterThan(0);

    // Verify the anomaly was recorded
    const anomalies = await repo.queryUnresolvedAnomalies();
    const errorAnomaly = anomalies.find(
      (a) => a.agent_name === "anomaly_test_agent" && a.anomaly_type === "error_count_deviation",
    );
    expect(errorAnomaly).toBeDefined();
    expect(errorAnomaly!.detection_method).toBe("daily_aggregation_2sigma");
    expect(errorAnomaly!.metric_name).toBe("error_count");
    expect(errorAnomaly!.actual_value).toBe(15);
  });

  it("does not flag anomaly when data is insufficient", async () => {
    // No historical data, so anomaly detection should be skipped
    const today = new Date("2026-03-03T00:00:00Z");
    for (let i = 0; i < 10; i++) {
      await emitter.emit({
        agent_name: "new_agent",
        event_type: "agent_action",
        event_subtype: "test",
        session_id: "s1",
        outcome: "failure",
        timestamp: new Date(today.getTime() + i * 60000).toISOString(),
      });
    }

    const result = await runDailyAggregation(emitter, repo, pool, today, {
      emitTelemetry: false,
    });

    expect(result.anomalies_detected).toBe(0);
  });
});

// ─── Telemetry Logging ──────────────────────────────────────────────────────

describe("Aggregation logs to Tier 1", () => {
  it("hourly aggregation emits system_event to JSONL", async () => {
    const hourBucket = new Date("2026-03-03T10:00:00Z");

    await emitter.emit({
      agent_name: "test_agent",
      event_type: "agent_action",
      event_subtype: "test",
      session_id: "s1",
      outcome: "success",
      timestamp: new Date(hourBucket.getTime() + 60000).toISOString(),
    });

    await runHourlyAggregation(emitter, repo, hourBucket, { emitTelemetry: true });

    // The aggregation log goes to today's JSONL (based on current time)
    // Check both today's file and the hourBucket file
    const todayEvents = await emitter.readEvents(new Date());
    const hbEvents = await emitter.readEvents(hourBucket);
    const allEvents = [...todayEvents, ...hbEvents];

    const aggEvent = allEvents.find(
      (e) =>
        e.event_type === "system_event" &&
        e.event_subtype === "aggregation_complete" &&
        (e.metadata as Record<string, unknown>)?.job_type === "hourly",
    );
    expect(aggEvent).toBeDefined();
    expect(aggEvent!.agent_name).toBe("system");
  });

  it("daily aggregation emits system_event to JSONL", async () => {
    const date = new Date("2026-03-03T00:00:00Z");

    await emitter.emit({
      agent_name: "test_agent",
      event_type: "agent_action",
      event_subtype: "test",
      session_id: "s1",
      outcome: "success",
      timestamp: new Date(date.getTime() + 60000).toISOString(),
    });

    await runDailyAggregation(emitter, repo, pool, date, { emitTelemetry: true });

    const todayEvents = await emitter.readEvents(new Date());
    const dateEvents = await emitter.readEvents(date);
    const allEvents = [...todayEvents, ...dateEvents];

    const aggEvent = allEvents.find(
      (e) =>
        e.event_type === "system_event" &&
        e.event_subtype === "aggregation_complete" &&
        (e.metadata as Record<string, unknown>)?.job_type === "daily",
    );
    expect(aggEvent).toBeDefined();
    expect(aggEvent!.agent_name).toBe("system");
  });
});

// ─── Backfill Mode ──────────────────────────────────────────────────────────

describe("Backfill mode", () => {
  it("backfills hourly for a range of hours", async () => {
    // Emit events in 2 different hours
    await emitter.emit({
      agent_name: "test_agent",
      event_type: "agent_action",
      event_subtype: "test",
      session_id: "s1",
      outcome: "success",
      latency_ms: 100,
      timestamp: "2026-03-03T10:30:00.000Z",
    });
    await emitter.emit({
      agent_name: "test_agent",
      event_type: "agent_action",
      event_subtype: "test",
      session_id: "s1",
      outcome: "success",
      latency_ms: 200,
      timestamp: "2026-03-03T11:30:00.000Z",
    });

    const results = await backfillHourly(
      emitter,
      repo,
      new Date("2026-03-03T10:00:00Z"),
      new Date("2026-03-03T12:00:00Z"),
      { emitTelemetry: false },
    );

    expect(results).toHaveLength(2);

    const rows10 = await repo.queryAgentHourly(
      "test_agent",
      new Date("2026-03-03T10:00:00Z"),
      new Date("2026-03-03T11:00:00Z"),
    );
    expect(rows10).toHaveLength(1);
    expect(rows10[0].action_count).toBe(1);

    const rows11 = await repo.queryAgentHourly(
      "test_agent",
      new Date("2026-03-03T11:00:00Z"),
      new Date("2026-03-03T12:00:00Z"),
    );
    expect(rows11).toHaveLength(1);
    expect(rows11[0].action_count).toBe(1);
  });

  it("backfills daily for a range of dates", async () => {
    // Emit events on 2 different days
    await emitter.emit({
      agent_name: "backfill_agent",
      event_type: "agent_action",
      event_subtype: "test",
      session_id: "s1",
      outcome: "success",
      timestamp: "2026-03-03T12:00:00.000Z",
    });
    await emitter.emit({
      agent_name: "backfill_agent",
      event_type: "agent_action",
      event_subtype: "test",
      session_id: "s1",
      outcome: "success",
      timestamp: "2026-03-04T12:00:00.000Z",
    });

    const results = await backfillDaily(
      emitter,
      repo,
      pool,
      new Date("2026-03-03"),
      new Date("2026-03-04"),
      { emitTelemetry: false },
    );

    expect(results).toHaveLength(2);

    // Verify day 1
    const quality03 = await repo.queryQualityDaily(
      "backfill_agent",
      new Date("2026-03-03"),
      new Date("2026-03-03"),
    );
    expect(quality03.length).toBeGreaterThan(0);

    // Verify day 2
    const quality04 = await repo.queryQualityDaily(
      "backfill_agent",
      new Date("2026-03-04"),
      new Date("2026-03-04"),
    );
    expect(quality04.length).toBeGreaterThan(0);
  });
});
