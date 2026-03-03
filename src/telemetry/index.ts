export { TelemetryEmitter } from "./emitter.js";
export { runRotation, type RotationResult } from "./rotation.js";
export {
  TelemetryEventSchema,
  EventType,
  type TelemetryEvent,
  type TelemetryEventInput,
} from "./types.js";

// Tier 2 — PostgreSQL aggregation tables
export { createPool, runTier2Migration, dropTier2Tables } from "./database.js";
export { Tier2Repository } from "./tier2-repository.js";

// Aggregation jobs
export {
  runHourlyAggregation,
  runDailyAggregation,
  backfillHourly,
  backfillDaily,
  type AggregationResult,
} from "./aggregation.js";
export {
  AgentHourlySchema,
  CostDailySchema,
  QualityDailySchema,
  AnomalySchema,
  TrendDirection,
  AnomalySeverity,
  type AgentHourly,
  type AgentHourlyInput,
  type CostDaily,
  type CostDailyInput,
  type QualityDaily,
  type QualityDailyInput,
  type Anomaly,
  type AnomalyInput,
} from "./tier2-types.js";

// Morning Brief — System Health
export {
  MorningBriefHealth,
  type SystemHealthSection,
} from "./morning-brief-health.js";

// Loop 1 — Operational Learning (Self-Assessment)
export { SelfAssessmentRunner } from "./self-assessment-runner.js";
export {
  SelfAssessmentConfigSchema,
  AdjustmentRuleSchema,
  RuleConditionSchema,
  MetricValueConditionSchema,
  TrendConditionSchema,
  ThresholdConditionSchema,
  SelfAssessmentResultSchema,
  AdjustmentResultSchema,
  type SelfAssessmentConfig,
  type AdjustmentRule,
  type RuleCondition,
  type SelfAssessmentResult,
  type AdjustmentResult,
} from "./self-assessment-types.js";

// Loop 2 — Pattern Learning (Weekly Reflections)
export { WeeklyReflectionGenerator } from "./weekly-reflection.js";
export {
  WeekSummarySchema,
  ReflectionSectionSchema,
  WeeklyReflectionSchema,
  CrossAgentPatternSchema,
  BarRaiserSynthesisSchema,
  type WeekSummary,
  type ReflectionSection,
  type WeeklyReflection,
  type CrossAgentPattern,
  type BarRaiserSynthesis,
} from "./weekly-reflection-types.js";
