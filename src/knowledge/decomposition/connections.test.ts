import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ConnectionDiscovery,
  type ConnectionAnalysis,
  type ImplicitBet,
  type CrossDomainClaim,
  ConnectionAnalysisSchema,
  ImplicitBetSchema,
} from "./connections.js";
import { ModelRouter, type RoutingDecision } from "../model-router.js";
import { TelemetryEmitter } from "../../telemetry/emitter.js";

/**
 * ConnectionDiscovery tests — verifies cross-domain connection detection
 * and implicit bet discovery.
 *
 * Uses mock LLM calls for deterministic testing.
 * Does NOT require a running LLM, Neo4j, or OpenAI instance.
 */

let emitter: TelemetryEmitter;
let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "vega-connections-test-"));
  emitter = new TelemetryEmitter(tempDir);
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── Mock LLM Responses ──────────────────────────────────────────────

const HIGH_RELEVANCE_CONNECTION: ConnectionAnalysis = {
  is_connected: true,
  explanation: "Jim LaMarche works at Blackstone, creating a direct bridge between the personal/family domain and the GIX financial domain.",
  relevance_score: 0.92,
  connection_type: "career_financial",
  insight: "Jim LaMarche's employment at Blackstone creates exposure to alternative investment strategies that may directly affect family financial planning decisions.",
};

const LOW_RELEVANCE_CONNECTION: ConnectionAnalysis = {
  is_connected: true,
  explanation: "Both claims mention financial matters but the connection is indirect.",
  relevance_score: 0.65,
  connection_type: "entity_bridge",
  insight: "Loose financial connection between domains.",
};

const NOT_CONNECTED_RESPONSE: ConnectionAnalysis = {
  is_connected: false,
  explanation: "These claims are about different aspects and do not share a meaningful connection.",
  relevance_score: 0.1,
  connection_type: "none",
};

const USD_CONCENTRATION_BETS: ImplicitBet[] = [
  {
    bet_type: "implicit",
    description: "All financial positions are denominated in USD, creating an implicit currency concentration bet.",
    concentration_factor: "USD currency",
    risk_level: "medium",
    supporting_evidence: ["claim-usd-1", "claim-usd-2", "claim-usd-3"],
  },
];

function createMockLlmCall(response: ConnectionAnalysis | ImplicitBet[]) {
  return vi.fn(async (_prompt: string, _systemPrompt: string, _routing: RoutingDecision) => {
    return JSON.stringify(response);
  });
}

// ── Mock Neo4j Session ───────────────────────────────────────────────

