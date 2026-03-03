import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TelemetryEmitter } from "./emitter.js";
import { PreReflection } from "./pre-reflection.js";
import type { TelemetryEventInput } from "./types.js";

let emitter: TelemetryEmitter;
let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "vega-prereflection-"));
  emitter = new TelemetryEmitter(tempDir);
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── Helper: emit events for Knowledge Agent ────────────────────────────────

async function emitAgentEvents(
  count: number,
  options: {
    agentName?: string;
    date?: Date;
    failureRate?: number;
    includeBlame?: boolean;
    includePredictions?: boolean;
  } = {},
): Promise<void> {
  const {
    agentName = "knowledge_agent",
    date = new Date("2026-03-02T12:00:00Z"),
    failureRate = 0.1,
    includeBlame = false,
    includePredictions = false,
  } = options;

  for (let i = 0; i < count; i++) {
    const isFailure = i < count * failureRate;
    const ts = new Date(date.getTime() + i * 60_000); // 1 min apart

    const eventTypes = [
      "agent_action",
      "model_call",
      "knowledge_write",
      "knowledge_query",
    ] as const;
    const subtypes = [
      "graph_query",
      "claim_write",
      "entity_lookup",
      "source_verify",
    ];

    const input: TelemetryEventInput = {
      agent_name: agentName,
      event_type: eventTypes[i % eventTypes.length],
      event_subtype: isFailure ? "graph_query" : subtypes[i % subtypes.length],
      session_id: `test_session_${i}`,
      model_used: "qwen3:32b",
      tokens_in: 500,
      tokens_out: 200,
      latency_ms: 100 + (i % 10) * 50,
      outcome: isFailure ? "failure" : "success",
      timestamp: ts.toISOString(),
      metadata: {
        ...(isFailure && includeBlame
          ? { reason: "blocked by upstream error from other agent failed" }
          : {}),
        ...(includePredictions
          ? { predicted_outcome: isFailure ? "success" : "success" }
          : {}),
      },
    };

    await emitter.emit(input);
  }
}

// ─── Test: generate pre-reflection digest with all required sections ────────

describe("PreReflection — digest generation", () => {
  it("generates a digest with all required sections for Knowledge Agent with 150 events", async () => {
    const now = new Date("2026-03-02T18:00:00Z");

    await emitAgentEvents(150, {
      agentName: "knowledge_agent",
      date: new Date("2026-03-02T10:00:00Z"),
    });

    const preReflection = new PreReflection(emitter, tempDir, {
      emitTelemetry: false,
    });
    const digest = await preReflection.generateDigest("knowledge_agent", now);

    // Verify all required sections present
    expect(digest.agent_name).toBe("knowledge_agent");
    expect(digest.model_used).toBe("qwen3:32b");

    // Event Summary
    expect(digest.event_summary.total_events).toBe(150);
    expect(digest.event_summary.by_type.length).toBeGreaterThan(0);
    expect(digest.event_summary.time_distribution.length).toBeGreaterThan(0);
    expect(digest.event_summary.date_range_start).toBeTruthy();
    expect(digest.event_summary.date_range_end).toBeTruthy();

    // Notable Failures (10% of 150 = 15 failures)
    expect(digest.notable_failures.length).toBeGreaterThan(0);
    expect(digest.notable_failures.length).toBeLessThanOrEqual(3);
    for (const f of digest.notable_failures) {
      expect(f.event_subtype).toBeTruthy();
      expect(f.count).toBeGreaterThan(0);
      expect(f.sample_event_id).toBeTruthy();
      expect(f.root_cause_analysis).toBeTruthy();
    }

    // Recurring Patterns
    // With 150 events, we should detect event bursts (>10 per hour)
    expect(digest.recurring_patterns.length).toBeGreaterThan(0);

    // Confidence Calibration (no predictions in these events)
    expect(digest.confidence_calibration.total_predictions).toBe(0);

    // Markdown contains all section headers
    expect(digest.markdown).toContain("# Pre-Reflection Digest: knowledge_agent");
    expect(digest.markdown).toContain("## Event Summary");
    expect(digest.markdown).toContain("### By Type");
    expect(digest.markdown).toContain("### Time Distribution");
    expect(digest.markdown).toContain("## Notable Failures");
    expect(digest.markdown).toContain("## Recurring Patterns");
    expect(digest.markdown).toContain("## Confidence Calibration");

    // Verify file written to disk
    const digestDir = preReflection.getDigestDir("knowledge_agent");
    expect(existsSync(path.join(digestDir, "2026-03-02.md"))).toBe(true);
    const fileContent = await readFile(
      path.join(digestDir, "2026-03-02.md"),
      "utf-8",
    );
    expect(fileContent).toBe(digest.markdown);
  });

  it("uses local model only — model_used is always qwen3:32b", async () => {
    const now = new Date("2026-03-02T18:00:00Z");

    const preReflection = new PreReflection(emitter, tempDir, {
      emitTelemetry: false,
    });
    const digest = await preReflection.generateDigest("knowledge_agent", now);

    // Pre-reflection digest always reports qwen3:32b
    expect(digest.model_used).toBe("qwen3:32b");
  });
});

