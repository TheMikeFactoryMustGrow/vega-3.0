import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { createPool, runTier2Migration, dropTier2Tables } from "./database.js";
import { Tier2Repository } from "./tier2-repository.js";
import { TelemetryEmitter } from "./emitter.js";
import { WeeklyReflectionGenerator } from "./weekly-reflection.js";

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
  tempDir = await mkdtemp(path.join(tmpdir(), "vega-reflection-"));
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

// ─── Test: generate weekly reflection with 7 days of telemetry data ────────

describe("WeeklyReflectionGenerator — single agent reflection", () => {
  it("generates a reflection with all required sections for Knowledge Agent", async () => {
    const weekEnd = new Date("2026-03-01"); // Sunday
    const weekStart = new Date("2026-02-22"); // Previous Sunday

    // Populate 7 days of hourly data for knowledge_agent
    for (let day = 0; day < 7; day++) {
      const date = new Date(weekStart);
      date.setUTCDate(date.getUTCDate() + day);

      // Insert hourly data (one hour per day for simplicity)
      await repo.upsertAgentHourly({
        agent_name: "knowledge_agent",
        hour_bucket: date,
        action_count: 10 + day, // varying action counts
        success_count: 8 + day,
        error_count: 2,
        avg_latency_ms: 500 + day * 50,
        p95_latency_ms: 1200 + day * 100,
        p99_latency_ms: 2000,
        reasoning_steps_avg: 3.5,
        model_distribution: { "grok-4-1-fast-reasoning": 10 + day },
        tokens_in_total: 5000,
        tokens_out_total: 2000,
        cost_usd_total: 0.035,
        performance_score: 0.75 + day * 0.02,
      });

      // Insert quality daily data with improving trends
      await repo.upsertQualityDaily({
        date,
        agent_name: "knowledge_agent",
        metric_name: "success_rate",
        metric_value: 0.8 + day * 0.02,
        trend: day >= 3 ? "improving" : "stable",
        p50_value: 0.8 + day * 0.02,
        p95_value: 0.95,
        sample_count: 10 + day,
      });

      await repo.upsertQualityDaily({
        date,
        agent_name: "knowledge_agent",
        metric_name: "avg_latency_ms",
        metric_value: 500 + day * 50,
        trend: "stable",
        p50_value: 400,
        p95_value: 1200,
        sample_count: 10,
      });
    }

    const generator = new WeeklyReflectionGenerator(pool, emitter, tempDir, {
      emitTelemetry: false,
    });
    const reflection = await generator.generateReflection(
      "knowledge_agent",
      weekEnd,
    );

    // Verify all required sections present
    expect(reflection.agent_name).toBe("knowledge_agent");
    expect(reflection.week_start).toEqual(weekStart);
    expect(reflection.week_end).toEqual(weekEnd);

    // Summary
    expect(reflection.summary.total_actions).toBeGreaterThan(0);
    expect(reflection.summary.success_rate).toBeGreaterThan(0);
    expect(reflection.summary.error_count).toBeGreaterThanOrEqual(0);

    // Reflection sections — all non-empty
    expect(reflection.reflection.what_worked_well.length).toBeGreaterThan(0);
    expect(reflection.reflection.what_didnt_work.length).toBeGreaterThan(0);
    expect(reflection.reflection.patterns_noticed.length).toBeGreaterThan(0);
    expect(reflection.reflection.proposed_adjustments.length).toBeGreaterThan(0);
    expect(reflection.reflection.questions_for_bar_raiser.length).toBeGreaterThan(0);

    // Markdown contains all section headers
    expect(reflection.markdown).toContain("# Weekly Reflection: knowledge_agent");
    expect(reflection.markdown).toContain("## Week Summary");
    expect(reflection.markdown).toContain("## What Worked Well");
    expect(reflection.markdown).toContain("## What Didn't Work");
    expect(reflection.markdown).toContain("## Patterns Noticed");
    expect(reflection.markdown).toContain("## Proposed Adjustments");
    expect(reflection.markdown).toContain("## Questions for Bar Raiser");

    // Verify reflection file was written
    const filePath = path.join(
      tempDir,
      "reflections",
      "knowledge_agent",
      "2026-03-01.md",
    );
    expect(existsSync(filePath)).toBe(true);
    const fileContent = await readFile(filePath, "utf-8");
    expect(fileContent).toBe(reflection.markdown);
  });

  it("handles agent with no telemetry data gracefully", async () => {
    const weekEnd = new Date("2026-03-01");

    const generator = new WeeklyReflectionGenerator(pool, emitter, tempDir, {
      emitTelemetry: false,
    });
    const reflection = await generator.generateReflection(
      "empty_agent",
      weekEnd,
    );

    expect(reflection.summary.total_actions).toBe(0);
    expect(reflection.summary.success_rate).toBe(0);
    expect(reflection.reflection.what_worked_well.length).toBeGreaterThan(0);
    expect(reflection.markdown).toContain("# Weekly Reflection: empty_agent");
  });
});

