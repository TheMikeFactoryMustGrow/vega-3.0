/**
 * Atomic Claim Decomposition Engine (US-017)
 *
 * Decomposes unstructured note text into atomic, verifiable claims stored in
 * Neo4j. Uses an LLM (Grok-4.20 via xAI or Ollama qwen3:32b locally) to
 * extract claims, generates embeddings for semantic search, and deduplicates
 * claims from overlapping text chunks by vector similarity.
 *
 * Usage:
 *   import { decomposeNote, decomposeNoteFile } from "../src/claim-decomposition.js";
 *
 *   const result = await decomposeNoteFile("/path/to/meeting-note.md", "gix");
 *
 * Environment variables (all optional — defaults to local Ollama):
 *   LLM_BASE_URL   — default: http://localhost:11434/v1
 *   LLM_MODEL      — default: qwen3:32b
 *   LLM_API_KEY    — default: ollama
 *   XAI_API_KEY    — if set, overrides LLM_API_KEY and uses https://api.x.ai/v1
 */

import { basename } from "node:path";
import { parseNoteFile, parseNoteString } from "./frontmatter-parser.js";
import { generateEmbedding } from "./embedding.js";
import { runCypher, escCypher, generateEntityId, generateSourceId } from "./entity-mapper.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ExtractedClaim {
  content: string;
  entities: string[];
  domainHint: string;
}

export interface StoredClaim {
  claimId: string;
  content: string;
  entities: string[];
  domain: string;
  truthScore: number;
  embedding: number[] | null;
}

export interface DecompositionResult {
  sourceFile: string;
  sourceId: string;
  domain: string;
  totalChunks: number;
  rawClaimsExtracted: number;
  claimsAfterDedup: number;
  claimsStored: StoredClaim[];
  entitiesLinked: string[];
  errors: string[];
  success: boolean;
}

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_LLM_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_LLM_MODEL = "qwen3:32b";
const DEFAULT_LLM_API_KEY = "ollama";

// Chunking constants (~4 chars per token)
const CHARS_PER_TOKEN = 4;
const MAX_CHUNK_TOKENS = 2000;
const OVERLAP_TOKENS = 200;
// Threshold to trigger chunking. With local models (Ollama), smaller chunks
// are faster and more reliable. With cloud APIs (xAI), 4000 tokens is fine.
const LARGE_NOTE_THRESHOLD_TOKENS = 2500;

const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;
const LARGE_NOTE_THRESHOLD_CHARS = LARGE_NOTE_THRESHOLD_TOKENS * CHARS_PER_TOKEN;

// Deduplication threshold
const DEDUP_COSINE_THRESHOLD = 0.95;

export function resolveLLMConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  const xaiKey = process.env["XAI_API_KEY"];
  if (xaiKey) {
    return {
      baseUrl: overrides?.baseUrl ?? "https://api.x.ai/v1",
      apiKey: overrides?.apiKey ?? xaiKey,
      model: overrides?.model ?? "grok-4.20",
    };
  }
  return {
    baseUrl: overrides?.baseUrl ?? process.env["LLM_BASE_URL"] ?? DEFAULT_LLM_BASE_URL,
    apiKey: overrides?.apiKey ?? process.env["LLM_API_KEY"] ?? DEFAULT_LLM_API_KEY,
    model: overrides?.model ?? process.env["LLM_MODEL"] ?? DEFAULT_LLM_MODEL,
  };
}

// ── Text Chunking ────────────────────────────────────────────────────────────

/**
 * Split text into chunks using a sliding window approach.
 * For text under the threshold, returns a single chunk.
 * For larger text: ~2000-token segments with ~200-token overlap.
 */
export function chunkText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.length <= LARGE_NOTE_THRESHOLD_CHARS) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < trimmed.length) {
    let end = start + MAX_CHUNK_CHARS;

    if (end >= trimmed.length) {
      chunks.push(trimmed.slice(start).trim());
      break;
    }

    // Try to break at a paragraph or sentence boundary
    const segment = trimmed.slice(start, end);
    const lastPara = segment.lastIndexOf("\n\n");
    const lastSentence = segment.lastIndexOf(". ");

    if (lastPara > MAX_CHUNK_CHARS * 0.6) {
      end = start + lastPara + 2;
    } else if (lastSentence > MAX_CHUNK_CHARS * 0.6) {
      end = start + lastSentence + 2;
    }

    chunks.push(trimmed.slice(start, end).trim());
    start = end - OVERLAP_CHARS;
  }

  return chunks;
}

