import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { TelemetryEmitter } from "../telemetry/emitter.js";
import {
  materialize_icloud_stubs,
  type MaterializeOptions,
  type MaterializationReport,
} from "../telemetry/icloud-sync.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface VaultFile {
  path: string;
  frontmatter: Record<string, unknown> | null;
  body: string;
  lastModified: Date;
}

export interface VaultScanResult {
  files: VaultFile[];
  materialization?: MaterializationReport;
  errors: string[];
}

export type VaultEventType = "created" | "modified" | "deleted";

export interface VaultEvent {
  type: VaultEventType;
  filePath: string;
  timestamp: Date;
}

export type VaultEventHandler = (event: VaultEvent) => void;

export interface VaultConnectorConfig {
  vaultPath: string;
  emitter?: TelemetryEmitter;
  materializeOptions?: MaterializeOptions;
}

// ── Frontmatter Parsing ────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse YAML frontmatter and body from an Obsidian markdown file.
 * Returns null frontmatter if no valid frontmatter block is found.
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: null, body: content };
  }

  try {
    const parsed = YAML.parse(match[1]) as Record<string, unknown>;
    return {
      frontmatter: parsed && typeof parsed === "object" ? parsed : null,
      body: match[2],
    };
  } catch {
    return { frontmatter: null, body: content };
  }
}

/**
 * Serialize frontmatter and body into Obsidian markdown format.
 */
export function serializeNote(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const yamlStr = YAML.stringify(frontmatter).trimEnd();
  return `---\n${yamlStr}\n---\n${body}`;
}

// ── Glob Matching ──────────────────────────────────────────────────────

/**
 * Simple glob matcher supporting * and ** patterns.
 * Used for selective vault scanning.
 */
function matchGlob(filePath: string, pattern: string): boolean {
  // Normalize separators
  const normalized = filePath.replace(/\\/g, "/");
  // Convert glob to regex
  const regexStr = pattern
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{GLOBSTAR}}/g, ".*");
  return new RegExp(`^${regexStr}$`).test(normalized);
}

// ── VaultConnector ─────────────────────────────────────────────────────

/**
 * VaultConnector — Reads files from the Obsidian vault at the configured path.
 *
 * Integrates with iCloudSync to materialize .icloud stubs before scanning.
 * Write access is restricted to the _agent_insights/ directory only.
 *
 * Default vault path: ~/Library/Mobile Documents/com~apple~CloudDocs/Lingelpedia
 */
export class VaultConnector {
  private readonly vaultPath: string;
  private readonly emitter: TelemetryEmitter;
  private readonly materializeOptions: MaterializeOptions;
  private readonly sessionId: string;
  private watcher: FSWatcher | null = null;
  private eventHandlers: VaultEventHandler[] = [];

  constructor(config: VaultConnectorConfig) {
    this.vaultPath = config.vaultPath;
    this.emitter = config.emitter ?? new TelemetryEmitter();
    this.materializeOptions = config.materializeOptions ?? {};
    this.sessionId = `vault-${Date.now()}`;
  }

  /** Get the absolute path to _agent_insights/ within the vault */
  private get agentInsightsPath(): string {
    return path.join(this.vaultPath, "_agent_insights");
  }

  // ── Scanning ───────────────────────────────────────────────────────

  /**
   * Scan the vault for all .md files. Materializes iCloud stubs first.
   *
   * @param patterns - Optional glob patterns to filter results (e.g., 'Finance/Entities/*.md')
   */
  async scan(patterns?: string[]): Promise<VaultScanResult> {
    const start = Date.now();
    const errors: string[] = [];

    // Materialize iCloud stubs before scanning
    let materialization: MaterializationReport | undefined;
    try {
      materialization = await materialize_icloud_stubs(
        this.vaultPath,
        this.materializeOptions,
      );
    } catch (err) {
      const msg = `iCloud materialization failed: ${err}`;
      errors.push(msg);
      process.stderr.write(`[VaultConnector] ${msg}\n`);
    }

    // Recursively find all .md files
    const mdFiles = await this.findMarkdownFiles(this.vaultPath);

    // Parse each file
    const files: VaultFile[] = [];
    for (const filePath of mdFiles) {
      // Apply glob patterns if specified
      if (patterns && patterns.length > 0) {
        const relativePath = path.relative(this.vaultPath, filePath);
        const matches = patterns.some((p) => matchGlob(relativePath, p));
        if (!matches) continue;
      }

      try {
        const content = await readFile(filePath, "utf-8");
        const fileStat = await stat(filePath);
        const { frontmatter, body } = parseFrontmatter(content);

        files.push({
          path: filePath,
          frontmatter,
          body,
          lastModified: fileStat.mtime,
        });
      } catch (err) {
        const msg = `Failed to read ${filePath}: ${err}`;
        errors.push(msg);
        process.stderr.write(`[VaultConnector] ${msg}\n`);
      }
    }

    await this.emitter.emit({
      agent_name: "knowledge_agent",
      event_type: "knowledge_query",
      event_subtype: "vault_scan",
      session_id: this.sessionId,
      outcome: errors.length === 0 ? "success" : "partial",
      latency_ms: Date.now() - start,
      metadata: {
        vault_path: this.vaultPath,
        files_found: files.length,
        patterns: patterns ?? null,
        stubs_materialized: materialization?.successfully_materialized ?? 0,
        errors: errors.length,
      },
    });

    return { files, materialization, errors };
  }

