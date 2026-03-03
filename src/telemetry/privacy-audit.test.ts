import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { TelemetryEmitter } from "./emitter.js";
import { PrivacyAuditor } from "./privacy-audit.js";
import type { CypherQueryFn, Neo4jRow } from "./privacy-audit-types.js";

/**
 * Privacy Audit Cypher Query Library Tests
 *
 * Uses mock CypherQueryFn to simulate Neo4j responses.
 * No actual Neo4j connection required — the query definitions and
 * audit logic are tested via dependency injection.
 */

describe("PrivacyAuditor", () => {
  let tmpDir: string;
  let emitter: TelemetryEmitter;

  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "privacy-audit-"));
    emitter = new TelemetryEmitter(tmpDir);
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ─── Audit Definitions ─────────────────────────────────────────────────

  it("exposes all 6 audit definitions", () => {
    const mockQuery: CypherQueryFn = async () => [];
    const auditor = new PrivacyAuditor(mockQuery, emitter, {}, { emitTelemetry: false });

    const defs = auditor.getAuditDefinitions();
    expect(defs).toHaveLength(6);

    const ids = defs.map((d) => d.id);
    expect(ids).toEqual([
      "orphaned_sources",
      "stale_claims",
      "cross_account_leakage",
      "missing_truth_tier",
      "permission_boundary",
      "temporal_anomalies",
    ]);
  });

  it("all queries are parameterized (no hardcoded values)", () => {
    const mockQuery: CypherQueryFn = async () => [];
    const auditor = new PrivacyAuditor(mockQuery, emitter, {}, { emitTelemetry: false });

    const defs = auditor.getAuditDefinitions();

    // stale_claims uses $stale_days parameter
    const staleClaims = defs.find((d) => d.id === "stale_claims")!;
    expect(staleClaims.cypher).toContain("$stale_days");
    expect(staleClaims.default_params).toHaveProperty("stale_days", 90);

    // cross_account_leakage uses $personal_account and $confidential_tag
    const crossAccount = defs.find((d) => d.id === "cross_account_leakage")!;
    expect(crossAccount.cypher).toContain("$personal_account");
    expect(crossAccount.cypher).toContain("$confidential_tag");

    // permission_boundary uses $personal_account and $confidential_tag
    const permBoundary = defs.find((d) => d.id === "permission_boundary")!;
    expect(permBoundary.cypher).toContain("$personal_account");
    expect(permBoundary.cypher).toContain("$confidential_tag");
  });

  // ─── Audit 1: Orphaned Sources ──────────────────────────────────────────

  it("Audit 1 — detects orphaned Source nodes", async () => {
    const orphanedSource: Neo4jRow = {
      s: {
        title: "Orphaned Email",
        source_type: "email",
        source_account: "icloud_family",
        credibility_weight: 0.8,
      },
    };

    const mockQuery: CypherQueryFn = async (cypher) => {
      if (cypher.includes("(s:Source)") && cypher.includes("NOT (s)<-[:SOURCED_FROM]-()")) {
        return [orphanedSource];
      }
      return [];
    };

    const auditor = new PrivacyAuditor(mockQuery, emitter, {}, { emitTelemetry: false });
    const finding = await auditor.runAudit("orphaned_sources");

    expect(finding.audit_id).toBe("orphaned_sources");
    expect(finding.finding_count).toBe(1);
    expect(finding.findings).toEqual([orphanedSource]);
    expect(finding.escalation_triggered).toBe(true);
    expect(finding.escalation_level).toBe("level_3");
    expect(finding.severity).toBe("warning");
  });

  // ─── Audit 2: Stale Claims ─────────────────────────────────────────────

  it("Audit 2 — detects stale claims not verified in 90+ days", async () => {
    const staleClaim: Neo4jRow = {
      c: {
        title: "Old Financial Claim",
        truth_tier: "single_source",
        last_verified: "2025-11-01T00:00:00Z",
      },
    };

    const mockQuery: CypherQueryFn = async (cypher, params) => {
      if (cypher.includes("c.last_verified") && cypher.includes("$stale_days")) {
        expect(params.stale_days).toBe(90);
        return [staleClaim];
      }
      return [];
    };

    const auditor = new PrivacyAuditor(mockQuery, emitter, { stale_claim_days: 90 }, { emitTelemetry: false });
    const finding = await auditor.runAudit("stale_claims");

    expect(finding.audit_id).toBe("stale_claims");
    expect(finding.finding_count).toBe(1);
    expect(finding.escalation_triggered).toBe(true);
    expect(finding.escalation_level).toBe("level_3");
  });

  // ─── Audit 3: Cross-Account Leakage ────────────────────────────────────

  it("Audit 3 — detects cross-account leakage (personal → business)", async () => {
    const leakedPath: Neo4jRow = {
      s: { title: "Family iCloud Note", source_account: "icloud_family" },
      c: { title: "Leaked Claim", truth_tier: "single_source" },
      e: { title: "GIX Strategy Doc", tags: ["gix_confidential"] },
    };

    const mockQuery: CypherQueryFn = async (cypher, params) => {
      if (
        cypher.includes("$personal_account") &&
        cypher.includes("$confidential_tag") &&
        cypher.includes("RELATES_TO")
      ) {
        expect(params.personal_account).toBe("icloud_family");
        expect(params.confidential_tag).toBe("gix_confidential");
        return [leakedPath];
      }
      return [];
    };

    const auditor = new PrivacyAuditor(mockQuery, emitter, {}, { emitTelemetry: false });
    const finding = await auditor.runAudit("cross_account_leakage");

    expect(finding.audit_id).toBe("cross_account_leakage");
    expect(finding.finding_count).toBe(1);
    expect(finding.severity).toBe("critical");
    expect(finding.escalation_triggered).toBe(true);
    expect(finding.escalation_level).toBe("level_3");
  });

  // ─── Audit 4: Missing Truth Tier ───────────────────────────────────────

  it("Audit 4 — detects claims with null truth_tier", async () => {
    const unclassifiedClaim: Neo4jRow = {
      c: { title: "Unclassified Claim", truth_tier: null },
    };

    const mockQuery: CypherQueryFn = async (cypher) => {
      if (cypher.includes("c.truth_tier IS NULL")) {
        return [unclassifiedClaim];
      }
      return [];
    };

    const auditor = new PrivacyAuditor(mockQuery, emitter, {}, { emitTelemetry: false });
    const finding = await auditor.runAudit("missing_truth_tier");

    expect(finding.audit_id).toBe("missing_truth_tier");
    expect(finding.finding_count).toBe(1);
    expect(finding.findings).toEqual([unclassifiedClaim]);
    expect(finding.escalation_triggered).toBe(true);
    expect(finding.escalation_level).toBe("level_3");
  });

  // ─── Audit 5: Permission Boundary ──────────────────────────────────────

  it("Audit 5 — detects permission boundary violations (icloud_family → gix_confidential)", async () => {
    const violation: Neo4jRow = {
      s: { title: "Personal Note", source_account: "icloud_family" },
      c: { title: "Boundary Violation Claim" },
      e: { title: "Confidential Entity", domain: "gix_confidential" },
    };

    const mockQuery: CypherQueryFn = async (cypher, params) => {
      if (cypher.includes("e.domain = $confidential_tag")) {
        expect(params.personal_account).toBe("icloud_family");
        expect(params.confidential_tag).toBe("gix_confidential");
        return [violation];
      }
      return [];
    };

    const auditor = new PrivacyAuditor(mockQuery, emitter, {}, { emitTelemetry: false });
    const finding = await auditor.runAudit("permission_boundary");

    expect(finding.audit_id).toBe("permission_boundary");
    expect(finding.finding_count).toBe(1);
    expect(finding.severity).toBe("critical");
    expect(finding.escalation_triggered).toBe(true);
  });

  // ─── Audit 6: Temporal Anomalies ───────────────────────────────────────

  it("Audit 6 — detects logically impossible timestamps (no escalation)", async () => {
    const temporalAnomaly: Neo4jRow = {
      c: {
        title: "Time-Paradox Claim",
        created_date: "2026-03-03T00:00:00Z",
        last_verified: "2026-02-01T00:00:00Z",
      },
    };

    const mockQuery: CypherQueryFn = async (cypher) => {
      if (cypher.includes("c.created_date > c.last_verified")) {
        return [temporalAnomaly];
      }
      return [];
    };

    const auditor = new PrivacyAuditor(mockQuery, emitter, {}, { emitTelemetry: false });
    const finding = await auditor.runAudit("temporal_anomalies");

    expect(finding.audit_id).toBe("temporal_anomalies");
    expect(finding.finding_count).toBe(1);
    expect(finding.severity).toBe("info");
    // Audit 6 does NOT trigger escalation
    expect(finding.escalation_triggered).toBe(false);
    expect(finding.escalation_level).toBeNull();
  });

  // ─── Full Audit Run ────────────────────────────────────────────────────

  it("runAllAudits — runs all 6 audits and produces a full report", async () => {
    // Mock: orphaned source (Audit 1) and missing truth tier (Audit 4)
    const mockQuery: CypherQueryFn = async (cypher) => {
      if (cypher.includes("NOT (s)<-[:SOURCED_FROM]-()")) {
        return [{ s: { title: "Orphan" } }];
      }
      if (cypher.includes("c.truth_tier IS NULL")) {
        return [
          { c: { title: "Missing1" } },
          { c: { title: "Missing2" } },
        ];
      }
      return [];
    };

    const auditor = new PrivacyAuditor(mockQuery, emitter, {}, { emitTelemetry: false });
    const report = await auditor.runAllAudits();

    expect(report.audits_run).toBe(6);
    expect(report.total_findings).toBe(3); // 1 orphan + 2 missing truth tier
    expect(report.has_escalations).toBe(true);
    expect(report.escalations).toHaveLength(2); // orphaned_sources + missing_truth_tier

    // Verify escalation details
    const orphanEsc = report.escalations.find(
      (e) => e.audit_id === "orphaned_sources",
    );
    expect(orphanEsc).toBeDefined();
    expect(orphanEsc!.level).toBe("level_3");
    expect(orphanEsc!.finding_count).toBe(1);

    const truthEsc = report.escalations.find(
      (e) => e.audit_id === "missing_truth_tier",
    );
    expect(truthEsc).toBeDefined();
    expect(truthEsc!.finding_count).toBe(2);

    // Verify clean audits
    const cleanAudits = report.findings.filter((f) => f.finding_count === 0);
    expect(cleanAudits).toHaveLength(4); // stale, cross-account, permission, temporal

    // Verify markdown report
    expect(report.markdown).toContain("# Privacy Audit Report");
    expect(report.markdown).toContain("Escalations (Level 3");
    expect(report.markdown).toContain("Orphaned Sources");
    expect(report.markdown).toContain("Missing Truth Tier");
    expect(report.markdown).toContain("PASS");
    expect(report.markdown).toContain("FINDINGS");
  });

  it("runAllAudits — clean graph produces no escalations", async () => {
    const mockQuery: CypherQueryFn = async () => [];
    const auditor = new PrivacyAuditor(mockQuery, emitter, {}, { emitTelemetry: false });
    const report = await auditor.runAllAudits();

    expect(report.audits_run).toBe(6);
    expect(report.total_findings).toBe(0);
    expect(report.has_escalations).toBe(false);
    expect(report.escalations).toHaveLength(0);

    // All audits PASS
    for (const finding of report.findings) {
      expect(finding.finding_count).toBe(0);
      expect(finding.escalation_triggered).toBe(false);
    }
  });

  // ─── Configuration ─────────────────────────────────────────────────────

  it("accepts custom configuration overrides", async () => {
    let capturedParams: Record<string, unknown> = {};
    const mockQuery: CypherQueryFn = async (cypher, params) => {
      if (cypher.includes("$stale_days")) {
        capturedParams = params;
      }
      return [];
    };

    const auditor = new PrivacyAuditor(
      mockQuery,
      emitter,
      {
        stale_claim_days: 60,
        personal_source_account: "custom_account",
        confidential_tag: "custom_confidential",
      },
      { emitTelemetry: false },
    );

    await auditor.runAudit("stale_claims");
    expect(capturedParams.stale_days).toBe(60);

    // Verify custom account in cross-account leakage
    const crossAudit = auditor.getAudit("cross_account_leakage");
    expect(crossAudit!.default_params.personal_account).toBe("custom_account");
    expect(crossAudit!.default_params.confidential_tag).toBe("custom_confidential");
  });

  it("supports runtime parameter overrides per audit", async () => {
    let capturedParams: Record<string, unknown> = {};
    const mockQuery: CypherQueryFn = async (_cypher, params) => {
      capturedParams = params;
      return [];
    };

    const auditor = new PrivacyAuditor(mockQuery, emitter, {}, { emitTelemetry: false });
    await auditor.runAudit("stale_claims", { stale_days: 30 });

    expect(capturedParams.stale_days).toBe(30);
  });

  // ─── Error Handling ────────────────────────────────────────────────────

  it("throws on unknown audit ID", async () => {
    const mockQuery: CypherQueryFn = async () => [];
    const auditor = new PrivacyAuditor(mockQuery, emitter, {}, { emitTelemetry: false });

    await expect(auditor.runAudit("nonexistent_audit")).rejects.toThrow(
      "Unknown audit: nonexistent_audit",
    );
  });

  // ─── Telemetry Integration ─────────────────────────────────────────────

  it("logs audit results to Tier 1 telemetry when enabled", async () => {
    const mockQuery: CypherQueryFn = async (cypher) => {
      if (cypher.includes("NOT (s)<-[:SOURCED_FROM]-()")) {
        return [{ s: { title: "Orphan" } }];
      }
      return [];
    };

    const telemetryEmitter = new TelemetryEmitter(tmpDir);
    const auditor = new PrivacyAuditor(mockQuery, telemetryEmitter, {}, { emitTelemetry: true });
    const report = await auditor.runAllAudits();

    // Read today's events
    const events = await telemetryEmitter.readEvents(new Date());
    const auditEvents = events.filter(
      (e) => e.event_subtype === "privacy_audit",
    );
    const escalationEvents = events.filter(
      (e) => e.event_subtype === "privacy_violation",
    );

    expect(auditEvents.length).toBeGreaterThanOrEqual(1);
    expect(auditEvents[0].agent_name).toBe("privacy_auditor");
    expect(auditEvents[0].event_type).toBe("system_event");
    expect(auditEvents[0].outcome).toBe("failure"); // has escalations
    expect((auditEvents[0].metadata as Record<string, unknown>).total_findings).toBe(1);

    // One escalation event for orphaned_sources
    expect(escalationEvents.length).toBeGreaterThanOrEqual(1);
    expect(escalationEvents[0].event_type).toBe("escalation");
    expect((escalationEvents[0].metadata as Record<string, unknown>).audit_id).toBe("orphaned_sources");
    expect((escalationEvents[0].metadata as Record<string, unknown>).level).toBe("level_3");
  });
});
