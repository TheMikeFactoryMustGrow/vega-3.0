import { writeFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TelemetryEventSchema, type TelemetryEvent, type TelemetryEventInput } from "./types.js";

/**
 * TelemetryEmitter — Tier 1 JSONL event stream writer
 *
 * Appends structured telemetry events to daily JSONL files.
 * Non-blocking: telemetry failures never block agent operations.
 *
 * File location: {basePath}/events/{YYYY-MM-DD}.jsonl
 * Archive location: {basePath}/archive/
 */
export class TelemetryEmitter {
  private readonly eventsDir: string;
  private readonly archiveDir: string;
  private initialized = false;

  constructor(private readonly basePath: string = path.join(process.env.HOME ?? "~", "vega-telemetry")) {
    this.eventsDir = path.join(this.basePath, "events");
    this.archiveDir = path.join(this.basePath, "archive");
  }

  /** Ensure directories exist (idempotent) */
  private async ensureDirs(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.eventsDir, { recursive: true });
    await mkdir(this.archiveDir, { recursive: true });
    this.initialized = true;
  }

  /** Get the JSONL file path for a given date */
  getEventFilePath(date: Date = new Date()): string {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    return path.join(this.eventsDir, `${yyyy}-${mm}-${dd}.jsonl`);
  }

  /** Get the archive path for a given JSONL file */
  getArchivePath(eventFileName: string): string {
    return path.join(this.archiveDir, `${eventFileName}.gz`);
  }

  /** Get the events directory path */
  getEventsDir(): string {
    return this.eventsDir;
  }

  /** Get the archive directory path */
  getArchiveDir(): string {
    return this.archiveDir;
  }

  /**
   * Emit a telemetry event — non-blocking.
   *
   * Generates event_id (UUID v7-compatible) and timestamp if not provided.
   * Validates against the schema, then appends to the daily JSONL file.
   * Returns the complete event on success, null on failure.
   * Never throws — telemetry failures are silently logged to stderr.
   */
  async emit(input: TelemetryEventInput): Promise<TelemetryEvent | null> {
    try {
      await this.ensureDirs();

      const event: TelemetryEvent = TelemetryEventSchema.parse({
        event_id: input.event_id ?? randomUUID(),
        timestamp: input.timestamp ?? new Date().toISOString(),
        agent_name: input.agent_name,
        event_type: input.event_type,
        event_subtype: input.event_subtype,
        session_id: input.session_id,
        model_used: input.model_used ?? null,
        tokens_in: input.tokens_in ?? null,
        tokens_out: input.tokens_out ?? null,
        latency_ms: input.latency_ms ?? null,
        outcome: input.outcome,
        metadata: input.metadata ?? {},
      });

      const filePath = this.getEventFilePath(new Date(event.timestamp));
      const line = JSON.stringify(event) + "\n";

      if (!existsSync(filePath)) {
        await writeFile(filePath, line, "utf-8");
      } else {
        await appendFile(filePath, line, "utf-8");
      }

      return event;
    } catch (err) {
      // Non-blocking: telemetry failures never block agent operations
      process.stderr.write(`[TelemetryEmitter] Failed to emit event: ${err}\n`);
      return null;
    }
  }

  /**
   * Emit multiple events (convenience method).
   * Each event is emitted independently — partial failures don't block others.
   */
  async emitBatch(inputs: TelemetryEventInput[]): Promise<(TelemetryEvent | null)[]> {
    return Promise.all(inputs.map((input) => this.emit(input)));
  }

  /**
   * Read all events from a specific date's JSONL file.
   * Returns parsed events or an empty array if the file doesn't exist.
   */
  async readEvents(date: Date = new Date()): Promise<TelemetryEvent[]> {
    const filePath = this.getEventFilePath(date);
    try {
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      return lines.map((line) => TelemetryEventSchema.parse(JSON.parse(line)));
    } catch {
      return [];
    }
  }
}
