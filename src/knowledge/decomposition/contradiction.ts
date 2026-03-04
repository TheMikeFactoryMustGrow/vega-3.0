import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Neo4jConnection } from "../neo4j.js";
import { EmbeddingPipeline, type SemanticSearchResult } from "../embedding.js";
import { ModelRouter, type RoutingDecision } from "../model-router.js";
import { TelemetryEmitter } from "../../telemetry/emitter.js";

/**
 * ContradictionDetector — Scans for conflicting claims in the knowledge graph
 * and surfaces them as OpenQuestion nodes for review.
 *
 * Two detection modes:
 * 1. On-ingestion: check a new claim against existing graph (cosine > 0.7)
 * 2. Periodic-scan: batch check high-value claims for internal consistency
 *
 * Uses frontier model (via ModelRouter) — contradiction detection is
 * complex multi-source reasoning, never delegated to local models.
 *
 * family_direct claims are NEVER automatically overwritten — contradictions
 * are surfaced as OpenQuestions for Mike's review.
 */

// ── Types ────────────────────────────────────────────────────────────

export const ContradictionSeverity = z.enum(["high", "low"]);
export type ContradictionSeverity = z.infer<typeof ContradictionSeverity>;

export const ContradictionAnalysisSchema = z.object({
  is_contradictory: z.boolean(),
  explanation: z.string(),
  severity: ContradictionSeverity.optional(),
});
export type ContradictionAnalysis = z.infer<typeof ContradictionAnalysisSchema>;

export interface ClaimInfo {
  id: string;
  content: string;
  truth_tier: string;
  domain: string;
  source_id?: string;
}

export interface ContradictionResult {
  contradictions_found: number;
  open_questions_created: number;
  claims_checked: number;
  errors: string[];
}

export interface DetectorOptions {
  connection?: Neo4jConnection;
  embedding?: EmbeddingPipeline | null;
  router?: ModelRouter;
  emitter?: TelemetryEmitter;
  /** Override for testing — inject a function that calls the LLM */
  llmCall?: (prompt: string, systemPrompt: string, routing: RoutingDecision) => Promise<string>;
  /** Cosine similarity threshold for related claims (default: 0.7) */
  similarityThreshold?: number;
}

// ── Prompts ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Knowledge Agent's contradiction detection engine. Your job is to analyze pairs of claims and determine if they contradict each other.

