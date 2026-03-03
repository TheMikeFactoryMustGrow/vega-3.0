import pg from "pg";
import { TelemetryEmitter } from "./emitter.js";
import {
  type SelfAssessmentConfig,
  type SelfAssessmentResult,
  type AdjustmentResult,
  type RuleCondition,
  SelfAssessmentConfigSchema,
} from "./self-assessment-types.js";

/**
 * SelfAssessmentRunner — Loop 1 Operational Learning
 *
 * Reads self_assessment config from an agent identity file, executes
 * metrics_query against telemetry_quality_daily, evaluates adjustment_rules,
 * and updates reasoning_prompt_injection when conditions are met.
 *
 * All adjustments are logged to Tier 1 telemetry (event_type: system_event,
 * event_subtype: self_assessment). The Bar Raiser can override any adjustment.
 */
export class SelfAssessmentRunner {
  private overrides: Map<string, Set<string>> = new Map();

  constructor(
    private readonly pool: pg.Pool,
    private readonly emitter: TelemetryEmitter,
    private readonly options: { emitTelemetry?: boolean } = {},
  ) {}

  /**
   * Register a Bar Raiser override for a specific agent + rule combination.
   * When overridden, the rule is skipped even if the condition is met.
   */
  addOverride(agentName: string, ruleName: string): void {
    if (!this.overrides.has(agentName)) {
      this.overrides.set(agentName, new Set());
    }
    this.overrides.get(agentName)!.add(ruleName);
  }

  /**
   * Remove a Bar Raiser override.
   */
  removeOverride(agentName: string, ruleName: string): void {
    this.overrides.get(agentName)?.delete(ruleName);
  }

  /**
   * Check if a specific rule is overridden by the Bar Raiser.
   */
  isOverridden(agentName: string, ruleName: string): boolean {
    return this.overrides.get(agentName)?.has(ruleName) ?? false;
  }

  /**
   * Run self-assessment for an agent.
   *
   * 1. Validate the self_assessment config
   * 2. Execute metrics_query against PostgreSQL
   * 3. Evaluate each adjustment_rule against query results
   * 4. Apply adjustments (update reasoning_prompt_injection)
   * 5. Log adjustments to Tier 1 telemetry
   * 6. Return updated config and result summary
   */
  async run(
    agentName: string,
    config: SelfAssessmentConfig,
  ): Promise<{ result: SelfAssessmentResult; updatedConfig: SelfAssessmentConfig }> {
    const validated = SelfAssessmentConfigSchema.parse(config);
    const ranAt = new Date();

    // Execute metrics_query to get current metric data
    const queryResult = await this.pool.query(validated.metrics_query);
    const rows: Record<string, unknown>[] = queryResult.rows;

    // Evaluate each adjustment rule
    const adjustments: AdjustmentResult[] = [];
    let currentPrompt = validated.reasoning_prompt_injection;

    for (const rule of validated.adjustment_rules) {
      const overridden = this.isOverridden(agentName, rule.name);
      const conditionMet = this.evaluateCondition(rule.condition, rows);
      const triggered = conditionMet && !overridden;

      const beforePrompt = currentPrompt;
      if (triggered) {
        currentPrompt = rule.action.new_prompt;
      }

      adjustments.push({
        rule_name: rule.name,
        triggered,
        condition_met: conditionMet,
        overridden,
        before_prompt: beforePrompt,
        after_prompt: triggered ? rule.action.new_prompt : beforePrompt,
      });
    }

    // Log to telemetry
    const triggeredRules = adjustments.filter((a) => a.triggered);
    if (triggeredRules.length > 0 && this.options.emitTelemetry !== false) {
      await this.emitter.emit({
        agent_name: agentName,
        event_type: "system_event",
        event_subtype: "self_assessment",
        session_id: `self_assessment_${agentName}_${ranAt.toISOString()}`,
        outcome: "success",
        metadata: {
          rules_triggered: triggeredRules.map((a) => a.rule_name),
          before_prompt: validated.reasoning_prompt_injection,
          after_prompt: currentPrompt,
          adjustments: triggeredRules.map((a) => ({
            rule: a.rule_name,
            before: a.before_prompt,
            after: a.after_prompt,
          })),
          metrics_rows: rows.length,
        },
      });
    }

    // Log overridden rules to telemetry
    const overriddenRules = adjustments.filter((a) => a.overridden && a.condition_met);
    if (overriddenRules.length > 0 && this.options.emitTelemetry !== false) {
      await this.emitter.emit({
        agent_name: "bar_raiser",
        event_type: "system_event",
        event_subtype: "self_assessment_override",
        session_id: `self_assessment_override_${agentName}_${ranAt.toISOString()}`,
        outcome: "success",
        metadata: {
          target_agent: agentName,
          overridden_rules: overriddenRules.map((a) => a.rule_name),
        },
      });
    }

    const result: SelfAssessmentResult = {
      agent_name: agentName,
      ran_at: ranAt,
      metrics_query_rows: rows.length,
      rules_evaluated: adjustments.length,
      rules_triggered: triggeredRules.length,
      rules_overridden: overriddenRules.length,
      adjustments,
      final_prompt: currentPrompt,
    };

    const updatedConfig: SelfAssessmentConfig = {
      ...validated,
      reasoning_prompt_injection: currentPrompt,
    };

    return { result, updatedConfig };
  }

  /**
   * Evaluate a rule condition against query result rows.
   *
   * A condition is met if ANY row in the result set satisfies it.
   * This allows rules like "if ANY metric's p50_value < 0.8" to fire
   * even when only one of several metrics meets the threshold.
   */
  evaluateCondition(condition: RuleCondition, rows: Record<string, unknown>[]): boolean {
    if (rows.length === 0) return false;

    return rows.some((row) => this.evaluateConditionOnRow(condition, row));
  }

  private evaluateConditionOnRow(condition: RuleCondition, row: Record<string, unknown>): boolean {
    switch (condition.type) {
      case "metric_value": {
        const fieldValue = this.getNumericValue(row, condition.field);
        if (fieldValue === null) return false;
        return this.compareValues(fieldValue, condition.operator, condition.value);
      }
      case "trend": {
        const trendValue = row[condition.field];
        if (typeof trendValue !== "string") return false;
        return trendValue === condition.equals;
      }
      case "threshold": {
        const fieldValue = this.getNumericValue(row, condition.field);
        if (fieldValue === null) return false;
        if (condition.min !== undefined && fieldValue < condition.min) return true;
        if (condition.max !== undefined && fieldValue > condition.max) return true;
        return false;
      }
    }
  }

  private getNumericValue(row: Record<string, unknown>, field: string): number | null {
    const val = row[field];
    if (val === null || val === undefined) return null;
    const num = Number(val);
    return isNaN(num) ? null : num;
  }

  private compareValues(
    actual: number,
    operator: "<" | ">" | "=" | "<=" | ">=",
    expected: number,
  ): boolean {
    switch (operator) {
      case "<": return actual < expected;
      case ">": return actual > expected;
      case "=": return actual === expected;
      case "<=": return actual <= expected;
      case ">=": return actual >= expected;
    }
  }
}
