import { z } from "zod";

/**
 * VEGA v3.3 — YAML Frontmatter Validation Schemas
 *
 * Defines Zod schemas for all 6 Obsidian note types used by the Knowledge Agent.
 * Validation ensures frontmatter integrity at write time, preventing silent
 * downstream failures in the dual-write invariant (Obsidian ↔ Neo4j).
 */

// ─── Shared Enums ───────────────────────────────────────────────────────────

export const TruthTier = z.enum([
  "family_direct",
  "multi_source_verified",
  "single_source",
  "agent_inferred",
]);
export type TruthTier = z.infer<typeof TruthTier>;

export const EntityType = z.enum([
  "person",
  "organization",
  "financial_instrument",
  "property",
  "concept",
]);
export type EntityType = z.infer<typeof EntityType>;

export const NoteType = z.enum([
  "Claim",
  "Entity",
  "Source",
  "OpenQuestion",
  "Bet",
  "MOC",
]);
export type NoteType = z.infer<typeof NoteType>;

// ─── Note Type Schemas ──────────────────────────────────────────────────────

export const ClaimFrontmatterSchema = z.object({
  title: z.string().min(1),
  truth_tier: TruthTier,
  truth_score: z.number().min(0).max(1),
  source_ids: z.array(z.string().min(1)).min(1),
  domain: z.string().min(1),
  created_date: z.string().min(1),
  last_verified: z.string().min(1),
  // Optional fields
  tags: z.array(z.string()).optional(),
  aliases: z.array(z.string()).optional(),
  related_claims: z.array(z.string()).optional(),
});
export type ClaimFrontmatter = z.infer<typeof ClaimFrontmatterSchema>;

export const EntityFrontmatterSchema = z.object({
  title: z.string().min(1),
  entity_type: EntityType,
  domain: z.string().min(1),
  created_date: z.string().min(1),
  // Optional fields
  tags: z.array(z.string()).optional(),
  aliases: z.array(z.string()).optional(),
  description: z.string().optional(),
});
export type EntityFrontmatter = z.infer<typeof EntityFrontmatterSchema>;

export const SourceFrontmatterSchema = z.object({
  title: z.string().min(1),
  source_type: z.string().min(1),
  source_account: z.string().min(1),
  credibility_weight: z.number().min(0).max(1),
  captured_date: z.string().min(1),
  // Optional fields
  tags: z.array(z.string()).optional(),
  url: z.string().optional(),
  author: z.string().optional(),
});
export type SourceFrontmatter = z.infer<typeof SourceFrontmatterSchema>;

export const OpenQuestionFrontmatterSchema = z.object({
  title: z.string().min(1),
  domain: z.string().min(1),
  status: z.enum(["open", "investigating", "resolved"]),
  created_date: z.string().min(1),
  // Optional fields
  tags: z.array(z.string()).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  assigned_agent: z.string().optional(),
  resolution_date: z.string().optional(),
});
export type OpenQuestionFrontmatter = z.infer<typeof OpenQuestionFrontmatterSchema>;

export const BetFrontmatterSchema = z.object({
  title: z.string().min(1),
  hypothesis: z.string().min(1),
  expected_outcome: z.string().min(1),
  measurement_criteria: z.string().min(1),
  status: z.enum(["pending_approval", "active", "confirmed", "revised", "abandoned"]),
  created_date: z.string().min(1),
  review_date: z.string().min(1),
  // Optional fields
  tags: z.array(z.string()).optional(),
  rollback_trigger: z.string().optional(),
  actual_outcome: z.string().optional(),
  source_review_month: z.string().optional(),
});
export type BetFrontmatter = z.infer<typeof BetFrontmatterSchema>;

export const MOCFrontmatterSchema = z.object({
  title: z.string().min(1),
  domain: z.string().min(1),
  created_date: z.string().min(1),
  // Optional fields
  tags: z.array(z.string()).optional(),
  last_updated: z.string().optional(),
  description: z.string().optional(),
  linked_notes: z.array(z.string()).optional(),
});
export type MOCFrontmatter = z.infer<typeof MOCFrontmatterSchema>;

// ─── Schema Registry ────────────────────────────────────────────────────────

export const FrontmatterSchemas: Record<NoteType, z.ZodTypeAny> = {
  Claim: ClaimFrontmatterSchema,
  Entity: EntityFrontmatterSchema,
  Source: SourceFrontmatterSchema,
  OpenQuestion: OpenQuestionFrontmatterSchema,
  Bet: BetFrontmatterSchema,
  MOC: MOCFrontmatterSchema,
};

// ─── Validation Result Types ────────────────────────────────────────────────

export const ValidationErrorSchema = z.object({
  field: z.string(),
  message: z.string(),
  code: z.string(),
});
export type ValidationError = z.infer<typeof ValidationErrorSchema>;

export const ValidationResultSchema = z.object({
  valid: z.boolean(),
  note_type: NoteType,
  errors: z.array(ValidationErrorSchema),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

// ─── Escalation Level ───────────────────────────────────────────────────────

export const EscalationLevel = {
  LEVEL_2: 2, // Bar Raiser review — used for frontmatter validation failures
} as const;
