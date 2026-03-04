import { TelemetryEmitter } from "../telemetry/emitter.js";

/**
 * ModelRouter — Routes LLM requests to the correct provider based on task type.
 *
 * Frontier (grok-4-1-fast-reasoning via xAI): AQM, claim decomposition, contradiction
 *   detection, initial seeding, complex reasoning.
 * Local (qwen3:32b via Ollama): routine claim updates, embedding preprocessing,
 *   low-stakes formatting, pre-reflections.
 * Embeddings (text-embedding-3-small via OpenAI): routed through EmbeddingPipeline.
 *
 * Environment variables:
 *   XAI_API_KEY (required for frontier)
 *   LLM_BASE_URL (default: https://api.x.ai/v1)
 *   OLLAMA_BASE_URL (default: http://localhost:11434)
 */

export type ModelTier = "frontier" | "local" | "embeddings";

export type TaskType =
  | "claim_decomposition"
  | "contradiction_detection"
  | "aqm_query"
  | "aqm_synthesis"
  | "initial_seeding"
  | "complex_reasoning"
  | "formatting"
  | "embedding_preprocessing"
  | "routine_update"
  | "pre_reflection"
  | "embedding";

export interface ModelRouterConfig {
  default_model: ModelTier;
  cost_optimization: boolean;
  supervision_sample_rate: number;
  quality_threshold: number;
}

export interface RoutingDecision {
  tier: ModelTier;
  model: string;
  baseURL: string;
  apiKey: string;
  cost_warning?: boolean;
  reason: string;
}

export interface ModelRouterOptions {
  xaiApiKey?: string;
  llmBaseURL?: string;
  ollamaBaseURL?: string;
  emitter?: TelemetryEmitter;
  config?: Partial<ModelRouterConfig>;
}

const DEFAULT_CONFIG: ModelRouterConfig = {
  default_model: "frontier",
  cost_optimization: true,
  supervision_sample_rate: 0.1,
  quality_threshold: 0.85,
};

/** Tasks that MUST use frontier model — never delegated to local */
const FRONTIER_ONLY_TASKS: ReadonlySet<TaskType> = new Set([
  "claim_decomposition",
  "contradiction_detection",
  "aqm_query",
  "aqm_synthesis",
  "initial_seeding",
  "complex_reasoning",
]);

/** Tasks eligible for local model delegation */
const LOCAL_ELIGIBLE_TASKS: ReadonlySet<TaskType> = new Set([
  "formatting",
  "embedding_preprocessing",
  "routine_update",
  "pre_reflection",
]);

export class ModelRouter {
  private readonly xaiApiKey: string;
  private readonly llmBaseURL: string;
  private readonly ollamaBaseURL: string;
  private readonly emitter: TelemetryEmitter;
  private readonly config: ModelRouterConfig;
  private readonly sessionId: string;

  constructor(options?: ModelRouterOptions) {
    this.xaiApiKey = options?.xaiApiKey ?? process.env.XAI_API_KEY ?? "";
    this.llmBaseURL =
      options?.llmBaseURL ?? process.env.LLM_BASE_URL ?? "https://api.x.ai/v1";
    this.ollamaBaseURL =
      options?.ollamaBaseURL ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    this.emitter = options?.emitter ?? new TelemetryEmitter();
    this.config = { ...DEFAULT_CONFIG, ...options?.config };
    this.sessionId = `router-${Date.now()}`;
  }

  /**
   * Route a task to the appropriate model.
   * Returns the model tier, model name, base URL, and API key to use.
   */
  async route(taskType: TaskType): Promise<RoutingDecision> {
    const start = Date.now();

    // Embedding tasks always go to the embedding pipeline
    if (taskType === "embedding") {
      const decision: RoutingDecision = {
        tier: "embeddings",
        model: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
        baseURL: process.env.EMBEDDING_BASE_URL ?? "https://api.openai.com/v1",
        apiKey: process.env.OPENAI_API_KEY ?? "",
        reason: "Embedding tasks routed to OpenAI embedding pipeline",
      };
      await this.emitRoutingEvent(taskType, decision, Date.now() - start);
      return decision;
    }

    // Frontier-only tasks — never delegated
    if (FRONTIER_ONLY_TASKS.has(taskType)) {
      const decision: RoutingDecision = {
        tier: "frontier",
        model: "grok-4-1-fast-reasoning",
        baseURL: this.llmBaseURL,
        apiKey: this.xaiApiKey,
        reason: `Task '${taskType}' requires frontier model — complex reasoning, never delegated`,
      };
      await this.emitRoutingEvent(taskType, decision, Date.now() - start);
      return decision;
    }

    // Local-eligible tasks — try local first, fallback to frontier
    if (LOCAL_ELIGIBLE_TASKS.has(taskType)) {
      const localAvailable = await this.checkLocalAvailability();

      if (localAvailable) {
        const decision: RoutingDecision = {
          tier: "local",
          model: "qwen3:32b",
          baseURL: this.ollamaBaseURL,
          apiKey: "",
          reason: `Task '${taskType}' routed to local model — routine task, cost optimized`,
        };
        await this.emitRoutingEvent(taskType, decision, Date.now() - start);
        return decision;
      }

      // Fallback to frontier with cost warning
      const decision: RoutingDecision = {
        tier: "frontier",
        model: "grok-4-1-fast-reasoning",
        baseURL: this.llmBaseURL,
        apiKey: this.xaiApiKey,
        cost_warning: true,
        reason: `Local model unavailable — falling back to frontier for '${taskType}' (cost warning)`,
      };
      await this.emitRoutingEvent(taskType, decision, Date.now() - start);
      return decision;
    }

    // Default: route to frontier
    const decision: RoutingDecision = {
      tier: "frontier",
      model: "grok-4-1-fast-reasoning",
      baseURL: this.llmBaseURL,
      apiKey: this.xaiApiKey,
      reason: `Unknown task '${taskType}' — defaulting to frontier model`,
    };
    await this.emitRoutingEvent(taskType, decision, Date.now() - start);
    return decision;
  }

  /** Get the router configuration */
  getConfig(): Readonly<ModelRouterConfig> {
    return this.config;
  }

  /** Check if a task type requires the frontier model */
  isFrontierOnly(taskType: TaskType): boolean {
    return FRONTIER_ONLY_TASKS.has(taskType);
  }

  /** Check if a task type is eligible for local model delegation */
  isLocalEligible(taskType: TaskType): boolean {
    return LOCAL_ELIGIBLE_TASKS.has(taskType);
  }

  /**
   * Check if the local Ollama model is available.
   * Non-blocking — returns false on any error.
   */
  private async checkLocalAvailability(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(`${this.ollamaBaseURL}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) return false;

      const data = (await response.json()) as { models?: Array<{ name: string }> };
      const models = data.models ?? [];
      return models.some(
        (m) => m.name.startsWith("qwen3:32b") || m.name === "qwen3:32b",
      );
    } catch {
      return false;
    }
  }

  private async emitRoutingEvent(
    taskType: TaskType,
    decision: RoutingDecision,
    latencyMs: number,
  ): Promise<void> {
    try {
      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_query",
        event_subtype: "model_routing",
        session_id: this.sessionId,
        model_used: decision.model,
        outcome: "success",
        latency_ms: latencyMs,
        metadata: {
          task_type: taskType,
          tier: decision.tier,
          cost_warning: decision.cost_warning ?? false,
          reason: decision.reason,
        },
      });
    } catch {
      // Non-blocking: telemetry failure never blocks routing
    }
  }
}
