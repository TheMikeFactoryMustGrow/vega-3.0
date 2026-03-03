import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { createPool, runTier2Migration, dropTier2Tables } from "./database.js";
import { Tier2Repository } from "./tier2-repository.js";
import { TelemetryEmitter } from "./emitter.js";
import { SelfAssessmentRunner } from "./self-assessment-runner.js";
import type { SelfAssessmentConfig } from "./self-assessment-types.js";

const TEST_DB_URL =
  process.env.VEGA_TEST_PG_URL ?? "postgres://localhost/vega_test";

let pool: pg.Pool;
let repo: Tier2Repository;
let emitter: TelemetryEmitter;
let tempDir: string;

beforeAll(async () => {
  pool = createPool(TEST_DB_URL);
  await dropTier2Tables(pool);
  await runTier2Migration(pool);
  repo = new Tier2Repository(pool);
  tempDir = await mkdtemp(path.join(tmpdir(), "vega-self-assessment-"));
  emitter = new TelemetryEmitter(tempDir);
});

afterAll(async () => {
  await dropTier2Tables(pool);
  await pool.end();
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query("DELETE FROM telemetry_anomalies");
  await pool.query("DELETE FROM telemetry_quality_daily");
  await pool.query("DELETE FROM telemetry_cost_daily");
  await pool.query("DELETE FROM telemetry_agent_hourly");
});

// ─── Test: self_assessment triggers when quality_daily p50_value < 0.8 ──────

describe("SelfAssessmentRunner — metric_value condition", () => {
  it("updates reasoning_prompt_injection when p50_value < 0.8", async () => {
    const targetDate = new Date("2026-03-02");

    // Insert quality data with low p50_value
    await repo.upsertQualityDaily({
      date: targetDate,
      agent_name: "knowledge_agent",
      metric_name: "success_rate",
      metric_value: 0.72,
      trend: "declining",
      p50_value: 0.72,
      p95_value: 0.85,
      sample_count: 50,
    });

    const config: SelfAssessmentConfig = {
      frequency: "every 10 actions",
      metrics_query: `SELECT * FROM telemetry_quality_daily
                       WHERE agent_name = 'knowledge_agent'`,
      adjustment_rules: [
        {
          name: "low_quality_boost",
          condition: {
            type: "metric_value",
            field: "p50_value",
            operator: "<",
            value: 0.8,
          },
          action: {
            type: "update_prompt",
            new_prompt:
              "PRIORITY: Quality has dropped below acceptable threshold (p50 < 0.8). " +
              "Before each action, verify inputs are complete and validate outputs against known patterns. " +
              "Prefer accuracy over speed.",
          },
        },
      ],
      reasoning_prompt_injection: "Standard operating mode. Balance speed and accuracy.",
    };

    const runner = new SelfAssessmentRunner(pool, emitter, { emitTelemetry: false });
    const { result, updatedConfig } = await runner.run("knowledge_agent", config);

    // Rule should have triggered
    expect(result.rules_evaluated).toBe(1);
    expect(result.rules_triggered).toBe(1);
    expect(result.rules_overridden).toBe(0);
    expect(result.adjustments[0].triggered).toBe(true);
    expect(result.adjustments[0].condition_met).toBe(true);
    expect(result.adjustments[0].before_prompt).toBe(
      "Standard operating mode. Balance speed and accuracy.",
    );
    expect(result.adjustments[0].after_prompt).toContain("Quality has dropped");

    // Updated config should have new prompt
    expect(updatedConfig.reasoning_prompt_injection).toContain("Quality has dropped");
    expect(result.final_prompt).toContain("Quality has dropped");
  });

  it("does NOT update when p50_value >= 0.8", async () => {
    const targetDate = new Date("2026-03-02");

    await repo.upsertQualityDaily({
      date: targetDate,
      agent_name: "knowledge_agent",
      metric_name: "success_rate",
      metric_value: 0.92,
      trend: "stable",
      p50_value: 0.92,
      p95_value: 0.98,
      sample_count: 50,
    });

    const config: SelfAssessmentConfig = {
      frequency: "every 10 actions",
      metrics_query: `SELECT * FROM telemetry_quality_daily
                       WHERE agent_name = 'knowledge_agent'
`,
      adjustment_rules: [
        {
          name: "low_quality_boost",
          condition: {
            type: "metric_value",
            field: "p50_value",
            operator: "<",
            value: 0.8,
          },
          action: {
            type: "update_prompt",
            new_prompt: "Quality boost prompt.",
          },
        },
      ],
      reasoning_prompt_injection: "Standard operating mode.",
    };

    const runner = new SelfAssessmentRunner(pool, emitter, { emitTelemetry: false });
    const { result, updatedConfig } = await runner.run("knowledge_agent", config);

    expect(result.rules_triggered).toBe(0);
    expect(result.adjustments[0].triggered).toBe(false);
    expect(result.adjustments[0].condition_met).toBe(false);
    expect(updatedConfig.reasoning_prompt_injection).toBe("Standard operating mode.");
  });
});