// ── LLM Decomposition ───────────────────────────────────────────────────────

const DECOMPOSITION_PROMPT = `You are an expert knowledge analyst. Your job is to decompose the following text into atomic, verifiable claims.

Rules:
1. Each claim must be a SINGLE, self-contained, verifiable statement
2. Claims should be specific — include names, numbers, dates when present
3. Do NOT include opinions unless attributed (e.g., "X believes Y")
4. Extract entities (people, companies, organizations) mentioned in each claim
5. Provide a domain hint for each claim (e.g., "finance", "technology", "real-estate", "telecommunications", "business-development", "legal", "personnel")

IMPORTANT: Respond with ONLY valid JSON, no markdown fences, no extra text. Do not think step by step — go straight to the JSON output. Use this exact format:
{"claims":[{"content":"claim text here","entities":["Entity1","Entity2"],"domain_hint":"domain"}]}

If the text contains no extractable claims, return: {"claims":[]}

/no_think`;

interface LLMChatResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

/**
 * Call the LLM to decompose a text chunk into atomic claims.
 * Retries up to MAX_RETRIES times on transient failures (fetch errors, timeouts).
 */
export async function decomposeChunk(
  chunk: string,
  config?: Partial<LLMConfig>
): Promise<ExtractedClaim[]> {
  const MAX_RETRIES = 2;
  const llm = resolveLLMConfig(config);
  const url = `${llm.baseUrl}/chat/completions`;

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
            { role: "system", content: DECOMPOSITION_PROMPT },
            { role: "user", content: chunk },
          ],
          temperature: 0.1,
          max_tokens: 4096,
        }),
        signal: AbortSignal.timeout(600_000), // 10-minute timeout per request
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

      return parseLLMResponse(content);
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        // Wait before retrying (2s, then 4s)
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }

  return []; // unreachable but satisfies TypeScript
}

/**
 * Parse the LLM's JSON response into ExtractedClaim objects.
 * Handles common LLM quirks (markdown fences, think tags, trailing text).
 */
export function parseLLMResponse(raw: string): ExtractedClaim[] {
  // Strip <think>...</think> blocks (qwen3 thinking mode)
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  // Strip markdown code fences
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");

  // Find the JSON object
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) {
    return [];
  }
  cleaned = cleaned.slice(jsonStart, jsonEnd + 1);

  try {
    const parsed = JSON.parse(cleaned) as { claims?: unknown[] };
    if (!parsed.claims || !Array.isArray(parsed.claims)) return [];

    return parsed.claims
      .filter(
        (c): c is { content: string; entities?: unknown[]; domain_hint?: string } =>
          typeof c === "object" &&
          c !== null &&
          "content" in c &&
          typeof (c as Record<string, unknown>).content === "string"
      )
      .map((c) => ({
        content: c.content.trim(),
        entities: Array.isArray(c.entities)
          ? c.entities.filter((e): e is string => typeof e === "string")
          : [],
        domainHint: typeof c.domain_hint === "string" ? c.domain_hint : "unknown",
      }))
      .filter((c) => c.content.length > 0);
  } catch {
    return [];
  }
}

// ── Deduplication ────────────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

/**
 * Deduplicate claims by vector similarity. Claims with >0.95 cosine
 * similarity are considered duplicates; the first occurrence is kept.
 */
export async function deduplicateClaims(
  claims: ExtractedClaim[]
): Promise<{ unique: ExtractedClaim[]; embeddings: Map<number, number[]> }> {
  if (claims.length === 0) return { unique: [], embeddings: new Map() };

  // Generate embeddings for all claims
  const embeddings = new Map<number, number[]>();
  for (let i = 0; i < claims.length; i++) {
    try {
      embeddings.set(i, await generateEmbedding(claims[i].content));
    } catch {
      // If embedding fails, keep the claim without dedup ability
      embeddings.set(i, []);
    }
  }

  const unique: ExtractedClaim[] = [];
  const uniqueEmbeddings = new Map<number, number[]>();
  const keptIndices: number[] = [];

  for (let i = 0; i < claims.length; i++) {
    const emb = embeddings.get(i) ?? [];
    let isDuplicate = false;

    if (emb.length > 0) {
      for (const keptIdx of keptIndices) {
        const keptEmb = uniqueEmbeddings.get(keptIdx) ?? [];
        if (keptEmb.length > 0) {
          const sim = cosineSimilarity(emb, keptEmb);
          if (sim >= DEDUP_COSINE_THRESHOLD) {
            isDuplicate = true;
            break;
          }
        }
      }
    }

    if (!isDuplicate) {
      unique.push(claims[i]);
      uniqueEmbeddings.set(unique.length - 1, emb);
      keptIndices.push(i);
    }
  }

  // Remap embeddings to the unique claim indices
  const finalEmbeddings = new Map<number, number[]>();
  for (let i = 0; i < keptIndices.length; i++) {
    finalEmbeddings.set(i, embeddings.get(keptIndices[i]) ?? []);
  }

  return { unique, embeddings: finalEmbeddings };
}

