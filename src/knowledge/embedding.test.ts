import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Neo4jConnection } from "./neo4j.js";
import { applySchema } from "./schema.js";
import { EmbeddingPipeline } from "./embedding.js";
import { TelemetryEmitter } from "../telemetry/emitter.js";

/**
 * EmbeddingPipeline tests — requires Neo4j running at bolt://localhost:7687
 *
 * Uses vi.mock to mock OpenAI API calls so tests don't require a real API key.
 * Neo4j integration is tested against the real local instance.
 */

// Mock OpenAI client
const mockEmbeddingsCreate = vi.fn();
vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      embeddings = { create: mockEmbeddingsCreate };
      constructor() {}
    },
  };
});

let connection: Neo4jConnection;
let emitter: TelemetryEmitter;
let pipeline: EmbeddingPipeline;
let tempDir: string;

const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "testpassword";
const TEST_CLAIM_ID = "test-claim-embed-001";
const TEST_CLAIM_ID_2 = "test-claim-embed-002";
const TEST_CLAIM_ID_NOEMBED = "test-claim-embed-003";

function makeFakeEmbedding(dim: number = 1536): number[] {
  return Array.from({ length: dim }, (_, i) => Math.sin(i * 0.01));
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "vega-embedding-test-"));
  emitter = new TelemetryEmitter(tempDir);
  connection = new Neo4jConnection({ password: NEO4J_PASSWORD }, emitter);

  // Ensure schema is applied
  await applySchema(connection, emitter);

  // Create test Claim nodes
  const session = connection.session();
  try {
    await session.run(
      `MERGE (c:Claim {id: $id})
       SET c.content = $content, c.domain = 'test', c.status = 'active', c.truth_tier = 'T3'`,
      { id: TEST_CLAIM_ID, content: "The speed of light in vacuum is approximately 299,792,458 meters per second." },
    );
    await session.run(
      `MERGE (c:Claim {id: $id})
       SET c.content = $content, c.domain = 'test', c.status = 'active', c.truth_tier = 'T3'`,
      { id: TEST_CLAIM_ID_2, content: "Water boils at 100 degrees Celsius at standard atmospheric pressure." },
    );
    await session.run(
      `MERGE (c:Claim {id: $id})
       SET c.content = $content, c.domain = 'test', c.status = 'active', c.truth_tier = 'T3'`,
      { id: TEST_CLAIM_ID_NOEMBED, content: "Gravity accelerates objects at 9.81 m/s^2 on Earth." },
    );
  } finally {
    await session.close();
  }

  // Create pipeline with mock OpenAI
  pipeline = new EmbeddingPipeline(connection, {
    apiKey: "test-key",
    emitter,
  });
});