function createMockConnection(crossDomainRecords: Array<Record<string, unknown>> = [], financialRecords: Array<Record<string, unknown>> = []) {
  const runMock = vi.fn();

  // Default: findCrossDomainClaims returns cross-domain records
  runMock.mockImplementation(async (query: string) => {
    if (query.includes("ABOUT") && query.includes("domain")) {
      return {
        records: crossDomainRecords.map((rec) => ({
          get: (key: string) => rec[key],
        })),
      };
    }
    if (query.includes("personal_finance") && query.includes("gix")) {
      return {
        records: financialRecords.map((rec) => ({
          get: (key: string) => rec[key],
        })),
      };
    }
    // CREATE/MERGE operations return empty
    return { records: [] };
  });

  return {
    session: () => ({
      run: runMock,
      close: vi.fn(),
    }),
    _runMock: runMock,
  } as unknown as import("../neo4j.js").Neo4jConnection & { _runMock: ReturnType<typeof vi.fn> };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ConnectionDiscovery", () => {
  describe("Jim LaMarche ↔ Blackstone canonical example", () => {
    it("should detect cross-domain connection between personal and gix domains", async () => {
      const crossDomainRecords = [
        {
          id: "claim-blackstone-1",
          content: "Blackstone is the world's largest alternative asset manager with $1 trillion AUM",
          truth_tier: "multi_source_verified",
          domain: "gix",
          entity_name: "Blackstone",
        },
      ];

      const mockConnection = createMockConnection(crossDomainRecords);
      const mockLlm = createMockLlmCall(HIGH_RELEVANCE_CONNECTION);

      const discovery = new ConnectionDiscovery({
        connection: mockConnection,
        emitter,
        llmCall: mockLlm,
      });

      const result = await discovery.checkOnIngestion(
        "claim-jim-1",
        "Jim LaMarche works at Blackstone as a Senior Managing Director",
        "family",
        "family_direct",
        [
          { name: "Jim LaMarche", type: "person" },
          { name: "Blackstone", type: "organization" },
        ],
      );

      expect(result.connections_found).toBe(1);
      expect(result.claims_created).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(mockLlm).toHaveBeenCalledOnce();
    });

    it("should create RELATED_TO relationship between cross-domain claims", async () => {
      const crossDomainRecords = [
        {
          id: "claim-blackstone-1",
          content: "Blackstone manages alternative investments",
          truth_tier: "single_source",
          domain: "gix",
          entity_name: "Blackstone",
        },
      ];

      const mockConnection = createMockConnection(crossDomainRecords);
      const mockLlm = createMockLlmCall(HIGH_RELEVANCE_CONNECTION);

      const discovery = new ConnectionDiscovery({
        connection: mockConnection,
        emitter,
        llmCall: mockLlm,
      });

      await discovery.checkOnIngestion(
        "claim-jim-1",
        "Jim LaMarche works at Blackstone",
        "family",
        "family_direct",
        [{ name: "Blackstone", type: "organization" }],
      );

      // Verify RELATED_TO creation was called
      const runMock = mockConnection._runMock;
      const relatedToCalls = runMock.mock.calls.filter(
        (call: [string, ...unknown[]]) => typeof call[0] === "string" && call[0].includes("RELATED_TO"),
      );
      expect(relatedToCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("low-relevance connections", () => {
    it("should log but NOT persist low-relevance connections as Claims", async () => {
      const crossDomainRecords = [
        {
          id: "claim-other-1",
          content: "General financial observation",
          truth_tier: "single_source",
          domain: "gix",
          entity_name: "SomeEntity",
        },
      ];

      const mockConnection = createMockConnection(crossDomainRecords);
      const mockLlm = createMockLlmCall(LOW_RELEVANCE_CONNECTION);

      const discovery = new ConnectionDiscovery({
        connection: mockConnection,
        emitter,
        llmCall: mockLlm,
      });

      const result = await discovery.checkOnIngestion(
        "claim-test-1",
        "Some claim about finances",
        "personal_finance",
        "single_source",
        [{ name: "SomeEntity", type: "organization" }],
      );

      expect(result.connections_found).toBe(1);
      expect(result.claims_created).toBe(0); // NOT persisted
      expect(result.low_relevance_logged).toBe(1);
    });

    it("should NOT persist connections below the low relevance threshold", async () => {
      const crossDomainRecords = [
        {
          id: "claim-unrelated-1",
          content: "Completely unrelated claim",
          truth_tier: "single_source",
          domain: "health",
          entity_name: "SomeEntity",
        },
      ];

      const mockConnection = createMockConnection(crossDomainRecords);
      const mockLlm = createMockLlmCall(NOT_CONNECTED_RESPONSE);

      const discovery = new ConnectionDiscovery({
        connection: mockConnection,
        emitter,
        llmCall: mockLlm,
      });

      const result = await discovery.checkOnIngestion(
        "claim-test-1",
        "Something about finances",
        "personal_finance",
        "single_source",
        [{ name: "SomeEntity", type: "organization" }],
      );

      expect(result.connections_found).toBe(0);
      expect(result.claims_created).toBe(0);
      expect(result.low_relevance_logged).toBe(0);
    });
  });

  describe("implicit bet detection", () => {
    it("should detect USD currency concentration bet", async () => {
      const financialRecords = [
        { id: "claim-usd-1", content: "Vanguard Total Stock Market Index Fund valued at $150,000 USD", domain: "personal_finance" },
        { id: "claim-usd-2", content: "Blackstone fund position worth $75,000 USD", domain: "gix" },
        { id: "claim-usd-3", content: "Checking account balance is $25,000 USD at Chase", domain: "personal_finance" },
      ];

      const mockConnection = createMockConnection([], financialRecords);
      const mockLlm = createMockLlmCall(USD_CONCENTRATION_BETS);

      const discovery = new ConnectionDiscovery({
        connection: mockConnection,
        emitter,
        llmCall: mockLlm,
      });

      const result = await discovery.detectImplicitBets();

      expect(result.bets_detected).toBe(1);
      expect(result.connections_found).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(mockLlm).toHaveBeenCalledOnce();
    });

    it("should create Bet nodes with EVIDENCED_BY relationships", async () => {
      const financialRecords = [
        { id: "claim-usd-1", content: "Position in USD", domain: "personal_finance" },
        { id: "claim-usd-2", content: "Another position in USD", domain: "gix" },
      ];

      const mockConnection = createMockConnection([], financialRecords);
      const mockLlm = createMockLlmCall(USD_CONCENTRATION_BETS);

      const discovery = new ConnectionDiscovery({
        connection: mockConnection,
        emitter,
        llmCall: mockLlm,
      });

      await discovery.detectImplicitBets();

      // Verify Bet node and EVIDENCED_BY creation
      const runMock = mockConnection._runMock;
      const betCalls = runMock.mock.calls.filter(
        (call: [string, ...unknown[]]) => typeof call[0] === "string" && call[0].includes("Bet"),
      );
      expect(betCalls.length).toBeGreaterThanOrEqual(1);

      const evidenceCalls = runMock.mock.calls.filter(
        (call: [string, ...unknown[]]) => typeof call[0] === "string" && call[0].includes("EVIDENCED_BY"),
      );
      expect(evidenceCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("should skip detection with fewer than 2 financial claims", async () => {
      const financialRecords = [
        { id: "claim-only-1", content: "Only one claim", domain: "personal_finance" },
      ];

      const mockConnection = createMockConnection([], financialRecords);
      const mockLlm = createMockLlmCall(USD_CONCENTRATION_BETS);

      const discovery = new ConnectionDiscovery({
        connection: mockConnection,
        emitter,
        llmCall: mockLlm,
      });

      const result = await discovery.detectImplicitBets();

      expect(result.bets_detected).toBe(0);
      expect(mockLlm).not.toHaveBeenCalled();
    });

    it("should handle no Neo4j connection gracefully", async () => {
      const discovery = new ConnectionDiscovery({
        emitter,
        llmCall: createMockLlmCall(USD_CONCENTRATION_BETS),
      });

      const result = await discovery.detectImplicitBets();

      expect(result.bets_detected).toBe(0);
      expect(result.errors).toContain("No Neo4j connection — cannot detect implicit bets");
    });
  });

  describe("connection scoring", () => {
    it("should boost score for cross-domain connections", () => {
      const discovery = new ConnectionDiscovery({ emitter });

      const claim1: CrossDomainClaim = {
        id: "c1", content: "test", truth_tier: "single_source",
        domain: "family", entity_name: "Jim",
      };
      const claim2: CrossDomainClaim = {
        id: "c2", content: "test", truth_tier: "single_source",
        domain: "gix", entity_name: "Jim",
      };

      const analysis: ConnectionAnalysis = {
        is_connected: true,
        explanation: "Connected",
        relevance_score: 0.75,
        connection_type: "entity_bridge",
      };

      const score = discovery.computeConnectionScore(analysis, claim1, claim2);

      // 0.75 base + 0.05 cross-domain + 0 truth_tier for single_source
      expect(score).toBe(0.8);
    });

    it("should boost score for family_direct truth tier", () => {
      const discovery = new ConnectionDiscovery({ emitter });

      const claim1: CrossDomainClaim = {
        id: "c1", content: "test", truth_tier: "family_direct",
        domain: "family", entity_name: "Jim",
      };
      const claim2: CrossDomainClaim = {
        id: "c2", content: "test", truth_tier: "multi_source_verified",
        domain: "gix", entity_name: "Jim",
      };

      const analysis: ConnectionAnalysis = {
        is_connected: true,
        explanation: "Connected",
        relevance_score: 0.7,
        connection_type: "entity_bridge",
      };

      const score = discovery.computeConnectionScore(analysis, claim1, claim2);

      // 0.7 base + 0.05 cross-domain + 0.1 family_direct + 0.05 multi_source_verified
      expect(score).toBe(0.9);
    });

    it("should penalize agent_inferred truth tier", () => {
      const discovery = new ConnectionDiscovery({ emitter });

      const claim1: CrossDomainClaim = {
        id: "c1", content: "test", truth_tier: "agent_inferred",
        domain: "general", entity_name: "Test",
      };
      const claim2: CrossDomainClaim = {
        id: "c2", content: "test", truth_tier: "agent_inferred",
        domain: "gix", entity_name: "Test",
      };

      const analysis: ConnectionAnalysis = {
        is_connected: true,
        explanation: "Connected",
        relevance_score: 0.7,
        connection_type: "entity_bridge",
      };

      const score = discovery.computeConnectionScore(analysis, claim1, claim2);

      // 0.7 base + 0.05 cross-domain - 0.05 agent_inferred - 0.05 agent_inferred
      expect(score).toBeCloseTo(0.65, 10);
    });

    it("should clamp score to [0, 1] range", () => {
      const discovery = new ConnectionDiscovery({ emitter });

      const claim1: CrossDomainClaim = {
        id: "c1", content: "test", truth_tier: "family_direct",
        domain: "family", entity_name: "Jim",
      };
      const claim2: CrossDomainClaim = {
        id: "c2", content: "test", truth_tier: "family_direct",
        domain: "gix", entity_name: "Jim",
      };

      const analysis: ConnectionAnalysis = {
        is_connected: true,
        explanation: "Connected",
        relevance_score: 0.95,
        connection_type: "entity_bridge",
      };

      const score = discovery.computeConnectionScore(analysis, claim1, claim2);

      // 0.95 + 0.05 + 0.1 + 0.1 = 1.2 → clamped to 1.0
      expect(score).toBe(1.0);
    });
  });

  describe("parseConnectionAnalysis", () => {
    it("should parse valid JSON response", () => {
      const discovery = new ConnectionDiscovery({ emitter });

      const result = discovery.parseConnectionAnalysis(
        JSON.stringify(HIGH_RELEVANCE_CONNECTION),
      );

      expect(result.is_connected).toBe(true);
      expect(result.relevance_score).toBe(0.92);
      expect(result.connection_type).toBe("career_financial");
      expect(result.insight).toContain("Jim LaMarche");
    });

    it("should handle markdown fencing", () => {
      const discovery = new ConnectionDiscovery({ emitter });

      const result = discovery.parseConnectionAnalysis(
        "```json\n" + JSON.stringify(NOT_CONNECTED_RESPONSE) + "\n```",
      );

      expect(result.is_connected).toBe(false);
      expect(result.relevance_score).toBe(0.1);
    });

    it("should throw on invalid JSON", () => {
      const discovery = new ConnectionDiscovery({ emitter });

      expect(() => discovery.parseConnectionAnalysis("not json")).toThrow();
    });

    it("should throw on missing required fields", () => {
      const discovery = new ConnectionDiscovery({ emitter });

      expect(() =>
        discovery.parseConnectionAnalysis(JSON.stringify({ is_connected: true })),
      ).toThrow();
    });
  });

  describe("parseBetResponse", () => {
    it("should parse valid bet array", () => {
      const discovery = new ConnectionDiscovery({ emitter });

      const result = discovery.parseBetResponse(JSON.stringify(USD_CONCENTRATION_BETS));

      expect(result).toHaveLength(1);
      expect(result[0].bet_type).toBe("implicit");
      expect(result[0].concentration_factor).toBe("USD currency");
      expect(result[0].risk_level).toBe("medium");
      expect(result[0].supporting_evidence).toHaveLength(3);
    });

    it("should handle markdown fencing in bet response", () => {
      const discovery = new ConnectionDiscovery({ emitter });

      const result = discovery.parseBetResponse(
        "```json\n" + JSON.stringify(USD_CONCENTRATION_BETS) + "\n```",
      );

      expect(result).toHaveLength(1);
    });

    it("should skip invalid bets but continue parsing", () => {
      const discovery = new ConnectionDiscovery({ emitter });

      const mixedBets = [
        { bet_type: "implicit", description: "Valid bet", concentration_factor: "USD", risk_level: "high", supporting_evidence: ["c1"] },
        { bet_type: "invalid_type", description: "Bad type" }, // Invalid
        { bet_type: "implicit", description: "Another valid bet", concentration_factor: "EUR", risk_level: "low", supporting_evidence: ["c2"] },
      ];

      const result = discovery.parseBetResponse(JSON.stringify(mixedBets));

      expect(result).toHaveLength(2);
    });

    it("should throw on non-array response", () => {
      const discovery = new ConnectionDiscovery({ emitter });

      expect(() =>
        discovery.parseBetResponse(JSON.stringify({ not: "array" })),
      ).toThrow("LLM response is not a JSON array");
    });
  });

  describe("Zod schema validation", () => {
    it("should validate ConnectionAnalysis schema", () => {
      const valid = ConnectionAnalysisSchema.parse({
        is_connected: true,
        explanation: "test",
        relevance_score: 0.8,
        connection_type: "entity_bridge",
        insight: "test insight",
      });
      expect(valid.is_connected).toBe(true);
    });

    it("should reject ConnectionAnalysis with invalid score range", () => {
      expect(() =>
        ConnectionAnalysisSchema.parse({
          is_connected: true,
          explanation: "test",
          relevance_score: 1.5, // Out of range
          connection_type: "test",
        }),
      ).toThrow();
    });

    it("should validate ImplicitBet schema", () => {
      const valid = ImplicitBetSchema.parse({
        bet_type: "implicit",
        description: "test bet",
        concentration_factor: "USD",
        risk_level: "high",
        supporting_evidence: ["c1", "c2"],
      });
      expect(valid.bet_type).toBe("implicit");
    });

    it("should reject ImplicitBet with invalid risk_level", () => {
      expect(() =>
        ImplicitBetSchema.parse({
          bet_type: "implicit",
          description: "test",
          concentration_factor: "USD",
          risk_level: "extreme", // Invalid
          supporting_evidence: [],
        }),
      ).toThrow();
    });
  });

  describe("routing verification", () => {
    it("should route connection analysis to complex_reasoning (frontier)", async () => {
      const router = new ModelRouter({ xaiApiKey: "test-key", emitter });
      const routeSpy = vi.spyOn(router, "route");

      const crossDomainRecords = [
        {
          id: "claim-cross-1",
          content: "Cross domain claim",
          truth_tier: "single_source",
          domain: "gix",
          entity_name: "TestEntity",
        },
      ];

      const mockConnection = createMockConnection(crossDomainRecords);
      const mockLlm = createMockLlmCall(HIGH_RELEVANCE_CONNECTION);

      const discovery = new ConnectionDiscovery({
        connection: mockConnection,
        router,
        emitter,
        llmCall: mockLlm,
      });

      await discovery.checkOnIngestion(
        "claim-test-1",
        "Test claim",
        "family",
        "single_source",
        [{ name: "TestEntity", type: "organization" }],
      );

      expect(routeSpy).toHaveBeenCalledWith("complex_reasoning");
    });

    it("should route bet detection to complex_reasoning (frontier)", async () => {
      const router = new ModelRouter({ xaiApiKey: "test-key", emitter });
      const routeSpy = vi.spyOn(router, "route");

      const financialRecords = [
        { id: "c1", content: "USD position 1", domain: "personal_finance" },
        { id: "c2", content: "USD position 2", domain: "gix" },
      ];

      const mockConnection = createMockConnection([], financialRecords);
      const mockLlm = createMockLlmCall(USD_CONCENTRATION_BETS);

      const discovery = new ConnectionDiscovery({
        connection: mockConnection,
        router,
        emitter,
        llmCall: mockLlm,
      });

      await discovery.detectImplicitBets();

      expect(routeSpy).toHaveBeenCalledWith("complex_reasoning");
    });
  });

  describe("error handling", () => {
    it("should handle LLM call failures gracefully", async () => {
      const crossDomainRecords = [
        {
          id: "claim-cross-1",
          content: "Cross domain claim",
          truth_tier: "single_source",
          domain: "gix",
          entity_name: "TestEntity",
        },
      ];

      const mockConnection = createMockConnection(crossDomainRecords);
      const mockLlm = vi.fn().mockRejectedValue(new Error("LLM API timeout"));

      const discovery = new ConnectionDiscovery({
        connection: mockConnection,
        emitter,
        llmCall: mockLlm,
      });

      const result = await discovery.checkOnIngestion(
        "claim-test-1",
        "Test claim",
        "family",
        "single_source",
        [{ name: "TestEntity", type: "organization" }],
      );

      expect(result.connections_found).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("Error checking cross-domain claim");
    });

    it("should handle no cross-domain claims found", async () => {
      const mockConnection = createMockConnection([]); // No cross-domain claims
      const mockLlm = createMockLlmCall(HIGH_RELEVANCE_CONNECTION);

      const discovery = new ConnectionDiscovery({
        connection: mockConnection,
        emitter,
        llmCall: mockLlm,
      });

      const result = await discovery.checkOnIngestion(
        "claim-test-1",
        "Test claim",
        "family",
        "single_source",
        [{ name: "UniqueEntity", type: "person" }],
      );

      expect(result.connections_found).toBe(0);
      expect(result.claims_created).toBe(0);
      expect(mockLlm).not.toHaveBeenCalled();
    });

    it("should work without Neo4j connection for on-ingestion", async () => {
      const mockLlm = createMockLlmCall(HIGH_RELEVANCE_CONNECTION);

      const discovery = new ConnectionDiscovery({
        emitter,
        llmCall: mockLlm,
      });

      const result = await discovery.checkOnIngestion(
        "claim-test-1",
        "Test claim",
        "family",
        "single_source",
        [{ name: "Jim", type: "person" }],
      );

      // Without connection, findCrossDomainClaims returns []
      expect(result.connections_found).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("should handle router failures gracefully", async () => {
      const crossDomainRecords = [
        {
          id: "claim-cross-1",
          content: "Cross domain claim",
          truth_tier: "single_source",
          domain: "gix",
          entity_name: "TestEntity",
        },
      ];

      const mockConnection = createMockConnection(crossDomainRecords);
      const router = new ModelRouter({ emitter });
      vi.spyOn(router, "route").mockRejectedValue(new Error("Router failed"));

      const discovery = new ConnectionDiscovery({
        connection: mockConnection,
        router,
        emitter,
        llmCall: createMockLlmCall(HIGH_RELEVANCE_CONNECTION),
      });

      const result = await discovery.checkOnIngestion(
        "claim-test-1",
        "Test claim",
        "family",
        "single_source",
        [{ name: "TestEntity", type: "organization" }],
      );

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("On-ingestion check failed");
    });
  });

  describe("telemetry", () => {
    it("should emit telemetry for on-ingestion discovery", async () => {
      const localEmitter = new TelemetryEmitter(tempDir);
      const emitSpy = vi.spyOn(localEmitter, "emit");

      const crossDomainRecords = [
        {
          id: "claim-cross-1",
          content: "Cross domain claim",
          truth_tier: "single_source",
          domain: "gix",
          entity_name: "TestEntity",
        },
      ];

      const mockConnection = createMockConnection(crossDomainRecords);
      const mockLlm = createMockLlmCall(HIGH_RELEVANCE_CONNECTION);

      const discovery = new ConnectionDiscovery({
        connection: mockConnection,
        emitter: localEmitter,
        llmCall: mockLlm,
      });

      await discovery.checkOnIngestion(
        "claim-test-1",
        "Test claim",
        "family",
        "single_source",
        [{ name: "TestEntity", type: "organization" }],
      );

      const connectionEvents = emitSpy.mock.calls.filter(
        (call) => call[0].event_subtype === "connection_discovery",
      );
      expect(connectionEvents.length).toBeGreaterThanOrEqual(1);

      const event = connectionEvents[0][0];
      expect(event.agent_name).toBe("knowledge_agent");
      expect(event.event_type).toBe("knowledge_write");
      expect(event.metadata).toHaveProperty("mode", "on_ingestion");
    });

    it("should emit telemetry for implicit bet detection", async () => {
      const localEmitter = new TelemetryEmitter(tempDir);
      const emitSpy = vi.spyOn(localEmitter, "emit");

      const financialRecords = [
        { id: "c1", content: "USD position", domain: "personal_finance" },
        { id: "c2", content: "USD position 2", domain: "gix" },
      ];

      const mockConnection = createMockConnection([], financialRecords);
      const mockLlm = createMockLlmCall(USD_CONCENTRATION_BETS);

      const discovery = new ConnectionDiscovery({
        connection: mockConnection,
        emitter: localEmitter,
        llmCall: mockLlm,
      });

      await discovery.detectImplicitBets();

      const connectionEvents = emitSpy.mock.calls.filter(
        (call) => call[0].event_subtype === "connection_discovery",
      );
      expect(connectionEvents.length).toBeGreaterThanOrEqual(1);

      const event = connectionEvents[0][0];
      expect(event.metadata).toHaveProperty("mode", "implicit_bet_detection");
    });

    it("should emit failure telemetry on router error", async () => {
      const localEmitter = new TelemetryEmitter(tempDir);
      const emitSpy = vi.spyOn(localEmitter, "emit");

      const crossDomainRecords = [
        {
          id: "claim-cross-1",
          content: "test",
          truth_tier: "single_source",
          domain: "gix",
          entity_name: "TestEntity",
        },
      ];

      const mockConnection = createMockConnection(crossDomainRecords);
      const router = new ModelRouter({ emitter: localEmitter });
      vi.spyOn(router, "route").mockRejectedValue(new Error("Router failed"));

      const discovery = new ConnectionDiscovery({
        connection: mockConnection,
        router,
        emitter: localEmitter,
        llmCall: createMockLlmCall(HIGH_RELEVANCE_CONNECTION),
      });

      await discovery.checkOnIngestion(
        "claim-test-1",
        "Test",
        "family",
        "single_source",
        [{ name: "TestEntity", type: "organization" }],
      );

      const failureEvents = emitSpy.mock.calls.filter(
        (call) =>
          call[0].event_subtype === "connection_discovery" &&
          call[0].outcome === "failure",
      );
      expect(failureEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("deduplication of cross-domain claims", () => {
    it("should not duplicate claims when same entity appears in multiple entities list", async () => {
      const crossDomainRecords = [
        {
          id: "claim-shared-1",
          content: "Blackstone manages Jim's fund",
          truth_tier: "single_source",
          domain: "gix",
          entity_name: "Blackstone",
        },
      ];

      const mockConnection = createMockConnection(crossDomainRecords);
      const mockLlm = createMockLlmCall(HIGH_RELEVANCE_CONNECTION);

      const discovery = new ConnectionDiscovery({
        connection: mockConnection,
        emitter,
        llmCall: mockLlm,
      });

      // Entity "Blackstone" appears in queries for both entities,
      // but the same claim should only be analyzed once
      const result = await discovery.checkOnIngestion(
        "claim-test-1",
        "Jim works at Blackstone",
        "family",
        "family_direct",
        [
          { name: "Jim LaMarche", type: "person" },
          { name: "Blackstone", type: "organization" },
        ],
      );

      // Even though we have 2 entities, LLM should only be called once
      // because the cross-domain claim is the same
      expect(mockLlm).toHaveBeenCalledOnce();
    });
  });
});