// ─── Test: trigger condition — inject 100 events → verify auto-trigger ──────

describe("PreReflection — trigger conditions", () => {
  it("triggers when event threshold is reached (≥100 events)", async () => {
    // Create a fresh temp dir to isolate this test
    const isolatedDir = await mkdtemp(
      path.join(tmpdir(), "vega-prereflection-trigger-"),
    );
    const isolatedEmitter = new TelemetryEmitter(isolatedDir);

    try {
      // Emit exactly 100 events
      for (let i = 0; i < 100; i++) {
        await isolatedEmitter.emit({
          agent_name: "trigger_agent",
          event_type: "agent_action",
          event_subtype: "test_action",
          session_id: `trigger_test_${i}`,
          outcome: "success",
          timestamp: new Date("2026-03-02T10:00:00Z").toISOString(),
          model_used: "qwen3:32b",
        });
      }

      const preReflection = new PreReflection(isolatedEmitter, isolatedDir, {
        event_threshold: 100,
        emitTelemetry: false,
      });

      const now = new Date("2026-03-02T18:00:00Z");
      const trigger = await preReflection.checkTrigger("trigger_agent", now);

      expect(trigger.should_trigger).toBe(true);
      expect(trigger.reason).toContain("Event threshold reached");
      expect(trigger.events_since_last).toBeGreaterThanOrEqual(100);
    } finally {
      await rm(isolatedDir, { recursive: true, force: true });
    }
  });

  it("triggers when approaching Loop 2 deadline", async () => {
    const isolatedDir = await mkdtemp(
      path.join(tmpdir(), "vega-prereflection-deadline-"),
    );
    const isolatedEmitter = new TelemetryEmitter(isolatedDir);

    try {
      // Emit just a few events (below threshold)
      for (let i = 0; i < 10; i++) {
        await isolatedEmitter.emit({
          agent_name: "deadline_agent",
          event_type: "agent_action",
          event_subtype: "test_action",
          session_id: `deadline_test_${i}`,
          outcome: "success",
          timestamp: new Date("2026-02-28T10:00:00Z").toISOString(),
          model_used: "qwen3:32b",
        });
      }

      const preReflection = new PreReflection(isolatedEmitter, isolatedDir, {
        event_threshold: 100,
        hours_before_deadline: 24,
        weekly_deadline_day: 0, // Sunday
        weekly_deadline_hour: 20, // 20:00 UTC
        emitTelemetry: false,
      });

      // 2026-02-28 is Saturday. Now = Saturday 22:00 UTC → 22h until Sunday 2026-03-01 20:00 UTC
      const now = new Date("2026-02-28T22:00:00Z");
      const trigger = await preReflection.checkTrigger("deadline_agent", now);

      expect(trigger.should_trigger).toBe(true);
      expect(trigger.reason).toContain("Approaching Loop 2 deadline");
      expect(trigger.hours_until_deadline).toBeLessThanOrEqual(24);
    } finally {
      await rm(isolatedDir, { recursive: true, force: true });
    }
  });

  it("does not trigger when below threshold and far from deadline", async () => {
    const isolatedDir = await mkdtemp(
      path.join(tmpdir(), "vega-prereflection-notrigger-"),
    );
    const isolatedEmitter = new TelemetryEmitter(isolatedDir);

    try {
      // Emit just a few events — timestamps before "now"
      for (let i = 0; i < 5; i++) {
        await isolatedEmitter.emit({
          agent_name: "calm_agent",
          event_type: "agent_action",
          event_subtype: "test_action",
          session_id: `calm_test_${i}`,
          outcome: "success",
          timestamp: new Date("2026-03-02T06:00:00Z").toISOString(),
          model_used: "qwen3:32b",
        });
      }

      const preReflection = new PreReflection(isolatedEmitter, isolatedDir, {
        event_threshold: 100,
        hours_before_deadline: 24,
        weekly_deadline_day: 0, // Sunday
        weekly_deadline_hour: 20,
        emitTelemetry: false,
      });

      // 2026-03-02 is Monday. Monday morning — next Sunday 20:00 is ~156h away
      const now = new Date("2026-03-02T08:00:00Z");
      const trigger = await preReflection.checkTrigger("calm_agent", now);

      expect(trigger.should_trigger).toBe(false);
      expect(trigger.events_since_last).toBe(5);
      expect(trigger.hours_until_deadline).toBeGreaterThan(24);
    } finally {
      await rm(isolatedDir, { recursive: true, force: true });
    }
  });
});

