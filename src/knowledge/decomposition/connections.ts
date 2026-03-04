import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Neo4jConnection } from "../neo4j.js";
import { EmbeddingPipeline } from "../embedding.js";
import { ModelRouter, type RoutingDecision } from "../model-router.js";
import { TelemetryEmitter } from "../../telemetry/emitter.js";
import { DomainClassification, TruthTierEnum } from "./decomposer.js";

/**
 * ConnectionDiscovery — The compound interest engine.
 *
 * Discovers non-obvious connections between claims and entities across domains.
 * Two modes:
 * 1. On-ingestion: when a new claim is created, check if extracted entities
 *    also appear in claims from OTHER domains (cross-domain bridge detection).
 * 2. Implicit bet detection: periodic scan for concentration patterns
 *    (e.g., all financial positions in USD = implicit currency bet).
 *
 * High-relevance connections (score > 0.8) → persisted as agent_inferred Claims.
 * Low-relevance connections (0.5-0.8) → logged, not persisted.
 *
 * Uses frontier model (via ModelRouter) — connection analysis is complex reasoning.
 */

// ── Types ────────────────────────────────────────────────────────────

export const ConnectionAnalysisSchema = z.object({
  is_connected: z.boolean(),
  explanation: z.string(),
  relevance_score: z.number().min(0).max(1),
  connection_type: z.string(),
  insight: z.string().optional(),
});
export type ConnectionAnalysis = z.infer<typeof ConnectionAnalysisSchema>;

export const ImplicitBetSchema = z.object({
  bet_type: z.literal("implicit"),
  description: z.string(),
  concentration_factor: z.string(),
  risk_level: z.enum(["high", "medium", "low"]),
  supporting_evidence: z.array(z.string()),
});
export type ImplicitBet = z.infer<typeof ImplicitBetSchema>;

export interface CrossDomainClaim {
  id: string;
  content: string;
  truth_tier: string;
  domain: string;
  entity_name: string;
}

export interface ConnectionResult {
  connections_found: number;
  claims_created: number;
  bets_detected: number;
  low_relevance_logged: number;
  errors: string[];
}

export interface ConnectionDiscoveryOptions {
  connection?: Neo4jConnection;
  embedding?: EmbeddingPipeline | null;
  router?: ModelRouter;
  emitter?: TelemetryEmitter;
  /** Override for testing — inject a function that calls the LLM */
  llmCall?: (prompt: string, systemPrompt: string, routing: RoutingDecision) => Promise<string>;
  /** Threshold above which connections are persisted as Claims (default: 0.8) */
  highRelevanceThreshold?: number;
  /** Threshold below which connections are discarded (default: 0.5) */
  lowRelevanceThreshold?: number;
}

// ── Prompts ──────────────────────────────────────────────────────────

const CONNECTION_SYSTEM_PROMPT = `You are the Knowledge Agent's cross-domain connection discovery engine. Your job is to identify non-obvious connections between claims from different domains.

For each pair of cross-domain claims, assess:
1. is_connected: true if there is a meaningful, non-trivial connection between the claims
2. explanation: Brief explanation of the connection (or why there isn't one)
3. relevance_score: 0.0-1.0 — how valuable this connection is for decision-making
4. connection_type: Type of connection (e.g., "career_financial", "health_legal", "family_business", "entity_bridge")
5. insight: If is_connected is true, a synthesized insight that combines information from both domains

Rules:
- Connections must be MEANINGFUL — not just "both mention money"
- Cross-domain connections are more valuable than same-domain connections
- Entity overlap (same person/org in different domains) is a strong signal
- Consider temporal relationships — events in one domain may affect another
- Respond with ONLY a JSON object, no markdown fencing, no explanation.`;

