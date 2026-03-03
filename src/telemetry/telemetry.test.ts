import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TelemetryEmitter } from "./emitter.js";
import { TelemetryEventSchema, EventType } from "./types.js";
import { runRotation } from "./rotation.js";
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { createGzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import os from "node:os";

let tmpDir: string;
let emitter: TelemetryEmitter;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "vega-telemetry-test-"));
  emitter = new TelemetryEmitter(tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("TelemetryEmitter", () => {
  describe("Event schema validation", () => {
    it("accepts a valid event with all required fields", () => {
      const event = {
        event_id: "a7b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6",
        timestamp: "2026-03-03T14:22:31.442Z",
        agent_name: "knowledge_agent",
        event_type: "agent_action" as const,
        event_subtype: "neo4j_write",
        session_id: "session-001",
        model_used: "grok-4-1-fast-reasoning",
        tokens_in: 1240,
        tokens_out: 320,
        latency_ms: 1842,
        outcome: "success" as const,
        metadata: { source_note: "GIX/Meeting Notes/2026-02-28-Board.md" },
      };

      const parsed = TelemetryEventSchema.parse(event);
      expect(parsed.event_id).toBe(event.event_id);
      expect(parsed.agent_name).toBe("knowledge_agent");
      expect(parsed.event_type).toBe("agent_action");
    });

    it("rejects an event with invalid event_type", () => {
      expect(() =>
        TelemetryEventSchema.parse({
          event_id: "a7b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6",
          timestamp: "2026-03-03T14:22:31.442Z",
          agent_name: "test",
          event_type: "invalid_type",
          event_subtype: "test",
          session_id: "s1",
          outcome: "success",
        })
      ).toThrow();
    });

    it("validates all 7 event_type categories", () => {
      const types = EventType.options;
      expect(types).toEqual([
        "agent_action",
        "model_call",
        "knowledge_write",
        "knowledge_query",
        "escalation",
        "schedule_trigger",
        "system_event",
      ]);
      expect(types).toHaveLength(7);
    });
  });

  describe("Event emission", () => {
    it("emits an event and writes to today's JSONL file", async () => {
      const event = await emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "agent_action",
        event_subtype: "neo4j_write",
        session_id: "session-001",
        model_used: "grok-4-1-fast-reasoning",
        tokens_in: 100,
        tokens_out: 50,
        latency_ms: 500,
        outcome: "success",
        metadata: { test: true },
      });

      expect(event).not.toBeNull();
      expect(event!.event_id).toBeDefined();
      expect(event!.timestamp).toBeDefined();
      expect(event!.agent_name).toBe("knowledge_agent");

      // Verify the file exists and contains the event
      const filePath = emitter.getEventFilePath();
      const content = await readFile(filePath, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.event_id).toBe(event!.event_id);
    });

    it("trigger 3 different agent actions → verify 3 events with valid schema", async () => {
      // AC: "Test: trigger 3 different agent actions → verify 3 events appear in today's JSONL with valid schema"
      const events = await emitter.emitBatch([
        {
          agent_name: "knowledge_agent",
          event_type: "agent_action",
          event_subtype: "neo4j_write",
          session_id: "s1",
          outcome: "success",
          latency_ms: 200,
        },
        {
          agent_name: "vega_core",
          event_type: "model_call",
          event_subtype: "frontier_call",
          session_id: "s1",
          model_used: "grok-4-1-fast-reasoning",
          tokens_in: 500,
          tokens_out: 200,
          outcome: "success",
          latency_ms: 1500,
        },
        {
          agent_name: "bar_raiser",
          event_type: "knowledge_query",
          event_subtype: "aqm_query",
          session_id: "s1",
          outcome: "success",
          latency_ms: 800,
        },
      ]);

      // All 3 should have succeeded
      expect(events.filter(Boolean)).toHaveLength(3);

      // Verify all 3 are in today's JSONL
      const todayEvents = await emitter.readEvents(new Date());
      expect(todayEvents).toHaveLength(3);

      // Validate each against schema
      for (const event of todayEvents) {
        const result = TelemetryEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      }

      // Verify different agent names
      const agents = todayEvents.map((e) => e.agent_name);
      expect(agents).toContain("knowledge_agent");
      expect(agents).toContain("vega_core");
      expect(agents).toContain("bar_raiser");
    });

    it("is non-blocking — invalid events return null without throwing", async () => {
      // Emit with invalid data should return null, not throw
      const result = await emitter.emit({
        agent_name: "",
        event_type: "agent_action",
        event_subtype: "test",
        session_id: "s1",
        outcome: "success",
      });
      expect(result).toBeNull();
    });

    it("auto-generates event_id and timestamp when not provided", async () => {
      const event = await emitter.emit({
        agent_name: "test_agent",
        event_type: "system_event",
        event_subtype: "test",
        session_id: "s1",
        outcome: "success",
      });

      expect(event).not.toBeNull();
      expect(event!.event_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(new Date(event!.timestamp).getTime()).not.toBeNaN();
    });

    it("writes events to the correct date-based file", async () => {
      const specificDate = "2026-02-15T10:00:00.000Z";
      const event = await emitter.emit({
        agent_name: "test_agent",
        event_type: "agent_action",
        event_subtype: "test",
        session_id: "s1",
        timestamp: specificDate,
        outcome: "success",
      });

      expect(event).not.toBeNull();
      const expectedPath = path.join(emitter.getEventsDir(), "2026-02-15.jsonl");
      const content = await readFile(expectedPath, "utf-8");
      expect(content).toContain(event!.event_id);
    });
  });

  describe("Event metadata", () => {
    it("supports flexible metadata JSON", async () => {
      const event = await emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "agent_action",
        event_subtype: "neo4j_write",
        session_id: "s1",
        outcome: "success",
        metadata: {
          source_note: "GIX/Board/2026-02.md",
          trust_level: "suggest",
          triggered_by: "vault_file_watcher",
          nested: { deep: true },
        },
      });

      expect(event).not.toBeNull();
      expect(event!.metadata).toEqual({
        source_note: "GIX/Board/2026-02.md",
        trust_level: "suggest",
        triggered_by: "vault_file_watcher",
        nested: { deep: true },
      });
    });
  });
});

