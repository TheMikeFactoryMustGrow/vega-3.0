/**
 * AQM Stage 2 — Structured Query Construction
 *
 * Uses the frontier model to generate parametric Cypher queries based on
 * schema inspection results and the original question. All queries use
 * parameters (no string interpolation) to prevent injection.
 */

import type { Neo4jConnection } from "../neo4j.js";
import type { ModelRouter, RoutingDecision } from "../model-router.js";
import type { TelemetryEmitter } from "../../telemetry/emitter.js";
import type { SchemaContext } from "./schema-inspector.js";
import { randomUUID } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ConstructedQuery {
  cypher: string;
  parameters: Record<string, unknown>;
  description: string;
  pattern: QueryPattern;
}

export type QueryPattern =
  | "multi_entity_exposure"
  | "cascading_impact"
  | "temporal_change"
  | "entity_lookup"
  | "relationship_traversal"
  | "aggregation"
  | "general";

export interface QueryConstructorOptions {
  connection?: Neo4jConnection;
  router?: ModelRouter;
  emitter?: TelemetryEmitter;
  /** Override for testing — inject a function that calls the LLM */
  llmCall?: (
    prompt: string,
    systemPrompt: string,
    routing: RoutingDecision,
  ) => Promise<string>;
}

export interface QueryConstructionResult {
  query: ConstructedQuery | null;
  validated: boolean;
  validationError?: string;
  fallbackUsed: boolean;
}

// ── System Prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Cypher query generator for a knowledge graph. Your job is to translate natural language questions into precise, parameterized Cypher queries.

GRAPH SCHEMA:
- Node labels: Claim, Entity, Source, OpenQuestion, Bet
- Key properties on Claim: id, content, domain, truth_tier, truth_score, entity_type, created_at, updated_at, embedding
- Key properties on Entity: name, entity_type, domain, description
- Key properties on Source: id, source_type, source_account, file_path
- Relationships: ABOUT (Claim→Entity), SOURCED_FROM (Claim→Source), CONTRADICTS (Claim→Claim), INVOLVES (OpenQuestion→Claim), EVIDENCED_BY (Bet→Claim), RELATED_TO (Entity→Entity, Claim→Claim), BELONGS_TO (Entity→Entity)

RULES:
1. ALL values must be Cypher parameters (use $paramName) — NEVER interpolate strings into the query
2. Use OPTIONAL MATCH for non-critical joins to avoid losing results
3. Return meaningful aliases (not just n, m)
4. Include ORDER BY and LIMIT for result sets
5. Use truth_tier for trust-based filtering/ordering

QUERY PATTERNS you should recognize:
- multi_entity_exposure: Questions about aggregate exposure across multiple entities (e.g., "total exposure to interest rate risk")
- cascading_impact: Questions about chain effects (e.g., "what happens if X changes")
- temporal_change: Questions about changes over time (e.g., "how has X changed")
- entity_lookup: Direct entity questions (e.g., "what do we know about X")
- relationship_traversal: Questions about connections (e.g., "how is X related to Y")
- aggregation: Questions requiring aggregation (e.g., "how many", "total", "average")
- general: Everything else