// ── Neo4j Storage ────────────────────────────────────────────────────────────

/**
 * Generate a deterministic claim ID from source and content.
 */
export function generateClaimId(sourceFile: string, index: number): string {
  const sourceSlug = basename(sourceFile, ".md")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `claim-${sourceSlug}-${index}`;
}

/**
 * Store a single claim in Neo4j with all relationships.
 */
function storeClaimInNeo4j(
  claim: ExtractedClaim,
  claimId: string,
  sourceId: string,
  _sourceFile: string,
  domain: string,
  embedding: number[] | null
): StoredClaim {
  const truthScore = 0.7; // agent-populated
  const embeddingStr = embedding && embedding.length > 0 ? `, c.embedding = [${embedding.join(",")}]` : "";

  // Create/update Claim node
  const claimCypher = `MERGE (c:Claim {id: "${escCypher(claimId)}"})
SET c.content = "${escCypher(claim.content)}",
    c.truth_score = ${truthScore},
    c.truth_basis = "agent-populated",
    c.domain = "${escCypher(domain)}",
    c.source_type = "obsidian_vault",
    c.created_by = "lingelpedia_agent",
    c.status = "active",
    c.updated_at = datetime()${embeddingStr}
RETURN c.id;`;

  runCypher(claimCypher);

  // Link to Source node
  const sourceLinkCypher = `MATCH (c:Claim {id: "${escCypher(claimId)}"})
MATCH (s:Source {id: "${escCypher(sourceId)}"})
MERGE (c)-[:SOURCED_FROM]->(s)
RETURN c.id;`;

  try {
    runCypher(sourceLinkCypher);
  } catch {
    // Source may not exist yet if this is a new file; handled below
  }

  // Link to entities via ABOUT relationship
  const linkedEntities: string[] = [];
  for (const entityName of claim.entities) {
    const entityId = generateEntityId(null, entityName);
    const entityCypher = `MERGE (e:Entity {id: "${escCypher(entityId)}"})
ON CREATE SET e.name = "${escCypher(entityName)}", e.entity_type = "unknown", e.truth_score = 0.5, e.created_at = datetime()
SET e.updated_at = datetime()
WITH e
MATCH (c:Claim {id: "${escCypher(claimId)}"})
MERGE (c)-[:ABOUT]->(e)
RETURN e.id;`;

    try {
      runCypher(entityCypher);
      linkedEntities.push(entityName);
    } catch {
      // Best effort — entity linking failure shouldn't stop the pipeline
    }
  }

  return {
    claimId,
    content: claim.content,
    entities: linkedEntities,
    domain,
    truthScore,
    embedding,
  };
}

// ── Main Entry Points ────────────────────────────────────────────────────────

/**
 * Decompose a note's body text into atomic claims and store them in Neo4j.
 *
 * @param bodyText - The markdown body (non-frontmatter) text
 * @param domain - The domain classification (e.g., "gix", "finance", "we")
 * @param sourceFile - Path to the source Obsidian file
 * @param llmConfig - Optional LLM configuration overrides
 */
