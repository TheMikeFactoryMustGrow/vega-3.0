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

// Bar Raiser Learning Monitors
export { BarRaiserMonitor } from "./bar-raiser-monitor.js";
export {
  DetectionPatternType,
  MetricGamingSubtype,
  ScopeCreepSubtype,
  ConfirmationBiasSubtype,
  DetectionSchema,
  MonitorConfigSchema,
  MonitorReportSchema,
  type Detection,
  type MonitorConfig,
  type MonitorReport,
} from "./bar-raiser-monitor-types.js";

// iCloud Sync Handler
export {
  materialize_icloud_stubs,
  find_icloud_stubs,
  get_materialized_path,
  type MaterializationReport,
  type MaterializationResult,
  type MaterializeOptions,
} from "./icloud-sync.js";

// YAML Frontmatter Validation
export { FrontmatterValidator } from "./frontmatter-validator.js";
export {
  NoteType,
  TruthTier,
  EntityType,
  ClaimFrontmatterSchema,
  EntityFrontmatterSchema,
  SourceFrontmatterSchema,
  OpenQuestionFrontmatterSchema,
  BetFrontmatterSchema,
  MOCFrontmatterSchema,
  FrontmatterSchemas,
  ValidationErrorSchema,
  ValidationResultSchema,
  EscalationLevel,
  type ClaimFrontmatter,
  type EntityFrontmatter,
  type SourceFrontmatter,
  type OpenQuestionFrontmatter,
  type BetFrontmatter,
  type MOCFrontmatter,
  type NoteType as NoteTypeType,
  type ValidationError,
  type ValidationResult,
} from "./frontmatter-validator-types.js";

// Loop 3 — Structural Learning (Monthly Reviews with Bet Tracking)
export { MonthlyReviewGenerator } from "./monthly-review.js";
export {
  BetStatus,
  BetSchema,
  BetInputSchema,
  StructuralProposalSchema,
  BetOutcomeSchema,
  MonthlyTrendSummarySchema,
  MonthlyReviewSchema,
  type Bet,
  type BetInput,
  type StructuralProposal,
  type BetOutcome,
  type MonthlyTrendSummary,
  type MonthlyReview,
} from "./monthly-review-types.js";
