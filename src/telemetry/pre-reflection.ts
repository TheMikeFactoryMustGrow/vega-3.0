import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { TelemetryEmitter } from "./emitter.js";
import type { TelemetryEvent } from "./types.js";
import {
  PreReflectionOptionsSchema,
  type PreReflectionDigest,
  type PreReflectionOptions,
  type TriggerCheckResult,
  type EventSummary,
  type EventTypeSummary,
  type TimeDistribution,
  type NotableFailure,
  type RecurringPattern,
  type ConfidenceCalibration,
} from "./pre-reflection-types.js";

/**
 * VEGA v3.3 Loop 1.5: Agent-Local Pre-Reflection
 *
 * Each agent runs a lightweight pre-reflection routine on its own Tier 1
 * JSONL event history before weekly Loop 2 reflections. This ensures
 * reflections contain substantive self-analysis grounded in actual experience.
 *
 * Key constraints:
 * - Reads ONLY from Tier 1 JSONL (never Tier 2 PostgreSQL)
 * - Uses ONLY local model (qwen3:32b) — never frontier model
 * - Fires when ≥100 events accumulated OR 24h before Loop 2 deadline
 *
 * Digests stored at: ~/vega-telemetry/pre-reflections/{agent_name}/{YYYY-MM-DD}.md
 */
export class PreReflection {
  private readonly preReflectionsDir: string;
  private readonly options: Required<
    Omit<PreReflectionOptions, "emitTelemetry">
  > & { emitTelemetry: boolean };

  constructor(
    private readonly emitter: TelemetryEmitter,
    private readonly basePath: string = path.join(
      process.env.HOME ?? "~",
      "vega-telemetry",
    ),
    options: PreReflectionOptions = {},
  ) {
    const parsed = PreReflectionOptionsSchema.parse(options);
    this.options = {
      event_threshold: parsed.event_threshold ?? 100,
      hours_before_deadline: parsed.hours_before_deadline ?? 24,
      weekly_deadline_day: parsed.weekly_deadline_day ?? 0,
      weekly_deadline_hour: parsed.weekly_deadline_hour ?? 20,
      emitTelemetry: parsed.emitTelemetry ?? true,
    };
    this.preReflectionsDir = path.join(this.basePath, "pre-reflections");
  }

  /**
   * Check whether a pre-reflection should be triggered for this agent.
   *
   * Fires when:
   *   1. Agent has accumulated ≥ event_threshold events since last pre-reflection, OR
   *   2. We are within hours_before_deadline of the weekly Loop 2 deadline
   */
  async checkTrigger(
    agentName: string,
    now: Date = new Date(),
  ): Promise<TriggerCheckResult> {
    const lastDigestDate = await this.getLastDigestDate(agentName);
    const eventsSinceLast = await this.countEventsSince(
      agentName,
      lastDigestDate,
      now,
    );

    // Check deadline proximity
    const nextDeadline = this.getNextWeeklyDeadline(now);
    const hoursUntilDeadline =
      (nextDeadline.getTime() - now.getTime()) / (1000 * 60 * 60);

    // Trigger condition 1: event threshold
    if (eventsSinceLast >= this.options.event_threshold) {
      return {
        should_trigger: true,
        reason: `Event threshold reached: ${eventsSinceLast} events (threshold: ${this.options.event_threshold})`,
        events_since_last: eventsSinceLast,
        hours_until_deadline: hoursUntilDeadline,
      };
    }

    // Trigger condition 2: approaching deadline
    if (hoursUntilDeadline <= this.options.hours_before_deadline) {
      return {
        should_trigger: true,
        reason: `Approaching Loop 2 deadline: ${hoursUntilDeadline.toFixed(1)}h remaining (threshold: ${this.options.hours_before_deadline}h)`,
        events_since_last: eventsSinceLast,
        hours_until_deadline: hoursUntilDeadline,
      };
    }

    return {
      should_trigger: false,
      reason: `No trigger: ${eventsSinceLast} events (need ${this.options.event_threshold}), ${hoursUntilDeadline.toFixed(1)}h until deadline (need ≤${this.options.hours_before_deadline}h)`,
      events_since_last: eventsSinceLast,
      hours_until_deadline: hoursUntilDeadline,
    };
  }

