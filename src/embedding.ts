/**
 * Embedding Pipeline (US-007)
 *
 * Generates vector embeddings via an OpenAI-compatible API and stores/queries
 * them in Neo4j for semantic search, contradiction detection, and the compound
 * interest engine.
 *
 * Default backend: Ollama (local) with nomic-embed-text (768 dimensions).
 * When xAI adds embedding models, change EMBEDDING_BASE_URL to https://api.x.ai/v1.
 *
 * Usage:
 *   import { generateEmbedding, storeClaimEmbedding, findSimilarClaims } from "../src/embedding.js";
 *
 * Environment variables (all optional — defaults to local Ollama):
 *   EMBEDDING_BASE_URL  — default: http://localhost:11434/v1
 *   EMBEDDING_MODEL     — default: nomic-embed-text
 *   EMBEDDING_API_KEY   — default: ollama (Ollama ignores auth)
 *   EMBEDDING_DIMENSIONS — default: 768 (auto-detected from first call)
 */

import { execSync } from "node:child_process";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface SimilarClaim {
  id: string;
  content: string;
  score: number;
  domain: string;
  truthScore: number;
}

interface OpenAIEmbeddingResponse {
  object: string;
  data: Array<{
    object: string;
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_MODEL = "nomic-embed-text";
const DEFAULT_API_KEY = "ollama";

/** Detected dimensions from first embedding call. */
let detectedDimensions: number | null = null;

export function getDetectedDimensions(): number | null {
  return detectedDimensions;
}

function resolveConfig(overrides?: Partial<EmbeddingConfig>): EmbeddingConfig {
  return {
    baseUrl:
      overrides?.baseUrl ??
      process.env["EMBEDDING_BASE_URL"] ??
      DEFAULT_BASE_URL,
    apiKey:
      overrides?.apiKey ??
      process.env["EMBEDDING_API_KEY"] ??
      process.env["XAI_API_KEY"] ??
      DEFAULT_API_KEY,
    model:
      overrides?.model ??
      process.env["EMBEDDING_MODEL"] ??
      DEFAULT_MODEL,
  };
}

// ── Embedding Generation ─────────────────────────────────────────────────────

/**
 * Generate an embedding vector for a single text string.
 */
export async function generateEmbedding(
  text: string,
  configOverrides?: Partial<EmbeddingConfig>
): Promise<number[]> {
  const results = await generateEmbeddings([text], configOverrides);
  return results[0];
}

/**
 * Generate embeddings for multiple texts in a single API call.
 * Returns an array of float arrays in input order.
 */
export async function generateEmbeddings(
  texts: string[],
  configOverrides?: Partial<EmbeddingConfig>
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const config = resolveConfig(configOverrides);
  const url = `${config.baseUrl}/embeddings`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      input: texts,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding API error (HTTP ${response.status}): ${body}`);
  }

  const result = (await response.json()) as OpenAIEmbeddingResponse;

  if (!result.data || result.data.length !== texts.length) {
    throw new Error(
      `Expected ${texts.length} embeddings, got ${result.data?.length ?? 0}`
    );
  }

  // Sort by index to guarantee input order
  const sorted = [...result.data].sort((a, b) => a.index - b.index);
  const embeddings = sorted.map((d) => d.embedding);

  // Detect and validate dimensions consistency
  const dims = embeddings[0].length;
  if (detectedDimensions === null) {
    detectedDimensions = dims;
  } else if (dims !== detectedDimensions) {
    throw new Error(
      `Dimension mismatch: got ${dims}, previously detected ${detectedDimensions}`
    );
  }

  for (let i = 1; i < embeddings.length; i++) {
    if (embeddings[i].length !== dims) {
      throw new Error(
        `Embedding ${i} has ${embeddings[i].length} dimensions, expected ${dims}`
      );
    }
  }

  return embeddings;
}

// ── Neo4j Integration ────────────────────────────────────────────────────────

const NEO4J_CONTAINER = "linglepedia";
const NEO4J_USER = "neo4j";
const NEO4J_PASSWORD = "lingelpedia2026";

function runCypher(query: string, timeoutMs = 15_000): string {
  const result = execSync(
    `docker exec -i ${NEO4J_CONTAINER} cypher-shell -u ${NEO4J_USER} -p ${NEO4J_PASSWORD}`,
    {
      input: query,
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  return result.trim();
}

/**
 * Store an embedding vector on a Claim node in Neo4j.
 * Creates the Claim if it doesn't exist (MERGE on id).
 */
export function storeClaimEmbedding(
  claimId: string,
  embedding: number[],
  properties?: {
    content?: string;
    domain?: string;
    truthScore?: number;
    status?: string;
  }
): void {
  const embeddingStr = `[${embedding.join(",")}]`;
  const setProps: string[] = [`c.embedding = ${embeddingStr}`];

  if (properties?.content !== undefined) {
    setProps.push(`c.content = "${escCypher(properties.content)}"`);
  }
  if (properties?.domain !== undefined) {
    setProps.push(`c.domain = "${escCypher(properties.domain)}"`);
  }
  if (properties?.truthScore !== undefined) {
    setProps.push(`c.truth_score = ${properties.truthScore}`);
  }
  if (properties?.status !== undefined) {
    setProps.push(`c.status = "${escCypher(properties.status)}"`);
  }

  const cypher = `MERGE (c:Claim {id: "${escCypher(claimId)}"})
SET ${setProps.join(", ")}, c.updated_at = datetime()
RETURN c.id;`;

  runCypher(cypher);
}

/**
 * Find the top-N most similar claims to a query embedding using Neo4j vector index.
 */
export function findSimilarClaims(
  queryEmbedding: number[],
  topK = 5,
  minScore = 0.0
): SimilarClaim[] {
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  const cypher = `CALL db.index.vector.queryNodes('claim_embeddings', ${topK}, ${embeddingStr})
YIELD node, score
WHERE score >= ${minScore}
RETURN node.id AS id, node.content AS content, score, node.domain AS domain, node.truth_score AS truthScore
ORDER BY score DESC;`;

  const raw = runCypher(cypher);
  if (!raw || raw.startsWith("0 rows")) return [];

  const lines = raw.split("\n").filter((l) => l.trim() && !l.startsWith("id,") && !l.includes(" rows"));
  return lines.map((line) => {
    const parts = parseCsvLine(line);
    return {
      id: unquote(parts[0]),
      content: unquote(parts[1]),
      score: parseFloat(parts[2]),
      domain: unquote(parts[3]),
      truthScore: parseFloat(parts[4]) || 0,
    };
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escCypher(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function unquote(s: string): string {
  if (!s) return "";
  const trimmed = s.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
        current += '"';
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