// ─── Test: confidence calibration with predictions ──────────────────────────

describe("PreReflection — confidence calibration", () => {
  it("computes calibration when prediction metadata is present", async () => {
    const isolatedDir = await mkdtemp(
      path.join(tmpdir(), "vega-prereflection-confidence-"),
    );
    const isolatedEmitter = new TelemetryEmitter(isolatedDir);

    try {
      await emitAgentEventsTo(isolatedEmitter, 50, {
        agentName: "calibrated_agent",
        date: new Date("2026-03-02T10:00:00Z"),
        failureRate: 0.2,
        includePredictions: true,
      });

      const preReflection = new PreReflection(
        isolatedEmitter,
        isolatedDir,
        { emitTelemetry: false },
      );

      const digest = await preReflection.generateDigest(
        "calibrated_agent",
        new Date("2026-03-02T18:00:00Z"),
      );

      // Should have some predictions
      expect(digest.confidence_calibration.total_predictions).toBe(50);
      // 20% failure, all predicted success → overconfident for failures
      expect(digest.confidence_calibration.overconfident_count).toBeGreaterThan(0);
      expect(digest.confidence_calibration.accuracy).toBeGreaterThan(0);
      expect(digest.confidence_calibration.accuracy).toBeLessThan(1);
    } finally {
      await rm(isolatedDir, { recursive: true, force: true });
    }
  });
});

// ─── Test: external blame detection ─────────────────────────────────────────

describe("PreReflection — external blame detection", () => {
  it("detects external blame patterns in failure metadata", async () => {
    const isolatedDir = await mkdtemp(
      path.join(tmpdir(), "vega-prereflection-blame-"),
    );
    const isolatedEmitter = new TelemetryEmitter(isolatedDir);

    try {
      await emitAgentEventsTo(isolatedEmitter, 50, {
        agentName: "blaming_agent",
        date: new Date("2026-03-02T10:00:00Z"),
        failureRate: 0.2,
        includeBlame: true,
      });

      const preReflection = new PreReflection(
        isolatedEmitter,
        isolatedDir,
        { emitTelemetry: false },
      );

      const digest = await preReflection.generateDigest(
        "blaming_agent",
        new Date("2026-03-02T18:00:00Z"),
      );

      expect(digest.external_blame_detected).toBe(true);
      expect(digest.markdown).toContain("External Blame Detected");
    } finally {
      await rm(isolatedDir, { recursive: true, force: true });
    }
  });

  it("does not flag external blame when failure metadata is clean", async () => {
    const isolatedDir = await mkdtemp(
      path.join(tmpdir(), "vega-prereflection-noblame-"),
    );
    const isolatedEmitter = new TelemetryEmitter(isolatedDir);

    try {
      await emitAgentEventsTo(isolatedEmitter, 50, {
        agentName: "clean_agent",
        date: new Date("2026-03-02T10:00:00Z"),
        failureRate: 0.2,
        includeBlame: false,
      });

      const preReflection = new PreReflection(
        isolatedEmitter,
        isolatedDir,
        { emitTelemetry: false },
      );

      const digest = await preReflection.generateDigest(
        "clean_agent",
        new Date("2026-03-02T18:00:00Z"),
      );

      expect(digest.external_blame_detected).toBe(false);
      expect(digest.markdown).not.toContain("External Blame Detected");
    } finally {
      await rm(isolatedDir, { recursive: true, force: true });
    }
  });
});

