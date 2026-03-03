import { z } from "zod";

/**
 * VEGA v3.3 Telemetry Event Schema
 *
 * Matches the Implementation Guide event schema (Section: Event Schema).
 * Every agent action emits a structured event to the Tier 1 JSONL stream.
 */

export const EventType = z.enum([
  "agent_action",
  "model_call",
  "knowledge_write",
  "knowledge_query",
  "escalation",
  "schedule_trigger",
  "system_event",
]);
export type EventType = z.infer<typeof EventType>;

export const TelemetryEventSchema = z.object({
  event_id: z.string().uuid(),
  timestamp: z.string().datetime({ offset: true }),
  agent_name: z.string().min(1),
  event_type: EventType,
  event_subtype: z.string().min(1),
  session_id: z.string().min(1),
  model_used: z.string().nullable().optional(),
  tokens_in: z.number().int().nonnegative().nullable().optional(),
  tokens_out: z.number().int().nonnegative().nullable().optional(),
  latency_ms: z.number().nonnegative().nullable().optional(),
  outcome: z.enum(["success", "failure", "partial", "skipped"]),
  metadata: z.record(z.unknown()).optional().default({}),
});

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

/** Input type for emitting events — event_id and timestamp are auto-generated */
export type TelemetryEventInput = Omit<TelemetryEvent, "event_id" | "timestamp"> & {
  event_id?: string;
  timestamp?: string;
};
