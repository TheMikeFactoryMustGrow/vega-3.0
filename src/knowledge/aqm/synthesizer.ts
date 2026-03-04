/**
 * AQM Stage 4 — Grounded Synthesis
 *
 * Produces a grounded answer with inline citations in format:
 *   [Claim ID: {id} | truth_tier: {tier} | truth_score: {score}]
 *
 * Includes inference chains, identified gaps, and confidence assessment.
 * Uses frontier model for synthesis — never local.
 */

import type { ModelRouter, RoutingDecision } from "../model-router.js";
import type { TelemetryEmitter } from "../../telemetry/emitter.js";
import type { RankedResult, GapInfo } from "./reranker.js";
import { randomUUID } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SynthesisInput {
  /** Original question */
  question: string;
  /** Reranked results from Stage 3 */
  rankedResults: RankedResult[];
  /** Gaps identified by Stage 3 */
  gaps: GapInfo[];
  /** The Cypher query that was used (for transparency) */
  queryUsed?: string;
}

export interface Citation {
  claimId: string;
  content: string;
  truthTier: string;
  truthScore: number;
  /** Formatted citation string */
  formatted: string;
}

export interface InferenceStep {
  /** What was inferred */
  inference: string;
  /** Claim IDs supporting this inference */
  supportingClaims: string[];
}

export interface SynthesisResult {
  /** The grounded answer with inline citations */
  answer: string;
  /** All citations used in the answer */
  citations: Citation[];
  /** Gaps in knowledge */
  gaps: string[];
  /** Overall confidence (0–1) based on component claim scores */
  confidence: number;
  /** How the answer was derived from multiple claims */
  inferenceChain: InferenceStep[];
  /** The Cypher query that produced the data */
  queryUsed?: string;
}

export interface SynthesizerOptions {
  router?: ModelRouter;
  emitter?: TelemetryEmitter;
  /** Override for testing — inject a function that calls the LLM */
  llmCall?: (
    prompt: string,
    systemPrompt: string,
    routing: RoutingDecision,
  ) => Promise<string>;
}

// ── System Prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a knowledge synthesis engine. Your job is to produce a grounded, cited answer from ranked knowledge graph claims.

RULES:
1. Every factual statement MUST cite its source claim using this EXACT format:
   [Claim ID: {id} | truth_tier: {tier} | truth_score: {score}]
2. If you can infer something from combining claims, state the inference and list supporting claim IDs
3. Explicitly state what you DON'T know (gaps in the data)
4. Assess overall confidence based on the quality and quantity of supporting claims
5. Use truth_tier to weight your confidence:
   - family_direct (highest trust) = strongest evidence
   - multi_source_verified = strong evidence
   - single_source = moderate evidence
   - agent_inferred (lowest trust) = weak evidence
6. NEVER make claims that aren't supported by the provided data
7. If no claims are provided, say "No knowledge available for this question."

