import pg from "pg";
import { TelemetryEmitter } from "../telemetry/emitter.js";
import { ModelRouter, type TaskType, type RoutingDecision } from "./model-router.js";

const { Pool } = pg;

/**
 * ModelBootstrapper — Performance-based supervision loop for frontier → local delegation.
 *
 * Implements the 5-step supervision loop per Implementation Guide (lines 789-837):
 *   1. Frontier does work first — all tasks start on frontier model
 *   2. Local attempts same task (shadow mode) — output NOT used
 *   3. Quality comparison — configurable quality metrics
 *   4. If local quality meets threshold → mark 'local_candidate'
 *   5. After N successful evaluations → delegate to local with permanent supervision
 *
 * Bar Raiser monitoring: auto-reverts to frontier_only if quality drops.
 * Cost tracking: tracks savings from delegation (frontier - local cost per task).
 *
 * PostgreSQL table: model_quality_metrics
 */

export type DelegationStatus =
  | "frontier_only"
  | "shadow_testing"
  | "local_candidate"
  | "delegated";

export interface QualityMetric {
  task_type: string;
  model: string;
  quality_score: number;
  sample_count: number;
  delegation_status: DelegationStatus;
  last_evaluated: Date;
}

export interface ComparisonResult {
  task_type: TaskType;
  frontier_output: string;
  local_output: string;
  quality_score: number;
  semantic_similarity: number;
  structural_match: number;
  correctness: number;
}

export interface CostSavings {
  task_type: string;
  delegated_count: number;
  frontier_cost_per_task: number;
  local_cost_per_task: number;
  total_savings: number;
}

export interface BootstrapperConfig {
  quality_threshold: number;
  required_successes: number;
  supervision_sample_rate: number;
  frontier_cost_per_1k_tokens: number;
  local_cost_per_1k_tokens: number;
}

export interface ModelBootstrapperOptions {
  pool?: pg.Pool;
  connectionString?: string;
  emitter?: TelemetryEmitter;
  router?: ModelRouter;
  config?: Partial<BootstrapperConfig>;
  /** Injectable quality comparison function for testing */
  compareQuality?: (
    taskType: TaskType,
    frontierOutput: string,
    localOutput: string,
  ) => Promise<ComparisonResult>;
}

const DEFAULT_CONFIG: BootstrapperConfig = {
  quality_threshold: 0.85,
  required_successes: 10,
  supervision_sample_rate: 0.1,
  frontier_cost_per_1k_tokens: 0.005,
  local_cost_per_1k_tokens: 0.0,
};

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS model_quality_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type VARCHAR NOT NULL,
  model VARCHAR NOT NULL,
  quality_score FLOAT NOT NULL DEFAULT 0,
  sample_count INT NOT NULL DEFAULT 0,
  delegation_status VARCHAR NOT NULL DEFAULT 'frontier_only',
  last_evaluated TIMESTAMP NOT NULL DEFAULT now(),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(task_type, model)
);

CREATE INDEX IF NOT EXISTS idx_model_quality_task
  ON model_quality_metrics(task_type);
CREATE INDEX IF NOT EXISTS idx_model_quality_status
  ON model_quality_metrics(delegation_status);
