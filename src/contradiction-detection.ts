/**
 * Contradiction Detection via Vector Similarity (US-018)
 *
 * After a new claim is added, finds semantically similar existing claims and
 * uses an LLM to determine if they contradict. Contradictions create
 * (:OpenQuestion) nodes, (:Claim)-[:CONTRADICTS]->(:Claim) edges, and
 * Obsidian insight notes in _agent_insights/.
 *
 * Usage:
 *   import { detectContradictions, detectContradictionsForClaim } from "../src/contradiction-detection.js";
 *
 * Environment variables (all optional — defaults to local Ollama):
 *   LLM_BASE_URL   — default: http://localhost:11434/v1
 *   LLM_MODEL      — default: qwen3:32b
 *   LLM_API_KEY    — default: ollama
 *   XAI_API_KEY    — if set, overrides LLM_API_KEY and uses https://api.x.ai/v1
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { generateEmbedding } from "./embedding.js";
import { findSimilarClaims } from "./embedding.js";
import { runCypher, escCypher } from "./entity-mapper.js";
import { resolveLLMConfig, type LLMConfig } from "./claim-decomposition.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ContradictionPair {
  claimAId: string;
  claimAContent: string;
  claimBId: string;
  claimBContent: string;
  similarity: number;
  explanation: string;
  openQuestionId: string;
}

export interface ContradictionResult {
  claimId: string;
  candidatesChecked: number;
  contradictionsFound: ContradictionPair[];
  insightFileWritten: string | null;
  errors: string[];
  success: boolean;
}

export interface BatchContradictionResult {
  claimsChecked: number;
  totalContradictions: number;
  contradictions: ContradictionPair[];
  insightFilesWritten: string[];
  errors: string[];
  success: boolean;
}

// ── Configuration ────────────────────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.7;
const TOP_K_CANDIDATES = 10;

const VAULT_DIR =
  process.env["VAULT_DIR"] ??
  `${process.env["HOME"]}/Library/Mobile Documents/com~apple~CloudDocs/Linglepedia`;

// ── LLM Contradiction Check ──────────────────────────────────────────────────

const CONTRADICTION_PROMPT = `You are an expert fact-checker. Given two claims, determine if they CONTRADICT each other.

Two claims contradict if:
- They assert opposite facts about the same subject
- They give conflicting numbers, dates, or attributes for the same thing
- One says X happened and the other says X did not happen
- They make incompatible assertions about the same entity

Two claims do NOT contradict if:
- They are about different subjects or time periods
- They provide complementary (not conflicting) information
- One is more specific than the other but both can be true
- They describe different aspects of the same topic

IMPORTANT: Respond with ONLY valid JSON, no markdown fences, no extra text. Use this exact format:
{"contradicts": true/false, "explanation": "brief explanation of why or why not"}

/no_think`;

interface LLMChatResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

interface ContradictionLLMResponse {
  contradicts: boolean;
  explanation: string;
}

/**
 * Ask the LLM whether two claims contradict each other.
 */