  /**
   * Generate a pre-reflection digest for an agent.
   *
   * Reads Tier 1 JSONL events, analyzes them, and produces a structured
   * digest. Writes the digest to disk as markdown.
   */
  async generateDigest(
    agentName: string,
    now: Date = new Date(),
  ): Promise<PreReflectionDigest> {
    const lastDigestDate = await this.getLastDigestDate(agentName);
    const events = await this.collectEventsSince(agentName, lastDigestDate, now);

    const eventSummary = this.computeEventSummary(events);
    const notableFailures = this.extractNotableFailures(events);
    const recurringPatterns = this.detectRecurringPatterns(events);
    const confidenceCalibration = this.computeConfidenceCalibration(events);
    const externalBlameDetected = this.detectExternalBlame(events);

    const digest: PreReflectionDigest = {
      agent_name: agentName,
      generated_at: now,
      model_used: "qwen3:32b",
      event_summary: eventSummary,
      notable_failures: notableFailures,
      recurring_patterns: recurringPatterns,
      confidence_calibration: confidenceCalibration,
      external_blame_detected: externalBlameDetected,
      markdown: "",
    };

    digest.markdown = this.renderDigestMarkdown(digest);

    // Write to filesystem
    const agentDir = path.join(this.preReflectionsDir, agentName);
    await mkdir(agentDir, { recursive: true });
    const fileName = `${now.toISOString().slice(0, 10)}.md`;
    await writeFile(path.join(agentDir, fileName), digest.markdown, "utf-8");

    // Log to telemetry
    if (this.options.emitTelemetry) {
      await this.emitter.emit({
        agent_name: agentName,
        event_type: "system_event",
        event_subtype: "pre_reflection",
        session_id: `pre_reflection_${agentName}_${now.toISOString().slice(0, 10)}`,
        model_used: "qwen3:32b",
        timestamp: now.toISOString(),
        outcome: "success",
        metadata: {
          total_events_analyzed: events.length,
          notable_failures_count: notableFailures.length,
          recurring_patterns_count: recurringPatterns.length,
          external_blame_detected: externalBlameDetected,
        },
      });
    }

    return digest;
  }

  /**
   * Get the path to the pre-reflections directory for an agent.
   */
  getDigestDir(agentName: string): string {
    return path.join(this.preReflectionsDir, agentName);
  }

  // ─── Event Collection ──────────────────────────────────────────────────────

  /**
   * Get the date of the most recent pre-reflection digest for an agent.
   * Returns null if no previous digest exists.
   */
  private async getLastDigestDate(agentName: string): Promise<Date | null> {
    const agentDir = path.join(this.preReflectionsDir, agentName);
    if (!existsSync(agentDir)) return null;

    try {
      const files = await readdir(agentDir);
      const mdFiles = files
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse();
      if (mdFiles.length === 0) return null;

      const dateStr = mdFiles[0].replace(".md", "");
      const parsed = new Date(dateStr + "T00:00:00Z");
      return isNaN(parsed.getTime()) ? null : parsed;
    } catch {
      return null;
    }
  }

  /**
   * Count events for an agent since a given date (or all events if no date).
   */
  private async countEventsSince(
    agentName: string,
    since: Date | null,
    until: Date,
  ): Promise<number> {
    const events = await this.collectEventsSince(agentName, since, until);
    return events.length;
  }

  /**
   * Collect all Tier 1 JSONL events for an agent in a date range.
   */
  private async collectEventsSince(
    agentName: string,
    since: Date | null,
    until: Date,
  ): Promise<TelemetryEvent[]> {
    const startDate = since ?? new Date(until.getTime() - 30 * 24 * 60 * 60 * 1000); // default 30 days back
    const allEvents: TelemetryEvent[] = [];

    // Iterate day by day
    const current = new Date(
      Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth(),
        startDate.getUTCDate(),
      ),
    );
    const end = new Date(
      Date.UTC(
        until.getUTCFullYear(),
        until.getUTCMonth(),
        until.getUTCDate(),
      ),
    );

    while (current <= end) {
      const dayEvents = await this.emitter.readEvents(current);
      const agentEvents = dayEvents.filter(
        (e) => e.agent_name === agentName,
      );

      // Filter by timestamp range
      for (const event of agentEvents) {
        const eventTime = new Date(event.timestamp);
        if (eventTime >= startDate && eventTime <= until) {
          allEvents.push(event);
        }
      }

      current.setUTCDate(current.getUTCDate() + 1);
    }

