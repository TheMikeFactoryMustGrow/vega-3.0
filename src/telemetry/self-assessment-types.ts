import { z } from "zod";

/**
 * VEGA v3.3 Loop 1: Operational Learning — Self-Assessment Types
 *
 * Defines the self_assessment YAML block schema for agent identity files.
 * Each agent can include a self_assessment block that specifies:
 * - How often to self-assess (frequency)
 * - What metrics to query (metrics_query — SQL against telemetry_quality_daily)
 * - Rules for automated adjustments (adjustment_rules)
 * - The current reasoning prompt injection text (reasoning_prompt_injection)
 */

// ─── Condition Types ──────────────────────────────────────────────────────────

/** Condition: compare a numeric field from query results using an operator */
export const MetricValueConditionSchema = z.object({
  type: z.literal("metric_value"),
  field: z.string().min(1),
  operator: z.enum(["<", ">", "=", "<=", ">="]),
  value: z.number(),
});

/** Condition: check the trend direction of a metric */
export const TrendConditionSchema = z.object({
  type: z.literal("trend"),
  field: z.string().default("trend"),
  equals: z.enum(["improving", "stable", "declining"]),
});

/** Condition: check that a numeric field falls within min/max bounds */
export const ThresholdConditionSchema = z.object({
  type: z.literal("threshold"),
  field: z.string().min(1),
  min: z.number().optional(),
  max: z.number().optional(),
});

export const RuleConditionSchema = z.discriminatedUnion("type", [
  MetricValueConditionSchema,
  TrendConditionSchema,
  ThresholdConditionSchema,
]);

export type RuleCondition = z.infer<typeof RuleConditionSchema>;

// ─── Adjustment Rule ──────────────────────────────────────────────────────────

export const AdjustmentRuleSchema = z.object({
  name: z.string().min(1),
  condition: RuleConditionSchema,
  action: z.object({
    type: z.literal("update_prompt"),
    new_prompt: z.string().min(1),
  }),
});

export type AdjustmentRule = z.infer<typeof AdjustmentRuleSchema>;

// ─── Self-Assessment Config ───────────────────────────────────────────────────

export const SelfAssessmentConfigSchema = z.object({
  frequency: z.string().min(1),
  metrics_query: z.string().min(1),
  adjustment_rules: z.array(AdjustmentRuleSchema).min(1),
  reasoning_prompt_injection: z.string(),
});

export type SelfAssessmentConfig = z.infer<typeof SelfAssessmentConfigSchema>;

// ─── Runner Result Types ──────────────────────────────────────────────────────

export const AdjustmentResultSchema = z.object({
  rule_name: z.string(),
  triggered: z.boolean(),
  condition_met: z.boolean(),
  overridden: z.boolean(),
  before_prompt: z.string(),
  after_prompt: z.string(),
});

export type AdjustmentResult = z.infer<typeof AdjustmentResultSchema>;

export const SelfAssessmentResultSchema = z.object({
  agent_name: z.string(),
  ran_at: z.coerce.date(),
  metrics_query_rows: z.number().int().nonnegative(),
  rules_evaluated: z.number().int().nonnegative(),
  rules_triggered: z.number().int().nonnegative(),
  rules_overridden: z.number().int().nonnegative(),
  adjustments: z.array(AdjustmentResultSchema),
  final_prompt: z.string(),
});

export type SelfAssessmentResult = z.infer<typeof SelfAssessmentResultSchema>;