const BET_SYSTEM_PROMPT = `You are the Knowledge Agent's implicit bet detection engine. Your job is to identify hidden concentration risks and implicit bets in a portfolio of financial claims.

Analyze the provided claims for concentration patterns and respond with a JSON array of implicit bets detected. For each bet:
1. bet_type: always "implicit"
2. description: Clear description of the implicit bet being made
3. concentration_factor: What is concentrated (e.g., "USD currency", "US equities", "single counterparty")
4. risk_level: "high", "medium", or "low"
5. supporting_evidence: Array of claim IDs that support this detection

Rules:
- Look for currency concentration (all positions in same currency)
- Look for geographic concentration (all positions in same region)
- Look for counterparty concentration (multiple positions with same institution)
- Look for asset class concentration (heavily weighted in one asset type)
- Only flag MEANINGFUL concentrations — a single position isn't a bet
- Respond with ONLY a JSON array, no markdown fencing, no explanation.`;

function buildConnectionPrompt(
  claim1: CrossDomainClaim,
  claim2: CrossDomainClaim,
): string {
  return `Analyze these two cross-domain claims for meaningful connections:

Claim 1 (domain: ${claim1.domain}, entity: ${claim1.entity_name}, truth_tier: ${claim1.truth_tier}):
"${claim1.content}"

Claim 2 (domain: ${claim2.domain}, entity: ${claim2.entity_name}, truth_tier: ${claim2.truth_tier}):
"${claim2.content}"

Is there a meaningful cross-domain connection?`;
}

function buildBetPrompt(claims: Array<{ id: string; content: string; domain: string }>): string {
  const claimList = claims
    .map((c) => `- [${c.id}] (${c.domain}): "${c.content}"`)
    .join("\n");
  return `Analyze these financial claims for implicit bets and concentration risks:\n\n${claimList}`;
}

// ── ConnectionDiscovery ──────────────────────────────────────────────

export class ConnectionDiscovery {
  private readonly connection: Neo4jConnection | null;
  private readonly embedding: EmbeddingPipeline | null;
  private readonly router: ModelRouter;
  private readonly emitter: TelemetryEmitter;
  private readonly llmCall: (prompt: string, systemPrompt: string, routing: RoutingDecision) => Promise<string>;
  private readonly highRelevanceThreshold: number;
  private readonly lowRelevanceThreshold: number;
  private readonly sessionId: string;

  constructor(options?: ConnectionDiscoveryOptions) {
    this.connection = options?.connection ?? null;
    this.embedding = options?.embedding ?? null;
    this.router = options?.router ?? new ModelRouter();
    this.emitter = options?.emitter ?? new TelemetryEmitter();
    this.highRelevanceThreshold = options?.highRelevanceThreshold ?? 0.8;
    this.lowRelevanceThreshold = options?.lowRelevanceThreshold ?? 0.5;
    this.sessionId = `connections-${Date.now()}`;

    this.llmCall = options?.llmCall ?? this.defaultLlmCall.bind(this);
  }

