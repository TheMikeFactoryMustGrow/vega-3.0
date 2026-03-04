import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  KnowledgePrivacyAuditor,
  type KnowledgeAuditFinding,
  type KnowledgePrivacyAuditorConfig,
} from "./privacy-auditor.js";
import { TelemetryEmitter } from "../telemetry/emitter.js";

/**
 * KnowledgePrivacyAuditor tests — verifies all 6 production privacy audits.
 *
 * Uses mock Neo4j sessions for deterministic testing.
 * Does NOT require a running Neo4j or PostgreSQL instance.
 */

let emitter: TelemetryEmitter;
let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "vega-privacy-audit-test-"));
  emitter = new TelemetryEmitter(tempDir);
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── Mock Helpers ───────────────────────────────────────────────────────

function createMockRecord(data: Record<string, unknown>) {
  return {
    keys: Object.keys(data),
    get: (key: string) => data[key],
  };
}

function createMockNeo4jResult(records: Record<string, unknown>[]) {
  return {
    records: records.map(createMockRecord),
  };
}

function createMockSession(runImpl?: (...args: unknown[]) => Promise<unknown>) {
  const mockRun = runImpl
    ? vi.fn(runImpl)
    : vi.fn().mockResolvedValue(createMockNeo4jResult([{ count: 0 }]));

  return {
    run: mockRun,
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockConnection(sessionFactory?: () => ReturnType<typeof createMockSession>) {
  const defaultSession = createMockSession();
  return {
    session: sessionFactory
      ? vi.fn(sessionFactory)
      : vi.fn(() => defaultSession),
  };
}

function createMockPool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  };
}

function createAuditor(opts: {
  sessionFactory?: () => ReturnType<typeof createMockSession>;
  pool?: ReturnType<typeof createMockPool> | null;
  identityAgents?: string[];
} = {}) {
  const connection = createMockConnection(opts.sessionFactory);
  const pool = opts.pool === null ? null : (opts.pool ?? createMockPool());

  const config: KnowledgePrivacyAuditorConfig = {
    connection: connection as unknown as KnowledgePrivacyAuditorConfig["connection"],
    pool: pool as unknown as KnowledgePrivacyAuditorConfig["pool"],
    emitter,
    identity_agents: opts.identityAgents,
  };

  return { auditor: new KnowledgePrivacyAuditor(config), connection, pool };
}

// ── Audit Definitions ──────────────────────────────────────────────────

describe("KnowledgePrivacyAuditor — Definitions", () => {
  it("exposes 6 knowledge audit definitions", () => {
    const { auditor } = createAuditor();
    const defs = auditor.getAuditDefinitions();
    expect(defs).toHaveLength(6);
    expect(defs.map((d) => d.id)).toEqual([
      "sole_write_owner",
      "children_harrison",
      "children_beckham",
      "connector_scope_drive",
      "cross_domain_health",
      "agent_access_anomaly",
    ]);
  });

  it("returns individual audit by ID", () => {
    const { auditor } = createAuditor();
    const audit = auditor.getAudit("sole_write_owner");
    expect(audit).toBeDefined();
    expect(audit!.name).toBe("Sole Write Owner");
    expect(audit!.escalation_on_nonzero).toBe(true);
  });

  it("all queries are parameterized (no hardcoded values)", () => {
    const { auditor } = createAuditor();
    const defs = auditor.getAuditDefinitions();
    for (const def of defs) {
      // Verify queries use $parameter syntax
      expect(def.cypher).toMatch(/\$/);
      // Verify params are provided
      expect(Object.keys(def.params).length).toBeGreaterThan(0);
    }
  });

  it("audits 1-5 have escalation_on_nonzero = true", () => {
    const { auditor } = createAuditor();
    const defs = auditor.getAuditDefinitions();
    for (let i = 0; i < 5; i++) {
      expect(defs[i].escalation_on_nonzero).toBe(true);
    }
  });

  it("audit 6 (agent_access_anomaly) has escalation_on_nonzero = false", () => {
    const { auditor } = createAuditor();
    const def = auditor.getAudit("agent_access_anomaly");
    expect(def!.escalation_on_nonzero).toBe(false);
  });

  it("exposes base v3.3 PrivacyAuditor", () => {
    const { auditor } = createAuditor();
    const base = auditor.getBaseAuditor();
    expect(base).toBeDefined();
    expect(base.getAuditDefinitions()).toHaveLength(6);
  });

  it("default schedule is weekly (7 days)", () => {
    const { auditor } = createAuditor();
    expect(auditor.getScheduleIntervalDays()).toBe(7);
  });
});

