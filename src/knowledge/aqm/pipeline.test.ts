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
import { ModelRouter, type RoutingDecision } from "../model-router.js";
import { TelemetryEmitter } from "../../telemetry/emitter.js";

/**
 * AQM Pipeline tests — verifies query classification, schema inspection,
 * query construction, and pipeline orchestration.
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
    expect(result.fallbackUsed).toBe(false);
    expect(result.timing.classification_ms).toBeGreaterThanOrEqual(0);
  });

  it("routes complex question through AQM stages 1-2", async () => {
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
    expect(result.stage2!.queryResults![0].claim).toBe(
      "Variable rate mortgage at 6.5%",
    );
    expect(result.fallbackUsed).toBe(false);
    expect(result.timing.stage1_ms).toBeGreaterThanOrEqual(0);
    expect(result.timing.stage2_ms).toBeGreaterThanOrEqual(0);
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

  it("includes timing information in results", async () => {
    const pipeline = new AQMPipeline({ router, emitter });
    const result = await pipeline.query("Who is Jim LaMarche?");

    expect(result.timing.classification_ms).toBeGreaterThanOrEqual(0);
    expect(result.timing.total_ms).toBeGreaterThanOrEqual(0);
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
});