// ─── Test: Bar Raiser synthesis with cross-agent pattern detection ──────────

describe("WeeklyReflectionGenerator — Bar Raiser synthesis", () => {
  it("identifies at least one cross-agent pattern across 3 agents", async () => {
    const weekEnd = new Date("2026-03-01");
    const weekStart = new Date("2026-02-22");

    // Agent 1: knowledge_agent — good performance, improving
    for (let day = 0; day < 7; day++) {
      const date = new Date(weekStart);
      date.setUTCDate(date.getUTCDate() + day);

      await repo.upsertAgentHourly({
        agent_name: "knowledge_agent",
        hour_bucket: date,
        action_count: 20,
        success_count: 19,
        error_count: 1,
        avg_latency_ms: 300,
        p95_latency_ms: 800,
        p99_latency_ms: 1500,
        reasoning_steps_avg: 3,
        model_distribution: { "grok-4-1-fast-reasoning": 20 },
        tokens_in_total: 10000,
        tokens_out_total: 5000,
        cost_usd_total: 0.075,
        performance_score: 0.92,
      });

      await repo.upsertQualityDaily({
        date,
        agent_name: "knowledge_agent",
        metric_name: "success_rate",
        metric_value: 0.95,
        trend: "improving",
        p50_value: 0.95,
        p95_value: 0.99,
        sample_count: 20,
      });
    }

    // Agent 2: research_agent — also improving (shared improvement pattern)
    for (let day = 0; day < 7; day++) {
      const date = new Date(weekStart);
      date.setUTCDate(date.getUTCDate() + day);

      await repo.upsertAgentHourly({
        agent_name: "research_agent",
        hour_bucket: date,
        action_count: 15,
        success_count: 14,
        error_count: 1,
        avg_latency_ms: 450,
        p95_latency_ms: 900,
        p99_latency_ms: 1800,
        reasoning_steps_avg: 4,
        model_distribution: { "grok-4-1-fast-reasoning": 15 },
        tokens_in_total: 8000,
        tokens_out_total: 4000,
        cost_usd_total: 0.06,
        performance_score: 0.88,
      });

      await repo.upsertQualityDaily({
        date,
        agent_name: "research_agent",
        metric_name: "success_rate",
        metric_value: 0.93,
        trend: "improving",
        p50_value: 0.93,
        p95_value: 0.98,
        sample_count: 15,
      });
    }

    // Agent 3: integration_agent — poor performance (complementary pattern)
    for (let day = 0; day < 7; day++) {
      const date = new Date(weekStart);
      date.setUTCDate(date.getUTCDate() + day);

      await repo.upsertAgentHourly({
        agent_name: "integration_agent",
        hour_bucket: date,
        action_count: 10,
        success_count: 5,
        error_count: 5,
        avg_latency_ms: 2000,
        p95_latency_ms: 5000,
        p99_latency_ms: 8000,
        reasoning_steps_avg: 5,
        model_distribution: { "grok-4-1-fast-reasoning": 10 },
        tokens_in_total: 6000,
        tokens_out_total: 3000,
        cost_usd_total: 0.045,
        performance_score: 0.41,
      });

      await repo.upsertQualityDaily({
        date,
        agent_name: "integration_agent",
        metric_name: "success_rate",
        metric_value: 0.5,
        trend: "declining",
        p50_value: 0.5,
        p95_value: 0.6,
        sample_count: 10,
      });
    }

    const generator = new WeeklyReflectionGenerator(pool, emitter, tempDir, {
      emitTelemetry: false,
    });
    const synthesis = await generator.generateSynthesis(
      ["knowledge_agent", "research_agent", "integration_agent"],
      weekEnd,
    );

    // Verify synthesis structure
    expect(synthesis.agents_included).toEqual([
      "knowledge_agent",
      "research_agent",
      "integration_agent",
    ]);
    expect(synthesis.week_start).toEqual(weekStart);
    expect(synthesis.week_end).toEqual(weekEnd);

    // Verify at least one cross-agent pattern detected
    const allPatterns = [
      ...synthesis.cross_agent_patterns,
      ...synthesis.contradictions,
    ];
    expect(allPatterns.length).toBeGreaterThan(0);

    // Specifically: shared_improvement should be detected (knowledge + research both improving)
    const sharedImprovement = synthesis.cross_agent_patterns.filter(
      (p) => p.pattern_type === "shared_improvement",
    );
    expect(sharedImprovement.length).toBeGreaterThan(0);
    expect(sharedImprovement[0].agents_involved).toContain("knowledge_agent");
    expect(sharedImprovement[0].agents_involved).toContain("research_agent");

    // Complementary pattern: knowledge_agent excelling, integration_agent struggling
    const complementary = synthesis.cross_agent_patterns.filter(
      (p) => p.pattern_type === "complementary",
    );
    expect(complementary.length).toBeGreaterThan(0);

    // Verify markdown contains all required sections
    expect(synthesis.markdown).toContain("# Bar Raiser Weekly Synthesis");
    expect(synthesis.markdown).toContain("## Overall System Health");
    expect(synthesis.markdown).toContain("## Agent Summaries");
    expect(synthesis.markdown).toContain("## Cross-Agent Patterns");
    expect(synthesis.markdown).toContain("## Contradictions");
    expect(synthesis.markdown).toContain("## Recommendations");

    // Verify recommendations exist
    expect(synthesis.recommendations.length).toBeGreaterThan(0);

    // Verify synthesis file was written
    const synthesisPath = path.join(
      tempDir,
      "reflections",
      "bar_raiser",
      "synthesis_2026-03-01.md",
    );
    expect(existsSync(synthesisPath)).toBe(true);
  });

  it("detects contradiction when agent claims positive but metrics are declining", async () => {
    const weekEnd = new Date("2026-03-01");
    const weekStart = new Date("2026-02-22");

    // Agent with high success rate (claims positive) but declining quality trends
    for (let day = 0; day < 7; day++) {
      const date = new Date(weekStart);
      date.setUTCDate(date.getUTCDate() + day);

      await repo.upsertAgentHourly({
        agent_name: "contradicted_agent",
        hour_bucket: date,
        action_count: 20,
        success_count: 19, // 95% success — triggers "High success rate" positive claim
        error_count: 1,
        avg_latency_ms: 300,
        p95_latency_ms: 800,
        p99_latency_ms: 1500,
        reasoning_steps_avg: 3,
        model_distribution: { "grok-4-1-fast-reasoning": 20 },
        tokens_in_total: 10000,
        tokens_out_total: 5000,
        cost_usd_total: 0.075,
        performance_score: 0.9,
      });

      // Quality daily shows DECLINING trends on most days (contradicts positive self-assessment)
      await repo.upsertQualityDaily({
        date,
        agent_name: "contradicted_agent",
        metric_name: "success_rate",
        metric_value: 0.95 - day * 0.03, // gradually declining
        trend: "declining",
        p50_value: 0.95 - day * 0.03,
        p95_value: 0.99,
        sample_count: 20,
      });
    }

    // Second agent needed for synthesis
    for (let day = 0; day < 7; day++) {
      const date = new Date(weekStart);
      date.setUTCDate(date.getUTCDate() + day);

      await repo.upsertAgentHourly({
        agent_name: "baseline_agent",
        hour_bucket: date,
        action_count: 5,
        success_count: 4,
        error_count: 1,
        avg_latency_ms: 300,
        p95_latency_ms: 600,
        p99_latency_ms: 1000,
        reasoning_steps_avg: 2,
        model_distribution: { "qwen3:32b": 5 },
        tokens_in_total: 2000,
        tokens_out_total: 800,
        cost_usd_total: 0,
        performance_score: 0.78,
      });
    }

    const generator = new WeeklyReflectionGenerator(pool, emitter, tempDir, {
      emitTelemetry: false,
    });

    const synthesis = await generator.generateSynthesis(
      ["contradicted_agent", "baseline_agent"],
      weekEnd,
    );

    // Verify contradiction is detected: agent claims positive but metrics show declining
    const contradictions = synthesis.contradictions.filter(
      (c) =>
        c.agents_involved.includes("contradicted_agent") &&
        c.description.includes("declining"),
    );
    expect(contradictions.length).toBe(1);
    expect(contradictions[0].severity).toBe("warning");
    expect(contradictions[0].pattern_type).toBe("contradiction");
  });
});
