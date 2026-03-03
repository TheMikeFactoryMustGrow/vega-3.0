import { z } from "zod";

/**
 * VEGA v3.3 Privacy Audit Cypher Query Library — Types
 *
 * Defines the 6 audit types, result schemas, configuration, and report format.
 * These Cypher queries enforce privacy boundaries in the Neo4j/Lingelpedia graph.
 */

// ─── Audit Identifiers ──────────────────────────────────────────────────────

export const AuditId = z.enum([
  "orphaned_sources",
  "stale_claims",
  "cross_account_leakage",
  "missing_truth_tier",
  "permission_boundary",
  "temporal_anomalies",
]);
export type AuditId = z.infer<typeof AuditId>;

// ─── Audit Severity ──────────────────────────────────────────────────────────

export const AuditSeverity = z.enum(["info", "warning", "critical"]);
export type AuditSeverity = z.infer<typeof AuditSeverity>;

// ─── Escalation Level ────────────────────────────────────────────────────────

export const EscalationLevel = z.enum(["level_1", "level_2", "level_3"]);
export type EscalationLevel = z.infer<typeof EscalationLevel>;

// ─── Neo4j Query Function (dependency injection) ─────────────────────────────

/** Generic row type returned by Neo4j queries */
export type Neo4jRow = Record<string, unknown>;

/**
 * Function signature for executing Cypher queries against Neo4j.
 * Injected as a dependency so tests can use mock implementations.
 */
export type CypherQueryFn = (
  cypher: string,
  params: Record<string, unknown>,
) => Promise<Neo4jRow[]>;

// ─── Audit Definition ────────────────────────────────────────────────────────

export const AuditDefinitionSchema = z.object({
  id: AuditId,
  name: z.string().min(1),
  description: z.string().min(1),
  cypher: z.string().min(1),
  default_params: z.record(z.unknown()).default({}),
  /** Audits 1-5 trigger Level 3 escalation on non-zero results */
  escalation_on_nonzero: z.boolean(),
  severity: AuditSeverity,
});
export type AuditDefinition = z.infer<typeof AuditDefinitionSchema>;

// ─── Audit Finding ───────────────────────────────────────────────────────────

export const AuditFindingSchema = z.object({
  audit_id: AuditId,
  audit_name: z.string().min(1),
  severity: AuditSeverity,
  finding_count: z.number().int().nonnegative(),
  findings: z.array(z.record(z.unknown())),
  escalation_triggered: z.boolean(),
  escalation_level: EscalationLevel.nullable(),
});
export type AuditFinding = z.infer<typeof AuditFindingSchema>;

// ─── Audit Report ────────────────────────────────────────────────────────────

export const AuditReportSchema = z.object({
  run_at: z.coerce.date(),
  audits_run: z.number().int().positive(),
  total_findings: z.number().int().nonnegative(),
  findings: z.array(AuditFindingSchema),
  escalations: z.array(
    z.object({
      audit_id: AuditId,
      level: EscalationLevel,
      finding_count: z.number().int().positive(),
      description: z.string().min(1),
    }),
  ),
  has_escalations: z.boolean(),
  markdown: z.string(),
});
export type AuditReport = z.infer<typeof AuditReportSchema>;

// ─── Audit Configuration ─────────────────────────────────────────────────────

export const AuditConfigSchema = z.object({
  /** Number of days after which a claim is considered stale (Audit 2) */
  stale_claim_days: z.number().int().positive().default(90),
  /** Source account considered personal/family (Audit 3 & 5) */
  personal_source_account: z.string().default("icloud_family"),
  /** Entity tag considered confidential business (Audit 3 & 5) */
  confidential_tag: z.string().default("gix_confidential"),
}).default({});
export type AuditConfig = z.infer<typeof AuditConfigSchema>;
