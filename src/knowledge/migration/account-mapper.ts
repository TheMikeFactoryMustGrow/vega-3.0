import { randomUUID } from "node:crypto";
import { Neo4jConnection } from "../neo4j.js";
import { EmbeddingPipeline } from "../embedding.js";
import { TelemetryEmitter } from "../../telemetry/emitter.js";
import { extractClaimsFromBody, type MigrationStats, type MapperOptions } from "./entity-mapper.js";
import type { AccountTemplate } from "./parser.js";

/**
 * AccountMapper — Converts parsed Account Obsidian notes into Neo4j Entity nodes
 * with entity_type: 'account' and BELONGS_TO relationship to Institution.
 *
 * Uses MERGE (not CREATE) for idempotent re-runs — matches on name + entity_type.
 * Auto-creates Institution Entity if not found.
 */

export class AccountMapper {
  private readonly connection: Neo4jConnection;
  private readonly embedding: EmbeddingPipeline | null;
  private readonly emitter: TelemetryEmitter;
  private readonly sessionId: string;

  constructor(options: MapperOptions) {
    this.connection = options.connection;
    this.embedding = options.embedding ?? null;
    this.emitter = options.emitter ?? new TelemetryEmitter();
    this.sessionId = `account-mapper-${Date.now()}`;
  }

  /**
   * Migrate an Account note into Neo4j.
   *
   * Creates/updates:
   * - Entity node with entity_type: 'account' (MERGE on name + entity_type)
   * - Account-specific properties: institution, account_type, balance, currency, last_verified
   * - Institution Entity node (auto-created if not found)
   * - BELONGS_TO relationship (Account → Institution)
   * - Source node for the Obsidian note
   * - Claim nodes for each paragraph/bullet in the body
   * - ABOUT relationships (Claim → Entity)
   * - SOURCED_FROM relationships (Claim → Source)
   */
  async migrate(
    frontmatter: AccountTemplate,
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
      // 1. MERGE Account Entity node
      const entityId = `entity-${frontmatter.name.toLowerCase().replace(/\s+/g, "-")}-account`;
      const entityResult = await session.run(
        `MERGE (e:Entity {name: $name, entity_type: 'account'})
         ON CREATE SET
           e.id = $entityId,
           e.domain = $domain,
           e.institution = $institution,
           e.account_type = $accountType,
           e.balance = $balance,
           e.currency = $currency,
           e.last_verified = $lastVerified,
           e.created_at = datetime(),
           e.updated_at = datetime()
         ON MATCH SET
           e.domain = $domain,
           e.institution = $institution,
           e.account_type = $accountType,
           e.balance = $balance,
           e.currency = $currency,
           e.last_verified = $lastVerified,
           e.updated_at = datetime()
         RETURN e.id AS id, e.created_at = e.updated_at AS isNew`,
        {
          name: frontmatter.name,
          entityId,
          domain: frontmatter.domain,
          institution: frontmatter.institution,
          accountType: frontmatter.account_type,
          balance: frontmatter.balance ?? null,
          currency: frontmatter.currency ?? null,
          lastVerified: frontmatter.last_verified ?? null,
        },
      );

      const isNew = entityResult.records[0]?.get("isNew") as boolean;
      if (isNew) {
        stats.entities_created++;
      } else {
        stats.entities_updated++;
      }

      // 2. MERGE Institution Entity and create BELONGS_TO relationship
      const instId = `entity-${frontmatter.institution.toLowerCase().replace(/\s+/g, "-")}-organization`;
      const instResult = await session.run(
        `MERGE (inst:Entity {name: $instName, entity_type: 'organization'})
         ON CREATE SET
           inst.id = $instId,
           inst.domain = $domain,
           inst.created_at = datetime(),
           inst.updated_at = datetime()
         ON MATCH SET
           inst.updated_at = datetime()
         WITH inst
         MATCH (acct:Entity {name: $acctName, entity_type: 'account'})
         MERGE (acct)-[:BELONGS_TO]->(inst)
         RETURN inst.created_at = inst.updated_at AS instIsNew`,
        {
          instName: frontmatter.institution,
          instId,
          domain: frontmatter.domain,
          acctName: frontmatter.name,
        },
      );

      const instIsNew = instResult.records[0]?.get("instIsNew") as boolean;
      if (instIsNew) {
        stats.entities_created++;
      }

      // 3. Create Source node for the Obsidian note
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

      // 4. Extract claims from body and create Claim nodes
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
             MATCH (e:Entity {name: $entityName, entity_type: 'account'})
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
              sourceId,
            },
          );
          stats.claims_created++;

          // 5. Generate embedding for the claim
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
        event_subtype: "account_migration",
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
        event_subtype: "account_migration",
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
