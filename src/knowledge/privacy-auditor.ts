import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { PrivacyAuditor } from "../telemetry/privacy-audit.js";
import { TelemetryEmitter } from "../telemetry/emitter.js";
import type { Neo4jConnection } from "./neo4j.js";
import type { CypherQueryFn, AuditFinding, AuditReport } from "../telemetry/privacy-audit-types.js";

// ── Types ──────────────────────────────────────────────────────────────

export const KnowledgeAuditId = z.enum([
  "sole_write_owner",
  "children_harrison",
  "children_beckham",
  "connector_scope_drive",
  "cross_domain_health",
  "agent_access_anomaly",
]);
export type KnowledgeAuditId = z.infer<typeof KnowledgeAuditId>;

export interface KnowledgeAuditDefinition {
  id: KnowledgeAuditId;
  name: string;
  description: string;
  cypher: string;
  params: Record<string, unknown>;
  escalation_on_nonzero: boolean;
  severity: "info" | "warning" | "critical";
}

export interface KnowledgeAuditFinding {
  audit_id: KnowledgeAuditId;
  audit_name: string;
  severity: "info" | "warning" | "critical";
  finding_count: number;
  findings: Record<string, unknown>[];
  escalation_triggered: boolean;
  escalation_level: "level_3" | null;
}

export interface KnowledgeAuditReport {
  run_at: Date;
  audits_run: number;
  total_findings: number;
  findings: KnowledgeAuditFinding[];
  escalations: {
    audit_id: KnowledgeAuditId;
    level: "level_3";
    finding_count: number;
    description: string;
  }[];
  has_escalations: boolean;
}

export interface PrivacyAuditLogEntry {
  id: string;
  audit_type: string;
  status: "pass" | "fail";
  finding: string;
  affected_data: string | null;
  affected_agent: string | null;
  recommended_action: string | null;
  created_at: Date;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
  resolution: string | null;
}

export interface KnowledgePrivacyAuditorConfig {
  connection: Neo4jConnection;
  pool?: pg.Pool | null;
  emitter?: TelemetryEmitter;
  schedule_interval_days?: number;
  identity_agents?: string[];
}

// ── SQL DDL ────────────────────────────────────────────────────────────

const PRIVACY_AUDIT_LOG_SQL = `
CREATE TABLE IF NOT EXISTS privacy_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_type VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  finding TEXT NOT NULL,
  affected_data TEXT,
  affected_agent VARCHAR,
  recommended_action TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMP,
  resolved_at TIMESTAMP,
  resolution TEXT
);

CREATE INDEX IF NOT EXISTS idx_privacy_audit_log_type
  ON privacy_audit_log(audit_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_privacy_audit_log_status
  ON privacy_audit_log(status);
`;

const BAR_RAISER_DIRECT_SQL = `
CREATE TABLE IF NOT EXISTS bar_raiser_direct (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  severity VARCHAR NOT NULL,
  flag_type VARCHAR NOT NULL,
  target_agent VARCHAR NOT NULL,
  evidence TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMP,
  resolved_at TIMESTAMP,
  resolution TEXT
);

CREATE INDEX IF NOT EXISTS idx_bar_raiser_direct_severity
  ON bar_raiser_direct(severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bar_raiser_direct_unresolved
  ON bar_raiser_direct(created_at DESC) WHERE resolved_at IS NULL;
`;

// ── Audit Definitions ──────────────────────────────────────────────────

