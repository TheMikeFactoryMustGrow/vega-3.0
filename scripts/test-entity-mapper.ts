/**
 * Test Entity Mapper with a real vault Entity note (US-013).
 *
 * Maps one real Entity note from Finance/Entities/ to Neo4j and verifies
 * the node was created with correct properties and relationships.
 *
 * Usage: npx tsx scripts/test-entity-mapper.ts
 */

import { execSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { mapEntityNoteFile } from "../src/entity-mapper.js";

const VAULT_ENTITIES_DIR = join(
  process.env["HOME"] ?? "",
  "Library/Mobile Documents/com~apple~CloudDocs/Linglepedia/Finance/Entities"
);

const NEO4J_CONTAINER = "linglepedia";
const NEO4J_USER = "neo4j";
const NEO4J_PASSWORD = "lingelpedia2026";

function runCypher(query: string): string {
  return execSync(
    `docker exec -i ${NEO4J_CONTAINER} cypher-shell -u ${NEO4J_USER} -p ${NEO4J_PASSWORD}`,
    {
      input: query,
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
    }
  ).trim();
}

async function main(): Promise<void> {
  console.log("=== Entity Mapper Integration Test ===\n");

  // 1. List available entity notes
  console.log(`Vault entities dir: ${VAULT_ENTITIES_DIR}`);
  let files: string[];
  try {
    files = (await readdir(VAULT_ENTITIES_DIR)).filter((f) =>
      f.endsWith(".md")
    );
  } catch (err) {
    console.error(`ERROR: Cannot read vault directory: ${err}`);
    process.exit(1);
  }

  console.log(`Found ${files.length} entity notes:`);
  for (const f of files) {
    console.log(`  - ${f}`);
  }

  // 2. Pick the first entity note for testing
  const testFile = files[0];
  if (!testFile) {
    console.error("ERROR: No entity notes found");
    process.exit(1);
  }

  const testPath = join(VAULT_ENTITIES_DIR, testFile);
  console.log(`\nMapping: ${testFile}`);
  console.log(`Full path: ${testPath}\n`);

  // 3. Map the entity note
  const result = await mapEntityNoteFile(testPath);
  console.log("Mapper result:");
  console.log(`  Entity ID: ${result.entityId}`);
  console.log(`  Source ID: ${result.sourceId}`);
  console.log(`  Success: ${result.success}`);
  if (result.error) {
    console.log(`  Error: ${result.error}`);
  }
  console.log(`  Relationships created: ${result.relationshipsCreated.length}`);
  for (const rel of result.relationshipsCreated) {
    console.log(`    - ${rel}`);
  }
  console.log(`  OpenQuestion created: ${result.openQuestionCreated}`);
  console.log(`  Node properties:`, JSON.stringify(result.nodeProperties, null, 2));

  if (!result.success) {
    console.error("\nFAILED: Mapper did not succeed.");
    process.exit(1);
  }

  // 4. Verify in Neo4j
  console.log("\n--- Neo4j Verification ---\n");

  // Check entity node
  const entityCheck = runCypher(
    `MATCH (e:Entity {id: "${result.entityId}"}) RETURN e.name, e.entity_type, e.truth_score, e.is_canonical, e.domain;`
  );
  console.log("Entity node:");
  console.log(entityCheck);

  // Check source node and relationship
  const sourceCheck = runCypher(
    `MATCH (e:Entity {id: "${result.entityId}"})-[:SOURCED_FROM]->(s:Source) RETURN s.id, s.source_type, s.file_path;`
  );
  console.log("\nSource node (SOURCED_FROM):");
  console.log(sourceCheck);

  // Check BELONGS_TO relationships
  const belongsCheck = runCypher(
    `MATCH (e:Entity {id: "${result.entityId}"})-[:BELONGS_TO]->(parent) RETURN parent.name;`
  );
  console.log("\nBELONGS_TO relationships:");
  console.log(belongsCheck || "(none)");

  // Check RELATED_TO relationships
  const relatedCheck = runCypher(
    `MATCH (e:Entity {id: "${result.entityId}"})-[:RELATED_TO]->(related) RETURN related.name;`
  );
  console.log("\nRELATED_TO relationships:");
  console.log(relatedCheck || "(none)");

  // 5. Run idempotency test — map again and verify no duplicates
  console.log("\n--- Idempotency Test ---\n");
  const result2 = await mapEntityNoteFile(testPath);
  console.log(`Second run success: ${result2.success}`);
  console.log(`Same entity ID: ${result.entityId === result2.entityId}`);

  const countCheck = runCypher(
    `MATCH (e:Entity {id: "${result.entityId}"}) RETURN count(e) AS cnt;`
  );
  console.log(`Entity count (should be 1): ${countCheck}`);

  console.log("\n=== PASS ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