// ─── Test: adjustment logged to telemetry with before/after values ──────────

describe("SelfAssessmentRunner — telemetry logging", () => {
  it("logs adjustment to Tier 1 telemetry with before/after values", async () => {
    const targetDate = new Date("2026-03-02");

    await repo.upsertQualityDaily({
      date: targetDate,
      agent_name: "knowledge_agent",
      metric_name: "success_rate",
      metric_value: 0.65,
      trend: "declining",
      p50_value: 0.65,
      p95_value: 0.78,
      sample_count: 40,
    });

    const config: SelfAssessmentConfig = {
      frequency: "every 10 actions",
      metrics_query: `SELECT * FROM telemetry_quality_daily
                       WHERE agent_name = 'knowledge_agent'
`,
      adjustment_rules: [
        {
          name: "critical_quality_alert",
          condition: {
            type: "metric_value",
            field: "p50_value",
            operator: "<",
            value: 0.7,
          },
          action: {
            type: "update_prompt",
            new_prompt:
              "CRITICAL: Quality is severely degraded. Double-check all outputs.",
          },
        },
      ],
      reasoning_prompt_injection: "Normal mode.",
    };

    // Enable telemetry emission for this test
    const runner = new SelfAssessmentRunner(pool, emitter, { emitTelemetry: true });
    await runner.run("knowledge_agent", config);

    // Read telemetry events
    const events = await emitter.readEvents(new Date());
    const assessmentEvents = events.filter(
      (e) => e.event_type === "system_event" && e.event_subtype === "self_assessment",
    );

    expect(assessmentEvents.length).toBe(1);
    const event = assessmentEvents[0];
    expect(event.agent_name).toBe("knowledge_agent");
    expect(event.outcome).toBe("success");

    // Check metadata contains before/after values
    const meta = event.metadata as Record<string, unknown>;
    expect(meta.before_prompt).toBe("Normal mode.");
    expect(meta.after_prompt).toBe(
      "CRITICAL: Quality is severely degraded. Double-check all outputs.",
    );
    expect(meta.rules_triggered).toEqual(["critical_quality_alert"]);
    expect(Array.isArray(meta.adjustments)).toBe(true);
    const adj = (meta.adjustments as Array<Record<string, string>>)[0];
    expect(adj.before).toBe("Normal mode.");
    expect(adj.after).toBe(
      "CRITICAL: Quality is severely degraded. Double-check all outputs.",
    );
  });

  it("does NOT emit telemetry when no rules are triggered", async () => {
    const targetDate = new Date("2026-03-02");

    await repo.upsertQualityDaily({
      date: targetDate,
      agent_name: "knowledge_agent",
      metric_name: "success_rate",
      metric_value: 0.95,
      trend: "improving",
      p50_value: 0.95,
      p95_value: 0.99,
      sample_count: 50,
    });

    const config: SelfAssessmentConfig = {
      frequency: "every 10 actions",
      metrics_query: `SELECT * FROM telemetry_quality_daily
                       WHERE agent_name = 'knowledge_agent'
`,
      adjustment_rules: [
        {
          name: "quality_check",
          condition: {
            type: "metric_value",
            field: "p50_value",
            operator: "<",
            value: 0.8,
          },
          action: {
            type: "update_prompt",
            new_prompt: "Should not appear.",
          },
        },
      ],
      reasoning_prompt_injection: "Normal mode.",
    };

    const runner = new SelfAssessmentRunner(pool, emitter, { emitTelemetry: true });
    await runner.run("knowledge_agent", config);

    // Read all events from today — there should be no self_assessment events
    const events = await emitter.readEvents(new Date());
    const assessmentEvents = events.filter(
      (e) => e.event_type === "system_event" && e.event_subtype === "self_assessment",
    );
    // Only count new events (the previous test may have emitted one)
    // Instead, check that no event was emitted for this specific agent with all-pass outcome
    // The runner only emits when triggeredRules.length > 0
    expect(assessmentEvents.every((e) => {
      const meta = e.metadata as Record<string, unknown>;
      return Array.isArray(meta.rules_triggered) && (meta.rules_triggered as string[]).length > 0;
    })).toBe(true);
  });
});

// ─── Test: trend condition ──────────────────────────────────────────────────

