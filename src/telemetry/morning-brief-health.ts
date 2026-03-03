import pg from "pg";

/**
 * VEGA v3.3 Morning Brief — System Health Section
 *
 * Generates a structured markdown section for the Morning Brief (06:00 AM daily)
 * that queries Tier 2 PostgreSQL tables and presents yesterday's operational metrics.
 *
 * 6 subsections:
 *   1. Active Agents — 24h action counts
 *   2. Total Actions — with day-over-day delta
 *   3. Estimated Cost — with budget tracking
 *   4. Quality Scores — per-agent with trend arrows
 *   5. Anomalies — unresolved from telemetry_anomalies
 *   6. Top Performers — agents by performance_score
 */

export interface SystemHealthSection {
  markdown: string;
  generated_at: Date;
  data_available: boolean;
}

/** Trend arrow mapping: ↑ for >5% improvement, ↓ for >5% decline, → for stable */
function trendArrow(trend: string | null): string {
  switch (trend) {
    case "improving":
      return "↑";
    case "declining":
      return "↓";
    case "stable":
      return "→";
    default:
      return "→";
  }
}

/** Format a number with day-over-day delta as percentage string. */
function formatDelta(current: number, previous: number): string {
  if (previous === 0 && current === 0) return "→ 0%";
  if (previous === 0) return "↑ new";
  const delta = ((current - previous) / previous) * 100;
  if (delta > 5) return `↑ +${delta.toFixed(1)}%`;
  if (delta < -5) return `↓ ${delta.toFixed(1)}%`;
  return `→ ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

export class MorningBriefHealth {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Generate the System Health markdown section.
   *
   * @param targetDate — The date to report on (typically yesterday).
   * @returns Structured markdown section with all 6 subsections.
   */
  async generate(targetDate: Date): Promise<SystemHealthSection> {
    const dayStart = new Date(
      Date.UTC(
        targetDate.getUTCFullYear(),
        targetDate.getUTCMonth(),
        targetDate.getUTCDate(),
      ),
    );
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    // Check if Tier 2 tables have any data for this date
    const hasData = await this.hasDataForDate(dayStart, dayEnd);
    if (!hasData) {
      return {
        markdown:
          "### System Health\n\nTelemetry data collecting — system health available tomorrow\n",
        generated_at: new Date(),
        data_available: false,
      };
    }

    // Generate each subsection via dedicated SQL queries
    const [
      activeAgents,
      totalActions,
      estimatedCost,
      qualityScores,
      anomalies,
      topPerformers,
    ] = await Promise.all([
      this.generateActiveAgents(dayStart, dayEnd),
      this.generateTotalActions(dayStart, dayEnd),
      this.generateEstimatedCost(dayStart),
      this.generateQualityScores(dayStart),
      this.generateAnomalies(),
      this.generateTopPerformers(dayStart, dayEnd),
    ]);

    const markdown = [
      "### System Health",
      "",
      activeAgents,
      totalActions,
      estimatedCost,
      qualityScores,
      anomalies,
      topPerformers,
    ].join("\n");

    return { markdown, generated_at: new Date(), data_available: true };
  }

  // ─── Data availability check ─────────────────────────────────────────────

  private async hasDataForDate(dayStart: Date, dayEnd: Date): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT EXISTS(
        SELECT 1 FROM telemetry_agent_hourly
        WHERE hour_bucket >= $1 AND hour_bucket < $2
      ) AS has_data`,
      [dayStart, dayEnd],
    );
    return result.rows[0]?.has_data === true;
  }

  // ─── Subsection 1: Active Agents ─────────────────────────────────────────

  private async generateActiveAgents(
    dayStart: Date,
    dayEnd: Date,
  ): Promise<string> {
    const result = await this.pool.query(
      `SELECT agent_name, SUM(action_count) AS total_actions
       FROM telemetry_agent_hourly
       WHERE hour_bucket >= $1 AND hour_bucket < $2
       GROUP BY agent_name
       ORDER BY total_actions DESC`,
      [dayStart, dayEnd],
    );

    const lines = ["**Active Agents (24h)**", ""];
    if (result.rows.length === 0) {
      lines.push("No agent activity recorded.");
    } else {
      for (const row of result.rows) {
        lines.push(`- ${row.agent_name}: ${Number(row.total_actions)} actions`);
      }
    }
    lines.push("");
    return lines.join("\n");
  }

  // ─── Subsection 2: Total Actions ─────────────────────────────────────────

  private async generateTotalActions(
    dayStart: Date,
    dayEnd: Date,
  ): Promise<string> {
    // Today's total
    const todayResult = await this.pool.query(
      `SELECT COALESCE(SUM(action_count), 0) AS total
       FROM telemetry_agent_hourly
       WHERE hour_bucket >= $1 AND hour_bucket < $2`,
      [dayStart, dayEnd],
    );
    const todayTotal = Number(todayResult.rows[0]?.total ?? 0);

    // Previous day's total for delta
    const prevDayStart = new Date(dayStart);
    prevDayStart.setUTCDate(prevDayStart.getUTCDate() - 1);
    const prevResult = await this.pool.query(
      `SELECT COALESCE(SUM(action_count), 0) AS total
       FROM telemetry_agent_hourly
       WHERE hour_bucket >= $1 AND hour_bucket < $2`,
      [prevDayStart, dayStart],
    );
    const prevTotal = Number(prevResult.rows[0]?.total ?? 0);

    const delta = formatDelta(todayTotal, prevTotal);

    const lines = [
      "**Total Actions**",
      "",
      `- Total: ${todayTotal} (${delta} day-over-day)`,
      "",
    ];
    return lines.join("\n");
  }

  // ─── Subsection 3: Estimated Cost ────────────────────────────────────────

  private async generateEstimatedCost(dayStart: Date): Promise<string> {
    const result = await this.pool.query(
      `SELECT agent_name, model,
              SUM(total_cost_usd) AS cost,
              SUM(invocations) AS invocations
       FROM telemetry_cost_daily
       WHERE date = $1
       GROUP BY agent_name, model
       ORDER BY cost DESC`,
      [dayStart],
    );

    let totalCost = 0;
    const lines = ["**Estimated Cost**", ""];
    if (result.rows.length === 0) {
      lines.push("No cost data available.");
    } else {
      for (const row of result.rows) {
        const cost = Number(row.cost);
        totalCost += cost;
        lines.push(
          `- ${row.agent_name} (${row.model}): $${cost.toFixed(4)} (${Number(row.invocations)} calls)`,
        );
      }
      lines.push("");
      lines.push(`**Daily Total: $${totalCost.toFixed(4)}**`);
    }
    lines.push("");
    return lines.join("\n");
  }

  // ─── Subsection 4: Quality Scores ────────────────────────────────────────

  private async generateQualityScores(dayStart: Date): Promise<string> {
    const result = await this.pool.query(
      `SELECT agent_name, metric_name, metric_value, trend, p50_value, p95_value
       FROM telemetry_quality_daily
       WHERE date = $1
       ORDER BY agent_name, metric_name`,
      [dayStart],
    );

    const lines = ["**Quality Scores**", ""];
    if (result.rows.length === 0) {
      lines.push("No quality data available.");
    } else {
      // Group by agent
      const agentMetrics = new Map<
        string,
        Array<{
          metric_name: string;
          metric_value: number;
          trend: string | null;
          p50_value: number | null;
          p95_value: number | null;
        }>
      >();
      for (const row of result.rows) {
        const metrics = agentMetrics.get(row.agent_name) ?? [];
        metrics.push({
          metric_name: row.metric_name,
          metric_value: Number(row.metric_value),
          trend: row.trend,
          p50_value: row.p50_value != null ? Number(row.p50_value) : null,
          p95_value: row.p95_value != null ? Number(row.p95_value) : null,
        });
        agentMetrics.set(row.agent_name, metrics);
      }

      for (const [agent, metrics] of agentMetrics) {
        lines.push(`- **${agent}**`);
        for (const m of metrics) {
          const arrow = trendArrow(m.trend);
          const valueStr =
            m.metric_value < 1 && m.metric_value >= 0
              ? `${(m.metric_value * 100).toFixed(1)}%`
              : m.metric_value.toFixed(1);
          lines.push(`  - ${m.metric_name}: ${valueStr} ${arrow}`);
        }
      }
    }
    lines.push("");
    return lines.join("\n");
  }

  // ─── Subsection 5: Anomalies ─────────────────────────────────────────────

  private async generateAnomalies(): Promise<string> {
    const result = await this.pool.query(
      `SELECT severity, COUNT(*) AS count
       FROM telemetry_anomalies
       WHERE resolved_at IS NULL
       GROUP BY severity
       ORDER BY
         CASE severity
           WHEN 'critical' THEN 1
           WHEN 'warning' THEN 2
           WHEN 'info' THEN 3
         END`,
    );

    const lines = ["**Anomalies**", ""];
    if (result.rows.length === 0) {
      lines.push("No unresolved anomalies.");
    } else {
      let totalCount = 0;
      const breakdown: string[] = [];
      for (const row of result.rows) {
        const count = Number(row.count);
        totalCount += count;
        breakdown.push(`${count} ${row.severity}`);
      }
      lines.push(
        `- ${totalCount} unresolved anomalies: ${breakdown.join(", ")}`,
      );
    }
    lines.push("");
    return lines.join("\n");
  }

  // ─── Subsection 6: Top Performers ────────────────────────────────────────

  private async generateTopPerformers(
    dayStart: Date,
    dayEnd: Date,
  ): Promise<string> {
    const result = await this.pool.query(
      `SELECT agent_name,
              AVG(performance_score) AS avg_score,
              SUM(action_count) AS total_actions
       FROM telemetry_agent_hourly
       WHERE hour_bucket >= $1 AND hour_bucket < $2
         AND performance_score IS NOT NULL
       GROUP BY agent_name
       ORDER BY avg_score DESC`,
      [dayStart, dayEnd],
    );

    const lines = ["**Top Performers**", ""];
    if (result.rows.length === 0) {
      lines.push("No performance data available.");
    } else {
      for (let i = 0; i < result.rows.length; i++) {
        const row = result.rows[i];
        const score = Number(row.avg_score);
        lines.push(
          `${i + 1}. ${row.agent_name} — score: ${score.toFixed(2)} (${Number(row.total_actions)} actions)`,
        );
      }
    }
    lines.push("");
    return lines.join("\n");
  }
}