// ── Audit 1: Sole Write Owner ──────────────────────────────────────────

describe("Audit 1 — Sole Write Owner", () => {
  it("passes when all claims are created by knowledge_agent", async () => {
    const { auditor } = createAuditor({
      sessionFactory: () => createMockSession(
        async () => createMockNeo4jResult([{ count: 0 }]),
      ),
    });

    const finding = await auditor.runAudit("sole_write_owner");
    expect(finding.finding_count).toBe(0);
    expect(finding.escalation_triggered).toBe(false);
    expect(finding.escalation_level).toBeNull();
  });

  it("detects claims NOT created by knowledge_agent", async () => {
    const { auditor } = createAuditor({
      sessionFactory: () => createMockSession(
        async () => createMockNeo4jResult([{ count: 3 }]),
      ),
    });

    const finding = await auditor.runAudit("sole_write_owner");
    expect(finding.finding_count).toBe(3);
    expect(finding.escalation_triggered).toBe(true);
    expect(finding.escalation_level).toBe("level_3");
  });

  it("uses parameterized query with $agent", async () => {
    const mockSession = createMockSession(
      async () => createMockNeo4jResult([{ count: 0 }]),
    );
    const { auditor } = createAuditor({
      sessionFactory: () => mockSession,
    });

    await auditor.runAudit("sole_write_owner");
    expect(mockSession.run).toHaveBeenCalledWith(
      expect.stringContaining("c.created_by <> $agent"),
      expect.objectContaining({ agent: "knowledge_agent" }),
    );
  });
});

// ── Audit 2: Children's Data Protection (Harrison) ─────────────────────

describe("Audit 2 — Children's Data Protection (Harrison)", () => {
  it("passes when all Harrison claims have children_elevated protection", async () => {
    const { auditor } = createAuditor({
      sessionFactory: () => createMockSession(
        async () => createMockNeo4jResult([{ count: 0 }]),
      ),
    });

    const finding = await auditor.runAudit("children_harrison");
    expect(finding.finding_count).toBe(0);
    expect(finding.escalation_triggered).toBe(false);
  });

  it("detects Harrison claims without children_elevated protection", async () => {
    const { auditor } = createAuditor({
      sessionFactory: () => createMockSession(
        async () => createMockNeo4jResult([{ count: 2 }]),
      ),
    });

    const finding = await auditor.runAudit("children_harrison");
    expect(finding.finding_count).toBe(2);
    expect(finding.escalation_triggered).toBe(true);
    expect(finding.escalation_level).toBe("level_3");
    expect(finding.severity).toBe("critical");
  });

  it("queries with correct params for Harrison Lingle", async () => {
    const mockSession = createMockSession(
      async () => createMockNeo4jResult([{ count: 0 }]),
    );
    const { auditor } = createAuditor({
      sessionFactory: () => mockSession,
    });

    await auditor.runAudit("children_harrison");
    expect(mockSession.run).toHaveBeenCalledWith(
      expect.stringContaining("Entity {name: $name}"),
      expect.objectContaining({ name: "Harrison Lingle", protection: "children_elevated" }),
    );
  });
});

// ── Audit 3: Children's Data Protection (Beckham) ──────────────────────