For each pair, assess:
1. is_contradictory: true if the claims are mutually exclusive or directly conflict, false otherwise
2. explanation: Brief explanation of why they contradict (or why they don't)
3. severity: Only include if is_contradictory is true:
   - "high" — same-source contradiction or family_direct claim involved
   - "low" — time-decay contradiction (old claim vs new claim, could be an update)

Rules:
- Claims that are merely different (e.g., different topics) are NOT contradictory
- Claims that complement each other are NOT contradictory
- Claims with different time frames may or may not contradict — assess carefully
- Claims about amounts, dates, or facts that directly conflict ARE contradictory
- Respond with ONLY a JSON object, no markdown fencing, no explanation.`;

function buildContradictionPrompt(claim1: ClaimInfo, claim2: ClaimInfo): string {
  return `Analyze these two claims for contradiction:

Claim 1 (truth_tier: ${claim1.truth_tier}, domain: ${claim1.domain}):
"${claim1.content}"

Claim 2 (truth_tier: ${claim2.truth_tier}, domain: ${claim2.domain}):
"${claim2.content}"

Are these claims contradictory?`;
}

// ── ContradictionDetector ────────────────────────────────────────────

export class ContradictionDetector {
  private readonly connection: Neo4jConnection | null;
  private readonly embedding: EmbeddingPipeline | null;
  private readonly router: ModelRouter;
  private readonly emitter: TelemetryEmitter;
  private readonly llmCall: (prompt: string, systemPrompt: string, routing: RoutingDecision) => Promise<string>;
  private readonly similarityThreshold: number;
  private readonly sessionId: string;

  constructor(options?: DetectorOptions) {
    this.connection = options?.connection ?? null;
    this.embedding = options?.embedding ?? null;
    this.router = options?.router ?? new ModelRouter();
    this.emitter = options?.emitter ?? new TelemetryEmitter();
    this.similarityThreshold = options?.similarityThreshold ?? 0.7;
    this.sessionId = `contradiction-${Date.now()}`;

    this.llmCall = options?.llmCall ?? this.defaultLlmCall.bind(this);
  }

  /**
   * On-ingestion mode: check a new claim against existing related claims.
   * Finds similar claims via vector search (cosine > threshold), then uses
   * frontier model to assess contradiction.
   */
  async checkOnIngestion(claim: ClaimInfo): Promise<ContradictionResult> {
    const start = Date.now();
    const result: ContradictionResult = {
      contradictions_found: 0,
      open_questions_created: 0,
      claims_checked: 0,
      errors: [],
    };

    try {
      // 1. Find related claims via vector similarity
      const relatedClaims = await this.findRelatedClaims(claim);
      result.claims_checked = relatedClaims.length;

      if (relatedClaims.length === 0) {
        await this.emitEvent("on_ingestion", result, Date.now() - start);
        return result;
      }

      // 2. Route to frontier model
      const routing = await this.router.route("contradiction_detection");

      // 3. Check each related claim for contradiction
      for (const related of relatedClaims) {
        try {
          const analysis = await this.analyzeContradiction(claim, related, routing);

          if (analysis.is_contradictory) {
            result.contradictions_found++;

            // Persist to graph if connected
            if (this.connection) {
              await this.createContradiction(claim, related, analysis);
              result.open_questions_created++;
            }
          }
        } catch (err) {
          result.errors.push(`Error checking claim ${related.id}: ${err}`);
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
   * Periodic-scan mode: batch check high-value claims for internal consistency.
   * Checks family_direct and multi_source_verified claims.
   */
  async periodicScan(): Promise<ContradictionResult> {
    const start = Date.now();
    const result: ContradictionResult = {
      contradictions_found: 0,
      open_questions_created: 0,
      claims_checked: 0,
      errors: [],
    };

    if (!this.connection) {
      result.errors.push("No Neo4j connection — cannot run periodic scan");
      return result;
    }

    try {
      // 1. Fetch high-value claims
      const highValueClaims = await this.fetchHighValueClaims();

      if (highValueClaims.length === 0) {
        await this.emitEvent("periodic_scan", result, Date.now() - start);
        return result;
      }

      // 2. Route to frontier model
      const routing = await this.router.route("contradiction_detection");

      // 3. Pairwise comparison (skip already-checked pairs)
      const checkedPairs = new Set<string>();

      for (let i = 0; i < highValueClaims.length; i++) {
        for (let j = i + 1; j < highValueClaims.length; j++) {
          const claim1 = highValueClaims[i];
          const claim2 = highValueClaims[j];

          // Skip if not in the same domain or about different topics
          if (claim1.domain !== claim2.domain) continue;

          const pairKey = [claim1.id, claim2.id].sort().join(":");
          if (checkedPairs.has(pairKey)) continue;
          checkedPairs.add(pairKey);

          result.claims_checked++;

          // Check if already linked by CONTRADICTS
          const alreadyLinked = await this.hasContradictionRelationship(claim1.id, claim2.id);
          if (alreadyLinked) continue;

          try {
            const analysis = await this.analyzeContradiction(claim1, claim2, routing);

            if (analysis.is_contradictory) {
              result.contradictions_found++;
              await this.createContradiction(claim1, claim2, analysis);
              result.open_questions_created++;
            }
          } catch (err) {
            result.errors.push(`Error checking pair ${claim1.id}:${claim2.id}: ${err}`);
          }
        }
      }

      await this.emitEvent("periodic_scan", result, Date.now() - start);
      return result;
    } catch (err) {
      result.errors.push(`Periodic scan failed: ${err}`);
      await this.emitEvent("periodic_scan", result, Date.now() - start, "failure");
      return result;
    }
  }

  /**
   * Analyze whether two claims contradict each other using the frontier model.
   */
  async analyzeContradiction(
    claim1: ClaimInfo,
    claim2: ClaimInfo,
    routing: RoutingDecision,
  ): Promise<ContradictionAnalysis> {
    const userPrompt = buildContradictionPrompt(claim1, claim2);
    const rawResponse = await this.llmCall(userPrompt, SYSTEM_PROMPT, routing);
    return this.parseAnalysis(rawResponse);
  }

  /**
   * Parse the LLM contradiction analysis response.
   * Strips markdown fencing, validates with Zod.
   */
  parseAnalysis(raw: string): ContradictionAnalysis {
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
    return ContradictionAnalysisSchema.parse(parsed);
  }

  /**
   * Find claims related to the given claim via vector similarity search.
   * Returns claims with cosine similarity > threshold (default 0.7).
   */
  private async findRelatedClaims(claim: ClaimInfo): Promise<ClaimInfo[]> {
    if (!this.embedding || !this.connection) return [];

    try {
      const searchResults = await this.embedding.semanticSearch(claim.content, 10);

      // Filter by threshold and exclude the claim itself
      const related = searchResults.filter(
        (r: SemanticSearchResult) => r.score > this.similarityThreshold && r.claimId !== claim.id,
      );

      // Fetch full claim info from Neo4j
      const claims: ClaimInfo[] = [];
      for (const r of related) {
        const info = await this.fetchClaimInfo(r.claimId);
        if (info) claims.push(info);
      }

      return claims;
    } catch {
      return [];
    }
  }

  /**
   * Fetch claim details from Neo4j.
   */
  private async fetchClaimInfo(claimId: string): Promise<ClaimInfo | null> {
    if (!this.connection) return null;

    const session = this.connection.session();
    try {
      const result = await session.run(
        `MATCH (c:Claim {id: $claimId})
         OPTIONAL MATCH (c)-[:SOURCED_FROM]->(s:Source)
         RETURN c.id AS id, c.content AS content, c.truth_tier AS truth_tier,
                c.domain AS domain, s.id AS source_id`,
        { claimId },
      );

      if (result.records.length === 0) return null;

      const record = result.records[0];
      return {
        id: record.get("id") as string,
        content: record.get("content") as string,
        truth_tier: (record.get("truth_tier") as string) ?? "single_source",
        domain: (record.get("domain") as string) ?? "general",
        source_id: record.get("source_id") as string | undefined,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Fetch high-value claims (family_direct and multi_source_verified)
   * for periodic scanning.
   */
  private async fetchHighValueClaims(): Promise<ClaimInfo[]> {
    if (!this.connection) return [];

    const session = this.connection.session();
    try {
      const result = await session.run(
        `MATCH (c:Claim)
         WHERE c.truth_tier IN ['family_direct', 'multi_source_verified']
           AND c.status = 'active'
         OPTIONAL MATCH (c)-[:SOURCED_FROM]->(s:Source)
         RETURN c.id AS id, c.content AS content, c.truth_tier AS truth_tier,
                c.domain AS domain, s.id AS source_id
         ORDER BY c.truth_tier, c.created_at DESC`,
      );

      return result.records.map((record) => ({
        id: record.get("id") as string,
        content: record.get("content") as string,
        truth_tier: (record.get("truth_tier") as string) ?? "single_source",
        domain: (record.get("domain") as string) ?? "general",
        source_id: record.get("source_id") as string | undefined,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Check if two claims already have a CONTRADICTS relationship.
   */
  private async hasContradictionRelationship(claimId1: string, claimId2: string): Promise<boolean> {
    if (!this.connection) return false;

    const session = this.connection.session();
    try {
      const result = await session.run(
        `MATCH (c1:Claim {id: $id1})-[:CONTRADICTS]-(c2:Claim {id: $id2})
         RETURN count(*) AS cnt`,
        { id1: claimId1, id2: claimId2 },
      );

      const cnt = result.records[0]?.get("cnt");
      const count = typeof cnt === "object" && cnt?.toNumber ? cnt.toNumber() : Number(cnt);
      return count > 0;
    } finally {
      await session.close();
    }
  }

  /**
   * Create CONTRADICTS relationship and OpenQuestion node for a detected contradiction.
   *
   * - CONTRADICTS relationship between the two Claims
   * - OpenQuestion node with conflict description
   * - INVOLVES relationships from OpenQuestion to both Claims
   * - Priority: 'high' if family_direct involved, 'medium' otherwise
   * - Severity: same-source = 'high', cross-source = 'medium', time-decay = 'low'
   */
  private async createContradiction(
    claim1: ClaimInfo,
    claim2: ClaimInfo,
    analysis: ContradictionAnalysis,
  ): Promise<void> {
    if (!this.connection) return;

    const priority = this.determinePriority(claim1, claim2);
    const severity = this.determineSeverity(claim1, claim2, analysis);
    const questionId = `oq-${randomUUID()}`;

    const session = this.connection.session();
    try {
      await session.run(
        `MATCH (c1:Claim {id: $claim1Id}), (c2:Claim {id: $claim2Id})
         MERGE (c1)-[:CONTRADICTS]->(c2)
         CREATE (oq:OpenQuestion {
           id: $questionId,
           question: $question,
           domain: $domain,
           priority: $priority,
           severity: $severity,
           raised_by: 'knowledge_agent',
           status: 'open',
           explanation: $explanation,
           created_at: datetime()
         })
         CREATE (oq)-[:INVOLVES]->(c1)
         CREATE (oq)-[:INVOLVES]->(c2)`,
        {
          claim1Id: claim1.id,
          claim2Id: claim2.id,
          questionId,
          question: `Contradiction detected: "${claim1.content}" vs "${claim2.content}"`,
          domain: claim1.domain,
          priority,
          severity,
          explanation: analysis.explanation,
        },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Determine priority based on truth tier hierarchy.
   * family_direct involved → 'high', otherwise 'medium'.
   */
  private determinePriority(claim1: ClaimInfo, claim2: ClaimInfo): string {
    if (claim1.truth_tier === "family_direct" || claim2.truth_tier === "family_direct") {
      return "high";
    }
    return "medium";
  }

  /**
   * Determine contradiction severity.
   * - same-source: both claims from same source → 'high'
   * - cross-source: claims from different sources → 'medium'
   * - time-decay: LLM flagged as 'low' (old vs new claim)
   */
  private determineSeverity(
    claim1: ClaimInfo,
    claim2: ClaimInfo,
    analysis: ContradictionAnalysis,
  ): string {
    // If LLM assessed severity, use it
    if (analysis.severity) return analysis.severity;

    // Same source → high severity
    if (claim1.source_id && claim2.source_id && claim1.source_id === claim2.source_id) {
      return "high";
    }

    // Cross source → medium
    return "medium";
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
        temperature: 0.1,
        max_tokens: 1024,
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
    result: ContradictionResult,
    latencyMs: number,
    outcome?: "success" | "failure" | "partial" | "skipped",
  ): Promise<void> {
    try {
      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_write",
        event_subtype: "contradiction_detection",
        session_id: this.sessionId,
        outcome: outcome ?? (result.errors.length === 0 ? "success" : "partial"),
        latency_ms: latencyMs,
        metadata: {
          mode,
          contradictions_found: result.contradictions_found,
          open_questions_created: result.open_questions_created,
          claims_checked: result.claims_checked,
          errors: result.errors.length,
        },
      });
    } catch {
      // Non-blocking: telemetry failure never blocks detection
    }
  }
}
