import { randomUUID } from "node:crypto";
import { Neo4jConnection } from "../neo4j.js";
import { EmbeddingPipeline } from "../embedding.js";
import { TelemetryEmitter } from "../../telemetry/emitter.js";
import { extractClaimsFromBody, type MigrationStats, type MapperOptions } from "./entity-mapper.js";
import type { CashFlowTemplate } from "./parser.js";

/**
 * CashFlowMapper — Converts parsed CashFlow Obsidian notes into Neo4j Claim nodes
 * with direction, frequency, and amount properties, linked to source Entity via ABOUT.
 *
 * CashFlow notes are primarily Claims (financial facts) rather than Entities.
 * The source_entity field links the cash flow to the Entity it belongs to.
 */

export class CashFlowMapper {
  private readonly connection: Neo4jConnection;
  private readonly embedding: EmbeddingPipeline | null;
  private readonly emitter: TelemetryEmitter;
  private readonly sessionId: string;

  constructor(options: MapperOptions) {
    this.connection = options.connection;
    this.embedding = options.embedding ?? null;
    this.emitter = options.emitter ?? new TelemetryEmitter();
    this.sessionId = `cashflow-mapper-${Date.now()}`;
  }

  /**
   * Migrate a CashFlow note into Neo4j.
   *
   * Creates/updates:
   * - Primary Claim node with direction, frequency, amount as properties
   * - ABOUT relationship to source Entity (auto-created if not found)
   * - Source node for the Obsidian note
   * - SOURCED_FROM relationships (Claim → Source)
   * - Additional Claim nodes from body text
   */
  async migrate(
    frontmatter: CashFlowTemplate,
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
      // 1. Ensure source Entity exists (auto-create if not found)
      const entityId = `entity-${frontmatter.source_entity.toLowerCase().replace(/\s+/g, "-")}-organization`;
      const entityResult = await session.run(
        `MERGE (e:Entity {name: $name, entity_type: 'organization'})
         ON CREATE SET
           e.id = $entityId,
           e.domain = $domain,
           e.created_at = datetime(),
           e.updated_at = datetime()
         ON MATCH SET
           e.updated_at = datetime()
         RETURN e.created_at = e.updated_at AS isNew`,
        {
          name: frontmatter.source_entity,
          entityId,
          domain: frontmatter.domain,
        },
      );

      const isNew = entityResult.records[0]?.get("isNew") as boolean;
      if (isNew) {
        stats.entities_created++;
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

      // 3. Create primary CashFlow Claim
      const primaryClaimText = `${frontmatter.name}: ${frontmatter.direction} of $${frontmatter.amount.toLocaleString()} (${frontmatter.frequency}) from ${frontmatter.source_entity}`;
      const primaryClaimId = `claim-${randomUUID()}`;

      try {
        await session.run(
          `CREATE (c:Claim {
             id: $claimId,
             content: $content,
             truth_tier: 'single_source',
             truth_score: 0.5,
             domain: $domain,
             status: 'active',
             claim_type: 'cash_flow',
             direction: $direction,
             frequency: $frequency,
             amount: $amount,
             created_at: datetime(),
             updated_at: datetime()
           })
           WITH c
           MATCH (e:Entity {name: $entityName, entity_type: 'organization'})
           MERGE (c)-[:ABOUT]->(e)
           WITH c
           MATCH (s:Source {id: $sourceId})
           MERGE (c)-[:SOURCED_FROM]->(s)`,
          {
            claimId: primaryClaimId,
            content: primaryClaimText,
            domain: frontmatter.domain,
            direction: frontmatter.direction,
            frequency: frontmatter.frequency,
            amount: frontmatter.amount,
            entityName: frontmatter.source_entity,
            sourceId,
          },
        );
        stats.claims_created++;

        if (this.embedding) {
          try {
            const result = await this.embedding.embedAndStore(primaryClaimId, primaryClaimText);
            if (result.success) {
              stats.embeddings_generated++;
            }
          } catch {
            stats.errors.push(`Embedding failed for primary claim ${primaryClaimId}`);
          }
        }
      } catch (err) {
        stats.errors.push(`Primary claim creation failed: ${err}`);
      }

      // 4. Extract additional claims from body and create Claim nodes
      const claimTexts = extractClaimsFromBody(body);

      for (const claimText of claimTexts) {
        const claimId = `claim-${randomUUID()}`;
        try {
          await session.run(
            `CREATE (c:Claim {
               id: $claimId,
               content: $content,
               truth_tier: 'single_source',
               truth_score: 0.5,
               domain: $domain,
               status: 'active',
               created_at: datetime(),
               updated_at: datetime()
             })
             WITH c
             MATCH (e:Entity {name: $entityName, entity_type: 'organization'})
             MERGE (c)-[:ABOUT]->(e)
             WITH c
             MATCH (s:Source {id: $sourceId})
             MERGE (c)-[:SOURCED_FROM]->(s)`,
            {
              claimId,
              content: claimText,
              domain: frontmatter.domain,
              entityName: frontmatter.source_entity,
              sourceId,
            },
          );
          stats.claims_created++;

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
        event_subtype: "cashflow_migration",
        session_id: this.sessionId,
        outcome: stats.errors.length === 0 ? "success" : "partial",
        latency_ms: Date.now() - start,
        metadata: { ...stats, sourcePath },
      });

      return stats;
    } catch (err) {
      stats.errors.push(`Migration failed: ${err}`);

      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_write",
        event_subtype: "cashflow_migration",
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
