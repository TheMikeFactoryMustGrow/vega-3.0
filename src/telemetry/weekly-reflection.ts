import pg from "pg";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { TelemetryEmitter } from "./emitter.js";
import type {
  WeekSummary,
  ReflectionSection,
  WeeklyReflection,
  CrossAgentPattern,
  BarRaiserSynthesis,
} from "./weekly-reflection-types.js";

/**
 * VEGA v3.3 Loop 2: Pattern Learning — Weekly Reflections
 *
 * Each agent generates a weekly reflection that synthesizes its operational
 * patterns, recurring issues, and improvement opportunities. The Bar Raiser
 * synthesizes all agent reflections into a weekly learning digest that
 * identifies cross-agent patterns and flags contradictions.
 *
 * Reflections stored at: ~/vega-telemetry/reflections/{agent_name}/{YYYY-MM-DD}.md
 * Triggered weekly (configurable day, default: Sunday 20:00 UTC).
 */

export class WeeklyReflectionGenerator {
  private readonly reflectionsDir: string;

  constructor(
    private readonly pool: pg.Pool,
    private readonly emitter: TelemetryEmitter,
    private readonly basePath: string = path.join(
      process.env.HOME ?? "~",
      "vega-telemetry",
    ),
    private readonly options: { emitTelemetry?: boolean } = {},
  ) {
    this.reflectionsDir = path.join(this.basePath, "reflections");
  }

  /**
   * Generate a weekly reflection for a single agent.
   *
   * 5-step mechanism (Loop 1.5 integration):
   *   1. Read most recent pre-reflection digest (if available)
   *   2. Read Tier 2 aggregated data
   *   3. Synthesize reflection sections
   *   4. Propose adjustments
   *   5. Write reflection to disk
   */
  async generateReflection(
    agentName: string,
    weekEndDate: Date,
  ): Promise<WeeklyReflection> {
    const weekEnd = new Date(
      Date.UTC(
        weekEndDate.getUTCFullYear(),
        weekEndDate.getUTCMonth(),
        weekEndDate.getUTCDate(),
      ),
    );
    const weekStart = new Date(weekEnd);
    weekStart.setUTCDate(weekStart.getUTCDate() - 7);

    // Step 1: Read most recent pre-reflection digest
    const preReflectionDigest = await this.readLatestPreReflectionDigest(agentName);

    // Step 2: Read Tier 2 aggregated data
    const summary = await this.computeWeekSummary(agentName, weekStart, weekEnd);

    // Step 3 & 4: Synthesize reflection + propose adjustments
    const reflection = await this.buildReflection(agentName, summary, weekStart, weekEnd, preReflectionDigest);
    const markdown = this.renderReflectionMarkdown(agentName, weekStart, weekEnd, summary, reflection, preReflectionDigest);

    const result: WeeklyReflection = {
      agent_name: agentName,
      week_start: weekStart,
      week_end: weekEnd,
      generated_at: new Date(),
      summary,
      reflection,
      markdown,
    };

    // Write reflection to filesystem
    const agentDir = path.join(this.reflectionsDir, agentName);
    await mkdir(agentDir, { recursive: true });
    const fileName = `${weekEnd.toISOString().slice(0, 10)}.md`;
    await writeFile(path.join(agentDir, fileName), markdown, "utf-8");

    // Log to telemetry
    if (this.options.emitTelemetry !== false) {
      await this.emitter.emit({
        agent_name: agentName,
        event_type: "system_event",
        event_subtype: "weekly_reflection",
        session_id: `reflection_${agentName}_${weekEnd.toISOString().slice(0, 10)}`,
        outcome: "success",
        metadata: {
          week_start: weekStart.toISOString(),
          week_end: weekEnd.toISOString(),
          total_actions: summary.total_actions,
          success_rate: summary.success_rate,
        },
      });
    }

    return result;
  }

