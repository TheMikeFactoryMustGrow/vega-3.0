/**
 * VEGA v3.3 End-to-End Validation Tests (US-411)
 *
 * 14 integration tests validating the full telemetry pipeline, learning loops,
 * and all v3.3 capabilities. This is the gate check for the v3.3 upgrade.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import pg from "pg";
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TelemetryEmitter } from "./emitter.js";
import { TelemetryEventSchema, type TelemetryEventInput } from "./types.js";
import { createPool, runTier2Migration, dropTier2Tables } from "./database.js";
import { Tier2Repository } from "./tier2-repository.js";
import {
  runHourlyAggregation,
  runDailyAggregation,
} from "./aggregation.js";
import { MorningBriefHealth } from "./morning-brief-health.js";
import { SelfAssessmentRunner } from "./self-assessment-runner.js";
import { WeeklyReflectionGenerator } from "./weekly-reflection.js";
import { BarRaiserMonitor } from "./bar-raiser-monitor.js";
import { MonitorConfigSchema } from "./bar-raiser-monitor-types.js";
import { PrivacyAuditor } from "./privacy-audit.js";
import { FrontmatterValidator } from "./frontmatter-validator.js";
import { PreReflection } from "./pre-reflection.js";
import { PatternMiner } from "./pattern-miner.js";

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
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "vega-v33-e2e-"));
  emitter = new TelemetryEmitter(tmpDir);
  // Clean all Tier 2 tables between tests
  await pool.query("DELETE FROM telemetry_anomalies");
  await pool.query("DELETE FROM telemetry_quality_daily");
  await pool.query("DELETE FROM telemetry_cost_daily");
  await pool.query("DELETE FROM telemetry_agent_hourly");
  await pool.query("DELETE FROM telemetry_bets");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── Test 1: Event Emission ──────────────────────────────────────────────────

describe("Test 1 — Event Emission", () => {
  it("trigger 10 agent actions → verify 10 events in today's JSONL with valid schema", async () => {
    const now = new Date("2026-03-03T12:00:00Z");

    const eventTypes = [
      "agent_action",
      "model_call",
      "knowledge_write",
      "knowledge_query",
      "escalation",
      "schedule_trigger",
      "system_event",
      "agent_action",
      "model_call",
      "agent_action",
    ] as const;

    for (let i = 0; i < 10; i++) {
      await emitter.emit({
        agent_name: `agent_${i % 3}`,
        event_type: eventTypes[i],
        event_subtype: `subtype_${i}`,
        session_id: "e2e-test-session",
        model_used: "grok-4-1-fast-reasoning",
        tokens_in: 100 + i * 10,
        tokens_out: 50 + i * 5,
        latency_ms: 200 + i * 50,
        outcome: "success",
        metadata: { test_index: i },
        timestamp: new Date(now.getTime() + i * 1000).toISOString(),
      });
    }

    const events = await emitter.readEvents(now);
    expect(events).toHaveLength(10);

    // Validate every event against the Zod schema
    for (const event of events) {
      const parsed = TelemetryEventSchema.safeParse(event);
      expect(parsed.success).toBe(true);
      expect(event.event_id).toBeDefined();
      expect(event.timestamp).toBeDefined();
      expect(event.session_id).toBe("e2e-test-session");
    }

    // Verify all 7 event types are represented
    const types = new Set(events.map((e) => e.event_type));
    expect(types.has("agent_action")).toBe(true);
    expect(types.has("model_call")).toBe(true);
    expect(types.has("knowledge_write")).toBe(true);
    expect(types.has("knowledge_query")).toBe(true);
    expect(types.has("escalation")).toBe(true);
    expect(types.has("schedule_trigger")).toBe(true);
    expect(types.has("system_event")).toBe(true);
  });
});

// ─── Test 2: Hourly Aggregation ──────────────────────────────────────────────

describe("Test 2 — Hourly Aggregation", () => {
  it("run hourly job → verify telemetry_agent_hourly populated correctly from JSONL events", async () => {
    const hourBucket = new Date("2026-03-03T10:00:00Z");

    // Emit 15 events for 2 agents within the hour
    for (let i = 0; i < 10; i++) {
      await emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "agent_action",
        event_subtype: "neo4j_write",
        session_id: "s1",
        model_used: "grok-4-1-fast-reasoning",
        tokens_in: 100,
        tokens_out: 50,
        latency_ms: 200 + i * 20,
        outcome: i < 8 ? "success" : "failure",
        timestamp: new Date(hourBucket.getTime() + i * 60000).toISOString(),
      });
    }
    for (let i = 0; i < 5; i++) {
      await emitter.emit({
        agent_name: "vega_core",
        event_type: "model_call",
        event_subtype: "frontier_call",
        session_id: "s1",
        model_used: "grok-4-1-fast-reasoning",
        tokens_in: 200,
        tokens_out: 100,
        latency_ms: 300,
        outcome: "success",
        timestamp: new Date(hourBucket.getTime() + i * 60000).toISOString(),
      });
    }

    const result = await runHourlyAggregation(emitter, repo, hourBucket, {
      emitTelemetry: false,
    });

    expect(result.agents_processed).toBe(2);
    expect(result.rows_upserted).toBe(2);

    // queryAgentHourly uses hour_bucket >= $2 AND hour_bucket < $3 (exclusive upper)
    const hourEnd = new Date(hourBucket.getTime() + 3600000);

    // Verify knowledge_agent row
    const kaRows = await repo.queryAgentHourly("knowledge_agent", hourBucket, hourEnd);
    expect(kaRows).toHaveLength(1);
    expect(kaRows[0].action_count).toBe(10);
    expect(kaRows[0].success_count).toBe(8);
    expect(kaRows[0].error_count).toBe(2);

    // Verify vega_core row
    const vcRows = await repo.queryAgentHourly("vega_core", hourBucket, hourEnd);
    expect(vcRows).toHaveLength(1);
    expect(vcRows[0].action_count).toBe(5);
    expect(vcRows[0].success_count).toBe(5);
    expect(vcRows[0].error_count).toBe(0);
  });
});

// ─── Test 3: Daily Aggregation ───────────────────────────────────────────────

describe("Test 3 — Daily Aggregation", () => {
  it("run daily job → verify telemetry_cost_daily and telemetry_quality_daily populated", async () => {
    const date = new Date("2026-03-02T00:00:00Z");

    // Emit 20 events for a single agent across the day
    for (let i = 0; i < 20; i++) {
      await emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "agent_action",
        event_subtype: "neo4j_write",
        session_id: "s1",
        model_used: "grok-4-1-fast-reasoning",
        tokens_in: 1000,
        tokens_out: 500,
        latency_ms: 250 + i * 10,
        outcome: i < 17 ? "success" : "failure",
        timestamp: new Date(date.getTime() + i * 3600000).toISOString(),
      });
    }

    const result = await runDailyAggregation(emitter, repo, pool, date, {
      emitTelemetry: false,
    });

    expect(result.agents_processed).toBeGreaterThanOrEqual(1);

    // Verify cost_daily
    const costRows = await repo.queryCostDaily("knowledge_agent", date, date);
    expect(costRows.length).toBeGreaterThanOrEqual(1);
    const costRow = costRows[0];
    expect(costRow.total_tokens_in).toBeGreaterThan(0);
    expect(costRow.total_tokens_out).toBeGreaterThan(0);
    expect(costRow.total_cost_usd).toBeGreaterThan(0);

    // Verify quality_daily
    const qualityRows = await repo.queryQualityDaily("knowledge_agent", date, date);
    expect(qualityRows.length).toBeGreaterThanOrEqual(1);
    const successRateRow = qualityRows.find((r) => r.metric_name === "success_rate");
    expect(successRateRow).toBeDefined();
    expect(successRateRow!.metric_value).toBeCloseTo(17 / 20, 1);
  });
});

// ─── Test 4: Anomaly Detection ───────────────────────────────────────────────

describe("Test 4 — Anomaly Detection", () => {
  it("inject 3σ latency spike → verify telemetry_anomalies row created", async () => {
    const spikeDate = new Date("2026-03-03T00:00:00Z");

    // Anomaly detection reads from telemetry_agent_hourly (not quality_daily).
    // Seed 7 days of historical hourly data with low error counts (varying for non-zero stddev).
    for (let d = 1; d <= 7; d++) {
      const pastDate = new Date(spikeDate);
      pastDate.setUTCDate(pastDate.getUTCDate() - d);

      // Insert 2-3 hourly rows per day to simulate normal operations
      for (let h = 0; h < 3; h++) {
        const hourBucket = new Date(
          Date.UTC(
            pastDate.getUTCFullYear(),
            pastDate.getUTCMonth(),
            pastDate.getUTCDate(),
            10 + h,
          ),
        );
        await repo.upsertAgentHourly({
          agent_name: "knowledge_agent",
          hour_bucket: hourBucket,
          action_count: 10,
          success_count: 9,
          error_count: 1 + (d % 2), // 1-2 errors, gives variance
          avg_latency_ms: 200 + d * 5,
          p95_latency_ms: 400,
          p99_latency_ms: 600,
          reasoning_steps_avg: 3,
          model_distribution: { "grok-4": 10 },
          tokens_in_total: 5000,
          tokens_out_total: 2500,
          cost_usd_total: 0.05,
          performance_score: 0.85,
        });
      }
    }

    // Now emit events for the spike date with very high error count
    for (let i = 0; i < 20; i++) {
      await emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "agent_action",
        event_subtype: "neo4j_write",
        session_id: "s1",
        model_used: "grok-4-1-fast-reasoning",
        tokens_in: 500,
        tokens_out: 200,
        latency_ms: 5000 + i * 100, // massive spike
        outcome: i < 3 ? "success" : "failure", // 17 failures vs historical ~2-3/day
        timestamp: new Date(spikeDate.getTime() + i * 3600000).toISOString(),
      });
    }

    const result = await runDailyAggregation(emitter, repo, pool, spikeDate, {
      emitTelemetry: false,
    });

    expect(result.anomalies_detected).toBeGreaterThanOrEqual(1);

    // Verify anomaly row exists
    const anomalies = await repo.queryUnresolvedAnomalies();
    const errorAnomaly = anomalies.find(
      (a) =>
        a.agent_name === "knowledge_agent" &&
        a.detection_method === "daily_aggregation_2sigma",
    );
    expect(errorAnomaly).toBeDefined();
    expect(errorAnomaly!.severity).toMatch(/warning|critical/);
  });
});

// ─── Test 5: Morning Brief System Health ─────────────────────────────────────

describe("Test 5 — Morning Brief System Health", () => {
  it("generate System Health with populated Tier 2 data → verify all 6 subsections", async () => {
    const targetDate = new Date("2026-03-03T00:00:00Z");

    // Populate agent_hourly for yesterday (24h window)
    for (let h = 0; h < 24; h++) {
      const hourBucket = new Date(targetDate);
      hourBucket.setUTCHours(h, 0, 0, 0);

      await repo.upsertAgentHourly({
        agent_name: "knowledge_agent",
        hour_bucket: hourBucket,
        action_count: 10,
        success_count: 9,
        error_count: 1,
        avg_latency_ms: 300,
        p95_latency_ms: 800,
        p99_latency_ms: 1200,
        reasoning_steps_avg: 3,
        model_distribution: { "grok-4": 10 },
        tokens_in_total: 5000,
        tokens_out_total: 2500,
        cost_usd_total: 0.05,
        performance_score: 0.88,
      });
    }

    // Populate cost_daily
    await repo.upsertCostDaily({
      date: targetDate,
      agent_name: "knowledge_agent",
      model: "grok-4-1-fast-reasoning",
      total_tokens_in: 120000,
      total_tokens_out: 60000,
      total_cost_usd: 1.26,
      avg_cost_per_action: 0.0053,
      cost_per_mtok: 15.0,
      invocations: 240,
    });

    // Populate quality_daily
    await repo.upsertQualityDaily({
      date: targetDate,
      agent_name: "knowledge_agent",
      metric_name: "success_rate",
      metric_value: 0.9,
      trend: "improving",
      p50_value: 0.9,
      p95_value: 0.95,
      sample_count: 240,
    });

    const brief = new MorningBriefHealth(pool);
    const section = await brief.generate(targetDate);

    expect(section.data_available).toBe(true);
    const md = section.markdown;

    // Verify all 6 subsections present
    expect(md).toContain("Active Agents");
    expect(md).toContain("Total Actions");
    expect(md).toContain("Estimated Cost");
    expect(md).toContain("Quality Scores");
    expect(md).toContain("Anomalies");
    expect(md).toContain("Top Performers");

    // Verify knowledge_agent data appears
    expect(md).toContain("knowledge_agent");
  });
});

// ─── Test 6: Loop 1 Self-Assessment ──────────────────────────────────────────

describe("Test 6 — Loop 1 Self-Assessment", () => {
  it("trigger self_assessment for agent with declining quality → verify prompt updated", async () => {
    const targetDate = new Date("2026-03-03T00:00:00Z");

    // Insert declining quality metric
    await repo.upsertQualityDaily({
      date: targetDate,
      agent_name: "knowledge_agent",
      metric_name: "success_rate",
      metric_value: 0.65, // Below 0.8 threshold
      trend: "declining",
      p50_value: 0.65,
      p95_value: 0.7,
      sample_count: 50,
    });

    const runner = new SelfAssessmentRunner(pool, emitter, {
      emitTelemetry: false,
    });

    const config = {
      frequency: "every 10 actions",
      metrics_query:
        "SELECT metric_value, trend FROM telemetry_quality_daily WHERE agent_name = 'knowledge_agent' AND metric_name = 'success_rate' ORDER BY date DESC LIMIT 1",
      adjustment_rules: [
        {
          name: "low_quality_boost",
          condition: {
            type: "metric_value" as const,
            field: "metric_value",
            operator: "<" as const,
            value: 0.8,
          },
          action: {
            type: "update_prompt" as const,
            new_prompt:
              "IMPORTANT: Your recent success rate is below target. Double-check your reasoning before responding.",
          },
        },
      ],
      reasoning_prompt_injection: "Standard operational prompt.",
    };

    const { result, updatedConfig } = await runner.run(
      "knowledge_agent",
      config,
    );

    expect(result.rules_triggered).toBe(1);
    expect(result.adjustments[0].triggered).toBe(true);
    expect(result.adjustments[0].rule_name).toBe("low_quality_boost");
    expect(updatedConfig.reasoning_prompt_injection).toContain(
      "Double-check your reasoning",
    );
    expect(updatedConfig.reasoning_prompt_injection).not.toBe(
      "Standard operational prompt.",
    );
  });
});

// ─── Test 7: Loop 2 Weekly Reflection with Pre-Reflection ────────────────────

describe("Test 7 — Loop 2 Weekly Reflection with Pre-Reflection Digest", () => {
  it("generate reflection with pre-reflection input → verify required sections and digest reference", async () => {
    const weekEnd = new Date("2026-03-01T00:00:00Z"); // Sunday

    // Populate 7 days of quality data
    for (let d = 0; d < 7; d++) {
      const date = new Date(weekEnd);
      date.setUTCDate(date.getUTCDate() - d);

      await repo.upsertQualityDaily({
        date,
        agent_name: "knowledge_agent",
        metric_name: "success_rate",
        metric_value: 0.82 + d * 0.01,
        trend: d > 0 ? "improving" : "stable",
        p50_value: 0.82 + d * 0.01,
        p95_value: 0.90,
        sample_count: 50,
      });

      await repo.upsertAgentHourly({
        agent_name: "knowledge_agent",
        hour_bucket: new Date(
          Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate(),
            10,
          ),
        ),
        action_count: 20,
        success_count: 18,
        error_count: 2,
        avg_latency_ms: 300,
        p95_latency_ms: 800,
        p99_latency_ms: 1200,
        reasoning_steps_avg: 3,
        model_distribution: { "grok-4": 20 },
        tokens_in_total: 10000,
        tokens_out_total: 5000,
        cost_usd_total: 0.1,
        performance_score: 0.85,
      });
    }

    // Create a pre-reflection digest file that Loop 2 will read
    const preReflDir = path.join(
      tmpDir,
      "pre-reflections",
      "knowledge_agent",
    );
    await mkdir(preReflDir, { recursive: true });
    await writeFile(
      path.join(preReflDir, "2026-03-01.md"),
      `# Pre-Reflection Digest: knowledge_agent

## Event Summary
- Total events: 150
- By type: agent_action (120), model_call (30)

## Notable Failures
- neo4j_timeout: 5 occurrences

## Recurring Patterns
- Event burst detected at 14:00 UTC

## Confidence Calibration
- Accuracy: 85%
`,
    );

    const generator = new WeeklyReflectionGenerator(pool, emitter, tmpDir, {
      emitTelemetry: false,
    });

    const reflection = await generator.generateReflection(
      "knowledge_agent",
      weekEnd,
    );

    // Verify all required sections present (nested under `reflection` and `summary`)
    expect(reflection.agent_name).toBe("knowledge_agent");
    expect(reflection.reflection.what_worked_well).toBeDefined();
    expect(reflection.reflection.what_didnt_work).toBeDefined();
    expect(reflection.reflection.patterns_noticed).toBeDefined();
    expect(reflection.reflection.proposed_adjustments).toBeDefined();
    expect(reflection.reflection.questions_for_bar_raiser).toBeDefined();
    expect(reflection.summary).toBeDefined();

    // Verify the markdown references the pre-reflection digest
    expect(reflection.markdown).toContain("Pre-Reflection");

    // Verify the reflection file was written
    const reflDir = path.join(tmpDir, "reflections", "knowledge_agent");
    const files = await readdir(reflDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Test 8: Bar Raiser Monitor ──────────────────────────────────────────────

describe("Test 8 — Bar Raiser Monitor (Metric Gaming)", () => {
  it("simulate metric gaming pattern → verify detection fires and anomaly logged", async () => {
    const targetDate = new Date("2026-03-03T00:00:00Z");

    // Create prior period data: high volume, moderate accuracy
    for (let d = 8; d <= 14; d++) {
      const date = new Date(targetDate);
      date.setUTCDate(date.getUTCDate() - d);

      await repo.upsertAgentHourly({
        agent_name: "knowledge_agent",
        hour_bucket: new Date(
          Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate(),
            10,
          ),
        ),
        action_count: 100, // High volume
        success_count: 75, // 75% accuracy
        error_count: 25,
        avg_latency_ms: 500,
        p95_latency_ms: 1000,
        p99_latency_ms: 1500,
        reasoning_steps_avg: 3,
        model_distribution: { "grok-4": 100 },
        tokens_in_total: 50000,
        tokens_out_total: 25000,
        cost_usd_total: 0.5,
        performance_score: 0.75,
      });
    }

    // Create current period: accuracy up, volume significantly down (sandbagging)
    for (let d = 1; d <= 7; d++) {
      const date = new Date(targetDate);
      date.setUTCDate(date.getUTCDate() - d);

      await repo.upsertAgentHourly({
        agent_name: "knowledge_agent",
        hour_bucket: new Date(
          Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate(),
            10,
          ),
        ),
        action_count: 30, // Volume dropped by 70%
        success_count: 29, // 97% accuracy — up significantly
        error_count: 1,
        avg_latency_ms: 500,
        p95_latency_ms: 1000,
        p99_latency_ms: 1500,
        reasoning_steps_avg: 3,
        model_distribution: { "grok-4": 30 },
        tokens_in_total: 15000,
        tokens_out_total: 7500,
        cost_usd_total: 0.15,
        performance_score: 0.92,
      });
    }

    const monitor = new BarRaiserMonitor(
      pool,
      emitter,
      MonitorConfigSchema.parse({}),
      tmpDir,
      { emitTelemetry: false },
    );

    const report = await monitor.runMonitor(
      ["knowledge_agent"],
      targetDate,
    );

    // Should detect sandbagging (metric gaming pattern)
    const gamingDetections = report.detections.filter(
      (d) => d.pattern === "metric_gaming",
    );
    expect(gamingDetections.length).toBeGreaterThanOrEqual(1);

    const sandbagging = gamingDetections.find(
      (d) => d.subtype === "sandbagging",
    );
    expect(sandbagging).toBeDefined();
    expect(sandbagging!.agent_name).toBe("knowledge_agent");
    expect(sandbagging!.severity).toMatch(/warning|critical/);
    expect(sandbagging!.evidence).toBeDefined();
  });
});

// ─── Test 9: Privacy Audits ──────────────────────────────────────────────────

describe("Test 9 — Privacy Audits", () => {
  it("run all 6 Cypher queries against test graph with known violations → verify detections", async () => {
    // Mock Cypher query function that returns violations for each audit.
    // Match on unique substring in each audit's cypher query.
    const mockQueryFn = async (
      query: string,
      params: Record<string, unknown>,
    ) => {
      // Audit 1 — Orphaned Sources: "NOT (s)<-[:SOURCED_FROM]-()"
      if (query.includes("NOT (s)<-[:SOURCED_FROM]")) {
        return [{ title: "Orphaned Source 1", id: "src-001" }];
      }
      // Audit 2 — Stale Claims: "duration({days: $stale_days})"
      if (query.includes("duration")) {
        return [{ title: "Stale Claim 1", id: "claim-001", last_verified: "2025-01-01" }];
      }
      // Audit 3 — Cross-Account Leakage: "e.tags IS NOT NULL"
      if (query.includes("e.tags IS NOT NULL")) {
        return [
          {
            source_title: "Family Photo",
            entity_title: "GIX Internal Doc",
            source_account: "icloud_family",
          },
        ];
      }
      // Audit 4 — Missing Truth Tier: "truth_tier IS NULL"
      if (query.includes("truth_tier IS NULL")) {
        return [{ title: "Unclassified Claim", id: "claim-002" }];
      }
      // Audit 5 — Permission Boundary: "e.domain ="
      if (query.includes("e.domain =")) {
        return [{ title: "Boundary Violation", id: "claim-003" }];
      }
      // Audit 6 — Temporal Anomalies: "created_date > c.last_verified"
      if (query.includes("created_date > c.last_verified")) {
        return [
          {
            title: "Time Travel Claim",
            id: "claim-004",
            created_date: "2026-03-03",
            last_verified: "2026-03-01",
          },
        ];
      }
      return [];
    };

    const auditor = new PrivacyAuditor(mockQueryFn, emitter, {}, {
      emitTelemetry: false,
    });

    const report = await auditor.runAllAudits();

    expect(report.audits_run).toBe(6);
    expect(report.total_findings).toBeGreaterThanOrEqual(6);

    // Verify each audit found its violation
    for (const finding of report.findings) {
      expect(finding.finding_count).toBeGreaterThanOrEqual(1);
    }

    // Verify escalation flags (audits 1-5 should escalate)
    const escalatedFindings = report.findings.filter(
      (f) => f.escalation_triggered,
    );
    expect(escalatedFindings.length).toBeGreaterThanOrEqual(5);

    // Audit 6 (temporal anomalies) should NOT escalate
    const temporalFinding = report.findings.find(
      (f) => f.audit_id === "temporal_anomalies",
    );
    expect(temporalFinding).toBeDefined();
    expect(temporalFinding!.escalation_triggered).toBe(false);
  });
});

// ─── Test 10: YAML Frontmatter Validation ────────────────────────────────────

describe("Test 10 — YAML Frontmatter Validation", () => {
  it("submit valid and invalid notes → verify correct accept/reject behavior", async () => {
    const validator = new FrontmatterValidator();

    // Valid Claim note
    const validClaim = validator.validate("Claim", {
      title: "Test Claim",
      truth_tier: "multi_source_verified",
      truth_score: 0.85,
      source_ids: ["src-001"],
      domain: "finance",
      created_date: "2026-03-03",
      last_verified: "2026-03-03",
    });
    expect(validClaim.valid).toBe(true);

    // Invalid Claim — missing required truth_tier
    const invalidClaim = validator.validate("Claim", {
      title: "Bad Claim",
      truth_score: 0.5,
      source_ids: ["src-001"],
      domain: "finance",
      created_date: "2026-03-03",
      last_verified: "2026-03-03",
    });
    expect(invalidClaim.valid).toBe(false);
    expect(invalidClaim.errors.length).toBeGreaterThan(0);

    // Valid Entity note
    const validEntity = validator.validate("Entity", {
      title: "Test Entity",
      entity_type: "person",
      domain: "family",
      created_date: "2026-03-03",
    });
    expect(validEntity.valid).toBe(true);

    // Invalid Entity — bad entity_type enum
    const invalidEntity = validator.validate("Entity", {
      title: "Bad Entity",
      entity_type: "invalid_type",
      domain: "family",
      created_date: "2026-03-03",
    });
    expect(invalidEntity.valid).toBe(false);

    // Valid Source note
    const validSource = validator.validate("Source", {
      title: "Test Source",
      source_type: "email",
      source_account: "icloud_family",
      credibility_weight: 0.9,
      captured_date: "2026-03-03",
    });
    expect(validSource.valid).toBe(true);

    // Invalid — out of range credibility_weight
    const invalidSource = validator.validate("Source", {
      title: "Bad Source",
      source_type: "email",
      source_account: "icloud_family",
      credibility_weight: 1.5,
      captured_date: "2026-03-03",
    });
    expect(invalidSource.valid).toBe(false);

    // writeNote with valid data should succeed
    const noteDir = path.join(tmpDir, "notes");
    await mkdir(noteDir, { recursive: true });

    const validatorWithEmitter = new FrontmatterValidator({
      emitter: new TelemetryEmitter(tmpDir),
    });
    const writeResult = await validatorWithEmitter.writeNote({
      note_type: "Entity",
      frontmatter: {
        title: "Written Entity",
        entity_type: "organization",
        domain: "business",
        created_date: "2026-03-03",
      },
      body: "This is the body of the note.",
      file_path: path.join(noteDir, "test-entity.md"),
      agent_name: "knowledge_agent",
    });
    expect(writeResult.success).toBe(true);

    // writeNote with invalid data should fail (note NOT written)
    const failResult = await validatorWithEmitter.writeNote({
      note_type: "Claim",
      frontmatter: {
        title: "Missing Fields",
      },
      body: "This should not be written.",
      file_path: path.join(noteDir, "bad-claim.md"),
      agent_name: "knowledge_agent",
    });
    expect(failResult.success).toBe(false);
    expect(failResult.escalation).toBeDefined();
    expect(failResult.escalation!.level).toBe(2);

    // Verify the bad file was NOT created
    const noteFiles = await readdir(noteDir);
    expect(noteFiles).not.toContain("bad-claim.md");
  });
});

// ─── Test 11: Idempotency ────────────────────────────────────────────────────

describe("Test 11 — Idempotency", () => {
  it("run both aggregation jobs twice for same time window → verify no duplicate rows", async () => {
    const hourBucket = new Date("2026-03-03T10:00:00Z");
    const date = new Date("2026-03-03T00:00:00Z");

    // Emit events for both hourly and daily
    for (let i = 0; i < 10; i++) {
      await emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "agent_action",
        event_subtype: "neo4j_write",
        session_id: "s1",
        model_used: "grok-4-1-fast-reasoning",
        tokens_in: 100,
        tokens_out: 50,
        latency_ms: 300,
        outcome: "success",
        timestamp: new Date(hourBucket.getTime() + i * 60000).toISOString(),
      });
    }

    // Run hourly twice
    await runHourlyAggregation(emitter, repo, hourBucket, {
      emitTelemetry: false,
    });
    await runHourlyAggregation(emitter, repo, hourBucket, {
      emitTelemetry: false,
    });

    // queryAgentHourly uses hour_bucket >= $2 AND hour_bucket < $3 (exclusive upper)
    const hourEnd = new Date(hourBucket.getTime() + 3600000);
    const hourlyRows = await repo.queryAgentHourly(
      "knowledge_agent",
      hourBucket,
      hourEnd,
    );
    expect(hourlyRows).toHaveLength(1); // No duplicates

    // Run daily twice
    await runDailyAggregation(emitter, repo, pool, date, {
      emitTelemetry: false,
    });
    await runDailyAggregation(emitter, repo, pool, date, {
      emitTelemetry: false,
    });

    const costRows = await repo.queryCostDaily("knowledge_agent", date, date);
    expect(costRows).toHaveLength(1); // No duplicates

    const qualityRows = await repo.queryQualityDaily(
      "knowledge_agent",
      date,
      date,
    );
    // Each metric name should appear only once
    const metricCounts = new Map<string, number>();
    for (const row of qualityRows) {
      metricCounts.set(
        row.metric_name,
        (metricCounts.get(row.metric_name) ?? 0) + 1,
      );
    }
    for (const [metric, count] of metricCounts) {
      expect(count).toBe(1);
    }
  });
});

// ─── Test 12: Graceful Degradation ───────────────────────────────────────────

describe("Test 12 — Graceful Degradation", () => {
  it("disable PostgreSQL → verify agent operations continue (emission works, aggregation fails gracefully)", async () => {
    const targetHour = new Date("2026-03-03T10:00:00Z");

    // Tier 1 event emission should work without PostgreSQL
    const isolatedEmitter = new TelemetryEmitter(tmpDir);

    // Emit events WITH timestamps matching the target hour so aggregation
    // actually tries to upsert into the broken DB
    for (let i = 0; i < 5; i++) {
      await isolatedEmitter.emit({
        agent_name: "knowledge_agent",
        event_type: "agent_action",
        event_subtype: "test_action",
        session_id: "degraded-session",
        model_used: "grok-4-1-fast-reasoning",
        tokens_in: 100,
        tokens_out: 50,
        latency_ms: 200,
        outcome: "success",
        timestamp: new Date(targetHour.getTime() + i * 60000).toISOString(),
      });
    }

    // Verify events written to disk
    const events = await isolatedEmitter.readEvents(targetHour);
    expect(events.length).toBe(5);

    // Now test aggregation with a broken pool (unreachable port)
    const brokenPool = new pg.Pool({
      connectionString: "postgres://localhost:59999/nonexistent_db",
      connectionTimeoutMillis: 1000,
    });
    const brokenRepo = new Tier2Repository(brokenPool);

    // Hourly aggregation should fail (PostgreSQL is unreachable)
    let hourlyError: Error | null = null;
    try {
      await runHourlyAggregation(
        isolatedEmitter,
        brokenRepo,
        targetHour,
        { emitTelemetry: false },
      );
    } catch (err) {
      hourlyError = err as Error;
    }
    expect(hourlyError).not.toBeNull();

    // Critical: the emitter still works after the aggregation failure
    const event2 = await isolatedEmitter.emit({
      agent_name: "knowledge_agent",
      event_type: "agent_action",
      event_subtype: "post_failure_action",
      session_id: "degraded-session",
      model_used: "grok-4-1-fast-reasoning",
      tokens_in: 100,
      tokens_out: 50,
      latency_ms: 200,
      outcome: "success",
      timestamp: new Date(targetHour.getTime() + 300000).toISOString(),
    });

    expect(event2).not.toBeNull();

    // Clean up broken pool
    await brokenPool.end();
  });
});

// ─── Test 13: Loop 1.5 Pre-Reflection ────────────────────────────────────────

describe("Test 13 — Loop 1.5 Pre-Reflection", () => {
  it("trigger pre-reflection with ≥100 events → verify digest with all sections, local model only", async () => {
    const now = new Date("2026-03-03T12:00:00Z");

    // Emit 150 events for knowledge_agent
    for (let i = 0; i < 150; i++) {
      await emitter.emit({
        agent_name: "knowledge_agent",
        event_type: (i % 3 === 0 ? "agent_action" : i % 3 === 1 ? "model_call" : "knowledge_write") as "agent_action" | "model_call" | "knowledge_write",
        event_subtype: `subtype_${i % 5}`,
        session_id: "pre-refl-test",
        model_used: "qwen3:32b",
        tokens_in: 100,
        tokens_out: 50,
        latency_ms: 200 + (i % 10) * 50,
        outcome: i < 130 ? "success" : "failure",
        metadata: i >= 130 ? { error: `failure_${i % 3}` } : {},
        timestamp: new Date(now.getTime() - (150 - i) * 60000).toISOString(),
      });
    }

    const preReflection = new PreReflection(emitter, tmpDir, {
      event_threshold: 100,
      emitTelemetry: false,
    });

    // Check trigger condition
    const trigger = await preReflection.checkTrigger("knowledge_agent", now);
    expect(trigger.should_trigger).toBe(true);
    expect(trigger.reason).toContain("event");

    // Generate the digest
    const digest = await preReflection.generateDigest("knowledge_agent", now);

    expect(digest).not.toBeNull();
    expect(digest!.agent_name).toBe("knowledge_agent");
    expect(digest!.model_used).toBe("qwen3:32b"); // Local model ONLY

    // Verify all 4 required sections
    expect(digest!.event_summary).toBeDefined();
    expect(digest!.event_summary.total_events).toBeGreaterThanOrEqual(100);
    expect(digest!.event_summary.by_type.length).toBeGreaterThan(0);

    expect(digest!.notable_failures).toBeDefined();

    expect(digest!.recurring_patterns).toBeDefined();

    expect(digest!.confidence_calibration).toBeDefined();

    // Verify digest file written
    const digestDir = path.join(
      tmpDir,
      "pre-reflections",
      "knowledge_agent",
    );
    const files = await readdir(digestDir);
    expect(files.length).toBeGreaterThanOrEqual(1);

    // Verify the markdown file content
    const digestFile = files.find((f) => f.endsWith(".md"));
    expect(digestFile).toBeDefined();
    const content = await readFile(
      path.join(digestDir, digestFile!),
      "utf-8",
    );
    expect(content).toContain("Event Summary");
    expect(content).toContain("Notable Failures");
    expect(content).toContain("Recurring Patterns");
    expect(content).toContain("Confidence Calibration");
  });
});

// ─── Test 14: Pattern Mining Infrastructure ──────────────────────────────────

describe("Test 14 — Pattern Mining Infrastructure", () => {
  it("verify disabled by default, then enable and detect demand clustering pattern", async () => {
    const targetDate = new Date("2026-03-03T00:00:00Z");

    // Step 1: Verify disabled by default
    const disabledMiner = new PatternMiner(pool, emitter, undefined, tmpDir, {
      emitTelemetry: false,
    });
    const nullResult = await disabledMiner.runMining(
      ["agent_a", "agent_b", "agent_c"],
      targetDate,
    );
    expect(nullResult).toBeNull();

    // Step 2: Enable and seed data with a known demand clustering pattern
    const enabledMiner = new PatternMiner(
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

    // Create Agent A → Agent B → Agent C co-occurrence 12 times in 30 days
    for (let d = 0; d < 12; d++) {
      const hourBucket = new Date(targetDate);
      hourBucket.setUTCDate(hourBucket.getUTCDate() - (d * 2 + 1));
      hourBucket.setUTCHours(10, 0, 0, 0);

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

    // Step 3: Run mining and verify detection
    const report = await enabledMiner.runMining(
      ["agent_a", "agent_b", "agent_c"],
      targetDate,
    );

    expect(report).not.toBeNull();
    expect(report!.activation_flag).toBe(true);

    // Should detect demand clustering
    const clusteringPatterns = report!.detected_patterns.filter(
      (p) => p.type === "demand_clustering",
    );
    expect(clusteringPatterns.length).toBeGreaterThanOrEqual(1);

    // At least one pair with ≥12 co-occurrences
    const highFreq = clusteringPatterns.find((p) => p.frequency >= 12);
    expect(highFreq).toBeDefined();
    expect(highFreq!.agents.length).toBe(2);

    // Verify report was written to filesystem
    const reportDir = path.join(tmpDir, "pattern-mining");
    const files = await readdir(reportDir);
    expect(files).toContain("2026-03-03.md");

    // Verify report has all required sections
    const md = report!.markdown;
    expect(md).toContain("# Cross-Agent Pattern Mining Report");
    expect(md).toContain("## Detected Patterns");
    expect(md).toContain("## Proactive Artifact Candidates");
    expect(md).toContain("## No-Action Patterns");
  });
});