Respond ONLY with a JSON object (no markdown fencing):
{
  "cypher": "MATCH ... RETURN ...",
  "parameters": { "paramName": "value" },
  "description": "Brief description of what this query does",
  "pattern": "one_of_the_patterns_above"
}`;

// ── Query Constructor ──────────────────────────────────────────────────────

export class QueryConstructor {
  private readonly connection: Neo4jConnection | null;
  private readonly router: ModelRouter | null;
  private readonly emitter: TelemetryEmitter | null;
  private readonly llmCall: (
    prompt: string,
    systemPrompt: string,
    routing: RoutingDecision,
  ) => Promise<string>;
  private readonly sessionId: string;

  constructor(options?: QueryConstructorOptions) {
    this.connection = options?.connection ?? null;
    this.router = options?.router ?? null;
    this.emitter = options?.emitter ?? null;
    this.llmCall = options?.llmCall ?? this.defaultLlmCall.bind(this);
    this.sessionId = randomUUID();
  }

  /**
   * Generate a parameterized Cypher query from a question and schema context.
   */
  async construct(
    question: string,
    schemaContext: SchemaContext,
  ): Promise<QueryConstructionResult> {
    const start = Date.now();

    if (!this.router) {
      return {
        query: null,
        validated: false,
        validationError: "No router configured",
        fallbackUsed: false,
      };
    }

    try {
      const routing = await this.router.route("aqm_query");

      const userPrompt = this.buildPrompt(question, schemaContext);
      const rawResponse = await this.llmCall(
        userPrompt,
        SYSTEM_PROMPT,
        routing,
      );
      const query = this.parseResponse(rawResponse);

      if (!query) {
        await this.emitEvent("query_construction_parse_error", "failure", {
          question,
          raw_response_length: rawResponse.length,
          latency_ms: Date.now() - start,
        });
        return {
          query: null,
          validated: false,
          validationError: "Failed to parse LLM response into a valid query",
          fallbackUsed: false,
        };
      }

      // Validate the query has parameters (no string interpolation)
      const injectionCheck = this.checkForInjection(query.cypher);
      if (injectionCheck) {
        await this.emitEvent(
          "query_construction_injection_detected",
          "failure",
          {
            question,
            issue: injectionCheck,
            latency_ms: Date.now() - start,
          },
        );
        return {
          query: null,
          validated: false,
          validationError: `Injection risk detected: ${injectionCheck}`,
          fallbackUsed: false,
        };
      }

      // Validate with EXPLAIN if we have a connection
      let validated = false;
      let validationError: string | undefined;

      if (this.connection) {
        const validation = await this.validateQuery(
          query.cypher,
          query.parameters,
        );
        validated = validation.valid;
        validationError = validation.error;
      }

      await this.emitEvent("query_construction_complete", "success", {
        question,
        pattern: query.pattern,
        validated,
        latency_ms: Date.now() - start,
      });

      return {
        query,
        validated,
        validationError,
        fallbackUsed: false,
      };
    } catch (error) {
      await this.emitEvent("query_construction_error", "failure", {
        question,
        error: error instanceof Error ? error.message : String(error),
        latency_ms: Date.now() - start,
      });

      return {
        query: null,
        validated: false,
        validationError:
          error instanceof Error ? error.message : String(error),
        fallbackUsed: false,
      };
    }
  }

  /**
   * Parse the LLM response into a ConstructedQuery.
   * Strips markdown code fencing if present.
   */
  parseResponse(raw: string): ConstructedQuery | null {
    try {
      let cleaned = raw.trim();

      // Strip markdown code fencing
      if (cleaned.startsWith("```")) {
        cleaned = cleaned
          .replace(/^```(?:json)?\s*\n?/, "")
          .replace(/\n?```\s*$/, "");
      }

      const parsed = JSON.parse(cleaned) as Record<string, unknown>;

      if (
        typeof parsed.cypher !== "string" ||
        !parsed.cypher.trim()
      ) {
        return null;
      }

      const validPatterns: QueryPattern[] = [
        "multi_entity_exposure",
        "cascading_impact",
        "temporal_change",
        "entity_lookup",
        "relationship_traversal",
        "aggregation",
        "general",
      ];

      const pattern = validPatterns.includes(
        parsed.pattern as QueryPattern,
      )
        ? (parsed.pattern as QueryPattern)
        : "general";

      return {
        cypher: parsed.cypher as string,
        parameters:
          typeof parsed.parameters === "object" && parsed.parameters !== null
            ? (parsed.parameters as Record<string, unknown>)
            : {},
        description:
          typeof parsed.description === "string"
            ? parsed.description
            : "Generated query",
        pattern,
      };
    } catch {
      return null;
    }
  }

  /**
   * Validate a Cypher query by running EXPLAIN against Neo4j.
   */
  private async validateQuery(
    cypher: string,
    parameters: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    if (!this.connection) {
      return { valid: false, error: "No connection" };
    }

    const session = this.connection.session();
    try {
      await session.run(`EXPLAIN ${cypher}`, parameters);
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Check for potential injection in the generated Cypher.
   * Returns a description of the issue, or null if safe.
   */
  private checkForInjection(cypher: string): string | null {
    // Check for string literals that look like they should be parameters
    // Allow string literals in WHERE clauses for known patterns (e.g., label checks)
    const suspiciousPatterns = [
      // Unescaped quotes inside WHERE conditions that aren't label/type checks
      /WHERE\s+[\w.]+\s*=\s*['"][^'"]*['"]\s*(?:AND|OR|RETURN|ORDER|$)/i,
    ];

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(cypher)) {
        // Check if all values in WHERE are parameterized
        const whereClause = cypher.match(/WHERE\s+(.*?)(?:RETURN|ORDER|WITH|$)/is)?.[1];
        if (whereClause) {
          // Simple heuristic: if we see `= 'value'` or `= "value"` it's suspicious
          const literalValues = whereClause.match(/=\s*['"][^'"]+['"]/g);
          if (literalValues && literalValues.length > 0) {
            return `Query contains literal string values in WHERE clause: ${literalValues.join(", ")}. Use parameters instead.`;
          }
        }
      }
    }

    return null;
  }

  /**
   * Build the user prompt with schema context.
   */
  private buildPrompt(question: string, schema: SchemaContext): string {
    const parts: string[] = [
      `QUESTION: ${question}`,
      "",
      "AVAILABLE SCHEMA:",
      `Labels: ${schema.labels.join(", ") || "none"}`,
      `Relationships: ${schema.relationshipTypes.join(", ") || "none"}`,
    ];

    if (Object.keys(schema.nodeCounts).length > 0) {
      parts.push("");
      parts.push("NODE COUNTS:");
      for (const [label, count] of Object.entries(schema.nodeCounts)) {
        parts.push(`  ${label}: ${count}`);
      }
    }

    if (Object.keys(schema.propertyKeys).length > 0) {
      parts.push("");
      parts.push("PROPERTY KEYS:");
      for (const [label, keys] of Object.entries(schema.propertyKeys)) {
        if (keys.length > 0) {
          parts.push(`  ${label}: ${keys.join(", ")}`);
        }
      }
    }

    if (Object.keys(schema.sampleData).length > 0) {
      parts.push("");
      parts.push("SAMPLE DATA:");
      for (const [label, samples] of Object.entries(schema.sampleData)) {
        parts.push(`  ${label}:`);
        for (const sample of samples.slice(0, 2)) {
          // Trim large properties (embeddings, long content)
          const trimmed: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(sample)) {
            if (k === "embedding") continue;
            if (typeof v === "string" && v.length > 200) {
              trimmed[k] = v.slice(0, 200) + "...";
            } else {
              trimmed[k] = v;
            }
          }
          parts.push(`    ${JSON.stringify(trimmed)}`);
        }
      }
    }

    if (schema.domainFilter) {
      parts.push("");
      parts.push(`DOMAIN FILTER: Focus on domain="${schema.domainFilter}"`);
    }

    parts.push("");
    parts.push(
      "Generate a parameterized Cypher query to answer the question. Use $parameters for ALL values.",
    );

    return parts.join("\n");
  }

  /**
   * Default LLM call using OpenAI-compatible chat completions endpoint.
   */
  private async defaultLlmCall(
    prompt: string,
    systemPrompt: string,
    routing: RoutingDecision,
  ): Promise<string> {
    const response = await fetch(`${routing.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${routing.apiKey}`,
      },
      body: JSON.stringify({
        model: routing.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `LLM API error: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    return data.choices[0]?.message?.content ?? "";
  }

  private async emitEvent(
    subtype: string,
    outcome: "success" | "failure" | "partial" | "skipped",
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!this.emitter) return;
    try {
      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_query",
        event_subtype: subtype,
        session_id: this.sessionId,
        outcome,
        metadata,
      });
    } catch {
      // Non-blocking
    }
  }
}
