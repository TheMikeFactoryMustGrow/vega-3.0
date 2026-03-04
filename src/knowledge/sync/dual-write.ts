import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { Neo4jConnection } from "../neo4j.js";
import {
  VaultConnector,
  parseFrontmatter,
  serializeNote,
  type VaultFile,
  type VaultEvent,
} from "../vault-connector.js";
import { MigrationParser } from "../migration/parser.js";
import { EntityMapper, type MigrationStats, type MapperOptions } from "../migration/entity-mapper.js";
import { PersonMapper } from "../migration/person-mapper.js";
import { AccountMapper } from "../migration/account-mapper.js";
import { InvestmentMapper } from "../migration/investment-mapper.js";
import { CashFlowMapper } from "../migration/cashflow-mapper.js";
import { InstitutionMapper } from "../migration/institution-mapper.js";
import { EmbeddingPipeline } from "../embedding.js";
import { TelemetryEmitter } from "../../telemetry/emitter.js";
import type {
  EntityTemplate,
  PersonTemplate,
  AccountTemplate,
  InvestmentTemplate,
  CashFlowTemplate,
  InstitutionTemplate,
} from "../migration/parser.js";

// ── Types ──────────────────────────────────────────────────────────────

export type SyncDirection = "obsidian_to_neo4j" | "neo4j_to_obsidian";
export type SyncStatus = "synced" | "pending" | "failed" | "conflict";

export interface SyncLedgerEntry {
  id: string;
  obsidian_path: string;
  neo4j_node_id: string;
  last_synced_at: Date;
  sync_direction: SyncDirection;
  sync_status: SyncStatus;
}

export interface DeadLetterEntry {
  id: string;
  obsidian_path: string | null;
  neo4j_node_id: string | null;
  error: string;
  attempt_count: number;
  max_attempts: number;
  next_retry_at: Date;
  created_at: Date;
  resolved_at: Date | null;
}

export interface SyncResult {
  direction: SyncDirection;
  obsidian_path: string | null;
  neo4j_node_id: string | null;
  success: boolean;
  migration_stats?: MigrationStats;
  error?: string;
  latency_ms: number;
}

export interface BatchSyncResult {
  total: number;
  synced: number;
  failed: number;
  conflicts: number;
  results: SyncResult[];
  latency_ms: number;
}

export interface DualWriteSyncConfig {
  connection: Neo4jConnection;
  vault: VaultConnector;
  pool: pg.Pool;
  embedding?: EmbeddingPipeline | null;
  emitter?: TelemetryEmitter;
  maxRetries?: number;
}

// ── SQL DDL ────────────────────────────────────────────────────────────

const SYNC_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_sync_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  obsidian_path TEXT,
  neo4j_node_id TEXT,
  last_synced_at TIMESTAMP NOT NULL DEFAULT now(),
  sync_direction VARCHAR NOT NULL,
  sync_status VARCHAR NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_sync_ledger_path
  ON knowledge_sync_ledger(obsidian_path);
CREATE INDEX IF NOT EXISTS idx_sync_ledger_node
  ON knowledge_sync_ledger(neo4j_node_id);

CREATE TABLE IF NOT EXISTS knowledge_dead_letter_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  obsidian_path TEXT,
  neo4j_node_id TEXT,
  error TEXT NOT NULL,
  attempt_count INT NOT NULL DEFAULT 1,
  max_attempts INT NOT NULL DEFAULT 3,
  next_retry_at TIMESTAMP NOT NULL DEFAULT now(),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  resolved_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_pending
  ON knowledge_dead_letter_queue(next_retry_at)
  WHERE resolved_at IS NULL;
