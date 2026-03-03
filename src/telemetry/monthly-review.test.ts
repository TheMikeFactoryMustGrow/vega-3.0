import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { createPool, runTier2Migration, dropTier2Tables } from "./database.js";
import { Tier2Repository } from "./tier2-repository.js";
import { TelemetryEmitter } from "./emitter.js";
import { MonthlyReviewGenerator } from "./monthly-review.js";

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
  tempDir = await mkdtemp(path.join(tmpdir(), "vega-monthly-review-"));
  emitter = new TelemetryEmitter(tempDir);
});

afterAll(async () => {
  await dropTier2Tables(pool);
  await pool.end();
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query("DELETE FROM telemetry_bets");
  await pool.query("DELETE FROM telemetry_anomalies");
  await pool.query("DELETE FROM telemetry_quality_daily");
  await pool.query("DELETE FROM telemetry_cost_daily");
  await pool.query("DELETE FROM telemetry_agent_hourly");
});

// ─── Helper: populate 4 weeks of data for an agent ──────────────────────────

async function populate4WeeksData(
  agentName: string,
  monthStart: Date,
  monthEnd: Date,
  opts: {
    successRate?: number;
    performanceScore?: number;
    trend?: "improving" | "stable" | "declining";
    anomalyCount?: number;
  } = {},
) {
  const {
    successRate = 0.85,
    performanceScore = 0.8,
    trend = "stable",
    anomalyCount = 0,
  } = opts;

  const dayCount = Math.floor(
    (monthEnd.getTime() - monthStart.getTime()) / 86400000,
  );

  for (let day = 0; day < dayCount; day++) {
    const date = new Date(monthStart);
    date.setUTCDate(date.getUTCDate() + day);

    const actionCount = 10;
    const successes = Math.round(actionCount * successRate);

    await repo.upsertAgentHourly({
      agent_name: agentName,
      hour_bucket: date,
      action_count: actionCount,
      success_count: successes,
      error_count: actionCount - successes,
      avg_latency_ms: 500,
      p95_latency_ms: 1200,
      p99_latency_ms: 2000,
      reasoning_steps_avg: 3.5,
      model_distribution: { "grok-4-1-fast-reasoning": actionCount },
      tokens_in_total: 5000,
      tokens_out_total: 2000,
      cost_usd_total: 0.035,
      performance_score: performanceScore + (trend === "improving" ? day * 0.005 : trend === "declining" ? -day * 0.005 : 0),
    });

    await repo.upsertQualityDaily({
      date,
      agent_name: agentName,
      metric_name: "success_rate",
      metric_value: successRate,
      trend,
      p50_value: successRate,
      p95_value: successRate + 0.05,
      sample_count: actionCount,
    });
  }

  // Insert anomalies if requested
  for (let i = 0; i < anomalyCount; i++) {
    const anomalyDate = new Date(monthStart);
    anomalyDate.setUTCDate(anomalyDate.getUTCDate() + i);
    await repo.insertAnomaly({
      detected_at: anomalyDate,
      agent_name: agentName,
      anomaly_type: "latency_spike",
      severity: "warning",
      detection_method: "statistical",
      description: `Latency spike detected for ${agentName}`,
      anomaly_details: { test: true },
      metric_name: "avg_latency_ms",
      expected_value: 500,
      actual_value: 2000,
      threshold_value: 1500,
      acknowledged_at: null,
      resolved_at: null,
    });
  }
}

// ─── Test 1: Monthly review with 4 weeks of reflection data ─────────────────

