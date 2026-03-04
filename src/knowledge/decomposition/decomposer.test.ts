import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ClaimDecomposer,
  type DecomposedClaim,
  type DecompositionResult,
  DecomposedClaimSchema,
} from "./decomposer.js";
import { ModelRouter, type RoutingDecision } from "../model-router.js";
import { TelemetryEmitter } from "../../telemetry/emitter.js";

/**
 * ClaimDecomposer tests — verifies claim decomposition from unstructured text.
 *
 * Uses a mock LLM call to return deterministic responses.
 * Does NOT require a running LLM, Neo4j, or OpenAI instance.
 */

let emitter: TelemetryEmitter;
let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "vega-decomposer-test-"));
  emitter = new TelemetryEmitter(tempDir);
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── Mock LLM Responses ──────────────────────────────────────────────

/** Jim LaMarche / Blackstone example — canonical test case from Implementation Guide */
const JIM_BLACKSTONE_RESPONSE: DecomposedClaim[] = [
  {
    content: "Jim LaMarche knows someone who works at Blackstone",
    entities: [
      { name: "Jim LaMarche", type: "person" },
      { name: "Blackstone", type: "organization" },
    ],
    truth_tier: "single_source",
    truth_score_estimate: 0.6,
    domain_classification: "personal_finance",
  },
  {
    content: "Jim LaMarche mentioned his Blackstone connection in a conversation",
    entities: [
      { name: "Jim LaMarche", type: "person" },
      { name: "Blackstone", type: "organization" },
    ],
    truth_tier: "single_source",
    truth_score_estimate: 0.5,
    domain_classification: "personal_finance",
  },
];

/** Multi-paragraph meeting note decomposition */
const MEETING_NOTE_RESPONSE: DecomposedClaim[] = [
  {
    content: "Q4 revenue exceeded $2M target by 15%",
    entities: [
      { name: "GIX", type: "organization" },
    ],
    truth_tier: "multi_source_verified",
    truth_score_estimate: 0.9,
    domain_classification: "gix",
  },
  {
    content: "GIX is expanding into the European market in Q1 2027",
    entities: [
      { name: "GIX", type: "organization" },
    ],
    truth_tier: "single_source",
    truth_score_estimate: 0.75,
    domain_classification: "gix",
  },
  {
    content: "Sarah Johnson was promoted to VP of Engineering",
    entities: [
      { name: "Sarah Johnson", type: "person" },
    ],
    truth_tier: "single_source",
    truth_score_estimate: 0.85,
    domain_classification: "gix",
  },
  {
    content: "The new product launch is scheduled for March 2027",
    entities: [
      { name: "GIX", type: "organization" },
    ],
    truth_tier: "single_source",
    truth_score_estimate: 0.7,
    domain_classification: "gix",
  },
];

/** Family member statement — should get family_direct truth tier */
const FAMILY_STATEMENT_RESPONSE: DecomposedClaim[] = [
  {
    content: "Lindsay wants to renovate the kitchen before summer",
    entities: [
      { name: "Lindsay", type: "person" },
    ],
    truth_tier: "family_direct",
    truth_score_estimate: 0.95,
    domain_classification: "family",
  },
  {
    content: "The kitchen renovation budget is approximately $45,000",
    entities: [
      { name: "Lindsay", type: "person" },
    ],
    truth_tier: "family_direct",
    truth_score_estimate: 0.95,
    domain_classification: "personal_finance",
  },
  {
    content: "Harrison has a soccer tournament next Saturday",
    entities: [
      { name: "Harrison", type: "person" },
    ],
    truth_tier: "family_direct",
    truth_score_estimate: 0.98,
    domain_classification: "family",
  },
];