export async function checkContradiction(
  claimA: string,
  claimB: string,
  config?: Partial<LLMConfig>
): Promise<ContradictionLLMResponse> {
  const llm = resolveLLMConfig(config);
  const url = `${llm.baseUrl}/chat/completions`;

  const userMessage = `Claim A: "${claimA}"\n\nClaim B: "${claimB}"`;

  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${llm.apiKey}`,
        },
        body: JSON.stringify({
          model: llm.model,
          messages: [
            { role: "system", content: CONTRADICTION_PROMPT },
            { role: "user", content: userMessage },
          ],
          temperature: 0.1,
          max_tokens: 1024,
        }),
        signal: AbortSignal.timeout(300_000),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`LLM API error (HTTP ${response.status}): ${body}`);
      }

      const result = (await response.json()) as LLMChatResponse;
      const content = result.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error("LLM returned empty response");
      }

      return parseContradictionResponse(content);
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }

  return { contradicts: false, explanation: "Unable to determine" };
}

/**
 * Parse the LLM's contradiction check response.
 */
export function parseContradictionResponse(raw: string): ContradictionLLMResponse {
  // Strip <think>...</think> blocks
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  // Strip markdown fences
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");

  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) {
    return { contradicts: false, explanation: "Could not parse LLM response" };
  }
  cleaned = cleaned.slice(jsonStart, jsonEnd + 1);

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      contradicts: parsed.contradicts === true,
      explanation: typeof parsed.explanation === "string" ? parsed.explanation : "No explanation provided",
    };
  } catch {
    return { contradicts: false, explanation: "Could not parse LLM response" };
  }
}

// ── Neo4j Operations ─────────────────────────────────────────────────────────

/**
 * Create CONTRADICTS relationship and OpenQuestion node for a contradiction.
 */
export function storeContradiction(
  claimAId: string,
  claimBId: string,
  explanation: string,
  domain: string
): string {
  const oqId = `oq-contradiction-${claimAId}-${claimBId}`.slice(0, 200);

  // Create OpenQuestion node
  const oqCypher = `MERGE (oq:OpenQuestion {id: "${escCypher(oqId)}"})
SET oq.question = "Contradiction detected between claims",
    oq.explanation = "${escCypher(explanation)}",
    oq.status = "open",
    oq.domain = "${escCypher(domain)}",
    oq.claim_a = "${escCypher(claimAId)}",
    oq.claim_b = "${escCypher(claimBId)}",
    oq.created_by = "lingelpedia_agent",
    oq.created_at = datetime(),
    oq.updated_at = datetime()
RETURN oq.id;`;

  runCypher(oqCypher);

  // Create CONTRADICTS relationship between the two claims
  const relCypher = `MATCH (a:Claim {id: "${escCypher(claimAId)}"})
MATCH (b:Claim {id: "${escCypher(claimBId)}"})
MERGE (a)-[:CONTRADICTS]->(b)
RETURN a.id;`;

  runCypher(relCypher);

  // Link both claims to the OpenQuestion
  const linkCypher = `MATCH (a:Claim {id: "${escCypher(claimAId)}"})
MATCH (b:Claim {id: "${escCypher(claimBId)}"})
MATCH (oq:OpenQuestion {id: "${escCypher(oqId)}"})
MERGE (a)-[:MENTIONS]->(oq)
MERGE (b)-[:MENTIONS]->(oq)
RETURN oq.id;`;

  runCypher(linkCypher);

  // Flag both claims with conflicted truth basis
  const flagCypher = `MATCH (c:Claim) WHERE c.id IN ["${escCypher(claimAId)}", "${escCypher(claimBId)}"]
SET c.truth_basis = "conflicted", c.truth_score = 0.5
RETURN count(c);`;

  runCypher(flagCypher);

  return oqId;
}

/**
 * Get a claim's content and embedding from Neo4j.
 */
export function getClaimFromNeo4j(claimId: string): { content: string; domain: string; embedding: number[] } | null {
  const cypher = `MATCH (c:Claim {id: "${escCypher(claimId)}"})
RETURN c.content AS content, c.domain AS domain, c.embedding AS embedding;`;

  try {
    const raw = runCypher(cypher);
    if (!raw || raw.includes("0 rows")) return null;

    const lines = raw.split("\n").filter((l) => l.trim() && !l.startsWith("content,") && !l.includes(" rows"));
    if (lines.length === 0) return null;

    // Parse CSV - content is quoted, domain is quoted, embedding is an array
    const line = lines[0];
    const firstQuoteEnd = findClosingQuote(line, 0);
    const content = line.slice(1, firstQuoteEnd).replace(/""/g, '"');

    const afterFirstComma = line.indexOf(",", firstQuoteEnd) + 1;
    const domainStart = line.indexOf('"', afterFirstComma);
    const domainEnd = findClosingQuote(line, domainStart);
    const domain = line.slice(domainStart + 1, domainEnd);

    // Embedding parsing - it's after the second comma as a list
    const afterSecondComma = line.indexOf(",", domainEnd) + 1;
    const embeddingStr = line.slice(afterSecondComma).trim();
    let embedding: number[] = [];
    if (embeddingStr && embeddingStr !== "NULL" && embeddingStr !== "null") {
      const cleaned = embeddingStr.replace(/^\[/, "").replace(/\]$/, "");
      if (cleaned) {
        embedding = cleaned.split(",").map((v) => parseFloat(v.trim())).filter((v) => !isNaN(v));
      }
    }

    return { content, domain, embedding };
  } catch {
    return null;
  }
}

function findClosingQuote(s: string, openPos: number): number {
  for (let i = openPos + 1; i < s.length; i++) {
    if (s[i] === '"') {
      if (i + 1 < s.length && s[i + 1] === '"') {
        i++; // skip escaped quote
      } else {
        return i;
      }
    }
  }
  return s.length - 1;
}

// ── Insight Note Writing ─────────────────────────────────────────────────────

/**
 * Write a contradiction insight note to the Obsidian vault's _agent_insights/ directory.
 */
export function writeContradictionInsightNote(
  pair: ContradictionPair,
  claimADomain: string,
  claimBDomain: string
): string {
  const insightsDir = join(VAULT_DIR, "_agent_insights");
  if (!existsSync(insightsDir)) {
    mkdirSync(insightsDir, { recursive: true });
  }

  const today = new Date().toISOString().split("T")[0];
  const shortDesc = generateShortDescription(pair.claimAContent, pair.claimBContent);
  const filename = `${today}_contradiction_${shortDesc}.md`;
  const filePath = join(insightsDir, filename);

  const content = `---
type: contradiction
created_by: lingelpedia_agent
created_at: ${new Date().toISOString()}
related_claims:
  - ${pair.claimAId}
  - ${pair.claimBId}
open_question_id: ${pair.openQuestionId}
suggested_action: Review both claims and determine which is correct, then update truth scores accordingly
domains:
  - ${claimADomain}
  - ${claimBDomain}
---

# Contradiction Detected

**Date:** ${today}
**Similarity Score:** ${pair.similarity.toFixed(3)}

## Conflicting Claims

### Claim A
> ${pair.claimAContent}

- **ID:** ${pair.claimAId}
- **Domain:** ${claimADomain}

### Claim B
> ${pair.claimBContent}

- **ID:** ${pair.claimBId}
- **Domain:** ${claimBDomain}

## Analysis

${pair.explanation}

## Suggested Action

Review both claims and determine which is correct. Update truth scores accordingly:
- If Claim A is correct, mark Claim B as \`disputed\`
- If Claim B is correct, mark Claim A as \`disputed\`
- If both need updating, revise both claims with corrected information
`;

  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/**
 * Generate a short slug description from two claim texts for the filename.
 */
function generateShortDescription(claimA: string, claimB: string): string {
  // Extract key nouns/entities from both claims
  const words = (claimA + " " + claimB)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3);

  // Take up to 3 meaningful words
  const stopWords = new Set([
    "that", "this", "with", "from", "have", "been", "were", "their", "about",
    "which", "when", "will", "than", "they", "them", "then", "also", "more",
    "into", "over", "some", "only", "does", "each", "very", "much", "just",
  ]);
  const meaningful = words.filter((w) => !stopWords.has(w));
  const unique = [...new Set(meaningful)].slice(0, 3);

  return unique.join("-") || "unknown";
}

