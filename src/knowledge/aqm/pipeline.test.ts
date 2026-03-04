import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AQMPipeline,
  classifyQuery,
  type AQMPipelineResult,
} from "./pipeline.js";
import { SchemaInspector, type SchemaContext } from "./schema-inspector.js";
import {
  QueryConstructor,
  type ConstructedQuery,
  type QueryPattern,
} from "./query-constructor.js";
import { Reranker, type RerankResult, type RankedResult, type GapInfo } from "./reranker.js";
import { Synthesizer, type SynthesisResult, type Citation } from "./synthesizer.js";
import { ModelRouter, type RoutingDecision } from "../model-router.js";
import { TelemetryEmitter } from "../../telemetry/emitter.js";

/**
 * AQM Pipeline tests — verifies query classification, schema inspection,
 * query construction, precision reranking, grounded synthesis, and full
 * pipeline orchestration.
 *
 * Uses mock LLM calls and mock Neo4j sessions for deterministic testing.
 * Does NOT require a running LLM, Neo4j, or OpenAI instance.
 */

let emitter: TelemetryEmitter;
let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "vega-aqm-test-"));
  emitter = new TelemetryEmitter(tempDir);
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── Mock LLM Responses ──────────────────────────────────────────────

const INTEREST_RATE_QUERY: ConstructedQuery = {
  cypher:
    "MATCH (c:Claim)-[:ABOUT]->(e:Entity) " +
    "WHERE c.domain = $domain AND c.content CONTAINS $keyword " +
    "OPTIONAL MATCH (c)-[:SOURCED_FROM]->(s:Source) " +
    "RETURN c.content AS claim, e.name AS entity, c.truth_tier AS tier, " +
    "c.truth_score AS score, s.source_type AS source " +
    "ORDER BY c.truth_score DESC LIMIT $limit",
  parameters: {
    domain: "personal_finance",
    keyword: "interest rate",
    limit: 25,
  },
  description:
    "Find all claims about interest rate exposure across financial entities",
  pattern: "multi_entity_exposure",
};

const ENTITY_LOOKUP_QUERY: ConstructedQuery = {
  cypher:
    "MATCH (c:Claim)-[:ABOUT]->(e:Entity {name: $name}) " +
    "OPTIONAL MATCH (c)-[:SOURCED_FROM]->(s:Source) " +
    "RETURN c.content AS claim, c.truth_tier AS tier, " +
    "c.truth_score AS score, s.source_type AS source " +
    "ORDER BY c.truth_score DESC LIMIT $limit",
  parameters: { name: "Jim LaMarche", limit: 10 },
  description: "Find all claims about Jim LaMarche",
  pattern: "entity_lookup",
};

// ── Query Classification Tests ──────────────────────────────────────

describe("classifyQuery", () => {
  it("classifies simple entity lookup as 'simple'", () => {
    expect(classifyQuery("Who is Jim LaMarche?")).toBe("simple");
  });

  it("classifies 'what is' as simple", () => {
    expect(classifyQuery("What is GIX?")).toBe("simple");
  });

  it("classifies 'tell me about' as simple", () => {
    expect(classifyQuery("Tell me about Blackstone")).toBe("simple");
  });

  it("classifies total exposure question as 'aqm'", () => {
    expect(
      classifyQuery("What is my total exposure to interest rate risk?"),
    ).toBe("aqm");
  });

  it("classifies cascading impact as 'aqm'", () => {
    expect(
      classifyQuery("What happens if interest rates increase by 2%?"),
    ).toBe("aqm");
  });

  it("classifies cross-entity question as 'aqm'", () => {
    expect(
      classifyQuery("How is Jim LaMarche related to Blackstone?"),
    ).toBe("aqm");
  });

  it("classifies temporal question as 'aqm'", () => {
    expect(
      classifyQuery("How has my portfolio changed over the last year?"),
    ).toBe("aqm");
  });

  it("classifies aggregate question as 'aqm'", () => {
    expect(classifyQuery("How many claims do I have across all domains?")).toBe(
      "aqm",
    );
  });

  it("classifies contradiction question as 'aqm'", () => {
    expect(
      classifyQuery("Are there any contradictions in my financial data?"),
    ).toBe("aqm");
  });

  it("classifies multi-proper-noun question as 'aqm'", () => {
    expect(
      classifyQuery(
        "Compare GIX Series B valuation with Blackstone performance",
      ),
    ).toBe("aqm");
  });

  it("classifies short generic question based on length", () => {
    expect(classifyQuery("Show me claims")).toBe("simple");
  });
});

// ── Schema Inspector Tests ──────────────────────────────────────────