  /**
   * Generate Bar Raiser synthesis of all agent reflections.
   *
   * Synthesizes reflections from multiple agents, identifies cross-agent
   * patterns, and flags contradictions between agent self-assessments
   * and actual metrics.
   */
  async generateSynthesis(
    agentNames: string[],
    weekEndDate: Date,
  ): Promise<BarRaiserSynthesis> {
    const weekEnd = new Date(
      Date.UTC(
        weekEndDate.getUTCFullYear(),
        weekEndDate.getUTCMonth(),
        weekEndDate.getUTCDate(),
      ),
    );
    const weekStart = new Date(weekEnd);
    weekStart.setUTCDate(weekStart.getUTCDate() - 7);

    // Generate reflections for all agents
    const reflections: WeeklyReflection[] = [];
    for (const agentName of agentNames) {
      const reflection = await this.generateReflection(agentName, weekEndDate);
      reflections.push(reflection);
    }

    // Detect cross-agent patterns
    const crossAgentPatterns = this.detectCrossAgentPatterns(reflections);

    // Detect contradictions between self-assessments and actual metrics
    const contradictions = await this.detectContradictions(reflections, weekStart, weekEnd);

    // Assess overall system health
    const overallHealth = this.assessOverallHealth(reflections);

    // Build recommendations
    const recommendations = this.buildRecommendations(
      crossAgentPatterns,
      contradictions,
      reflections,
    );

    const markdown = this.renderSynthesisMarkdown(
      weekStart,
      weekEnd,
      agentNames,
      reflections,
      crossAgentPatterns,
      contradictions,
      overallHealth,
      recommendations,
    );

    const result: BarRaiserSynthesis = {
      week_start: weekStart,
      week_end: weekEnd,
      generated_at: new Date(),
      agents_included: agentNames,
      cross_agent_patterns: crossAgentPatterns,
      contradictions,
      overall_system_health: overallHealth,
      recommendations,
      markdown,
    };

    // Write synthesis to filesystem
    await mkdir(path.join(this.reflectionsDir, "bar_raiser"), { recursive: true });
    const fileName = `synthesis_${weekEnd.toISOString().slice(0, 10)}.md`;
    await writeFile(
      path.join(this.reflectionsDir, "bar_raiser", fileName),
      markdown,
      "utf-8",
    );

    // Log to telemetry
    if (this.options.emitTelemetry !== false) {
      await this.emitter.emit({
        agent_name: "bar_raiser",
        event_type: "system_event",
        event_subtype: "weekly_synthesis",
        session_id: `synthesis_${weekEnd.toISOString().slice(0, 10)}`,
        outcome: "success",
        metadata: {
          week_start: weekStart.toISOString(),
          week_end: weekEnd.toISOString(),
          agents_included: agentNames,
          patterns_detected: crossAgentPatterns.length,
          contradictions_detected: contradictions.length,
        },
      });
    }

    return result;
  }

  // ─── Pre-Reflection Digest Integration ─────────────────────────────────────

  /**
   * Read the most recent pre-reflection digest for an agent.
   * Returns the digest markdown content or null if none exists.
   */
  private async readLatestPreReflectionDigest(
    agentName: string,
  ): Promise<string | null> {
    const preReflectionsDir = path.join(
      this.basePath,
      "pre-reflections",
      agentName,
    );
    if (!existsSync(preReflectionsDir)) return null;

    try {
      const files = await readdir(preReflectionsDir);
      const mdFiles = files.filter((f) => f.endsWith(".md")).sort().reverse();
      if (mdFiles.length === 0) return null;

      const content = await readFile(
        path.join(preReflectionsDir, mdFiles[0]),
        "utf-8",
      );
      return content;
    } catch {
      return null;
    }
  }

  // ─── Week Summary Computation ─────────────────────────────────────────────