describe("MonthlyReviewGenerator — monthly review generation", () => {
  it("generates a monthly review with all required sections", async () => {
    const monthEnd = new Date("2026-03-01");
    const monthStart = new Date("2026-02-01");

    // Populate data for 3 agents across the month
    await populate4WeeksData("knowledge_agent", monthStart, monthEnd, {
      successRate: 0.92,
      performanceScore: 0.85,
      trend: "improving",
    });
    await populate4WeeksData("research_agent", monthStart, monthEnd, {
      successRate: 0.88,
      performanceScore: 0.78,
      trend: "stable",
    });
    await populate4WeeksData("integration_agent", monthStart, monthEnd, {
      successRate: 0.6,
      performanceScore: 0.55,
      trend: "declining",
      anomalyCount: 6,
    });

    // Write a mock Bar Raiser synthesis file
    const synthDir = path.join(tempDir, "reflections", "bar_raiser");
    await mkdir(synthDir, { recursive: true });
    await writeFile(
      path.join(synthDir, "synthesis_2026-02-15.md"),
      `# Bar Raiser Weekly Synthesis
## Recommendations
- Focus attention on integration_agent low performance
- Investigate shared improvement across knowledge and research agents
`,
      "utf-8",
    );

    const generator = new MonthlyReviewGenerator(pool, emitter, tempDir, {
      emitTelemetry: false,
    });
    const review = await generator.generateReview(
      ["knowledge_agent", "research_agent", "integration_agent"],
      monthEnd,
    );

    // Verify review structure
    expect(review.agents_included).toEqual([
      "knowledge_agent",
      "research_agent",
      "integration_agent",
    ]);
    expect(review.month_start).toEqual(monthStart);
    expect(review.month_end).toEqual(monthEnd);

    // Verify agent trends populated
    expect(review.agent_trends.length).toBe(3);
    const knowledgeTrend = review.agent_trends.find(
      (t) => t.agent_name === "knowledge_agent",
    );
    expect(knowledgeTrend).toBeDefined();
    expect(knowledgeTrend!.total_actions).toBeGreaterThan(0);
    expect(knowledgeTrend!.avg_success_rate).toBeGreaterThan(0.8);

    const integrationTrend = review.agent_trends.find(
      (t) => t.agent_name === "integration_agent",
    );
    expect(integrationTrend).toBeDefined();
    expect(integrationTrend!.anomaly_count).toBe(6);

    // Verify Bar Raiser observations were read
    expect(review.bar_raiser_observations.length).toBeGreaterThan(0);
    expect(
      review.bar_raiser_observations.some((o) =>
        o.includes("integration_agent"),
      ),
    ).toBe(true);

    // Verify proposals generated for declining agent
    expect(review.proposals.length).toBeGreaterThan(0);
    const integrationProposals = review.proposals.filter(
      (p) => p.agent_name === "integration_agent",
    );
    expect(integrationProposals.length).toBeGreaterThan(0);
    // Each proposal has all required fields
    for (const proposal of integrationProposals) {
      expect(proposal.hypothesis).toBeTruthy();
      expect(proposal.expected_outcome).toBeTruthy();
      expect(proposal.measurement_criteria).toBeTruthy();
      expect(proposal.rollback_trigger).toBeTruthy();
      expect(proposal.rationale).toBeTruthy();
    }

    // Verify markdown contains all required sections
    expect(review.markdown).toContain("# Monthly Structural Review");
    expect(review.markdown).toContain("## Agent Performance Trends");
    expect(review.markdown).toContain("## Bar Raiser Observations");
    expect(review.markdown).toContain("## Previous Bet Outcomes");
    expect(review.markdown).toContain("## Structural Proposals");
    expect(review.markdown).toContain("## Proposals Awaiting Review");

    // Verify review file was written
    const reviewPath = path.join(tempDir, "reviews", "2026-03.md");
    expect(existsSync(reviewPath)).toBe(true);
    const fileContent = await readFile(reviewPath, "utf-8");
    expect(fileContent).toBe(review.markdown);
  });

  it("generates review with empty Tier 2 tables gracefully", async () => {
    const monthEnd = new Date("2026-03-01");

    const generator = new MonthlyReviewGenerator(pool, emitter, tempDir, {
      emitTelemetry: false,
    });
    const review = await generator.generateReview(["empty_agent"], monthEnd);

    expect(review.agents_included).toEqual(["empty_agent"]);
    expect(review.agent_trends.length).toBe(1);
    expect(review.agent_trends[0].total_actions).toBe(0);
    expect(review.proposals.length).toBe(0);
    expect(review.markdown).toContain(
      "No structural changes proposed",
    );
  });
});