describe("SchemaInspector", () => {
  it("returns empty context when no connection", async () => {
    const inspector = new SchemaInspector({ emitter });
    const context = await inspector.inspect();
    expect(context.labels).toEqual([]);
    expect(context.relationshipTypes).toEqual([]);
    expect(context.nodeCounts).toEqual({});
    expect(context.propertyKeys).toEqual({});
    expect(context.sampleData).toEqual({});
  });

  it("returns empty context with domain filter when no connection", async () => {
    const inspector = new SchemaInspector({ emitter });
    const context = await inspector.inspect("personal_finance");
    expect(context.domainFilter).toBe("personal_finance");
    expect(context.labels).toEqual([]);
  });

  it("inspects schema from mock Neo4j connection", async () => {
    const mockSession = {
      run: vi.fn().mockImplementation((cypher: string) => {
        if (cypher === "CALL db.labels()") {
          return {
            records: [
              { get: () => "Claim" },
              { get: () => "Entity" },
            ],
          };
        }
        if (cypher === "CALL db.relationshipTypes()") {
          return {
            records: [
              { get: () => "ABOUT" },
              { get: () => "SOURCED_FROM" },
            ],
          };
        }
        // Node counts
        if (cypher.includes("count(n)")) {
          return {
            records: [
              { get: (k: string) => (k === "label" ? "Claim" : 150) },
              { get: (k: string) => (k === "label" ? "Entity" : 45) },
            ],
          };
        }
        // Property keys
        if (cypher.includes("keys(n)")) {
          return {
            records: [
              {
                get: (k: string) =>
                  k === "label"
                    ? "Claim"
                    : ["id", "content", "domain", "truth_tier"],
              },
              {
                get: (k: string) =>
                  k === "label"
                    ? "Entity"
                    : ["name", "entity_type", "domain"],
              },
            ],
          };
        }
        // Sample data
        if (cypher.includes("properties(n)")) {
          return {
            records: [
              {
                get: () => ({
                  id: "claim-1",
                  content: "Test claim",
                  domain: "gix",
                }),
              },
            ],
          };
        }
        return { records: [] };
      }),
      close: vi.fn(),
    };

    const mockConnection = {
      session: () => mockSession,
    } as unknown as import("../neo4j.js").Neo4jConnection;

    const inspector = new SchemaInspector({
      connection: mockConnection,
      emitter,
    });
    const context = await inspector.inspect();

    expect(context.labels).toContain("Claim");
    expect(context.labels).toContain("Entity");
    expect(context.relationshipTypes).toContain("ABOUT");
    expect(context.relationshipTypes).toContain("SOURCED_FROM");
    expect(mockSession.close).toHaveBeenCalled();
  });

  it("inspectForQuestion returns schema context with relevant samples", async () => {
    const mockSession = {
      run: vi.fn().mockImplementation((cypher: string) => {
        if (cypher === "CALL db.labels()") {
          return {
            records: [{ get: () => "Claim" }, { get: () => "Entity" }],
          };
        }
        if (cypher === "CALL db.relationshipTypes()") {
          return { records: [{ get: () => "ABOUT" }] };
        }
        if (cypher.includes("count(n)")) {
          return {
            records: [
              { get: (k: string) => (k === "label" ? "Claim" : 100) },
              { get: (k: string) => (k === "label" ? "Entity" : 30) },
            ],
          };
        }
        if (cypher.includes("keys(n)")) {
          return {
            records: [
              {
                get: (k: string) =>
                  k === "label" ? "Claim" : ["id", "content", "domain"],
              },
              {
                get: (k: string) =>
                  k === "label" ? "Entity" : ["name", "entity_type"],
              },
            ],
          };
        }
        // Full-text search
        if (cypher.includes("fulltext.queryNodes")) {
          return {
            records: [
              {
                get: (k: string) =>
                  k === "props"
                    ? { id: "c1", content: "Interest rate claim", domain: "personal_finance" }
                    : 0.9,
              },
            ],
          };
        }
        // Generic sample data
        if (cypher.includes("properties(n)")) {
          return {
            records: [
              { get: () => ({ name: "Sample Entity", entity_type: "organization" }) },
            ],
          };
        }
        return { records: [] };
      }),
      close: vi.fn(),
    };

    const mockConnection = {
      session: () => mockSession,
    } as unknown as import("../neo4j.js").Neo4jConnection;

    const inspector = new SchemaInspector({
      connection: mockConnection,
      emitter,
    });
    const context = await inspector.inspectForQuestion(
      "What is my total exposure to interest rate risk?",
    );

    expect(context.labels.length).toBeGreaterThan(0);
    expect(context.sampleData["Claim"]).toBeDefined();
    expect(mockSession.close).toHaveBeenCalled();
  });

  it("handles Neo4j errors gracefully and returns empty context", async () => {
    const mockSession = {
      run: vi.fn().mockRejectedValue(new Error("Connection refused")),
      close: vi.fn(),
    };

    const mockConnection = {
      session: () => mockSession,
    } as unknown as import("../neo4j.js").Neo4jConnection;

    const inspector = new SchemaInspector({
      connection: mockConnection,
      emitter,
    });
    const context = await inspector.inspect();

    expect(context.labels).toEqual([]);
    expect(context.nodeCounts).toEqual({});
    expect(mockSession.close).toHaveBeenCalled();
  });
});

// ── Query Constructor Tests ─────────────────────────────────────────