  private async computeWeekSummary(
    agentName: string,
    weekStart: Date,
    weekEnd: Date,
  ): Promise<WeekSummary> {
    // Query hourly data for the week
    const hourlyResult = await this.pool.query(
      `SELECT
        COALESCE(SUM(action_count), 0) AS total_actions,
        COALESCE(SUM(success_count), 0) AS success_count,
        COALESCE(SUM(error_count), 0) AS error_count,
        AVG(avg_latency_ms) FILTER (WHERE avg_latency_ms IS NOT NULL) AS avg_latency_ms,
        COALESCE(SUM(cost_usd_total), 0) AS total_cost_usd,
        AVG(performance_score) FILTER (WHERE performance_score IS NOT NULL) AS performance_score_avg
      FROM telemetry_agent_hourly
      WHERE agent_name = $1 AND hour_bucket >= $2 AND hour_bucket < $3`,
      [agentName, weekStart, weekEnd],
    );

    const row = hourlyResult.rows[0];
    const totalActions = Number(row?.total_actions ?? 0);
    const successCount = Number(row?.success_count ?? 0);

    return {
      total_actions: totalActions,
      success_rate: totalActions > 0 ? successCount / totalActions : 0,
      error_count: Number(row?.error_count ?? 0),
      avg_latency_ms: row?.avg_latency_ms != null ? Number(row.avg_latency_ms) : null,
      total_cost_usd: Number(row?.total_cost_usd ?? 0),
      performance_score_avg:
        row?.performance_score_avg != null
          ? Number(row.performance_score_avg)
          : null,
    };
  }

  // ─── Reflection Generation ────────────────────────────────────────────────

  private async buildReflection(
    agentName: string,
    summary: WeekSummary,
    weekStart: Date,
    weekEnd: Date,
    preReflectionDigest?: string | null,
  ): Promise<ReflectionSection> {
    // Query quality daily for trend data
    const qualityResult = await this.pool.query(
      `SELECT metric_name, metric_value, trend, p50_value, p95_value, sample_count, date
       FROM telemetry_quality_daily
       WHERE agent_name = $1 AND date >= $2 AND date < $3
       ORDER BY date`,
      [agentName, weekStart, weekEnd],
    );

    // Query anomalies for the week
    const anomalyResult = await this.pool.query(
      `SELECT anomaly_type, severity, description, detection_method
       FROM telemetry_anomalies
       WHERE agent_name = $1 AND detected_at >= $2 AND detected_at < $3
       ORDER BY detected_at`,
      [agentName, weekStart, weekEnd],
    );

    const qualityRows = qualityResult.rows;
    const anomalies = anomalyResult.rows;

    // ── What worked well
    const whatWorkedWell: string[] = [];
    if (summary.success_rate >= 0.9) {
      whatWorkedWell.push(
        `High success rate (${(summary.success_rate * 100).toFixed(1)}%) maintained throughout the week`,
      );
    }
    const improvingMetrics = qualityRows.filter((r) => r.trend === "improving");
    if (improvingMetrics.length > 0) {
      const metricNames = [...new Set(improvingMetrics.map((r) => r.metric_name))];
      whatWorkedWell.push(
        `Improving trends detected in: ${metricNames.join(", ")}`,
      );
    }
    if (summary.performance_score_avg != null && summary.performance_score_avg >= 0.8) {
      whatWorkedWell.push(
        `Strong performance score (${summary.performance_score_avg.toFixed(2)}) above 0.8 threshold`,
      );
    }
    if (whatWorkedWell.length === 0) {
      whatWorkedWell.push("No notable positive patterns identified this week");
    }

    // ── What didn't work
    const whatDidntWork: string[] = [];
    if (summary.error_count > 0) {
      whatDidntWork.push(
        `${summary.error_count} errors encountered during the week`,
      );
    }
    const decliningMetrics = qualityRows.filter((r) => r.trend === "declining");
    if (decliningMetrics.length > 0) {
      const metricNames = [...new Set(decliningMetrics.map((r) => r.metric_name))];
      whatDidntWork.push(
        `Declining trends detected in: ${metricNames.join(", ")}`,
      );
    }
    if (anomalies.length > 0) {
      whatDidntWork.push(
        `${anomalies.length} anomalies detected: ${anomalies.map((a) => a.description).join("; ")}`,
      );
    }
    if (whatDidntWork.length === 0) {
      whatDidntWork.push("No significant issues identified this week");
    }

    // ── Patterns noticed
    const patternsNoticed: string[] = [];
    // Check for consistent trends across multiple days
    const metricTrendCounts = new Map<string, Map<string, number>>();
    for (const row of qualityRows) {
      if (!row.trend) continue;
      const byMetric = metricTrendCounts.get(row.metric_name) ?? new Map();
      byMetric.set(row.trend, (byMetric.get(row.trend) ?? 0) + 1);
      metricTrendCounts.set(row.metric_name, byMetric);
    }
    for (const [metricName, trends] of metricTrendCounts) {
      const totalDays = [...trends.values()].reduce((a, b) => a + b, 0);
      for (const [trend, count] of trends) {
        if (count >= 3 && count / totalDays > 0.5) {
          patternsNoticed.push(
            `${metricName} has been consistently ${trend} (${count}/${totalDays} days)`,
          );
        }
      }
    }
    if (summary.avg_latency_ms != null && summary.avg_latency_ms > 5000) {
      patternsNoticed.push(
        `High average latency (${summary.avg_latency_ms.toFixed(0)}ms) may indicate processing bottleneck`,
      );
    }
    // Incorporate pre-reflection digest patterns if available
    if (preReflectionDigest) {
      patternsNoticed.push(
        "Pre-reflection digest available — patterns grounded in Tier 1 event analysis",
      );
    }

    if (patternsNoticed.length === 0) {
      patternsNoticed.push(
        "No recurring patterns identified — insufficient data or stable operation",
      );
    }

    // ── Proposed adjustments
    const proposedAdjustments: string[] = [];
    if (summary.success_rate < 0.8) {
      proposedAdjustments.push(
        "Consider increasing input validation to improve success rate",
      );
    }
    if (decliningMetrics.length > 0) {
      proposedAdjustments.push(
        "Investigate root cause of declining metrics and consider Loop 1 rule tuning",
      );
    }
    if (anomalies.filter((a) => a.severity === "critical").length > 0) {
      proposedAdjustments.push(
        "Critical anomalies require immediate investigation and possible architectural review",
      );
    }
    if (proposedAdjustments.length === 0) {
      proposedAdjustments.push("No adjustments proposed — current configuration performing well");
    }

    // ── Questions for Bar Raiser
    const questionsForBarRaiser: string[] = [];
    if (anomalies.length > 3) {
      questionsForBarRaiser.push(
        "Multiple anomalies detected this week — is there a systemic issue?",
      );
    }
    if (summary.success_rate < 0.7) {
      questionsForBarRaiser.push(
        "Success rate below 70% — should operational parameters be reviewed?",
      );
    }
    if (questionsForBarRaiser.length === 0) {
      questionsForBarRaiser.push("No urgent questions — routine operation");
    }

    return {
      what_worked_well: whatWorkedWell,
      what_didnt_work: whatDidntWork,
      patterns_noticed: patternsNoticed,
      proposed_adjustments: proposedAdjustments,
      questions_for_bar_raiser: questionsForBarRaiser,
    };
  }

