import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { FrontmatterValidator } from "./frontmatter-validator.js";
import type { ValidationResult } from "./frontmatter-validator-types.js";

describe("FrontmatterValidator", () => {
  let validator: FrontmatterValidator;
  let tmpDir: string;

  beforeEach(async () => {
    validator = new FrontmatterValidator();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "frontmatter-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ─── Claim Validation ──────────────────────────────────────────────────

  describe("Claim frontmatter", () => {
    const validClaim = {
      title: "Climate change impacts on coastal property values",
      truth_tier: "multi_source_verified" as const,
      truth_score: 0.85,
      source_ids: ["src-001", "src-002"],
      domain: "finance",
      created_date: "2026-03-03",
      last_verified: "2026-03-03",
    };

    it("accepts valid Claim frontmatter", () => {
      const result = validator.validate("Claim", validClaim);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.note_type).toBe("Claim");
    });

    it("rejects Claim with missing truth_tier", () => {
      const { truth_tier, ...incomplete } = validClaim;
      const result = validator.validate("Claim", incomplete);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "truth_tier")).toBe(true);
    });

    it("rejects Claim with invalid truth_tier value", () => {
      const result = validator.validate("Claim", {
        ...validClaim,
        truth_tier: "hearsay",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "truth_tier")).toBe(true);
    });

    it("rejects Claim with truth_score out of range", () => {
      const result = validator.validate("Claim", {
        ...validClaim,
        truth_score: 1.5,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "truth_score")).toBe(true);
    });

    it("rejects Claim with empty source_ids", () => {
      const result = validator.validate("Claim", {
        ...validClaim,
        source_ids: [],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "source_ids")).toBe(true);
    });

    it("rejects Claim with missing required fields", () => {
      const result = validator.validate("Claim", { title: "Incomplete" });
      expect(result.valid).toBe(false);
      // Should flag multiple missing fields
      expect(result.errors.length).toBeGreaterThanOrEqual(5);
    });

    it("accepts Claim with optional tags", () => {
      const result = validator.validate("Claim", {
        ...validClaim,
        tags: ["finance", "climate"],
      });
      expect(result.valid).toBe(true);
    });
  });

  // ─── Entity Validation ─────────────────────────────────────────────────

  describe("Entity frontmatter", () => {
    const validEntity = {
      title: "Acme Corporation",
      entity_type: "organization" as const,
      domain: "business",
      created_date: "2026-03-03",
    };

    it("accepts valid Entity frontmatter", () => {
      const result = validator.validate("Entity", validEntity);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects Entity with invalid entity_type", () => {
      const result = validator.validate("Entity", {
        ...validEntity,
        entity_type: "animal",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "entity_type")).toBe(true);
    });

    it("rejects Entity with missing title", () => {
      const { title, ...noTitle } = validEntity;
      const result = validator.validate("Entity", noTitle);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "title")).toBe(true);
    });

    it("accepts all valid entity_type values", () => {
      for (const entityType of ["person", "organization", "financial_instrument", "property", "concept"]) {
        const result = validator.validate("Entity", { ...validEntity, entity_type: entityType });
        expect(result.valid).toBe(true);
      }
    });
  });

  // ─── Source Validation ─────────────────────────────────────────────────

  describe("Source frontmatter", () => {
    const validSource = {
      title: "Bloomberg Terminal Feed",
      source_type: "api",
      source_account: "gix_business",
      credibility_weight: 0.95,
      captured_date: "2026-03-03",
    };

    it("accepts valid Source frontmatter", () => {
      const result = validator.validate("Source", validSource);
      expect(result.valid).toBe(true);
    });

    it("rejects Source with credibility_weight > 1", () => {
      const result = validator.validate("Source", {
        ...validSource,
        credibility_weight: 1.1,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "credibility_weight")).toBe(true);
    });

    it("rejects Source with missing source_account", () => {
      const { source_account, ...noAccount } = validSource;
      const result = validator.validate("Source", noAccount);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "source_account")).toBe(true);
    });
  });

  // ─── OpenQuestion Validation ───────────────────────────────────────────

  describe("OpenQuestion frontmatter", () => {
    const validOQ = {
      title: "What is the optimal rebalancing frequency?",
      domain: "finance",
      status: "open" as const,
      created_date: "2026-03-03",
    };

    it("accepts valid OpenQuestion frontmatter", () => {
      const result = validator.validate("OpenQuestion", validOQ);
      expect(result.valid).toBe(true);
    });

    it("rejects OpenQuestion with invalid status", () => {
      const result = validator.validate("OpenQuestion", {
        ...validOQ,
        status: "closed",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "status")).toBe(true);
    });
  });

  // ─── Bet Validation ────────────────────────────────────────────────────

  describe("Bet frontmatter", () => {
    const validBet = {
      title: "Increase Knowledge Agent query batch size",
      hypothesis: "Larger batch sizes will reduce total query latency by 20%",
      expected_outcome: "p95 latency drops below 500ms",
      measurement_criteria: "Compare p95 latency week-over-week",
      status: "pending_approval" as const,
      created_date: "2026-03-03",
      review_date: "2026-04-03",
    };

    it("accepts valid Bet frontmatter", () => {
      const result = validator.validate("Bet", validBet);
      expect(result.valid).toBe(true);
    });

    it("rejects Bet with invalid status", () => {
      const result = validator.validate("Bet", {
        ...validBet,
        status: "expired",
      });
      expect(result.valid).toBe(false);
    });

    it("rejects Bet with missing hypothesis", () => {
      const { hypothesis, ...noHypothesis } = validBet;
      const result = validator.validate("Bet", noHypothesis);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "hypothesis")).toBe(true);
    });
  });

  // ─── MOC Validation ────────────────────────────────────────────────────

  describe("MOC frontmatter", () => {
    const validMOC = {
      title: "Finance Domain Map",
      domain: "finance",
      created_date: "2026-03-03",
    };

    it("accepts valid MOC frontmatter", () => {
      const result = validator.validate("MOC", validMOC);
      expect(result.valid).toBe(true);
    });

    it("rejects MOC with empty title", () => {
      const result = validator.validate("MOC", {
        ...validMOC,
        title: "",
      });
      expect(result.valid).toBe(false);
    });
  });

  // ─── Invalid Note Type ─────────────────────────────────────────────────

  describe("invalid note type", () => {
    it("rejects unknown note type", () => {
      const result = validator.validate("Journal", { title: "Something" });
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("invalid_note_type");
      expect(result.errors[0].message).toContain("Journal");
    });
  });

  // ─── writeNote Integration ─────────────────────────────────────────────

  describe("writeNote", () => {
    it("writes valid Entity note to disk", async () => {
      const filePath = path.join(tmpDir, "entities", "acme.md");

      const result = await validator.writeNote({
        note_type: "Entity",
        frontmatter: {
          title: "Acme Corporation",
          entity_type: "organization",
          domain: "business",
          created_date: "2026-03-03",
        },
        body: "# Acme Corporation\n\nA leading business entity.",
        file_path: filePath,
      });

      expect(result.success).toBe(true);
      expect(result.validation.valid).toBe(true);
      expect(result.escalation).toBeUndefined();

      // Verify file was written
      expect(existsSync(filePath)).toBe(true);
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("---");
      expect(content).toContain("title: Acme Corporation");
      expect(content).toContain("entity_type: organization");
      expect(content).toContain("# Acme Corporation");
    });

    it("rejects and does not write note with invalid frontmatter", async () => {
      const filePath = path.join(tmpDir, "claims", "bad-claim.md");

      const result = await validator.writeNote({
        note_type: "Claim",
        frontmatter: {
          title: "Missing fields claim",
          // Missing: truth_tier, truth_score, source_ids, domain, created_date, last_verified
        },
        body: "This should not be written.",
        file_path: filePath,
        agent_name: "knowledge_agent",
      });

      expect(result.success).toBe(false);
      expect(result.validation.valid).toBe(false);
      expect(result.escalation).toBeDefined();
      expect(result.escalation!.level).toBe(2);
      expect(result.escalation!.agent_name).toBe("knowledge_agent");
      expect(result.escalation!.errors.length).toBeGreaterThan(0);

      // Verify file was NOT written
      expect(existsSync(filePath)).toBe(false);
    });

    it("includes specific error message for missing truth_tier", async () => {
      const filePath = path.join(tmpDir, "claims", "no-tier.md");

      const result = await validator.writeNote({
        note_type: "Claim",
        frontmatter: {
          title: "Test Claim",
          truth_score: 0.8,
          source_ids: ["src-001"],
          domain: "test",
          created_date: "2026-03-03",
          last_verified: "2026-03-03",
          // Missing: truth_tier
        },
        body: "Body text.",
        file_path: filePath,
      });

      expect(result.success).toBe(false);
      expect(result.escalation!.errors.some((e) => e.field === "truth_tier")).toBe(true);
      expect(result.escalation!.reason).toContain("truth_tier");
      expect(existsSync(filePath)).toBe(false);
    });

    it("writes note with array fields correctly formatted", async () => {
      const filePath = path.join(tmpDir, "claims", "with-arrays.md");

      const result = await validator.writeNote({
        note_type: "Claim",
        frontmatter: {
          title: "Array Fields Test",
          truth_tier: "family_direct",
          truth_score: 1.0,
          source_ids: ["src-001", "src-002", "src-003"],
          domain: "test",
          created_date: "2026-03-03",
          last_verified: "2026-03-03",
          tags: ["test", "validation"],
        },
        body: "Body.",
        file_path: filePath,
      });

      expect(result.success).toBe(true);
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("source_ids:");
      expect(content).toContain("  - src-001");
      expect(content).toContain("  - src-002");
      expect(content).toContain("  - src-003");
      expect(content).toContain("tags:");
      expect(content).toContain("  - test");
    });
  });
});