describe("SelfAssessmentRunner — trend condition", () => {
  it("triggers when trend is declining", async () => {
    const targetDate = new Date("2026-03-02");

    await repo.upsertQualityDaily({
      date: targetDate,
      agent_name: "knowledge_agent",
      metric_name: "success_rate",
      metric_value: 0.85,
      trend: "declining",
      p50_value: 0.85,
      p95_value: 0.92,
      sample_count: 50,
    });

    const config: SelfAssessmentConfig = {
      frequency: "every 10 actions",
      metrics_query: `SELECT * FROM telemetry_quality_daily
                       WHERE agent_name = 'knowledge_agent'
`,
      adjustment_rules: [
        {
          name: "declining_trend_alert",
          condition: {
            type: "trend",
            field: "trend",
            equals: "declining",
          },
          action: {
            type: "update_prompt",
            new_prompt:
              "NOTICE: Performance trend is declining. Increase validation steps.",
          },
        },
      ],
      reasoning_prompt_injection: "Standard mode.",
    };

    const runner = new SelfAssessmentRunner(pool, emitter, { emitTelemetry: false });
    const { result } = await runner.run("knowledge_agent", config);

    expect(result.rules_triggered).toBe(1);
    expect(result.final_prompt).toContain("declining");
  });

  it("does NOT trigger when trend does not match", async () => {
    const targetDate = new Date("2026-03-02");

    await repo.upsertQualityDaily({
      date: targetDate,
      agent_name: "knowledge_agent",
      metric_name: "success_rate",
      metric_value: 0.95,
      trend: "improving",
      p50_value: 0.95,
      p95_value: 0.99,
      sample_count: 50,
    });

    const config: SelfAssessmentConfig = {
      frequency: "every 10 actions",
      metrics_query: `SELECT * FROM telemetry_quality_daily
                       WHERE agent_name = 'knowledge_agent'
`,
      adjustment_rules: [
        {
          name: "declining_alert",
          condition: {
            type: "trend",
            field: "trend",
            equals: "declining",
          },
          action: {
            type: "update_prompt",
            new_prompt: "Declining prompt.",
          },
        },
      ],
      reasoning_prompt_injection: "Standard mode.",
    };

    const runner = new SelfAssessmentRunner(pool, emitter, { emitTelemetry: false });
    const { result } = await runner.run("knowledge_agent", config);

    expect(result.rules_triggered).toBe(0);
    expect(result.final_prompt).toBe("Standard mode.");
  });
});

// ─── Test: threshold condition ──────────────────────────────────────────────

describe("SelfAssessmentRunner — threshold condition", () => {
  it("triggers when value exceeds max threshold", async () => {
    const targetDate = new Date("2026-03-02");

    await repo.upsertQualityDaily({
      date: targetDate,
      agent_name: "knowledge_agent",
      metric_name: "avg_latency_ms",
      metric_value: 2500,
      trend: "declining",
      p50_value: 2000,
      p95_value: 5000,
      sample_count: 30,
    });

    const config: SelfAssessmentConfig = {
      frequency: "every 10 actions",
      metrics_query: `SELECT * FROM telemetry_quality_daily
                       WHERE agent_name = 'knowledge_agent'
`,
      adjustment_rules: [
        {
          name: "high_latency_alert",
          condition: {
            type: "threshold",
            field: "metric_value",
            max: 1000,
          },
          action: {
            type: "update_prompt",
            new_prompt: "ALERT: High latency detected. Simplify reasoning chains.",
          },
        },
      ],
      reasoning_prompt_injection: "Normal mode.",
    };

    const runner = new SelfAssessmentRunner(pool, emitter, { emitTelemetry: false });
    const { result } = await runner.run("knowledge_agent", config);

    expect(result.rules_triggered).toBe(1);
    expect(result.final_prompt).toContain("High latency");
  });
});

// ─── Test: Bar Raiser override ──────────────────────────────────────────────