// ─── Test 2: Bet lifecycle — create, approve, assess outcome ─────────────────

describe("MonthlyReviewGenerator — Bet lifecycle", () => {
  it("creates a Bet node and populates actual_outcome after simulated 30 days", async () => {
    const generator = new MonthlyReviewGenerator(pool, emitter, tempDir, {
      emitTelemetry: false,
    });

    // Step 1: Create a Bet as pending_approval
    const bet = await generator.createBet({
      agent_name: "knowledge_agent",
      hypothesis:
        "Increasing reasoning depth will improve knowledge extraction quality",
      expected_outcome:
        "Quality score should improve by 10% within 30 days",
      measurement_criteria:
        "knowledge_agent avg quality_daily metric_value >= 0.9",
      rollback_trigger:
        "Latency increases by >50% or error rate exceeds 15%",
      actual_outcome: null,
      status: "pending_approval",
      created_date: new Date("2026-02-01"),
      review_date: null,
      source_review_month: "2026-02",
    });

    expect(bet.id).toBeTruthy();
    expect(bet.status).toBe("pending_approval");
    expect(bet.actual_outcome).toBeNull();

    // Step 2: Mike approves the bet
    const approvedBet = await generator.approveBet(bet.id);
    expect(approvedBet.status).toBe("active");

    // Step 3: Simulate 30 days of telemetry (good performance → should confirm)
    const monthStart = new Date("2026-02-01");
    const monthEnd = new Date("2026-03-01");
    await populate4WeeksData("knowledge_agent", monthStart, monthEnd, {
      successRate: 0.92,
      performanceScore: 0.85,
      trend: "improving",
    });

    // Step 4: Run monthly review which assesses active Bets
    const review = await generator.generateReview(
      ["knowledge_agent"],
      monthEnd,
    );

    // Step 5: Verify Bet outcome was assessed
    expect(review.bet_outcomes.length).toBe(1);
    expect(review.bet_outcomes[0].bet_id).toBe(bet.id);
    expect(review.bet_outcomes[0].actual_outcome).toBeTruthy();
    expect(review.bet_outcomes[0].new_status).toBe("confirmed");
    expect(review.bet_outcomes[0].evidence).toContain("validated");

    // Step 6: Verify Bet was updated in database
    const bets = await generator.queryBetsByStatus("confirmed");
    expect(bets.length).toBe(1);
    expect(bets[0].id).toBe(bet.id);
    expect(bets[0].actual_outcome).toBeTruthy();
    expect(bets[0].review_date).toBeTruthy();
  });

  it("transitions Bet to abandoned when performance is poor", async () => {
    const generator = new MonthlyReviewGenerator(pool, emitter, tempDir, {
      emitTelemetry: false,
    });

    // Create and approve bet
    const bet = await generator.createBet({
      agent_name: "struggling_agent",
      hypothesis: "New processing pipeline will reduce errors",
      expected_outcome: "Error count reduced by 50%",
      measurement_criteria: "struggling_agent error_rate < 0.1",
      rollback_trigger: "Success rate drops below 50%",
      actual_outcome: null,
      status: "pending_approval",
      created_date: new Date("2026-02-01"),
      review_date: null,
      source_review_month: "2026-02",
    });
    await generator.approveBet(bet.id);

    // Simulate poor performance data
    const monthStart = new Date("2026-02-01");
    const monthEnd = new Date("2026-03-01");
    await populate4WeeksData("struggling_agent", monthStart, monthEnd, {
      successRate: 0.45,
      performanceScore: 0.35,
      trend: "declining",
    });

    const review = await generator.generateReview(
      ["struggling_agent"],
      monthEnd,
    );

    expect(review.bet_outcomes.length).toBe(1);
    expect(review.bet_outcomes[0].new_status).toBe("abandoned");
    expect(review.bet_outcomes[0].evidence).toContain("rejected");

    // Verify in database
    const abandoned = await generator.queryBetsByStatus("abandoned");
    expect(abandoned.length).toBe(1);
  });

  it("transitions Bet to revised when performance is moderate", async () => {
    const generator = new MonthlyReviewGenerator(pool, emitter, tempDir, {
      emitTelemetry: false,
    });

    // Create and approve bet
    const bet = await generator.createBet({
      agent_name: "moderate_agent",
      hypothesis: "Tuning model parameters will improve throughput",
      expected_outcome: "Throughput increases by 20%",
      measurement_criteria: "moderate_agent action_count >= 200/day",
      rollback_trigger: "Quality score drops below 0.6",
      actual_outcome: null,
      status: "pending_approval",
      created_date: new Date("2026-02-01"),
      review_date: null,
      source_review_month: "2026-02",
    });
    await generator.approveBet(bet.id);

    // Simulate moderate performance
    const monthStart = new Date("2026-02-01");
    const monthEnd = new Date("2026-03-01");
    await populate4WeeksData("moderate_agent", monthStart, monthEnd, {
      successRate: 0.75,
      performanceScore: 0.65,
      trend: "stable",
    });

    const review = await generator.generateReview(
      ["moderate_agent"],
      monthEnd,
    );

    expect(review.bet_outcomes.length).toBe(1);
    expect(review.bet_outcomes[0].new_status).toBe("revised");
    expect(review.bet_outcomes[0].evidence).toContain("Partially validated");
  });

  it("stores proposals as pending_approval Bets and queries by month", async () => {
    const monthEnd = new Date("2026-03-01");
    const monthStart = new Date("2026-02-01");

    // Create declining agent to trigger proposals
    await populate4WeeksData("declining_agent", monthStart, monthEnd, {
      successRate: 0.55,
      performanceScore: 0.4,
      trend: "declining",
      anomalyCount: 7,
    });

    const generator = new MonthlyReviewGenerator(pool, emitter, tempDir, {
      emitTelemetry: false,
    });
    await generator.generateReview(["declining_agent"], monthEnd);

    // Verify bets were stored as pending_approval
    const pendingBets = await generator.queryBetsByStatus("pending_approval");
    expect(pendingBets.length).toBeGreaterThan(0);

    // All bets should be for declining_agent and source month 2026-03
    for (const bet of pendingBets) {
      expect(bet.agent_name).toBe("declining_agent");
      expect(bet.source_review_month).toBe("2026-03");
      expect(bet.status).toBe("pending_approval");
    }

    // Query by month
    const monthBets = await generator.queryBetsByMonth("2026-03");
    expect(monthBets.length).toBe(pendingBets.length);
  });

  it("only Mike can approve — pending_approval bets are not assessed", async () => {
    const generator = new MonthlyReviewGenerator(pool, emitter, tempDir, {
      emitTelemetry: false,
    });

    // Create bet but DON'T approve it
    await generator.createBet({
      agent_name: "unapproved_agent",
      hypothesis: "Test hypothesis",
      expected_outcome: "Test outcome",
      measurement_criteria: "Test criteria",
      rollback_trigger: "Test trigger",
      actual_outcome: null,
      status: "pending_approval",
      created_date: new Date("2026-02-01"),
      review_date: null,
      source_review_month: "2026-02",
    });

    // Populate data
    const monthStart = new Date("2026-02-01");
    const monthEnd = new Date("2026-03-01");
    await populate4WeeksData("unapproved_agent", monthStart, monthEnd);

    const review = await generator.generateReview(
      ["unapproved_agent"],
      monthEnd,
    );

    // pending_approval bets should NOT be assessed (only active ones)
    expect(review.bet_outcomes.length).toBe(0);

    // Bet should still be pending_approval
    const pending = await generator.queryBetsByStatus("pending_approval");
    expect(pending.length).toBeGreaterThanOrEqual(1);
  });
});