// ─── Test: telemetry logging uses local model ───────────────────────────────

describe("PreReflection — telemetry logging", () => {
  it("logs pre-reflection event with model_used=qwen3:32b", async () => {
    const isolatedDir = await mkdtemp(
      path.join(tmpdir(), "vega-prereflection-telemetry-"),
    );
    const isolatedEmitter = new TelemetryEmitter(isolatedDir);

    try {
      // Emit some base events
      await emitAgentEventsTo(isolatedEmitter, 20, {
        agentName: "logged_agent",
        date: new Date("2026-03-02T10:00:00Z"),
      });

      const preReflection = new PreReflection(
        isolatedEmitter,
        isolatedDir,
        { emitTelemetry: true },
      );

      const now = new Date("2026-03-02T18:00:00Z");
      await preReflection.generateDigest("logged_agent", now);

      // Read back events and find the pre_reflection system event
      const events = await isolatedEmitter.readEvents(now);
      const preReflectionEvents = events.filter(
        (e) =>
          e.event_type === "system_event" &&
          e.event_subtype === "pre_reflection",
      );

      expect(preReflectionEvents.length).toBe(1);
      expect(preReflectionEvents[0].model_used).toBe("qwen3:32b");
      expect(preReflectionEvents[0].agent_name).toBe("logged_agent");
      expect(preReflectionEvents[0].outcome).toBe("success");
    } finally {
      await rm(isolatedDir, { recursive: true, force: true });
    }
  });
});

// ─── Helper: emit events to a specific emitter ──────────────────────────────

async function emitAgentEventsTo(
  targetEmitter: TelemetryEmitter,
  count: number,
  options: {
    agentName?: string;
    date?: Date;
    failureRate?: number;
    includeBlame?: boolean;
    includePredictions?: boolean;
  } = {},
): Promise<void> {
  const {
    agentName = "knowledge_agent",
    date = new Date("2026-03-02T12:00:00Z"),
    failureRate = 0.1,
    includeBlame = false,
    includePredictions = false,
  } = options;

  for (let i = 0; i < count; i++) {
    const isFailure = i < count * failureRate;
    const ts = new Date(date.getTime() + i * 60_000);

    const eventTypes = [
      "agent_action",
      "model_call",
      "knowledge_write",
      "knowledge_query",
    ] as const;
    const subtypes = [
      "graph_query",
      "claim_write",
      "entity_lookup",
      "source_verify",
    ];

    await targetEmitter.emit({
      agent_name: agentName,
      event_type: eventTypes[i % eventTypes.length],
      event_subtype: isFailure ? "graph_query" : subtypes[i % subtypes.length],
      session_id: `test_session_${i}`,
      model_used: "qwen3:32b",
      tokens_in: 500,
      tokens_out: 200,
      latency_ms: 100 + (i % 10) * 50,
      outcome: isFailure ? "failure" : "success",
      timestamp: ts.toISOString(),
      metadata: {
        ...(isFailure && includeBlame
          ? { reason: "blocked by upstream error from other agent failed" }
          : {}),
        ...(includePredictions
          ? { predicted_outcome: isFailure ? "success" : "success" }
          : {}),
      },
    });
  }
}