function createMockLlmCall(response: DecomposedClaim[]) {
  return vi.fn(async (_prompt: string, _systemPrompt: string, _routing: RoutingDecision) => {
    return JSON.stringify(response);
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ClaimDecomposer", () => {
  describe("Jim LaMarche / Blackstone canonical example", () => {
    it("extracts 2+ claims with Jim LaMarche and Blackstone entities", async () => {
      const mockLlm = createMockLlmCall(JIM_BLACKSTONE_RESPONSE);
      const decomposer = new ClaimDecomposer({
        emitter,
        llmCall: mockLlm,
        router: new ModelRouter({ emitter, xaiApiKey: "test-key" }),
      });

      const result = await decomposer.decompose(
        "Talked to Jim — he mentioned he knows someone at Blackstone",
      );

      expect(result.claims.length).toBeGreaterThanOrEqual(2);

      // Verify Jim LaMarche entity is identified
      const allEntities = result.claims.flatMap((c) => c.entities);
      const jimEntity = allEntities.find((e) => e.name === "Jim LaMarche");
      expect(jimEntity).toBeDefined();
      expect(jimEntity!.type).toBe("person");

      // Verify Blackstone entity is identified
      const blackstoneEntity = allEntities.find((e) => e.name === "Blackstone");
      expect(blackstoneEntity).toBeDefined();
      expect(blackstoneEntity!.type).toBe("organization");

      // Verify LLM was called with frontier routing
      expect(mockLlm).toHaveBeenCalledOnce();
      const [prompt, systemPrompt] = mockLlm.mock.calls[0];
      expect(prompt).toContain("Talked to Jim");
      expect(systemPrompt).toContain("claim decomposition engine");
    });
  });

  describe("multi-paragraph meeting note", () => {
    it("decomposes into atomic claims with correct domain and truth_tier", async () => {
      const mockLlm = createMockLlmCall(MEETING_NOTE_RESPONSE);
      const decomposer = new ClaimDecomposer({
        emitter,
        llmCall: mockLlm,
        router: new ModelRouter({ emitter, xaiApiKey: "test-key" }),
      });

      const meetingNote = `## Q4 Board Meeting Notes

Q4 revenue exceeded the $2M target by 15%. The board is pleased with the performance.

Sarah Johnson was promoted to VP of Engineering. She will lead the European expansion.

GIX is expanding into the European market in Q1 2027. The new product launch is scheduled for March 2027.`;

      const result = await decomposer.decompose(meetingNote, {
        sourceContext: "Board meeting minutes — verified by CFO",
      });

      expect(result.claims.length).toBeGreaterThanOrEqual(3);

      // Verify domain classification
      const gixClaims = result.claims.filter(
        (c) => c.domain_classification === "gix",
      );
      expect(gixClaims.length).toBeGreaterThan(0);

      // Verify truth tiers are assigned
      const verifiedClaims = result.claims.filter(
        (c) => c.truth_tier === "multi_source_verified",
      );
      expect(verifiedClaims.length).toBeGreaterThan(0);

      // Verify entities are extracted
      const allEntities = result.claims.flatMap((c) => c.entities);
      expect(allEntities.some((e) => e.name === "GIX")).toBe(true);
      expect(allEntities.some((e) => e.name === "Sarah Johnson")).toBe(true);
    });
  });

  describe("family member statement truth tier", () => {
    it("assigns family_direct truth_tier with truth_score >= 0.95", async () => {
      const mockLlm = createMockLlmCall(FAMILY_STATEMENT_RESPONSE);
      const decomposer = new ClaimDecomposer({
        emitter,
        llmCall: mockLlm,
        router: new ModelRouter({ emitter, xaiApiKey: "test-key" }),
      });

      const familyText =
        "Lindsay said she wants to renovate the kitchen before summer. Budget is about $45k. Harrison has a soccer tournament next Saturday.";

      const result = await decomposer.decompose(familyText, {
        sourceContext: "Family conversation with Lindsay",
      });

      // Verify family_direct truth tier
      const familyDirectClaims = result.claims.filter(
        (c) => c.truth_tier === "family_direct",
      );
      expect(familyDirectClaims.length).toBeGreaterThan(0);

      // Verify truth scores >= 0.95
      for (const claim of familyDirectClaims) {
        expect(claim.truth_score_estimate).toBeGreaterThanOrEqual(0.95);
      }

      // Verify Harrison entity
      const allEntities = result.claims.flatMap((c) => c.entities);
      expect(allEntities.some((e) => e.name === "Harrison")).toBe(true);
    });
  });

  describe("parseResponse", () => {
    let decomposer: ClaimDecomposer;

    beforeEach(() => {
      decomposer = new ClaimDecomposer({
        emitter,
        llmCall: createMockLlmCall([]),
        router: new ModelRouter({ emitter, xaiApiKey: "test-key" }),
      });
    });

    it("parses clean JSON array", () => {
      const raw = JSON.stringify(JIM_BLACKSTONE_RESPONSE);
      const claims = decomposer.parseResponse(raw);
      expect(claims).toHaveLength(2);
      expect(claims[0].content).toBe("Jim LaMarche knows someone who works at Blackstone");
    });

    it("strips markdown code fencing", () => {
      const raw = "```json\n" + JSON.stringify(JIM_BLACKSTONE_RESPONSE) + "\n```";
      const claims = decomposer.parseResponse(raw);
      expect(claims).toHaveLength(2);
    });

    it("strips bare code fencing", () => {
      const raw = "```\n" + JSON.stringify(JIM_BLACKSTONE_RESPONSE) + "\n```";
      const claims = decomposer.parseResponse(raw);
      expect(claims).toHaveLength(2);
    });

    it("throws on non-array response", () => {
      expect(() => decomposer.parseResponse('{"not": "an array"}')).toThrow(
        "LLM response is not a JSON array",
      );
    });

    it("throws on invalid JSON", () => {
      expect(() => decomposer.parseResponse("not json at all")).toThrow();
    });

    it("skips invalid claims but returns valid ones", () => {
      const mixed = [
        JIM_BLACKSTONE_RESPONSE[0],
        { content: "missing entities", truth_tier: "invalid_tier" }, // invalid
        JIM_BLACKSTONE_RESPONSE[1],
      ];
      const claims = decomposer.parseResponse(JSON.stringify(mixed));
      expect(claims).toHaveLength(2);
    });
  });

  describe("Zod schema validation", () => {
    it("validates a well-formed DecomposedClaim", () => {
      const claim = DecomposedClaimSchema.parse({
        content: "Test claim",
        entities: [{ name: "Test Entity", type: "person" }],
        truth_tier: "single_source",
        truth_score_estimate: 0.5,
        domain_classification: "general",
      });
      expect(claim.content).toBe("Test claim");
      expect(claim.entities[0].type).toBe("person");
    });

    it("rejects invalid entity types", () => {
      expect(() =>
        DecomposedClaimSchema.parse({
          content: "Test",
          entities: [{ name: "X", type: "invalid_type" }],
          truth_tier: "single_source",
          truth_score_estimate: 0.5,
          domain_classification: "general",
        }),
      ).toThrow();
    });

    it("rejects invalid truth tiers", () => {
      expect(() =>
        DecomposedClaimSchema.parse({
          content: "Test",
          entities: [],
          truth_tier: "invalid_tier",
          truth_score_estimate: 0.5,
          domain_classification: "general",
        }),
      ).toThrow();
    });

    it("rejects invalid domain classifications", () => {
      expect(() =>
        DecomposedClaimSchema.parse({
          content: "Test",
          entities: [],
          truth_tier: "single_source",
          truth_score_estimate: 0.5,
          domain_classification: "invalid_domain",
        }),
      ).toThrow();
    });

    it("rejects truth_score outside 0-1 range", () => {
      expect(() =>
        DecomposedClaimSchema.parse({
          content: "Test",
          entities: [],
          truth_tier: "single_source",
          truth_score_estimate: 1.5,
          domain_classification: "general",
        }),
      ).toThrow();
    });

    it("accepts all valid domain classifications", () => {
      const domains = ["gix", "we", "personal_finance", "health", "family", "legal", "general"];
      for (const domain of domains) {
        const claim = DecomposedClaimSchema.parse({
          content: "Test",
          entities: [],
          truth_tier: "single_source",
          truth_score_estimate: 0.5,
          domain_classification: domain,
        });
        expect(claim.domain_classification).toBe(domain);
      }
    });

    it("accepts all valid entity types", () => {
      const types = ["person", "organization", "financial_instrument", "property", "concept"];
      for (const type of types) {
        const claim = DecomposedClaimSchema.parse({
          content: "Test",
          entities: [{ name: "X", type }],
          truth_tier: "single_source",
          truth_score_estimate: 0.5,
          domain_classification: "general",
        });
        expect(claim.entities[0].type).toBe(type);
      }
    });
  });

  describe("routing", () => {
    it("always routes to frontier model for claim_decomposition", async () => {
      const router = new ModelRouter({ emitter, xaiApiKey: "test-key" });
      const decision = await router.route("claim_decomposition");
      expect(decision.tier).toBe("frontier");
      expect(decision.model).toBe("grok-4-1-fast-reasoning");
    });

    it("passes routing decision to LLM call", async () => {
      const mockLlm = createMockLlmCall([]);
      const decomposer = new ClaimDecomposer({
        emitter,
        llmCall: mockLlm,
        router: new ModelRouter({ emitter, xaiApiKey: "test-key" }),
      });

      await decomposer.decompose("test text");

      expect(mockLlm).toHaveBeenCalledOnce();
      const routing = mockLlm.mock.calls[0][2] as RoutingDecision;
      expect(routing.tier).toBe("frontier");
      expect(routing.model).toBe("grok-4-1-fast-reasoning");
    });
  });

  describe("source context", () => {
    it("includes source context in prompt when provided", async () => {
      const mockLlm = createMockLlmCall([]);
      const decomposer = new ClaimDecomposer({
        emitter,
        llmCall: mockLlm,
        router: new ModelRouter({ emitter, xaiApiKey: "test-key" }),
      });

      await decomposer.decompose("some text", {
        sourceContext: "Meeting with CFO",
      });

      const prompt = mockLlm.mock.calls[0][0] as string;
      expect(prompt).toContain("some text");
      expect(prompt).toContain("Meeting with CFO");
    });

    it("generates a source_id in result", async () => {
      const mockLlm = createMockLlmCall(JIM_BLACKSTONE_RESPONSE);
      const decomposer = new ClaimDecomposer({
        emitter,
        llmCall: mockLlm,
        router: new ModelRouter({ emitter, xaiApiKey: "test-key" }),
      });

      const result = await decomposer.decompose("test text");
      expect(result.source_id).toMatch(/^source-decomposition-/);
    });
  });

  describe("error handling", () => {
    it("returns error in result when LLM call fails", async () => {
      const mockLlm = vi.fn(async () => {
        throw new Error("API connection timeout");
      });
      const decomposer = new ClaimDecomposer({
        emitter,
        llmCall: mockLlm,
        router: new ModelRouter({ emitter, xaiApiKey: "test-key" }),
      });

      const result = await decomposer.decompose("test text");
      expect(result.claims).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("API connection timeout");
    });

    it("returns error when LLM returns invalid JSON", async () => {
      const mockLlm = vi.fn(async () => "this is not json");
      const decomposer = new ClaimDecomposer({
        emitter,
        llmCall: mockLlm,
        router: new ModelRouter({ emitter, xaiApiKey: "test-key" }),
      });

      const result = await decomposer.decompose("test text");
      expect(result.claims).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("telemetry", () => {
    it("emits telemetry event on successful decomposition", async () => {
      const mockEmitter = new TelemetryEmitter(tempDir);
      const emitSpy = vi.spyOn(mockEmitter, "emit");

      const mockLlm = createMockLlmCall(JIM_BLACKSTONE_RESPONSE);
      const decomposer = new ClaimDecomposer({
        emitter: mockEmitter,
        llmCall: mockLlm,
        router: new ModelRouter({ emitter: mockEmitter, xaiApiKey: "test-key" }),
      });

      await decomposer.decompose("test text");

      // Find the decomposition telemetry event (not routing events)
      const decompositionEvents = emitSpy.mock.calls.filter(
        (call) => (call[0] as Record<string, unknown>).event_subtype === "claim_decomposition",
      );
      expect(decompositionEvents.length).toBe(1);
      const event = decompositionEvents[0][0] as Record<string, unknown>;
      expect(event.agent_name).toBe("knowledge_agent");
      expect(event.event_type).toBe("knowledge_write");
      expect(event.outcome).toBe("success");
      const metadata = event.metadata as Record<string, unknown>;
      expect(metadata.claims_extracted).toBe(2);
    });

    it("emits failure telemetry on error", async () => {
      const mockEmitter = new TelemetryEmitter(tempDir);
      const emitSpy = vi.spyOn(mockEmitter, "emit");

      const mockLlm = vi.fn(async () => {
        throw new Error("API error");
      });
      const decomposer = new ClaimDecomposer({
        emitter: mockEmitter,
        llmCall: mockLlm,
        router: new ModelRouter({ emitter: mockEmitter, xaiApiKey: "test-key" }),
      });

      await decomposer.decompose("test text");

      const decompositionEvents = emitSpy.mock.calls.filter(
        (call) => (call[0] as Record<string, unknown>).event_subtype === "claim_decomposition",
      );
      expect(decompositionEvents.length).toBe(1);
      const event = decompositionEvents[0][0] as Record<string, unknown>;
      expect(event.outcome).toBe("failure");
    });
  });
});