function buildKnowledgeAudits(): KnowledgeAuditDefinition[] {
  return [
    {
      id: "sole_write_owner",
      name: "Sole Write Owner",
      description:
        "Verifies all Claims are created by knowledge_agent — no other agent should write directly",
      cypher: `MATCH (c:Claim) WHERE c.created_by <> $agent RETURN count(c) AS count`,
      params: { agent: "knowledge_agent" },
      escalation_on_nonzero: true,
      severity: "critical",
    },
    {
      id: "children_harrison",
      name: "Children's Data Protection (Harrison)",
      description:
        "Verifies all Claims about Harrison Lingle have children_elevated protection level",
      cypher: `MATCH (e:Entity {name: $name})<-[:ABOUT]-(c:Claim) WHERE NOT c.protection_level = $protection RETURN count(c) AS count`,
      params: { name: "Harrison Lingle", protection: "children_elevated" },
      escalation_on_nonzero: true,
      severity: "critical",
    },
    {
      id: "children_beckham",
      name: "Children's Data Protection (Beckham)",
      description:
        "Verifies all Claims about Beckham Lingle have children_elevated protection level",
      cypher: `MATCH (e:Entity {name: $name})<-[:ABOUT]-(c:Claim) WHERE NOT c.protection_level = $protection RETURN count(c) AS count`,
      params: { name: "Beckham Lingle", protection: "children_elevated" },
      escalation_on_nonzero: true,
      severity: "critical",
    },
    {
      id: "connector_scope_drive",
      name: "Connector Scope (Drive)",
      description:
        "Verifies Google Drive sources only come from approved folders (GIX, WE, Finance)",
      cypher: `MATCH (s:Source) WHERE s.source_account = $account AND NOT s.folder IN $folders RETURN count(s) AS count`,
      params: { account: "google_drive", folders: ["GIX", "WE", "Finance"] },
      escalation_on_nonzero: true,
      severity: "critical",
    },
    {
      id: "cross_domain_health",
      name: "Cross-Domain Leakage (Health)",
      description:
        "Verifies health domain claims only come from approved sources (obsidian_vault, apple_health)",
      cypher: `MATCH (c:Claim {domain: $domain})-[:SOURCED_FROM]->(s:Source) WHERE NOT s.source_account IN $accounts RETURN count(c) AS count`,
      params: { domain: "health", accounts: ["obsidian_vault", "apple_health"] },
      escalation_on_nonzero: true,
      severity: "critical",
    },
    {
      id: "agent_access_anomaly",
      name: "Agent Access Anomaly",
      description:
        "Finds Claims accessed by agents other than knowledge_agent — cross-reference against identity declarations",
      cypher: `MATCH (c:Claim) WHERE c.last_accessed_by IS NOT NULL AND c.last_accessed_by <> $agent RETURN c.last_accessed_by AS agent, c.domain AS domain, count(c) AS count`,
      params: { agent: "knowledge_agent" },
      escalation_on_nonzero: false,
      severity: "warning",
    },
  ];
}

// ── KnowledgePrivacyAuditor ────────────────────────────────────────────

/**
 * KnowledgePrivacyAuditor — extends v3.3 PrivacyAuditor with 6 production
 * Neo4j Cypher queries specified in the Implementation Guide.
 *
 * Audits 1-5: non-zero results trigger Level 3 escalation (immediate Mike notification)
 * via the bar_raiser_direct PostgreSQL table.
 *
 * Audit 6: informational — agent access anomalies are logged but not escalated.
 *
 * Results written to privacy_audit_log PostgreSQL table.
 * Schedule: configurable, default weekly.
 */
export class KnowledgePrivacyAuditor {
  private readonly connection: Neo4jConnection;
  private readonly pool: pg.Pool | null;
  private readonly emitter: TelemetryEmitter;
  private readonly audits: KnowledgeAuditDefinition[];
  private readonly scheduleIntervalDays: number;
  private readonly identityAgents: string[];
  private readonly baseAuditor: PrivacyAuditor;
  private schemaApplied = false;

  constructor(config: KnowledgePrivacyAuditorConfig) {
    this.connection = config.connection;
    this.pool = config.pool ?? null;
    this.emitter = config.emitter ?? new TelemetryEmitter();
    this.scheduleIntervalDays = config.schedule_interval_days ?? 7;
    this.identityAgents = config.identity_agents ?? ["knowledge_agent"];
    this.audits = buildKnowledgeAudits();

    // Create a CypherQueryFn adapter from the Neo4j connection
    const queryFn: CypherQueryFn = async (cypher, params) => {
      const session = this.connection.session();
      try {
        const result = await session.run(cypher, params);
        return result.records.map((record) => {
          const obj: Record<string, unknown> = {};
          for (const key of record.keys) {
            const k = String(key);
            const val = record.get(k);
            obj[k] =
              typeof val === "object" && val !== null && typeof val.toNumber === "function"
                ? val.toNumber()
                : val;
          }
          return obj;
        });
      } finally {
        await session.close();
      }
    };

    this.baseAuditor = new PrivacyAuditor(queryFn, this.emitter, {}, { emitTelemetry: false });
  }