    return allEvents;
  }

  /**
   * Get the next weekly Loop 2 deadline from a given point in time.
   */
  private getNextWeeklyDeadline(now: Date): Date {
    const deadline = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        this.options.weekly_deadline_hour,
      ),
    );

    // Advance to the next target day
    const currentDay = deadline.getUTCDay();
    let daysUntilTarget = this.options.weekly_deadline_day - currentDay;
    if (daysUntilTarget < 0) daysUntilTarget += 7;
    if (daysUntilTarget === 0 && deadline <= now) daysUntilTarget = 7;

    deadline.setUTCDate(deadline.getUTCDate() + daysUntilTarget);
    return deadline;
  }

  // ─── Analysis Functions ────────────────────────────────────────────────────

  /**
   * Compute event summary: total events, by type, and time distribution.
   */
  private computeEventSummary(events: TelemetryEvent[]): EventSummary {
    // By type
    const typeMap = new Map<
      string,
      { count: number; success: number; failure: number }
    >();
    for (const event of events) {
      const entry = typeMap.get(event.event_type) ?? {
        count: 0,
        success: 0,
        failure: 0,
      };
      entry.count++;
      if (event.outcome === "success") entry.success++;
      if (event.outcome === "failure") entry.failure++;
      typeMap.set(event.event_type, entry);
    }

    const byType: EventTypeSummary[] = [...typeMap.entries()].map(
      ([event_type, stats]) => ({
        event_type,
        count: stats.count,
        success_count: stats.success,
        failure_count: stats.failure,
      }),
    );

    // Time distribution (by hour of day)
    const hourCounts = new Map<number, number>();
    for (const event of events) {
      const hour = new Date(event.timestamp).getUTCHours();
      hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1);
    }

    const timeDistribution: TimeDistribution[] = [...hourCounts.entries()]
      .map(([hour, count]) => ({ hour, count }))
      .sort((a, b) => a.hour - b.hour);

    // Date range
    const timestamps = events.map((e) => e.timestamp).sort();

    return {
      total_events: events.length,
      by_type: byType,
      time_distribution: timeDistribution,
      date_range_start: timestamps[0] ?? "",
      date_range_end: timestamps[timestamps.length - 1] ?? "",
    };
  }

  /**
   * Extract the top 3 most common failure subtypes with root cause analysis.
   */
  private extractNotableFailures(
    events: TelemetryEvent[],
  ): NotableFailure[] {
    const failures = events.filter((e) => e.outcome === "failure");
    if (failures.length === 0) return [];

    // Group by event_subtype
    const subtypeMap = new Map<string, TelemetryEvent[]>();
    for (const f of failures) {
      const group = subtypeMap.get(f.event_subtype) ?? [];
      group.push(f);
      subtypeMap.set(f.event_subtype, group);
    }

    // Sort by frequency, take top 3
    const sorted = [...subtypeMap.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 3);

    return sorted.map(([subtype, failureEvents]) => {
      const sample = failureEvents[0];
      const errorMetadata = sample.metadata?.error ?? sample.metadata?.reason;
      const rootCause = errorMetadata
        ? `Error detail: ${String(errorMetadata)}`
        : `${failureEvents.length} occurrences of ${subtype} failure — investigate ${sample.event_type} handler`;

      return {
        event_subtype: subtype,
        count: failureEvents.length,
        sample_event_id: sample.event_id,
        sample_timestamp: sample.timestamp,
        root_cause_analysis: rootCause,
      };
    });
  }

  /**
   * Detect recurring patterns from event sequences.
   */
  private detectRecurringPatterns(
    events: TelemetryEvent[],
  ): RecurringPattern[] {
    const patterns: RecurringPattern[] = [];
    if (events.length === 0) return patterns;

    // Pattern 1: Repeated failure sequences (same subtype failing repeatedly)
    const failureStreaks = this.detectFailureStreaks(events);
    for (const streak of failureStreaks) {
      patterns.push({
        pattern_type: "failure_streak",
        description: `Repeated ${streak.subtype} failures (${streak.count} consecutive)`,
        frequency: streak.occurrences,
        evidence: `First occurrence at ${streak.firstTimestamp}, last at ${streak.lastTimestamp}`,
      });
    }

    // Pattern 2: High-frequency event bursts (>10 events in the same hour)
    const bursts = this.detectEventBursts(events);
    for (const burst of bursts) {
      patterns.push({
        pattern_type: "event_burst",
        description: `Event burst: ${burst.count} events in hour starting ${burst.hourStart}`,
        frequency: burst.count,
        evidence: `Peak activity at ${burst.hourStart} UTC with ${burst.count} events`,
      });
    }

    // Pattern 3: Model usage patterns
    const modelPatterns = this.detectModelPatterns(events);
    for (const mp of modelPatterns) {
      patterns.push(mp);
    }

    return patterns;
  }

  private detectFailureStreaks(
    events: TelemetryEvent[],
  ): Array<{
    subtype: string;
    count: number;
    occurrences: number;
    firstTimestamp: string;
    lastTimestamp: string;
  }> {
    const results: Array<{
      subtype: string;
      count: number;
      occurrences: number;
      firstTimestamp: string;
      lastTimestamp: string;
    }> = [];

    const sorted = [...events].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    let currentSubtype = "";
    let streakCount = 0;
    let streakStart = "";

    for (const event of sorted) {
      if (event.outcome === "failure") {
        if (event.event_subtype === currentSubtype) {
          streakCount++;
        } else {
          if (streakCount >= 3) {
            results.push({
              subtype: currentSubtype,
              count: streakCount,
              occurrences: 1,
              firstTimestamp: streakStart,
              lastTimestamp: sorted[sorted.indexOf(event) - 1]?.timestamp ?? streakStart,
            });
          }
          currentSubtype = event.event_subtype;
          streakCount = 1;
          streakStart = event.timestamp;
        }
      } else {
        if (streakCount >= 3) {
          results.push({
            subtype: currentSubtype,
            count: streakCount,
            occurrences: 1,
            firstTimestamp: streakStart,
            lastTimestamp: sorted[sorted.indexOf(event) - 1]?.timestamp ?? streakStart,
          });
        }
        currentSubtype = "";
        streakCount = 0;
        streakStart = "";
      }
    }

    // Final streak
    if (streakCount >= 3) {
      results.push({
        subtype: currentSubtype,
        count: streakCount,
        occurrences: 1,
        firstTimestamp: streakStart,
        lastTimestamp: sorted[sorted.length - 1]?.timestamp ?? streakStart,
      });
    }

    return results;
  }

  private detectEventBursts(
    events: TelemetryEvent[],
  ): Array<{ hourStart: string; count: number }> {
    const hourBuckets = new Map<string, number>();

    for (const event of events) {
      const ts = new Date(event.timestamp);
      const hourKey = `${ts.toISOString().slice(0, 13)}:00:00Z`;
      hourBuckets.set(hourKey, (hourBuckets.get(hourKey) ?? 0) + 1);
    }

    return [...hourBuckets.entries()]
      .filter(([, count]) => count > 10)
      .map(([hourStart, count]) => ({ hourStart, count }))
      .sort((a, b) => b.count - a.count);
  }

  private detectModelPatterns(
    events: TelemetryEvent[],
  ): RecurringPattern[] {
    const patterns: RecurringPattern[] = [];
    const modelUsage = new Map<string, number>();

    for (const event of events) {
      if (event.model_used) {
        modelUsage.set(
          event.model_used,
          (modelUsage.get(event.model_used) ?? 0) + 1,
        );
      }
    }

    // Flag if frontier model was used (should be local model only for pre-reflection context)
    const frontierModels = [...modelUsage.entries()].filter(
      ([model]) => model !== "qwen3:32b",
    );

    if (frontierModels.length > 0) {
      for (const [model, count] of frontierModels) {
        patterns.push({
          pattern_type: "frontier_model_usage",
          description: `Frontier model ${model} used ${count} times in period — verify if appropriate`,
          frequency: count,
          evidence: `Model: ${model}, usage count: ${count}`,
        });
      }
    }

    return patterns;
  }

  /**
   * Compute confidence calibration from predicted vs actual outcomes.
   *
   * Uses event metadata to check for predicted_outcome vs actual outcome.
   * Events without predictions are excluded from calibration.
   */
  private computeConfidenceCalibration(
    events: TelemetryEvent[],
  ): ConfidenceCalibration {
    let totalPredictions = 0;
    let correctPredictions = 0;
    let overconfident = 0;
    let underconfident = 0;

    for (const event of events) {
      const predicted = event.metadata?.predicted_outcome as
        | string
        | undefined;
      if (!predicted) continue;

      totalPredictions++;
      if (predicted === event.outcome) {
        correctPredictions++;
      } else if (predicted === "success" && event.outcome === "failure") {
        overconfident++;
      } else if (predicted === "failure" && event.outcome === "success") {
        underconfident++;
      }
    }

    return {
      total_predictions: totalPredictions,
      correct_predictions: correctPredictions,
      accuracy: totalPredictions > 0 ? correctPredictions / totalPredictions : 0,
      overconfident_count: overconfident,
      underconfident_count: underconfident,
    };
  }

  /**
   * Detect external blame patterns in event metadata.
   *
   * Agents attributing failures to other agents or infrastructure rather
   * than their own behavior is a red flag the Bar Raiser monitors.
   */
  private detectExternalBlame(events: TelemetryEvent[]): boolean {
    const blameKeywords = [
      "caused by another agent",
      "infrastructure failure",
      "not my fault",
      "external dependency",
      "upstream error",
      "other agent failed",
      "blocked by",
      "waiting on",
    ];

    for (const event of events) {
      if (event.outcome !== "failure") continue;

      const metadataStr = JSON.stringify(event.metadata ?? {}).toLowerCase();
      for (const keyword of blameKeywords) {
        if (metadataStr.includes(keyword)) {
          return true;
        }
      }
    }

    return false;
  }

  // ─── Markdown Rendering ────────────────────────────────────────────────────

  private renderDigestMarkdown(digest: PreReflectionDigest): string {
    const lines: string[] = [
      `# Pre-Reflection Digest: ${digest.agent_name}`,
      "",
      `**Generated**: ${digest.generated_at.toISOString().slice(0, 19)}Z`,
      `**Model**: ${digest.model_used} (local)`,
      "",
      "## Event Summary",
      "",
      `- **Total Events**: ${digest.event_summary.total_events}`,
      `- **Date Range**: ${digest.event_summary.date_range_start.slice(0, 10)} to ${digest.event_summary.date_range_end.slice(0, 10)}`,
      "",
      "### By Type",
      "",
    ];

    if (digest.event_summary.by_type.length === 0) {
      lines.push("No events recorded.", "");
    } else {
      lines.push("| Event Type | Count | Success | Failure |", "| --- | --- | --- | --- |");
      for (const t of digest.event_summary.by_type) {
        lines.push(
          `| ${t.event_type} | ${t.count} | ${t.success_count} | ${t.failure_count} |`,
        );
      }
      lines.push("");
    }

    lines.push("### Time Distribution", "");
    if (digest.event_summary.time_distribution.length === 0) {
      lines.push("No time distribution data.", "");
    } else {
      lines.push("| Hour (UTC) | Count |", "| --- | --- |");
      for (const td of digest.event_summary.time_distribution) {
        lines.push(`| ${String(td.hour).padStart(2, "0")}:00 | ${td.count} |`);
      }
      lines.push("");
    }

    lines.push("## Notable Failures", "");
    if (digest.notable_failures.length === 0) {
      lines.push("No failures recorded in this period.", "");
    } else {
      for (let i = 0; i < digest.notable_failures.length; i++) {
        const f = digest.notable_failures[i];
        lines.push(
          `### ${i + 1}. ${f.event_subtype} (${f.count} occurrences)`,
          "",
          `- **Sample Event**: ${f.sample_event_id}`,
          `- **First Seen**: ${f.sample_timestamp}`,
          `- **Root Cause**: ${f.root_cause_analysis}`,
          "",
        );
      }
    }

    lines.push("## Recurring Patterns", "");
    if (digest.recurring_patterns.length === 0) {
      lines.push(
        "No recurring patterns detected — operations appear stable.",
        "",
      );
    } else {
      for (const p of digest.recurring_patterns) {
        lines.push(
          `- **${p.pattern_type}**: ${p.description} (frequency: ${p.frequency})`,
          `  - Evidence: ${p.evidence}`,
        );
      }
      lines.push("");
    }

    lines.push("## Confidence Calibration", "");
    const cc = digest.confidence_calibration;
    if (cc.total_predictions === 0) {
      lines.push(
        "No prediction metadata available — confidence calibration requires predicted_outcome in event metadata.",
        "",
      );
    } else {
      lines.push(
        `- **Total Predictions**: ${cc.total_predictions}`,
        `- **Accuracy**: ${(cc.accuracy * 100).toFixed(1)}%`,
        `- **Overconfident**: ${cc.overconfident_count} (predicted success, got failure)`,
        `- **Underconfident**: ${cc.underconfident_count} (predicted failure, got success)`,
        "",
      );
    }

    if (digest.external_blame_detected) {
      lines.push(
        "## ⚠ External Blame Detected",
        "",
        "Bar Raiser alert: failure metadata contains external attribution patterns.",
        "Agent may be attributing failures to other agents or infrastructure rather than own behavior.",
        "",
      );
    }

    return lines.join("\n");
  }
}