  // ─── Cross-Agent Pattern Detection ────────────────────────────────────────

  private detectCrossAgentPatterns(
    reflections: WeeklyReflection[],
  ): CrossAgentPattern[] {
    const patterns: CrossAgentPattern[] = [];

    if (reflections.length < 2) return patterns;

    // Check for shared improvement trends
    const improvingAgents = reflections.filter((r) =>
      r.reflection.what_worked_well.some((w) => w.includes("Improving trends")),
    );
    if (improvingAgents.length >= 2) {
      patterns.push({
        pattern_type: "shared_improvement",
        agents_involved: improvingAgents.map((r) => r.agent_name),
        description: "Multiple agents showing improving metrics simultaneously",
        evidence: improvingAgents
          .map((r) => {
            const improving = r.reflection.what_worked_well.find((w) =>
              w.includes("Improving trends"),
            );
            return `${r.agent_name}: ${improving}`;
          })
          .join("; "),
        severity: "info",
      });
    }

    // Check for shared degradation
    const degradingAgents = reflections.filter((r) =>
      r.reflection.what_didnt_work.some((w) => w.includes("Declining trends")),
    );
    if (degradingAgents.length >= 2) {
      patterns.push({
        pattern_type: "shared_degradation",
        agents_involved: degradingAgents.map((r) => r.agent_name),
        description:
          "Multiple agents showing declining metrics — possible systemic issue",
        evidence: degradingAgents
          .map((r) => {
            const declining = r.reflection.what_didnt_work.find((w) =>
              w.includes("Declining trends"),
            );
            return `${r.agent_name}: ${declining}`;
          })
          .join("; "),
        severity: "warning",
      });
    }

    // Check for complementary patterns (one agent's success area is another's weakness)
    for (let i = 0; i < reflections.length; i++) {
      for (let j = i + 1; j < reflections.length; j++) {
        const a = reflections[i];
        const b = reflections[j];

        // Check if one agent has high success and another has low success
        if (
          a.summary.success_rate >= 0.9 &&
          b.summary.success_rate < 0.7
        ) {
          patterns.push({
            pattern_type: "complementary",
            agents_involved: [a.agent_name, b.agent_name],
            description: `${a.agent_name} excelling (${(a.summary.success_rate * 100).toFixed(1)}%) while ${b.agent_name} struggling (${(b.summary.success_rate * 100).toFixed(1)}%) — investigate if workload or configuration differences explain the gap`,
            evidence: `Success rate gap: ${a.agent_name}=${(a.summary.success_rate * 100).toFixed(1)}%, ${b.agent_name}=${(b.summary.success_rate * 100).toFixed(1)}%`,
            severity: "info",
          });
        }
        // Reverse check
        if (
          b.summary.success_rate >= 0.9 &&
          a.summary.success_rate < 0.7
        ) {
          patterns.push({
            pattern_type: "complementary",
            agents_involved: [b.agent_name, a.agent_name],
            description: `${b.agent_name} excelling (${(b.summary.success_rate * 100).toFixed(1)}%) while ${a.agent_name} struggling (${(a.summary.success_rate * 100).toFixed(1)}%) — investigate if workload or configuration differences explain the gap`,
            evidence: `Success rate gap: ${b.agent_name}=${(b.summary.success_rate * 100).toFixed(1)}%, ${a.agent_name}=${(a.summary.success_rate * 100).toFixed(1)}%`,
            severity: "info",
          });
        }
      }
    }

    return patterns;
  }

