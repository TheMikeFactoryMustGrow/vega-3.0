import pg from "pg";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { TelemetryEmitter } from "./emitter.js";
import {
  PatternMinerConfigSchema,
  type PatternMinerConfig,
  type DetectedPattern,
  type ProactiveArtifact,
  type PatternMiningReport,
} from "./pattern-miner-types.js";

/**
 * VEGA v3.3 Cross-Agent Pattern Mining — Phase 4+ Infrastructure
 *
 * Analyzes centralized Tier 2 telemetry and Loop 2 reflections across all agents
 * to detect behavioral patterns invisible to individual agents.
 *
 * Four pattern types:
 * 1. demand_clustering — agents frequently invoked in sequence
 * 2. resource_contention — agents querying overlapping data at overlapping times
 * 3. complementary_gap — one agent's output frequently becomes another's input
 * 4. drift_correlation — correlated metric changes across agents
 *
 * Safety constraints:
 * - Read-only: no agent behavior modification, only reports and optional claims
 * - Proactive artifact proposals flagged for Mike approval, never auto-executed
 * - Bar Raiser reviews all reports for confirmation bias
 * - Activation flag (default: disabled) until Phase 4 with ≥8 weeks of data
 *
 * Report written to: ~/vega-telemetry/pattern-mining/{YYYY-MM-DD}.md
 */
export class PatternMiner {
  private readonly config: PatternMinerConfig;
  private readonly reportDir: string;

  constructor(
    private readonly pool: pg.Pool,
    private readonly emitter: TelemetryEmitter,
    config?: Partial<PatternMinerConfig>,
    private readonly basePath: string = path.join(
      process.env.HOME ?? "~",
      "vega-telemetry",
    ),
    private readonly options: { emitTelemetry?: boolean } = {},
  ) {
    this.config = PatternMinerConfigSchema.parse(config ?? {});
    this.reportDir = path.join(this.basePath, "pattern-mining");
  }

  /**
   * Run the pattern mining analysis for the given date.
   *
   * Returns null if the activation flag is disabled.
   * When enabled, analyzes Tier 2 data and Loop 2 reflections
   * to detect cross-agent patterns.
   */
  async runMining(
    agentNames: string[],
    targetDate: Date,
  ): Promise<PatternMiningReport | null> {
    // Check activation flag
    if (!this.config.enabled) {
      return null;
    }

    const now = targetDate;
    const lookbackStart = new Date(now);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - this.config.lookback_days);

    // Detect all four pattern types
    const demandClustering = await this.detectDemandClustering(
      agentNames,
      lookbackStart,
      now,
    );
    const resourceContention = await this.detectResourceContention(
      agentNames,
      lookbackStart,
      now,
    );
    const complementaryGap = await this.detectComplementaryGap(
      agentNames,
      lookbackStart,
      now,
    );
    const driftCorrelation = await this.detectDriftCorrelation(
      agentNames,
      lookbackStart,
      now,
    );

    const allPatterns: DetectedPattern[] = [
      ...demandClustering,
      ...resourceContention,
      ...complementaryGap,
      ...driftCorrelation,
    ];

    // Generate proactive artifact candidates from high-confidence patterns
    const artifactCandidates = this.generateArtifactCandidates(allPatterns);

    // Patterns that don't require action (low confidence or informational)
    const noActionPatterns = this.identifyNoActionPatterns(allPatterns);

    // Read reflection data for context enrichment
    const reflectionContext = await this.readReflectionContext(agentNames);

    // Generate markdown report
    const markdown = this.renderReport(
      now,
      agentNames,
      allPatterns,
      artifactCandidates,
      noActionPatterns,
      reflectionContext,
    );

    const report: PatternMiningReport = {
      date: now,
      generated_at: new Date(),
      agents_analyzed: agentNames,
      detected_patterns: allPatterns,
      proactive_artifact_candidates: artifactCandidates,
      no_action_patterns: noActionPatterns,
      activation_flag: this.config.enabled,
      markdown,
    };

    // Write report to filesystem
    await mkdir(this.reportDir, { recursive: true });
    const fileName = `${now.toISOString().slice(0, 10)}.md`;
    await writeFile(path.join(this.reportDir, fileName), markdown, "utf-8");

