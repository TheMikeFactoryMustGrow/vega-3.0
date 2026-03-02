/**
 * Proactive Cross-Domain Connection Engine (US-019)
 *
 * After a claim batch is processed, searches for related claims in different
 * domains. Scores connections by vector similarity, shared entities, and
 * temporal proximity. Interesting connections are written as Obsidian insight
 * notes in _agent_insights/.
 *
 * Usage:
 *   import { findCrossDomainConnections, findConnectionsForClaim } from "../src/cross-domain-connections.js";
 *
 * Environment variables (all optional — defaults to local Ollama):
 *   LLM_BASE_URL   — default: http://localhost:11434/v1
 *   LLM_MODEL      — default: qwen3:32b
 *   LLM_API_KEY    — default: ollama
 *   XAI_API_KEY    — if set, overrides LLM_API_KEY and uses https://api.x.ai/v1
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { generateEmbedding, findSimilarClaims } from "./embedding.js";
import { runCypher, escCypher } from "./entity-mapper.js";
import { resolveLLMConfig, type LLMConfig } from "./claim-decomposition.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CrossDomainConnection {
  claimAId: string;
  claimAContent: string;
  claimADomain: string;
  claimBId: string;
  claimBContent: string;
  claimBDomain: string;
  similarityScore: number;
  sharedEntities: string[];
  connectionScore: number;
  explanation: string;
  suggestedAction: string;
}

export interface ConnectionResult {
  claimId: string;
  candidatesChecked: number;
  connectionsFound: CrossDomainConnection[];
  insightFileWritten: string | null;
  errors: string[];
  success: boolean;
}

export interface BatchConnectionResult {
  claimsChecked: number;
  totalConnections: number;
  connections: CrossDomainConnection[];
  insightFilesWritten: string[];
  errors: string[];
  success: boolean;
}

// ── Configuration ────────────────────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.5;
const TOP_K_CANDIDATES = 15;
const CONNECTION_SCORE_THRESHOLD = 0.4;

const VAULT_DIR =
  process.env["VAULT_DIR"] ??
  `${process.env["HOME"]}/Library/Mobile Documents/com~apple~CloudDocs/Linglepedia`;

// ── Neo4j Queries ────────────────────────────────────────────────────────────

interface ClaimData {
  id: string;
  content: string;
  domain: string;
  embedding: number[];
  createdAt: string | null;
}

/**
 * Get a claim's data from Neo4j.
 */
export function getClaimData(claimId: string): ClaimData | null {
  const cypher = `MATCH (c:Claim {id: "${escCypher(claimId)}"})
RETURN c.content AS content, c.domain AS domain, c.embedding AS embedding, toString(c.created_at) AS created_at;`;

  try {
    const raw = runCypher(cypher);
    if (!raw || raw.includes("0 rows")) return null;

    const lines = raw.split("\n").filter((l) => l.trim() && !l.startsWith("content,") && !l.includes(" rows"));
    if (lines.length === 0) return null;

    const line = lines[0];
    const firstQuoteEnd = findClosingQuote(line, 0);
    const content = line.slice(1, firstQuoteEnd).replace(/""/g, '"');

    const afterFirstComma = line.indexOf(",", firstQuoteEnd) + 1;
    const domainStart = line.indexOf('"', afterFirstComma);
    const domainEnd = findClosingQuote(line, domainStart);
    const domain = line.slice(domainStart + 1, domainEnd);

    const afterSecondComma = line.indexOf(",", domainEnd) + 1;
    // Find the bracket for embedding
    const bracketStart = line.indexOf("[", afterSecondComma);
    const bracketEnd = line.indexOf("]", bracketStart);

    let embedding: number[] = [];
    if (bracketStart !== -1 && bracketEnd !== -1) {
      const embStr = line.slice(bracketStart + 1, bracketEnd);
      if (embStr) {
        embedding = embStr.split(",").map((v) => parseFloat(v.trim())).filter((v) => !isNaN(v));
      }
    }

    // created_at is after the embedding
    const afterBracket = bracketEnd !== -1 ? bracketEnd + 1 : afterSecondComma;
    const afterThirdComma = line.indexOf(",", afterBracket) + 1;
    let createdAt: string | null = null;
    if (afterThirdComma > 0) {
      const rest = line.slice(afterThirdComma).trim().replace(/^"|"$/g, "");
      if (rest && rest !== "NULL" && rest !== "null") {
        createdAt = rest;
      }
    }

    return { id: claimId, content, domain, embedding, createdAt };
  } catch {
    return null;
  }
}

