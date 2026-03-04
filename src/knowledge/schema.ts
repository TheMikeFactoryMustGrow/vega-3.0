import type { Session } from "neo4j-driver";
import { Neo4jConnection } from "./neo4j.js";
import { TelemetryEmitter } from "../telemetry/emitter.js";

/**
 * Lingelpedia Schema — Applies the complete Neo4j schema for the knowledge graph.
 *
 * Creates:
 * - 5 uniqueness constraints (Claim.id, Entity.id, Source.id, OpenQuestion.id, Bet.id)
 * - 1 vector index (claim_embeddings — 1536-dim cosine for OpenAI text-embedding-3-small)
 * - 1 full-text index (claim_content)
 * - 8 lookup indexes (claim_domain, claim_status, claim_truth_tier, entity_type,
 *   bet_type, bet_status, open_question_status, source_account)
 *
 * All operations are idempotent — running twice produces no errors.
 */

const UNIQUENESS_CONSTRAINTS = [
  { name: "claim_id_unique", label: "Claim", property: "id" },
  { name: "entity_id_unique", label: "Entity", property: "id" },
  { name: "source_id_unique", label: "Source", property: "id" },
  { name: "open_question_id_unique", label: "OpenQuestion", property: "id" },
  { name: "bet_id_unique", label: "Bet", property: "id" },
] as const;

const LOOKUP_INDEXES = [
  { name: "claim_domain", label: "Claim", property: "domain" },
  { name: "claim_status", label: "Claim", property: "status" },
  { name: "claim_truth_tier", label: "Claim", property: "truth_tier" },
  { name: "entity_type", label: "Entity", property: "entity_type" },
  { name: "bet_type", label: "Bet", property: "bet_type" },
  { name: "bet_status", label: "Bet", property: "status" },
  { name: "open_question_status", label: "OpenQuestion", property: "status" },
  { name: "source_account", label: "Source", property: "source_account" },
] as const;

export interface SchemaApplicationResult {
  constraintsCreated: number;
  indexesCreated: number;
  errors: string[];
}

export async function applySchema(
  connection: Neo4jConnection,
  emitter?: TelemetryEmitter,
): Promise<SchemaApplicationResult> {
  const tel = emitter ?? new TelemetryEmitter();
  const sessionId = `schema-${Date.now()}`;
  const start = Date.now();
  const result: SchemaApplicationResult = { constraintsCreated: 0, indexesCreated: 0, errors: [] };

  const session = connection.session();
  try {
    // 1. Uniqueness constraints
    for (const c of UNIQUENESS_CONSTRAINTS) {
      try {
        await session.run(
          `CREATE CONSTRAINT ${c.name} IF NOT EXISTS FOR (n:${c.label}) REQUIRE n.${c.property} IS UNIQUE`,
        );
        result.constraintsCreated++;
      } catch (err) {
        result.errors.push(`Constraint ${c.name}: ${err}`);
      }
    }

    // 2. Vector index (1536-dim cosine for OpenAI text-embedding-3-small)
    try {
      await session.run(
        `CREATE VECTOR INDEX claim_embeddings IF NOT EXISTS
         FOR (c:Claim) ON (c.embedding)
         OPTIONS {indexConfig: {
           \`vector.dimensions\`: 1536,
           \`vector.similarity_function\`: 'cosine'
         }}`,
      );
      result.indexesCreated++;
    } catch (err) {
      result.errors.push(`Vector index claim_embeddings: ${err}`);
    }

    // 3. Full-text index
    try {
      // Full-text indexes don't support IF NOT EXISTS in all Neo4j versions,
      // so we check existence first
      const existing = await session.run(
        `SHOW INDEXES WHERE name = 'claim_content'`,
      );
      if (existing.records.length === 0) {
        await session.run(
          `CREATE FULLTEXT INDEX claim_content FOR (c:Claim) ON EACH [c.content]`,
        );
      }
      result.indexesCreated++;
    } catch (err) {
      result.errors.push(`Fulltext index claim_content: ${err}`);
    }

    // 4. Lookup indexes
    for (const idx of LOOKUP_INDEXES) {
      try {
        await session.run(
          `CREATE INDEX ${idx.name} IF NOT EXISTS FOR (n:${idx.label}) ON (n.${idx.property})`,
        );
        result.indexesCreated++;
      } catch (err) {
        result.errors.push(`Index ${idx.name}: ${err}`);
      }
    }

    await tel.emit({
      agent_name: "knowledge_agent",
      event_type: "knowledge_write",
      event_subtype: "schema_application",
      session_id: sessionId,
      outcome: result.errors.length === 0 ? "success" : "partial",
      latency_ms: Date.now() - start,
      metadata: {
        constraintsCreated: result.constraintsCreated,
        indexesCreated: result.indexesCreated,
        errors: result.errors,
      },
    });

    return result;
  } catch (err) {
    await tel.emit({
      agent_name: "knowledge_agent",
      event_type: "knowledge_write",
      event_subtype: "schema_application",
      session_id: sessionId,
      outcome: "failure",
      latency_ms: Date.now() - start,
      metadata: { error: String(err) },
    });

    result.errors.push(`Schema application failed: ${err}`);
    return result;
  } finally {
    await session.close();
  }
}

/** Verify all expected constraints and indexes exist */
export async function verifySchema(
  connection: Neo4jConnection,
): Promise<{ constraints: string[]; indexes: string[]; missing: string[] }> {
  const session = connection.session();
  try {
    const constraintResult = await session.run("SHOW CONSTRAINTS");
    const constraints = constraintResult.records.map((r) => r.get("name") as string);

    const indexResult = await session.run("SHOW INDEXES");
    const indexes = indexResult.records.map((r) => r.get("name") as string);

    const expectedConstraints = UNIQUENESS_CONSTRAINTS.map((c) => c.name);
    const expectedIndexes = [
      "claim_embeddings",
      "claim_content",
      ...LOOKUP_INDEXES.map((i) => i.name),
    ];

    const allExpected = [...expectedConstraints, ...expectedIndexes];
    const allPresent = [...constraints, ...indexes];
    const missing = allExpected.filter((name) => !allPresent.includes(name));

    return { constraints, indexes, missing };
  } finally {
    await session.close();
  }
}
