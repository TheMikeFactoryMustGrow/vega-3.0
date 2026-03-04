import { z } from "zod";
import { FrontmatterValidator } from "../../telemetry/frontmatter-validator.js";
import {
  TruthTier,
  EntityType,
  type ValidationError,
} from "../../telemetry/frontmatter-validator-types.js";
import { TelemetryEmitter } from "../../telemetry/emitter.js";

/**
 * VEGA v3.4 — Migration Template Parser
 *
 * Extends v3.3 FrontmatterValidator with 7 migration template-specific Zod schemas
 * for parsing Obsidian vault notes into typed objects for Neo4j ingestion.
 *
 * Template types: entity, account, investment, cash_flow, institution, person, claim
 */

// ── Migration Template Type ──────────────────────────────────────────

export const MigrationTemplateType = z.enum([
  "entity",
  "account",
  "investment",
  "cash_flow",
  "institution",
  "person",
  "claim",
]);
export type MigrationTemplateType = z.infer<typeof MigrationTemplateType>;

// ── Template Schemas ──────────────────────────────────────────────────

export const EntityTemplateSchema = z.object({
  type: z.literal("entity"),
  name: z.string().min(1, "name is required"),
  entity_type: EntityType,
  domain: z.string().min(1, "domain is required"),
  aliases: z.array(z.string()).optional(),
  description: z.string().optional(),
});
export type EntityTemplate = z.infer<typeof EntityTemplateSchema>;

export const AccountTemplateSchema = z.object({
  type: z.literal("account"),
  name: z.string().min(1, "name is required"),
  institution: z.string().min(1, "institution is required"),
  account_type: z.string().min(1, "account_type is required"),
  domain: z.string().min(1, "domain is required"),
  balance: z.number().optional(),
  currency: z.string().optional(),
  last_verified: z.string().optional(),
});
export type AccountTemplate = z.infer<typeof AccountTemplateSchema>;

export const InvestmentTemplateSchema = z.object({
  type: z.literal("investment"),
  name: z.string().min(1, "name is required"),
  vehicle: z.string().min(1, "vehicle is required"),
  strategy: z.string().min(1, "strategy is required"),
  domain: z.string().min(1, "domain is required"),
  current_value: z.number().optional(),
  cost_basis: z.number().optional(),
  inception_date: z.string().optional(),
});
export type InvestmentTemplate = z.infer<typeof InvestmentTemplateSchema>;

export const CashFlowTemplateSchema = z.object({
  type: z.literal("cash_flow"),
  name: z.string().min(1, "name is required"),
  direction: z.enum(["inflow", "outflow"], {
    errorMap: () => ({
      message: "direction must be one of: inflow, outflow",
    }),
  }),
  frequency: z.string().min(1, "frequency is required"),
  amount: z.number({ required_error: "amount is required" }),
  source_entity: z.string().min(1, "source_entity is required"),
  domain: z.string().min(1, "domain is required"),
});
export type CashFlowTemplate = z.infer<typeof CashFlowTemplateSchema>;

export const InstitutionTemplateSchema = z.object({
  type: z.literal("institution"),
  name: z.string().min(1, "name is required"),
  institution_type: z.string().min(1, "institution_type is required"),
  domain: z.string().min(1, "domain is required"),
  contacts: z.array(z.string()).optional(),
  relationship_status: z.string().optional(),
});
export type InstitutionTemplate = z.infer<typeof InstitutionTemplateSchema>;

export const PersonTemplateSchema = z.object({
  type: z.literal("person"),
  name: z.string().min(1, "name is required"),
  relationship: z.string().min(1, "relationship is required"),
  domain: z.string().min(1, "domain is required"),
  birthday: z.string().optional(),
  contact_info: z.string().optional(),
  notes: z.string().optional(),
});
export type PersonTemplate = z.infer<typeof PersonTemplateSchema>;

export const ClaimTemplateSchema = z.object({
  truth_tier: TruthTier.describe(
    "truth_tier must be one of: family_direct, multi_source_verified, single_source, agent_inferred",
  ),
  truth_score: z
    .number()
    .min(0, "truth_score must be between 0.0 and 1.0")
    .max(1, "truth_score must be between 0.0 and 1.0"),
  source_ids: z.array(z.string().min(1)).min(1, "source_ids must have at least one entry"),
  domain: z.string().min(1, "domain is required"),
  created_date: z.string().min(1, "created_date is required"),
  last_verified: z.string().min(1, "last_verified is required"),
});
export type ClaimTemplate = z.infer<typeof ClaimTemplateSchema>;

