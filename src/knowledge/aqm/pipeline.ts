/**
 * AQM Pipeline Orchestrator
 *
 * Orchestrates the full Agentic Query Mode pipeline:
 *   1. Query Classification — determines if AQM or simple retrieval is needed
 *   2. Stage 1: Schema Inspection — discovers relevant graph schema
 *   3. Stage 2: Structured Query Construction — generates parameterized Cypher
 *   4. Stage 3: Precision Reranking — scores and reranks by trust + recency
 *   5. Stage 4: Grounded Synthesis — produces cited answer with inference chains
 *   Fallback: vector similarity search when AQM fails
 */

import type { Neo4jConnection } from "../neo4j.js";
import type { ModelRouter, RoutingDecision } from "../model-router.js";
import type { EmbeddingPipeline, SemanticSearchResult } from "../embedding.js";
import type { TelemetryEmitter } from "../../telemetry/emitter.js";
import {
  SchemaInspector,
  type SchemaContext,
  type SchemaInspectorOptions,
} from "./schema-inspector.js";
import {
  QueryConstructor,
  type ConstructedQuery,
  type QueryConstructorOptions,
  type QueryConstructionResult,
} from "./query-constructor.js";
import { Reranker, type RerankResult, type RerankerOptions } from "./reranker.js";
import {
  Synthesizer,
  type SynthesisResult,
  type SynthesizerOptions,
} from "./synthesizer.js";
import { randomUUID } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────

export type QueryClassification = "aqm" | "simple";

export interface AQMPipelineOptions {
  connection?: Neo4jConnection;
  router?: ModelRouter;
  embedding?: EmbeddingPipeline | null;
  emitter?: TelemetryEmitter;
  /** Override for testing — inject a function that calls the LLM */
  llmCall?: (
    prompt: string,
    systemPrompt: string,
    routing: RoutingDecision,
  ) => Promise<string>;
  /** Override for testing — inject custom schema inspector */
  schemaInspector?: SchemaInspector;
  /** Override for testing — inject custom query constructor */
  queryConstructor?: QueryConstructor;
  /** Override for testing — inject custom reranker */
  reranker?: Reranker;
  /** Override for testing — inject custom synthesizer */
  synthesizer?: Synthesizer;
}

export interface AQMStage1Result {
  schemaContext: SchemaContext;
}

export interface AQMStage2Result {
  constructionResult: QueryConstructionResult;
  queryResults: Record<string, unknown>[] | null;
}

export interface AQMStage3Result {
  rerankResult: RerankResult;
}

export interface AQMStage4Result {
  synthesisResult: SynthesisResult;
}

export interface AQMPipelineResult {
  classification: QueryClassification;
  stage1?: AQMStage1Result;
  stage2?: AQMStage2Result;
  stage3?: AQMStage3Result;
  stage4?: AQMStage4Result;
  /** Full pipeline answer (from Stage 4 synthesis) */
  answer?: string;
  /** Citations from synthesis */
  citations?: SynthesisResult["citations"];
  /** Gaps from reranking + synthesis */
  gaps?: string[];
  /** Overall confidence from synthesis */
  confidence?: number;
  /** Cypher query used */
  queryUsed?: string;
  simpleResults?: SemanticSearchResult[];
  fallbackUsed: boolean;
  error?: string;
  timing: {
    classification_ms: number;
    stage1_ms?: number;
    stage2_ms?: number;
    stage3_ms?: number;
    stage4_ms?: number;
    total_ms: number;
  };
}

// ── Query Classifier ───────────────────────────────────────────────────────

/**
 * Classify whether a question needs AQM (complex, multi-entity) or
 * simple retrieval (single entity lookup, keyword search).
 */
export function classifyQuery(question: string): QueryClassification {
  const q = question.toLowerCase();

  // AQM indicators — check FIRST since complex questions may start with "what is"
  const aqmIndicators = [
    "total exposure",
    "interest rate risk",
    "across",
    "all my",
    "every",
    "aggregate",
    "combined",
    "cascading",
    "chain effect",
    "what happens if",
    "impact of",
    "how has",
    "changed over",
    "trend",
    "compare",
    "relationship between",
    "connected to",
    "related to",
    "how many",
    "concentration",
    "diversif",
    "portfolio",
    "overlap",
    "contradiction",
    "inconsisten",
  ];

  for (const indicator of aqmIndicators) {
    if (q.includes(indicator)) {
      return "aqm";
    }
  }

  // Multi-entity questions (contains multiple proper-noun-like words)
  // Skip the first word (often capitalized just because it starts a sentence)
  const withoutFirstWord = question.replace(/^\S+\s+/, "");
  const properNouns = withoutFirstWord.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
  if (properNouns && properNouns.length >= 2) {
    return "aqm";
  }

  // Questions with "and" connecting multiple concepts
  if (/\band\b.*\band\b/i.test(q)) {
    return "aqm";
  }

  // Simple retrieval indicators — direct entity lookups, single-fact questions
  // Checked AFTER AQM indicators so "What is my total exposure..." routes to AQM
  const simplePatterns = [
    /^who is\s/,
    /^what is\s/,
    /^where is\s/,
    /^when was\s/,
    /^tell me about\s/,
    /^describe\s/,
    /^show me\s(?!.*(?:all|every|across|total))/,
    /^what does\s.*\s(?:do|mean)\??$/,
  ];

  for (const pattern of simplePatterns) {
    if (pattern.test(q)) {
      return "simple";
    }
  }

  // Default: simple for short questions, aqm for longer analytical ones
  return q.split(/\s+/).length > 12 ? "aqm" : "simple";
}