Respond with a JSON object (no markdown fencing):
{
  "answer": "The grounded answer text with inline citations [Claim ID: ... | truth_tier: ... | truth_score: ...]",
  "inference_chain": [
    {
      "inference": "What was inferred",
      "supporting_claims": ["claim-id-1", "claim-id-2"]
    }
  ],
  "gaps": ["What we don't know about X", "Missing data about Y"],
  "confidence": 0.85
}`;

// ── Synthesizer ───────────────────────────────────────────────────────────

export class Synthesizer {
  private readonly router: ModelRouter | null;
  private readonly emitter: TelemetryEmitter | null;
  private readonly llmCall: (
    prompt: string,
    systemPrompt: string,
    routing: RoutingDecision,
  ) => Promise<string>;
  private readonly sessionId: string;

  constructor(options?: SynthesizerOptions) {
    this.router = options?.router ?? null;
    this.emitter = options?.emitter ?? null;
    this.llmCall = options?.llmCall ?? this.defaultLlmCall.bind(this);
    this.sessionId = randomUUID();
  }

  /**
   * Synthesize a grounded answer from ranked results.
   */
  async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
    const start = Date.now();

    // Handle empty results
    if (input.rankedResults.length === 0) {
      const emptyResult: SynthesisResult = {
        answer: "No knowledge available for this question.",
        citations: [],
        gaps: input.gaps.map((g) => g.reason),
        confidence: 0,
        inferenceChain: [],
        queryUsed: input.queryUsed,
      };

      await this.emitEvent("synthesis_empty_input", "skipped", {
        question: input.question,
        gap_count: input.gaps.length,
      });

      return emptyResult;
    }

    // Build citations from ranked results
    const citations = this.buildCitations(input.rankedResults);

    // If no router, produce a simple answer without LLM
    if (!this.router) {
      return this.fallbackSynthesis(input, citations);
    }

    try {
      const routing = await this.router.route("aqm_synthesis");
      const userPrompt = this.buildPrompt(input, citations);
      const rawResponse = await this.llmCall(
        userPrompt,
        SYSTEM_PROMPT,
        routing,
      );
      const parsed = this.parseResponse(rawResponse);

      if (!parsed) {
        // Fallback if LLM response can't be parsed
        await this.emitEvent("synthesis_parse_error", "partial", {
          question: input.question,
          raw_response_length: rawResponse.length,
          latency_ms: Date.now() - start,
        });
        return this.fallbackSynthesis(input, citations);
      }

      const result: SynthesisResult = {
        answer: parsed.answer,
        citations,
        gaps: [
          ...parsed.gaps,
          ...input.gaps.map((g) => g.reason),
        ],
        confidence: Math.max(0, Math.min(1, parsed.confidence)),
        inferenceChain: parsed.inferenceChain,
        queryUsed: input.queryUsed,
      };

      await this.emitEvent("synthesis_complete", "success", {
        question: input.question,
        citation_count: citations.length,
        gap_count: result.gaps.length,
        confidence: result.confidence,
        latency_ms: Date.now() - start,
      });

      return result;
    } catch (error) {
      await this.emitEvent("synthesis_error", "failure", {
        question: input.question,
        error: error instanceof Error ? error.message : String(error),
        latency_ms: Date.now() - start,
      });

      // Non-blocking fallback
      return this.fallbackSynthesis(input, citations);
    }
  }

  /**
   * Parse the LLM synthesis response.
   */
  parseResponse(
    raw: string,
  ): {
    answer: string;
    inferenceChain: InferenceStep[];
    gaps: string[];
    confidence: number;
  } | null {
    try {
      let cleaned = raw.trim();

      // Strip markdown code fencing
      if (cleaned.startsWith("```")) {
        cleaned = cleaned
          .replace(/^```(?:json)?\s*\n?/, "")
          .replace(/\n?```\s*$/, "");
      }

      const parsed = JSON.parse(cleaned) as Record<string, unknown>;

      if (typeof parsed.answer !== "string" || !parsed.answer.trim()) {
        return null;
      }

      // Parse inference chain
      const inferenceChain: InferenceStep[] = [];
      if (Array.isArray(parsed.inference_chain)) {
        for (const step of parsed.inference_chain) {
          if (
            typeof step === "object" &&
            step !== null &&
            typeof (step as Record<string, unknown>).inference === "string"
          ) {
            const s = step as Record<string, unknown>;
            inferenceChain.push({
              inference: s.inference as string,
              supportingClaims: Array.isArray(s.supporting_claims)
                ? (s.supporting_claims as string[])
                : [],
            });
          }
        }
      }

      // Parse gaps
      const gaps: string[] = [];
      if (Array.isArray(parsed.gaps)) {
        for (const gap of parsed.gaps) {
          if (typeof gap === "string") {
            gaps.push(gap);
          }
        }
      }

      // Parse confidence
      const confidence =
        typeof parsed.confidence === "number"
          ? parsed.confidence
          : 0.5;

      return {
        answer: parsed.answer as string,
        inferenceChain,
        gaps,
        confidence,
      };
    } catch {
      return null;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private buildCitations(rankedResults: RankedResult[]): Citation[] {
    return rankedResults.map((result) => {
      const id =
        result.claimId ??
        (result.data.id as string) ??
        (result.data.claim_id as string) ??
        "unknown";
      const content =
        (result.data.content as string) ??
        (result.data.claim as string) ??
        "No content";
      const truthTier = result.truthTier;
      const truthScore =
        typeof result.data.truth_score === "number"
          ? result.data.truth_score
          : result.score;

      return {
        claimId: id,
        content,
        truthTier,
        truthScore: Math.round(truthScore * 100) / 100,
        formatted: `[Claim ID: ${id} | truth_tier: ${truthTier} | truth_score: ${Math.round(truthScore * 100) / 100}]`,
      };
    });
  }

  private buildPrompt(input: SynthesisInput, citations: Citation[]): string {
    const parts: string[] = [
      `QUESTION: ${input.question}`,
      "",
      "RANKED CLAIMS (highest trust first):",
    ];

    for (const [i, citation] of citations.entries()) {
      const rank = i + 1;
      parts.push(
        `${rank}. ${citation.formatted}`,
        `   Content: ${citation.content}`,
        `   Composite Score: ${input.rankedResults[i].score}`,
        "",
      );
    }

    if (input.gaps.length > 0) {
      parts.push("KNOWN GAPS:");
      for (const gap of input.gaps) {
        parts.push(`  - ${gap.reason}`);
      }
      parts.push("");
    }

    parts.push(
      "Synthesize a grounded answer citing the claims above. Include inference chains and identify additional gaps.",
    );

    return parts.join("\n");
  }

  /**
   * Produce a simple synthesis without LLM when router is unavailable.
   */
  private fallbackSynthesis(
    input: SynthesisInput,
    citations: Citation[],
  ): SynthesisResult {
    // Build a simple answer from the top-ranked results
    const topClaims = citations.slice(0, 5);
    const answerParts = topClaims.map(
      (c) => `${c.content} ${c.formatted}`,
    );

    const answer =
      answerParts.length > 0
        ? `Based on available knowledge:\n\n${answerParts.join("\n\n")}`
        : "No knowledge available for this question.";

    // Calculate confidence from average scores
    const avgScore =
      input.rankedResults.length > 0
        ? input.rankedResults.reduce((sum, r) => sum + r.score, 0) /
          input.rankedResults.length
        : 0;

    return {
      answer,
      citations,
      gaps: input.gaps.map((g) => g.reason),
      confidence: Math.round(avgScore * 100) / 100,
      inferenceChain: [],
      queryUsed: input.queryUsed,
    };
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
        temperature: 0.3,
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
