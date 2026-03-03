import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { TelemetryEmitter } from "./emitter.js";
import { Tier2Repository } from "./tier2-repository.js";
import { PatternMiner } from "./pattern-miner.js";
import { runTier2Migration, dropTier2Tables } from "./database.js";

const { Pool } = pg;

describe("PatternMiner", () => {
  let pool: pg.Pool;
  let tmpDir: string;
  let emitter: TelemetryEmitter;
  let repo: Tier2Repository;

  beforeAll(async () => {
    pool = new Pool({
      connectionString:
        process.env.VEGA_TEST_PG_URL ?? "postgres://localhost/vega_test",
    });
    await dropTier2Tables(pool);
    await runTier2Migration(pool);
    tmpDir = await mkdtemp(path.join(tmpdir(), "pattern-miner-"));
    emitter = new TelemetryEmitter(tmpDir);
    repo = new Tier2Repository(pool);
  });

  afterAll(async () => {
    await dropTier2Tables(pool);
    await pool.end();
    await rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM telemetry_anomalies");
    await pool.query("DELETE FROM telemetry_agent_hourly");
    await pool.query("DELETE FROM telemetry_quality_daily");
    await pool.query("DELETE FROM telemetry_cost_daily");
    await pool.query("DELETE FROM telemetry_bets");
  });

  // ─── Activation Flag ─────────────────────────────────────────────────────

  it("returns null when activation flag is disabled (default)", async () => {
    const miner = new PatternMiner(pool, emitter, undefined, tmpDir, {
      emitTelemetry: false,
    });

    const result = await miner.runMining(
      ["agent_a", "agent_b"],
      new Date("2026-03-03T00:00:00Z"),
    );

    expect(result).toBeNull();
  });

  it("returns null when activation flag is explicitly disabled", async () => {
    const miner = new PatternMiner(
      pool,
      emitter,
      { enabled: false },
      tmpDir,
      { emitTelemetry: false },
    );

    const result = await miner.runMining(
      ["agent_a", "agent_b"],
      new Date("2026-03-03T00:00:00Z"),
    );

    expect(result).toBeNull();
  });

  // ─── Demand Clustering Detection ──────────────────────────────────────────

  it("detects demand clustering: agents frequently invoked in the same hour", async () => {
    const miner = new PatternMiner(
      pool,
      emitter,
      {
        enabled: true,
        demand_clustering_min_occurrences: 5,
        lookback_days: 30,
      },
      tmpDir,
      { emitTelemetry: false },
    );

    const now = new Date("2026-03-03T00:00:00Z");

    // Create a pattern: Agent A → Agent B → Agent C appear together 12 times
    // over 30 days (same hour bucket)
    for (let d = 0; d < 12; d++) {
      const hourBucket = new Date(now);
      hourBucket.setUTCDate(hourBucket.getUTCDate() - (d * 2 + 1));
      hourBucket.setUTCHours(10, 0, 0, 0); // All at 10:00 UTC

      // All three agents active in the same hour
      for (const agentName of ["agent_a", "agent_b", "agent_c"]) {
        await repo.upsertAgentHourly({
          agent_name: agentName,
          hour_bucket: hourBucket,
          action_count: 20,
          success_count: 18,
          error_count: 2,
          avg_latency_ms: 500,
          p95_latency_ms: 1000,
          p99_latency_ms: 1500,
          reasoning_steps_avg: 3,
          model_distribution: { "grok-4": 20 },
          tokens_in_total: 10000,
          tokens_out_total: 5000,
          cost_usd_total: 0.1,
          performance_score: 0.85,
        });
      }
    }

    const report = await miner.runMining(
      ["agent_a", "agent_b", "agent_c"],
      now,
    );

    expect(report).not.toBeNull();
    expect(report!.activation_flag).toBe(true);

    // Should detect demand clustering between agent pairs
    const clusteringPatterns = report!.detected_patterns.filter(
      (p) => p.type === "demand_clustering",
    );
    expect(clusteringPatterns.length).toBeGreaterThanOrEqual(1);

    // At least one pair should have ≥12 co-occurrences (above 5 threshold)
    const highFreq = clusteringPatterns.find((p) => p.frequency >= 12);
    expect(highFreq).toBeDefined();
    expect(highFreq!.agents.length).toBe(2);
    expect(highFreq!.evidence).toContain("same hour bucket");
    expect(highFreq!.evidence).toContain("12 times");
    expect(highFreq!.suggested_action).toContain("co-scheduling");
  });

  // ─── Report Structure ─────────────────────────────────────────────────────

  it("generates a complete report with all required sections", async () => {
    const miner = new PatternMiner(
      pool,
      emitter,
      {
        enabled: true,
        demand_clustering_min_occurrences: 5,
        lookback_days: 30,
      },
      tmpDir,
      { emitTelemetry: false },
    );

    const now = new Date("2026-03-03T00:00:00Z");

    const report = await miner.runMining(["agent_a", "agent_b"], now);

    expect(report).not.toBeNull();
    expect(report!.date).toEqual(now);
    expect(report!.agents_analyzed).toEqual(["agent_a", "agent_b"]);
    expect(report!.activation_flag).toBe(true);

    // Verify markdown has all required sections
    const md = report!.markdown;
    expect(md).toContain("# Cross-Agent Pattern Mining Report");
    expect(md).toContain("## Detected Patterns");
    expect(md).toContain("## Proactive Artifact Candidates");
    expect(md).toContain("## No-Action Patterns");
    expect(md).toContain("read-only");
    expect(md).toContain("Mike");
    expect(md).toContain("Bar Raiser");

    // Report should be written to filesystem
    const reportDir = path.join(tmpDir, "pattern-mining");
    const files = await readdir(reportDir);
    expect(files).toContain("2026-03-03.md");

    const fileContent = await readFile(
      path.join(reportDir, "2026-03-03.md"),
      "utf-8",
    );
    expect(fileContent).toBe(md);
  });

  // ─── Drift Correlation Detection ──────────────────────────────────────────

  it("detects drift correlation: correlated metric changes across agents", async () => {
    const miner = new PatternMiner(
      pool,
      emitter,
      {
        enabled: true,
        drift_correlation_min_coefficient: 0.7,
        lookback_days: 30,
      },
      tmpDir,
      { emitTelemetry: false },
    );

    const now = new Date("2026-03-03T00:00:00Z");

    // Create correlated metric data: both agents' success_rate rises together
    for (let d = 0; d < 10; d++) {
      const date = new Date(now);
      date.setUTCDate(date.getUTCDate() - (10 - d));

      // Agent A: success_rate increases linearly
      await repo.upsertQualityDaily({
        date,
        agent_name: "agent_a",
        metric_name: "success_rate",
        metric_value: 0.70 + d * 0.02, // 0.70 → 0.88
        trend: d > 0 ? "improving" : "stable",
        p50_value: 0.70 + d * 0.02,
        p95_value: 0.75 + d * 0.02,
        sample_count: 100,
      });

      // Agent B: success_rate also increases linearly (correlated)
      await repo.upsertQualityDaily({
        date,
        agent_name: "agent_b",
        metric_name: "success_rate",
        metric_value: 0.65 + d * 0.025, // 0.65 → 0.875
        trend: d > 0 ? "improving" : "stable",
        p50_value: 0.65 + d * 0.025,
        p95_value: 0.70 + d * 0.025,
        sample_count: 100,
      });
    }

    const report = await miner.runMining(["agent_a", "agent_b"], now);

    expect(report).not.toBeNull();

    const driftPatterns = report!.detected_patterns.filter(
      (p) => p.type === "drift_correlation",
    );
    expect(driftPatterns.length).toBe(1);
    expect(driftPatterns[0].agents).toContain("agent_a");
    expect(driftPatterns[0].agents).toContain("agent_b");
    expect(driftPatterns[0].evidence).toContain("positive correlation");
    expect(driftPatterns[0].evidence).toContain("success_rate");
    expect(driftPatterns[0].confidence).toBeGreaterThanOrEqual(0.7);
  });

  // ─── Resource Contention Detection ────────────────────────────────────────

  it("detects resource contention: overlapping high-activity periods", async () => {
    const miner = new PatternMiner(
      pool,
      emitter,
      {
        enabled: true,
        resource_contention_min_overlaps: 5,
        lookback_days: 30,
      },
      tmpDir,
      { emitTelemetry: false },
    );

    const now = new Date("2026-03-03T00:00:00Z");

    // Create overlapping high-activity hours for two agents
    for (let d = 0; d < 15; d++) {
      const hourBucket = new Date(now);
      hourBucket.setUTCDate(hourBucket.getUTCDate() - (d + 1));
      hourBucket.setUTCHours(14, 0, 0, 0); // Both active at 14:00

      for (const agentName of ["agent_x", "agent_y"]) {
        await repo.upsertAgentHourly({
          agent_name: agentName,
          hour_bucket: hourBucket,
          action_count: 50,
          success_count: 45,
          error_count: 5,
          avg_latency_ms: 800,
          p95_latency_ms: 1500,
          p99_latency_ms: 2000,
          reasoning_steps_avg: 4,
          model_distribution: { "grok-4": 50 },
          tokens_in_total: 25000,
          tokens_out_total: 12000,
          cost_usd_total: 0.25,
          performance_score: 0.82,
        });
      }
    }

    const report = await miner.runMining(["agent_x", "agent_y"], now);

    expect(report).not.toBeNull();

    const contentionPatterns = report!.detected_patterns.filter(
      (p) => p.type === "resource_contention",
    );
    expect(contentionPatterns.length).toBe(1);
    expect(contentionPatterns[0].agents).toContain("agent_x");
    expect(contentionPatterns[0].agents).toContain("agent_y");
    expect(contentionPatterns[0].evidence).toContain("overlapping high-activity");
    expect(contentionPatterns[0].frequency).toBeGreaterThanOrEqual(5);
  });

  // ─── Proactive Artifact Generation ────────────────────────────────────────

  it("generates proactive artifact candidates for high-confidence patterns", async () => {
    const miner = new PatternMiner(
      pool,
      emitter,
      {
        enabled: true,
        demand_clustering_min_occurrences: 3,
        lookback_days: 30,
      },
      tmpDir,
      { emitTelemetry: false },
    );

    const now = new Date("2026-03-03T00:00:00Z");

    // Create many co-occurrences to get high confidence
    for (let d = 0; d < 20; d++) {
      const hourBucket = new Date(now);
      hourBucket.setUTCDate(hourBucket.getUTCDate() - (d + 1));
      hourBucket.setUTCHours(10, 0, 0, 0);

      for (const agentName of ["agent_p", "agent_q"]) {
        await repo.upsertAgentHourly({
          agent_name: agentName,
          hour_bucket: hourBucket,
          action_count: 30,
          success_count: 28,
          error_count: 2,
          avg_latency_ms: 400,
          p95_latency_ms: 800,
          p99_latency_ms: 1200,
          reasoning_steps_avg: 3,
          model_distribution: { "grok-4": 30 },
          tokens_in_total: 15000,
          tokens_out_total: 7000,
          cost_usd_total: 0.15,
          performance_score: 0.9,
        });
      }
    }

    const report = await miner.runMining(["agent_p", "agent_q"], now);

    expect(report).not.toBeNull();

    // Should have high-confidence clustering pattern
    const clusteringPatterns = report!.detected_patterns.filter(
      (p) => p.type === "demand_clustering",
    );
    expect(clusteringPatterns.length).toBeGreaterThanOrEqual(1);

    // High-confidence patterns should generate artifact candidates
    const highConfidence = clusteringPatterns.filter(
      (p) => p.confidence >= 0.7,
    );
    if (highConfidence.length > 0) {
      expect(report!.proactive_artifact_candidates.length).toBeGreaterThanOrEqual(1);
      const artifact = report!.proactive_artifact_candidates[0];
      expect(artifact.requires_mike_approval).toBe(true);
      expect(artifact.source_pattern).toBe("demand_clustering");
      expect(artifact.agents_involved).toContain("agent_p");
      expect(artifact.agents_involved).toContain("agent_q");
    }
  });

  // ─── No-Action and Empty Report ───────────────────────────────────────────

  it("identifies no-action patterns when no data exists", async () => {
    const miner = new PatternMiner(
      pool,
      emitter,
      {
        enabled: true,
        lookback_days: 30,
      },
      tmpDir,
      { emitTelemetry: false },
    );

    const report = await miner.runMining(
      ["agent_a", "agent_b"],
      new Date("2026-03-03T00:00:00Z"),
    );

    expect(report).not.toBeNull();
    expect(report!.detected_patterns).toEqual([]);
    expect(report!.no_action_patterns.length).toBeGreaterThanOrEqual(1);
    expect(report!.no_action_patterns[0]).toContain("No cross-agent patterns");
    expect(report!.proactive_artifact_candidates).toEqual([]);
  });

  // ─── Complementary Gap Detection ──────────────────────────────────────────

  it("detects complementary gap: producer-consumer token patterns", async () => {
    const miner = new PatternMiner(
      pool,
      emitter,
      {
        enabled: true,
        complementary_gap_min_correlation: 0.6,
        lookback_days: 30,
      },
      tmpDir,
      { emitTelemetry: false },
    );

    const now = new Date("2026-03-03T00:00:00Z");

    // Agent "producer" has high output-to-input ratio
    for (let d = 0; d < 10; d++) {
      const date = new Date(now);
      date.setUTCDate(date.getUTCDate() - (d + 1));

      await repo.upsertCostDaily({
        date,
        agent_name: "producer",
        model: "grok-4",
        total_tokens_in: 5000,
        total_tokens_out: 20000, // 4:1 output-to-input ratio
        total_cost_usd: 0.5,
        avg_cost_per_action: 0.05,
        cost_per_mtok: 15.0,
        invocations: 10,
      });
    }

    // Agent "consumer" has high input-to-output ratio
    for (let d = 0; d < 10; d++) {
      const date = new Date(now);
      date.setUTCDate(date.getUTCDate() - (d + 1));

      await repo.upsertCostDaily({
        date,
        agent_name: "consumer",
        model: "grok-4",
        total_tokens_in: 20000, // 4:1 input-to-output ratio
        total_tokens_out: 5000,
        total_cost_usd: 0.3,
        avg_cost_per_action: 0.03,
        cost_per_mtok: 15.0,
        invocations: 10,
      });
    }

    const report = await miner.runMining(["producer", "consumer"], now);

    expect(report).not.toBeNull();

    const gapPatterns = report!.detected_patterns.filter(
      (p) => p.type === "complementary_gap",
    );
    expect(gapPatterns.length).toBeGreaterThanOrEqual(1);

    const pattern = gapPatterns.find(
      (p) => p.agents.includes("producer") && p.agents.includes("consumer"),
    );
    expect(pattern).toBeDefined();
    expect(pattern!.evidence).toContain("output-to-input ratio");
    expect(pattern!.suggested_action).toContain("pipeline");
  });
});