  /** Get the base v3.3 PrivacyAuditor instance */
  getBaseAuditor(): PrivacyAuditor {
    return this.baseAuditor;
  }

  /** Get all knowledge audit definitions */
  getAuditDefinitions(): KnowledgeAuditDefinition[] {
    return [...this.audits];
  }

  /** Get a single audit by ID */
  getAudit(auditId: KnowledgeAuditId): KnowledgeAuditDefinition | undefined {
    return this.audits.find((a) => a.id === auditId);
  }

  /** Get the configured schedule interval in days */
  getScheduleIntervalDays(): number {
    return this.scheduleIntervalDays;
  }

  // ── Schema Migration ──────────────────────────────────────────────────

  /** Apply privacy audit PostgreSQL schema (idempotent) */
  async applySchema(): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(PRIVACY_AUDIT_LOG_SQL);
    await this.pool.query(BAR_RAISER_DIRECT_SQL);
    this.schemaApplied = true;
  }

  // ── Run Individual Audit ──────────────────────────────────────────────

  /** Run a single knowledge audit by ID */
  async runAudit(auditId: KnowledgeAuditId): Promise<KnowledgeAuditFinding> {
    const audit = this.audits.find((a) => a.id === auditId);
    if (!audit) {
      throw new Error(`Unknown knowledge audit: ${auditId}`);
    }

    const session = this.connection.session();
    try {
      const result = await session.run(audit.cypher, audit.params);
      const rows = result.records.map((record) => {
        const obj: Record<string, unknown> = {};
        for (const key of record.keys) {
          const k = String(key);
          const val = record.get(k);
          obj[k] =
            typeof val === "object" && val !== null && typeof val.toNumber === "function"
              ? val.toNumber()
              : val;
        }
        return obj;
      });

      // For count-based audits, check if count > 0
      let findingCount: number;
      if (rows.length === 1 && typeof rows[0].count === "number") {
        findingCount = rows[0].count;
      } else {
        findingCount = rows.length;
      }

      const escalationTriggered = audit.escalation_on_nonzero && findingCount > 0;

      const finding: KnowledgeAuditFinding = {
        audit_id: audit.id,
        audit_name: audit.name,
        severity: audit.severity,
        finding_count: findingCount,
        findings: rows,
        escalation_triggered: escalationTriggered,
        escalation_level: escalationTriggered ? "level_3" : null,
      };

      return finding;
    } finally {
      await session.close();
    }
  }

  // ── Run All Audits ────────────────────────────────────────────────────

  /** Run all 6 knowledge audits and produce a full report */
  async runAllAudits(): Promise<KnowledgeAuditReport> {
    const start = Date.now();
    const findings: KnowledgeAuditFinding[] = [];

    for (const audit of this.audits) {
      try {
        const finding = await this.runAudit(audit.id);
        findings.push(finding);
      } catch (err) {
        // Non-blocking: failed audit logged, not thrown
        findings.push({
          audit_id: audit.id,
          audit_name: audit.name,
          severity: audit.severity,
          finding_count: -1,
          findings: [{ error: String(err) }],
          escalation_triggered: false,
          escalation_level: null,
        });
      }
    }

    const escalations = findings
      .filter((f) => f.escalation_triggered)
      .map((f) => ({
        audit_id: f.audit_id,
        level: "level_3" as const,
        finding_count: f.finding_count,
        description: `${f.audit_name}: ${f.finding_count} violation(s) detected — immediate Mike notification required`,
      }));

    const totalFindings = findings
      .filter((f) => f.finding_count > 0)
      .reduce((sum, f) => sum + f.finding_count, 0);

    const report: KnowledgeAuditReport = {
      run_at: new Date(),
      audits_run: findings.length,
      total_findings: totalFindings,
      findings,
      escalations,
      has_escalations: escalations.length > 0,
    };

    // Log to PostgreSQL and telemetry
    await this.logResults(report);
    await this.emitTelemetry(report, Date.now() - start);

    // Escalate violations
    if (report.has_escalations) {
      await this.escalateViolations(report.escalations);
    }

    return report;
  }

  // ── PostgreSQL Logging ────────────────────────────────────────────────

  private async logResults(report: KnowledgeAuditReport): Promise<void> {
    if (!this.pool) return;

    try {
      if (!this.schemaApplied) {
        await this.applySchema();
      }

      for (const finding of report.findings) {
        const status = finding.finding_count === 0 ? "pass" : "fail";
        const findingText =
          finding.finding_count === 0
            ? `${finding.audit_name}: No violations found`
            : `${finding.audit_name}: ${finding.finding_count} violation(s) detected`;

        const affectedData =
          finding.finding_count > 0 ? JSON.stringify(finding.findings) : null;

        await this.pool.query(
          `INSERT INTO privacy_audit_log (id, audit_type, status, finding, affected_data, affected_agent, recommended_action, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            randomUUID(),
            finding.audit_id,
            status,
            findingText,
            affectedData,
            "knowledge_agent",
            finding.escalation_triggered ? "Level 3 escalation — immediate Mike notification" : null,
            report.run_at,
          ],
        );
      }
    } catch (err) {
      process.stderr.write(`[KnowledgePrivacyAuditor] Failed to log results: ${err}\n`);
    }
  }

  // ── Escalation ────────────────────────────────────────────────────────

  private async escalateViolations(
    escalations: KnowledgeAuditReport["escalations"],
  ): Promise<void> {
    if (!this.pool) return;

    try {
      if (!this.schemaApplied) {
        await this.applySchema();
      }

      for (const esc of escalations) {
        await this.pool.query(
          `INSERT INTO bar_raiser_direct (id, severity, flag_type, target_agent, evidence, recommended_action, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            randomUUID(),
            "critical",
            "privacy_violation",
            "knowledge_agent",
            esc.description,
            `Investigate ${esc.audit_id} — ${esc.finding_count} violation(s) require immediate review`,
            new Date(),
          ],
        );
      }
    } catch (err) {
      process.stderr.write(`[KnowledgePrivacyAuditor] Failed to escalate: ${err}\n`);
    }
  }

  // ── Telemetry ─────────────────────────────────────────────────────────

  private async emitTelemetry(report: KnowledgeAuditReport, latencyMs: number): Promise<void> {
    try {
      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "system_event",
        event_subtype: "privacy_audit",
        session_id: `privacy-audit-${report.run_at.toISOString()}`,
        outcome: report.has_escalations ? "failure" : "success",
        latency_ms: latencyMs,
        metadata: {
          audits_run: report.audits_run,
          total_findings: report.total_findings,
          escalation_count: report.escalations.length,
          findings_by_audit: Object.fromEntries(
            report.findings.map((f) => [f.audit_id, f.finding_count]),
          ),
        },
      });

      for (const esc of report.escalations) {
        await this.emitter.emit({
          agent_name: "knowledge_agent",
          event_type: "escalation",
          event_subtype: "privacy_violation",
          session_id: `privacy-audit-${report.run_at.toISOString()}`,
          outcome: "failure",
          metadata: {
            audit_id: esc.audit_id,
            level: esc.level,
            finding_count: esc.finding_count,
            description: esc.description,
          },
        });
      }
    } catch (err) {
      process.stderr.write(`[KnowledgePrivacyAuditor] Failed to emit telemetry: ${err}\n`);
    }
  }

  // ── Agent Access Anomaly Cross-Reference ──────────────────────────────

  /**
   * Cross-reference agent access anomalies against identity file declarations.
   * Returns agents found in the graph that are NOT in the identity declarations.
   */
  crossReferenceAgentAccess(
    anomalyFindings: Record<string, unknown>[],
  ): string[] {
    const unknownAgents: string[] = [];
    for (const row of anomalyFindings) {
      const agent = row.agent as string;
      if (agent && !this.identityAgents.includes(agent)) {
        unknownAgents.push(agent);
      }
    }
    return unknownAgents;
  }
}
