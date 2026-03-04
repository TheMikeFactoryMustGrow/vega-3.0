import { randomUUID } from "node:crypto";
import { Neo4jConnection } from "../neo4j.js";
import { EmbeddingPipeline } from "../embedding.js";
import { TelemetryEmitter } from "../../telemetry/emitter.js";
import type { EntityTemplate } from "./parser.js";

/**
 * EntityMapper — Converts parsed Entity Obsidian notes into Neo4j Entity nodes
 * with Claim relationships extracted from the note body.
 *
 * Uses MERGE (not CREATE) for idempotent re-runs — matches on name + entity_type.
 * Each paragraph or bullet point in the body becomes a Claim node linked via ABOUT.
 */

export interface MigrationStats {
  entities_created: number;
  entities_updated: number;
  claims_created: number;
  embeddings_generated: number;
  errors: string[];
}

export interface MapperOptions {
  connection: Neo4jConnection;
  embedding?: EmbeddingPipeline | null;
  emitter?: TelemetryEmitter;
}

/**
 * Extract claims from note body text.
 * Each non-empty paragraph or bullet point becomes a separate claim.
 */
export function extractClaimsFromBody(body: string): string[] {
  if (!body || !body.trim()) return [];

  const claims: string[] = [];
  const lines = body.split("\n");
  let currentParagraph = "";

  for (const line of lines) {
    const trimmed = line.trim();

    // Bullet points become individual claims
    if (/^[-*+]\s+/.test(trimmed)) {
      // Flush any accumulated paragraph
      if (currentParagraph.trim()) {
        claims.push(currentParagraph.trim());
        currentParagraph = "";
      }
      const bulletContent = trimmed.replace(/^[-*+]\s+/, "").trim();
      if (bulletContent) {
        claims.push(bulletContent);
      }
      continue;
    }

    // Numbered list items become individual claims
    if (/^\d+\.\s+/.test(trimmed)) {
      if (currentParagraph.trim()) {
        claims.push(currentParagraph.trim());
        currentParagraph = "";
      }
      const itemContent = trimmed.replace(/^\d+\.\s+/, "").trim();
      if (itemContent) {
        claims.push(itemContent);
      }
      continue;
    }

    // Skip headings — they're structural, not claims
    if (/^#{1,6}\s+/.test(trimmed)) {
      if (currentParagraph.trim()) {
        claims.push(currentParagraph.trim());
        currentParagraph = "";
      }
      continue;
    }

    // Empty line = paragraph break
    if (!trimmed) {
      if (currentParagraph.trim()) {
        claims.push(currentParagraph.trim());
        currentParagraph = "";
      }
      continue;
    }

    // Accumulate paragraph text
    currentParagraph += (currentParagraph ? " " : "") + trimmed;
  }

  // Flush last paragraph
  if (currentParagraph.trim()) {
    claims.push(currentParagraph.trim());
  }

  return claims;
}

export class EntityMapper {
  private readonly connection: Neo4jConnection;
  private readonly embedding: EmbeddingPipeline | null;
  private readonly emitter: TelemetryEmitter;
  private readonly sessionId: string;

  constructor(options: MapperOptions) {
    this.connection = options.connection;
    this.embedding = options.embedding ?? null;
    this.emitter = options.emitter ?? new TelemetryEmitter();
    this.sessionId = `entity-mapper-${Date.now()}`;
  }

