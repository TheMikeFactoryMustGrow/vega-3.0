import { z } from "zod";

/**
 * VEGA v3.3 Loop 2: Pattern Learning — Weekly Reflection Types
 *
 * Defines the schema for weekly agent reflections and Bar Raiser synthesis.
 * Each agent generates a weekly reflection summarizing its operational patterns,
 * recurring issues, and improvement opportunities. The Bar Raiser synthesizes
 * all agent reflections into a cross-agent learning digest.
 */

// ─── Weekly Reflection Sections ─────────────────────────────────────────────

export const WeekSummarySchema = z.object({
  total_actions: z.number().int().nonnegative(),
  success_rate: z.number().min(0).max(1),
  error_count: z.number().int().nonnegative(),
  avg_latency_ms: z.number().nonnegative().nullable(),
  total_cost_usd: z.number().nonnegative(),
  performance_score_avg: z.number().min(0).max(1).nullable(),
});

export type WeekSummary = z.infer<typeof WeekSummarySchema>;

export const ReflectionSectionSchema = z.object({
  what_worked_well: z.array(z.string()),
  what_didnt_work: z.array(z.string()),
  patterns_noticed: z.array(z.string()),
  proposed_adjustments: z.array(z.string()),
  questions_for_bar_raiser: z.array(z.string()),
});

export type ReflectionSection = z.infer<typeof ReflectionSectionSchema>;

// ─── Weekly Reflection ──────────────────────────────────────────────────────

export const WeeklyReflectionSchema = z.object({
  agent_name: z.string().min(1),
  week_start: z.coerce.date(),
  week_end: z.coerce.date(),
  generated_at: z.coerce.date(),
  summary: WeekSummarySchema,
  reflection: ReflectionSectionSchema,
  markdown: z.string(),
});

export type WeeklyReflection = z.infer<typeof WeeklyReflectionSchema>;

// ─── Cross-Agent Pattern ────────────────────────────────────────────────────

export const CrossAgentPatternSchema = z.object({
  pattern_type: z.enum([
    "shared_improvement",
    "shared_degradation",
    "contradiction",
    "complementary",
  ]),
  agents_involved: z.array(z.string().min(1)).min(2),
  description: z.string().min(1),
  evidence: z.string().min(1),
  severity: z.enum(["info", "warning", "critical"]),
});

export type CrossAgentPattern = z.infer<typeof CrossAgentPatternSchema>;

// ─── Bar Raiser Weekly Synthesis ────────────────────────────────────────────

export const BarRaiserSynthesisSchema = z.object({
  week_start: z.coerce.date(),
  week_end: z.coerce.date(),
  generated_at: z.coerce.date(),
  agents_included: z.array(z.string().min(1)),
  cross_agent_patterns: z.array(CrossAgentPatternSchema),
  contradictions: z.array(CrossAgentPatternSchema),
  overall_system_health: z.string().min(1),
  recommendations: z.array(z.string()),
  markdown: z.string(),
});

export type BarRaiserSynthesis = z.infer<typeof BarRaiserSynthesisSchema>;
