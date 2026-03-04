import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRouter, type TaskType } from "./model-router.js";
import { TelemetryEmitter } from "../telemetry/emitter.js";

/**
 * ModelRouter tests — verifies routing logic for frontier/local/embeddings.
 *
 * Mocks fetch for Ollama availability checks.
 * Does NOT require a running Neo4j or Ollama instance.
 */

let emitter: TelemetryEmitter;
let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "vega-router-test-"));
  emitter = new TelemetryEmitter(tempDir);
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("ModelRouter", () => {
  it("creates with default config matching Implementation Guide", () => {
    const router = new ModelRouter({ emitter, xaiApiKey: "test-key" });
    const config = router.getConfig();
    expect(config.default_model).toBe("frontier");
    expect(config.cost_optimization).toBe(true);
    expect(config.supervision_sample_rate).toBe(0.1);
    expect(config.quality_threshold).toBe(0.85);
  });

  it("accepts custom config overrides", () => {
    const router = new ModelRouter({
      emitter,
      xaiApiKey: "test-key",
      config: { quality_threshold: 0.9 },
    });
    const config = router.getConfig();
    expect(config.quality_threshold).toBe(0.9);
    expect(config.default_model).toBe("frontier");
  });

  describe("frontier-only routing", () => {
    const frontierTasks: TaskType[] = [
      "claim_decomposition",
      "contradiction_detection",
      "aqm_query",
      "aqm_synthesis",
      "initial_seeding",
      "complex_reasoning",
    ];

    for (const task of frontierTasks) {
      it(`routes '${task}' to frontier model`, async () => {
        const router = new ModelRouter({
          emitter,
          xaiApiKey: "xai-test-key",
          llmBaseURL: "https://api.x.ai/v1",
        });

        const decision = await router.route(task);

        expect(decision.tier).toBe("frontier");
        expect(decision.model).toBe("grok-4-1-fast-reasoning");
        expect(decision.baseURL).toBe("https://api.x.ai/v1");
        expect(decision.apiKey).toBe("xai-test-key");
        expect(decision.cost_warning).toBeUndefined();
        expect(decision.reason).toContain("frontier");
      });
    }

    it("isFrontierOnly returns true for frontier tasks", () => {
      const router = new ModelRouter({ emitter, xaiApiKey: "test-key" });
      expect(router.isFrontierOnly("claim_decomposition")).toBe(true);
      expect(router.isFrontierOnly("aqm_query")).toBe(true);
      expect(router.isFrontierOnly("formatting")).toBe(false);
    });
  });

  describe("local model routing", () => {
    const localTasks: TaskType[] = [
      "formatting",
      "embedding_preprocessing",
      "routine_update",
      "pre_reflection",
    ];

    it("isLocalEligible returns true for local-eligible tasks", () => {
      const router = new ModelRouter({ emitter, xaiApiKey: "test-key" });
      expect(router.isLocalEligible("formatting")).toBe(true);
      expect(router.isLocalEligible("routine_update")).toBe(true);
      expect(router.isLocalEligible("claim_decomposition")).toBe(false);
    });

    for (const task of localTasks) {
      it(`routes '${task}' to local model when Ollama available`, async () => {
        // Mock fetch to simulate Ollama with qwen3:32b available
        const mockFetch = vi.fn().mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            models: [{ name: "qwen3:32b", size: 20000000000 }],
          }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const router = new ModelRouter({
          emitter,
          xaiApiKey: "xai-test-key",
          ollamaBaseURL: "http://localhost:11434",
        });

        const decision = await router.route(task);

        expect(decision.tier).toBe("local");
        expect(decision.model).toBe("qwen3:32b");
        expect(decision.baseURL).toBe("http://localhost:11434");
        expect(decision.cost_warning).toBeUndefined();

        vi.unstubAllGlobals();
      });
    }

    it("falls back to frontier with cost_warning when Ollama unavailable", async () => {
      // Mock fetch to simulate Ollama offline
      const mockFetch = vi.fn().mockRejectedValueOnce(new Error("Connection refused"));
      vi.stubGlobal("fetch", mockFetch);

      const router = new ModelRouter({
        emitter,
        xaiApiKey: "xai-test-key",
        llmBaseURL: "https://api.x.ai/v1",
      });

      const decision = await router.route("formatting");

      expect(decision.tier).toBe("frontier");
      expect(decision.model).toBe("grok-4-1-fast-reasoning");
      expect(decision.cost_warning).toBe(true);
      expect(decision.reason).toContain("Local model unavailable");

      vi.unstubAllGlobals();
    });

    it("falls back to frontier when Ollama responds but qwen3:32b not found", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{ name: "llama3:8b", size: 5000000000 }],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const router = new ModelRouter({
        emitter,
        xaiApiKey: "xai-test-key",
      });

      const decision = await router.route("formatting");

      expect(decision.tier).toBe("frontier");
      expect(decision.cost_warning).toBe(true);

      vi.unstubAllGlobals();
    });
  });

  describe("embedding routing", () => {
    it("routes 'embedding' task to embeddings tier", async () => {
      const router = new ModelRouter({ emitter, xaiApiKey: "test-key" });
      const decision = await router.route("embedding");

      expect(decision.tier).toBe("embeddings");
      expect(decision.model).toBe("text-embedding-3-small");
      expect(decision.reason).toContain("embedding pipeline");
    });
  });

  describe("telemetry emission", () => {
    it("emits routing telemetry with model_used and task_type metadata", async () => {
      const mockFetch = vi.fn().mockRejectedValueOnce(new Error("offline"));
      vi.stubGlobal("fetch", mockFetch);

      const localEmitter = new TelemetryEmitter(tempDir);
      const router = new ModelRouter({
        emitter: localEmitter,
        xaiApiKey: "xai-test-key",
      });

      await router.route("claim_decomposition");

      const events = await localEmitter.readEvents(new Date());
      const routingEvents = events.filter(
        (e) => e.event_subtype === "model_routing",
      );
      expect(routingEvents.length).toBeGreaterThanOrEqual(1);

      const latest = routingEvents[routingEvents.length - 1];
      expect(latest.agent_name).toBe("knowledge_agent");
      expect(latest.model_used).toBe("grok-4-1-fast-reasoning");
      expect(latest.metadata).toHaveProperty("task_type", "claim_decomposition");
      expect(latest.metadata).toHaveProperty("tier", "frontier");

      vi.unstubAllGlobals();
    });
  });
});