describe("QueryConstructor", () => {
  let router: ModelRouter;

  beforeAll(() => {
    router = new ModelRouter({
      xaiApiKey: "test-key",
      emitter,
    });
  });

  it("constructs query from LLM response", async () => {
    const mockLlmCall = vi
      .fn()
      .mockResolvedValue(JSON.stringify(INTEREST_RATE_QUERY));

    const constructor = new QueryConstructor({
      router,
      emitter,
      llmCall: mockLlmCall,
    });

    const result = await constructor.construct(
      "What is my total exposure to interest rate risk?",
      {
        labels: ["Claim", "Entity", "Source"],
        relationshipTypes: ["ABOUT", "SOURCED_FROM"],
        propertyKeys: {
          Claim: ["id", "content", "domain", "truth_tier", "truth_score"],
          Entity: ["name", "entity_type", "domain"],
        },
        nodeCounts: { Claim: 150, Entity: 45, Source: 30 },
        sampleData: {},
      },
    );

    expect(result.query).not.toBeNull();
    expect(result.query!.pattern).toBe("multi_entity_exposure");
    expect(result.query!.parameters).toHaveProperty("domain");
    expect(result.query!.cypher).toContain("$domain");
    expect(mockLlmCall).toHaveBeenCalledOnce();
  });

  it("uses parameters — no string interpolation in generated Cypher", async () => {
    const mockLlmCall = vi
      .fn()
      .mockResolvedValue(JSON.stringify(ENTITY_LOOKUP_QUERY));

    const constructor = new QueryConstructor({
      router,
      emitter,
      llmCall: mockLlmCall,
    });

    const result = await constructor.construct("Who is Jim LaMarche?", {
      labels: ["Claim", "Entity"],
      relationshipTypes: ["ABOUT"],
      propertyKeys: {},
      nodeCounts: {},
      sampleData: {},
    });

    expect(result.query).not.toBeNull();
    expect(result.query!.cypher).toContain("$name");
    expect(result.query!.cypher).not.toContain("'Jim LaMarche'");
    expect(result.query!.parameters.name).toBe("Jim LaMarche");
  });

  it("returns null query on unparseable LLM response", async () => {
    const mockLlmCall = vi.fn().mockResolvedValue("not valid json at all");

    const constructor = new QueryConstructor({
      router,
      emitter,
      llmCall: mockLlmCall,
    });

    const result = await constructor.construct("test question", {
      labels: [],
      relationshipTypes: [],
      propertyKeys: {},
      nodeCounts: {},
      sampleData: {},
    });

    expect(result.query).toBeNull();
    expect(result.validated).toBe(false);
  });

  it("strips markdown code fencing from LLM response", () => {
    const constructor = new QueryConstructor({ router, emitter });
    const fenced = "```json\n" + JSON.stringify(INTEREST_RATE_QUERY) + "\n```";
    const parsed = constructor.parseResponse(fenced);
    expect(parsed).not.toBeNull();
    expect(parsed!.pattern).toBe("multi_entity_exposure");
  });

  it("handles empty cypher in response", () => {
    const constructor = new QueryConstructor({ router, emitter });
    const parsed = constructor.parseResponse(
      JSON.stringify({ cypher: "", parameters: {}, description: "empty" }),
    );
    expect(parsed).toBeNull();
  });

  it("defaults unknown pattern to 'general'", () => {
    const constructor = new QueryConstructor({ router, emitter });
    const parsed = constructor.parseResponse(
      JSON.stringify({
        cypher: "MATCH (n) RETURN n LIMIT 10",
        parameters: {},
        description: "test",
        pattern: "unknown_pattern",
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.pattern).toBe("general");
  });

  it("defaults missing parameters to empty object", () => {
    const constructor = new QueryConstructor({ router, emitter });
    const parsed = constructor.parseResponse(
      JSON.stringify({
        cypher: "MATCH (n) RETURN n LIMIT 10",
        description: "test",
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.parameters).toEqual({});
  });

  it("returns null when no router configured", async () => {
    const constructor = new QueryConstructor({ emitter });
    const result = await constructor.construct("test", {
      labels: [],
      relationshipTypes: [],
      propertyKeys: {},
      nodeCounts: {},
      sampleData: {},
    });
    expect(result.query).toBeNull();
    expect(result.validationError).toBe("No router configured");
  });

  it("handles LLM call error gracefully", async () => {
    const mockLlmCall = vi
      .fn()
      .mockRejectedValue(new Error("LLM API error: 500"));

    const constructor = new QueryConstructor({
      router,
      emitter,
      llmCall: mockLlmCall,
    });

    const result = await constructor.construct("test", {
      labels: [],
      relationshipTypes: [],
      propertyKeys: {},
      nodeCounts: {},
      sampleData: {},
    });

    expect(result.query).toBeNull();
    expect(result.validationError).toBe("LLM API error: 500");
    expect(result.fallbackUsed).toBe(false);
  });

  it("validates query with EXPLAIN when connection provided", async () => {
    const mockSession = {
      run: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn(),
    };
    const mockConnection = {
      session: () => mockSession,
    } as unknown as import("../neo4j.js").Neo4jConnection;

    const mockLlmCall = vi
      .fn()
      .mockResolvedValue(JSON.stringify(ENTITY_LOOKUP_QUERY));

    const constructor = new QueryConstructor({
      connection: mockConnection,
      router,
      emitter,
      llmCall: mockLlmCall,
    });

    const result = await constructor.construct("Who is Jim LaMarche?", {
      labels: ["Claim", "Entity"],
      relationshipTypes: ["ABOUT"],
      propertyKeys: {},
      nodeCounts: {},
      sampleData: {},
    });

    expect(result.query).not.toBeNull();
    expect(result.validated).toBe(true);
    // EXPLAIN should have been called
    expect(mockSession.run).toHaveBeenCalledWith(
      expect.stringContaining("EXPLAIN"),
      expect.any(Object),
    );
  });

  it("reports validation error when EXPLAIN fails", async () => {
    const mockSession = {
      run: vi.fn().mockRejectedValue(new Error("Invalid query syntax")),
      close: vi.fn(),
    };
    const mockConnection = {
      session: () => mockSession,
    } as unknown as import("../neo4j.js").Neo4jConnection;

    const mockLlmCall = vi
      .fn()
      .mockResolvedValue(JSON.stringify(ENTITY_LOOKUP_QUERY));

    const constructor = new QueryConstructor({
      connection: mockConnection,
      router,
      emitter,
      llmCall: mockLlmCall,
    });

    const result = await constructor.construct("test", {
      labels: [],
      relationshipTypes: [],
      propertyKeys: {},
      nodeCounts: {},
      sampleData: {},
    });

    expect(result.validated).toBe(false);
    expect(result.validationError).toBe("Invalid query syntax");
  });
});

// ── Reranker Tests (Stage 3) ────────────────────────────────────────

describe("Reranker", () => {
  it("scores results using composite formula", async () => {
    const reranker = new Reranker({ emitter });

    const today = new Date().toISOString();
    const result = await reranker.rerank({
      queryResults: [
        {
          id: "claim-1",
          content: "Variable rate mortgage at 6.5%",
          truth_tier: "single_source",
          truth_score: 0.7,
          score: 0.85,
          domain: "personal_finance",
          updated_at: today,
        },
      ],
      question: "What is my interest rate exposure?",
    });

    expect(result.ranked.length).toBe(1);
    const ranked = result.ranked[0];
    // score = (0.85 × 0.4) + (0.6 × 0.35) + (recency × 0.25)
    // recency for today ≈ 1.0
    // score ≈ 0.34 + 0.21 + 0.25 = 0.80
    expect(ranked.score).toBeGreaterThan(0.7);
    expect(ranked.score).toBeLessThanOrEqual(1.0);
    expect(ranked.components.semantic_similarity).toBeCloseTo(0.85, 2);
    expect(ranked.components.truth_tier_weight).toBe(0.6);
  });

  it("ranks family_direct above single_source for same semantic similarity", async () => {
    const reranker = new Reranker({ emitter });

    const today = new Date().toISOString();
    const result = await reranker.rerank({
      queryResults: [
        {
          id: "claim-single",
          content: "Claim from single source",
          truth_tier: "single_source",
          score: 0.9,
          updated_at: today,
        },
        {
          id: "claim-family",
          content: "Claim from family member",
          truth_tier: "family_direct",
          score: 0.9,
          updated_at: today,
        },
      ],
      question: "test question",
    });

    expect(result.ranked.length).toBe(2);
    // family_direct (weight 1.0) should outrank single_source (weight 0.6)
    expect(result.ranked[0].truthTier).toBe("family_direct");
    expect(result.ranked[1].truthTier).toBe("single_source");
    expect(result.ranked[0].score).toBeGreaterThan(result.ranked[1].score);
  });

  it("applies truth tier weights correctly", () => {
    const reranker = new Reranker({ emitter });
    expect(reranker.getTruthTierWeight("family_direct")).toBe(1.0);
    expect(reranker.getTruthTierWeight("multi_source_verified")).toBe(0.85);
    expect(reranker.getTruthTierWeight("single_source")).toBe(0.6);
    expect(reranker.getTruthTierWeight("agent_inferred")).toBe(0.4);
    // Unknown tiers default to agent_inferred weight
    expect(reranker.getTruthTierWeight("unknown")).toBe(0.4);
  });

  it("calculates recency decay — today is 1.0, old is near 0", () => {
    const reranker = new Reranker({ emitter, recencyWindowDays: 365 });

    const today = new Date().toISOString();
    expect(reranker.calculateRecencyDecay(today)).toBeCloseTo(1.0, 1);

    // 365 days ago should be very low
    const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    expect(reranker.calculateRecencyDecay(yearAgo)).toBeLessThan(0.1);

    // 30 days ago should be moderate
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const monthDecay = reranker.calculateRecencyDecay(monthAgo);
    expect(monthDecay).toBeGreaterThan(0.5);
    expect(monthDecay).toBeLessThan(1.0);
  });

  it("handles null/invalid dates with default 0.5 score", () => {
    const reranker = new Reranker({ emitter });
    expect(reranker.calculateRecencyDecay(null)).toBe(0.5);
    expect(reranker.calculateRecencyDecay(undefined)).toBe(0.5);
    expect(reranker.calculateRecencyDecay("not-a-date")).toBe(0.5);
  });

  it("detects domain gaps in results", async () => {
    const reranker = new Reranker({ emitter });

    const result = await reranker.rerank({
      queryResults: [
        {
          id: "c1",
          content: "GIX Series A at $10M",
          domain: "gix",
          truth_tier: "single_source",
          score: 0.8,
        },
      ],
      question: "What is my total financial exposure across all accounts?",
      knownDomains: ["personal_finance", "gix"],
    });

    // Should detect personal_finance gap since question mentions finance
    const financeGap = result.gaps.find(
      (g) => g.type === "domain" && g.value === "personal_finance",
    );
    expect(financeGap).toBeDefined();
    expect(financeGap!.reason).toContain("personal_finance");
  });

  it("returns empty ranked array for empty input", async () => {
    const reranker = new Reranker({ emitter });

    const result = await reranker.rerank({
      queryResults: [],
      question: "test question",
    });

    expect(result.ranked).toEqual([]);
    expect(result.stats.total_input).toBe(0);
    expect(result.stats.total_output).toBe(0);
    expect(result.stats.avg_score).toBe(0);
  });

  it("sorts results by composite score descending", async () => {
    const reranker = new Reranker({ emitter });

    const today = new Date().toISOString();
    const result = await reranker.rerank({
      queryResults: [
        { id: "low", truth_tier: "agent_inferred", score: 0.3, updated_at: today },
        { id: "high", truth_tier: "family_direct", score: 0.95, updated_at: today },
        { id: "mid", truth_tier: "single_source", score: 0.7, updated_at: today },
      ],
      question: "test",
    });

    expect(result.ranked[0].claimId).toBe("high");
    expect(result.ranked[result.ranked.length - 1].claimId).toBe("low");
    // Verify sorted descending
    for (let i = 1; i < result.ranked.length; i++) {
      expect(result.ranked[i - 1].score).toBeGreaterThanOrEqual(result.ranked[i].score);
    }
  });

  it("computes average score in stats", async () => {
    const reranker = new Reranker({ emitter });

    const today = new Date().toISOString();
    const result = await reranker.rerank({
      queryResults: [
        { id: "a", truth_tier: "family_direct", score: 0.9, updated_at: today },
        { id: "b", truth_tier: "family_direct", score: 0.9, updated_at: today },
      ],
      question: "test",
    });

    expect(result.stats.avg_score).toBeGreaterThan(0);
    expect(result.stats.total_input).toBe(2);
    expect(result.stats.total_output).toBe(2);
  });

  it("emits telemetry for reranking", async () => {
    const emitSpy = vi.spyOn(emitter, "emit");
    emitSpy.mockClear();

    const reranker = new Reranker({ emitter });
    await reranker.rerank({
      queryResults: [
        { id: "c1", truth_tier: "single_source", score: 0.8 },
      ],
      question: "test",
    });

    const rerankEvents = emitSpy.mock.calls.filter(
      (call) => (call[0] as { event_subtype: string }).event_subtype === "rerank_complete",
    );
    expect(rerankEvents.length).toBe(1);

    emitSpy.mockRestore();
  });
});

// ── Synthesizer Tests (Stage 4) ────────────────────────────────────

describe("Synthesizer", () => {
  let router: ModelRouter;

  beforeAll(() => {
    router = new ModelRouter({
      xaiApiKey: "test-key",
      emitter,
    });
  });

  it("produces grounded answer with inline citations", async () => {
    const mockLlmCall = vi.fn().mockResolvedValue(
      JSON.stringify({
        answer:
          "Your variable rate mortgage is at 6.5% [Claim ID: claim-1 | truth_tier: single_source | truth_score: 0.7]. " +
          "Based on family input, your total exposure is approximately $500K [Claim ID: claim-2 | truth_tier: family_direct | truth_score: 0.95].",
        inference_chain: [
          {
            inference: "Combined variable rate + family direct data shows total exposure",
            supporting_claims: ["claim-1", "claim-2"],
          },
        ],
        gaps: ["No data on fixed-rate accounts"],
        confidence: 0.82,
      }),
    );

    const synthesizer = new Synthesizer({
      router,
      emitter,
      llmCall: mockLlmCall,
    });

    const rankedResults: RankedResult[] = [
      {
        data: { id: "claim-2", content: "Total exposure ~$500K from family", truth_tier: "family_direct", truth_score: 0.95 },
        score: 0.92,
        components: { semantic_similarity: 0.9, truth_tier_weight: 1.0, recency_decay: 0.85 },
        truthTier: "family_direct",
        claimId: "claim-2",
      },
      {
        data: { id: "claim-1", content: "Variable rate mortgage at 6.5%", truth_tier: "single_source", truth_score: 0.7 },
        score: 0.78,
        components: { semantic_similarity: 0.85, truth_tier_weight: 0.6, recency_decay: 0.9 },
        truthTier: "single_source",
        claimId: "claim-1",
      },
    ];

    const result = await synthesizer.synthesize({
      question: "What is my total interest rate exposure?",
      rankedResults,
      gaps: [],
      queryUsed: "MATCH (c:Claim) ...",
    });

    expect(result.answer).toContain("[Claim ID:");
    expect(result.answer).toContain("truth_tier:");
    expect(result.citations.length).toBe(2);
    expect(result.citations[0].claimId).toBe("claim-2");
    expect(result.citations[0].formatted).toContain("family_direct");
    expect(result.confidence).toBeCloseTo(0.82, 1);
    expect(result.inferenceChain.length).toBe(1);
    expect(result.inferenceChain[0].supportingClaims).toContain("claim-1");
    expect(result.queryUsed).toBe("MATCH (c:Claim) ...");
  });

  it("returns 'No knowledge available' for empty results", async () => {
    const synthesizer = new Synthesizer({ router, emitter });

    const result = await synthesizer.synthesize({
      question: "What is my exposure?",
      rankedResults: [],
      gaps: [{ type: "domain", value: "personal_finance", reason: "No finance data" }],
    });

    expect(result.answer).toBe("No knowledge available for this question.");
    expect(result.citations).toEqual([]);
    expect(result.confidence).toBe(0);
    expect(result.gaps).toContain("No finance data");
  });

  it("includes inference chains in synthesis", async () => {
    const mockLlmCall = vi.fn().mockResolvedValue(
      JSON.stringify({
        answer: "Based on multiple claims...",
        inference_chain: [
          {
            inference: "Combining claim-1 and claim-2 shows a pattern",
            supporting_claims: ["claim-1", "claim-2"],
          },
          {
            inference: "This pattern suggests increasing exposure",
            supporting_claims: ["claim-2", "claim-3"],
          },
        ],
        gaps: [],
        confidence: 0.75,
      }),
    );

    const synthesizer = new Synthesizer({ router, emitter, llmCall: mockLlmCall });

    const result = await synthesizer.synthesize({
      question: "test",
      rankedResults: [
        { data: { id: "claim-1" }, score: 0.9, components: { semantic_similarity: 0.9, truth_tier_weight: 1.0, recency_decay: 0.8 }, truthTier: "family_direct", claimId: "claim-1" },
        { data: { id: "claim-2" }, score: 0.8, components: { semantic_similarity: 0.8, truth_tier_weight: 0.85, recency_decay: 0.7 }, truthTier: "multi_source_verified", claimId: "claim-2" },
        { data: { id: "claim-3" }, score: 0.7, components: { semantic_similarity: 0.7, truth_tier_weight: 0.6, recency_decay: 0.9 }, truthTier: "single_source", claimId: "claim-3" },
      ],
      gaps: [],
    });

    expect(result.inferenceChain.length).toBe(2);
    expect(result.inferenceChain[0].supportingClaims).toContain("claim-1");
    expect(result.inferenceChain[1].supportingClaims).toContain("claim-3");
  });

  it("includes gaps from both reranker and synthesis", async () => {
    const mockLlmCall = vi.fn().mockResolvedValue(
      JSON.stringify({
        answer: "Partial answer...",
        inference_chain: [],
        gaps: ["Missing fixed-rate account data", "No tax implications data"],
        confidence: 0.5,
      }),
    );

    const synthesizer = new Synthesizer({ router, emitter, llmCall: mockLlmCall });

    const result = await synthesizer.synthesize({
      question: "test",
      rankedResults: [
        { data: { id: "c1" }, score: 0.7, components: { semantic_similarity: 0.7, truth_tier_weight: 0.6, recency_decay: 0.8 }, truthTier: "single_source", claimId: "c1" },
      ],
      gaps: [{ type: "domain", value: "legal", reason: "No legal data found" }],
    });

    // Should include both LLM-identified gaps and reranker gaps
    expect(result.gaps).toContain("Missing fixed-rate account data");
    expect(result.gaps).toContain("No tax implications data");
    expect(result.gaps).toContain("No legal data found");
  });

  it("uses frontier model for synthesis — never local", () => {
    const spiedRouter = new ModelRouter({
      xaiApiKey: "test-key",
      emitter,
    });

    expect(spiedRouter.isFrontierOnly("aqm_synthesis")).toBe(true);
  });

  it("falls back to simple synthesis when LLM response is unparseable", async () => {
    const mockLlmCall = vi.fn().mockResolvedValue("not valid json");

    const synthesizer = new Synthesizer({ router, emitter, llmCall: mockLlmCall });

    const result = await synthesizer.synthesize({
      question: "test",
      rankedResults: [
        {
          data: { id: "c1", content: "Test claim content", truth_tier: "single_source", truth_score: 0.7 },
          score: 0.75,
          components: { semantic_similarity: 0.8, truth_tier_weight: 0.6, recency_decay: 0.9 },
          truthTier: "single_source",
          claimId: "c1",
        },
      ],
      gaps: [],
    });

    // Fallback should still produce an answer
    expect(result.answer).toContain("Test claim content");
    expect(result.citations.length).toBe(1);
  });

  it("falls back when LLM call throws", async () => {
    const mockLlmCall = vi.fn().mockRejectedValue(new Error("LLM timeout"));

    const synthesizer = new Synthesizer({ router, emitter, llmCall: mockLlmCall });

    const result = await synthesizer.synthesize({
      question: "test",
      rankedResults: [
        {
          data: { id: "c1", content: "Fallback claim", truth_score: 0.6 },
          score: 0.65,
          components: { semantic_similarity: 0.7, truth_tier_weight: 0.6, recency_decay: 0.5 },
          truthTier: "single_source",
          claimId: "c1",
        },
      ],
      gaps: [],
    });

    expect(result.answer).toContain("Fallback claim");
    expect(result.citations.length).toBe(1);
  });

  it("parseResponse strips markdown code fencing", () => {
    const synthesizer = new Synthesizer({ emitter });
    const response = JSON.stringify({
      answer: "Test answer",
      inference_chain: [],
      gaps: [],
      confidence: 0.8,
    });
    const fenced = "```json\n" + response + "\n```";
    const parsed = synthesizer.parseResponse(fenced);
    expect(parsed).not.toBeNull();
    expect(parsed!.answer).toBe("Test answer");
    expect(parsed!.confidence).toBe(0.8);
  });

  it("parseResponse returns null for invalid JSON", () => {
    const synthesizer = new Synthesizer({ emitter });
    expect(synthesizer.parseResponse("not json")).toBeNull();
  });

  it("parseResponse returns null for missing answer field", () => {
    const synthesizer = new Synthesizer({ emitter });
    expect(
      synthesizer.parseResponse(JSON.stringify({ confidence: 0.5 })),
    ).toBeNull();
  });

  it("builds citations with correct format", async () => {
    const mockLlmCall = vi.fn().mockResolvedValue(
      JSON.stringify({
        answer: "Test answer [Claim ID: c1 | truth_tier: family_direct | truth_score: 0.95]",
        inference_chain: [],
        gaps: [],
        confidence: 0.9,
      }),
    );

    const synthesizer = new Synthesizer({ router, emitter, llmCall: mockLlmCall });

    const result = await synthesizer.synthesize({
      question: "test",
      rankedResults: [
        {
          data: { id: "c1", content: "Family claim", truth_tier: "family_direct", truth_score: 0.95 },
          score: 0.95,
          components: { semantic_similarity: 0.9, truth_tier_weight: 1.0, recency_decay: 0.95 },
          truthTier: "family_direct",
          claimId: "c1",
        },
      ],
      gaps: [],
    });

    expect(result.citations[0].formatted).toBe(
      "[Claim ID: c1 | truth_tier: family_direct | truth_score: 0.95]",
    );
  });

  it("emits telemetry for synthesis", async () => {
    const emitSpy = vi.spyOn(emitter, "emit");
    emitSpy.mockClear();

    const mockLlmCall = vi.fn().mockResolvedValue(
      JSON.stringify({
        answer: "Test",
        inference_chain: [],
        gaps: [],
        confidence: 0.7,
      }),
    );

    const synthesizer = new Synthesizer({ router, emitter, llmCall: mockLlmCall });
    await synthesizer.synthesize({
      question: "test",
      rankedResults: [
        { data: { id: "c1" }, score: 0.7, components: { semantic_similarity: 0.7, truth_tier_weight: 0.6, recency_decay: 0.8 }, truthTier: "single_source", claimId: "c1" },
      ],
      gaps: [],
    });

    const synthEvents = emitSpy.mock.calls.filter(
      (call) => (call[0] as { event_subtype: string }).event_subtype === "synthesis_complete",
    );
    expect(synthEvents.length).toBe(1);

    emitSpy.mockRestore();
  });

  it("produces fallback synthesis when no router available", async () => {
    const synthesizer = new Synthesizer({ emitter });

    const result = await synthesizer.synthesize({
      question: "test",
      rankedResults: [
        {
          data: { id: "c1", content: "No-router claim" },
          score: 0.6,
          components: { semantic_similarity: 0.6, truth_tier_weight: 0.6, recency_decay: 0.5 },
          truthTier: "single_source",
          claimId: "c1",
        },
      ],
      gaps: [],
    });

    expect(result.answer).toContain("No-router claim");
    expect(result.inferenceChain).toEqual([]);
  });
});

// ── Pipeline Orchestrator Tests ─────────────────────────────────────

describe("AQMPipeline", () => {
  let router: ModelRouter;

  beforeAll(() => {
    router = new ModelRouter({
      xaiApiKey: "test-key",
      emitter,
    });
  });

  it("routes simple question to simple retrieval, NOT AQM", async () => {
    const pipeline = new AQMPipeline({ router, emitter });
    const result = await pipeline.query("Who is Jim LaMarche?");

    expect(result.classification).toBe("simple");
    expect(result.stage1).toBeUndefined();
    expect(result.stage2).toBeUndefined();
    expect(result.stage3).toBeUndefined();
    expect(result.stage4).toBeUndefined();
    expect(result.fallbackUsed).toBe(false);
    expect(result.timing.classification_ms).toBeGreaterThanOrEqual(0);
  });

  it("runs full 4-stage pipeline for complex AQM question", async () => {
    const mockSchemaContext: SchemaContext = {
      labels: ["Claim", "Entity", "Source"],
      relationshipTypes: ["ABOUT", "SOURCED_FROM"],
      propertyKeys: {
        Claim: ["id", "content", "domain", "truth_tier"],
        Entity: ["name", "entity_type"],
      },
      nodeCounts: { Claim: 150, Entity: 45 },
      sampleData: {
        Claim: [
          { id: "c1", content: "Interest rate risk on variable accounts", domain: "personal_finance" },
        ],
      },
    };

    const mockInspector = {
      inspect: vi.fn().mockResolvedValue(mockSchemaContext),
      inspectForQuestion: vi.fn().mockResolvedValue(mockSchemaContext),
    } as unknown as SchemaInspector;

    const mockConstructor = {
      construct: vi.fn().mockResolvedValue({
        query: INTEREST_RATE_QUERY,
        validated: true,
        fallbackUsed: false,
      }),
    } as unknown as QueryConstructor;

    // Mock connection for query execution
    const mockSession = {
      run: vi.fn().mockResolvedValue({
        records: [
          {
            keys: ["claim", "entity", "tier", "score"],
            get: (k: string) => {
              const data: Record<string, unknown> = {
                claim: "Variable rate mortgage at 6.5%",
                entity: "Chase Mortgage",
                tier: "single_source",
                score: 0.7,
              };
              return data[k];
            },
          },
        ],
      }),
      close: vi.fn(),
    };
    const mockConnection = {
      session: () => mockSession,
    } as unknown as import("../neo4j.js").Neo4jConnection;

    const pipeline = new AQMPipeline({
      connection: mockConnection,
      router,
      emitter,
      schemaInspector: mockInspector,
      queryConstructor: mockConstructor,
    });

    const result = await pipeline.query(
      "What is my total exposure to interest rate risk?",
    );

    expect(result.classification).toBe("aqm");
    expect(result.stage1).toBeDefined();
    expect(result.stage1!.schemaContext.labels).toContain("Claim");
    expect(result.stage2).toBeDefined();
    expect(result.stage2!.queryResults).not.toBeNull();
    expect(result.stage2!.queryResults!.length).toBe(1);
    expect(result.stage3).toBeDefined();
    expect(result.stage3!.rerankResult.ranked.length).toBe(1);
    expect(result.stage4).toBeDefined();
    expect(result.stage4!.synthesisResult.answer).toBeDefined();
    expect(result.answer).toBeDefined();
    expect(result.fallbackUsed).toBe(false);
    expect(result.timing.stage1_ms).toBeGreaterThanOrEqual(0);
    expect(result.timing.stage2_ms).toBeGreaterThanOrEqual(0);
    expect(result.timing.stage3_ms).toBeGreaterThanOrEqual(0);
    expect(result.timing.stage4_ms).toBeGreaterThanOrEqual(0);
  });

  it("Stage 1 inspects financial entities for exposure question", async () => {
    const mockInspector = {
      inspectForQuestion: vi.fn().mockResolvedValue({
        labels: ["Claim", "Entity"],
        relationshipTypes: ["ABOUT"],
        propertyKeys: { Claim: ["content", "domain"] },
        nodeCounts: { Claim: 200 },
        sampleData: {
          Claim: [{ content: "Interest rate data", domain: "personal_finance" }],
        },
      }),
    } as unknown as SchemaInspector;

    const mockConstructor = {
      construct: vi.fn().mockResolvedValue({
        query: INTEREST_RATE_QUERY,
        validated: false,
        fallbackUsed: false,
      }),
    } as unknown as QueryConstructor;

    const pipeline = new AQMPipeline({
      router,
      emitter,
      schemaInspector: mockInspector,
      queryConstructor: mockConstructor,
    });

    const result = await pipeline.query(
      "What is my total exposure to interest rate risk?",
    );

    expect(mockInspector.inspectForQuestion).toHaveBeenCalledWith(
      "What is my total exposure to interest rate risk?",
    );
    expect(result.stage1!.schemaContext.labels).toContain("Claim");
  });

  it("Stage 2 generates multi-hop Cypher for exposure question", async () => {
    const mockInspector = {
      inspectForQuestion: vi.fn().mockResolvedValue({
        labels: ["Claim", "Entity"],
        relationshipTypes: ["ABOUT"],
        propertyKeys: {},
        nodeCounts: {},
        sampleData: {},
      }),
    } as unknown as SchemaInspector;

    const mockConstructor = {
      construct: vi.fn().mockResolvedValue({
        query: INTEREST_RATE_QUERY,
        validated: false,
        fallbackUsed: false,
      }),
    } as unknown as QueryConstructor;

    const pipeline = new AQMPipeline({
      router,
      emitter,
      schemaInspector: mockInspector,
      queryConstructor: mockConstructor,
    });

    await pipeline.query(
      "What is my total exposure to interest rate risk?",
    );

    expect(mockConstructor.construct).toHaveBeenCalledWith(
      "What is my total exposure to interest rate risk?",
      expect.objectContaining({ labels: expect.any(Array) }),
    );
  });

  it("falls back to vector search when query construction fails", async () => {
    const mockInspector = {
      inspectForQuestion: vi.fn().mockResolvedValue({
        labels: [],
        relationshipTypes: [],
        propertyKeys: {},
        nodeCounts: {},
        sampleData: {},
      }),
    } as unknown as SchemaInspector;

    const mockConstructor = {
      construct: vi.fn().mockResolvedValue({
        query: null,
        validated: false,
        validationError: "Failed to parse LLM response",
        fallbackUsed: false,
      }),
    } as unknown as QueryConstructor;

    const mockEmbedding = {
      semanticSearch: vi.fn().mockResolvedValue([
        { claimId: "c1", content: "Relevant claim", score: 0.85 },
      ]),
    } as unknown as import("../embedding.js").EmbeddingPipeline;

    const pipeline = new AQMPipeline({
      router,
      emitter,
      embedding: mockEmbedding,
      schemaInspector: mockInspector,
      queryConstructor: mockConstructor,
    });

    const result = await pipeline.query("What are all my interest rate risks?");

    expect(result.classification).toBe("aqm");
    expect(result.fallbackUsed).toBe(true);
    expect(result.simpleResults).toBeDefined();
    expect(result.simpleResults!.length).toBe(1);
    expect(result.error).toBeDefined();
  });

  it("falls back when query execution fails", async () => {
    const mockInspector = {
      inspectForQuestion: vi.fn().mockResolvedValue({
        labels: ["Claim"],
        relationshipTypes: [],
        propertyKeys: {},
        nodeCounts: {},
        sampleData: {},
      }),
    } as unknown as SchemaInspector;

    const mockConstructor = {
      construct: vi.fn().mockResolvedValue({
        query: INTEREST_RATE_QUERY,
        validated: false,
        validationError: "Validation failed",
        fallbackUsed: false,
      }),
    } as unknown as QueryConstructor;

    // Mock a failing Neo4j connection
    const mockSession = {
      run: vi.fn().mockRejectedValue(new Error("Query execution failed")),
      close: vi.fn(),
    };
    const mockConnection = {
      session: () => mockSession,
    } as unknown as import("../neo4j.js").Neo4jConnection;

    const mockEmbedding = {
      semanticSearch: vi.fn().mockResolvedValue([]),
    } as unknown as import("../embedding.js").EmbeddingPipeline;

    const pipeline = new AQMPipeline({
      connection: mockConnection,
      router,
      emitter,
      embedding: mockEmbedding,
      schemaInspector: mockInspector,
      queryConstructor: mockConstructor,
    });

    const result = await pipeline.query("What are all my interest rate risks?");

    expect(result.fallbackUsed).toBe(true);
  });

  it("uses AQM exclusively with frontier model — never local", async () => {
    // Verify routing goes through aqm_query task type
    const spiedRouter = new ModelRouter({
      xaiApiKey: "test-key",
      emitter,
    });
    const routeSpy = vi.spyOn(spiedRouter, "route");

    expect(spiedRouter.isFrontierOnly("aqm_query")).toBe(true);
    expect(spiedRouter.isFrontierOnly("aqm_synthesis")).toBe(true);

    // Verify routing returns frontier tier
    const routing = await spiedRouter.route("aqm_query");
    expect(routing.tier).toBe("frontier");
    expect(routing.model).toBe("grok-4-1-fast-reasoning");

    routeSpy.mockRestore();
  });

  it("includes timing information for all stages", async () => {
    const mockInspector = {
      inspectForQuestion: vi.fn().mockResolvedValue({
        labels: ["Claim"],
        relationshipTypes: [],
        propertyKeys: {},
        nodeCounts: {},
        sampleData: {},
      }),
    } as unknown as SchemaInspector;

    const mockConstructor = {
      construct: vi.fn().mockResolvedValue({
        query: {
          cypher: "MATCH (c:Claim) RETURN c.content AS content LIMIT 10",
          parameters: {},
          description: "test",
          pattern: "general" as QueryPattern,
        },
        validated: true,
        fallbackUsed: false,
      }),
    } as unknown as QueryConstructor;

    const mockSession = {
      run: vi.fn().mockResolvedValue({
        records: [
          {
            keys: ["content"],
            get: () => "Test claim",
          },
        ],
      }),
      close: vi.fn(),
    };
    const mockConnection = {
      session: () => mockSession,
    } as unknown as import("../neo4j.js").Neo4jConnection;

    const pipeline = new AQMPipeline({
      connection: mockConnection,
      router,
      emitter,
      schemaInspector: mockInspector,
      queryConstructor: mockConstructor,
    });

    const result = await pipeline.query(
      "What is my total exposure to interest rate risk?",
    );

    expect(result.timing.classification_ms).toBeGreaterThanOrEqual(0);
    expect(result.timing.stage1_ms).toBeGreaterThanOrEqual(0);
    expect(result.timing.stage2_ms).toBeGreaterThanOrEqual(0);
    expect(result.timing.stage3_ms).toBeGreaterThanOrEqual(0);
    expect(result.timing.stage4_ms).toBeGreaterThanOrEqual(0);
    expect(result.timing.total_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns answer, citations, gaps, confidence from full pipeline", async () => {
    const mockInspector = {
      inspectForQuestion: vi.fn().mockResolvedValue({
        labels: ["Claim", "Entity"],
        relationshipTypes: ["ABOUT"],
        propertyKeys: {},
        nodeCounts: {},
        sampleData: {},
      }),
    } as unknown as SchemaInspector;

    const mockConstructor = {
      construct: vi.fn().mockResolvedValue({
        query: INTEREST_RATE_QUERY,
        validated: true,
        fallbackUsed: false,
      }),
    } as unknown as QueryConstructor;

    const mockSession = {
      run: vi.fn().mockResolvedValue({
        records: [
          {
            keys: ["claim", "entity", "tier", "score", "id"],
            get: (k: string) => {
              const data: Record<string, unknown> = {
                claim: "Chase variable rate at 6.5%",
                entity: "Chase Mortgage",
                tier: "family_direct",
                score: 0.95,
                id: "claim-chase",
              };
              return data[k];
            },
          },
        ],
      }),
      close: vi.fn(),
    };
    const mockConnection = {
      session: () => mockSession,
    } as unknown as import("../neo4j.js").Neo4jConnection;

    const pipeline = new AQMPipeline({
      connection: mockConnection,
      router,
      emitter,
      schemaInspector: mockInspector,
      queryConstructor: mockConstructor,
    });

    const result = await pipeline.query(
      "What is my total exposure to interest rate risk?",
    );

    // Full pipeline should populate answer, citations, gaps, confidence
    expect(result.answer).toBeDefined();
    expect(typeof result.answer).toBe("string");
    expect(result.citations).toBeDefined();
    expect(Array.isArray(result.citations)).toBe(true);
    expect(result.gaps).toBeDefined();
    expect(typeof result.confidence).toBe("number");
    expect(result.queryUsed).toBeDefined();
  });

  it("emits telemetry events for classification", async () => {
    const emitSpy = vi.spyOn(emitter, "emit");
    emitSpy.mockClear();

    const pipeline = new AQMPipeline({ router, emitter });
    await pipeline.query("Who is Jim LaMarche?");

    const classificationEvents = emitSpy.mock.calls.filter(
      (call) => (call[0] as { event_subtype: string }).event_subtype === "aqm_classification",
    );
    expect(classificationEvents.length).toBe(1);
    expect(
      (classificationEvents[0][0] as { metadata: Record<string, unknown> }).metadata,
    ).toHaveProperty("classification", "simple");

    emitSpy.mockRestore();
  });

  it("emits telemetry for AQM pipeline completion", async () => {
    const emitSpy = vi.spyOn(emitter, "emit");
    emitSpy.mockClear();

    const mockInspector = {
      inspectForQuestion: vi.fn().mockResolvedValue({
        labels: ["Claim"],
        relationshipTypes: [],
        propertyKeys: {},
        nodeCounts: {},
        sampleData: {},
      }),
    } as unknown as SchemaInspector;

    const mockConstructor = {
      construct: vi.fn().mockResolvedValue({
        query: INTEREST_RATE_QUERY,
        validated: true,
        fallbackUsed: false,
      }),
    } as unknown as QueryConstructor;

    const mockSession = {
      run: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn(),
    };
    const mockConnection = {
      session: () => mockSession,
    } as unknown as import("../neo4j.js").Neo4jConnection;

    const pipeline = new AQMPipeline({
      connection: mockConnection,
      router,
      emitter,
      schemaInspector: mockInspector,
      queryConstructor: mockConstructor,
    });

    await pipeline.query(
      "What is my total exposure to interest rate risk?",
    );

    const pipelineEvents = emitSpy.mock.calls.filter(
      (call) =>
        (call[0] as { event_subtype: string }).event_subtype === "aqm_pipeline_complete",
    );
    expect(pipelineEvents.length).toBe(1);

    emitSpy.mockRestore();
  });

  it("emits telemetry for fallback to vector search", async () => {
    const emitSpy = vi.spyOn(emitter, "emit");
    emitSpy.mockClear();

    const mockInspector = {
      inspectForQuestion: vi.fn().mockResolvedValue({
        labels: [],
        relationshipTypes: [],
        propertyKeys: {},
        nodeCounts: {},
        sampleData: {},
      }),
    } as unknown as SchemaInspector;

    const mockConstructor = {
      construct: vi.fn().mockResolvedValue({
        query: null,
        validated: false,
        validationError: "Construction failed",
        fallbackUsed: false,
      }),
    } as unknown as QueryConstructor;

    const pipeline = new AQMPipeline({
      router,
      emitter,
      schemaInspector: mockInspector,
      queryConstructor: mockConstructor,
    });

    await pipeline.query(
      "What is my total exposure to interest rate risk?",
    );

    const fallbackEvents = emitSpy.mock.calls.filter(
      (call) =>
        (call[0] as { event_subtype: string }).event_subtype === "aqm_fallback_to_vector",
    );
    expect(fallbackEvents.length).toBe(1);

    emitSpy.mockRestore();
  });

  it("handles query with no dependencies gracefully", async () => {
    // Pipeline with no connection, no embedding, no router
    const pipeline = new AQMPipeline({ emitter });
    const result = await pipeline.query("Who is Jim LaMarche?");

    expect(result.classification).toBe("simple");
    expect(result.simpleResults).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("converts Neo4j integer results in query output", async () => {
    const mockInspector = {
      inspectForQuestion: vi.fn().mockResolvedValue({
        labels: ["Claim"],
        relationshipTypes: [],
        propertyKeys: {},
        nodeCounts: {},
        sampleData: {},
      }),
    } as unknown as SchemaInspector;

    const mockConstructor = {
      construct: vi.fn().mockResolvedValue({
        query: {
          cypher: "MATCH (c:Claim) RETURN count(c) AS total",
          parameters: {},
          description: "Count claims",
          pattern: "aggregation" as QueryPattern,
        },
        validated: true,
        fallbackUsed: false,
      }),
    } as unknown as QueryConstructor;

    const mockSession = {
      run: vi.fn().mockResolvedValue({
        records: [
          {
            keys: ["total"],
            get: () => ({
              toNumber: () => 42,
            }),
          },
        ],
      }),
      close: vi.fn(),
    };
    const mockConnection = {
      session: () => mockSession,
    } as unknown as import("../neo4j.js").Neo4jConnection;

    const pipeline = new AQMPipeline({
      connection: mockConnection,
      router,
      emitter,
      schemaInspector: mockInspector,
      queryConstructor: mockConstructor,
    });

    const result = await pipeline.query("How many claims do I have across all domains?");

    expect(result.stage2!.queryResults![0].total).toBe(42);
  });

  it("runs AQM against empty graph — graceful 'no knowledge available' response", async () => {
    const mockInspector = {
      inspectForQuestion: vi.fn().mockResolvedValue({
        labels: [],
        relationshipTypes: [],
        propertyKeys: {},
        nodeCounts: {},
        sampleData: {},
      }),
    } as unknown as SchemaInspector;

    const mockConstructor = {
      construct: vi.fn().mockResolvedValue({
        query: {
          cypher: "MATCH (c:Claim) RETURN c LIMIT 10",
          parameters: {},
          description: "test",
          pattern: "general" as QueryPattern,
        },
        validated: true,
        fallbackUsed: false,
      }),
    } as unknown as QueryConstructor;

    // Empty query results
    const mockSession = {
      run: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn(),
    };
    const mockConnection = {
      session: () => mockSession,
    } as unknown as import("../neo4j.js").Neo4jConnection;

    const pipeline = new AQMPipeline({
      connection: mockConnection,
      router,
      emitter,
      schemaInspector: mockInspector,
      queryConstructor: mockConstructor,
    });

    const result = await pipeline.query(
      "What is my total exposure to interest rate risk?",
    );

    expect(result.answer).toBe("No knowledge available for this question.");
    expect(result.confidence).toBe(0);
    expect(result.citations).toEqual([]);
  });

  it("full pipeline with custom reranker and synthesizer", async () => {
    const mockInspector = {
      inspectForQuestion: vi.fn().mockResolvedValue({
        labels: ["Claim"],
        relationshipTypes: [],
        propertyKeys: {},
        nodeCounts: {},
        sampleData: {},
      }),
    } as unknown as SchemaInspector;

    const mockConstructor = {
      construct: vi.fn().mockResolvedValue({
        query: {
          cypher: "MATCH (c:Claim) RETURN c.content AS content LIMIT 5",
          parameters: {},
          description: "test",
          pattern: "general" as QueryPattern,
        },
        validated: true,
        fallbackUsed: false,
      }),
    } as unknown as QueryConstructor;

    const mockReranker = {
      rerank: vi.fn().mockResolvedValue({
        ranked: [
          {
            data: { content: "Reranked claim" },
            score: 0.9,
            components: { semantic_similarity: 0.9, truth_tier_weight: 1.0, recency_decay: 0.8 },
            truthTier: "family_direct",
            claimId: "c1",
          },
        ],
        gaps: [],
        stats: { total_input: 1, total_output: 1, avg_score: 0.9, top_truth_tier: "family_direct" },
      } as RerankResult),
    } as unknown as Reranker;

    const mockSynthesizer = {
      synthesize: vi.fn().mockResolvedValue({
        answer: "Custom synthesized answer",
        citations: [{ claimId: "c1", formatted: "[Claim ID: c1]" }],
        gaps: [],
        confidence: 0.9,
        inferenceChain: [],
      } as unknown as SynthesisResult),
    } as unknown as Synthesizer;

    const mockSession = {
      run: vi.fn().mockResolvedValue({
        records: [
          {
            keys: ["content"],
            get: () => "Raw claim content",
          },
        ],
      }),
      close: vi.fn(),
    };
    const mockConnection = {
      session: () => mockSession,
    } as unknown as import("../neo4j.js").Neo4jConnection;

    const pipeline = new AQMPipeline({
      connection: mockConnection,
      router,
      emitter,
      schemaInspector: mockInspector,
      queryConstructor: mockConstructor,
      reranker: mockReranker,
      synthesizer: mockSynthesizer,
    });

    const result = await pipeline.query(
      "What is my total exposure to interest rate risk?",
    );

    expect(mockReranker.rerank).toHaveBeenCalled();
    expect(mockSynthesizer.synthesize).toHaveBeenCalled();
    expect(result.answer).toBe("Custom synthesized answer");
    expect(result.confidence).toBe(0.9);
  });
});
