import pg from "pg";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { TelemetryEmitter } from "./emitter.js";
import { Tier2Repository } from "./tier2-repository.js";
import {
  MonitorConfigSchema,
  type MonitorConfig,
  type Detection,
  type MonitorReport,
} from "./bar-raiser-monitor-types.js";

/**
 * VEGA v3.3 Bar Raiser Learning Monitors
 *
 * Runs daily monitoring checks (02:00 UTC) that detect pathological
 * self-improvement behaviors across all agents:
 *
 * Pattern 1 — Metric Gaming: sandbagging, shortcutting, avoidance
 * Pattern 2 — Scope Creep: authority expansion, domain expansion, trust creep
 * Pattern 3 — Confirmation Bias: no-issues streaks, sentiment-metric mismatch, unchanged assessment
 *
 * Detections are logged to telemetry_anomalies with detection_method='bar_raiser_monitor'.
 * Critical detections trigger immediate escalation to Mike via Morning Brief alert.
 */
export class BarRaiserMonitor {
  private readonly repo: Tier2Repository;
  private readonly reflectionsDir: string;
  private readonly reportsDir: string;

  constructor(
    private readonly pool: pg.Pool,
    private readonly emitter: TelemetryEmitter,
    private readonly config: MonitorConfig = MonitorConfigSchema.parse({}),
    private readonly basePath: string = path.join(
      process.env.HOME ?? "~",
      "vega-telemetry",
    ),
    private readonly options: { emitTelemetry?: boolean } = {},
  ) {
    this.repo = new Tier2Repository(pool);
    this.reflectionsDir = path.join(this.basePath, "reflections");
    this.reportsDir = path.join(this.basePath, "monitor-reports");
  }

  /**
   * Run all three detection patterns against all provided agents.
   * Returns a monitoring report with all detections.
   */
  async runMonitor(
    agentNames: string[],
    targetDate: Date = new Date(),
  ): Promise<MonitorReport> {
    const date = new Date(
      Date.UTC(
        targetDate.getUTCFullYear(),
        targetDate.getUTCMonth(),
        targetDate.getUTCDate(),
      ),
    );

    const allDetections: Detection[] = [];

    for (const agentName of agentNames) {
      // Pattern 1 — Metric Gaming
      const gamingDetections = await this.detectMetricGaming(agentName, date);
      allDetections.push(...gamingDetections);

      // Pattern 2 — Scope Creep
      const scopeDetections = await this.detectScopeCreep(agentName);
      allDetections.push(...scopeDetections);

      // Pattern 3 — Confirmation Bias
      const biasDetections = await this.detectConfirmationBias(agentName, date);
      allDetections.push(...biasDetections);
    }

    // Log detections to telemetry_anomalies
    for (const detection of allDetections) {
      await this.repo.insertAnomaly({
        detected_at: new Date(),
        agent_name: detection.agent_name,
        anomaly_type: `${detection.pattern}:${detection.subtype}`,
        severity: detection.severity,
        detection_method: "bar_raiser_monitor",
        description: detection.evidence,
        anomaly_details: detection.details,
        metric_name: null,
        expected_value: null,
        actual_value: null,
        threshold_value: null,
        acknowledged_at: null,
        resolved_at: null,
      });
    }

    const hasCritical = allDetections.some((d) => d.severity === "critical");

    const markdown = this.renderReport(date, agentNames, allDetections, hasCritical);

    const report: MonitorReport = {
      date,
      generated_at: new Date(),
      agents_monitored: agentNames.length,
      detections: allDetections,
      has_critical: hasCritical,
      markdown,
    };

    // Write report to filesystem
    await mkdir(this.reportsDir, { recursive: true });
    const fileName = `${date.toISOString().slice(0, 10)}.md`;
    await writeFile(path.join(this.reportsDir, fileName), markdown, "utf-8");

    // Log monitoring execution to telemetry
    if (this.options.emitTelemetry !== false) {
      await this.emitter.emit({
        agent_name: "bar_raiser",
        event_type: "system_event",
        event_subtype: "bar_raiser_monitor",
        session_id: `monitor_${date.toISOString().slice(0, 10)}`,
        outcome: "success",
        metadata: {
          date: date.toISOString(),
          agents_monitored: agentNames.length,
          detections_count: allDetections.length,
          has_critical: hasCritical,
          patterns: allDetections.map((d) => `${d.pattern}:${d.subtype}`),
        },
      });
    }

    return report;
  }