  /**
   * On-ingestion mode: for a new claim, find cross-domain entity bridges.
   * Queries Neo4j for entities in the claim that also appear in claims from
   * OTHER domains, then analyzes the connection with the frontier model.
   */
  async checkOnIngestion(
    claimId: string,
    claimContent: string,
    claimDomain: string,
    claimTruthTier: string,
    entities: Array<{ name: string; type: string }>,
  ): Promise<ConnectionResult> {
    const start = Date.now();
    const result: ConnectionResult = {
      connections_found: 0,
      claims_created: 0,
      bets_detected: 0,
      low_relevance_logged: 0,
      errors: [],
    };

    try {
      // For each entity, find cross-domain claims about the same entity
      const crossDomainClaims = await this.findCrossDomainClaims(entities, claimDomain);

      if (crossDomainClaims.length === 0) {
        await this.emitEvent("on_ingestion", result, Date.now() - start);
        return result;
      }

      // Route to frontier model for analysis
      const routing = await this.router.route("complex_reasoning");

      // Analyze each cross-domain pair
      for (const crossClaim of crossDomainClaims) {
        try {
          const thisClaim: CrossDomainClaim = {
            id: claimId,
            content: claimContent,
            truth_tier: claimTruthTier,
            domain: claimDomain,
            entity_name: crossClaim.entity_name,
          };

          const analysis = await this.analyzeConnection(thisClaim, crossClaim, routing);

          if (analysis.is_connected) {
            result.connections_found++;

            const score = this.computeConnectionScore(
              analysis,
              thisClaim,
              crossClaim,
            );

            if (score > this.highRelevanceThreshold && this.connection) {
              // Persist as agent_inferred Claim
              await this.persistConnection(thisClaim, crossClaim, analysis, score);
              result.claims_created++;
            } else if (score >= this.lowRelevanceThreshold) {
              // Log but don't persist
              result.low_relevance_logged++;
            }

            // Create RELATED_TO relationship regardless of score
            if (this.connection) {
              await this.createRelatedToRelationship(
                thisClaim.id,
                crossClaim.id,
                analysis.connection_type,
                score,
              );
            }
          }
        } catch (err) {
          result.errors.push(`Error checking cross-domain claim ${crossClaim.id}: ${err}`);
        }
      }

      await this.emitEvent("on_ingestion", result, Date.now() - start);
      return result;
    } catch (err) {
      result.errors.push(`On-ingestion check failed: ${err}`);
      await this.emitEvent("on_ingestion", result, Date.now() - start, "failure");
      return result;
    }
  }

  /**
   * Detect implicit bets — concentration patterns in financial claims.
   * Runs Cypher queries for currency/geographic/counterparty/asset concentration.
   */
  async detectImplicitBets(): Promise<ConnectionResult> {
    const start = Date.now();
    const result: ConnectionResult = {
      connections_found: 0,
      claims_created: 0,
      bets_detected: 0,
      low_relevance_logged: 0,
      errors: [],
    };

    if (!this.connection) {
      result.errors.push("No Neo4j connection — cannot detect implicit bets");
      return result;
    }

    try {
      // 1. Fetch financial claims for analysis
      const financialClaims = await this.fetchFinancialClaims();

      if (financialClaims.length < 2) {
        await this.emitEvent("implicit_bet_detection", result, Date.now() - start);
        return result;
      }

      // 2. Route to frontier model
      const routing = await this.router.route("complex_reasoning");

      // 3. Analyze for concentration patterns
      const userPrompt = buildBetPrompt(financialClaims);
      const rawResponse = await this.llmCall(userPrompt, BET_SYSTEM_PROMPT, routing);
      const bets = this.parseBetResponse(rawResponse);

      // 4. Create Bet nodes for detected bets
      for (const bet of bets) {
        try {
          await this.createBetNode(bet);
          result.bets_detected++;
        } catch (err) {
          result.errors.push(`Error creating bet node: ${err}`);
        }
      }

      result.connections_found = bets.length;
      await this.emitEvent("implicit_bet_detection", result, Date.now() - start);
      return result;
    } catch (err) {
      result.errors.push(`Implicit bet detection failed: ${err}`);
      await this.emitEvent("implicit_bet_detection", result, Date.now() - start, "failure");
      return result;
    }
  }

  /**
   * Analyze whether two cross-domain claims have a meaningful connection.
   */
  async analyzeConnection(
    claim1: CrossDomainClaim,
    claim2: CrossDomainClaim,
    routing: RoutingDecision,
  ): Promise<ConnectionAnalysis> {
    const userPrompt = buildConnectionPrompt(claim1, claim2);
    const rawResponse = await this.llmCall(userPrompt, CONNECTION_SYSTEM_PROMPT, routing);
    return this.parseConnectionAnalysis(rawResponse);
  }