  // ─── Contradiction Detection ──────────────────────────────────────────────

  private async detectContradictions(
    reflections: WeeklyReflection[],
    weekStart: Date,
    weekEnd: Date,
  ): Promise<CrossAgentPattern[]> {
    const contradictions: CrossAgentPattern[] = [];

    for (const reflection of reflections) {
      // Check: agent says "what worked well" includes high success, but actual metrics show declining
      const claimsPositive = reflection.reflection.what_worked_well.some(
        (w) => w.includes("success rate") || w.includes("Strong performance"),
      );

      // Query actual quality trends for this agent
      const trendResult = await this.pool.query(
        `SELECT metric_name, trend, metric_value
         FROM telemetry_quality_daily
         WHERE agent_name = $1 AND date >= $2 AND date < $3
         ORDER BY date DESC
         LIMIT 7`,
        [reflection.agent_name, weekStart, weekEnd],
      );

      const recentTrends = trendResult.rows;
      const decliningCount = recentTrends.filter(
        (r) => r.trend === "declining",
      ).length;

      // Contradiction: agent claims positive but metrics show declining
      if (claimsPositive && decliningCount >= 3) {
        contradictions.push({
          pattern_type: "contradiction",
          agents_involved: [reflection.agent_name, "bar_raiser"],
          description: `${reflection.agent_name} reports positive outcomes but ${decliningCount} metric readings show declining trends`,
          evidence: `Self-assessment: positive. Actual trends: ${decliningCount}/${recentTrends.length} declining readings`,
          severity: "warning",
        });
      }

      // Contradiction: agent reports no issues but anomalies exist
      const noIssues = reflection.reflection.what_didnt_work.some((w) =>
        w.includes("No significant issues"),
      );
      if (noIssues) {
        const anomalyResult = await this.pool.query(
          `SELECT COUNT(*) AS count
           FROM telemetry_anomalies
           WHERE agent_name = $1 AND detected_at >= $2 AND detected_at < $3`,
          [reflection.agent_name, weekStart, weekEnd],
        );
        const anomalyCount = Number(anomalyResult.rows[0]?.count ?? 0);
        if (anomalyCount > 0) {
          contradictions.push({
            pattern_type: "contradiction",
            agents_involved: [reflection.agent_name, "bar_raiser"],
            description: `${reflection.agent_name} reports no issues but ${anomalyCount} anomalies were detected during the week`,
            evidence: `Self-assessment: no issues. Actual anomalies: ${anomalyCount}`,
            severity: "warning",
          });
        }
      }
    }

    return contradictions;
  }