describe("Rotation Job", () => {
  it("archives files older than 30 days as gzip", async () => {
    // AC: "Test: verify event file for 31-day-old date is in archive/ as .jsonl.gz"
    const eventsDir = path.join(tmpDir, "events");
    const archiveDir = path.join(tmpDir, "archive");
    await mkdir(eventsDir, { recursive: true });
    await mkdir(archiveDir, { recursive: true });

    // Create a file dated 31 days ago
    const oldDate = new Date();
    oldDate.setUTCDate(oldDate.getUTCDate() - 31);
    const yyyy = oldDate.getUTCFullYear();
    const mm = String(oldDate.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(oldDate.getUTCDate()).padStart(2, "0");
    const oldFileName = `${yyyy}-${mm}-${dd}.jsonl`;

    const testEvent = JSON.stringify({
      event_id: "test-uuid",
      timestamp: oldDate.toISOString(),
      agent_name: "test",
      event_type: "system_event",
      event_subtype: "test",
      session_id: "s1",
      outcome: "success",
      metadata: {},
    });
    await writeFile(path.join(eventsDir, oldFileName), testEvent + "\n");

    // Also create a recent file (should NOT be archived)
    const recentDate = new Date();
    const rYyyy = recentDate.getUTCFullYear();
    const rMm = String(recentDate.getUTCMonth() + 1).padStart(2, "0");
    const rDd = String(recentDate.getUTCDate()).padStart(2, "0");
    const recentFileName = `${rYyyy}-${rMm}-${rDd}.jsonl`;
    await writeFile(path.join(eventsDir, recentFileName), testEvent + "\n");

    const now = new Date();
    const result = await runRotation(eventsDir, archiveDir, now);

    // Old file should be archived
    expect(result.archived).toContain(oldFileName);
    expect(result.errors).toHaveLength(0);

    // Verify gzip exists in archive
    const archiveFiles = await readdir(archiveDir);
    expect(archiveFiles).toContain(`${oldFileName}.gz`);

    // Old file should be removed from events
    const eventFiles = await readdir(eventsDir);
    expect(eventFiles).not.toContain(oldFileName);

    // Recent file should still be in events
    expect(eventFiles).toContain(recentFileName);
  });

  it("deletes archive files older than 90 days", async () => {
    const eventsDir = path.join(tmpDir, "events");
    const archiveDir = path.join(tmpDir, "archive");
    await mkdir(eventsDir, { recursive: true });
    await mkdir(archiveDir, { recursive: true });

    // Create a gzipped file dated 91 days ago
    const oldDate = new Date();
    oldDate.setUTCDate(oldDate.getUTCDate() - 91);
    const yyyy = oldDate.getUTCFullYear();
    const mm = String(oldDate.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(oldDate.getUTCDate()).padStart(2, "0");
    const oldArchiveFile = `${yyyy}-${mm}-${dd}.jsonl.gz`;

    // Write a dummy gz file
    const srcPath = path.join(archiveDir, `temp.jsonl`);
    const destPath = path.join(archiveDir, oldArchiveFile);
    await writeFile(srcPath, "test data\n");
    const readStream = createReadStream(srcPath);
    const gzipStream = createGzip();
    const writeStream = createWriteStream(destPath);
    await pipeline(readStream, gzipStream, writeStream);
    await rm(srcPath);

    const now = new Date();
    const result = await runRotation(eventsDir, archiveDir, now);

    expect(result.deleted).toContain(oldArchiveFile);

    const archiveFiles = await readdir(archiveDir);
    expect(archiveFiles).not.toContain(oldArchiveFile);
  });

  it("preserves files within retention windows", async () => {
    const eventsDir = path.join(tmpDir, "events");
    const archiveDir = path.join(tmpDir, "archive");
    await mkdir(eventsDir, { recursive: true });
    await mkdir(archiveDir, { recursive: true });

    // Create a file dated 15 days ago (within 30-day active window)
    const recentDate = new Date();
    recentDate.setUTCDate(recentDate.getUTCDate() - 15);
    const yyyy = recentDate.getUTCFullYear();
    const mm = String(recentDate.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(recentDate.getUTCDate()).padStart(2, "0");
    const recentFileName = `${yyyy}-${mm}-${dd}.jsonl`;
    await writeFile(path.join(eventsDir, recentFileName), "test\n");

    // Create a gzipped file dated 60 days ago (within 90-day archive window)
    const midDate = new Date();
    midDate.setUTCDate(midDate.getUTCDate() - 60);
    const mYyyy = midDate.getUTCFullYear();
    const mMm = String(midDate.getUTCMonth() + 1).padStart(2, "0");
    const mDd = String(midDate.getUTCDate()).padStart(2, "0");
    const midArchiveFile = `${mYyyy}-${mMm}-${mDd}.jsonl.gz`;

    const srcPath = path.join(archiveDir, `temp.jsonl`);
    await writeFile(srcPath, "test data\n");
    const readStream = createReadStream(srcPath);
    const gzipStream = createGzip();
    const writeStream = createWriteStream(path.join(archiveDir, midArchiveFile));
    await pipeline(readStream, gzipStream, writeStream);
    await rm(srcPath);

    const result = await runRotation(eventsDir, archiveDir, new Date());

    expect(result.archived).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);

    // Both files should still exist
    const eventFiles = await readdir(eventsDir);
    expect(eventFiles).toContain(recentFileName);
    const archiveFiles = await readdir(archiveDir);
    expect(archiveFiles).toContain(midArchiveFile);
  });
});