// ── Pipeline Orchestrator ──────────────────────────────────────────────────

export class AQMPipeline {
  private readonly connection: Neo4jConnection | null;
  private readonly router: ModelRouter | null;
  private readonly embedding: EmbeddingPipeline | null;
  private readonly emitter: TelemetryEmitter | null;
  private readonly schemaInspector: SchemaInspector;
  private readonly queryConstructor: QueryConstructor;
  private readonly reranker: Reranker;
  private readonly synthesizer: Synthesizer;
  private readonly sessionId: string;

  constructor(options?: AQMPipelineOptions) {
    this.connection = options?.connection ?? null;
    this.router = options?.router ?? null;
    this.embedding = options?.embedding ?? null;
    this.emitter = options?.emitter ?? null;
    this.sessionId = randomUUID();

    // Allow injecting custom instances for testing
    this.schemaInspector =
      options?.schemaInspector ??
      new SchemaInspector({
        connection: this.connection ?? undefined,
        emitter: this.emitter ?? undefined,
      } as SchemaInspectorOptions);

    this.queryConstructor =
      options?.queryConstructor ??
      new QueryConstructor({
        connection: this.connection ?? undefined,
        router: this.router ?? undefined,
        emitter: this.emitter ?? undefined,
        llmCall: options?.llmCall,
      } as QueryConstructorOptions);

    this.reranker =
      options?.reranker ??
      new Reranker({
        emitter: this.emitter ?? undefined,
      } as RerankerOptions);

    this.synthesizer =
      options?.synthesizer ??
      new Synthesizer({
        router: this.router ?? undefined,
        emitter: this.emitter ?? undefined,
        llmCall: options?.llmCall,
      } as SynthesizerOptions);
  }