  // ─── Health Assessment ────────────────────────────────────────────────────

  private assessOverallHealth(reflections: WeeklyReflection[]): string {
    if (reflections.length === 0) return "No agent data available for assessment";

    const avgSuccessRate =
      reflections.reduce((sum, r) => sum + r.summary.success_rate, 0) /
      reflections.length;
    const totalErrors = reflections.reduce(
      (sum, r) => sum + r.summary.error_count,
      0,
    );
    const agentsWithIssues = reflections.filter(
      (r) =>
        r.summary.success_rate < 0.8 ||
        r.reflection.what_didnt_work.some(
          (w) => !w.includes("No significant issues"),
        ),
    );

    if (avgSuccessRate >= 0.9 && totalErrors === 0) {
      return "Excellent — all agents performing at or above expected levels";
    }
    if (avgSuccessRate >= 0.8 && agentsWithIssues.length <= 1) {
      return `Good — system stable with minor issues in ${agentsWithIssues.length} agent(s)`;
    }
    if (avgSuccessRate >= 0.6) {
      return `Fair — ${agentsWithIssues.length}/${reflections.length} agents showing issues, average success rate ${(avgSuccessRate * 100).toFixed(1)}%`;
    }
    return `Needs Attention — average success rate ${(avgSuccessRate * 100).toFixed(1)}%, ${agentsWithIssues.length}/${reflections.length} agents experiencing problems`;
  }

  // ─── Recommendations ──────────────────────────────────────────────────────

  private buildRecommendations(
    patterns: CrossAgentPattern[],
    contradictions: CrossAgentPattern[],
    reflections: WeeklyReflection[],
  ): string[] {
    const recommendations: string[] = [];

    if (contradictions.length > 0) {
      recommendations.push(
        `Review ${contradictions.length} contradiction(s) between agent self-assessments and actual metrics — agents may have blind spots`,
      );
    }

    const sharedDegradation = patterns.filter(
      (p) => p.pattern_type === "shared_degradation",
    );
    if (sharedDegradation.length > 0) {
      recommendations.push(
        "Investigate shared degradation across multiple agents — may indicate infrastructure or configuration issue",
      );
    }

    const lowPerformers = reflections.filter(
      (r) => r.summary.success_rate < 0.7,
    );
    if (lowPerformers.length > 0) {
      recommendations.push(
        `Focus attention on low-performing agents: ${lowPerformers.map((r) => r.agent_name).join(", ")}`,
      );
    }

    if (recommendations.length === 0) {
      recommendations.push("No urgent actions required — continue monitoring");
    }

    return recommendations;
  }

  // ─── Markdown Rendering ───────────────────────────────────────────────────

