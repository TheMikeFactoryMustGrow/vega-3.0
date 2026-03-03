import { z } from "zod";

/**
 * VEGA v3.3 Cross-Agent Pattern Mining — Types
 *
 * Infrastructure for Phase 4+ cross-agent pattern detection.
 * The PatternMiner analyzes centralized Tier 2 telemetry and Loop 2 reflections
 * across all agents to detect behavioral patterns invisible to individual agents.
 *
 * Four pattern types detected:
 * 1. demand_clustering — agents frequently invoked in sequence
 * 2. resource_contention — agents querying overlapping data at overlapping times
 * 3. complementary_gap — one agent's output frequently becomes another's input
 * 4. drift_correlation — correlated metric changes across agents
 */

// ─── Pattern Types ──────────────────────────────────────────────────────────

export const PatternType = z.enum([
  "demand_clustering",
  "resource_contention",
  "complementary_gap",
  "drift_correlation",
]);
export type PatternType = z.infer<typeof PatternType>;

// ─── Detected Pattern ───────────────────────────────────────────────────────

export const DetectedPatternSchema = z.object({
  type: PatternType,
  agents: z.array(z.string().min(1)).min(2),
  evidence: z.string().min(1),
  frequency: z.number().int().nonnegative(),
  suggested_action: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export type DetectedPattern = z.infer<typeof DetectedPatternSchema>;

// ─── Proactive Artifact Candidate ───────────────────────────────────────────

export const ProactiveArtifactSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  source_pattern: PatternType,
  agents_involved: z.array(z.string().min(1)),
  requires_mike_approval: z.literal(true),
});

export type ProactiveArtifact = z.infer<typeof ProactiveArtifactSchema>;

// ─── Pattern Mining Report ──────────────────────────────────────────────────

export const PatternMiningReportSchema = z.object({
  date: z.coerce.date(),
  generated_at: z.coerce.date(),
  agents_analyzed: z.array(z.string().min(1)),

  detected_patterns: z.array(DetectedPatternSchema),
  proactive_artifact_candidates: z.array(ProactiveArtifactSchema),
  no_action_patterns: z.array(z.string()),

  activation_flag: z.boolean(),
  markdown: z.string(),
});

export type PatternMiningReport = z.infer<typeof PatternMiningReportSchema>;

// ─── Pattern Miner Configuration ────────────────────────────────────────────

export const PatternMinerConfigSchema = z.object({
  /** Master activation flag. Default: disabled. Flip to true in Phase 4. */
  enabled: z.boolean().default(false),

  /** Minimum weeks of Tier 2 data required before activation (default: 8). */
  min_weeks_data: z.number().int().positive().default(8),

  /** Demand clustering: minimum sequence occurrences to flag (default: 5). */
  demand_clustering_min_occurrences: z.number().int().positive().default(5),

  /** Resource contention: minimum overlapping hour count (default: 10). */
  resource_contention_min_overlaps: z.number().int().positive().default(10),

  /** Complementary gap: minimum output→input correlation (default: 0.6). */
  complementary_gap_min_correlation: z.number().min(0).max(1).default(0.6),

  /** Drift correlation: minimum metric correlation coefficient (default: 0.7). */
  drift_correlation_min_coefficient: z.number().min(0).max(1).default(0.7),

  /** Lookback window in days for analysis (default: 30). */
  lookback_days: z.number().int().positive().default(30),

  /** Model to use for analysis (frontier model). */
  model: z.string().default("grok-4-1-fast-reasoning"),
}).default({});

export type PatternMinerConfig = z.infer<typeof PatternMinerConfigSchema>;
