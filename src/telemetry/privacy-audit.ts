import { TelemetryEmitter, type TelemetryEventInput } from "./index.js";
import {
  AuditConfigSchema,
  type AuditConfig,
  type AuditDefinition,
  type AuditFinding,
  type AuditReport,
  type CypherQueryFn,
} from "./privacy-audit-types.js";

/**
 * VEGA v3.3 Privacy Audit Cypher Query Library
 *
 * 6 production-ready Cypher queries that enforce privacy boundaries in the
 * Neo4j/Lingelpedia knowledge graph. Integrated into the PrivacyAuditor module.
 *
 * Audits 1-5: non-zero results trigger Level 3 escalation (immediate Mike notification).
 * Audit 6: informational — temporal anomalies are logged but not escalated.
 *
 * The Neo4j driver is injected via `CypherQueryFn` for testability.
 */
export class PrivacyAuditor {
  private readonly config: AuditConfig;
  private readonly audits: AuditDefinition[];

  constructor(
    private readonly queryFn: CypherQueryFn,
    private readonly emitter: TelemetryEmitter,
    config?: Partial<AuditConfig>,
    private readonly options: { emitTelemetry?: boolean } = {},
  ) {
    this.config = AuditConfigSchema.parse(config ?? {});
    this.audits = this.buildAuditDefinitions();
  }

  // ─── Audit Definitions ───────────────────────────────────────────────────

