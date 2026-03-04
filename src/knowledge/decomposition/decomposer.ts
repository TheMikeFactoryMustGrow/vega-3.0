import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Neo4jConnection } from "../neo4j.js";
import { EmbeddingPipeline } from "../embedding.js";
import { ModelRouter, type RoutingDecision } from "../model-router.js";
import { TelemetryEmitter } from "../../telemetry/emitter.js";

/**
 * ClaimDecomposer — Decomposes unstructured text (meeting notes, journal entries,
 * voice memo transcripts) into atomic, verifiable claims linked to entities.
 *
 * Uses frontier model (via ModelRouter) — claim decomposition is complex reasoning,
 * never delegated to local models.
 *
 * Deduplication: checks embedding cosine similarity against existing claims.
 * Similarity > 0.95 = potential duplicate, flagged for review.
 */

// ── Types ────────────────────────────────────────────────────────────

export const DomainClassification = z.enum([
  "gix",
  "we",
  "personal_finance",
  "health",
  "family",
  "legal",
  "general",
]);
export type DomainClassification = z.infer<typeof DomainClassification>;

export const EntityTypeEnum = z.enum([
  "person",
  "organization",
  "financial_instrument",
  "property",
  "concept",
]);
export type EntityTypeEnum = z.infer<typeof EntityTypeEnum>;

export const TruthTierEnum = z.enum([
  "family_direct",
  "multi_source_verified",
  "single_source",
  "agent_inferred",
]);
export type TruthTierEnum = z.infer<typeof TruthTierEnum>;

export const ExtractedEntitySchema = z.object({
  name: z.string(),
  type: EntityTypeEnum,
});
export type ExtractedEntity = z.infer<typeof ExtractedEntitySchema>;

export const DecomposedClaimSchema = z.object({
  content: z.string(),
  entities: z.array(ExtractedEntitySchema),
  truth_tier: TruthTierEnum,
  truth_score_estimate: z.number().min(0).max(1),
  domain_classification: DomainClassification,
});
export type DecomposedClaim = z.infer<typeof DecomposedClaimSchema>;

export interface DecompositionResult {
  claims: DecomposedClaim[];
  source_id: string;
  duplicates_flagged: number;
  claims_created: number;
  entities_created: number;
  embeddings_generated: number;
  errors: string[];
}

export interface DecomposerOptions {
  connection?: Neo4jConnection;
  embedding?: EmbeddingPipeline | null;
  router?: ModelRouter;
  emitter?: TelemetryEmitter;
  /** Override for testing — inject a function that calls the LLM */
  llmCall?: (prompt: string, systemPrompt: string, routing: RoutingDecision) => Promise<string>;
  /** Cosine similarity threshold for deduplication (default: 0.95) */
  deduplicationThreshold?: number;
}

// ── Decomposition Prompt ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Knowledge Agent's claim decomposition engine. Your job is to take unstructured text and decompose it into atomic, verifiable claims.

For each claim you extract, provide:
1. content: A single, atomic, verifiable statement in natural language
2. entities: Array of entities mentioned (name and type). Types: person, organization, financial_instrument, property, concept
3. truth_tier: Based on source context:
   - "family_direct" — text attributed to Mike or Lindsay Lingle (truth_score >= 0.95)
   - "multi_source_verified" — text from verified documents or multiple sources
   - "single_source" — single mention from a single source
   - "agent_inferred" — inference made by the agent, not directly stated
4. truth_score_estimate: 0.0-1.0 confidence in the claim's truth
5. domain_classification: One of: gix, we, personal_finance, health, family, legal, general

Rules:
- Each claim must be ATOMIC — one fact per claim
- Identify ALL entities mentioned: people, companies, financial instruments, properties, concepts
- Family members (Mike, Lindsay, Harrison, Beckham) get "family_direct" truth_tier with truth_score >= 0.95
- Statements from verified documents get "multi_source_verified"
- Single mentions from conversations get "single_source"
- Your own inferences get "agent_inferred" with lower truth_scores
- Do NOT merge multiple facts into one claim
- Do NOT include meta-commentary about the text itself