function findClosingQuote(s: string, openPos: number): number {
  for (let i = openPos + 1; i < s.length; i++) {
    if (s[i] === '"') {
      if (i + 1 < s.length && s[i + 1] === '"') {
        i++;
      } else {
        return i;
      }
    }
  }
  return s.length - 1;
}

/**
 * Get entities linked to a claim via ABOUT relationships.
 */
export function getClaimEntities(claimId: string): string[] {
  const cypher = `MATCH (c:Claim {id: "${escCypher(claimId)}"})-[:ABOUT]->(e:Entity)
RETURN e.id AS id;`;

  try {
    const raw = runCypher(cypher);
    if (!raw || raw.includes("0 rows")) return [];

    return raw
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("id") && !l.includes(" rows"))
      .map((l) => l.trim().replace(/^"|"$/g, ""));
  } catch {
    return [];
  }
}

// ── Connection Scoring ───────────────────────────────────────────────────────

/**
 * Compute temporal proximity score between two date strings.
 * Returns 1.0 for same day, decaying toward 0 over ~365 days.
 */
export function temporalProximityScore(dateA: string | null, dateB: string | null): number {
  if (!dateA || !dateB) return 0.5; // neutral if unknown

  try {
    const a = new Date(dateA).getTime();
    const b = new Date(dateB).getTime();
    if (isNaN(a) || isNaN(b)) return 0.5;

    const daysDiff = Math.abs(a - b) / (1000 * 60 * 60 * 24);
    // Exponential decay: 1.0 at 0 days, ~0.5 at 30 days, ~0.05 at 365 days
    return Math.exp(-daysDiff / 45);
  } catch {
    return 0.5;
  }
}

/**
 * Compute composite connection score.
 *
 * Weights:
 *   - Vector similarity: 0.5
 *   - Shared entities: 0.3
 *   - Temporal proximity: 0.2
 */
export function computeConnectionScore(
  similarity: number,
  sharedEntityCount: number,
  totalEntityCount: number,
  temporalScore: number
): number {
  const entityScore = totalEntityCount > 0 ? Math.min(sharedEntityCount / Math.max(totalEntityCount, 1), 1) : 0;
  return 0.5 * similarity + 0.3 * entityScore + 0.2 * temporalScore;
}

// ── LLM Connection Explanation ───────────────────────────────────────────────

const CONNECTION_PROMPT = `You are an expert knowledge analyst. Given two claims from DIFFERENT domains, explain why they might be meaningfully connected and suggest an action.

Focus on:
- How information from one domain could impact decisions in the other
- Shared entities, risks, or opportunities across domains
- Strategic implications of the connection

IMPORTANT: Respond with ONLY valid JSON, no markdown fences, no extra text. Use this exact format:
{"explanation": "why these claims are connected", "suggested_action": "what should be done about this connection"}

/no_think`;

interface ConnectionLLMResponse {
  explanation: string;
  suggestedAction: string;
}

/**
 * Ask the LLM to explain why two cross-domain claims are connected.
 */
export async function explainConnection(
  claimA: string,
  domainA: string,
  claimB: string,
  domainB: string,
  config?: Partial<LLMConfig>
): Promise<ConnectionLLMResponse> {
  const llm = resolveLLMConfig(config);
  const url = `${llm.baseUrl}/chat/completions`;

  const userMessage = `Domain A (${domainA}): "${claimA}"\n\nDomain B (${domainB}): "${claimB}"`;

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
            { role: "system", content: CONNECTION_PROMPT },
            { role: "user", content: userMessage },
          ],
          temperature: 0.3,
          max_tokens: 1024,
        }),
        signal: AbortSignal.timeout(300_000),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`LLM API error (HTTP ${response.status}): ${body}`);
      }

      const result = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      const content = result.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error("LLM returned empty response");
      }

      return parseConnectionResponse(content);
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }

  return { explanation: "Unable to determine", suggestedAction: "Review manually" };
}

/**
 * Parse the LLM's connection explanation response.
 */
