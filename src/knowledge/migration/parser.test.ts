import { describe, it, expect } from "vitest";
import { MigrationParser } from "./parser.js";
import { FrontmatterValidator } from "../../telemetry/frontmatter-validator.js";

describe("MigrationParser", () => {
  const parser = new MigrationParser();

  // ── Entity Template ───────────────────────────────────────────────

  describe("Entity template", () => {
    it("parses valid Entity frontmatter", () => {
      const result = parser.parse({
        type: "entity",
        name: "Blackstone Group",
        entity_type: "organization",
        domain: "gix",
        aliases: ["BX", "Blackstone"],
        description: "Global alternative asset management firm",
      });
      expect(result.valid).toBe(true);
      expect(result.template_type).toBe("entity");
      expect(result.data).toMatchObject({
        type: "entity",
        name: "Blackstone Group",
        entity_type: "organization",
        domain: "gix",
      });
    });

    it("validates entity_type enum values", () => {
      const result = parser.parse({
        type: "entity",
        name: "Test",
        entity_type: "invalid_type",
        domain: "general",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "entity_type")).toBe(true);
    });

    it("requires name field", () => {
      const result = parser.parse({
        type: "entity",
        entity_type: "person",
        domain: "family",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "name")).toBe(true);
    });
  });

  // ── Account Template ──────────────────────────────────────────────

  describe("Account template", () => {
    it("parses valid Account frontmatter", () => {
      const result = parser.parse({
        type: "account",
        name: "Schwab Brokerage",
        institution: "Charles Schwab",
        account_type: "brokerage",
        domain: "personal_finance",
        balance: 125000,
        currency: "USD",
        last_verified: "2026-02-15",
      });
      expect(result.valid).toBe(true);
      expect(result.template_type).toBe("account");
      expect(result.data).toMatchObject({
        name: "Schwab Brokerage",
        institution: "Charles Schwab",
        account_type: "brokerage",
      });
    });

    it("requires institution field", () => {
      const result = parser.parse({
        type: "account",
        name: "Test Account",
        account_type: "checking",
        domain: "personal_finance",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "institution")).toBe(true);
    });

    it("accepts optional balance and currency", () => {
      const result = parser.parse({
        type: "account",
        name: "Simple Account",
        institution: "Bank of America",
        account_type: "savings",
        domain: "personal_finance",
      });
      expect(result.valid).toBe(true);
    });
  });

  // ── Investment Template ───────────────────────────────────────────

  describe("Investment template", () => {
    it("parses valid Investment frontmatter", () => {
      const result = parser.parse({
        type: "investment",
        name: "WE Fund III",
        vehicle: "venture_capital_fund",
        strategy: "early_stage_growth",
        domain: "we",
        current_value: 500000,
        cost_basis: 250000,
        inception_date: "2024-06-01",
      });
      expect(result.valid).toBe(true);
      expect(result.template_type).toBe("investment");
      expect(result.data).toMatchObject({
        name: "WE Fund III",
        vehicle: "venture_capital_fund",
        strategy: "early_stage_growth",
      });
    });

    it("requires vehicle and strategy", () => {
      const result = parser.parse({
        type: "investment",
        name: "Test Investment",
        domain: "personal_finance",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "vehicle")).toBe(true);
      expect(result.errors.some((e) => e.field === "strategy")).toBe(true);
    });
  });

  // ── Cash Flow Template ────────────────────────────────────────────

  describe("Cash Flow template", () => {
    it("parses valid Cash Flow frontmatter", () => {
      const result = parser.parse({
        type: "cash_flow",
        name: "Monthly Salary",
        direction: "inflow",
        frequency: "monthly",
        amount: 15000,
        source_entity: "GIX Management",
        domain: "personal_finance",
      });
      expect(result.valid).toBe(true);
      expect(result.template_type).toBe("cash_flow");
      expect(result.data).toMatchObject({
        direction: "inflow",
        amount: 15000,
        source_entity: "GIX Management",
      });
    });

    it("validates direction enum (inflow|outflow)", () => {
      const result = parser.parse({
        type: "cash_flow",
        name: "Test Flow",
        direction: "sideways",
        frequency: "monthly",
        amount: 100,
        source_entity: "Test",
        domain: "general",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "direction")).toBe(true);
      expect(
        result.errors.some((e) => e.message.includes("inflow") && e.message.includes("outflow")),
      ).toBe(true);
    });

    it("requires amount as a number", () => {
      const result = parser.parse({
        type: "cash_flow",
        name: "Test Flow",
        direction: "outflow",
        frequency: "weekly",
        amount: "not_a_number" as any,
        source_entity: "Test",
        domain: "general",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "amount")).toBe(true);
    });
  });

  // ── Institution Template ──────────────────────────────────────────

  describe("Institution template", () => {
    it("parses valid Institution frontmatter", () => {
      const result = parser.parse({
        type: "institution",
        name: "Charles Schwab",
        institution_type: "brokerage",
        domain: "personal_finance",
        contacts: ["John Smith", "Jane Doe"],
        relationship_status: "active",
      });
      expect(result.valid).toBe(true);
      expect(result.template_type).toBe("institution");
      expect(result.data).toMatchObject({
        name: "Charles Schwab",
        institution_type: "brokerage",
        contacts: ["John Smith", "Jane Doe"],
      });
    });

    it("requires institution_type", () => {
      const result = parser.parse({
        type: "institution",
        name: "Test Bank",
        domain: "personal_finance",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "institution_type")).toBe(true);
    });
  });

  // ── Person Template ───────────────────────────────────────────────

  describe("Person template", () => {
    it("parses valid Person frontmatter", () => {
      const result = parser.parse({
        type: "person",
        name: "Jim LaMarche",
        relationship: "business_contact",
        domain: "gix",
        birthday: "1975-03-15",
        contact_info: "jim@example.com",
        notes: "Met at CIP conference 2025",
      });
      expect(result.valid).toBe(true);
      expect(result.template_type).toBe("person");
      expect(result.data).toMatchObject({
        name: "Jim LaMarche",
        relationship: "business_contact",
        birthday: "1975-03-15",
      });
    });

    it("requires relationship field", () => {
      const result = parser.parse({
        type: "person",
        name: "Test Person",
        domain: "family",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "relationship")).toBe(true);
    });

    it("accepts person without optional fields", () => {
      const result = parser.parse({
        type: "person",
        name: "Lindsay Lingle",
        relationship: "spouse",
        domain: "family",
      });
      expect(result.valid).toBe(true);
      expect(result.data).toMatchObject({ name: "Lindsay Lingle" });
    });
  });

  // ── Claim Template ────────────────────────────────────────────────

  describe("Claim template (base)", () => {
    it("parses valid Claim frontmatter", () => {
      const result = parser.parse({
        truth_tier: "family_direct",
        truth_score: 0.98,
        source_ids: ["src-001"],
        domain: "family",
        created_date: "2026-03-01",
        last_verified: "2026-03-01",
      });
      expect(result.valid).toBe(true);
      expect(result.template_type).toBe("claim");
      expect(result.data).toMatchObject({
        truth_tier: "family_direct",
        truth_score: 0.98,
        domain: "family",
      });
    });

    it("validates truth_tier enum", () => {
      const result = parser.parse({
        truth_tier: "unverified",
        truth_score: 0.5,
        source_ids: ["src-001"],
        domain: "general",
        created_date: "2026-03-01",
        last_verified: "2026-03-01",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "truth_tier")).toBe(true);
    });

    it("validates truth_score range 0.0-1.0", () => {
      const result = parser.parse({
        truth_tier: "single_source",
        truth_score: 1.5,
        source_ids: ["src-001"],
        domain: "general",
        created_date: "2026-03-01",
        last_verified: "2026-03-01",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "truth_score")).toBe(true);
    });

    it("requires source_ids with at least one entry", () => {
      const result = parser.parse({
        truth_tier: "agent_inferred",
        truth_score: 0.7,
        source_ids: [],
        domain: "gix",
        created_date: "2026-03-01",
        last_verified: "2026-03-01",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "source_ids")).toBe(true);
    });
  });

  // ── Auto-detection ────────────────────────────────────────────────

  describe("Template type auto-detection", () => {
    it("detects claim template by truth_tier field (no type field)", () => {
      const result = parser.parse({
        truth_tier: "multi_source_verified",
        truth_score: 0.85,
        source_ids: ["s1", "s2"],
        domain: "personal_finance",
        created_date: "2026-01-01",
        last_verified: "2026-03-01",
      });
      expect(result.template_type).toBe("claim");
      expect(result.valid).toBe(true);
    });

    it("returns error for unrecognized type", () => {
      const result = parser.parse({
        type: "unknown_type",
        name: "Test",
      });
      expect(result.valid).toBe(false);
      expect(result.template_type).toBeNull();
      expect(result.errors[0].code).toBe("unrecognized_template");
    });

    it("returns error for frontmatter with no type or truth_tier", () => {
      const result = parser.parse({
        name: "Something",
        domain: "general",
      });
      expect(result.valid).toBe(false);
      expect(result.template_type).toBeNull();
    });
  });

  // ── parseAs (explicit type) ───────────────────────────────────────

  describe("parseAs (explicit type)", () => {
    it("parses with explicit type bypassing auto-detection", () => {
      const result = parser.parseAs("entity", {
        type: "entity",
        name: "Test Entity",
        entity_type: "concept",
        domain: "general",
      });
      expect(result.valid).toBe(true);
      expect(result.template_type).toBe("entity");
    });

    it("rejects invalid template type", () => {
      const result = parser.parseAs("invalid" as any, { name: "test" });
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("invalid_template_type");
    });
  });

  // ── Cross-validation with v3.3 FrontmatterValidator ───────────────

  describe("v3.3 FrontmatterValidator integration", () => {
    it("exposes the underlying FrontmatterValidator", () => {
      const validator = parser.getValidator();
      expect(validator).toBeInstanceOf(FrontmatterValidator);
    });

    it("v3.3 validator still works for existing note types", () => {
      const validator = parser.getValidator();
      const result = validator.validate("Entity", {
        title: "Test",
        entity_type: "person",
        domain: "family",
        created_date: "2026-03-01",
      });
      expect(result.valid).toBe(true);
    });
  });

  // ── All 7 templates with valid data ───────────────────────────────

  describe("All 7 templates parse successfully", () => {
    const validTemplates: Array<{ type: string; frontmatter: Record<string, unknown> }> = [
      {
        type: "entity",
        frontmatter: {
          type: "entity",
          name: "VEGA",
          entity_type: "concept",
          domain: "gix",
        },
      },
      {
        type: "account",
        frontmatter: {
          type: "account",
          name: "Checking",
          institution: "Chase",
          account_type: "checking",
          domain: "personal_finance",
        },
      },
      {
        type: "investment",
        frontmatter: {
          type: "investment",
          name: "S&P 500 Index",
          vehicle: "index_fund",
          strategy: "passive",
          domain: "personal_finance",
        },
      },
      {
        type: "cash_flow",
        frontmatter: {
          type: "cash_flow",
          name: "Rent Payment",
          direction: "outflow",
          frequency: "monthly",
          amount: 3000,
          source_entity: "Landlord",
          domain: "personal_finance",
        },
      },
      {
        type: "institution",
        frontmatter: {
          type: "institution",
          name: "Fidelity",
          institution_type: "investment_manager",
          domain: "personal_finance",
        },
      },
      {
        type: "person",
        frontmatter: {
          type: "person",
          name: "Harrison Lingle",
          relationship: "son",
          domain: "family",
        },
      },
      {
        type: "claim",
        frontmatter: {
          truth_tier: "family_direct",
          truth_score: 1.0,
          source_ids: ["mike-direct"],
          domain: "family",
          created_date: "2026-03-01",
          last_verified: "2026-03-01",
        },
      },
    ];

    for (const { type, frontmatter } of validTemplates) {
      it(`parses valid ${type} template`, () => {
        const result = parser.parse(frontmatter);
        expect(result.valid).toBe(true);
        expect(result.template_type).toBe(type);
        expect(result.data).not.toBeNull();
        expect(result.errors).toHaveLength(0);
      });
    }
  });
});