  private buildAuditDefinitions(): AuditDefinition[] {
    return [
      {
        id: "orphaned_sources",
        name: "Orphaned Sources",
        description:
          "Finds Source nodes not referenced by any Claim via SOURCED_FROM relationship",
        cypher: `MATCH (s:Source) WHERE NOT (s)<-[:SOURCED_FROM]-() RETURN s`,
        default_params: {},
        escalation_on_nonzero: true,
        severity: "warning",
      },
      {
        id: "stale_claims",
        name: "Stale Claims",
        description:
          "Finds Claim nodes not re-verified within the configured threshold",
        cypher: `MATCH (c:Claim) WHERE c.last_verified < datetime() - duration({days: $stale_days}) RETURN c`,
        default_params: { stale_days: this.config.stale_claim_days },
        escalation_on_nonzero: true,
        severity: "warning",
      },
      {
        id: "cross_account_leakage",
        name: "Cross-Account Leakage",
        description:
          "Detects information crossing from personal sources to confidential business entities",
        cypher: [
          `MATCH (s:Source {source_account: $personal_account})<-[:SOURCED_FROM]-(c:Claim)-[:RELATES_TO]->(e:Entity)`,
          `WHERE e.tags IS NOT NULL AND $confidential_tag IN e.tags`,
          `RETURN s, c, e`,
        ].join(" "),
        default_params: {
          personal_account: this.config.personal_source_account,
          confidential_tag: this.config.confidential_tag,
        },
        escalation_on_nonzero: true,
        severity: "critical",
      },
      {
        id: "missing_truth_tier",
        name: "Missing Truth Tier",
        description:
          "Finds Claim nodes without a truth_tier classification",
        cypher: `MATCH (c:Claim) WHERE c.truth_tier IS NULL RETURN c`,
        default_params: {},
        escalation_on_nonzero: true,
        severity: "warning",
      },
      {
        id: "permission_boundary",
        name: "Permission Boundary",
        description:
          "Verifies no claim from personal source references confidential business entities",
        cypher: [
          `MATCH (s:Source {source_account: $personal_account})<-[:SOURCED_FROM]-(c:Claim)-[:RELATES_TO]->(e:Entity)`,
          `WHERE e.domain = $confidential_tag`,
          `RETURN s, c, e`,
        ].join(" "),
        default_params: {
          personal_account: this.config.personal_source_account,
          confidential_tag: this.config.confidential_tag,
        },
        escalation_on_nonzero: true,
        severity: "critical",
      },
      {
        id: "temporal_anomalies",
        name: "Temporal Anomalies",
        description:
          "Finds Claims with logically impossible timestamps (created_date > last_verified)",
        cypher: `MATCH (c:Claim) WHERE c.created_date > c.last_verified RETURN c`,
        default_params: {},
        escalation_on_nonzero: false,
        severity: "info",
      },
    ];
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Get all audit definitions (useful for inspection/documentation) */
  getAuditDefinitions(): AuditDefinition[] {
    return [...this.audits];
  }

  /** Get a single audit definition by ID */
  getAudit(auditId: string): AuditDefinition | undefined {
    return this.audits.find((a) => a.id === auditId);
  }

  /**
   * Run a single audit by ID with optional parameter overrides.
   * Returns the finding with escalation status.
   */
  async runAudit(
    auditId: string,
    paramOverrides?: Record<string, unknown>,
  ): Promise<AuditFinding> {
    const audit = this.audits.find((a) => a.id === auditId);
    if (!audit) {
      throw new Error(`Unknown audit: ${auditId}`);
    }

    const params = { ...audit.default_params, ...paramOverrides };
    const rows = await this.queryFn(audit.cypher, params);

    const escalationTriggered =
      audit.escalation_on_nonzero && rows.length > 0;

    const finding: AuditFinding = {
      audit_id: audit.id,
      audit_name: audit.name,
      severity: audit.severity,
      finding_count: rows.length,
      findings: rows,
      escalation_triggered: escalationTriggered,
      escalation_level: escalationTriggered ? "level_3" : null,
    };

    return finding;
  }

  /**
   * Run all 6 audits and produce a full report.
   * Non-zero results on audits 1-5 trigger Level 3 escalation.
   */
  async runAllAudits(
    paramOverrides?: Record<string, Record<string, unknown>>,
  ): Promise<AuditReport> {
    const findings: AuditFinding[] = [];

    for (const audit of this.audits) {
      const overrides = paramOverrides?.[audit.id];
      const finding = await this.runAudit(audit.id, overrides);
      findings.push(finding);
    }

    const escalations = findings
      .filter((f) => f.escalation_triggered)
      .map((f) => ({
        audit_id: f.audit_id,
        level: "level_3" as const,
        finding_count: f.finding_count,
        description: `${f.audit_name}: ${f.finding_count} finding(s) detected — immediate review required`,
      }));

    const totalFindings = findings.reduce(
      (sum, f) => sum + f.finding_count,
      0,
    );

    const report: AuditReport = {
      run_at: new Date(),
      audits_run: findings.length,
      total_findings: totalFindings,
      findings,
      escalations,
      has_escalations: escalations.length > 0,
      markdown: this.renderReport(findings, escalations, totalFindings),
    };

    // Log to telemetry
    if (this.options.emitTelemetry !== false) {
      await this.logToTelemetry(report);
    }

    return report;
  }

  // ─── Telemetry Logging ───────────────────────────────────────────────────

  private async logToTelemetry(report: AuditReport): Promise<void> {
    const event: TelemetryEventInput = {
      agent_name: "privacy_auditor",
      event_type: "system_event",
      event_subtype: "privacy_audit",
      session_id: `privacy-audit-${report.run_at.toISOString()}`,
      outcome: report.has_escalations ? "failure" : "success",
      metadata: {
        audits_run: report.audits_run,
        total_findings: report.total_findings,
        escalation_count: report.escalations.length,
        findings_by_audit: Object.fromEntries(
          report.findings.map((f) => [f.audit_id, f.finding_count]),
        ),
      },
    };

    await this.emitter.emit(event);

    // Log individual escalations
    for (const esc of report.escalations) {
      await this.emitter.emit({
        agent_name: "privacy_auditor",
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
  }

  // ─── Markdown Report ─────────────────────────────────────────────────────

  private renderReport(
    findings: AuditFinding[],
    escalations: { audit_id: string; level: string; finding_count: number; description: string }[],
    totalFindings: number,
  ): string {
    const lines: string[] = [
      "# Privacy Audit Report",
      "",
      `**Run at:** ${new Date().toISOString()}`,
      `**Audits run:** ${findings.length}`,
      `**Total findings:** ${totalFindings}`,
      `**Escalations:** ${escalations.length}`,
      "",
    ];

    if (escalations.length > 0) {
      lines.push("## Escalations (Level 3 — Immediate Mike Notification)");
      lines.push("");
      for (const esc of escalations) {
        lines.push(`- **${esc.audit_id}**: ${esc.description}`);
      }
      lines.push("");
    }

    lines.push("## Audit Results");
    lines.push("");

    for (const finding of findings) {
      const status =
        finding.finding_count === 0 ? "PASS" : "FINDINGS";
      const icon = finding.finding_count === 0 ? "✅" : "⚠️";

      lines.push(
        `### ${icon} ${finding.audit_name} (${finding.audit_id}) — ${status}`,
      );
      lines.push("");
      lines.push(`- **Severity:** ${finding.severity}`);
      lines.push(`- **Findings:** ${finding.finding_count}`);
      if (finding.escalation_triggered) {
        lines.push(`- **Escalation:** Level 3 triggered`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}