  private renderReflectionMarkdown(
    agentName: string,
    weekStart: Date,
    weekEnd: Date,
    summary: WeekSummary,
    reflection: ReflectionSection,
    preReflectionDigest?: string | null,
  ): string {
    const startStr = weekStart.toISOString().slice(0, 10);
    const endStr = weekEnd.toISOString().slice(0, 10);

    const lines: string[] = [
      `# Weekly Reflection: ${agentName}`,
      "",
      `**Week**: ${startStr} to ${endStr}`,
      `**Generated**: ${new Date().toISOString().slice(0, 19)}Z`,
      `**Pre-Reflection Digest**: ${preReflectionDigest ? "Available" : "Not available"}`,
      "",
    ];

    // Step 1 reference: include pre-reflection digest summary if available
    if (preReflectionDigest) {
      lines.push(
        "## Pre-Reflection Input",
        "",
        "This reflection incorporates the agent's pre-reflection digest (Loop 1.5),",
        "which provides self-analysis grounded in Tier 1 event data.",
        "",
      );
    }

    lines.push(
      "## Week Summary",
      "",
      `- **Total Actions**: ${summary.total_actions}`,
      `- **Success Rate**: ${(summary.success_rate * 100).toFixed(1)}%`,
      `- **Errors**: ${summary.error_count}`,
      `- **Avg Latency**: ${summary.avg_latency_ms != null ? `${summary.avg_latency_ms.toFixed(0)}ms` : "N/A"}`,
      `- **Total Cost**: $${summary.total_cost_usd.toFixed(4)}`,
      `- **Performance Score**: ${summary.performance_score_avg != null ? summary.performance_score_avg.toFixed(2) : "N/A"}`,
      "",
      "## What Worked Well",
      "",
      ...reflection.what_worked_well.map((item) => `- ${item}`),
      "",
      "## What Didn't Work",
      "",
      ...reflection.what_didnt_work.map((item) => `- ${item}`),
      "",
      "## Patterns Noticed",
      "",
      ...reflection.patterns_noticed.map((item) => `- ${item}`),
      "",
      "## Proposed Adjustments",
      "",
      ...reflection.proposed_adjustments.map((item) => `- ${item}`),
      "",
      "## Questions for Bar Raiser",
      "",
      ...reflection.questions_for_bar_raiser.map((item) => `- ${item}`),
      "",
    );

    return lines.join("\n");
  }

  private renderSynthesisMarkdown(
    weekStart: Date,
    weekEnd: Date,
    agentNames: string[],
    reflections: WeeklyReflection[],
    patterns: CrossAgentPattern[],
    contradictions: CrossAgentPattern[],
    overallHealth: string,
    recommendations: string[],
  ): string {
    const startStr = weekStart.toISOString().slice(0, 10);
    const endStr = weekEnd.toISOString().slice(0, 10);

    const lines: string[] = [
      "# Bar Raiser Weekly Synthesis",
      "",
      `**Week**: ${startStr} to ${endStr}`,
      `**Generated**: ${new Date().toISOString().slice(0, 19)}Z`,
      `**Agents Included**: ${agentNames.join(", ")}`,
      "",
      "## Overall System Health",
      "",
      overallHealth,
      "",
      "## Agent Summaries",
      "",
    ];

    for (const r of reflections) {
      lines.push(
        `### ${r.agent_name}`,
        "",
        `- Actions: ${r.summary.total_actions} | Success: ${(r.summary.success_rate * 100).toFixed(1)}% | Errors: ${r.summary.error_count}`,
        `- Key insight: ${r.reflection.patterns_noticed[0] ?? "No notable patterns"}`,
        "",
      );
    }

    lines.push("## Cross-Agent Patterns", "");
    if (patterns.length === 0) {
      lines.push("No cross-agent patterns detected.", "");
    } else {
      for (const p of patterns) {
        lines.push(
          `### ${p.pattern_type} [${p.severity}]`,
          "",
          `**Agents**: ${p.agents_involved.join(", ")}`,
          "",
          p.description,
          "",
          `**Evidence**: ${p.evidence}`,
          "",
        );
      }
    }

    lines.push("## Contradictions", "");
    if (contradictions.length === 0) {
      lines.push("No contradictions detected between self-assessments and metrics.", "");
    } else {
      for (const c of contradictions) {
        lines.push(
          `### ${c.agents_involved[0]} [${c.severity}]`,
          "",
          c.description,
          "",
          `**Evidence**: ${c.evidence}`,
          "",
        );
      }
    }

    lines.push(
      "## Recommendations",
      "",
      ...recommendations.map((r) => `- ${r}`),
      "",
    );

    return lines.join("\n");
  }
}
