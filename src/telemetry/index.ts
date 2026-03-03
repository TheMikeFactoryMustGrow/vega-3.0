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