// ── Schema Registry ────────────────────────────────────────────────────

const MigrationSchemas: Record<MigrationTemplateType, z.ZodTypeAny> = {
  entity: EntityTemplateSchema,
  account: AccountTemplateSchema,
  investment: InvestmentTemplateSchema,
  cash_flow: CashFlowTemplateSchema,
  institution: InstitutionTemplateSchema,
  person: PersonTemplateSchema,
  claim: ClaimTemplateSchema,
};

// ── Parse Result Types ──────────────────────────────────────────────────

export interface MigrationParseResult<T = Record<string, unknown>> {
  valid: boolean;
  template_type: MigrationTemplateType | null;
  data: T | null;
  errors: ValidationError[];
}

// ── MigrationParser ─────────────────────────────────────────────────────

export class MigrationParser {
  private readonly validator: FrontmatterValidator;
  private readonly emitter: TelemetryEmitter | null;

  constructor(options?: { emitter?: TelemetryEmitter }) {
    this.emitter = options?.emitter ?? null;
    this.validator = new FrontmatterValidator({ emitter: this.emitter ?? undefined });
  }

  /**
   * Auto-detect template type from frontmatter and validate against
   * the corresponding migration schema.
   *
   * For claim templates (no 'type' field), detects by presence of truth_tier.
   */
  parse(frontmatter: Record<string, unknown>): MigrationParseResult {
    const templateType = this.detectTemplateType(frontmatter);

    if (!templateType) {
      return {
        valid: false,
        template_type: null,
        data: null,
        errors: [
          {
            field: "type",
            message:
              "Unable to detect template type. Frontmatter must have a 'type' field " +
              "(entity, account, investment, cash_flow, institution, person) " +
              "or 'truth_tier' field for claim templates.",
            code: "unrecognized_template",
          },
        ],
      };
    }

    const schema = MigrationSchemas[templateType];
    const result = schema.safeParse(frontmatter);

    if (result.success) {
      return {
        valid: true,
        template_type: templateType,
        data: result.data as Record<string, unknown>,
        errors: [],
      };
    }

    const errors: ValidationError[] = result.error.issues.map((issue: z.ZodIssue) => ({
      field: issue.path.join(".") || "(root)",
      message: issue.message,
      code: issue.code,
    }));

    return {
      valid: false,
      template_type: templateType,
      data: null,
      errors,
    };
  }

  /**
   * Parse and validate frontmatter for a specific known template type.
   * Bypasses auto-detection.
   */
  parseAs<T extends MigrationTemplateType>(
    templateType: T,
    frontmatter: Record<string, unknown>,
  ): MigrationParseResult {
    const typeCheck = MigrationTemplateType.safeParse(templateType);
    if (!typeCheck.success) {
      return {
        valid: false,
        template_type: null,
        data: null,
        errors: [
          {
            field: "template_type",
            message: `Invalid template type '${templateType}'. Must be one of: ${MigrationTemplateType.options.join(", ")}`,
            code: "invalid_template_type",
          },
        ],
      };
    }

    const schema = MigrationSchemas[typeCheck.data];
    const result = schema.safeParse(frontmatter);

    if (result.success) {
      return {
        valid: true,
        template_type: typeCheck.data,
        data: result.data as Record<string, unknown>,
        errors: [],
      };
    }

    const errors: ValidationError[] = result.error.issues.map((issue: z.ZodIssue) => ({
      field: issue.path.join(".") || "(root)",
      message: issue.message,
      code: issue.code,
    }));

    return {
      valid: false,
      template_type: typeCheck.data,
      data: null,
      errors,
    };
  }

  /**
   * Get the v3.3 FrontmatterValidator instance for cross-validation
   * with the existing 6 note type schemas (Claim, Entity, Source, etc.)
   */
  getValidator(): FrontmatterValidator {
    return this.validator;
  }

  /**
   * Detect template type from frontmatter content.
   *
   * Uses the 'type' field for typed templates (entity, account, investment,
   * cash_flow, institution, person). Falls back to truth_tier presence
   * for claim templates (which don't have a 'type' field).
   */
  private detectTemplateType(
    frontmatter: Record<string, unknown>,
  ): MigrationTemplateType | null {
    // Check for explicit 'type' field
    if ("type" in frontmatter && typeof frontmatter.type === "string") {
      const parsed = MigrationTemplateType.safeParse(frontmatter.type);
      if (parsed.success) return parsed.data;
    }

    // Detect claim template by presence of truth_tier
    if ("truth_tier" in frontmatter) {
      return "claim";
    }

    return null;
  }
}