  /**
   * Migrate an Entity note into Neo4j.
   *
   * Creates/updates:
   * - Entity node (MERGE on name + entity_type)
   * - Source node for the Obsidian note
   * - Claim nodes for each paragraph/bullet in the body
   * - ABOUT relationships (Claim → Entity)
   * - SOURCED_FROM relationships (Claim → Source)
   */
  async migrate(
    frontmatter: EntityTemplate,
    body: string,
    sourcePath: string,
  ): Promise<MigrationStats> {
    const start = Date.now();
    const stats: MigrationStats = {
      entities_created: 0,
      entities_updated: 0,
      claims_created: 0,
      embeddings_generated: 0,
      errors: [],
    };

    const session = this.connection.session();
    try {
      // 1. MERGE Entity node
      const entityId = `entity-${frontmatter.name.toLowerCase().replace(/\s+/g, "-")}-${frontmatter.entity_type}`;
      const entityResult = await session.run(
        `MERGE (e:Entity {name: $name, entity_type: $entityType})
         ON CREATE SET
           e.id = $entityId,
           e.domain = $domain,
           e.aliases = $aliases,
           e.description = $description,
           e.created_at = datetime(),
           e.updated_at = datetime()
         ON MATCH SET
           e.domain = $domain,
           e.aliases = $aliases,
           e.description = $description,
           e.updated_at = datetime()
         RETURN e.id AS id, e.created_at = e.updated_at AS isNew`,
        {
          name: frontmatter.name,
          entityType: frontmatter.entity_type,
          entityId,
          domain: frontmatter.domain,
          aliases: frontmatter.aliases ?? [],
          description: frontmatter.description ?? null,
        },
      );

      const isNew = entityResult.records[0]?.get("isNew") as boolean;
      if (isNew) {
        stats.entities_created++;
      } else {
        stats.entities_updated++;
      }

      // 2. Create Source node for the Obsidian note
      const sourceId = `source-obsidian-${sourcePath.replace(/[^a-zA-Z0-9]/g, "-")}`;
      await session.run(
        `MERGE (s:Source {id: $sourceId})
         ON CREATE SET
           s.source_type = 'obsidian_note',
           s.source_account = 'obsidian_vault',
           s.file_path = $filePath,
           s.credibility_weight = 0.7,
           s.captured_date = datetime(),
           s.created_at = datetime()
         ON MATCH SET
           s.file_path = $filePath,
           s.updated_at = datetime()`,
        { sourceId, filePath: sourcePath },
      );

      // 3. Extract claims from body and create Claim nodes
      const claimTexts = extractClaimsFromBody(body);
      const truthTier = (frontmatter as Record<string, unknown>).truth_tier as string | undefined ?? "single_source";

      for (const claimText of claimTexts) {
        const claimId = `claim-${randomUUID()}`;
        try {
          await session.run(
            `CREATE (c:Claim {
               id: $claimId,
               content: $content,
               truth_tier: $truthTier,
               truth_score: 0.5,
               domain: $domain,
               status: 'active',
               created_at: datetime(),
               updated_at: datetime()
             })
             WITH c
             MATCH (e:Entity {name: $entityName, entity_type: $entityType})
             MERGE (c)-[:ABOUT]->(e)
             WITH c
             MATCH (s:Source {id: $sourceId})
             MERGE (c)-[:SOURCED_FROM]->(s)`,
            {
              claimId,
              content: claimText,
              truthTier,
              domain: frontmatter.domain,
              entityName: frontmatter.name,
              entityType: frontmatter.entity_type,
              sourceId,
            },
          );
          stats.claims_created++;

          // 4. Generate embedding for the claim
          if (this.embedding) {
            try {
              const result = await this.embedding.embedAndStore(claimId, claimText);
              if (result.success) {
                stats.embeddings_generated++;
              }
            } catch {
              stats.errors.push(`Embedding failed for claim ${claimId}`);
            }
          }
        } catch (err) {
          stats.errors.push(`Claim creation failed: ${err}`);
        }
      }

      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_write",
        event_subtype: "entity_migration",
        session_id: this.sessionId,
        outcome: stats.errors.length === 0 ? "success" : "partial",
        latency_ms: Date.now() - start,
        metadata: { ...stats, entityId, sourcePath },
      });

      return stats;
    } catch (err) {
      stats.errors.push(`Migration failed: ${err}`);

      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_write",
        event_subtype: "entity_migration",
        session_id: this.sessionId,
        outcome: "failure",
        latency_ms: Date.now() - start,
        metadata: { error: String(err), sourcePath },
      });

      return stats;
    } finally {
      await session.close();
    }
  }
}