// ── Main Entry Points ────────────────────────────────────────────────────────

/**
 * Check a single claim against existing claims for contradictions.
 * Uses vector similarity to find candidates, then LLM to confirm contradictions.
 */
export async function detectContradictionsForClaim(
  claimId: string,
  options?: {
    topK?: number;
    similarityThreshold?: number;
    llmConfig?: Partial<LLMConfig>;
    skipInsightNote?: boolean;
  }
): Promise<ContradictionResult> {
  const topK = options?.topK ?? TOP_K_CANDIDATES;
  const threshold = options?.similarityThreshold ?? SIMILARITY_THRESHOLD;

  const result: ContradictionResult = {
    claimId,
    candidatesChecked: 0,
    contradictionsFound: [],
    insightFileWritten: null,
    errors: [],
    success: false,
  };

  try {
    // 1. Get the claim's content and embedding
    const claim = getClaimFromNeo4j(claimId);
    if (!claim) {
      result.errors.push(`Claim not found: ${claimId}`);
      return result;
    }

    let embedding = claim.embedding;
    if (!embedding || embedding.length === 0) {
      // Generate embedding if missing
      embedding = await generateEmbedding(claim.content);
    }

    // 2. Find similar claims via vector index
    const candidates = findSimilarClaims(embedding, topK + 1, threshold);

    // Filter out the claim itself
    const filtered = candidates.filter((c) => c.id !== claimId);
    result.candidatesChecked = filtered.length;

    if (filtered.length === 0) {
      result.success = true;
      return result;
    }

    // 3. Check each candidate for contradiction via LLM
    for (const candidate of filtered) {
      try {
        const check = await checkContradiction(
          claim.content,
          candidate.content,
          options?.llmConfig
        );

        if (check.contradicts) {
          const oqId = storeContradiction(
            claimId,
            candidate.id,
            check.explanation,
            claim.domain
          );

          const pair: ContradictionPair = {
            claimAId: claimId,
            claimAContent: claim.content,
            claimBId: candidate.id,
            claimBContent: candidate.content,
            similarity: candidate.score,
            explanation: check.explanation,
            openQuestionId: oqId,
          };

          result.contradictionsFound.push(pair);

          // Write insight note
          if (!options?.skipInsightNote) {
            try {
              const filePath = writeContradictionInsightNote(
                pair,
                claim.domain,
                candidate.domain
              );
              result.insightFileWritten = filePath;
            } catch (err) {
              result.errors.push(
                `Failed to write insight note: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
        }
      } catch (err) {
        result.errors.push(
          `LLM check against ${candidate.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    result.success = true;
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  return result;
}

/**
 * Run contradiction detection on a batch of claim IDs.
 */
export async function detectContradictions(
  claimIds: string[],
  options?: {
    topK?: number;
    similarityThreshold?: number;
    llmConfig?: Partial<LLMConfig>;
    skipInsightNotes?: boolean;
  }
): Promise<BatchContradictionResult> {
  const result: BatchContradictionResult = {
    claimsChecked: 0,
    totalContradictions: 0,
    contradictions: [],
    insightFilesWritten: [],
    errors: [],
    success: false,
  };

  // Track already-seen contradiction pairs to avoid duplicates
  const seenPairs = new Set<string>();

  for (const claimId of claimIds) {
    const claimResult = await detectContradictionsForClaim(claimId, {
      topK: options?.topK,
      similarityThreshold: options?.similarityThreshold,
      llmConfig: options?.llmConfig,
      skipInsightNote: options?.skipInsightNotes,
    });

    result.claimsChecked++;

    for (const pair of claimResult.contradictionsFound) {
      // Deduplicate: check both directions
      const pairKey1 = `${pair.claimAId}::${pair.claimBId}`;
      const pairKey2 = `${pair.claimBId}::${pair.claimAId}`;

      if (!seenPairs.has(pairKey1) && !seenPairs.has(pairKey2)) {
        seenPairs.add(pairKey1);
        result.contradictions.push(pair);
        result.totalContradictions++;
      }
    }

    if (claimResult.insightFileWritten) {
      result.insightFilesWritten.push(claimResult.insightFileWritten);
    }

    result.errors.push(...claimResult.errors);
  }

  result.success = result.errors.length === 0;
  return result;
}

/**
 * Scan all existing claims with "conflicted" truth_score from vault migration
 * and create OpenQuestion nodes for them.
 */
export function migrateConflictedTruthScores(): {
  openQuestionsCreated: number;
  errors: string[];
} {
  const result = { openQuestionsCreated: 0, errors: [] as string[] };

  try {
    // Find entities with conflicted truth scores that don't already have OpenQuestion nodes
    const cypher = `MATCH (e:Entity)
WHERE e.truth_basis = "conflicted"
AND NOT EXISTS { MATCH (e)-[:MENTIONS]->(:OpenQuestion) }
RETURN e.id AS id, e.name AS name, e.domain AS domain;`;

    const raw = runCypher(cypher);
    if (!raw || raw.includes("0 rows")) return result;

    const lines = raw.split("\n").filter((l) => l.trim() && !l.startsWith("id,") && !l.includes(" rows"));

    for (const line of lines) {
      try {
        const parts = line.split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
        const entityId = parts[0] ?? "";
        const entityName = parts[1] ?? entityId;
        const domain = parts[2] ?? "unknown";

        if (!entityId) continue;

        const oqId = `oq-${entityId}-conflicted`;
        const oqCypher = `MERGE (oq:OpenQuestion {id: "${escCypher(oqId)}"})
SET oq.question = "Conflicted truth score on entity: ${escCypher(entityName)}",
    oq.status = "open",
    oq.domain = "${escCypher(domain)}",
    oq.source_entity = "${escCypher(entityId)}",
    oq.created_by = "lingelpedia_agent",
    oq.created_at = datetime(),
    oq.updated_at = datetime()
WITH oq
MATCH (e:Entity {id: "${escCypher(entityId)}"})
MERGE (e)-[:MENTIONS]->(oq)
RETURN oq.id;`;

        runCypher(oqCypher);
        result.openQuestionsCreated++;
      } catch (err) {
        result.errors.push(
          `Entity ${line}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  return result;
}