`;

// ── DualWriteSync ──────────────────────────────────────────────────────

/**
 * DualWriteSync — Bidirectional synchronization between Obsidian and Neo4j.
 *
 * Obsidian → Neo4j: when vault file is modified, re-parse and update Neo4j nodes.
 * Neo4j → Obsidian: when agent creates Claims/Entities/OpenQuestions, generate note in _agent_insights/.
 *
 * Conflict resolution:
 * - Obsidian is source of truth for manually written notes
 * - Neo4j is source of truth for agent-generated knowledge
 * - Conflicts create OpenQuestion nodes rather than auto-resolving
 *
 * Sync state tracked in PostgreSQL (knowledge_sync_ledger).
 * Failed syncs go to dead letter queue with exponential backoff (max 3 attempts).
 */
export class DualWriteSync {
  private readonly connection: Neo4jConnection;
  private readonly vault: VaultConnector;
  private readonly pool: pg.Pool;
  private readonly embedding: EmbeddingPipeline | null;
  private readonly emitter: TelemetryEmitter;
  private readonly sessionId: string;
  private readonly maxRetries: number;
  private readonly parser: MigrationParser;
  private watching = false;

  constructor(config: DualWriteSyncConfig) {
    this.connection = config.connection;
    this.vault = config.vault;
    this.pool = config.pool;
    this.embedding = config.embedding ?? null;
    this.emitter = config.emitter ?? new TelemetryEmitter();
    this.sessionId = `dual-write-${Date.now()}`;
    this.maxRetries = config.maxRetries ?? 3;
    this.parser = new MigrationParser({ emitter: this.emitter });
  }

  // ── Schema Migration ──────────────────────────────────────────────

  /** Create sync ledger and dead letter queue tables (idempotent) */
  async runMigration(): Promise<void> {
    await this.pool.query(SYNC_MIGRATION_SQL);
  }

  /** Drop sync tables (test cleanup only) */
  async dropTables(): Promise<void> {
    await this.pool.query(`
      DROP TABLE IF EXISTS knowledge_dead_letter_queue CASCADE;
      DROP TABLE IF EXISTS knowledge_sync_ledger CASCADE;
    `);
  }

  // ── Obsidian → Neo4j ──────────────────────────────────────────────

  /**
   * Sync a single Obsidian file to Neo4j.
   * Re-parses frontmatter and body, then runs the appropriate mapper.
   */
  async syncObsidianToNeo4j(filePath: string): Promise<SyncResult> {
    const start = Date.now();
    const relativePath = path.relative(this.vault.getVaultPath(), filePath);

    try {
      // Read and parse the file
      const content = await readFile(filePath, "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);

      if (!frontmatter) {
        return {
          direction: "obsidian_to_neo4j",
          obsidian_path: relativePath,
          neo4j_node_id: null,
          success: false,
          error: "No frontmatter found",
          latency_ms: Date.now() - start,
        };
      }

      // Detect template type and validate
      const parseResult = this.parser.parse(frontmatter);
      if (!parseResult.valid || !parseResult.template_type || !parseResult.data) {
        return {
          direction: "obsidian_to_neo4j",
          obsidian_path: relativePath,
          neo4j_node_id: null,
          success: false,
          error: `Invalid template: ${parseResult.errors.map((e) => e.message).join(", ")}`,
          latency_ms: Date.now() - start,
        };
      }

      // Run appropriate mapper
      const mapperOptions: MapperOptions = {
        connection: this.connection,
        embedding: this.embedding,
        emitter: this.emitter,
      };

      let stats: MigrationStats;
      let nodeId: string;

      switch (parseResult.template_type) {
        case "entity": {
          const mapper = new EntityMapper(mapperOptions);
          const data = parseResult.data as EntityTemplate;
          stats = await mapper.migrate(data, body, relativePath);
          nodeId = `entity-${data.name.toLowerCase().replace(/\s+/g, "-")}-${data.entity_type}`;
          break;
        }
        case "person": {
          const mapper = new PersonMapper(mapperOptions);
          const data = parseResult.data as PersonTemplate;
          stats = await mapper.migrate(data, body, relativePath);
          nodeId = `entity-${data.name.toLowerCase().replace(/\s+/g, "-")}-person`;
          break;
        }
        case "account": {
          const mapper = new AccountMapper(mapperOptions);
          const data = parseResult.data as AccountTemplate;
          stats = await mapper.migrate(data, body, relativePath);
          nodeId = `entity-${data.name.toLowerCase().replace(/\s+/g, "-")}-financial_account`;
          break;
        }
        case "investment": {
          const mapper = new InvestmentMapper(mapperOptions);
          const data = parseResult.data as InvestmentTemplate;
          stats = await mapper.migrate(data, body, relativePath);
          nodeId = `entity-${data.name.toLowerCase().replace(/\s+/g, "-")}-investment`;
          break;
        }
        case "cash_flow": {
          const mapper = new CashFlowMapper(mapperOptions);
          const data = parseResult.data as CashFlowTemplate;
          stats = await mapper.migrate(data, body, relativePath);
          nodeId = `cashflow-${data.name.toLowerCase().replace(/\s+/g, "-")}`;
          break;
        }
        case "institution": {
          const mapper = new InstitutionMapper(mapperOptions);
          const data = parseResult.data as InstitutionTemplate;
          stats = await mapper.migrate(data, body, relativePath);
          nodeId = `entity-${data.name.toLowerCase().replace(/\s+/g, "-")}-institution`;
          break;
        }
        case "claim":
          return {
            direction: "obsidian_to_neo4j",
            obsidian_path: relativePath,
            neo4j_node_id: null,
            success: false,
            error: "Claim templates not supported for direct sync",
            latency_ms: Date.now() - start,
          };
        default:
          return {
            direction: "obsidian_to_neo4j",
            obsidian_path: relativePath,
            neo4j_node_id: null,
            success: false,
            error: `Unknown template type: ${parseResult.template_type}`,
            latency_ms: Date.now() - start,
          };
      }

      // Check for complete failure (mapper caught errors but produced nothing useful)
      const totalCreated = stats.entities_created + stats.entities_updated + stats.claims_created;
      if (totalCreated === 0 && stats.errors.length > 0) {
        const error = `Migration failed: ${stats.errors.join("; ")}`;
        await this.addToDeadLetterQueue(relativePath, null, error);

        await this.emitter.emit({
          agent_name: "knowledge_agent",
          event_type: "knowledge_write",
          event_subtype: "sync_obsidian_to_neo4j",
          session_id: this.sessionId,
          outcome: "failure",
          latency_ms: Date.now() - start,
          metadata: { obsidian_path: relativePath, neo4j_node_id: nodeId, ...stats },
        });

        return {
          direction: "obsidian_to_neo4j",
          obsidian_path: relativePath,
          neo4j_node_id: nodeId,
          success: false,
          error,
          migration_stats: stats,
          latency_ms: Date.now() - start,
        };
      }

      // Update sync ledger
      await this.upsertLedger(relativePath, nodeId, "obsidian_to_neo4j", "synced");

      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_write",
        event_subtype: "sync_obsidian_to_neo4j",
        session_id: this.sessionId,
        outcome: stats.errors.length === 0 ? "success" : "partial",
        latency_ms: Date.now() - start,
        metadata: { obsidian_path: relativePath, neo4j_node_id: nodeId, ...stats },
      });

      return {
        direction: "obsidian_to_neo4j",
        obsidian_path: relativePath,
        neo4j_node_id: nodeId,
        success: true,
        migration_stats: stats,
        latency_ms: Date.now() - start,
      };
    } catch (err) {
      const error = String(err);

      // Add to dead letter queue
      await this.addToDeadLetterQueue(relativePath, null, error);

      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_write",
        event_subtype: "sync_obsidian_to_neo4j",
        session_id: this.sessionId,
        outcome: "failure",
        latency_ms: Date.now() - start,
        metadata: { obsidian_path: relativePath, error },
      });

      return {
        direction: "obsidian_to_neo4j",
        obsidian_path: relativePath,
        neo4j_node_id: null,
        success: false,
        error,
        latency_ms: Date.now() - start,
      };
    }
  }

  // ── Neo4j → Obsidian ──────────────────────────────────────────────

  /**
   * Sync a Neo4j node to Obsidian by generating a note in _agent_insights/.
   * Supports Claim, Entity, and OpenQuestion node types.
   */
  async syncNeo4jToObsidian(
    nodeId: string,
    nodeType: "Claim" | "Entity" | "OpenQuestion",
  ): Promise<SyncResult> {
    const start = Date.now();

    try {
      const session = this.connection.session();
      let noteContent: { frontmatter: Record<string, unknown>; body: string; fileName: string };

      try {
        switch (nodeType) {
          case "Claim": {
            const result = await session.run(
              `MATCH (c:Claim {id: $nodeId})
               OPTIONAL MATCH (c)-[:ABOUT]->(e:Entity)
               RETURN c, collect(e.name) AS entities`,
              { nodeId },
            );
            const record = result.records[0];
            if (!record) throw new Error(`Claim ${nodeId} not found`);

            const claim = record.get("c").properties;
            const entities = record.get("entities") as string[];
            const slug = (claim.content as string).slice(0, 50).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

            noteContent = {
              frontmatter: {
                type: "agent_claim",
                claim_id: nodeId,
                truth_tier: claim.truth_tier ?? "agent_inferred",
                truth_score: typeof claim.truth_score === "object" && claim.truth_score?.toNumber
                  ? claim.truth_score.toNumber()
                  : Number(claim.truth_score ?? 0.5),
                domain: claim.domain ?? "general",
                entities: entities.filter(Boolean),
                status: claim.status ?? "active",
                created_by: "knowledge_agent",
                synced_at: new Date().toISOString(),
              },
              body: `# ${(claim.content as string).slice(0, 80)}\n\n${claim.content as string}\n`,
              fileName: `Claim_${slug}_${Date.now()}.md`,
            };
            break;
          }
          case "Entity": {
            const result = await session.run(
              `MATCH (e:Entity {id: $nodeId})
               OPTIONAL MATCH (c:Claim)-[:ABOUT]->(e)
               RETURN e, count(c) AS claimCount`,
              { nodeId },
            );
            const record = result.records[0];
            if (!record) throw new Error(`Entity ${nodeId} not found`);

            const entity = record.get("e").properties;
            const claimCount = record.get("claimCount");
            const count = typeof claimCount === "object" && claimCount?.toNumber
              ? claimCount.toNumber()
              : Number(claimCount ?? 0);
            const slug = (entity.name as string).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

            noteContent = {
              frontmatter: {
                type: "agent_entity",
                entity_id: nodeId,
                name: entity.name,
                entity_type: entity.entity_type ?? "general",
                domain: entity.domain ?? "general",
                claim_count: count,
                created_by: "knowledge_agent",
                synced_at: new Date().toISOString(),
              },
              body: `# ${entity.name as string}\n\n**Type:** ${entity.entity_type as string}\n**Domain:** ${entity.domain as string}\n**Claims:** ${count}\n`,
              fileName: `Entity_${slug}_${Date.now()}.md`,
            };
            break;
          }
          case "OpenQuestion": {
            const result = await session.run(
              `MATCH (oq:OpenQuestion {id: $nodeId})
               OPTIONAL MATCH (oq)-[:INVOLVES]->(c:Claim)
               RETURN oq, collect(c.id) AS claimIds`,
              { nodeId },
            );
            const record = result.records[0];
            if (!record) throw new Error(`OpenQuestion ${nodeId} not found`);

            const oq = record.get("oq").properties;
            const claimIds = record.get("claimIds") as string[];
            const slug = (oq.question as string).slice(0, 50).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

            noteContent = {
              frontmatter: {
                type: "agent_open_question",
                question_id: nodeId,
                domain: oq.domain ?? "general",
                priority: oq.priority ?? "medium",
                severity: oq.severity ?? "medium",
                status: oq.status ?? "open",
                raised_by: oq.raised_by ?? "knowledge_agent",
                involved_claims: claimIds.filter(Boolean),
                created_by: "knowledge_agent",
                synced_at: new Date().toISOString(),
              },
              body: `# ${oq.question as string}\n\n${oq.explanation as string ?? ""}\n`,
              fileName: `OpenQuestion_${slug}_${Date.now()}.md`,
            };
            break;
          }
        }
      } finally {
        await session.close();
      }

      // Write to _agent_insights/
      await this.vault.writeInsight(
        noteContent.fileName,
        noteContent.frontmatter,
        noteContent.body,
      );

      // Update sync ledger
      const obsidianPath = `_agent_insights/${noteContent.fileName}`;
      await this.upsertLedger(obsidianPath, nodeId, "neo4j_to_obsidian", "synced");

      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_write",
        event_subtype: "sync_neo4j_to_obsidian",
        session_id: this.sessionId,
        outcome: "success",
        latency_ms: Date.now() - start,
        metadata: { neo4j_node_id: nodeId, node_type: nodeType, obsidian_path: obsidianPath },
      });

      return {
        direction: "neo4j_to_obsidian",
        obsidian_path: obsidianPath,
        neo4j_node_id: nodeId,
        success: true,
        latency_ms: Date.now() - start,
      };
    } catch (err) {
      const error = String(err);

      await this.addToDeadLetterQueue(null, nodeId, error);

      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_write",
        event_subtype: "sync_neo4j_to_obsidian",
        session_id: this.sessionId,
        outcome: "failure",
        latency_ms: Date.now() - start,
        metadata: { neo4j_node_id: nodeId, node_type: nodeType, error },
      });

      return {
        direction: "neo4j_to_obsidian",
        obsidian_path: null,
        neo4j_node_id: nodeId,
        success: false,
        error,
        latency_ms: Date.now() - start,
      };
    }
  }

  // ── Conflict Detection ────────────────────────────────────────────

  /**
   * Detect and handle sync conflict between Obsidian and Neo4j.
   * Creates an OpenQuestion node in Neo4j for manual resolution.
   */
  async handleConflict(
    obsidianPath: string,
    neo4jNodeId: string,
    description: string,
  ): Promise<SyncResult> {
    const start = Date.now();

    try {
      const session = this.connection.session();
      try {
        const questionId = `oq-conflict-${randomUUID()}`;
        await session.run(
          `CREATE (oq:OpenQuestion {
             id: $questionId,
             question: $question,
             domain: 'general',
             priority: 'high',
             severity: 'medium',
             raised_by: 'dual_write_sync',
             status: 'open',
             explanation: $explanation,
             created_at: datetime(),
             updated_at: datetime()
           })`,
          {
            questionId,
            question: `Sync conflict: ${obsidianPath} vs ${neo4jNodeId}`,
            explanation: description,
          },
        );

        // Link to the conflicting Neo4j node if it exists
        await session.run(
          `MATCH (oq:OpenQuestion {id: $questionId})
           OPTIONAL MATCH (n {id: $nodeId})
           FOREACH (_ IN CASE WHEN n IS NOT NULL THEN [1] ELSE [] END |
             MERGE (oq)-[:INVOLVES]->(n)
           )`,
          { questionId, nodeId: neo4jNodeId },
        );

        // Mark ledger as conflict
        await this.upsertLedger(obsidianPath, neo4jNodeId, "obsidian_to_neo4j", "conflict");

        await this.emitter.emit({
          agent_name: "knowledge_agent",
          event_type: "knowledge_write",
          event_subtype: "sync_conflict",
          session_id: this.sessionId,
          outcome: "partial",
          latency_ms: Date.now() - start,
          metadata: { obsidian_path: obsidianPath, neo4j_node_id: neo4jNodeId, question_id: questionId },
        });

        return {
          direction: "obsidian_to_neo4j",
          obsidian_path: obsidianPath,
          neo4j_node_id: neo4jNodeId,
          success: true,
          latency_ms: Date.now() - start,
        };
      } finally {
        await session.close();
      }
    } catch (err) {
      return {
        direction: "obsidian_to_neo4j",
        obsidian_path: obsidianPath,
        neo4j_node_id: neo4jNodeId,
        success: false,
        error: String(err),
        latency_ms: Date.now() - start,
      };
    }
  }

  // ── Batch Sync ────────────────────────────────────────────────────

  /**
   * Batch sync: re-sync all Obsidian files to Neo4j.
   * Used for initial migration or re-pipeline operations.
   */
  async batchSyncObsidianToNeo4j(): Promise<BatchSyncResult> {
    const start = Date.now();
    const results: SyncResult[] = [];

    const scanResult = await this.vault.scan();

    for (const file of scanResult.files) {
      if (!file.frontmatter) continue;

      const result = await this.syncObsidianToNeo4j(file.path);
      results.push(result);
    }

    const batchResult: BatchSyncResult = {
      total: results.length,
      synced: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      conflicts: 0,
      results,
      latency_ms: Date.now() - start,
    };

    await this.emitter.emit({
      agent_name: "knowledge_agent",
      event_type: "knowledge_write",
      event_subtype: "batch_sync",
      session_id: this.sessionId,
      outcome: batchResult.failed === 0 ? "success" : "partial",
      latency_ms: batchResult.latency_ms,
      metadata: {
        total: batchResult.total,
        synced: batchResult.synced,
        failed: batchResult.failed,
      },
    });

    return batchResult;
  }

  // ── File Watcher Integration ──────────────────────────────────────

  /**
   * Start watching the vault for changes and auto-sync to Neo4j.
   * Integrates with VaultConnector's file watcher.
   */
  startWatching(): void {
    if (this.watching) return;
    this.watching = true;

    this.vault.startWatching(async (event: VaultEvent) => {
      // Only sync modified .md files (not deletions for now)
      if (event.type === "deleted") return;

      try {
        await this.syncObsidianToNeo4j(event.filePath);
      } catch (err) {
        process.stderr.write(
          `[DualWriteSync] Watch sync failed for ${event.filePath}: ${err}\n`,
        );
      }
    });
  }

  /** Stop watching for vault changes */
  stopWatching(): void {
    if (!this.watching) return;
    this.watching = false;
    this.vault.stopWatching();
  }

  // ── Sync Ledger ──────────────────────────────────────────────────

  /** Upsert an entry in the sync ledger */
  private async upsertLedger(
    obsidianPath: string,
    neo4jNodeId: string,
    direction: SyncDirection,
    status: SyncStatus,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO knowledge_sync_ledger (id, obsidian_path, neo4j_node_id, last_synced_at, sync_direction, sync_status)
         VALUES ($1, $2, $3, now(), $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           last_synced_at = now(),
           sync_direction = $4,
           sync_status = $5`,
        [randomUUID(), obsidianPath, neo4jNodeId, direction, status],
      );
    } catch (err) {
      process.stderr.write(`[DualWriteSync] Ledger upsert failed: ${err}\n`);
    }
  }

  /** Get ledger entries for a given obsidian path */
  async getLedgerByPath(obsidianPath: string): Promise<SyncLedgerEntry[]> {
    const result = await this.pool.query(
      `SELECT id, obsidian_path, neo4j_node_id, last_synced_at, sync_direction, sync_status
       FROM knowledge_sync_ledger
       WHERE obsidian_path = $1
       ORDER BY last_synced_at DESC`,
      [obsidianPath],
    );
    return result.rows.map((row) => ({
      id: row.id,
      obsidian_path: row.obsidian_path,
      neo4j_node_id: row.neo4j_node_id,
      last_synced_at: new Date(row.last_synced_at),
      sync_direction: row.sync_direction as SyncDirection,
      sync_status: row.sync_status as SyncStatus,
    }));
  }

  /** Get ledger entries for a given Neo4j node ID */
  async getLedgerByNodeId(neo4jNodeId: string): Promise<SyncLedgerEntry[]> {
    const result = await this.pool.query(
      `SELECT id, obsidian_path, neo4j_node_id, last_synced_at, sync_direction, sync_status
       FROM knowledge_sync_ledger
       WHERE neo4j_node_id = $1
       ORDER BY last_synced_at DESC`,
      [neo4jNodeId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      obsidian_path: row.obsidian_path,
      neo4j_node_id: row.neo4j_node_id,
      last_synced_at: new Date(row.last_synced_at),
      sync_direction: row.sync_direction as SyncDirection,
      sync_status: row.sync_status as SyncStatus,
    }));
  }

  // ── Dead Letter Queue ─────────────────────────────────────────────

  /** Add a failed sync to the dead letter queue */
  private async addToDeadLetterQueue(
    obsidianPath: string | null,
    neo4jNodeId: string | null,
    error: string,
  ): Promise<void> {
    try {
      // Check if there's an existing unresolved entry for this path/node
      const existing = await this.pool.query(
        `SELECT id, attempt_count, max_attempts FROM knowledge_dead_letter_queue
         WHERE ((obsidian_path = $1 AND $1 IS NOT NULL) OR (neo4j_node_id = $2 AND $2 IS NOT NULL))
           AND resolved_at IS NULL`,
        [obsidianPath, neo4jNodeId],
      );

      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        const attempt = Number(row.attempt_count) + 1;
        const backoffMs = Math.pow(2, attempt) * 1000; // exponential backoff
        const nextRetry = new Date(Date.now() + backoffMs);

        await this.pool.query(
          `UPDATE knowledge_dead_letter_queue
           SET attempt_count = $1, error = $2, next_retry_at = $3
           WHERE id = $4`,
          [attempt, error, nextRetry, row.id],
        );
      } else {
        const backoffMs = 2000; // 2s initial backoff
        await this.pool.query(
          `INSERT INTO knowledge_dead_letter_queue (id, obsidian_path, neo4j_node_id, error, attempt_count, max_attempts, next_retry_at)
           VALUES ($1, $2, $3, $4, 1, $5, $6)`,
          [randomUUID(), obsidianPath, neo4jNodeId, error, this.maxRetries, new Date(Date.now() + backoffMs)],
        );
      }
    } catch (err) {
      process.stderr.write(`[DualWriteSync] Dead letter queue write failed: ${err}\n`);
    }
  }

  /** Get pending dead letter entries that are ready for retry */
  async getPendingRetries(): Promise<DeadLetterEntry[]> {
    const result = await this.pool.query(
      `SELECT id, obsidian_path, neo4j_node_id, error, attempt_count, max_attempts, next_retry_at, created_at, resolved_at
       FROM knowledge_dead_letter_queue
       WHERE resolved_at IS NULL AND attempt_count < max_attempts AND next_retry_at <= now()
       ORDER BY next_retry_at ASC`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      obsidian_path: row.obsidian_path,
      neo4j_node_id: row.neo4j_node_id,
      error: row.error,
      attempt_count: Number(row.attempt_count),
      max_attempts: Number(row.max_attempts),
      next_retry_at: new Date(row.next_retry_at),
      created_at: new Date(row.created_at),
      resolved_at: row.resolved_at ? new Date(row.resolved_at) : null,
    }));
  }

  /** Retry pending dead letter entries */
  async retryDeadLetters(): Promise<{ retried: number; succeeded: number; failed: number }> {
    const pending = await this.getPendingRetries();
    let succeeded = 0;
    let failed = 0;

    for (const entry of pending) {
      let result: SyncResult | null = null;

      if (entry.obsidian_path && !entry.obsidian_path.startsWith("_agent_insights/")) {
        // Retry Obsidian → Neo4j
        const fullPath = path.join(this.vault.getVaultPath(), entry.obsidian_path);
        result = await this.syncObsidianToNeo4j(fullPath);
      } else if (entry.neo4j_node_id) {
        // Retry Neo4j → Obsidian — we'd need node type; skip if unknown
        result = null;
      }

      if (result?.success) {
        // Mark as resolved
        await this.pool.query(
          `UPDATE knowledge_dead_letter_queue SET resolved_at = now() WHERE id = $1`,
          [entry.id],
        );
        succeeded++;
      } else {
        failed++;
      }
    }

    return { retried: pending.length, succeeded, failed };
  }

  /** Get all unresolved dead letter entries */
  async getDeadLetters(): Promise<DeadLetterEntry[]> {
    const result = await this.pool.query(
      `SELECT id, obsidian_path, neo4j_node_id, error, attempt_count, max_attempts, next_retry_at, created_at, resolved_at
       FROM knowledge_dead_letter_queue
       WHERE resolved_at IS NULL
       ORDER BY created_at DESC`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      obsidian_path: row.obsidian_path,
      neo4j_node_id: row.neo4j_node_id,
      error: row.error,
      attempt_count: Number(row.attempt_count),
      max_attempts: Number(row.max_attempts),
      next_retry_at: new Date(row.next_retry_at),
      created_at: new Date(row.created_at),
      resolved_at: row.resolved_at ? new Date(row.resolved_at) : null,
    }));
  }
}