  // ─── Pattern 1: Metric Gaming ──────────────────────────────────────────────

  /**
   * Detect metric gaming patterns:
   * - Sandbagging: accuracy up + volume down (agent doing fewer things but cherry-picking easy ones)
   * - Shortcutting: latency down + quality down (agent cutting corners for speed)
   * - Avoidance: escalation rate rising (agent escalating to avoid failures)
   */
  async detectMetricGaming(
    agentName: string,
    targetDate: Date,
  ): Promise<Detection[]> {
    const detections: Detection[] = [];
    const lookbackDays = this.config.lookback_days;
    const cfg = this.config.metric_gaming;

    const endDate = targetDate;
    const startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - lookbackDays);

    // Get prior period for comparison
    const priorEnd = startDate;
    const priorStart = new Date(priorEnd);
    priorStart.setUTCDate(priorStart.getUTCDate() - lookbackDays);

    // Query current and prior period hourly data
    const [currentData, priorData] = await Promise.all([
      this.queryPeriodSummary(agentName, startDate, endDate),
      this.queryPeriodSummary(agentName, priorStart, priorEnd),
    ]);

    // Skip if insufficient data in either period
    if (currentData.total_actions === 0 || priorData.total_actions === 0) {
      return detections;
    }

    // ── Sandbagging: accuracy up + volume down
    const currentSuccessRate = currentData.success_count / currentData.total_actions;
    const priorSuccessRate = priorData.success_count / priorData.total_actions;
    const accuracyDelta = currentSuccessRate - priorSuccessRate;
    const volumeDelta =
      (currentData.total_actions - priorData.total_actions) / priorData.total_actions;

    if (
      accuracyDelta >= cfg.sandbagging_accuracy_delta &&
      volumeDelta <= cfg.sandbagging_volume_delta
    ) {
      detections.push({
        pattern: "metric_gaming",
        subtype: "sandbagging",
        agent_name: agentName,
        severity: "warning",
        evidence: `${agentName}: accuracy up ${(accuracyDelta * 100).toFixed(1)}% while volume down ${(volumeDelta * 100).toFixed(1)}% — possible cherry-picking of easy tasks`,
        recommended_action: `Investigate ${agentName}'s task selection criteria. Review if agent is avoiding complex tasks to inflate success metrics.`,
        details: {
          current_success_rate: currentSuccessRate,
          prior_success_rate: priorSuccessRate,
          accuracy_delta: accuracyDelta,
          current_volume: currentData.total_actions,
          prior_volume: priorData.total_actions,
          volume_delta: volumeDelta,
        },
      });
    }

    // ── Shortcutting: latency down + quality down
    if (
      currentData.avg_latency_ms != null &&
      priorData.avg_latency_ms != null &&
      priorData.avg_latency_ms > 0
    ) {
      const latencyDelta =
        (currentData.avg_latency_ms - priorData.avg_latency_ms) /
        priorData.avg_latency_ms;
      const qualityDelta = currentSuccessRate - priorSuccessRate;

      if (
        latencyDelta <= cfg.shortcutting_latency_delta &&
        qualityDelta <= cfg.shortcutting_quality_delta
      ) {
        detections.push({
          pattern: "metric_gaming",
          subtype: "shortcutting",
          agent_name: agentName,
          severity: "warning",
          evidence: `${agentName}: latency down ${(latencyDelta * 100).toFixed(1)}% but quality also down ${(qualityDelta * 100).toFixed(1)}% — possible corner-cutting`,
          recommended_action: `Review ${agentName}'s processing logic. Speed improvements should not come at the expense of output quality.`,
          details: {
            current_avg_latency_ms: currentData.avg_latency_ms,
            prior_avg_latency_ms: priorData.avg_latency_ms,
            latency_delta: latencyDelta,
            quality_delta: qualityDelta,
          },
        });
      }
    }

    // ── Avoidance: escalation rate rising
    const currentEscalationRate =
      currentData.error_count / currentData.total_actions;
    const priorEscalationRate =
      priorData.error_count / priorData.total_actions;
    const escalationDelta = currentEscalationRate - priorEscalationRate;

