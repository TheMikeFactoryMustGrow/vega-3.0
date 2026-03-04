import OpenAI from "openai";
import { Neo4jConnection } from "./neo4j.js";
import { TelemetryEmitter } from "../telemetry/emitter.js";

/**
 * EmbeddingPipeline — Generates OpenAI text-embedding-3-small vectors
 * and stores them in Neo4j's native vector index for semantic search.
 *
 * Environment variables:
 *   OPENAI_API_KEY (required)
 *   EMBEDDING_BASE_URL (default: https://api.openai.com/v1)
 *   EMBEDDING_MODEL (default: text-embedding-3-small)
 *
 * Non-blocking: embedding failures never block claim creation.
 * Claims are created without embeddings and flagged for retry.
 */

export interface EmbeddingResult {
  embedding: Float32Array;
  tokens_used: number;
}

export interface SemanticSearchResult {
  claimId: string;
  content: string;
  score: number;
}

export interface EmbedAndStoreResult {
  success: boolean;
  tokens_used: number;
  error?: string;
}

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;

export class EmbeddingPipeline {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly emitter: TelemetryEmitter;
  private readonly sessionId: string;

  constructor(
    private readonly connection: Neo4jConnection,
    options?: {
      apiKey?: string;
      baseURL?: string;
      model?: string;
      emitter?: TelemetryEmitter;
    },
  ) {
    const apiKey = options?.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required (set via options or environment variable)");
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: options?.baseURL ?? process.env.EMBEDDING_BASE_URL ?? "https://api.openai.com/v1",
    });

    this.model = options?.model ?? process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
    this.emitter = options?.emitter ?? new TelemetryEmitter();
    this.sessionId = `embedding-${Date.now()}`;
  }

  /**
   * Generate embedding for a single text string.
   * Returns a 1536-dimensional Float32Array.
   */
  async embed(text: string): Promise<EmbeddingResult> {
    return this.embedWithRetry([text]).then((results) => results[0]);
  }

  /**
   * Generate embeddings for multiple texts in a single API call.
   * OpenAI supports up to 2048 inputs per request.
   */
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];
    return this.embedWithRetry(texts);
  }

  /**
   * Store an embedding on a Claim node in Neo4j.
   * Uses parameterized Cypher for safety.
   */
  async storeEmbedding(claimId: string, embedding: Float32Array): Promise<void> {
    const session = this.connection.session();
    try {
      await session.run(
        `MATCH (c:Claim {id: $claimId})
         SET c.embedding = $embedding, c.embedding_updated_at = datetime()`,
        { claimId, embedding: Array.from(embedding) },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Embed text and store on a Claim node — non-blocking.
   * If embedding fails, the claim is NOT affected — it remains without an embedding.
   */
  async embedAndStore(claimId: string, content: string): Promise<EmbedAndStoreResult> {
    const start = Date.now();
    try {
      const result = await this.embed(content);
      await this.storeEmbedding(claimId, result.embedding);

      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_write",
        event_subtype: "embedding_store",
        session_id: this.sessionId,
        outcome: "success",
        latency_ms: Date.now() - start,
        metadata: { claimId, tokens_used: result.tokens_used },
      });

      return { success: true, tokens_used: result.tokens_used };
    } catch (err) {
      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_write",
        event_subtype: "embedding_store",
        session_id: this.sessionId,
        outcome: "failure",
        latency_ms: Date.now() - start,
        metadata: { claimId, error: String(err) },
      });

      // Non-blocking: flag for retry but never throw
      await this.flagForRetry(claimId, String(err));
      return { success: false, tokens_used: 0, error: String(err) };
    }
  }

  /**
   * Re-embed a Claim by reading its current content from Neo4j,
   * generating a new embedding, and updating the stored vector.
   */
  async reembed(claimId: string): Promise<EmbedAndStoreResult> {
    const start = Date.now();
    const session = this.connection.session();
    try {
      const result = await session.run(
        `MATCH (c:Claim {id: $claimId}) RETURN c.content AS content`,
        { claimId },
      );

      if (result.records.length === 0) {
        return { success: false, tokens_used: 0, error: `Claim ${claimId} not found` };
      }

      const content = result.records[0].get("content") as string;
      if (!content) {
        return { success: false, tokens_used: 0, error: `Claim ${claimId} has no content` };
      }

      const embedResult = await this.embed(content);
      await this.storeEmbedding(claimId, embedResult.embedding);

      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_write",
        event_subtype: "embedding_reembed",
        session_id: this.sessionId,
        outcome: "success",
        latency_ms: Date.now() - start,
        metadata: { claimId, tokens_used: embedResult.tokens_used },
      });

      return { success: true, tokens_used: embedResult.tokens_used };
    } catch (err) {
      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_write",
        event_subtype: "embedding_reembed",
        session_id: this.sessionId,
        outcome: "failure",
        latency_ms: Date.now() - start,
        metadata: { claimId, error: String(err) },
      });

      return { success: false, tokens_used: 0, error: String(err) };
    } finally {
      await session.close();
    }
  }

  /**
   * Semantic search — generate embedding for query, then run vector
   * similarity search against the claim_embeddings index.
   */
  async semanticSearch(query: string, topK: number = 5): Promise<SemanticSearchResult[]> {
    const start = Date.now();
    try {
      const { embedding } = await this.embed(query);

      const session = this.connection.session();
      try {
        const result = await session.run(
          `CALL db.index.vector.queryNodes('claim_embeddings', $topK, $embedding)
           YIELD node, score
           RETURN node.id AS claimId, node.content AS content, score
           ORDER BY score DESC`,
          { topK: Number(topK), embedding: Array.from(embedding) },
        );

        const results: SemanticSearchResult[] = result.records.map((r) => ({
          claimId: r.get("claimId") as string,
          content: r.get("content") as string,
          score: r.get("score") as number,
        }));

        await this.emitter.emit({
          agent_name: "knowledge_agent",
          event_type: "knowledge_query",
          event_subtype: "semantic_search",
          session_id: this.sessionId,
          outcome: "success",
          latency_ms: Date.now() - start,
          metadata: { query, topK, resultCount: results.length },
        });

        return results;
      } finally {
        await session.close();
      }
    } catch (err) {
      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_query",
        event_subtype: "semantic_search",
        session_id: this.sessionId,
        outcome: "failure",
        latency_ms: Date.now() - start,
        metadata: { query, error: String(err) },
      });

      return [];
    }
  }

  /**
   * Flag a claim for embedding retry by setting a property on the node.
   */
  private async flagForRetry(claimId: string, error: string): Promise<void> {
    const session = this.connection.session();
    try {
      await session.run(
        `MATCH (c:Claim {id: $claimId})
         SET c.embedding_pending = true, c.embedding_error = $error`,
        { claimId, error },
      );
    } catch {
      // Non-blocking: even flagging failures don't propagate
    } finally {
      await session.close();
    }
  }

  /**
   * Embed texts with exponential backoff retry (max 3 attempts).
   */
  private async embedWithRetry(texts: string[]): Promise<EmbeddingResult[]> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const start = Date.now();
      try {
        const response = await this.client.embeddings.create({
          model: this.model,
          input: texts,
        });

        const totalTokens = response.usage?.total_tokens ?? 0;

        await this.emitter.emit({
          agent_name: "knowledge_agent",
          event_type: "model_call",
          event_subtype: "embedding_generate",
          session_id: this.sessionId,
          model_used: this.model,
          outcome: "success",
          latency_ms: Date.now() - start,
          metadata: { tokens_used: totalTokens, input_count: texts.length, attempt },
        });

        return response.data.map((item) => ({
          embedding: new Float32Array(item.embedding),
          tokens_used: Math.ceil(totalTokens / texts.length),
        }));
      } catch (err) {
        lastError = err;

        await this.emitter.emit({
          agent_name: "knowledge_agent",
          event_type: "model_call",
          event_subtype: "embedding_generate",
          session_id: this.sessionId,
          model_used: this.model,
          outcome: "failure",
          latency_ms: Date.now() - start,
          metadata: { error: String(err), attempt, input_count: texts.length },
        });

        if (attempt < MAX_RETRIES - 1) {
          const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
    }

    throw lastError;
  }
}
