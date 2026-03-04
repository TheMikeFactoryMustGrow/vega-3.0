/**
 * AQM Stage 3 — Precision Reranking
 *
 * Scores and reranks query results using a composite formula:
 *   score = (semantic_similarity × 0.4) + (truth_tier_weight × 0.35) + (recency_decay × 0.25)
 *
 * Also identifies gaps — domains or entity types that SHOULD have results but returned empty.
 */

import type { TelemetryEmitter } from "../../telemetry/emitter.js";
import { randomUUID } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────

export interface RerankInput {
  /** Raw query results from Stage 2 (Cypher execution) */
  queryResults: Record<string, unknown>[];
  /** Original question for gap analysis */
  question: string;
  /** All domains present in the graph (for gap detection) */
  knownDomains?: string[];
  /** All entity types present in the graph (for gap detection) */
  knownEntityTypes?: string[];
}

export interface RankedResult {
  /** Original result data */
  data: Record<string, unknown>;
  /** Composite reranking score (0–1) */
  score: number;
  /** Individual scoring components */
  components: {
    semantic_similarity: number;
    truth_tier_weight: number;
    recency_decay: number;
  };
  /** Truth tier of the underlying claim */
  truthTier: string;
  /** Claim ID if available */
  claimId?: string;
}

export interface GapInfo {
  /** Type of gap: missing domain or missing entity type */
  type: "domain" | "entity_type";
  /** The missing value */
  value: string;
  /** Why this gap is notable */
  reason: string;
}

export interface RerankResult {
  /** Reranked results, sorted by composite score descending */
  ranked: RankedResult[];
  /** Identified gaps — domains or entity types that should have appeared */
  gaps: GapInfo[];
  /** Summary statistics */
  stats: {
    total_input: number;
    total_output: number;
    avg_score: number;
    top_truth_tier: string;
  };
}

export interface RerankerOptions {
  emitter?: TelemetryEmitter;
  /** Recency decay window in days (default: 365) */
  recencyWindowDays?: number;
  /** Scoring weights — must sum to 1.0 */
  weights?: {
    semantic_similarity: number;
    truth_tier: number;
    recency: number;
  };
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Truth tier weights as specified in the PRD */
const TRUTH_TIER_WEIGHTS: Record<string, number> = {
  family_direct: 1.0,
  multi_source_verified: 0.85,
  single_source: 0.6,
  agent_inferred: 0.4,
};

const DEFAULT_WEIGHTS = {
  semantic_similarity: 0.4,
  truth_tier: 0.35,
  recency: 0.25,
};

const DEFAULT_RECENCY_WINDOW_DAYS = 365;

// ── Domain keywords for gap detection ──────────────────────────────────────

const DOMAIN_QUESTION_HINTS: Record<string, string[]> = {
  personal_finance: [
    "finance",
    "financial",
    "money",
    "account",
    "investment",
    "mortgage",
    "loan",
    "interest rate",
    "portfolio",
    "exposure",
    "bank",
  ],
  gix: ["gix", "series", "valuation", "startup", "venture", "equity"],
  we: ["we", "company", "business", "revenue", "client"],
  health: ["health", "medical", "doctor", "fitness", "wellness"],
  family: [
    "family",
    "kid",
    "children",
    "harrison",
    "wife",
    "husband",
    "parent",
  ],
  legal: ["legal", "law", "contract", "agreement", "trust", "estate"],
  general: [],
};

const ENTITY_TYPE_HINTS: Record<string, string[]> = {
  person: ["who", "person", "people", "name"],
  organization: [
    "company",
    "organization",
    "firm",
    "bank",
    "institution",
    "fund",
  ],
  financial_instrument: [
    "account",
    "investment",
    "mortgage",
    "loan",
    "bond",
    "stock",
  ],
  concept: ["risk", "rate", "trend", "impact", "effect"],
};

// ── Reranker ───────────────────────────────────────────────────────────────

export class Reranker {
  private readonly emitter: TelemetryEmitter | null;
  private readonly recencyWindowDays: number;
  private readonly weights: {
    semantic_similarity: number;
    truth_tier: number;
    recency: number;
  };
  private readonly sessionId: string;

  constructor(options?: RerankerOptions) {
    this.emitter = options?.emitter ?? null;
    this.recencyWindowDays =
      options?.recencyWindowDays ?? DEFAULT_RECENCY_WINDOW_DAYS;
    this.weights = options?.weights ?? DEFAULT_WEIGHTS;
    this.sessionId = randomUUID();
  }

  /**
   * Rerank query results by composite score and identify gaps.
   */
  async rerank(input: RerankInput): Promise<RerankResult> {
    const start = Date.now();

    if (input.queryResults.length === 0) {
      await this.emitEvent("rerank_empty_input", "skipped", {
        question: input.question,
      });
      return {
        ranked: [],
        gaps: this.detectGaps(input.question, [], input),
        stats: {
          total_input: 0,
          total_output: 0,
          avg_score: 0,
          top_truth_tier: "none",
        },
      };
    }

    // Score each result
    const scored = input.queryResults.map((result) =>
      this.scoreResult(result),
    );

    // Sort by composite score descending
    scored.sort((a, b) => b.score - a.score);

    // Detect gaps
    const resultDomains = this.extractDomains(input.queryResults);
    const resultEntityTypes = this.extractEntityTypes(input.queryResults);
    const gaps = this.detectGaps(
      input.question,
      [...resultDomains, ...resultEntityTypes],
      input,
    );

    const avgScore =
      scored.length > 0
        ? scored.reduce((sum, r) => sum + r.score, 0) / scored.length
        : 0;

    const result: RerankResult = {
      ranked: scored,
      gaps,
      stats: {
        total_input: input.queryResults.length,
        total_output: scored.length,
        avg_score: Math.round(avgScore * 1000) / 1000,
        top_truth_tier: scored[0]?.truthTier ?? "none",
      },
    };

    await this.emitEvent("rerank_complete", "success", {
      question: input.question,
      input_count: input.queryResults.length,
      output_count: scored.length,
      avg_score: result.stats.avg_score,
      gap_count: gaps.length,
      latency_ms: Date.now() - start,
    });

    return result;
  }