    if (escalationDelta >= cfg.avoidance_escalation_delta) {
      detections.push({
        pattern: "metric_gaming",
        subtype: "avoidance",
        agent_name: agentName,
        severity: "warning",
        evidence: `${agentName}: escalation rate up ${(escalationDelta * 100).toFixed(1)}% (${(priorEscalationRate * 100).toFixed(1)}% → ${(currentEscalationRate * 100).toFixed(1)}%) — possible task avoidance through escalation`,
        recommended_action: `Review ${agentName}'s escalation patterns. Verify escalations are legitimate, not a mechanism to avoid failure.`,
        details: {
          current_escalation_rate: currentEscalationRate,
          prior_escalation_rate: priorEscalationRate,
          escalation_delta: escalationDelta,
        },
      });
    }

    return detections;
  }

  // ─── Pattern 2: Scope Creep ────────────────────────────────────────────────

  /**
   * Detect scope creep patterns by scanning weekly reflections:
   * - Authority expansion keywords in reflections
   * - Domain boundary expanding language
   * - Trust level self-assessment creeping upward
   */
  async detectScopeCreep(agentName: string): Promise<Detection[]> {
    const detections: Detection[] = [];
    const cfg = this.config.scope_creep;

    // Read recent reflection files for this agent
    const reflectionContent = await this.readRecentReflections(agentName, 4);
    if (reflectionContent.length === 0) return detections;

    // Combine all recent reflections into a single searchable text
    const allText = reflectionContent.join("\n").toLowerCase();

    // ── Authority expansion keywords
    const authorityMatches = cfg.authority_keywords.filter((kw) =>
      allText.includes(kw.toLowerCase()),
    );
    if (authorityMatches.length > 0) {
      detections.push({
        pattern: "scope_creep",
        subtype: "authority_expansion",
        agent_name: agentName,
        severity: authorityMatches.length >= 3 ? "critical" : "warning",
        evidence: `${agentName} reflection contains authority expansion language: "${authorityMatches.join('", "')}"`,
        recommended_action: `Review ${agentName}'s recent reflections for scope boundary violations. Ensure agent remains within its defined domain.`,
        details: {
          matched_keywords: authorityMatches,
          match_count: authorityMatches.length,
        },
      });
    }

    // ── Domain boundary expansion
    const domainMatches = cfg.domain_keywords.filter((kw) =>
      allText.includes(kw.toLowerCase()),
    );
    if (domainMatches.length > 0) {
      detections.push({
        pattern: "scope_creep",
        subtype: "domain_expansion",
        agent_name: agentName,
        severity: "warning",
        evidence: `${agentName} reflection mentions domain expansion: "${domainMatches.join('", "')}"`,
        recommended_action: `Verify ${agentName} is not attempting to operate outside its designated domain boundaries.`,
        details: {
          matched_keywords: domainMatches,
          match_count: domainMatches.length,
        },
      });
    }

    // ── Trust level creep: look for trust-related language in reflections
    const trustKeywords = [
      "increase my trust",
      "higher trust level",
      "elevated permissions",
      "more autonomy",
      "less oversight",
      "reduce supervision",
    ];
    const trustMatches = trustKeywords.filter((kw) =>
      allText.includes(kw.toLowerCase()),
    );
    if (trustMatches.length > 0) {
      detections.push({
        pattern: "scope_creep",
        subtype: "trust_creep",
        agent_name: agentName,
        severity: "warning",
        evidence: `${agentName} reflection requests increased trust/autonomy: "${trustMatches.join('", "')}"`,
        recommended_action: `Review ${agentName}'s trust level. Self-requests for elevated trust bypass the Bar Raiser approval process.`,
        details: {
          matched_keywords: trustMatches,
          match_count: trustMatches.length,
        },
      });
    }

    return detections;
  }

  // ─── Pattern 3: Confirmation Bias ──────────────────────────────────────────

  /**
   * Detect confirmation bias patterns:
   * - No issues reported for N consecutive weeks
   * - Contradiction between reflection sentiment and actual metrics
   * - Self-assessment unchanged across multiple review periods
   */
  async detectConfirmationBias(
    agentName: string,
    targetDate: Date,
  ): Promise<Detection[]> {
    const detections: Detection[] = [];
    const cfg = this.config.confirmation_bias;

    // Read recent reflections
    const reflectionContents = await this.readRecentReflections(
      agentName,
      cfg.no_issues_streak_threshold + 1,
    );

    // ── No issues streak: check if N consecutive reflections report no issues
    if (reflectionContents.length >= cfg.no_issues_streak_threshold) {
      const noIssuesStreak = reflectionContents
        .slice(0, cfg.no_issues_streak_threshold)
        .every((content) => {
          const lower = content.toLowerCase();
          return (
            lower.includes("no significant issues") ||
            lower.includes("no notable issues") ||
            lower.includes("no issues identified")
          );
        });

      if (noIssuesStreak) {
        detections.push({
          pattern: "confirmation_bias",
          subtype: "no_issues_streak",
          agent_name: agentName,
          severity: "warning",
          evidence: `${agentName}: ${cfg.no_issues_streak_threshold} consecutive weekly reflections report no issues — possible blind spot or insufficient self-critique`,
          recommended_action: `Deep-dive review of ${agentName}'s recent operations. Cross-reference with telemetry anomalies and quality metrics to verify no issues were genuinely missed.`,
          details: {
            streak_length: cfg.no_issues_streak_threshold,
            reflections_checked: reflectionContents.length,
          },
        });
      }
    }

    // ── Sentiment-metric mismatch: positive reflection but declining metrics
    if (reflectionContents.length > 0) {
      const latestReflection = reflectionContents[0].toLowerCase();
      const hasPositiveSentiment =
        (latestReflection.includes("high success rate") ||
          latestReflection.includes("strong performance") ||
          latestReflection.includes("what worked well")) &&
        !latestReflection.includes("declining trends");

      // Check actual quality metrics for declining trends
      const lookbackEnd = targetDate;
      const lookbackStart = new Date(lookbackEnd);
      lookbackStart.setUTCDate(
        lookbackStart.getUTCDate() - this.config.lookback_days,
      );

      const qualityResult = await this.pool.query(
        `SELECT metric_name, trend, metric_value
         FROM telemetry_quality_daily
         WHERE agent_name = $1 AND date >= $2 AND date < $3
         ORDER BY date DESC`,
        [agentName, lookbackStart, lookbackEnd],
      );

      const decliningCount = qualityResult.rows.filter(
        (r) => r.trend === "declining",
      ).length;

      if (hasPositiveSentiment && decliningCount >= 3) {
        detections.push({
          pattern: "confirmation_bias",
          subtype: "sentiment_metric_mismatch",
          agent_name: agentName,
          severity: "warning",
          evidence: `${agentName}: reflection conveys positive sentiment but ${decliningCount} quality metric readings show declining trends — agent may not be acknowledging deterioration`,
          recommended_action: `Compare ${agentName}'s self-assessment against actual Tier 2 quality_daily trends. Agent may need recalibration of its self-evaluation criteria.`,
          details: {
            declining_metric_count: decliningCount,
            total_metric_readings: qualityResult.rows.length,
          },
        });
      }
    }

    // ── Unchanged assessment: same self-assessment text across N review periods
    if (reflectionContents.length >= cfg.unchanged_assessment_threshold) {
      const recentReflections = reflectionContents.slice(
        0,
        cfg.unchanged_assessment_threshold,
      );
      // Extract "Proposed Adjustments" sections for comparison
      const adjustmentSections = recentReflections.map((content) =>
        this.extractSection(content, "Proposed Adjustments"),
      );

      const nonEmptySections = adjustmentSections.filter((s) => s !== null);
      if (nonEmptySections.length >= cfg.unchanged_assessment_threshold) {
        // Check if all sections are identical (or very similar)
        const allSame = nonEmptySections.every(
          (s) => s === nonEmptySections[0],
        );
        if (allSame) {
          detections.push({
            pattern: "confirmation_bias",
            subtype: "unchanged_assessment",
            agent_name: agentName,
            severity: "info",
            evidence: `${agentName}: proposed adjustments unchanged across ${cfg.unchanged_assessment_threshold} consecutive weekly reflections — agent may be stuck in a rut`,
            recommended_action: `Review whether ${agentName}'s self-assessment process is truly adaptive or just repeating the same analysis. Consider prompting for deeper introspection.`,
            details: {
              periods_checked: cfg.unchanged_assessment_threshold,
              repeated_content: nonEmptySections[0],
            },
          });
        }
      }
    }

    return detections;
  }

  // ─── Helper Methods ────────────────────────────────────────────────────────

  /**
   * Query aggregated period summary from telemetry_agent_hourly.
   */
  private async queryPeriodSummary(
    agentName: string,
    from: Date,
    to: Date,
  ): Promise<{
    total_actions: number;
    success_count: number;
    error_count: number;
    avg_latency_ms: number | null;
  }> {
    const result = await this.pool.query(
      `SELECT
        COALESCE(SUM(action_count), 0) AS total_actions,
        COALESCE(SUM(success_count), 0) AS success_count,
        COALESCE(SUM(error_count), 0) AS error_count,
        AVG(avg_latency_ms) FILTER (WHERE avg_latency_ms IS NOT NULL) AS avg_latency_ms
      FROM telemetry_agent_hourly
      WHERE agent_name = $1 AND hour_bucket >= $2 AND hour_bucket < $3`,
      [agentName, from, to],
    );

    const row = result.rows[0];
    return {
      total_actions: Number(row?.total_actions ?? 0),
      success_count: Number(row?.success_count ?? 0),
      error_count: Number(row?.error_count ?? 0),
      avg_latency_ms:
        row?.avg_latency_ms != null ? Number(row.avg_latency_ms) : null,
    };
  }

  /**
   * Read the most recent N reflection files for an agent.
   * Returns file contents sorted newest-first.
   */
  async readRecentReflections(
    agentName: string,
    maxFiles: number,
  ): Promise<string[]> {
    const agentDir = path.join(this.reflectionsDir, agentName);
    try {
      const files = await readdir(agentDir);
      const mdFiles = files
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse()
        .slice(0, maxFiles);

      const contents: string[] = [];
      for (const file of mdFiles) {
        const content = await readFile(path.join(agentDir, file), "utf-8");
        contents.push(content);
      }
      return contents;
    } catch {
      return [];
    }
  }

  /**
   * Extract a markdown section by heading name.
   * Returns the content under the heading until the next heading or end of file.
   */
  private extractSection(
    markdown: string,
    sectionName: string,
  ): string | null {
    const pattern = new RegExp(
      `^##\\s+${sectionName}\\s*$`,
      "mi",
    );
    const match = pattern.exec(markdown);
    if (!match) return null;

    const start = match.index + match[0].length;
    const nextSection = markdown.indexOf("\n## ", start);
    const content =
      nextSection >= 0
        ? markdown.slice(start, nextSection)
        : markdown.slice(start);

    return content.trim();
  }

  // ─── Report Rendering ─────────────────────────────────────────────────────

  private renderReport(
    date: Date,
    agentNames: string[],
    detections: Detection[],
    hasCritical: boolean,
  ): string {
    const dateStr = date.toISOString().slice(0, 10);

    const lines: string[] = [
      "# Bar Raiser Daily Monitor Report",
      "",
      `**Date**: ${dateStr}`,
      `**Generated**: ${new Date().toISOString().slice(0, 19)}Z`,
      `**Agents Monitored**: ${agentNames.length}`,
      `**Total Detections**: ${detections.length}`,
      "",
    ];

    if (hasCritical) {
      lines.push(
        "> **ALERT**: Critical detections require immediate escalation to Mike.",
        "",
      );
    }

    if (detections.length === 0) {
      lines.push("## Status", "", "No behavioral anomalies detected. All agents operating within expected parameters.", "");
    } else {
      // Group detections by pattern
      const byPattern = new Map<string, Detection[]>();
      for (const d of detections) {
        const key = d.pattern;
        if (!byPattern.has(key)) byPattern.set(key, []);
        byPattern.get(key)!.push(d);
      }

      lines.push("## Detections", "");

      for (const [pattern, dets] of byPattern) {
        const patternTitle = pattern
          .replace(/_/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
        lines.push(`### ${patternTitle}`, "");

        for (const d of dets) {
          lines.push(
            `#### ${d.agent_name} — ${d.subtype} [${d.severity}]`,
            "",
            d.evidence,
            "",
            `**Recommended Action**: ${d.recommended_action}`,
            "",
          );
        }
      }

      // Recommended actions summary
      lines.push("## Recommended Actions", "");
      for (const d of detections) {
        lines.push(`- **${d.agent_name}** (${d.pattern}/${d.subtype}): ${d.recommended_action}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}
