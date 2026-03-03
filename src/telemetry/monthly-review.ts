import pg from "pg";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { TelemetryEmitter } from "./emitter.js";
import {
  BetSchema,
  BetInputSchema,
  type Bet,
  type BetInput,
  type BetOutcome,
  type StructuralProposal,
  type MonthlyTrendSummary,
  type MonthlyReview,
} from "./monthly-review-types.js";

/**
 * VEGA v3.3 Loop 3: Structural Learning — Monthly Reviews with Bet Tracking
 *
 * Generates monthly structural reviews that synthesize 4 weeks of reflections,
 * telemetry trends, and Bar Raiser observations. Structural proposals are tracked
 * as Bet nodes with full lifecycle management.
 *
 * Monthly reviews stored at: ~/vega-telemetry/reviews/{YYYY-MM}.md
 * Triggered monthly (default: last Sunday of month, 22:00 UTC).
 *
 * Only Mike can approve structural proposals — they are surfaced in the
 * Morning Brief as 'Proposals Awaiting Review'.
 */

export class MonthlyReviewGenerator {
  private readonly reviewsDir: string;
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
    this.reviewsDir = path.join(this.basePath, "reviews");
    this.reflectionsDir = path.join(this.basePath, "reflections");
  }

  // ─── Monthly Review Generation ────────────────────────────────────────────

  async generateReview(
    agentNames: string[],
    monthEndDate: Date,
  ): Promise<MonthlyReview> {
    const monthEnd = new Date(
      Date.UTC(
        monthEndDate.getUTCFullYear(),
        monthEndDate.getUTCMonth(),
        monthEndDate.getUTCDate(),
      ),
    );
    const monthStart = new Date(monthEnd);
    monthStart.setUTCMonth(monthStart.getUTCMonth() - 1);

    // 1. Gather monthly telemetry trends per agent
    const agentTrends = await Promise.all(
      agentNames.map((agent) =>
        this.computeMonthlyTrend(agent, monthStart, monthEnd),
      ),
    );

    // 2. Read Bar Raiser weekly synthesis observations
    const barRaiserObservations = await this.readBarRaiserObservations(
      monthStart,
      monthEnd,
    );

    // 3. Assess previous month's active Bets
    const prevMonthEnd = new Date(monthStart);
    const prevMonth = `${prevMonthEnd.getUTCFullYear()}-${String(prevMonthEnd.getUTCMonth() + 1).padStart(2, "0")}`;
    const betOutcomes = await this.assessBetOutcomes(
      agentNames,
      monthStart,
      monthEnd,
      prevMonth,
    );

    // 4. Generate structural proposals based on trends
    const proposals = this.generateProposals(agentTrends, barRaiserObservations);

    // 5. Render markdown
    const sourceMonth = `${monthEnd.getUTCFullYear()}-${String(monthEnd.getUTCMonth() + 1).padStart(2, "0")}`;
    const markdown = this.renderReviewMarkdown(
      monthStart,
      monthEnd,
      agentNames,
      agentTrends,
      barRaiserObservations,
      betOutcomes,
      proposals,
    );

    const result: MonthlyReview = {
      month_start: monthStart,
      month_end: monthEnd,
      generated_at: new Date(),
      agents_included: agentNames,
      agent_trends: agentTrends,
      bar_raiser_observations: barRaiserObservations,
      bet_outcomes: betOutcomes,
      proposals,
      markdown,
    };

    // Write review to filesystem
    await mkdir(this.reviewsDir, { recursive: true });
    const fileName = `${sourceMonth}.md`;
    await writeFile(path.join(this.reviewsDir, fileName), markdown, "utf-8");

    // Store proposals as pending_approval Bets
    for (const proposal of proposals) {
      await this.createBet({
        agent_name: proposal.agent_name,
        hypothesis: proposal.hypothesis,
        expected_outcome: proposal.expected_outcome,
        measurement_criteria: proposal.measurement_criteria,
        rollback_trigger: proposal.rollback_trigger,
        actual_outcome: null,
        status: "pending_approval",
        created_date: monthEnd,
        review_date: null,
        source_review_month: sourceMonth,
      });
    }

    // Log to telemetry
    if (this.options.emitTelemetry !== false) {
      await this.emitter.emit({
        agent_name: "bar_raiser",
        event_type: "system_event",
        event_subtype: "monthly_review",
        session_id: `monthly_review_${sourceMonth}`,
        outcome: "success",
        metadata: {
          month_start: monthStart.toISOString(),
          month_end: monthEnd.toISOString(),
          agents_included: agentNames,
          proposals_generated: proposals.length,
          bets_assessed: betOutcomes.length,
        },
      });
    }

    return result;
  }

  // ─── Monthly Trend Computation ────────────────────────────────────────────

  private async computeMonthlyTrend(
    agentName: string,
    monthStart: Date,
    monthEnd: Date,
  ): Promise<MonthlyTrendSummary> {
    // Aggregate hourly data for the month
    const hourlyResult = await this.pool.query(
      `SELECT
        COALESCE(SUM(action_count), 0) AS total_actions,
        COALESCE(SUM(success_count), 0) AS success_count,
        AVG(avg_latency_ms) FILTER (WHERE avg_latency_ms IS NOT NULL) AS avg_latency_ms,
        COALESCE(SUM(cost_usd_total), 0) AS total_cost_usd,
        AVG(performance_score) FILTER (WHERE performance_score IS NOT NULL) AS avg_performance_score
      FROM telemetry_agent_hourly
      WHERE agent_name = $1 AND hour_bucket >= $2 AND hour_bucket < $3`,
      [agentName, monthStart, monthEnd],
    );

    const row = hourlyResult.rows[0];
    const totalActions = Number(row?.total_actions ?? 0);
    const successCount = Number(row?.success_count ?? 0);

    // Count anomalies for the month
    const anomalyResult = await this.pool.query(
      `SELECT COUNT(*) AS count
       FROM telemetry_anomalies
       WHERE agent_name = $1 AND detected_at >= $2 AND detected_at < $3`,
      [agentName, monthStart, monthEnd],
    );
    const anomalyCount = Number(anomalyResult.rows[0]?.count ?? 0);

    // Compute trend direction by comparing first half vs second half
    const midPoint = new Date(monthStart);
    midPoint.setUTCDate(
      midPoint.getUTCDate() +
        Math.floor(
          (monthEnd.getTime() - monthStart.getTime()) / (2 * 86400000),
        ),
    );

    const firstHalfResult = await this.pool.query(
      `SELECT AVG(performance_score) FILTER (WHERE performance_score IS NOT NULL) AS avg_score
       FROM telemetry_agent_hourly
       WHERE agent_name = $1 AND hour_bucket >= $2 AND hour_bucket < $3`,
      [agentName, monthStart, midPoint],
    );
    const secondHalfResult = await this.pool.query(
      `SELECT AVG(performance_score) FILTER (WHERE performance_score IS NOT NULL) AS avg_score
       FROM telemetry_agent_hourly
       WHERE agent_name = $1 AND hour_bucket >= $2 AND hour_bucket < $3`,
      [agentName, midPoint, monthEnd],
    );

    const firstScore = firstHalfResult.rows[0]?.avg_score != null
      ? Number(firstHalfResult.rows[0].avg_score)
      : null;
    const secondScore = secondHalfResult.rows[0]?.avg_score != null
      ? Number(secondHalfResult.rows[0].avg_score)
      : null;

    let trendDirection: "improving" | "stable" | "declining" = "stable";
    if (firstScore != null && secondScore != null && firstScore > 0) {
      const delta = (secondScore - firstScore) / firstScore;
      if (delta > 0.05) trendDirection = "improving";
      else if (delta < -0.05) trendDirection = "declining";
    }

    return {
      agent_name: agentName,
      total_actions: totalActions,
      avg_success_rate: totalActions > 0 ? successCount / totalActions : 0,
      avg_latency_ms:
        row?.avg_latency_ms != null ? Number(row.avg_latency_ms) : null,
      total_cost_usd: Number(row?.total_cost_usd ?? 0),
      avg_performance_score:
        row?.avg_performance_score != null
          ? Number(row.avg_performance_score)
          : null,
      anomaly_count: anomalyCount,
      trend_direction: trendDirection,
    };
  }

  // ─── Bar Raiser Observations ──────────────────────────────────────────────

  private async readBarRaiserObservations(
    monthStart: Date,
    monthEnd: Date,
  ): Promise<string[]> {
    const observations: string[] = [];

    try {
      const synthDir = path.join(this.reflectionsDir, "bar_raiser");
      const files = await readdir(synthDir);

      // Read synthesis files from the month range
      for (const file of files) {
        if (!file.startsWith("synthesis_") || !file.endsWith(".md")) continue;
        const dateStr = file.replace("synthesis_", "").replace(".md", "");
        const fileDate = new Date(dateStr + "T00:00:00Z");
        if (fileDate >= monthStart && fileDate < monthEnd) {
          const content = await readFile(
            path.join(synthDir, file),
            "utf-8",
          );
          // Extract recommendations section
          const recIdx = content.indexOf("## Recommendations");
          if (recIdx !== -1) {
            const recSection = content.slice(recIdx);
            const lines = recSection
              .split("\n")
              .filter((l) => l.startsWith("- "))
              .map((l) => l.slice(2).trim());
            observations.push(...lines);
          }
        }
      }
    } catch {
      // No synthesis files yet — graceful degradation
    }

    if (observations.length === 0) {
      observations.push(
        "No Bar Raiser weekly synthesis data available for this month",
      );
    }

    return observations;
  }

  // ─── Bet Outcome Assessment ───────────────────────────────────────────────

  private async assessBetOutcomes(
    agentNames: string[],
    monthStart: Date,
    monthEnd: Date,
    prevMonth: string,
  ): Promise<BetOutcome[]> {
    // Find active Bets from the previous month (or older)
    const result = await this.pool.query(
      `SELECT * FROM telemetry_bets
       WHERE status = 'active'
       ORDER BY created_date`,
    );

    const outcomes: BetOutcome[] = [];
    for (const row of result.rows) {
      const bet = this.parseBetRow(row);

      // Assess the bet based on current telemetry data
      const outcome = await this.assessSingleBet(bet, monthStart, monthEnd);
      if (outcome) {
        outcomes.push(outcome);
        // Update the bet in the database
        await this.updateBetOutcome(
          bet.id,
          outcome.actual_outcome,
          outcome.new_status,
          monthEnd,
        );
      }
    }

    return outcomes;
  }

  private async assessSingleBet(
    bet: Bet,
    monthStart: Date,
    monthEnd: Date,
  ): Promise<BetOutcome | null> {
    // Query the agent's current metrics to evaluate against measurement_criteria
    const hourlyResult = await this.pool.query(
      `SELECT
        COALESCE(SUM(action_count), 0) AS total_actions,
        COALESCE(SUM(success_count), 0) AS success_count,
        COALESCE(SUM(error_count), 0) AS error_count,
        AVG(avg_latency_ms) FILTER (WHERE avg_latency_ms IS NOT NULL) AS avg_latency_ms,
        AVG(performance_score) FILTER (WHERE performance_score IS NOT NULL) AS avg_perf
      FROM telemetry_agent_hourly
      WHERE agent_name = $1 AND hour_bucket >= $2 AND hour_bucket < $3`,
      [bet.agent_name, monthStart, monthEnd],
    );

    const row = hourlyResult.rows[0];
    const totalActions = Number(row?.total_actions ?? 0);
    const successCount = Number(row?.success_count ?? 0);
    const errorCount = Number(row?.error_count ?? 0);
    const avgPerf = row?.avg_perf != null ? Number(row.avg_perf) : null;
    const successRate = totalActions > 0 ? successCount / totalActions : 0;

    // Build actual outcome description from telemetry
    const actualOutcome = [
      `Actions: ${totalActions}`,
      `Success rate: ${(successRate * 100).toFixed(1)}%`,
      `Errors: ${errorCount}`,
      avgPerf != null ? `Avg performance: ${avgPerf.toFixed(2)}` : null,
    ]
      .filter(Boolean)
      .join(". ");

    // Determine new status based on performance data
    let newStatus: BetOutcome["new_status"];
    let evidence: string;

    if (totalActions === 0) {
      // No data — can't assess, keep active (don't generate outcome)
      return null;
    }

    if (avgPerf != null && avgPerf >= 0.8 && successRate >= 0.85) {
      newStatus = "confirmed";
      evidence = `Hypothesis validated: agent ${bet.agent_name} shows strong performance (score: ${avgPerf.toFixed(2)}, success: ${(successRate * 100).toFixed(1)}%)`;
    } else if (avgPerf != null && avgPerf >= 0.6 && successRate >= 0.7) {
      newStatus = "revised";
      evidence = `Partially validated: agent ${bet.agent_name} shows moderate results (score: ${avgPerf.toFixed(2)}, success: ${(successRate * 100).toFixed(1)}%) — hypothesis needs refinement`;
    } else {
      newStatus = "abandoned";
      evidence = `Hypothesis rejected: agent ${bet.agent_name} shows poor results (score: ${avgPerf?.toFixed(2) ?? "N/A"}, success: ${(successRate * 100).toFixed(1)}%) — rollback recommended`;
    }

    return {
      bet_id: bet.id,
      hypothesis: bet.hypothesis,
      expected_outcome: bet.expected_outcome,
      actual_outcome: actualOutcome,
      new_status: newStatus,
      evidence,
    };
  }

  // ─── Proposal Generation ──────────────────────────────────────────────────

  private generateProposals(
    trends: MonthlyTrendSummary[],
    barRaiserObservations: string[],
  ): StructuralProposal[] {
    const proposals: StructuralProposal[] = [];

    for (const trend of trends) {
      // Propose for declining agents
      if (trend.trend_direction === "declining") {
        proposals.push({
          agent_name: trend.agent_name,
          hypothesis: `${trend.agent_name} performance is declining due to suboptimal operational parameters`,
          expected_outcome: `After parameter adjustment, ${trend.agent_name} performance score should return to stable or improving trend within 2 weeks`,
          measurement_criteria: `${trend.agent_name} avg performance_score >= 0.75 AND trend_direction != 'declining' in next monthly review`,
          rollback_trigger: `${trend.agent_name} error_count increases by >50% or success_rate drops below 60%`,
          rationale: `Monthly trend shows declining performance (direction: ${trend.trend_direction}, success rate: ${(trend.avg_success_rate * 100).toFixed(1)}%, anomalies: ${trend.anomaly_count})`,
        });
      }

      // Propose for agents with high anomaly counts
      if (trend.anomaly_count >= 5) {
        proposals.push({
          agent_name: trend.agent_name,
          hypothesis: `${trend.agent_name} recurring anomalies indicate a structural issue in its configuration or scope`,
          expected_outcome: `After structural review, anomaly count should decrease by at least 50% in the next month`,
          measurement_criteria: `${trend.agent_name} anomaly_count < ${Math.ceil(trend.anomaly_count / 2)} in next monthly review`,
          rollback_trigger: `${trend.agent_name} anomaly_count exceeds ${trend.anomaly_count * 2} or new critical anomalies emerge`,
          rationale: `${trend.anomaly_count} anomalies detected this month — significantly above acceptable threshold`,
        });
      }

      // Propose for agents with very low success rates
      if (trend.avg_success_rate < 0.7 && trend.total_actions > 0) {
        proposals.push({
          agent_name: trend.agent_name,
          hypothesis: `${trend.agent_name} low success rate (${(trend.avg_success_rate * 100).toFixed(1)}%) suggests its current role or configuration needs restructuring`,
          expected_outcome: `Success rate should improve to >= 80% within one month after restructuring`,
          measurement_criteria: `${trend.agent_name} avg_success_rate >= 0.8 in next monthly review`,
          rollback_trigger: `${trend.agent_name} total_actions drops by >50% (indicating capability loss) or new error patterns emerge`,
          rationale: `Success rate of ${(trend.avg_success_rate * 100).toFixed(1)}% is well below the 80% acceptable threshold`,
        });
      }
    }

    return proposals;
  }

  // ─── Bet CRUD Operations ──────────────────────────────────────────────────

  async createBet(input: BetInput): Promise<Bet> {
    const row = BetInputSchema.parse(input);
    const result = await this.pool.query(
      `INSERT INTO telemetry_bets (
        agent_name, hypothesis, expected_outcome, measurement_criteria,
        rollback_trigger, actual_outcome, status, created_date,
        review_date, source_review_month
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *`,
      [
        row.agent_name,
        row.hypothesis,
        row.expected_outcome,
        row.measurement_criteria,
        row.rollback_trigger,
        row.actual_outcome,
        row.status,
        row.created_date,
        row.review_date,
        row.source_review_month,
      ],
    );
    return this.parseBetRow(result.rows[0]);
  }

  async approveBet(betId: string): Promise<Bet> {
    const result = await this.pool.query(
      `UPDATE telemetry_bets
       SET status = 'active', updated_at = now()
       WHERE id = $1 AND status = 'pending_approval'
       RETURNING *`,
      [betId],
    );
    if (result.rows.length === 0) {
      throw new Error(`Bet ${betId} not found or not in pending_approval state`);
    }
    return this.parseBetRow(result.rows[0]);
  }

  async updateBetOutcome(
    betId: string,
    actualOutcome: string,
    newStatus: string,
    reviewDate: Date,
  ): Promise<Bet> {
    const result = await this.pool.query(
      `UPDATE telemetry_bets
       SET actual_outcome = $2, status = $3, review_date = $4, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [betId, actualOutcome, newStatus, reviewDate],
    );
    if (result.rows.length === 0) {
      throw new Error(`Bet ${betId} not found`);
    }
    return this.parseBetRow(result.rows[0]);
  }

  async queryBetsByStatus(status: string): Promise<Bet[]> {
    const result = await this.pool.query(
      `SELECT * FROM telemetry_bets WHERE status = $1 ORDER BY created_date DESC`,
      [status],
    );
    return result.rows.map((r) => this.parseBetRow(r));
  }

  async queryBetsByAgent(agentName: string): Promise<Bet[]> {
    const result = await this.pool.query(
      `SELECT * FROM telemetry_bets WHERE agent_name = $1 ORDER BY created_date DESC`,
      [agentName],
    );
    return result.rows.map((r) => this.parseBetRow(r));
  }

  async queryBetsByMonth(sourceReviewMonth: string): Promise<Bet[]> {
    const result = await this.pool.query(
      `SELECT * FROM telemetry_bets WHERE source_review_month = $1 ORDER BY created_date DESC`,
      [sourceReviewMonth],
    );
    return result.rows.map((r) => this.parseBetRow(r));
  }

  private parseBetRow(row: Record<string, unknown>): Bet {
    return BetSchema.parse(row);
  }

  // ─── Markdown Rendering ───────────────────────────────────────────────────

  private renderReviewMarkdown(
    monthStart: Date,
    monthEnd: Date,
    agentNames: string[],
    trends: MonthlyTrendSummary[],
    barRaiserObservations: string[],
    betOutcomes: BetOutcome[],
    proposals: StructuralProposal[],
  ): string {
    const startStr = monthStart.toISOString().slice(0, 10);
    const endStr = monthEnd.toISOString().slice(0, 10);

    const lines: string[] = [
      "# Monthly Structural Review",
      "",
      `**Period**: ${startStr} to ${endStr}`,
      `**Generated**: ${new Date().toISOString().slice(0, 19)}Z`,
      `**Agents Reviewed**: ${agentNames.join(", ")}`,
      "",

      // Section 1: Agent Performance Trends
      "## Agent Performance Trends",
      "",
    ];

    for (const trend of trends) {
      const trendArrow =
        trend.trend_direction === "improving"
          ? "↑"
          : trend.trend_direction === "declining"
            ? "↓"
            : "→";
      lines.push(
        `### ${trend.agent_name} ${trendArrow}`,
        "",
        `- **Total Actions**: ${trend.total_actions}`,
        `- **Success Rate**: ${(trend.avg_success_rate * 100).toFixed(1)}%`,
        `- **Avg Latency**: ${trend.avg_latency_ms != null ? `${trend.avg_latency_ms.toFixed(0)}ms` : "N/A"}`,
        `- **Total Cost**: $${trend.total_cost_usd.toFixed(4)}`,
        `- **Performance Score**: ${trend.avg_performance_score != null ? trend.avg_performance_score.toFixed(2) : "N/A"}`,
        `- **Anomalies**: ${trend.anomaly_count}`,
        `- **Trend**: ${trend.trend_direction}`,
        "",
      );
    }

    // Section 2: Bar Raiser Observations
    lines.push(
      "## Bar Raiser Observations",
      "",
      ...barRaiserObservations.map((obs) => `- ${obs}`),
      "",
    );

    // Section 3: Previous Bet Outcomes
    lines.push("## Previous Bet Outcomes", "");
    if (betOutcomes.length === 0) {
      lines.push("No active Bets to assess this month.", "");
    } else {
      for (const outcome of betOutcomes) {
        const statusEmoji =
          outcome.new_status === "confirmed"
            ? "[CONFIRMED]"
            : outcome.new_status === "revised"
              ? "[REVISED]"
              : "[ABANDONED]";
        lines.push(
          `### ${statusEmoji} ${outcome.hypothesis}`,
          "",
          `- **Expected**: ${outcome.expected_outcome}`,
          `- **Actual**: ${outcome.actual_outcome}`,
          `- **Evidence**: ${outcome.evidence}`,
          "",
        );
      }
    }

    // Section 4: Structural Proposals
    lines.push("## Structural Proposals", "");
    if (proposals.length === 0) {
      lines.push(
        "No structural changes proposed — system operating within acceptable parameters.",
        "",
      );
    } else {
      lines.push(
        "> **Note**: These proposals require Mike's approval before activation.",
        "",
      );
      for (let i = 0; i < proposals.length; i++) {
        const p = proposals[i];
        lines.push(
          `### Proposal ${i + 1}: ${p.agent_name}`,
          "",
          `- **Hypothesis**: ${p.hypothesis}`,
          `- **Expected Outcome**: ${p.expected_outcome}`,
          `- **Measurement Criteria**: ${p.measurement_criteria}`,
          `- **Rollback Trigger**: ${p.rollback_trigger}`,
          `- **Rationale**: ${p.rationale}`,
          "",
        );
      }
    }

    // Section 5: Proposals Awaiting Review (for Morning Brief integration)
    lines.push("## Proposals Awaiting Review", "");
    if (proposals.length === 0) {
      lines.push("No proposals awaiting review.", "");
    } else {
      lines.push(
        `${proposals.length} proposal(s) awaiting Mike's approval.`,
        "",
      );
    }

    return lines.join("\n");
  }
}