describe("Audit 3 — Children's Data Protection (Beckham)", () => {
  it("passes when all Beckham claims have children_elevated protection", async () => {
    const { auditor } = createAuditor({
      sessionFactory: () => createMockSession(
        async () => createMockNeo4jResult([{ count: 0 }]),
      ),
    });

    const finding = await auditor.runAudit("children_beckham");
    expect(finding.finding_count).toBe(0);
    expect(finding.escalation_triggered).toBe(false);
  });

  it("detects Beckham claims without children_elevated protection", async () => {
    const { auditor } = createAuditor({
      sessionFactory: () => createMockSession(
        async () => createMockNeo4jResult([{ count: 1 }]),
      ),
    });

    const finding = await auditor.runAudit("children_beckham");
    expect(finding.finding_count).toBe(1);
    expect(finding.escalation_triggered).toBe(true);
    expect(finding.severity).toBe("critical");
  });

  it("queries with correct params for Beckham Lingle", async () => {
    const mockSession = createMockSession(
      async () => createMockNeo4jResult([{ count: 0 }]),
    );
    const { auditor } = createAuditor({
      sessionFactory: () => mockSession,
    });

    await auditor.runAudit("children_beckham");
    expect(mockSession.run).toHaveBeenCalledWith(
      expect.stringContaining("Entity {name: $name}"),
      expect.objectContaining({ name: "Beckham Lingle", protection: "children_elevated" }),
    );
  });
});

// ── Audit 4: Connector Scope (Drive) ───────────────────────────────────

describe("Audit 4 — Connector Scope (Drive)", () => {
  it("passes when all Drive sources are in approved folders", async () => {
    const { auditor } = createAuditor({
      sessionFactory: () => createMockSession(
        async () => createMockNeo4jResult([{ count: 0 }]),
      ),
    });

    const finding = await auditor.runAudit("connector_scope_drive");
    expect(finding.finding_count).toBe(0);
    expect(finding.escalation_triggered).toBe(false);
  });

  it("detects Drive sources from unapproved folders", async () => {
    const { auditor } = createAuditor({
      sessionFactory: () => createMockSession(
        async () => createMockNeo4jResult([{ count: 4 }]),
      ),
    });

    const finding = await auditor.runAudit("connector_scope_drive");
    expect(finding.finding_count).toBe(4);
    expect(finding.escalation_triggered).toBe(true);
  });

  it("queries with correct folder list params", async () => {
    const mockSession = createMockSession(
      async () => createMockNeo4jResult([{ count: 0 }]),
    );
    const { auditor } = createAuditor({
      sessionFactory: () => mockSession,
    });

    await auditor.runAudit("connector_scope_drive");
    expect(mockSession.run).toHaveBeenCalledWith(
      expect.stringContaining("NOT s.folder IN $folders"),
      expect.objectContaining({
        account: "google_drive",
        folders: ["GIX", "WE", "Finance"],
      }),
    );
  });
});

// ── Audit 5: Cross-Domain Leakage (Health) ─────────────────────────────

describe("Audit 5 — Cross-Domain Leakage (Health)", () => {
  it("passes when health claims only come from approved sources", async () => {
    const { auditor } = createAuditor({
      sessionFactory: () => createMockSession(
        async () => createMockNeo4jResult([{ count: 0 }]),
      ),
    });

    const finding = await auditor.runAudit("cross_domain_health");
    expect(finding.finding_count).toBe(0);
    expect(finding.escalation_triggered).toBe(false);
  });

  it("detects health claims from unapproved sources", async () => {
    const { auditor } = createAuditor({
      sessionFactory: () => createMockSession(
        async () => createMockNeo4jResult([{ count: 5 }]),
      ),
    });

    const finding = await auditor.runAudit("cross_domain_health");
    expect(finding.finding_count).toBe(5);
    expect(finding.escalation_triggered).toBe(true);
    expect(finding.severity).toBe("critical");
  });

  it("queries with correct source account params", async () => {
    const mockSession = createMockSession(
      async () => createMockNeo4jResult([{ count: 0 }]),
    );
    const { auditor } = createAuditor({
      sessionFactory: () => mockSession,
    });

    await auditor.runAudit("cross_domain_health");
    expect(mockSession.run).toHaveBeenCalledWith(
      expect.stringContaining("NOT s.source_account IN $accounts"),
      expect.objectContaining({
        domain: "health",
        accounts: ["obsidian_vault", "apple_health"],
      }),
    );
  });
});

// ── Audit 6: Agent Access Anomaly ──────────────────────────────────────