export function parseConnectionResponse(raw: string): ConnectionLLMResponse {
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");

  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) {
    return { explanation: "Could not parse LLM response", suggestedAction: "Review manually" };
  }
  cleaned = cleaned.slice(jsonStart, jsonEnd + 1);

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      explanation: typeof parsed.explanation === "string" ? parsed.explanation : "No explanation provided",
      suggestedAction: typeof parsed.suggested_action === "string"
        ? parsed.suggested_action
        : typeof parsed.suggestedAction === "string"
          ? parsed.suggestedAction
          : "Review this connection and determine if action is needed",
    };
  } catch {
    return { explanation: "Could not parse LLM response", suggestedAction: "Review manually" };
  }
}

// ── Insight Note Writing ─────────────────────────────────────────────────────

/**
 * Write a cross-domain connection insight note to _agent_insights/.
 */
export function writeConnectionInsightNote(connection: CrossDomainConnection): string {
  const insightsDir = join(VAULT_DIR, "_agent_insights");
  if (!existsSync(insightsDir)) {
    mkdirSync(insightsDir, { recursive: true });
  }

  const today = new Date().toISOString().split("T")[0];
  const shortDesc = generateShortDescription(connection.claimAContent, connection.claimBContent);
  const filename = `${today}_connection_${shortDesc}.md`;
  const filePath = join(insightsDir, filename);

  const sharedEntitiesStr = connection.sharedEntities.length > 0
    ? connection.sharedEntities.map((e) => `[[${e}]]`).join(", ")
    : "None identified";

  const content = `---
type: connection
created_by: lingelpedia_agent
created_at: ${new Date().toISOString()}
related_claims:
  - ${connection.claimAId}
  - ${connection.claimBId}
domains:
  - ${connection.claimADomain}
  - ${connection.claimBDomain}
connection_score: ${connection.connectionScore.toFixed(3)}
suggested_action: ${connection.suggestedAction}
---

# Cross-Domain Connection Discovered

**Date:** ${today}
**Connection Score:** ${connection.connectionScore.toFixed(3)}
**Domains:** ${connection.claimADomain} ↔ ${connection.claimBDomain}

## Connected Claims

### Claim A (${connection.claimADomain})
> ${connection.claimAContent}

- **ID:** ${connection.claimAId}

### Claim B (${connection.claimBDomain})
> ${connection.claimBContent}

- **ID:** ${connection.claimBId}

## Why This Matters

${connection.explanation}

## Shared Entities

${sharedEntitiesStr}

## Suggested Action

${connection.suggestedAction}
`;

  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/**
 * Generate a short slug description from two claim texts for the filename.
 */
function generateShortDescription(claimA: string, claimB: string): string {
  const words = (claimA + " " + claimB)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3);

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
 * Find cross-domain connections for a single claim.
 * Uses vector similarity to find candidates in OTHER domains, scores them,
 * and optionally uses LLM to explain interesting connections.
 */
export async function findConnectionsForClaim(
  claimId: string,
  options?: {
    topK?: number;
    similarityThreshold?: number;
    connectionScoreThreshold?: number;
    llmConfig?: Partial<LLMConfig>;
    skipInsightNote?: boolean;
    skipLLMExplanation?: boolean;
  }
): Promise<ConnectionResult> {
  const topK = options?.topK ?? TOP_K_CANDIDATES;
  const simThreshold = options?.similarityThreshold ?? SIMILARITY_THRESHOLD;
  const scoreThreshold = options?.connectionScoreThreshold ?? CONNECTION_SCORE_THRESHOLD;

  const result: ConnectionResult = {
    claimId,
    candidatesChecked: 0,
    connectionsFound: [],
    insightFileWritten: null,
    errors: [],
    success: false,
  };

  try {
    // 1. Get the claim's data
    const claim = getClaimData(claimId);
    if (!claim) {
      result.errors.push(`Claim not found: ${claimId}`);
      return result;
    }

    let embedding = claim.embedding;
    if (!embedding || embedding.length === 0) {
      embedding = await generateEmbedding(claim.content);
    }

    // 2. Get claim's entities for shared entity scoring
    const claimEntities = getClaimEntities(claimId);

    // 3. Find similar claims via vector index
    const candidates = findSimilarClaims(embedding, topK + 1, simThreshold);

    // Filter: exclude self AND same-domain claims
    const crossDomain = candidates.filter(
      (c) => c.id !== claimId && c.domain !== claim.domain
    );
    result.candidatesChecked = crossDomain.length;

    if (crossDomain.length === 0) {
      result.success = true;
      return result;
    }

    // 4. Score each cross-domain candidate
    for (const candidate of crossDomain) {
      try {
        const candidateEntities = getClaimEntities(candidate.id);
        const sharedEntities = claimEntities.filter((e) => candidateEntities.includes(e));
        const totalEntities = new Set([...claimEntities, ...candidateEntities]).size;

        // Get candidate's created_at for temporal scoring
        const candidateData = getClaimData(candidate.id);
        const temporal = temporalProximityScore(claim.createdAt, candidateData?.createdAt ?? null);

        const connectionScore = computeConnectionScore(
          candidate.score,
          sharedEntities.length,
          totalEntities,
          temporal
        );

        if (connectionScore >= scoreThreshold) {
          let explanation = "Semantically similar claims across different domains";
          let suggestedAction = "Review this connection and determine if action is needed";

          // Get LLM explanation for high-scoring connections
          if (!options?.skipLLMExplanation) {
            try {
              const llmResult = await explainConnection(
                claim.content,
                claim.domain,
                candidate.content,
                candidate.domain,
                options?.llmConfig
              );
              explanation = llmResult.explanation;
              suggestedAction = llmResult.suggestedAction;
            } catch (err) {
              result.errors.push(
                `LLM explanation for ${candidate.id}: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }

          const connection: CrossDomainConnection = {
            claimAId: claimId,
            claimAContent: claim.content,
            claimADomain: claim.domain,
            claimBId: candidate.id,
            claimBContent: candidate.content,
            claimBDomain: candidate.domain,
            similarityScore: candidate.score,
            sharedEntities,
            connectionScore,
            explanation,
            suggestedAction,
          };

          result.connectionsFound.push(connection);

          // Write insight note for the best connection
          if (!options?.skipInsightNote && result.insightFileWritten === null) {
            try {
              result.insightFileWritten = writeConnectionInsightNote(connection);
            } catch (err) {
              result.errors.push(
                `Failed to write insight note: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
        }
      } catch (err) {
        result.errors.push(
          `Scoring ${candidate.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Sort connections by score descending
    result.connectionsFound.sort((a, b) => b.connectionScore - a.connectionScore);
    result.success = true;
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  return result;
}

/**
 * Find cross-domain connections for a batch of claim IDs.
 * Deduplicates connections (A→B and B→A are the same).
 */
export async function findCrossDomainConnections(
  claimIds: string[],
  options?: {
    topK?: number;
    similarityThreshold?: number;
    connectionScoreThreshold?: number;
    llmConfig?: Partial<LLMConfig>;
    skipInsightNotes?: boolean;
    skipLLMExplanation?: boolean;
  }
): Promise<BatchConnectionResult> {
  const result: BatchConnectionResult = {
    claimsChecked: 0,
    totalConnections: 0,
    connections: [],
    insightFilesWritten: [],
    errors: [],
    success: false,
  };

  const seenPairs = new Set<string>();

  for (const claimId of claimIds) {
    const claimResult = await findConnectionsForClaim(claimId, {
      topK: options?.topK,
      similarityThreshold: options?.similarityThreshold,
      connectionScoreThreshold: options?.connectionScoreThreshold,
      llmConfig: options?.llmConfig,
      skipInsightNote: options?.skipInsightNotes,
      skipLLMExplanation: options?.skipLLMExplanation,
    });

    result.claimsChecked++;

    for (const conn of claimResult.connectionsFound) {
      const pairKey1 = `${conn.claimAId}::${conn.claimBId}`;
      const pairKey2 = `${conn.claimBId}::${conn.claimAId}`;

      if (!seenPairs.has(pairKey1) && !seenPairs.has(pairKey2)) {
        seenPairs.add(pairKey1);
        result.connections.push(conn);
        result.totalConnections++;
      }
    }

    if (claimResult.insightFileWritten) {
      result.insightFilesWritten.push(claimResult.insightFileWritten);
    }

    result.errors.push(...claimResult.errors);
  }

  // Sort all connections by score
  result.connections.sort((a, b) => b.connectionScore - a.connectionScore);
  result.success = true;
  return result;
}
