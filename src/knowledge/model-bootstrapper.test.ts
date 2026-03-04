import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { createPool } from "../telemetry/database.js";
import { TelemetryEmitter } from "../telemetry/emitter.js";
import {
  ModelBootstrapper,
  type ComparisonResult,
  type DelegationStatus,
  type QualityMetric,
  type CostSavings,
} from "./model-bootstrapper.js";
import type { TaskType } from "./model-router.js";

/**
 * ModelBootstrapper tests — verifies 5-step supervision loop,
 * delegation status progression, Bar Raiser auto-revert, and cost tracking.
 *
 * Uses real PostgreSQL for model_quality_metrics table tests.
 */

const TEST_DB_URL =
  process.env.VEGA_TEST_PG_URL ?? "postgres://localhost/vega_test";

let pool: pg.Pool;
let emitter: TelemetryEmitter;
let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "vega-bootstrapper-test-"));
  emitter = new TelemetryEmitter(tempDir);
  pool = createPool(TEST_DB_URL);

  // Clean up any existing test data and run migration
  await pool.query("DROP TABLE IF EXISTS model_quality_metrics CASCADE");
});

afterAll(async () => {
  await pool.query("DROP TABLE IF EXISTS model_quality_metrics CASCADE");
  await pool.end();
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Clean table data between tests
  try {
    await pool.query("DELETE FROM model_quality_metrics");
  } catch {
    // Table might not exist yet
  }
});

// ── Helper: create bootstrapper with injected compare function ──────

function createBootstrapper(
  overrides?: {
    quality_threshold?: number;
    required_successes?: number;
    compareQuality?: (
      taskType: TaskType,
      frontierOutput: string,
      localOutput: string,
    ) => Promise<ComparisonResult>;
  },
) {
  return new ModelBootstrapper({
    pool,
    emitter,
    config: {
      quality_threshold: overrides?.quality_threshold ?? 0.85,
      required_successes: overrides?.required_successes ?? 10,
    },
    compareQuality: overrides?.compareQuality,
  });
}

function mockCompareQuality(score: number) {
  return async (
    taskType: TaskType,
    frontierOutput: string,
    localOutput: string,
  ): Promise<ComparisonResult> => ({
    task_type: taskType,
    frontier_output: frontierOutput,
    local_output: localOutput,
    quality_score: score,
    semantic_similarity: score,
    structural_match: score,
    correctness: score,
  });
}