describe("Audit 6 — Agent Access Anomaly", () => {
  it("passes when no anomalous agent access", async () => {
    const { auditor } = createAuditor({
      sessionFactory: () => createMockSession(
        async () => createMockNeo4jResult([]),
      ),
    });

    const finding = await auditor.runAudit("agent_access_anomaly");
    expect(finding.finding_count).toBe(0);
    expect(finding.escalation_triggered).toBe(false);
  });

  it("detects access from unknown agents but does NOT escalate", async () => {
    const { auditor } = createAuditor({
      sessionFactory: () => createMockSession(
        async () => createMockNeo4jResult([
          { agent: "rogue_agent", domain: "health", count: 5 },
          { agent: "other_agent", domain: "finance", count: 3 },
        ]),
      ),
    });

    const finding = await auditor.runAudit("agent_access_anomaly");
    expect(finding.finding_count).toBe(2);
    // Audit 6 does NOT escalate
    expect(finding.escalation_triggered).toBe(false);
    expect(finding.escalation_level).toBeNull();
    expect(finding.severity).toBe("warning");
  });

  it("cross-references agent access against identity declarations", () => {
    const { auditor } = createAuditor({
      identityAgents: ["knowledge_agent", "finance_agent"],
    });

    const findings = [
      { agent: "finance_agent", domain: "finance", count: 10 },
      { agent: "rogue_agent", domain: "health", count: 5 },
    ];

    const unknown = auditor.crossReferenceAgentAccess(findings);
    expect(unknown).toEqual(["rogue_agent"]);
  });

  it("cross-reference returns empty when all agents are declared", () => {
    const { auditor } = createAuditor({
      identityAgents: ["knowledge_agent", "finance_agent"],
    });

    const findings = [
      { agent: "knowledge_agent", domain: "finance", count: 10 },
    ];

    const unknown = auditor.crossReferenceAgentAccess(findings);
    expect(unknown).toEqual([]);
  });
});

// ── Full Audit Suite ───────────────────────────────────────────────────