export async function decomposeNote(
  bodyText: string,
  domain: string,
  sourceFile: string,
  llmConfig?: Partial<LLMConfig>
): Promise<DecompositionResult> {
  const sourceId = generateSourceId(sourceFile);
  const result: DecompositionResult = {
    sourceFile,
    sourceId,
    domain,
    totalChunks: 0,
    rawClaimsExtracted: 0,
    claimsAfterDedup: 0,
    claimsStored: [],
    entitiesLinked: [],
    errors: [],
    success: false,
  };

  try {
    // 1. Ensure Source node exists
    const sourceName = basename(sourceFile);
    const sourceCypher = `MERGE (s:Source {id: "${escCypher(sourceId)}"})
SET s.source_type = "obsidian_vault", s.file_path = "${escCypher(sourceFile)}", s.name = "${escCypher(sourceName)}", s.updated_at = datetime()
RETURN s.id;`;
    runCypher(sourceCypher);

    // 2. Chunk the text
    const chunks = chunkText(bodyText);
    result.totalChunks = chunks.length;

    if (chunks.length === 0) {
      result.success = true;
      return result;
    }

    // 3. Decompose each chunk
    const allClaims: ExtractedClaim[] = [];
    for (let i = 0; i < chunks.length; i++) {
      try {
        const claims = await decomposeChunk(chunks[i], llmConfig);
        allClaims.push(...claims);
      } catch (err) {
        result.errors.push(
          `Chunk ${i + 1}/${chunks.length}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    result.rawClaimsExtracted = allClaims.length;

    if (allClaims.length === 0) {
      result.success = true;
      return result;
    }

    // 4. Deduplicate by vector similarity
    const { unique, embeddings } = await deduplicateClaims(allClaims);
    result.claimsAfterDedup = unique.length;

    // 5. Store each unique claim in Neo4j
    const allLinkedEntities = new Set<string>();
    for (let i = 0; i < unique.length; i++) {
      const claimId = generateClaimId(sourceFile, i);
      const embedding = embeddings.get(i) ?? null;
      const claimDomain = unique[i].domainHint !== "unknown" ? unique[i].domainHint : domain;

      try {
        const stored = storeClaimInNeo4j(
          unique[i],
          claimId,
          sourceId,
          sourceFile,
          claimDomain,
          embedding
        );
        result.claimsStored.push(stored);
        for (const e of stored.entities) allLinkedEntities.add(e);
      } catch (err) {
        result.errors.push(
          `Store claim ${i}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    result.entitiesLinked = [...allLinkedEntities];
    result.success = result.errors.length === 0;
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  return result;
}

/**
 * Parse and decompose an Obsidian note file.
 * Extracts frontmatter for domain classification, then decomposes the body text.
 */
export async function decomposeNoteFile(
  filePath: string,
  domainOverride?: string,
  llmConfig?: Partial<LLMConfig>
): Promise<DecompositionResult> {
  const note = await parseNoteFile(filePath);
  const domain = domainOverride ?? deriveDomainFromNote(note.frontmatter, filePath);
  return decomposeNote(note.body, domain, filePath, llmConfig);
}

/**
 * Parse and decompose an Obsidian note from a string.
 */
export async function decomposeNoteString(
  content: string,
  filePath: string,
  domainOverride?: string,
  llmConfig?: Partial<LLMConfig>
): Promise<DecompositionResult> {
  const note = parseNoteString(content, filePath);
  const domain = domainOverride ?? deriveDomainFromNote(note.frontmatter, filePath);
  return decomposeNote(note.body, domain, filePath, llmConfig);
}

/**
 * Derive domain from note frontmatter tags or file path.
 */
function deriveDomainFromNote(
  frontmatter: Record<string, unknown>,
  filePath: string
): string {
  // Check tags first
  const tags = frontmatter["tags"];
  if (Array.isArray(tags)) {
    const tagStrings = tags.filter((t): t is string => typeof t === "string").map((t) =>
      t.toLowerCase()
    );
    if (tagStrings.includes("gix")) return "gix";
    if (tagStrings.includes("we") || tagStrings.includes("wassonenterprise")) return "we";
    if (tagStrings.includes("finance")) return "finance";
    if (tagStrings.includes("real-estate") || tagStrings.includes("properties")) return "real-estate";
    if (tagStrings.includes("auto")) return "auto";
    if (tagStrings.includes("family-offices")) return "family-offices";
  }

  // Fall back to file path
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.includes("/gix/")) return "gix";
  if (lowerPath.includes("/we/")) return "we";
  if (lowerPath.includes("/finance/")) return "finance";
  if (lowerPath.includes("/properties/")) return "real-estate";
  if (lowerPath.includes("/auto/")) return "auto";
  if (lowerPath.includes("/family offices/") || lowerPath.includes("/family-offices/"))
    return "family-offices";
  if (lowerPath.includes("/people/")) return "people";

  return "unknown";
}
