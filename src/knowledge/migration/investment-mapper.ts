import { randomUUID } from "node:crypto";
import { Neo4jConnection } from "../neo4j.js";
import { EmbeddingPipeline } from "../embedding.js";
import { TelemetryEmitter } from "../../telemetry/emitter.js";
import { extractClaimsFromBody, type MigrationStats, type MapperOptions } from "./entity-mapper.js";
import type { InvestmentTemplate } from "./parser.js";

/**
 * InvestmentMapper — Converts parsed Investment Obsidian notes into Neo4j Entity nodes
 * with entity_type: 'financial_instrument' and value-tracking Claims.
 *
 * Uses MERGE (not CREATE) for idempotent re-runs — matches on name + entity_type.
 * Creates RELATED_TO relationship to investment vehicle Entity.
 */

export class InvestmentMapper {
  private readonly connection: Neo4jConnection;
  private readonly embedding: EmbeddingPipeline | null;
  private readonly emitter: TelemetryEmitter;
  private readonly sessionId: string;

  constructor(options: MapperOptions) {
    this.connection = options.connection;
    this.embedding = options.embedding ?? null;
    this.emitter = options.emitter ?? new TelemetryEmitter();
    this.sessionId = `investment-mapper-${Date.now()}`;
  }

  /**
   * Migrate an Investment note into Neo4j.
   *
   * Creates/updates:
   * - Entity node with entity_type: 'financial_instrument' (MERGE on name + entity_type)
   * - Investment-specific properties: vehicle, strategy, current_value, cost_basis, inception_date
   * - RELATED_TO relationship to vehicle Entity (auto-created if not found)
   * - Value-tracking Claim (current_value and cost_basis as a claim)
   * - Source node for the Obsidian note
   * - Claim nodes for each paragraph/bullet in the body
   * - ABOUT relationships (Claim → Entity)
   * - SOURCED_FROM relationships (Claim → Source)
   */
  async migrate(
    frontmatter: InvestmentTemplate,
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
      // 1. MERGE Investment Entity node
      const entityId = `entity-${frontmatter.name.toLowerCase().replace(/\s+/g, "-")}-financial_instrument`;
      const entityResult = await session.run(
        `MERGE (e:Entity {name: $name, entity_type: 'financial_instrument'})
         ON CREATE SET
           e.id = $entityId,
           e.domain = $domain,
           e.vehicle = $vehicle,
           e.strategy = $strategy,
           e.current_value = $currentValue,
           e.cost_basis = $costBasis,
           e.inception_date = $inceptionDate,
           e.created_at = datetime(),
           e.updated_at = datetime()
         ON MATCH SET
           e.domain = $domain,
           e.vehicle = $vehicle,
           e.strategy = $strategy,
           e.current_value = $currentValue,
           e.cost_basis = $costBasis,
           e.inception_date = $inceptionDate,
           e.updated_at = datetime()
         RETURN e.id AS id, e.created_at = e.updated_at AS isNew`,
        {
          name: frontmatter.name,
          entityId,
          domain: frontmatter.domain,
          vehicle: frontmatter.vehicle,
          strategy: frontmatter.strategy,
          currentValue: frontmatter.current_value ?? null,
          costBasis: frontmatter.cost_basis ?? null,
          inceptionDate: frontmatter.inception_date ?? null,
        },
      );

      const isNew = entityResult.records[0]?.get("isNew") as boolean;
      if (isNew) {
        stats.entities_created++;
      } else {
        stats.entities_updated++;
      }

      // 2. MERGE vehicle Entity and create RELATED_TO relationship
      const vehicleId = `entity-${frontmatter.vehicle.toLowerCase().replace(/\s+/g, "-")}-financial_instrument`;
      const vehicleResult = await session.run(
        `MERGE (v:Entity {name: $vehicleName, entity_type: 'financial_instrument'})
         ON CREATE SET
           v.id = $vehicleId,
           v.domain = $domain,
           v.created_at = datetime(),
           v.updated_at = datetime()
         ON MATCH SET
           v.updated_at = datetime()
         WITH v
         MATCH (inv:Entity {name: $invName, entity_type: 'financial_instrument'})
         WHERE inv.name <> v.name
         MERGE (inv)-[:RELATED_TO]->(v)
         RETURN v.created_at = v.updated_at AS vehicleIsNew`,
        {
          vehicleName: frontmatter.vehicle,
          vehicleId,
          domain: frontmatter.domain,
          invName: frontmatter.name,
        },
      );

      const vehicleIsNew = vehicleResult.records[0]?.get("vehicleIsNew") as boolean | undefined;
      if (vehicleIsNew) {
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

      // 4. Create value-tracking Claim if current_value or cost_basis is set
      if (frontmatter.current_value != null || frontmatter.cost_basis != null) {
        const valueParts: string[] = [];
        if (frontmatter.current_value != null) {
          valueParts.push(`Current value: $${frontmatter.current_value.toLocaleString()}`);
        }
        if (frontmatter.cost_basis != null) {
          valueParts.push(`Cost basis: $${frontmatter.cost_basis.toLocaleString()}`);
        }
        const valueClaimText = `${frontmatter.name}: ${valueParts.join(", ")}`;
        const valueClaimId = `claim-${randomUUID()}`;

        try {
          await session.run(
            `CREATE (c:Claim {
               id: $claimId,
               content: $content,
               truth_tier: 'single_source',
               truth_score: 0.5,
               domain: $domain,
               status: 'active',
               claim_type: 'value_tracking',
               created_at: datetime(),
               updated_at: datetime()
             })
             WITH c
             MATCH (e:Entity {name: $entityName, entity_type: 'financial_instrument'})
             MERGE (c)-[:ABOUT]->(e)
             WITH c
             MATCH (s:Source {id: $sourceId})
             MERGE (c)-[:SOURCED_FROM]->(s)`,
            {
              claimId: valueClaimId,
              content: valueClaimText,
              domain: frontmatter.domain,
              entityName: frontmatter.name,
              sourceId,
            },
          );
          stats.claims_created++;

          if (this.embedding) {
            try {
              const result = await this.embedding.embedAndStore(valueClaimId, valueClaimText);
              if (result.success) {
                stats.embeddings_generated++;
              }
            } catch {
              stats.errors.push(`Embedding failed for value claim ${valueClaimId}`);
            }
          }
        } catch (err) {
          stats.errors.push(`Value claim creation failed: ${err}`);
        }
      }

      // 5. Extract claims from body and create Claim nodes
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
             MATCH (e:Entity {name: $entityName, entity_type: 'financial_instrument'})
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
        event_subtype: "investment_migration",
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
        event_subtype: "investment_migration",
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