describe("Full Audit Suite", () => {
  it("runs all 6 audits against clean graph — all pass", async () => {
    const { auditor } = createAuditor({
      sessionFactory: () => createMockSession(
        async () => createMockNeo4jResult([{ count: 0 }]),
      ),
    });

    const report = await auditor.runAllAudits();
    expect(report.audits_run).toBe(6);
    expect(report.total_findings).toBe(0);
    expect(report.has_escalations).toBe(false);
    expect(report.escalations).toHaveLength(0);
    expect(report.findings).toHaveLength(6);

    for (const finding of report.findings) {
      expect(finding.finding_count).toBe(0);
      expect(finding.escalation_triggered).toBe(false);
    }
  });

  it("detects violations and triggers Level 3 escalation", async () => {
    let callIndex = 0;
    const { auditor, pool } = createAuditor({
      sessionFactory: () => createMockSession(async () => {
        const idx = callIndex++;
        // Audit 1 (sole_write_owner) returns violations
        if (idx === 0) return createMockNeo4jResult([{ count: 2 }]);
        // Audit 2 (children_harrison) returns violations
        if (idx === 1) return createMockNeo4jResult([{ count: 1 }]);
        // All others pass
        return createMockNeo4jResult([{ count: 0 }]);
      }),
    });

    const report = await auditor.runAllAudits();
    expect(report.audits_run).toBe(6);
    expect(report.total_findings).toBe(3);
    expect(report.has_escalations).toBe(true);
    expect(report.escalations).toHaveLength(2);

    // Check escalation audit IDs
    expect(report.escalations[0].audit_id).toBe("sole_write_owner");
    expect(report.escalations[0].level).toBe("level_3");
    expect(report.escalations[1].audit_id).toBe("children_harrison");

    // Verify bar_raiser_direct inserts
    expect(pool!.query).toHaveBeenCalled();
    const barRaiserCalls = (pool!.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("bar_raiser_direct"),
    );
    expect(barRaiserCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("logs audit results to privacy_audit_log table", async () => {
    const { auditor, pool } = createAuditor({
      sessionFactory: () => createMockSession(
        async () => createMockNeo4jResult([{ count: 0 }]),
      ),
    });

    await auditor.runAllAudits();

    const logCalls = (pool!.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("privacy_audit_log"),
    );
    // 6 audits → 6 log inserts + schema creation calls
    expect(logCalls.length).toBeGreaterThanOrEqual(6);
  });

  it("emits telemetry for audit run", async () => {
    const spy = vi.spyOn(emitter, "emit");
    spy.mockClear();

    const { auditor } = createAuditor({
      sessionFactory: () => createMockSession(
        async () => createMockNeo4jResult([{ count: 0 }]),
      ),
    });

    await auditor.runAllAudits();

    const auditEvents = spy.mock.calls.filter(
      (call) => call[0].event_subtype === "privacy_audit",
    );
    expect(auditEvents.length).toBeGreaterThanOrEqual(1);
    expect(auditEvents[0][0].outcome).toBe("success");
    expect(auditEvents[0][0].agent_name).toBe("knowledge_agent");

    spy.mockRestore();
  });

  it("emits escalation telemetry when violations found", async () => {
    const spy = vi.spyOn(emitter, "emit");
    spy.mockClear();

    const { auditor } = createAuditor({
      sessionFactory: () => createMockSession(
        async () => createMockNeo4jResult([{ count: 1 }]),
      ),
    });

    await auditor.runAllAudits();

    const escalationEvents = spy.mock.calls.filter(
      (call) => call[0].event_subtype === "privacy_violation",
    );
    // Audits 1-5 escalate → 5 escalation events
    expect(escalationEvents.length).toBe(5);

    // Main audit event should report failure
    const auditEvents = spy.mock.calls.filter(
      (call) => call[0].event_subtype === "privacy_audit",
    );
    expect(auditEvents[0][0].outcome).toBe("failure");

    spy.mockRestore();
  });

  it("handles Neo4j errors gracefully without crashing", async () => {
    let callIndex = 0;
    const { auditor } = createAuditor({
      sessionFactory: () => createMockSession(async () => {
        const idx = callIndex++;
        if (idx === 2) throw new Error("Neo4j connection lost");
        return createMockNeo4jResult([{ count: 0 }]);
      }),
    });

    const report = await auditor.runAllAudits();
    expect(report.audits_run).toBe(6);
    // The failed audit has finding_count = -1
    const failedAudit = report.findings.find((f) => f.finding_count === -1);
    expect(failedAudit).toBeDefined();
    expect(failedAudit!.findings[0].error).toContain("Neo4j connection lost");
  });

  it("works without PostgreSQL pool (no logging/escalation)", async () => {
    const { auditor } = createAuditor({
      pool: null,
      sessionFactory: () => createMockSession(
        async () => createMockNeo4jResult([{ count: 1 }]),
      ),
    });

    // Should not throw even without pool
    const report = await auditor.runAllAudits();
    expect(report.audits_run).toBe(6);
    expect(report.has_escalations).toBe(true);
  });
});

// ── Schema Migration ───────────────────────────────────────────────────

describe("Schema Migration", () => {
  it("applies privacy_audit_log and bar_raiser_direct tables", async () => {
    const { auditor, pool } = createAuditor();
    await auditor.applySchema();

    const schemaCalls = (pool!.query as ReturnType<typeof vi.fn>).mock.calls;
    const ddlStatements = schemaCalls.map((c: unknown[]) => c[0] as string).join(" ");

    expect(ddlStatements).toContain("privacy_audit_log");
    expect(ddlStatements).toContain("bar_raiser_direct");
    expect(ddlStatements).toContain("IF NOT EXISTS");
  });

  it("schema migration is idempotent", async () => {
    const { auditor, pool } = createAuditor();
    await auditor.applySchema();
    await auditor.applySchema();

    // Should succeed without errors both times
    expect(pool!.query).toHaveBeenCalled();
  });
});

// ── Neo4j Integer Handling ─────────────────────────────────────────────

describe("Neo4j Integer Handling", () => {
  it("converts Neo4j integer objects to JS numbers", async () => {
    const neo4jInt = { toNumber: () => 5 };
    const { auditor } = createAuditor({
      sessionFactory: () => createMockSession(
        async () => createMockNeo4jResult([{ count: neo4jInt }]),
      ),
    });

    const finding = await auditor.runAudit("sole_write_owner");
    expect(finding.finding_count).toBe(5);
  });
});

// ── Unknown Audit ID ───────────────────────────────────────────────────

describe("Error Cases", () => {
  it("throws on unknown audit ID", async () => {
    const { auditor } = createAuditor();
    await expect(
      auditor.runAudit("nonexistent" as KnowledgeAuditFinding["audit_id"]),
    ).rejects.toThrow("Unknown knowledge audit");
  });
});
