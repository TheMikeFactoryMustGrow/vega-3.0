/**
 * apply-schema.ts — Apply the Lingelpedia Neo4j schema and verify it.
 *
 * Reads cypher/lingelpedia-schema.cypher, executes each statement against
 * Neo4j via cypher-shell inside the linglepedia container, then verifies
 * all expected constraints and indexes exist.
 *
 * Usage: npx tsx scripts/apply-schema.ts
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const NEO4J_CONTAINER = "linglepedia";
const NEO4J_USER = "neo4j";
const NEO4J_PASS = "lingelpedia2026";

// ─── Helpers ────────────────────────────────────────────────────────────────

function cypher(query: string): string {
  const cmd = `docker exec -i ${NEO4J_CONTAINER} cypher-shell -u ${NEO4J_USER} -p ${NEO4J_PASS}`;
  return execSync(cmd, { input: query, encoding: "utf-8" }).trim();
}

function log(icon: string, msg: string): void {
  console.log(`${icon}  ${msg}`);
}

// ─── Apply Schema ───────────────────────────────────────────────────────────

function applySchema(): void {
  const schemaPath = resolve(import.meta.dirname!, "..", "cypher", "lingelpedia-schema.cypher");
  const raw = readFileSync(schemaPath, "utf-8");

  // Split on semicolons, strip comments and blank lines
  const statements = raw
    .split(";")
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n")
        .trim()
    )
    .filter((s) => s.length > 0);

  log("📋", `Found ${statements.length} schema statements`);

  for (const stmt of statements) {
    const label = stmt.split("\n")[0].trim().slice(0, 80);
    try {
      cypher(stmt);
      log("✅", label);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("❌", `FAILED: ${label}`);
      console.error(`   ${msg}`);
      process.exit(1);
    }
  }
}

// ─── Verify Schema ──────────────────────────────────────────────────────────

function parseTable(output: string): Record<string, string>[] {
  const lines = output.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"(.*)"$/, "$1"));
  return lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim().replace(/^"(.*)"$/, "$1"));
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = values[i] ?? "";
    });
    return row;
  });
}

const EXPECTED_CONSTRAINTS = [
  "claim_id_unique",
  "entity_id_unique",
  "source_id_unique",
  "open_question_id_unique",
  "bet_id_unique",
];

const EXPECTED_INDEXES = [
  { name: "claim_embeddings", type: "VECTOR" },
  { name: "claim_content", type: "FULLTEXT" },
  { name: "claim_domain", type: "RANGE" },
  { name: "claim_status", type: "RANGE" },
  { name: "entity_type", type: "RANGE" },
  { name: "bet_type", type: "RANGE" },
  { name: "bet_status", type: "RANGE" },
  { name: "open_question_status", type: "RANGE" },
];

function verifySchema(): boolean {
  log("🔍", "Verifying schema...\n");
  let allGood = true;

  // Check constraints
  const constraintOutput = cypher("SHOW CONSTRAINTS");
  const constraints = parseTable(constraintOutput);
  const constraintNames = new Set(constraints.map((c) => c["name"]));

  console.log("  Constraints:");
  for (const name of EXPECTED_CONSTRAINTS) {
    if (constraintNames.has(name)) {
      console.log(`    ✅ ${name}`);
    } else {
      console.log(`    ❌ ${name} — MISSING`);
      allGood = false;
    }
  }

  // Check indexes
  const indexOutput = cypher("SHOW INDEXES");
  const indexes = parseTable(indexOutput);
  const indexMap = new Map(indexes.map((i) => [i["name"], i["type"]]));

  console.log("\n  Indexes:");
  for (const { name, type } of EXPECTED_INDEXES) {
    const actual = indexMap.get(name);
    if (actual === type) {
      console.log(`    ✅ ${name} (${type})`);
    } else if (actual) {
      console.log(`    ⚠️  ${name} — expected ${type}, got ${actual}`);
      allGood = false;
    } else {
      console.log(`    ❌ ${name} — MISSING`);
      allGood = false;
    }
  }

  return allGood;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Lingelpedia Schema — Apply & Verify");
  console.log("═══════════════════════════════════════════════════\n");

  // Check Neo4j is reachable
  try {
    cypher("RETURN 1 AS test");
  } catch {
    log("❌", "Cannot reach Neo4j. Is the linglepedia container running?");
    process.exit(1);
  }
  log("🔌", "Neo4j is reachable\n");

  // Apply
  applySchema();
  console.log();

  // Verify
  const ok = verifySchema();
  console.log();

  if (ok) {
    log("🎉", "Schema applied and verified — all constraints and indexes present.");
  } else {
    log("❌", "Schema verification FAILED — see above for details.");
    process.exit(1);
  }
}

main();