  /**
   * Recursively find all .md files in a directory.
   */
  private async findMarkdownFiles(dir: string): Promise<string[]> {
    const results: string[] = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip hidden directories (e.g., .obsidian, .trash)
          if (entry.name.startsWith(".")) continue;
          const subFiles = await this.findMarkdownFiles(fullPath);
          results.push(...subFiles);
        } else if (entry.name.endsWith(".md") && !entry.name.startsWith(".")) {
          results.push(fullPath);
        }
      }
    } catch (err) {
      process.stderr.write(`[VaultConnector] Failed to read directory ${dir}: ${err}\n`);
    }

    return results;
  }

  // ── Writing ────────────────────────────────────────────────────────

  /**
   * Write a note to the _agent_insights/ directory.
   * Throws if the target path is outside _agent_insights/.
   *
   * @param relativePath - Path relative to _agent_insights/ (e.g., "MOC_finance.md")
   * @param frontmatter - YAML frontmatter object
   * @param body - Markdown body content
   */
  async writeInsight(
    relativePath: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): Promise<string> {
    const start = Date.now();
    const targetPath = path.resolve(this.agentInsightsPath, relativePath);

    // Security check: ensure we're writing within _agent_insights/
    if (!targetPath.startsWith(this.agentInsightsPath)) {
      throw new Error(
        `Write access denied: path "${relativePath}" resolves outside _agent_insights/`,
      );
    }

    // Ensure directory exists
    const targetDir = path.dirname(targetPath);
    await mkdir(targetDir, { recursive: true });

    // Serialize and write
    const content = serializeNote(frontmatter, body);
    await writeFile(targetPath, content, "utf-8");

    await this.emitter.emit({
      agent_name: "knowledge_agent",
      event_type: "knowledge_write",
      event_subtype: "vault_write_insight",
      session_id: this.sessionId,
      outcome: "success",
      latency_ms: Date.now() - start,
      metadata: {
        target_path: targetPath,
        frontmatter_keys: Object.keys(frontmatter),
      },
    });

    return targetPath;
  }

  /**
   * Write to the vault — only _agent_insights/ directory is permitted.
   * This is the public boundary enforcement method.
   *
   * @param relativePath - Path relative to vault root
   * @param content - File content
   */
  async write(relativePath: string, content: string): Promise<string> {
    const start = Date.now();
    const normalizedPath = relativePath.replace(/\\/g, "/");

    // Enforce _agent_insights/ write restriction
    if (!normalizedPath.startsWith("_agent_insights/") && normalizedPath !== "_agent_insights") {
      throw new Error(
        `Write access restricted to _agent_insights/ directory only. ` +
        `Attempted write to: "${relativePath}"`,
      );
    }

    const targetPath = path.resolve(this.vaultPath, relativePath);

    // Double-check resolved path is within vault/_agent_insights/
    if (!targetPath.startsWith(this.agentInsightsPath)) {
      throw new Error(
        `Write access denied: path "${relativePath}" resolves outside _agent_insights/`,
      );
    }

    const targetDir = path.dirname(targetPath);
    await mkdir(targetDir, { recursive: true });
    await writeFile(targetPath, content, "utf-8");

    await this.emitter.emit({
      agent_name: "knowledge_agent",
      event_type: "knowledge_write",
      event_subtype: "vault_write",
      session_id: this.sessionId,
      outcome: "success",
      latency_ms: Date.now() - start,
      metadata: { target_path: targetPath },
    });

    return targetPath;
  }

  // ── File Watcher ───────────────────────────────────────────────────

  /**
   * Start watching the vault for file changes.
   * Emits VaultEvents for created, modified, and deleted files.
   */
  startWatching(handler: VaultEventHandler): void {
    this.eventHandlers.push(handler);

    // Only create one watcher
    if (this.watcher) return;

    try {
      this.watcher = watch(
        this.vaultPath,
        { recursive: true },
        (eventType, filename) => {
          if (!filename || !filename.endsWith(".md")) return;
          if (filename.startsWith(".")) return;

          const filePath = path.join(this.vaultPath, filename);
          const vaultEventType: VaultEventType =
            eventType === "rename" ? "created" : "modified";

          const event: VaultEvent = {
            type: vaultEventType,
            filePath,
            timestamp: new Date(),
          };

          for (const h of this.eventHandlers) {
            try {
              h(event);
            } catch (err) {
              process.stderr.write(
                `[VaultConnector] Watcher handler error: ${err}\n`,
              );
            }
          }

          // Emit telemetry for file change
          this.emitter
            .emit({
              agent_name: "knowledge_agent",
              event_type: "knowledge_query",
              event_subtype: "vault_file_change",
              session_id: this.sessionId,
              outcome: "success",
              metadata: {
                change_type: vaultEventType,
                file: filename,
              },
            })
            .catch(() => {
              /* non-blocking telemetry */
            });
        },
      );
    } catch (err) {
      process.stderr.write(`[VaultConnector] Failed to start watcher: ${err}\n`);
    }
  }

  /**
   * Stop watching the vault for changes.
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.eventHandlers = [];
  }

  /** Get the configured vault path */
  getVaultPath(): string {
    return this.vaultPath;
  }
}