`;

export class ModelBootstrapper {
  private readonly pool: pg.Pool;
  private readonly emitter: TelemetryEmitter;
  private readonly router: ModelRouter;
  private readonly config: BootstrapperConfig;
  private readonly sessionId: string;
  private readonly compareQualityFn: (
    taskType: TaskType,
    frontierOutput: string,
    localOutput: string,
  ) => Promise<ComparisonResult>;

  constructor(options?: ModelBootstrapperOptions) {
    this.pool =
      options?.pool ??
      new Pool({
        connectionString:
          options?.connectionString ??
          process.env.VEGA_PG_URL ??
          "postgres://localhost/vega_db",
        max: 3,
      });
    this.emitter = options?.emitter ?? new TelemetryEmitter();
    this.router = options?.router ?? new ModelRouter({ emitter: this.emitter });
    this.config = { ...DEFAULT_CONFIG, ...options?.config };
    this.sessionId = `bootstrapper-${Date.now()}`;
    this.compareQualityFn =
      options?.compareQuality ?? this.defaultCompareQuality.bind(this);
  }

  /**
   * Run schema migration — creates model_quality_metrics table.
   * Idempotent: safe to run multiple times.
   */
  async migrate(): Promise<void> {
    await this.pool.query(MIGRATION_SQL);
  }

  /**
   * Get the current delegation status for a task type.
   * Returns null if not yet tracked.
   */
  async getStatus(taskType: TaskType): Promise<QualityMetric | null> {
    try {
      const result = await this.pool.query(
        `SELECT task_type, model, quality_score, sample_count,
                delegation_status, last_evaluated
         FROM model_quality_metrics
         WHERE task_type = $1
         ORDER BY updated_at DESC
         LIMIT 1`,
        [taskType],
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        task_type: row.task_type,
        model: row.model,
        quality_score: Number(row.quality_score),
        sample_count: Number(row.sample_count),
        delegation_status: row.delegation_status as DelegationStatus,
        last_evaluated: new Date(row.last_evaluated),
      };
    } catch {
      return null;
    }
  }

  /**
   * Step 1-3: Run shadow evaluation — frontier processes the task,
   * local processes in parallel (shadow mode), then compare quality.
   *
   * Returns the comparison result. The local output is NOT used for the final answer.
   */
  async shadowEvaluate(
    taskType: TaskType,
    frontierOutput: string,
    localOutput: string,
  ): Promise<ComparisonResult> {
    const start = Date.now();

    try {
      const result = await this.compareQualityFn(
        taskType,
        frontierOutput,
        localOutput,
      );

      // Record the evaluation
      await this.recordEvaluation(taskType, result.quality_score);

      await this.emitEvent("shadow_evaluate", "success", Date.now() - start, {
        task_type: taskType,
        quality_score: result.quality_score,
        semantic_similarity: result.semantic_similarity,
        structural_match: result.structural_match,
        correctness: result.correctness,
      });

      return result;
    } catch (err) {
      await this.emitEvent("shadow_evaluate", "failure", Date.now() - start, {
        task_type: taskType,
        error: String(err),
      });

      throw err;
    }
  }

  /**
   * Step 4-5: Record evaluation result and potentially progress delegation status.
   *
   * Status progression:
   *   frontier_only → shadow_testing (first evaluation)
   *   shadow_testing → local_candidate (quality >= threshold)
   *   local_candidate → delegated (N successful evaluations)
   *
   * Bar Raiser: if delegated and quality drops → revert to frontier_only.
   */
  async recordEvaluation(
    taskType: TaskType,
    qualityScore: number,
  ): Promise<DelegationStatus> {
    const start = Date.now();

    try {
      const current = await this.getStatus(taskType);
      let newStatus: DelegationStatus;
      let newSampleCount: number;
      let model: string;

      if (!current) {
        // First evaluation — move to shadow_testing
        newStatus = "shadow_testing";
        newSampleCount = 1;
        model = "qwen3:32b";
      } else {
        newSampleCount = current.sample_count + 1;
        model = current.model;

        switch (current.delegation_status) {
          case "frontier_only":
            // Start shadow testing
            newStatus = "shadow_testing";
            break;

          case "shadow_testing":
            if (qualityScore >= this.config.quality_threshold) {
              newStatus = "local_candidate";
            } else {
              newStatus = "shadow_testing";
            }
            break;

          case "local_candidate":
            if (qualityScore < this.config.quality_threshold) {
              // Quality dropped — revert to shadow_testing
              newStatus = "shadow_testing";
              newSampleCount = 0;
            } else if (newSampleCount >= this.config.required_successes) {
              // Enough successful evaluations — delegate!
              newStatus = "delegated";
            } else {
              newStatus = "local_candidate";
            }
            break;

          case "delegated":
            if (qualityScore < this.config.quality_threshold) {
              // Bar Raiser: quality dropped — auto-revert
              newStatus = "frontier_only";
              newSampleCount = 0;

              await this.emitEvent(
                "bar_raiser_revert",
                "success",
                Date.now() - start,
                {
                  task_type: taskType,
                  quality_score: qualityScore,
                  threshold: this.config.quality_threshold,
                  reason: "Quality dropped below threshold on delegated task",
                },
              );
            } else {
              newStatus = "delegated";
            }
            break;

          default:
            newStatus = "frontier_only";
        }
      }

      // Compute running average quality score
      const avgScore = current
        ? (current.quality_score * current.sample_count + qualityScore) /
          (current.sample_count + 1)
        : qualityScore;

      await this.upsertMetric(
        taskType,
        model,
        Math.round(avgScore * 1000) / 1000,
        newSampleCount,
        newStatus,
      );

      await this.emitEvent("record_evaluation", "success", Date.now() - start, {
        task_type: taskType,
        quality_score: qualityScore,
        avg_score: Math.round(avgScore * 1000) / 1000,
        sample_count: newSampleCount,
        delegation_status: newStatus,
        previous_status: current?.delegation_status ?? "none",
      });

      return newStatus;
    } catch (err) {
      await this.emitEvent("record_evaluation", "failure", Date.now() - start, {
        task_type: taskType,
        error: String(err),
      });

      return "frontier_only";
    }
  }

  /**
   * Check if a task should be supervised (spot-checked) during delegation.
   * Returns true supervision_sample_rate fraction of the time (default 10%).
   */
  shouldSupervise(): boolean {
    return Math.random() < this.config.supervision_sample_rate;
  }

  /**
   * Calculate cost savings from delegating tasks to local model.
   */
  async getCostSavings(): Promise<CostSavings[]> {
    try {
      const result = await this.pool.query(
        `SELECT task_type, sample_count, delegation_status
         FROM model_quality_metrics
         WHERE delegation_status = 'delegated'`,
      );

      return result.rows.map((row) => {
        const delegatedCount = Number(row.sample_count);
        const frontierCost =
          delegatedCount * this.config.frontier_cost_per_1k_tokens;
        const localCost =
          delegatedCount * this.config.local_cost_per_1k_tokens;
        return {
          task_type: row.task_type,
          delegated_count: delegatedCount,
          frontier_cost_per_task: this.config.frontier_cost_per_1k_tokens,
          local_cost_per_task: this.config.local_cost_per_1k_tokens,
          total_savings: Math.round((frontierCost - localCost) * 10000) / 10000,
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Get all tracked task types and their delegation statuses.
   */
  async getAllMetrics(): Promise<QualityMetric[]> {
    try {
      const result = await this.pool.query(
        `SELECT task_type, model, quality_score, sample_count,
                delegation_status, last_evaluated
         FROM model_quality_metrics
         ORDER BY task_type`,
      );

      return result.rows.map((row) => ({
        task_type: row.task_type,
        model: row.model,
        quality_score: Number(row.quality_score),
        sample_count: Number(row.sample_count),
        delegation_status: row.delegation_status as DelegationStatus,
        last_evaluated: new Date(row.last_evaluated),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Manually revert a task type to frontier_only.
   * Used by Bar Raiser for manual interventions.
   */
  async revertToFrontier(taskType: TaskType, reason: string): Promise<void> {
    const start = Date.now();

    try {
      await this.pool.query(
        `UPDATE model_quality_metrics
         SET delegation_status = 'frontier_only',
             sample_count = 0,
             updated_at = now()
         WHERE task_type = $1`,
        [taskType],
      );

      await this.emitEvent(
        "manual_revert",
        "success",
        Date.now() - start,
        { task_type: taskType, reason },
      );
    } catch (err) {
      await this.emitEvent(
        "manual_revert",
        "failure",
        Date.now() - start,
        { task_type: taskType, reason, error: String(err) },
      );
    }
  }

  /** Get the bootstrapper configuration */
  getConfig(): Readonly<BootstrapperConfig> {
    return this.config;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async upsertMetric(
    taskType: string,
    model: string,
    qualityScore: number,
    sampleCount: number,
    delegationStatus: DelegationStatus,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO model_quality_metrics
         (task_type, model, quality_score, sample_count, delegation_status, last_evaluated, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())
       ON CONFLICT (task_type, model) DO UPDATE SET
         quality_score = EXCLUDED.quality_score,
         sample_count = EXCLUDED.sample_count,
         delegation_status = EXCLUDED.delegation_status,
         last_evaluated = EXCLUDED.last_evaluated,
         updated_at = EXCLUDED.updated_at`,
      [taskType, model, qualityScore, sampleCount, delegationStatus],
    );
  }

  /**
   * Default quality comparison — uses simple heuristics.
   * In production, this would use embedding similarity + structural checks.
   */
  private async defaultCompareQuality(
    taskType: TaskType,
    frontierOutput: string,
    localOutput: string,
  ): Promise<ComparisonResult> {
    // Simple length-ratio similarity
    const lenRatio =
      Math.min(frontierOutput.length, localOutput.length) /
      Math.max(frontierOutput.length, localOutput.length || 1);

    // Simple word overlap (Jaccard similarity)
    const frontierWords = new Set(frontierOutput.toLowerCase().split(/\s+/));
    const localWords = new Set(localOutput.toLowerCase().split(/\s+/));
    const intersection = new Set(
      [...frontierWords].filter((w) => localWords.has(w)),
    );
    const union = new Set([...frontierWords, ...localWords]);
    const jaccard = union.size > 0 ? intersection.size / union.size : 0;

    // Structural match: JSON parseable check
    let structuralMatch = 0.5;
    try {
      JSON.parse(frontierOutput);
      try {
        JSON.parse(localOutput);
        structuralMatch = 1.0;
      } catch {
        structuralMatch = 0.0;
      }
    } catch {
      // Neither is JSON — structural match based on line count similarity
      const frontierLines = frontierOutput.split("\n").length;
      const localLines = localOutput.split("\n").length;
      structuralMatch =
        Math.min(frontierLines, localLines) /
        Math.max(frontierLines, localLines || 1);
    }

    const semanticSimilarity = (lenRatio + jaccard) / 2;
    const correctness = jaccard;
    const qualityScore =
      semanticSimilarity * 0.4 + structuralMatch * 0.3 + correctness * 0.3;

    return {
      task_type: taskType,
      frontier_output: frontierOutput,
      local_output: localOutput,
      quality_score: Math.round(qualityScore * 1000) / 1000,
      semantic_similarity: Math.round(semanticSimilarity * 1000) / 1000,
      structural_match: Math.round(structuralMatch * 1000) / 1000,
      correctness: Math.round(correctness * 1000) / 1000,
    };
  }

  private async emitEvent(
    subtype: string,
    outcome: "success" | "failure" | "partial" | "skipped",
    latencyMs: number,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_write",
        event_subtype: `model_bootstrapper_${subtype}`,
        session_id: this.sessionId,
        outcome,
        latency_ms: latencyMs,
        metadata,
      });
    } catch {
      // Non-blocking: telemetry failure never blocks operations
    }
  }
}