describe("ModelBootstrapper", () => {
  describe("schema migration", () => {
    it("creates model_quality_metrics table", async () => {
      const bootstrapper = createBootstrapper();
      await bootstrapper.migrate();

      // Verify table exists by querying it
      const result = await pool.query(
        "SELECT COUNT(*) as cnt FROM model_quality_metrics",
      );
      expect(Number(result.rows[0].cnt)).toBe(0);
    });

    it("migration is idempotent", async () => {
      const bootstrapper = createBootstrapper();
      await bootstrapper.migrate();
      await bootstrapper.migrate(); // Second run should not error

      const result = await pool.query(
        "SELECT COUNT(*) as cnt FROM model_quality_metrics",
      );
      expect(Number(result.rows[0].cnt)).toBe(0);
    });
  });

  describe("delegation status progression", () => {
    it("starts at shadow_testing on first evaluation", async () => {
      const bootstrapper = createBootstrapper({
        compareQuality: mockCompareQuality(0.9),
      });
      await bootstrapper.migrate();

      const status = await bootstrapper.recordEvaluation("formatting", 0.9);
      expect(status).toBe("shadow_testing");

      const metric = await bootstrapper.getStatus("formatting");
      expect(metric).not.toBeNull();
      expect(metric!.delegation_status).toBe("shadow_testing");
      expect(metric!.sample_count).toBe(1);
    });

    it("progresses to local_candidate when quality meets threshold", async () => {
      const bootstrapper = createBootstrapper({
        compareQuality: mockCompareQuality(0.9),
      });
      await bootstrapper.migrate();

      // First eval: frontier_only → shadow_testing
      await bootstrapper.recordEvaluation("formatting", 0.9);

      // Second eval: shadow_testing → local_candidate (quality >= 0.85)
      const status = await bootstrapper.recordEvaluation("formatting", 0.9);
      expect(status).toBe("local_candidate");
    });

    it("stays in shadow_testing when quality below threshold", async () => {
      const bootstrapper = createBootstrapper({
        compareQuality: mockCompareQuality(0.7),
      });
      await bootstrapper.migrate();

      // First eval: → shadow_testing
      await bootstrapper.recordEvaluation("formatting", 0.7);

      // Second eval: quality below threshold → stays shadow_testing
      const status = await bootstrapper.recordEvaluation("formatting", 0.7);
      expect(status).toBe("shadow_testing");
    });

    it("progresses to delegated after N successful evaluations", async () => {
      const bootstrapper = createBootstrapper({
        required_successes: 3,
        compareQuality: mockCompareQuality(0.9),
      });
      await bootstrapper.migrate();

      // Move through: shadow_testing → local_candidate → delegated
      await bootstrapper.recordEvaluation("formatting", 0.9); // → shadow_testing (count=1)
      await bootstrapper.recordEvaluation("formatting", 0.9); // → local_candidate (count=2)
      const status = await bootstrapper.recordEvaluation("formatting", 0.9); // count=3 → delegated
      expect(status).toBe("delegated");

      const metric = await bootstrapper.getStatus("formatting");
      expect(metric!.delegation_status).toBe("delegated");
      expect(metric!.sample_count).toBe(3);
    });

    it("runs full 5-step loop: frontier_only → shadow → candidate → delegated", async () => {
      const bootstrapper = createBootstrapper({
        required_successes: 4,
        compareQuality: mockCompareQuality(0.9),
      });
      await bootstrapper.migrate();

      // Step 1: Task starts on frontier (no entry yet)
      const initial = await bootstrapper.getStatus("formatting");
      expect(initial).toBeNull();

      // Step 2-3: Shadow evaluate — frontier and local process same input
      const comparison = await bootstrapper.shadowEvaluate(
        "formatting",
        "Frontier formatted output",
        "Local formatted output",
      );
      expect(comparison.quality_score).toBe(0.9);

      // Step 4: Check status progression
      let metric = await bootstrapper.getStatus("formatting");
      expect(metric!.delegation_status).toBe("shadow_testing");

      // More evaluations
      await bootstrapper.shadowEvaluate("formatting", "Frontier 2", "Local 2");
      metric = await bootstrapper.getStatus("formatting");
      expect(metric!.delegation_status).toBe("local_candidate");

      await bootstrapper.shadowEvaluate("formatting", "Frontier 3", "Local 3");
      metric = await bootstrapper.getStatus("formatting");
      expect(metric!.delegation_status).toBe("local_candidate");

      // Step 5: After enough successful evals, delegate
      await bootstrapper.shadowEvaluate("formatting", "Frontier 4", "Local 4");
      metric = await bootstrapper.getStatus("formatting");
      expect(metric!.delegation_status).toBe("delegated");
    });
  });

  describe("Bar Raiser auto-revert", () => {
    it("reverts delegated task to frontier_only when quality drops", async () => {
      const bootstrapper = createBootstrapper({
        required_successes: 3,
        compareQuality: mockCompareQuality(0.9),
      });
      await bootstrapper.migrate();

      // Progress to delegated
      await bootstrapper.recordEvaluation("formatting", 0.9);
      await bootstrapper.recordEvaluation("formatting", 0.9);
      await bootstrapper.recordEvaluation("formatting", 0.9);

      let metric = await bootstrapper.getStatus("formatting");
      expect(metric!.delegation_status).toBe("delegated");

      // Quality drops below threshold — auto-revert
      const status = await bootstrapper.recordEvaluation("formatting", 0.5);
      expect(status).toBe("frontier_only");

      metric = await bootstrapper.getStatus("formatting");
      expect(metric!.delegation_status).toBe("frontier_only");
      expect(metric!.sample_count).toBe(0); // Reset count
    });

    it("reverts local_candidate to shadow_testing on quality drop", async () => {
      const bootstrapper = createBootstrapper({
        required_successes: 10,
        compareQuality: mockCompareQuality(0.9),
      });
      await bootstrapper.migrate();

      // Progress to local_candidate
      await bootstrapper.recordEvaluation("formatting", 0.9);
      await bootstrapper.recordEvaluation("formatting", 0.9);

      let metric = await bootstrapper.getStatus("formatting");
      expect(metric!.delegation_status).toBe("local_candidate");

      // Quality drops — revert to shadow_testing
      const status = await bootstrapper.recordEvaluation("formatting", 0.5);
      expect(status).toBe("shadow_testing");

      metric = await bootstrapper.getStatus("formatting");
      expect(metric!.delegation_status).toBe("shadow_testing");
      expect(metric!.sample_count).toBe(0);
    });

    it("supports manual revert to frontier_only", async () => {
      const bootstrapper = createBootstrapper({
        required_successes: 3,
        compareQuality: mockCompareQuality(0.9),
      });
      await bootstrapper.migrate();

      // Progress to delegated
      await bootstrapper.recordEvaluation("formatting", 0.9);
      await bootstrapper.recordEvaluation("formatting", 0.9);
      await bootstrapper.recordEvaluation("formatting", 0.9);

      await bootstrapper.revertToFrontier(
        "formatting",
        "Manual Bar Raiser override",
      );

      const metric = await bootstrapper.getStatus("formatting");
      expect(metric!.delegation_status).toBe("frontier_only");
      expect(metric!.sample_count).toBe(0);
    });
  });

  describe("cost tracking", () => {
    it("calculates cost savings for delegated tasks", async () => {
      const bootstrapper = createBootstrapper({
        required_successes: 3,
        compareQuality: mockCompareQuality(0.9),
      });
      await bootstrapper.migrate();

      // Progress to delegated
      await bootstrapper.recordEvaluation("formatting", 0.9);
      await bootstrapper.recordEvaluation("formatting", 0.9);
      await bootstrapper.recordEvaluation("formatting", 0.9);

      const savings = await bootstrapper.getCostSavings();
      expect(savings.length).toBe(1);
      expect(savings[0].task_type).toBe("formatting");
      expect(savings[0].delegated_count).toBe(3);
      expect(savings[0].frontier_cost_per_task).toBe(0.005);
      expect(savings[0].local_cost_per_task).toBe(0.0);
      expect(savings[0].total_savings).toBeGreaterThan(0);
    });

    it("returns empty savings when no tasks delegated", async () => {
      const bootstrapper = createBootstrapper();
      await bootstrapper.migrate();

      const savings = await bootstrapper.getCostSavings();
      expect(savings).toEqual([]);
    });

    it("calculates correct savings amount", async () => {
      const bootstrapper = new ModelBootstrapper({
        pool,
        emitter,
        config: {
          required_successes: 2,
          frontier_cost_per_1k_tokens: 0.01,
          local_cost_per_1k_tokens: 0.001,
        },
        compareQuality: mockCompareQuality(0.95),
      });
      await bootstrapper.migrate();

      // Progress to delegated (shadow → candidate → delegated)
      await bootstrapper.recordEvaluation("routine_update", 0.95);
      await bootstrapper.recordEvaluation("routine_update", 0.95);
      await bootstrapper.recordEvaluation("routine_update", 0.95);

      const savings = await bootstrapper.getCostSavings();
      expect(savings.length).toBe(1);
      // 3 tasks × (0.01 - 0.001) = 0.027
      expect(savings[0].total_savings).toBeCloseTo(0.027, 3);
    });
  });

  describe("shadow evaluation", () => {
    it("compares frontier and local outputs and returns quality metrics", async () => {
      const bootstrapper = createBootstrapper({
        compareQuality: mockCompareQuality(0.88),
      });
      await bootstrapper.migrate();

      const result = await bootstrapper.shadowEvaluate(
        "formatting",
        "Frontier: Hello world",
        "Local: Hello world",
      );

      expect(result.task_type).toBe("formatting");
      expect(result.frontier_output).toBe("Frontier: Hello world");
      expect(result.local_output).toBe("Local: Hello world");
      expect(result.quality_score).toBe(0.88);
    });

    it("records evaluation automatically during shadow evaluate", async () => {
      const bootstrapper = createBootstrapper({
        compareQuality: mockCompareQuality(0.9),
      });
      await bootstrapper.migrate();

      await bootstrapper.shadowEvaluate("formatting", "a", "b");

      const metric = await bootstrapper.getStatus("formatting");
      expect(metric).not.toBeNull();
      expect(metric!.sample_count).toBe(1);
    });

    it("uses default compare quality when none injected", async () => {
      const bootstrapper = new ModelBootstrapper({
        pool,
        emitter,
      });
      await bootstrapper.migrate();

      const result = await bootstrapper.shadowEvaluate(
        "formatting",
        "The quick brown fox jumps over the lazy dog",
        "The quick brown fox jumps over the lazy dog",
      );

      // Identical outputs should have high quality score
      expect(result.quality_score).toBeGreaterThan(0.8);
      expect(result.semantic_similarity).toBeGreaterThan(0.8);
    });

    it("default compare gives lower score for very different outputs", async () => {
      const bootstrapper = new ModelBootstrapper({
        pool,
        emitter,
      });
      await bootstrapper.migrate();

      const result = await bootstrapper.shadowEvaluate(
        "formatting",
        "The quick brown fox",
        "Completely different text with no overlap whatsoever xyz abc",
      );

      expect(result.quality_score).toBeLessThan(0.5);
    });
  });

  describe("supervision sampling", () => {
    it("shouldSupervise returns boolean", () => {
      const bootstrapper = createBootstrapper();
      const result = bootstrapper.shouldSupervise();
      expect(typeof result).toBe("boolean");
    });

    it("supervision rate defaults to 0.1", () => {
      const bootstrapper = createBootstrapper();
      const config = bootstrapper.getConfig();
      expect(config.supervision_sample_rate).toBe(0.1);
    });
  });

  describe("getAllMetrics", () => {
    it("returns all tracked task types", async () => {
      const bootstrapper = createBootstrapper({
        compareQuality: mockCompareQuality(0.9),
      });
      await bootstrapper.migrate();

      await bootstrapper.recordEvaluation("formatting", 0.9);
      await bootstrapper.recordEvaluation("routine_update", 0.85);

      const metrics = await bootstrapper.getAllMetrics();
      expect(metrics.length).toBe(2);

      const taskTypes = metrics.map((m) => m.task_type).sort();
      expect(taskTypes).toEqual(["formatting", "routine_update"]);
    });
  });

  describe("configuration", () => {
    it("uses default config values", () => {
      const bootstrapper = new ModelBootstrapper({
        pool,
        emitter,
      });
      const config = bootstrapper.getConfig();
      expect(config.quality_threshold).toBe(0.85);
      expect(config.required_successes).toBe(10);
      expect(config.supervision_sample_rate).toBe(0.1);
      expect(config.frontier_cost_per_1k_tokens).toBe(0.005);
      expect(config.local_cost_per_1k_tokens).toBe(0.0);
    });

    it("accepts custom config overrides", () => {
      const bootstrapper = new ModelBootstrapper({
        pool,
        emitter,
        config: {
          quality_threshold: 0.9,
          required_successes: 20,
        },
      });
      const config = bootstrapper.getConfig();
      expect(config.quality_threshold).toBe(0.9);
      expect(config.required_successes).toBe(20);
      // Defaults preserved for non-overridden values
      expect(config.supervision_sample_rate).toBe(0.1);
    });
  });

  describe("telemetry", () => {
    it("emits telemetry for shadow evaluation", async () => {
      const localEmitter = new TelemetryEmitter(tempDir);
      const bootstrapper = new ModelBootstrapper({
        pool,
        emitter: localEmitter,
        compareQuality: mockCompareQuality(0.9),
      });
      await bootstrapper.migrate();

      await bootstrapper.shadowEvaluate("formatting", "frontier", "local");

      const events = await localEmitter.readEvents(new Date());
      const shadowEvents = events.filter(
        (e) => e.event_subtype === "model_bootstrapper_shadow_evaluate",
      );
      expect(shadowEvents.length).toBeGreaterThanOrEqual(1);

      const latest = shadowEvents[shadowEvents.length - 1];
      expect(latest.agent_name).toBe("knowledge_agent");
      expect(latest.outcome).toBe("success");
      expect(latest.metadata).toHaveProperty("task_type", "formatting");
      expect(latest.metadata).toHaveProperty("quality_score", 0.9);
    });

    it("emits telemetry for Bar Raiser revert", async () => {
      const localEmitter = new TelemetryEmitter(tempDir);
      const bootstrapper = new ModelBootstrapper({
        pool,
        emitter: localEmitter,
        config: { required_successes: 3 },
        compareQuality: mockCompareQuality(0.9),
      });
      await bootstrapper.migrate();

      // Progress to delegated
      await bootstrapper.recordEvaluation("formatting", 0.9);
      await bootstrapper.recordEvaluation("formatting", 0.9);
      await bootstrapper.recordEvaluation("formatting", 0.9);

      // Trigger revert
      await bootstrapper.recordEvaluation("formatting", 0.5);

      const events = await localEmitter.readEvents(new Date());
      const revertEvents = events.filter(
        (e) => e.event_subtype === "model_bootstrapper_bar_raiser_revert",
      );
      expect(revertEvents.length).toBeGreaterThanOrEqual(1);

      const latest = revertEvents[revertEvents.length - 1];
      expect(latest.outcome).toBe("success");
      expect(latest.metadata).toHaveProperty("task_type", "formatting");
      expect(latest.metadata).toHaveProperty("quality_score", 0.5);
      expect(latest.metadata).toHaveProperty("reason");
    });

    it("emits telemetry for record evaluation", async () => {
      const localEmitter = new TelemetryEmitter(tempDir);
      const bootstrapper = new ModelBootstrapper({
        pool,
        emitter: localEmitter,
        compareQuality: mockCompareQuality(0.9),
      });
      await bootstrapper.migrate();

      await bootstrapper.recordEvaluation("formatting", 0.9);

      const events = await localEmitter.readEvents(new Date());
      const evalEvents = events.filter(
        (e) => e.event_subtype === "model_bootstrapper_record_evaluation",
      );
      expect(evalEvents.length).toBeGreaterThanOrEqual(1);

      const latest = evalEvents[evalEvents.length - 1];
      expect(latest.metadata).toHaveProperty("delegation_status", "shadow_testing");
      expect(latest.metadata).toHaveProperty("previous_status", "none");
    });
  });

  describe("error handling", () => {
    it("getStatus returns null for unknown task type", async () => {
      const bootstrapper = createBootstrapper();
      await bootstrapper.migrate();

      const status = await bootstrapper.getStatus("formatting");
      expect(status).toBeNull();
    });

    it("getCostSavings returns empty array on error", async () => {
      // Use a bad pool
      const badPool = createPool("postgres://localhost:1/nonexistent_db");
      const bootstrapper = new ModelBootstrapper({
        pool: badPool,
        emitter,
      });

      const savings = await bootstrapper.getCostSavings();
      expect(savings).toEqual([]);

      await badPool.end();
    });

    it("getAllMetrics returns empty array on error", async () => {
      const badPool = createPool("postgres://localhost:1/nonexistent_db");
      const bootstrapper = new ModelBootstrapper({
        pool: badPool,
        emitter,
      });

      const metrics = await bootstrapper.getAllMetrics();
      expect(metrics).toEqual([]);

      await badPool.end();
    });
  });

  describe("quality score tracking", () => {
    it("maintains running average quality score", async () => {
      const bootstrapper = createBootstrapper({
        compareQuality: mockCompareQuality(0.9),
      });
      await bootstrapper.migrate();

      // Score 0.9
      await bootstrapper.recordEvaluation("formatting", 0.9);
      let metric = await bootstrapper.getStatus("formatting");
      expect(metric!.quality_score).toBeCloseTo(0.9, 2);

      // Score 0.8 — average should be (0.9 + 0.8) / 2 = 0.85
      await bootstrapper.recordEvaluation("formatting", 0.8);
      metric = await bootstrapper.getStatus("formatting");
      expect(metric!.quality_score).toBeCloseTo(0.85, 2);
    });
  });
});