describe("SelfAssessmentRunner — Bar Raiser override", () => {
  it("skips a triggered rule when overridden by Bar Raiser", async () => {
    const targetDate = new Date("2026-03-02");

    await repo.upsertQualityDaily({
      date: targetDate,
      agent_name: "knowledge_agent",
      metric_name: "success_rate",
      metric_value: 0.6,
      trend: "declining",
      p50_value: 0.6,
      p95_value: 0.75,
      sample_count: 40,
    });

    const config: SelfAssessmentConfig = {
      frequency: "every 10 actions",
      metrics_query: `SELECT * FROM telemetry_quality_daily
                       WHERE agent_name = 'knowledge_agent'
`,
      adjustment_rules: [
        {
          name: "quality_adjustment",
          condition: {
            type: "metric_value",
            field: "p50_value",
            operator: "<",
            value: 0.8,
          },
          action: {
            type: "update_prompt",
            new_prompt: "Override test prompt.",
          },
        },
      ],
      reasoning_prompt_injection: "Original prompt.",
    };

    const runner = new SelfAssessmentRunner(pool, emitter, { emitTelemetry: false });

    // Bar Raiser overrides this rule
    runner.addOverride("knowledge_agent", "quality_adjustment");

    const { result, updatedConfig } = await runner.run("knowledge_agent", config);

    // Condition IS met, but rule is overridden → not triggered
    expect(result.rules_triggered).toBe(0);
    expect(result.rules_overridden).toBe(1);
    expect(result.adjustments[0].condition_met).toBe(true);
    expect(result.adjustments[0].overridden).toBe(true);
    expect(result.adjustments[0].triggered).toBe(false);
    expect(updatedConfig.reasoning_prompt_injection).toBe("Original prompt.");
  });

  it("allows rule to fire after override is removed", async () => {
    const targetDate = new Date("2026-03-02");

    await repo.upsertQualityDaily({
      date: targetDate,
      agent_name: "knowledge_agent",
      metric_name: "success_rate",
      metric_value: 0.6,
      trend: "declining",
      p50_value: 0.6,
      p95_value: 0.75,
      sample_count: 40,
    });

    const config: SelfAssessmentConfig = {
      frequency: "every 10 actions",
      metrics_query: `SELECT * FROM telemetry_quality_daily
                       WHERE agent_name = 'knowledge_agent'
`,
      adjustment_rules: [
        {
          name: "quality_check",
          condition: {
            type: "metric_value",
            field: "p50_value",
            operator: "<",
            value: 0.8,
          },
          action: {
            type: "update_prompt",
            new_prompt: "Post-override prompt.",
          },
        },
      ],
      reasoning_prompt_injection: "Original.",
    };

    const runner = new SelfAssessmentRunner(pool, emitter, { emitTelemetry: false });

    // Override, then remove
    runner.addOverride("knowledge_agent", "quality_check");
    runner.removeOverride("knowledge_agent", "quality_check");

    const { result } = await runner.run("knowledge_agent", config);

    expect(result.rules_triggered).toBe(1);
    expect(result.final_prompt).toBe("Post-override prompt.");
  });
});

// ─── Test: multiple rules, only some trigger ────────────────────────────────

describe("SelfAssessmentRunner — multiple rules", () => {
  it("evaluates all rules and triggers only matching ones", async () => {
    const targetDate = new Date("2026-03-02");

    await repo.upsertQualityDaily({
      date: targetDate,
      agent_name: "knowledge_agent",
      metric_name: "success_rate",
      metric_value: 0.75,
      trend: "declining",
      p50_value: 0.75,
      p95_value: 0.88,
      sample_count: 50,
    });

    const config: SelfAssessmentConfig = {
      frequency: "every 10 actions",
      metrics_query: `SELECT * FROM telemetry_quality_daily
                       WHERE agent_name = 'knowledge_agent'
`,
      adjustment_rules: [
        {
          name: "good_quality_reward",
          condition: {
            type: "metric_value",
            field: "p50_value",
            operator: ">",
            value: 0.9,
          },
          action: {
            type: "update_prompt",
            new_prompt: "Great quality! Maintain current approach.",
          },
        },
        {
          name: "declining_trend_check",
          condition: {
            type: "trend",
            field: "trend",
            equals: "declining",
          },
          action: {
            type: "update_prompt",
            new_prompt: "Performance is declining. Increase validation.",
          },
        },
      ],
      reasoning_prompt_injection: "Default prompt.",
    };

    const runner = new SelfAssessmentRunner(pool, emitter, { emitTelemetry: false });
    const { result } = await runner.run("knowledge_agent", config);

    expect(result.rules_evaluated).toBe(2);
    expect(result.rules_triggered).toBe(1);

    // First rule (good_quality_reward) should NOT trigger (0.75 is not > 0.9)
    expect(result.adjustments[0].triggered).toBe(false);

    // Second rule (declining_trend_check) SHOULD trigger
    expect(result.adjustments[1].triggered).toBe(true);

    // Final prompt should be from the last triggered rule
    expect(result.final_prompt).toContain("declining");
  });
});

// ─── Test: empty query results ──────────────────────────────────────────────

describe("SelfAssessmentRunner — empty query results", () => {
  it("does not trigger any rules when no data is available", async () => {
    const config: SelfAssessmentConfig = {
      frequency: "every 10 actions",
      metrics_query: `SELECT * FROM telemetry_quality_daily
                       WHERE agent_name = 'nonexistent_agent'`,
      adjustment_rules: [
        {
          name: "always_check",
          condition: {
            type: "metric_value",
            field: "p50_value",
            operator: "<",
            value: 999,
          },
          action: {
            type: "update_prompt",
            new_prompt: "Should not trigger.",
          },
        },
      ],
      reasoning_prompt_injection: "Default.",
    };

    const runner = new SelfAssessmentRunner(pool, emitter, { emitTelemetry: false });
    const { result } = await runner.run("nonexistent_agent", config);

    expect(result.metrics_query_rows).toBe(0);
    expect(result.rules_triggered).toBe(0);
    expect(result.final_prompt).toBe("Default.");
  });
});
