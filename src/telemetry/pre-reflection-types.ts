import { z } from "zod";

/**
 * VEGA v3.3 Loop 1.5: Agent-Local Pre-Reflection Types
 *
 * Defines the schema for pre-reflection digests that agents produce
 * by analyzing their own Tier 1 JSONL event history. Pre-reflections
 * bridge raw event data (Tier 1) and weekly pattern analysis (Loop 2).
 *
 * Key constraint: pre-reflections use ONLY local model (qwen3:32b),
 * never frontier models.
 */

// ─── Event Summary ───────────────────────────────────────────────────────────

export const EventTypeSummarySchema = z.object({
  event_type: z.string(),
  count: z.number().int().nonnegative(),
  success_count: z.number().int().nonnegative(),
  failure_count: z.number().int().nonnegative(),
});

export type EventTypeSummary = z.infer<typeof EventTypeSummarySchema>;

export const TimeDistributionSchema = z.object({
  hour: z.number().int().min(0).max(23),
  count: z.number().int().nonnegative(),
});

export type TimeDistribution = z.infer<typeof TimeDistributionSchema>;

export const EventSummarySchema = z.object({
  total_events: z.number().int().nonnegative(),
  by_type: z.array(EventTypeSummarySchema),
  time_distribution: z.array(TimeDistributionSchema),
  date_range_start: z.string(),
  date_range_end: z.string(),
});

export type EventSummary = z.infer<typeof EventSummarySchema>;

// ─── Notable Failures ────────────────────────────────────────────────────────

export const NotableFailureSchema = z.object({
  event_subtype: z.string(),
  count: z.number().int().positive(),
  sample_event_id: z.string(),
  sample_timestamp: z.string(),
  root_cause_analysis: z.string(),
});

export type NotableFailure = z.infer<typeof NotableFailureSchema>;

// ─── Recurring Patterns ──────────────────────────────────────────────────────

export const RecurringPatternSchema = z.object({
  pattern_type: z.string(),
  description: z.string(),
  frequency: z.number().int().positive(),
  evidence: z.string(),
});

export type RecurringPattern = z.infer<typeof RecurringPatternSchema>;

// ─── Confidence Calibration ──────────────────────────────────────────────────

export const ConfidenceCalibrationSchema = z.object({
  total_predictions: z.number().int().nonnegative(),
  correct_predictions: z.number().int().nonnegative(),
  accuracy: z.number().min(0).max(1),
  overconfident_count: z.number().int().nonnegative(),
  underconfident_count: z.number().int().nonnegative(),
});

export type ConfidenceCalibration = z.infer<typeof ConfidenceCalibrationSchema>;

// ─── Pre-Reflection Digest ───────────────────────────────────────────────────

export const PreReflectionDigestSchema = z.object({
  agent_name: z.string().min(1),
  generated_at: z.coerce.date(),
  model_used: z.literal("qwen3:32b"),
  event_summary: EventSummarySchema,
  notable_failures: z.array(NotableFailureSchema),
  recurring_patterns: z.array(RecurringPatternSchema),
  confidence_calibration: ConfidenceCalibrationSchema,
  external_blame_detected: z.boolean(),
  markdown: z.string(),
});

export type PreReflectionDigest = z.infer<typeof PreReflectionDigestSchema>;

// ─── Trigger Check Result ────────────────────────────────────────────────────

export const TriggerCheckResultSchema = z.object({
  should_trigger: z.boolean(),
  reason: z.string(),
  events_since_last: z.number().int().nonnegative(),
  hours_until_deadline: z.number().nullable(),
});

export type TriggerCheckResult = z.infer<typeof TriggerCheckResultSchema>;

// ─── Pre-Reflection Options ──────────────────────────────────────────────────

export const PreReflectionOptionsSchema = z.object({
  event_threshold: z.number().int().positive().default(100),
  hours_before_deadline: z.number().positive().default(24),
  weekly_deadline_day: z.number().int().min(0).max(6).default(0), // 0 = Sunday
  weekly_deadline_hour: z.number().int().min(0).max(23).default(20), // 20:00 UTC
  emitTelemetry: z.boolean().default(true),
});

export type PreReflectionOptions = z.input<typeof PreReflectionOptionsSchema>;