  /**
   * Run the full AQM pipeline (Stages 1-4) for a question.
   * Returns classification, all stage results, answer, citations, gaps, confidence, and timing.
   */
  async query(question: string): Promise<AQMPipelineResult> {
    const totalStart = Date.now();

    // Step 1: Classify the question
    const classifyStart = Date.now();
    const classification = classifyQuery(question);
    const classificationMs = Date.now() - classifyStart;

    await this.emitEvent("aqm_classification", "success", {
      question,
      classification,
      latency_ms: classificationMs,
    });

    // Simple retrieval — use vector search
    if (classification === "simple") {
      const simpleResults = await this.simpleRetrieval(question);
      return {
        classification,
        simpleResults,
        fallbackUsed: false,
        timing: {
          classification_ms: classificationMs,
          total_ms: Date.now() - totalStart,
        },
      };
    }

    // AQM pipeline — Stages 1-4
    // Stage 1: Schema Inspection
    const stage1Start = Date.now();
    const schemaContext =
      await this.schemaInspector.inspectForQuestion(question);
    const stage1Ms = Date.now() - stage1Start;

    // Stage 2: Query Construction
    const stage2Start = Date.now();
    const constructionResult = await this.queryConstructor.construct(
      question,
      schemaContext,
    );
    const stage2Ms = Date.now() - stage2Start;

    // Execute the constructed query
    let queryResults: Record<string, unknown>[] | null = null;
    let fallbackUsed = false;

    if (constructionResult.query && constructionResult.validated) {
      queryResults = await this.executeQuery(constructionResult.query);
    } else if (constructionResult.query && !constructionResult.validated) {
      // Query was constructed but failed validation — try executing anyway
      // (EXPLAIN may fail on valid queries if parameters are complex)
      queryResults = await this.executeQuery(constructionResult.query);
      if (queryResults === null) {
        // Execution failed too — fall back to vector search
        fallbackUsed = true;
        const fallbackResults = await this.simpleRetrieval(question);
        await this.emitEvent("aqm_fallback_to_vector", "partial", {
          question,
          reason: constructionResult.validationError,
          latency_ms: Date.now() - totalStart,
        });

        return {
          classification,
          stage1: { schemaContext },
          stage2: { constructionResult, queryResults: null },
          simpleResults: fallbackResults,
          fallbackUsed: true,
          error: constructionResult.validationError,
          timing: {
            classification_ms: classificationMs,
            stage1_ms: stage1Ms,
            stage2_ms: stage2Ms,
            total_ms: Date.now() - totalStart,
          },
        };
      }
    } else {
      // No query constructed — fall back to vector search
      fallbackUsed = true;
      const fallbackResults = await this.simpleRetrieval(question);

      await this.emitEvent("aqm_fallback_to_vector", "partial", {
        question,
        reason: constructionResult.validationError ?? "Query construction failed",
        latency_ms: Date.now() - totalStart,
      });

      return {
        classification,
        stage1: { schemaContext },
        stage2: { constructionResult, queryResults: null },
        simpleResults: fallbackResults,
        fallbackUsed: true,
        error:
          constructionResult.validationError ?? "Query construction failed",
        timing: {
          classification_ms: classificationMs,
          stage1_ms: stage1Ms,
          stage2_ms: stage2Ms,
          total_ms: Date.now() - totalStart,
        },
      };
    }

    // Stage 3: Precision Reranking
    const stage3Start = Date.now();
    const rerankResult = await this.reranker.rerank({
      queryResults: queryResults ?? [],
      question,
      knownDomains: this.extractKnownDomains(schemaContext),
      knownEntityTypes: this.extractKnownEntityTypes(schemaContext),
    });
    const stage3Ms = Date.now() - stage3Start;

    // Stage 4: Grounded Synthesis
    const stage4Start = Date.now();
    const synthesisResult = await this.synthesizer.synthesize({
      question,
      rankedResults: rerankResult.ranked,
      gaps: rerankResult.gaps,
      queryUsed: constructionResult.query?.cypher,
    });
    const stage4Ms = Date.now() - stage4Start;

    await this.emitEvent("aqm_pipeline_complete", "success", {
      question,
      pattern: constructionResult.query?.pattern,
      result_count: queryResults?.length ?? 0,
      reranked_count: rerankResult.ranked.length,
      gap_count: synthesisResult.gaps.length,
      confidence: synthesisResult.confidence,
      fallback_used: fallbackUsed,
      latency_ms: Date.now() - totalStart,
    });

    return {
      classification,
      stage1: { schemaContext },
      stage2: { constructionResult, queryResults },
      stage3: { rerankResult },
      stage4: { synthesisResult },
      answer: synthesisResult.answer,
      citations: synthesisResult.citations,
      gaps: synthesisResult.gaps,
      confidence: synthesisResult.confidence,
      queryUsed: constructionResult.query?.cypher,
      fallbackUsed,
      timing: {
        classification_ms: classificationMs,
        stage1_ms: stage1Ms,
        stage2_ms: stage2Ms,
        stage3_ms: stage3Ms,
        stage4_ms: stage4Ms,
        total_ms: Date.now() - totalStart,
      },
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Execute a constructed Cypher query against Neo4j.
   */
  private async executeQuery(
    query: ConstructedQuery,
  ): Promise<Record<string, unknown>[] | null> {
    if (!this.connection) return null;

    const session = this.connection.session();
    try {
      const result = await session.run(query.cypher, query.parameters);
      return result.records.map((record) => {
        const obj: Record<string, unknown> = {};
        for (const key of record.keys) {
          const val = record.get(key);
          // Convert Neo4j integers
          if (typeof val === "object" && val !== null && val.toNumber) {
            obj[key as string] = val.toNumber();
          } else if (
            typeof val === "object" &&
            val !== null &&
            val.properties
          ) {
            obj[key as string] = val.properties;
          } else {
            obj[key as string] = val;
          }
        }
        return obj;
      });
    } catch (error) {
      await this.emitEvent("aqm_query_execution_error", "failure", {
        cypher: query.cypher,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      await session.close();
    }
  }

  /**
   * Fall back to vector similarity search for simple retrieval.
   */
  private async simpleRetrieval(
    question: string,
  ): Promise<SemanticSearchResult[]> {
    if (!this.embedding) return [];
    try {
      return await this.embedding.semanticSearch(question, 10);
    } catch {
      return [];
    }
  }

  /**
   * Extract known domains from schema sample data.
   */
  private extractKnownDomains(schema: SchemaContext): string[] {
    const domains = new Set<string>();
    for (const samples of Object.values(schema.sampleData)) {
      for (const sample of samples) {
        const domain = sample.domain as string;
        if (domain) domains.add(domain);
      }
    }
    return [...domains];
  }

  /**
   * Extract known entity types from schema sample data.
   */
  private extractKnownEntityTypes(schema: SchemaContext): string[] {
    const types = new Set<string>();
    for (const samples of Object.values(schema.sampleData)) {
      for (const sample of samples) {
        const entityType = sample.entity_type as string;
        if (entityType) types.add(entityType);
      }
    }
    return [...types];
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

// Re-export types for convenience
export type { SchemaContext } from "./schema-inspector.js";
export type {
  ConstructedQuery,
  QueryPattern,
  QueryConstructionResult,
} from "./query-constructor.js";
export type { RankedResult, RerankResult, GapInfo } from "./reranker.js";
export type {
  SynthesisResult,
  Citation,
  InferenceStep,
} from "./synthesizer.js";