Respond with ONLY a JSON array of claims, no markdown fencing, no explanation.`;

function buildUserPrompt(text: string, sourceContext?: string): string {
  let prompt = `Decompose the following text into atomic claims:\n\n${text}`;
  if (sourceContext) {
    prompt += `\n\nSource context: ${sourceContext}`;
  }
  return prompt;
}

// ── ClaimDecomposer ──────────────────────────────────────────────────

export class ClaimDecomposer {
  private readonly connection: Neo4jConnection | null;
  private readonly embedding: EmbeddingPipeline | null;
  private readonly router: ModelRouter;
  private readonly emitter: TelemetryEmitter;
  private readonly llmCall: (prompt: string, systemPrompt: string, routing: RoutingDecision) => Promise<string>;
  private readonly deduplicationThreshold: number;
  private readonly sessionId: string;

  constructor(options?: DecomposerOptions) {
    this.connection = options?.connection ?? null;
    this.embedding = options?.embedding ?? null;
    this.router = options?.router ?? new ModelRouter();
    this.emitter = options?.emitter ?? new TelemetryEmitter();
    this.deduplicationThreshold = options?.deduplicationThreshold ?? 0.95;
    this.sessionId = `decomposer-${Date.now()}`;

    this.llmCall = options?.llmCall ?? this.defaultLlmCall.bind(this);
  }

  /**
   * Decompose unstructured text into atomic claims.
   * Returns structured claims with entity extraction, truth tier assignment, and domain classification.
   */
  async decompose(
    text: string,
    options?: { sourceContext?: string; sourceType?: string; sourcePath?: string },
  ): Promise<DecompositionResult> {
    const start = Date.now();
    const result: DecompositionResult = {
      claims: [],
      source_id: "",
      duplicates_flagged: 0,
      claims_created: 0,
      entities_created: 0,
      embeddings_generated: 0,
      errors: [],
    };

    try {
      // 1. Route to frontier model (claim_decomposition is always frontier)
      const routing = await this.router.route("claim_decomposition");

      // 2. Call LLM for decomposition
      const userPrompt = buildUserPrompt(text, options?.sourceContext);
      const rawResponse = await this.llmCall(userPrompt, SYSTEM_PROMPT, routing);

      // 3. Parse and validate the response
      const claims = this.parseResponse(rawResponse);
      result.claims = claims;

      // 4. If we have a Neo4j connection, persist claims to the graph
      if (this.connection) {
        // Create Source node
        const sourceId = `source-decomposition-${randomUUID()}`;
        result.source_id = sourceId;
        await this.createSourceNode(sourceId, text, options);

        for (const claim of claims) {
          const claimId = `claim-${randomUUID()}`;

          // Check for duplicates via embedding similarity
          let isDuplicate = false;
          if (this.embedding) {
            isDuplicate = await this.checkDuplicate(claim.content);
            if (isDuplicate) {
              result.duplicates_flagged++;
              continue; // Skip creating duplicate claims
            }
          }

          // Create Claim node and link to Source
          await this.createClaimNode(claimId, claim, sourceId);
          result.claims_created++;

          // Create Entity nodes and link to Claim
          for (const entity of claim.entities) {
            await this.createEntityNode(entity, claimId);
            result.entities_created++;
          }

          // Generate embedding
          if (this.embedding) {
            try {
              const embedResult = await this.embedding.embedAndStore(claimId, claim.content);
              if (embedResult.success) {
                result.embeddings_generated++;
              }
            } catch {
              result.errors.push(`Embedding failed for claim ${claimId}`);
            }
          }
        }
      } else {
        result.source_id = `source-decomposition-${randomUUID()}`;
      }

      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_write",
        event_subtype: "claim_decomposition",
        session_id: this.sessionId,
        model_used: routing.model,
        outcome: result.errors.length === 0 ? "success" : "partial",
        latency_ms: Date.now() - start,
        metadata: {
          claims_extracted: claims.length,
          claims_created: result.claims_created,
          duplicates_flagged: result.duplicates_flagged,
          entities_created: result.entities_created,
          embeddings_generated: result.embeddings_generated,
          input_length: text.length,
        },
      });

      return result;
    } catch (err) {
      result.errors.push(`Decomposition failed: ${err}`);

      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_write",
        event_subtype: "claim_decomposition",
        session_id: this.sessionId,
        outcome: "failure",
        latency_ms: Date.now() - start,
        metadata: { error: String(err), input_length: text.length },
      });

      return result;
    }
  }

  /**
   * Parse the LLM response into validated DecomposedClaim objects.
   * Handles JSON arrays, strips markdown fencing, and validates with Zod.
   */
  parseResponse(raw: string): DecomposedClaim[] {
    // Strip markdown code fencing if present
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

    const claims: DecomposedClaim[] = [];
    for (const item of parsed) {
      try {
        claims.push(DecomposedClaimSchema.parse(item));
      } catch (err) {
        // Log validation error but continue with other claims
        console.error(`[ClaimDecomposer] Skipping invalid claim: ${err}`);
      }
    }

    return claims;
  }

  /**
   * Check if a claim is a potential duplicate by comparing embedding
   * cosine similarity against existing claims.
   * Returns true if similarity > threshold (default 0.95).
   */
  private async checkDuplicate(content: string): Promise<boolean> {
    if (!this.embedding) return false;

    try {
      const results = await this.embedding.semanticSearch(content, 1);
      if (results.length > 0 && results[0].score > this.deduplicationThreshold) {
        return true;
      }
    } catch {
      // Non-blocking: deduplication failure doesn't prevent claim creation
    }

    return false;
  }

  /**
   * Create a Source node for the decomposed text.
   */
  private async createSourceNode(
    sourceId: string,
    text: string,
    options?: { sourceType?: string; sourcePath?: string },
  ): Promise<void> {
    if (!this.connection) return;

    const session = this.connection.session();
    try {
      await session.run(
        `CREATE (s:Source {
           id: $sourceId,
           source_type: $sourceType,
           source_account: 'knowledge_agent',
           raw_text: $rawText,
           file_path: $filePath,
           credibility_weight: 0.7,
           captured_date: datetime(),
           created_at: datetime()
         })`,
        {
          sourceId,
          sourceType: options?.sourceType ?? "unstructured_text",
          rawText: text.slice(0, 5000), // Limit stored raw text
          filePath: options?.sourcePath ?? null,
        },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Create a Claim node and link to its Source via SOURCED_FROM.
   */
  private async createClaimNode(
    claimId: string,
    claim: DecomposedClaim,
    sourceId: string,
  ): Promise<void> {
    if (!this.connection) return;

    const session = this.connection.session();
    try {
      await session.run(
        `CREATE (c:Claim {
           id: $claimId,
           content: $content,
           truth_tier: $truthTier,
           truth_score: $truthScore,
           domain: $domain,
           status: 'active',
           decomposed: true,
           created_at: datetime(),
           updated_at: datetime()
         })
         WITH c
         MATCH (s:Source {id: $sourceId})
         MERGE (c)-[:SOURCED_FROM]->(s)`,
        {
          claimId,
          content: claim.content,
          truthTier: claim.truth_tier,
          truthScore: claim.truth_score_estimate,
          domain: claim.domain_classification,
          sourceId,
        },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Create or merge an Entity node and link to a Claim via ABOUT.
   */
  private async createEntityNode(
    entity: ExtractedEntity,
    claimId: string,
  ): Promise<void> {
    if (!this.connection) return;

    const session = this.connection.session();
    try {
      await session.run(
        `MERGE (e:Entity {name: $name, entity_type: $entityType})
         ON CREATE SET
           e.id = $entityId,
           e.domain = 'general',
           e.created_at = datetime(),
           e.updated_at = datetime()
         ON MATCH SET
           e.updated_at = datetime()
         WITH e
         MATCH (c:Claim {id: $claimId})
         MERGE (c)-[:ABOUT]->(e)`,
        {
          name: entity.name,
          entityType: entity.type,
          entityId: `entity-${entity.name.toLowerCase().replace(/\s+/g, "-")}-${entity.type}`,
          claimId,
        },
      );
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
}