afterAll(async () => {
  // Clean up test claim nodes
  const session = connection.session();
  try {
    await session.run(
      `MATCH (c:Claim) WHERE c.id IN $ids DETACH DELETE c`,
      { ids: [TEST_CLAIM_ID, TEST_CLAIM_ID_2, TEST_CLAIM_ID_NOEMBED] },
    );
  } finally {
    await session.close();
  }
  if (connection) await connection.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("EmbeddingPipeline", () => {
  it("throws if OPENAI_API_KEY is not provided", () => {
    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => new EmbeddingPipeline(connection, { apiKey: undefined as unknown as string })).toThrow(
        "OPENAI_API_KEY is required",
      );
    } finally {
      if (origKey) process.env.OPENAI_API_KEY = origKey;
    }
  });

  it("embed returns 1536-dimensional Float32Array", async () => {
    const fakeEmbedding = makeFakeEmbedding();
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [{ embedding: fakeEmbedding, index: 0 }],
      usage: { total_tokens: 12 },
    });

    const result = await pipeline.embed("test string");

    expect(result.embedding).toBeInstanceOf(Float32Array);
    expect(result.embedding.length).toBe(1536);
    expect(result.tokens_used).toBe(12);
    expect(mockEmbeddingsCreate).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: ["test string"],
    });
  });

  it("embedBatch handles multiple texts in single API call", async () => {
    const fakeEmbed1 = makeFakeEmbedding();
    const fakeEmbed2 = makeFakeEmbedding();
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [
        { embedding: fakeEmbed1, index: 0 },
        { embedding: fakeEmbed2, index: 1 },
      ],
      usage: { total_tokens: 24 },
    });

    const results = await pipeline.embedBatch(["text one", "text two"]);

    expect(results).toHaveLength(2);
    expect(results[0].embedding.length).toBe(1536);
    expect(results[1].embedding.length).toBe(1536);
    // Each gets proportional token count
    expect(results[0].tokens_used).toBe(12);
    expect(results[1].tokens_used).toBe(12);
  });

  it("embedBatch returns empty array for empty input", async () => {
    const results = await pipeline.embedBatch([]);
    expect(results).toEqual([]);
  });

  it("store embedding in Neo4j and verify it exists on the node", async () => {
    const fakeEmbedding = new Float32Array(makeFakeEmbedding());
    await pipeline.storeEmbedding(TEST_CLAIM_ID, fakeEmbedding);

    // Verify the embedding is stored
    const session = connection.session();
    try {
      const result = await session.run(
        `MATCH (c:Claim {id: $id}) RETURN c.embedding AS emb, c.embedding_updated_at AS ts`,
        { id: TEST_CLAIM_ID },
      );
      expect(result.records.length).toBe(1);
      const storedEmb = result.records[0].get("emb") as number[];
      expect(storedEmb.length).toBe(1536);
      expect(result.records[0].get("ts")).toBeTruthy();
    } finally {
      await session.close();
    }
  });

  it("vector similarity search returns results with scores", async () => {
    // Store embeddings for two claims first
    const embed1 = new Float32Array(makeFakeEmbedding());
    const embed2 = new Float32Array(makeFakeEmbedding().map((v) => v * 0.9));
    await pipeline.storeEmbedding(TEST_CLAIM_ID, embed1);
    await pipeline.storeEmbedding(TEST_CLAIM_ID_2, embed2);

    // Mock the query embedding generation
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [{ embedding: makeFakeEmbedding(), index: 0 }],
      usage: { total_tokens: 8 },
    });

    const results = await pipeline.semanticSearch("speed of light", 5);

    // Should find at least our test claims
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]).toHaveProperty("claimId");
    expect(results[0]).toHaveProperty("content");
    expect(results[0]).toHaveProperty("score");
    expect(typeof results[0].score).toBe("number");
  });

  it("embedAndStore succeeds and emits telemetry", async () => {
    const fakeEmbedding = makeFakeEmbedding();
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [{ embedding: fakeEmbedding, index: 0 }],
      usage: { total_tokens: 15 },
    });

    const result = await pipeline.embedAndStore(TEST_CLAIM_ID_2, "test content for embedding");

    expect(result.success).toBe(true);
    expect(result.tokens_used).toBe(15);
    expect(result.error).toBeUndefined();

    // Verify telemetry
    const events = await emitter.readEvents(new Date());
    const storeEvents = events.filter((e) => e.event_subtype === "embedding_store");
    expect(storeEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("graceful degradation — API failure does not throw, claim remains without embedding", async () => {
    mockEmbeddingsCreate.mockRejectedValue(new Error("API rate limit exceeded"));

    const result = await pipeline.embedAndStore(TEST_CLAIM_ID_NOEMBED, "test content");

    expect(result.success).toBe(false);
    expect(result.error).toContain("API rate limit exceeded");
    expect(result.tokens_used).toBe(0);

    // Verify claim still exists without embedding
    const session = connection.session();
    try {
      const check = await session.run(
        `MATCH (c:Claim {id: $id}) RETURN c.embedding AS emb, c.embedding_pending AS pending`,
        { id: TEST_CLAIM_ID_NOEMBED },
      );
      expect(check.records.length).toBe(1);
      // Embedding should be null (not set)
      expect(check.records[0].get("emb")).toBeNull();
      // Should be flagged for retry
      expect(check.records[0].get("pending")).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("re-embed reads content from Neo4j and updates embedding", async () => {
    const fakeEmbedding = makeFakeEmbedding();
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [{ embedding: fakeEmbedding, index: 0 }],
      usage: { total_tokens: 18 },
    });

    const result = await pipeline.reembed(TEST_CLAIM_ID);

    expect(result.success).toBe(true);
    expect(result.tokens_used).toBe(18);

    // Verify telemetry
    const events = await emitter.readEvents(new Date());
    const reembedEvents = events.filter((e) => e.event_subtype === "embedding_reembed");
    expect(reembedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("re-embed returns error for nonexistent claim", async () => {
    const result = await pipeline.reembed("nonexistent-claim-id");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("exponential backoff retries on transient failures", async () => {
    mockEmbeddingsCreate.mockClear();
    mockEmbeddingsCreate
      .mockRejectedValueOnce(new Error("rate limit"))
      .mockRejectedValueOnce(new Error("rate limit"))
      .mockResolvedValueOnce({
        data: [{ embedding: makeFakeEmbedding(), index: 0 }],
        usage: { total_tokens: 10 },
      });

    const result = await pipeline.embed("retry test");

    expect(result.embedding.length).toBe(1536);
    expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(3);
  }, 15000);

  it("emits cost tracking telemetry with tokens_used", async () => {
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [{ embedding: makeFakeEmbedding(), index: 0 }],
      usage: { total_tokens: 42 },
    });

    await pipeline.embed("cost tracking test");

    const events = await emitter.readEvents(new Date());
    const embedEvents = events.filter(
      (e) => e.event_subtype === "embedding_generate" && e.outcome === "success",
    );
    expect(embedEvents.length).toBeGreaterThanOrEqual(1);
    const latest = embedEvents[embedEvents.length - 1];
    expect(latest.metadata).toHaveProperty("tokens_used", 42);
    expect(latest.model_used).toBe("text-embedding-3-small");
  });
});