  /**
   * Parse an LLM connection analysis response.
   * Strips markdown fencing, validates with Zod.
   */
  parseConnectionAnalysis(raw: string): ConnectionAnalysis {
    let cleaned = raw.trim();
    if (cleaned.startsWith("```json")) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith("```")) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith("```")) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    const parsed = JSON.parse(cleaned);
    return ConnectionAnalysisSchema.parse(parsed);
  }

  /**
   * Parse the LLM implicit bet detection response.
   * Returns validated ImplicitBet objects.
   */
  parseBetResponse(raw: string): ImplicitBet[] {
    let cleaned = raw.trim();
    if (cleaned.startsWith("```json")) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith("```")) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith("```")) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) {
      throw new Error("LLM response is not a JSON array");
    }

    const bets: ImplicitBet[] = [];
    for (const item of parsed) {
      try {
        bets.push(ImplicitBetSchema.parse(item));
      } catch (err) {
        console.error(`[ConnectionDiscovery] Skipping invalid bet: ${err}`);
      }
    }

    return bets;
  }

  /**
   * Compute a connection score based on:
   * - LLM relevance score (base)
   * - Entity overlap count (bonus)
   * - Domain diversity (bonus for different domains)
   * - Truth tier of claims (higher tiers get bonus)
   */
  computeConnectionScore(
    analysis: ConnectionAnalysis,
    claim1: CrossDomainClaim,
    claim2: CrossDomainClaim,
  ): number {
    let score = analysis.relevance_score;

    // Domain diversity bonus (different domains = more valuable)
    if (claim1.domain !== claim2.domain) {
      score += 0.05;
    }

    // Truth tier bonus
    const tierBonus: Record<string, number> = {
      family_direct: 0.1,
      multi_source_verified: 0.05,
      single_source: 0,
      agent_inferred: -0.05,
    };
    score += tierBonus[claim1.truth_tier] ?? 0;
    score += tierBonus[claim2.truth_tier] ?? 0;

    // Clamp to [0, 1]
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Find claims from OTHER domains that share entities with the given claim.
   */
  private async findCrossDomainClaims(
    entities: Array<{ name: string; type: string }>,
    claimDomain: string,
  ): Promise<CrossDomainClaim[]> {
    if (!this.connection || entities.length === 0) return [];

    const crossDomainClaims: CrossDomainClaim[] = [];
    const seenClaimIds = new Set<string>();

    for (const entity of entities) {
      const session = this.connection.session();
      try {
        const result = await session.run(
          `MATCH (c:Claim)-[:ABOUT]->(e:Entity {name: $entityName})
           WHERE c.domain <> $domain AND c.status = 'active'
           RETURN c.id AS id, c.content AS content, c.truth_tier AS truth_tier,
                  c.domain AS domain, e.name AS entity_name`,
          { entityName: entity.name, domain: claimDomain },
        );

        for (const record of result.records) {
          const id = record.get("id") as string;
          if (seenClaimIds.has(id)) continue;
          seenClaimIds.add(id);

          crossDomainClaims.push({
            id,
            content: record.get("content") as string,
            truth_tier: (record.get("truth_tier") as string) ?? "single_source",
            domain: (record.get("domain") as string) ?? "general",
            entity_name: record.get("entity_name") as string,
          });
        }
      } finally {
        await session.close();
      }
    }

    return crossDomainClaims;
  }

  /**
   * Fetch financial claims for implicit bet analysis.
   * Targets personal_finance and gix domains.
   */
  private async fetchFinancialClaims(): Promise<Array<{ id: string; content: string; domain: string }>> {
    if (!this.connection) return [];

    const session = this.connection.session();
    try {
      const result = await session.run(
        `MATCH (c:Claim)
         WHERE c.domain IN ['personal_finance', 'gix']
           AND c.status = 'active'
         RETURN c.id AS id, c.content AS content, c.domain AS domain
         ORDER BY c.created_at DESC
         LIMIT 50`,
      );

      return result.records.map((record) => ({
        id: record.get("id") as string,
        content: record.get("content") as string,
        domain: (record.get("domain") as string) ?? "personal_finance",
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Persist a high-relevance cross-domain connection as an agent_inferred Claim.
   */
  private async persistConnection(
    claim1: CrossDomainClaim,
    claim2: CrossDomainClaim,
    analysis: ConnectionAnalysis,
    score: number,
  ): Promise<void> {
    if (!this.connection) return;

    const insightContent = analysis.insight
      ?? `Cross-domain connection: ${analysis.explanation}`;
    const claimId = `claim-connection-${randomUUID()}`;

    const session = this.connection.session();
    try {
      await session.run(
        `CREATE (c:Claim {
           id: $claimId,
           content: $content,
           truth_tier: 'agent_inferred',
           truth_score: $score,
           domain: $domain,
           status: 'active',
           connection_type: $connectionType,
           source_claim_1: $claim1Id,
           source_claim_2: $claim2Id,
           decomposed: false,
           created_at: datetime(),
           updated_at: datetime()
         })`,
        {
          claimId,
          content: insightContent,
          score,
          domain: claim1.domain,
          connectionType: analysis.connection_type,
          claim1Id: claim1.id,
          claim2Id: claim2.id,
        },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Create a RELATED_TO relationship between two cross-domain claims.
   */
  private async createRelatedToRelationship(
    claimId1: string,
    claimId2: string,
    connectionType: string,
    score: number,
  ): Promise<void> {
    if (!this.connection) return;

    const session = this.connection.session();
    try {
      await session.run(
        `MATCH (c1:Claim {id: $id1}), (c2:Claim {id: $id2})
         MERGE (c1)-[r:RELATED_TO]->(c2)
         SET r.connection_type = $connectionType,
             r.relevance_score = $score,
             r.discovered_at = datetime()`,
        { id1: claimId1, id2: claimId2, connectionType, score },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Create a Bet node for an implicit bet, linked to supporting claims via EVIDENCED_BY.
   */
  private async createBetNode(bet: ImplicitBet): Promise<void> {
    if (!this.connection) return;

    const betId = `bet-${randomUUID()}`;

    const session = this.connection.session();
    try {
      // Create the Bet node
      await session.run(
        `CREATE (b:Bet {
           id: $betId,
           bet_type: 'implicit',
           description: $description,
           concentration_factor: $concentrationFactor,
           risk_level: $riskLevel,
           status: 'active',
           detected_by: 'knowledge_agent',
           created_at: datetime()
         })`,
        {
          betId,
          description: bet.description,
          concentrationFactor: bet.concentration_factor,
          riskLevel: bet.risk_level,
        },
      );

      // Link to supporting claims via EVIDENCED_BY
      for (const claimId of bet.supporting_evidence) {
        await session.run(
          `MATCH (b:Bet {id: $betId}), (c:Claim {id: $claimId})
           MERGE (b)-[:EVIDENCED_BY]->(c)`,
          { betId, claimId },
        );
      }
    } finally {
      await session.close();
    }
  }

  /**
   * Default LLM call using fetch to the routed model's API.
   * Uses OpenAI-compatible chat completions endpoint.
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
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    return data.choices[0]?.message?.content ?? "";
  }

  private async emitEvent(
    mode: string,
    result: ConnectionResult,
    latencyMs: number,
    outcome?: "success" | "failure" | "partial" | "skipped",
  ): Promise<void> {
    try {
      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_write",
        event_subtype: "connection_discovery",
        session_id: this.sessionId,
        outcome: outcome ?? (result.errors.length === 0 ? "success" : "partial"),
        latency_ms: latencyMs,
        metadata: {
          mode,
          connections_found: result.connections_found,
          claims_created: result.claims_created,
          bets_detected: result.bets_detected,
          low_relevance_logged: result.low_relevance_logged,
          errors: result.errors.length,
        },
      });
    } catch {
      // Non-blocking: telemetry failure never blocks discovery
    }
  }
}