  /**
   * Get truth tier weight for a given tier name.
   */
  getTruthTierWeight(tier: string): number {
    return TRUTH_TIER_WEIGHTS[tier] ?? TRUTH_TIER_WEIGHTS.agent_inferred;
  }

  /**
   * Calculate recency decay for a given date.
   * Returns 1.0 for today, decaying exponentially toward 0 over the window.
   */
  calculateRecencyDecay(dateStr?: string | null): number {
    if (!dateStr) return 0.5; // Unknown date gets middle score

    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) return 0.5;

      const now = Date.now();
      const ageMs = now - date.getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      if (ageDays <= 0) return 1.0;

      // Exponential decay: e^(-3 * ageDays / windowDays)
      // At windowDays, this gives ~0.05
      const decay = Math.exp((-3 * ageDays) / this.recencyWindowDays);
      return Math.max(0, Math.min(1, decay));
    } catch {
      return 0.5;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private scoreResult(result: Record<string, unknown>): RankedResult {
    // Extract semantic similarity — from score field or default
    const semanticSimilarity = this.extractNumber(
      result.score ?? result.similarity ?? result.semantic_score,
      0.5,
    );

    // Extract truth tier
    const truthTier = this.extractTruthTier(result);
    const truthTierWeight = this.getTruthTierWeight(truthTier);

    // Extract recency
    const dateStr =
      (result.updated_at as string) ??
      (result.created_at as string) ??
      (result.date as string) ??
      null;
    const recencyDecay = this.calculateRecencyDecay(dateStr);

    // Composite score
    const score =
      semanticSimilarity * this.weights.semantic_similarity +
      truthTierWeight * this.weights.truth_tier +
      recencyDecay * this.weights.recency;

    return {
      data: result,
      score: Math.round(score * 1000) / 1000,
      components: {
        semantic_similarity: Math.round(semanticSimilarity * 1000) / 1000,
        truth_tier_weight: truthTierWeight,
        recency_decay: Math.round(recencyDecay * 1000) / 1000,
      },
      truthTier,
      claimId: (result.id as string) ?? (result.claim_id as string) ?? undefined,
    };
  }

  private extractNumber(val: unknown, defaultVal: number): number {
    if (typeof val === "number") return Math.max(0, Math.min(1, val));
    if (typeof val === "string") {
      const parsed = parseFloat(val);
      if (!isNaN(parsed)) return Math.max(0, Math.min(1, parsed));
    }
    return defaultVal;
  }

  private extractTruthTier(result: Record<string, unknown>): string {
    const tier =
      result.truth_tier ??
      result.tier ??
      result.truthTier;
    if (typeof tier === "string" && tier in TRUTH_TIER_WEIGHTS) {
      return tier;
    }
    return "agent_inferred";
  }

  private extractDomains(results: Record<string, unknown>[]): string[] {
    const domains = new Set<string>();
    for (const r of results) {
      const domain = r.domain as string;
      if (domain) domains.add(domain);
    }
    return [...domains];
  }

  private extractEntityTypes(results: Record<string, unknown>[]): string[] {
    const types = new Set<string>();
    for (const r of results) {
      const entityType = (r.entity_type ?? r.entityType) as string;
      if (entityType) types.add(entityType);
    }
    return [...types];
  }

  private detectGaps(
    question: string,
    presentValues: string[],
    input: RerankInput,
  ): GapInfo[] {
    const gaps: GapInfo[] = [];
    const q = question.toLowerCase();
    const present = new Set(presentValues.map((v) => v.toLowerCase()));

    // Check domain gaps
    for (const [domain, keywords] of Object.entries(DOMAIN_QUESTION_HINTS)) {
      if (domain === "general") continue;
      const questionMentions = keywords.some((kw) => q.includes(kw));
      if (questionMentions && !present.has(domain)) {
        // Also check if it's in knownDomains
        const isKnown =
          !input.knownDomains ||
          input.knownDomains.includes(domain);
        if (isKnown) {
          gaps.push({
            type: "domain",
            value: domain,
            reason: `Question mentions ${domain}-related terms but no results from this domain`,
          });
        }
      }
    }

    // Check entity type gaps
    for (const [entityType, keywords] of Object.entries(ENTITY_TYPE_HINTS)) {
      const questionMentions = keywords.some((kw) => q.includes(kw));
      if (questionMentions && !present.has(entityType)) {
        const isKnown =
          !input.knownEntityTypes ||
          input.knownEntityTypes.includes(entityType);
        if (isKnown) {
          gaps.push({
            type: "entity_type",
            value: entityType,
            reason: `Question mentions ${entityType}-related terms but no results of this type`,
          });
        }
      }
    }

    return gaps;
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
