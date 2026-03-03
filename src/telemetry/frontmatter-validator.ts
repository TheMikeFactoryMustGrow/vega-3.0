import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  NoteType,
  FrontmatterSchemas,
  type ValidationResult,
  type ValidationError,
  EscalationLevel,
} from "./frontmatter-validator-types.js";
import { TelemetryEmitter } from "./emitter.js";

/**
 * VEGA v3.3 — Frontmatter Validator
 *
 * Validates YAML frontmatter for all 6 Obsidian note types at write time.
 * Invalid frontmatter triggers a Level 2 escalation (Bar Raiser review)
 * and the note is NOT written, preventing data corruption in the
 * dual-write invariant (Obsidian ↔ Neo4j).
 */

export interface WriteNoteOptions {
  /** Note type (Claim, Entity, Source, OpenQuestion, Bet, MOC) */
  note_type: string;
  /** YAML frontmatter as a JS object */
  frontmatter: Record<string, unknown>;
  /** Markdown body content (after frontmatter) */
  body: string;
  /** Absolute file path to write the note to */
  file_path: string;
  /** Agent performing the write (for escalation context) */
  agent_name?: string;
}

export interface WriteNoteResult {
  success: boolean;
  validation: ValidationResult;
  /** If validation failed, escalation details */
  escalation?: {
    level: number;
    reason: string;
    agent_name: string;
    note_type: string;
    errors: ValidationError[];
  };
}

export class FrontmatterValidator {
  private emitter: TelemetryEmitter | null;

  constructor(options?: { emitter?: TelemetryEmitter }) {
    this.emitter = options?.emitter ?? null;
  }

  /**
   * Validate frontmatter against the schema for a given note type.
   */
  validate(noteType: string, frontmatter: Record<string, unknown>): ValidationResult {
    // Validate note type itself
    const noteTypeParse = NoteType.safeParse(noteType);
    if (!noteTypeParse.success) {
      return {
        valid: false,
        note_type: noteType as any,
        errors: [
          {
            field: "note_type",
            message: `Invalid note type '${noteType}'. Must be one of: Claim, Entity, Source, OpenQuestion, Bet, MOC`,
            code: "invalid_note_type",
          },
        ],
      };
    }

    const validNoteType = noteTypeParse.data;
    const schema = FrontmatterSchemas[validNoteType];
    const result = schema.safeParse(frontmatter);

    if (result.success) {
      return {
        valid: true,
        note_type: validNoteType,
        errors: [],
      };
    }

    // Map Zod errors to our ValidationError format
    const errors: ValidationError[] = result.error.issues.map((issue: z.ZodIssue) => ({
      field: issue.path.join(".") || "(root)",
      message: issue.message,
      code: issue.code,
    }));

    return {
      valid: false,
      note_type: validNoteType,
      errors,
    };
  }

  /**
   * Validate frontmatter and write the note if valid.
   * Invalid frontmatter triggers a Level 2 escalation and the note is NOT written.
   */
  async writeNote(options: WriteNoteOptions): Promise<WriteNoteResult> {
    const { note_type, frontmatter, body, file_path, agent_name = "knowledge_agent" } = options;

    const validation = this.validate(note_type, frontmatter);

    if (!validation.valid) {
      const escalation = {
        level: EscalationLevel.LEVEL_2,
        reason: `Frontmatter validation failed for ${note_type} note: ${validation.errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`,
        agent_name,
        note_type,
        errors: validation.errors,
      };

      // Log escalation to telemetry (non-blocking)
      await this.logEscalation(agent_name, note_type, validation.errors);

      return {
        success: false,
        validation,
        escalation,
      };
    }

    // Build the markdown content with YAML frontmatter
    const yamlLines = ["---"];
    for (const [key, value] of Object.entries(frontmatter)) {
      if (Array.isArray(value)) {
        yamlLines.push(`${key}:`);
        for (const item of value) {
          yamlLines.push(`  - ${item}`);
        }
      } else {
        yamlLines.push(`${key}: ${formatYamlValue(value)}`);
      }
    }
    yamlLines.push("---");
    yamlLines.push("");
    yamlLines.push(body);

    const content = yamlLines.join("\n");

    // Ensure directory exists
    const dir = path.dirname(file_path);
    await mkdir(dir, { recursive: true });

    // Write the note
    await writeFile(file_path, content, "utf-8");

    // Log successful write to telemetry (non-blocking)
    await this.logWrite(agent_name, note_type, file_path);

    return {
      success: true,
      validation,
    };
  }

  private async logEscalation(
    agentName: string,
    noteType: string,
    errors: ValidationError[],
  ): Promise<void> {
    if (!this.emitter) return;
    try {
      await this.emitter.emit({
        agent_name: agentName,
        event_type: "escalation",
        event_subtype: "frontmatter_validation_failed",
        session_id: "frontmatter-validator",
        outcome: "failure",
        metadata: {
          note_type: noteType,
          escalation_level: EscalationLevel.LEVEL_2,
          errors,
        },
      });
    } catch {
      // Non-blocking — telemetry failures never block operations
    }
  }

  private async logWrite(
    agentName: string,
    noteType: string,
    filePath: string,
  ): Promise<void> {
    if (!this.emitter) return;
    try {
      await this.emitter.emit({
        agent_name: agentName,
        event_type: "knowledge_write",
        event_subtype: "note_written",
        session_id: "frontmatter-validator",
        outcome: "success",
        metadata: {
          note_type: noteType,
          file_path: filePath,
        },
      });
    } catch {
      // Non-blocking — telemetry failures never block operations
    }
  }
}

/** Format a value for YAML output */
function formatYamlValue(value: unknown): string {
  if (typeof value === "string") {
    // Quote strings that could be misinterpreted
    if (
      value === "" ||
      value.includes(":") ||
      value.includes("#") ||
      value.includes("'") ||
      value.includes('"') ||
      value.includes("\n") ||
      /^[{[]/.test(value)
    ) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "null";
  }
  return String(value);
}