    // Log to telemetry
    if (this.options.emitTelemetry !== false) {
      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "system_event",
        event_subtype: "pattern_mining",
        session_id: `pattern_mining_${now.toISOString().slice(0, 10)}`,
        model_used: this.config.model,
        outcome: "success",
        metadata: {
          date: now.toISOString(),
          agents_analyzed: agentNames,
          patterns_detected: allPatterns.length,
          artifact_candidates: artifactCandidates.length,
        },
      });
    }

    return report;
  }

  // ─── Pattern 1: Demand Clustering ──────────────────────────────────────────

  /**
   * Detect agents frequently invoked in sequence.
   *
   * Looks for temporal co-occurrence patterns where Agent A activity is
   * consistently followed by Agent B activity within the same hour bucket.
   */
  private async detectDemandClustering(
    agentNames: string[],
    from: Date,
    to: Date,
  ): Promise<DetectedPattern[]> {
    const patterns: DetectedPattern[] = [];

    if (agentNames.length < 2) return patterns;

    // Query hourly activity for all agents in the window
    const result = await this.pool.query(
      `SELECT agent_name, hour_bucket, action_count
       FROM telemetry_agent_hourly
       WHERE agent_name = ANY($1) AND hour_bucket >= $2 AND hour_bucket < $3
       ORDER BY hour_bucket, agent_name`,
      [agentNames, from, to],
    );

    // Group by hour bucket
    const byHour = new Map<string, Map<string, number>>();
    for (const row of result.rows) {
      const hourKey = new Date(row.hour_bucket).toISOString();
      const agentMap = byHour.get(hourKey) ?? new Map<string, number>();
      agentMap.set(row.agent_name, Number(row.action_count));
      byHour.set(hourKey, agentMap);
    }

    // Count co-occurrence pairs: how often do two agents both have activity in the same hour?
    const pairCounts = new Map<string, number>();
    const sortedHours = [...byHour.keys()].sort();

    for (const hourKey of sortedHours) {
      const agentsActive = [...(byHour.get(hourKey)?.keys() ?? [])];

      // Check for sequence patterns: agents active in consecutive hours
      for (let i = 0; i < agentsActive.length; i++) {
        for (let j = i + 1; j < agentsActive.length; j++) {
          const pairKey = [agentsActive[i], agentsActive[j]].sort().join("→");
          pairCounts.set(pairKey, (pairCounts.get(pairKey) ?? 0) + 1);
        }
      }
    }

    // Flag pairs exceeding the threshold
    for (const [pairKey, count] of pairCounts) {
      if (count >= this.config.demand_clustering_min_occurrences) {
        const agents = pairKey.split("→");
        const totalHours = sortedHours.length || 1;
        const confidence = Math.min(count / totalHours, 1.0);

        patterns.push({
          type: "demand_clustering",
          agents,
          evidence: `${agents.join(" and ")} appear in the same hour bucket ${count} times over ${this.config.lookback_days} days (${totalHours} hours with data)`,
          frequency: count,
          suggested_action: `Consider co-scheduling ${agents.join(" and ")} or creating a combined workflow to reduce coordination overhead`,
          confidence,
        });
      }
    }

    return patterns;
  }

  // ─── Pattern 2: Resource Contention ────────────────────────────────────────

  /**
   * Detect agents querying overlapping data at overlapping times.
   *
   * Identifies hours where multiple agents have high action counts,
   * suggesting they may be competing for shared resources.
   */
  private async detectResourceContention(
    agentNames: string[],
    from: Date,
    to: Date,
  ): Promise<DetectedPattern[]> {
    const patterns: DetectedPattern[] = [];

    if (agentNames.length < 2) return patterns;

    // Find hours where multiple agents are highly active simultaneously
    const result = await this.pool.query(
      `SELECT hour_bucket,
              array_agg(agent_name ORDER BY action_count DESC) AS agents,
              array_agg(action_count ORDER BY action_count DESC) AS counts
       FROM telemetry_agent_hourly
       WHERE agent_name = ANY($1) AND hour_bucket >= $2 AND hour_bucket < $3
       GROUP BY hour_bucket
       HAVING COUNT(DISTINCT agent_name) >= 2
       ORDER BY hour_bucket`,
      [agentNames, from, to],
    );

    // Count overlapping high-activity hours per agent pair
    const overlapCounts = new Map<string, number>();
    for (const row of result.rows) {
      const agents: string[] = row.agents;
      const counts: number[] = (row.counts as unknown[]).map(Number);

      // Only count as contention if both agents have significant activity
      const activeAgents = agents.filter(
        (_, i) => counts[i] >= 5,
      );

      for (let i = 0; i < activeAgents.length; i++) {
        for (let j = i + 1; j < activeAgents.length; j++) {
          const pairKey = [activeAgents[i], activeAgents[j]].sort().join("↔");
          overlapCounts.set(
            pairKey,
            (overlapCounts.get(pairKey) ?? 0) + 1,
          );
        }
      }
    }

    for (const [pairKey, count] of overlapCounts) {
      if (count >= this.config.resource_contention_min_overlaps) {
        const agents = pairKey.split("↔");
        const confidence = Math.min(count / (this.config.lookback_days * 24), 1.0);

        patterns.push({
          type: "resource_contention",
          agents,
          evidence: `${agents.join(" and ")} have overlapping high-activity periods in ${count} hours over ${this.config.lookback_days} days`,
          frequency: count,
          suggested_action: `Consider staggering ${agents.join(" and ")} schedules or implementing request queuing to reduce contention`,
          confidence,
        });
      }
    }

    return patterns;
  }

  // ─── Pattern 3: Complementary Gap ──────────────────────────────────────────

  /**
   * Detect when one agent's output frequently becomes another's input.
   *
   * Identifies asymmetric cost/activity patterns suggesting data flow
   * from one agent to another. Agent A with high output tokens and
   * Agent B with high input tokens in subsequent hours suggests a pipeline.
   */
  private async detectComplementaryGap(
    agentNames: string[],
    from: Date,
    to: Date,
  ): Promise<DetectedPattern[]> {
    const patterns: DetectedPattern[] = [];

    if (agentNames.length < 2) return patterns;

    // Query daily cost data for token flow analysis
    const result = await this.pool.query(
      `SELECT agent_name,
              SUM(total_tokens_out) AS total_out,
              SUM(total_tokens_in) AS total_in,
              SUM(invocations) AS total_invocations
       FROM telemetry_cost_daily
       WHERE agent_name = ANY($1) AND date >= $2 AND date <= $3
       GROUP BY agent_name`,
      [agentNames, from, to],
    );

    const agentTokens = new Map<
      string,
      { total_out: number; total_in: number; invocations: number }
    >();
    for (const row of result.rows) {
      agentTokens.set(row.agent_name, {
        total_out: Number(row.total_out),
        total_in: Number(row.total_in),
        invocations: Number(row.total_invocations),
      });
    }

    // Detect complementary patterns: Agent A's output ratio vs Agent B's input ratio
    const agentList = [...agentTokens.keys()];
    for (let i = 0; i < agentList.length; i++) {
      for (let j = 0; j < agentList.length; j++) {
        if (i === j) continue;

        const producer = agentTokens.get(agentList[i])!;
        const consumer = agentTokens.get(agentList[j])!;

        // Producer has high output-to-input ratio, consumer has high input-to-output ratio
        const producerOutRatio =
          producer.total_in > 0 ? producer.total_out / producer.total_in : 0;
        const consumerInRatio =
          consumer.total_out > 0 ? consumer.total_in / consumer.total_out : 0;

        if (
          producerOutRatio >= this.config.complementary_gap_min_correlation &&
          consumerInRatio >= this.config.complementary_gap_min_correlation
        ) {
          const confidence = Math.min(
            (producerOutRatio + consumerInRatio) / 4,
            1.0,
          );

          patterns.push({
            type: "complementary_gap",
            agents: [agentList[i], agentList[j]],
            evidence: `${agentList[i]} produces ${producerOutRatio.toFixed(2)}x output-to-input ratio, ${agentList[j]} consumes ${consumerInRatio.toFixed(2)}x input-to-output ratio — suggesting data pipeline`,
            frequency: producer.invocations + consumer.invocations,
            suggested_action: `Consider creating a direct pipeline between ${agentList[i]} and ${agentList[j]} to reduce intermediate storage overhead`,
            confidence,
          });
        }
      }
    }

    return patterns;
  }

  // ─── Pattern 4: Drift Correlation ──────────────────────────────────────────

  /**
   * Detect correlated metric changes across agents.
   *
   * When Agent A's quality metric rises/falls, Agent B's metric consistently
   * moves in the same direction — suggesting a hidden dependency.
   */
  private async detectDriftCorrelation(
    agentNames: string[],
    from: Date,
    to: Date,
  ): Promise<DetectedPattern[]> {
    const patterns: DetectedPattern[] = [];

    if (agentNames.length < 2) return patterns;

    // Query quality daily trends for all agents
    const result = await this.pool.query(
      `SELECT agent_name, date, metric_name, metric_value, trend
       FROM telemetry_quality_daily
       WHERE agent_name = ANY($1) AND date >= $2 AND date <= $3
       ORDER BY date, agent_name`,
      [agentNames, from, to],
    );

    // Group by metric_name → agent_name → date-ordered values
    const metricsByName = new Map<
      string,
      Map<string, { date: Date; value: number; trend: string | null }[]>
    >();

    for (const row of result.rows) {
      const metricName: string = row.metric_name;
      const agentName: string = row.agent_name;

      const byAgent = metricsByName.get(metricName) ?? new Map();
      const entries = byAgent.get(agentName) ?? [];
      entries.push({
        date: new Date(row.date),
        value: Number(row.metric_value),
        trend: row.trend,
      });
      byAgent.set(agentName, entries);
      metricsByName.set(metricName, byAgent);
    }

    // For each metric, compare trend correlation between agent pairs
    for (const [metricName, byAgent] of metricsByName) {
      const agentList = [...byAgent.keys()];
      if (agentList.length < 2) continue;

      for (let i = 0; i < agentList.length; i++) {
        for (let j = i + 1; j < agentList.length; j++) {
          const entriesA = byAgent.get(agentList[i])!;
          const entriesB = byAgent.get(agentList[j])!;

          const correlation = this.computeTrendCorrelation(entriesA, entriesB);

          if (
            Math.abs(correlation) >=
            this.config.drift_correlation_min_coefficient
          ) {
            const direction = correlation > 0 ? "positive" : "negative";
            const frequency = Math.min(entriesA.length, entriesB.length);

            patterns.push({
              type: "drift_correlation",
              agents: [agentList[i], agentList[j]],
              evidence: `${agentList[i]} and ${agentList[j]} show ${direction} correlation (r=${correlation.toFixed(2)}) on ${metricName} over ${frequency} data points`,
              frequency,
              suggested_action:
                correlation > 0
                  ? `Investigate shared dependency causing ${agentList[i]} and ${agentList[j]} to drift together on ${metricName}`
                  : `Investigate inverse relationship between ${agentList[i]} and ${agentList[j]} on ${metricName} — one may be compensating for the other`,
              confidence: Math.abs(correlation),
            });
          }
        }
      }
    }

    return patterns;
  }

  /**
   * Compute Pearson correlation coefficient between two agents' metric trends.
   * Matches entries by date.
   */
  private computeTrendCorrelation(
    entriesA: { date: Date; value: number }[],
    entriesB: { date: Date; value: number }[],
  ): number {
    // Create date-indexed maps
    const mapA = new Map(
      entriesA.map((e) => [e.date.toISOString().slice(0, 10), e.value]),
    );
    const mapB = new Map(
      entriesB.map((e) => [e.date.toISOString().slice(0, 10), e.value]),
    );

    // Find common dates
    const commonDates = [...mapA.keys()].filter((d) => mapB.has(d));
    if (commonDates.length < 3) return 0; // Not enough data for correlation

    const valuesA = commonDates.map((d) => mapA.get(d)!);
    const valuesB = commonDates.map((d) => mapB.get(d)!);

    const n = valuesA.length;
    const meanA = valuesA.reduce((s, v) => s + v, 0) / n;
    const meanB = valuesB.reduce((s, v) => s + v, 0) / n;

    let sumAB = 0;
    let sumA2 = 0;
    let sumB2 = 0;

    for (let k = 0; k < n; k++) {
      const dA = valuesA[k] - meanA;
      const dB = valuesB[k] - meanB;
      sumAB += dA * dB;
      sumA2 += dA * dA;
      sumB2 += dB * dB;
    }

    const denominator = Math.sqrt(sumA2 * sumB2);
    if (denominator === 0) return 0;

    return sumAB / denominator;
  }

  // ─── Proactive Artifact Candidates ─────────────────────────────────────────

  private generateArtifactCandidates(
    patterns: DetectedPattern[],
  ): ProactiveArtifact[] {
    const candidates: ProactiveArtifact[] = [];

    for (const pattern of patterns) {
      // Only high-confidence patterns become artifact candidates
      if (pattern.confidence < 0.7) continue;

      switch (pattern.type) {
        case "demand_clustering":
          candidates.push({
            title: `Workflow: ${pattern.agents.join(" → ")} Pipeline`,
            description: `Automated workflow combining ${pattern.agents.join(" and ")} based on detected sequential invocation pattern (confidence: ${(pattern.confidence * 100).toFixed(0)}%)`,
            source_pattern: pattern.type,
            agents_involved: pattern.agents,
            requires_mike_approval: true,
          });
          break;

        case "drift_correlation":
          candidates.push({
            title: `Dependency Map: ${pattern.agents.join(" ↔ ")}`,
            description: `Document hidden dependency between ${pattern.agents.join(" and ")} based on correlated metric drift (confidence: ${(pattern.confidence * 100).toFixed(0)}%)`,
            source_pattern: pattern.type,
            agents_involved: pattern.agents,
            requires_mike_approval: true,
          });
          break;

        case "complementary_gap":
          candidates.push({
            title: `Pipeline: ${pattern.agents.join(" → ")}`,
            description: `Direct data pipeline from ${pattern.agents[0]} to ${pattern.agents[1]} based on producer-consumer token pattern (confidence: ${(pattern.confidence * 100).toFixed(0)}%)`,
            source_pattern: pattern.type,
            agents_involved: pattern.agents,
            requires_mike_approval: true,
          });
          break;

        case "resource_contention":
          candidates.push({
            title: `Schedule Optimization: ${pattern.agents.join(" / ")}`,
            description: `Stagger scheduling for ${pattern.agents.join(" and ")} to reduce resource contention (confidence: ${(pattern.confidence * 100).toFixed(0)}%)`,
            source_pattern: pattern.type,
            agents_involved: pattern.agents,
            requires_mike_approval: true,
          });
          break;
      }
    }

    return candidates;
  }

  // ─── No-Action Patterns ────────────────────────────────────────────────────

  private identifyNoActionPatterns(patterns: DetectedPattern[]): string[] {
    const noAction: string[] = [];

    for (const pattern of patterns) {
      if (pattern.confidence < 0.5) {
        noAction.push(
          `${pattern.type}: ${pattern.agents.join(", ")} — low confidence (${(pattern.confidence * 100).toFixed(0)}%), monitoring only`,
        );
      }
    }

    if (patterns.length === 0) {
      noAction.push(
        "No cross-agent patterns detected in the analysis window — insufficient data or independent agent operation",
      );
    }

    return noAction;
  }

  // ─── Reflection Context ────────────────────────────────────────────────────

  /**
   * Read recent Loop 2 reflections and Bar Raiser synthesis for context.
   */
  private async readReflectionContext(
    agentNames: string[],
  ): Promise<string | null> {
    const reflectionsDir = path.join(this.basePath, "reflections");
    const contextParts: string[] = [];

    // Read Bar Raiser synthesis (most recent)
    const synthesisDir = path.join(reflectionsDir, "bar_raiser");
    if (existsSync(synthesisDir)) {
      try {
        const files = await readdir(synthesisDir);
        const synthFiles = files
          .filter((f) => f.startsWith("synthesis_") && f.endsWith(".md"))
          .sort()
          .reverse();
        if (synthFiles.length > 0) {
          const content = await readFile(
            path.join(synthesisDir, synthFiles[0]),
            "utf-8",
          );
          contextParts.push(`Bar Raiser Synthesis:\n${content.slice(0, 500)}`);
        }
      } catch {
        // Ignore read errors
      }
    }

    // Read recent reflections for each agent
    for (const agentName of agentNames) {
      const agentDir = path.join(reflectionsDir, agentName);
      if (!existsSync(agentDir)) continue;

      try {
        const files = await readdir(agentDir);
        const mdFiles = files.filter((f) => f.endsWith(".md")).sort().reverse();
        if (mdFiles.length > 0) {
          const content = await readFile(
            path.join(agentDir, mdFiles[0]),
            "utf-8",
          );
          contextParts.push(
            `${agentName} Reflection:\n${content.slice(0, 300)}`,
          );
        }
      } catch {
        // Ignore read errors
      }
    }

    return contextParts.length > 0 ? contextParts.join("\n\n---\n\n") : null;
  }

  // ─── Markdown Report Rendering ─────────────────────────────────────────────

  private renderReport(
    date: Date,
    agentNames: string[],
    patterns: DetectedPattern[],
    artifacts: ProactiveArtifact[],
    noActionPatterns: string[],
    reflectionContext: string | null,
  ): string {
    const dateStr = date.toISOString().slice(0, 10);

    const lines: string[] = [
      "# Cross-Agent Pattern Mining Report",
      "",
      `**Date**: ${dateStr}`,
      `**Generated**: ${new Date().toISOString().slice(0, 19)}Z`,
      `**Agents Analyzed**: ${agentNames.join(", ")}`,
      `**Model**: ${this.config.model}`,
      `**Lookback Window**: ${this.config.lookback_days} days`,
      "",
    ];

    // Detected Patterns
    lines.push("## Detected Patterns", "");
    if (patterns.length === 0) {
      lines.push("No cross-agent patterns detected.", "");
    } else {
      for (const p of patterns) {
        lines.push(
          `### ${p.type} [confidence: ${(p.confidence * 100).toFixed(0)}%]`,
          "",
          `**Agents**: ${p.agents.join(", ")}`,
          `**Frequency**: ${p.frequency} occurrences`,
          "",
          `**Evidence**: ${p.evidence}`,
          "",
          `**Suggested Action**: ${p.suggested_action}`,
          "",
        );
      }
    }

    // Proactive Artifact Candidates
    lines.push("## Proactive Artifact Candidates", "");
    if (artifacts.length === 0) {
      lines.push(
        "No high-confidence patterns qualify for proactive artifacts.",
        "",
      );
    } else {
      lines.push(
        "> **Note**: All artifact proposals require Mike's approval before execution.",
        "",
      );
      for (const a of artifacts) {
        lines.push(
          `### ${a.title}`,
          "",
          a.description,
          "",
          `**Agents**: ${a.agents_involved.join(", ")}`,
          `**Source Pattern**: ${a.source_pattern}`,
          `**Requires Mike Approval**: Yes`,
          "",
        );
      }
    }

    // No-Action Patterns
    lines.push("## No-Action Patterns", "");
    if (noActionPatterns.length === 0) {
      lines.push("All detected patterns warrant action.", "");
    } else {
      for (const n of noActionPatterns) {
        lines.push(`- ${n}`);
      }
      lines.push("");
    }

    // Reflection Context
    if (reflectionContext) {
      lines.push(
        "## Reflection Context",
        "",
        "Recent Loop 2 reflections and Bar Raiser synthesis referenced during analysis:",
        "",
        reflectionContext,
        "",
      );
    }

    // Safety notice
    lines.push(
      "---",
      "",
      "*This report is read-only. No agent behavior was modified. Proactive artifact candidates require Mike's explicit approval. Bar Raiser should review this report for confirmation bias (Knowledge Agent finding patterns that justify its own importance).*",
      "",
    );

    return lines.join("\n");
  }
}
