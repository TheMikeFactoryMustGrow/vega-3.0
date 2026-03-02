/**
 * Integration test script for US-014: Account & Cash Flow mapper.
 *
 * Maps a real Account note from the vault to Neo4j and verifies the result.
 * Run: npm run test-account-cashflow-mapper
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { mapAccountNoteFile } from "../src/account-cashflow-mapper.js";
import { runCypher } from "../src/entity-mapper.js";

const VAULT_ACCOUNTS_DIR =
  process.env.VAULT_ACCOUNTS_DIR ??
  join(
    process.env.HOME ?? "",
    "Library/Mobile Documents/com~apple~CloudDocs/Linglepedia/Finance/Accounts"
  );

async function main(): Promise<void> {
  console.log("=== US-014: Account & Cash Flow Mapper Integration Test ===\n");

  // ── 1. Find a real account note ─────────────────────────────────────────
  let files: string[];
  try {
    files = readdirSync(VAULT_ACCOUNTS_DIR).filter((f) => f.endsWith(".md"));
  } catch (err) {
    console.error(`Cannot read vault directory: ${VAULT_ACCOUNTS_DIR}`);
    console.error(
      "Set VAULT_ACCOUNTS_DIR to override, or ensure the vault is accessible."
    );
    process.exit(1);
  }

  if (files.length === 0) {
    console.error("No .md files found in vault Accounts directory.");
    process.exit(1);
  }

  console.log(`Found ${files.length} account notes in vault.\n`);

  // Pick the first few for testing
  const testFiles = files.slice(0, 3);

  for (const file of testFiles) {
    const filePath = join(VAULT_ACCOUNTS_DIR, file);
    console.log(`── Mapping: ${file}`);
    console.log(`   Path: ${filePath}`);

    const result = await mapAccountNoteFile(filePath);

    if (result.success) {
      console.log(`   ✓ Account ID: ${result.accountId}`);
      console.log(`   ✓ Source ID:  ${result.sourceId}`);
      console.log(
        `   ✓ Properties: entity_type=${result.nodeProperties.entity_type}, account_type=${result.nodeProperties.account_type}`
      );
      console.log(
        `   ✓ Relationships: ${result.relationshipsCreated.length} created`
      );
      for (const rel of result.relationshipsCreated) {
        console.log(`     - ${rel}`);
      }
      if (result.openQuestionCreated) {
        console.log(`   ⚠ OpenQuestion created (conflicted truth score)`);
      }

      // Verify in Neo4j
      try {
        const check = runCypher(
          `MATCH (e:Entity {id: "${result.accountId}"}) RETURN e.name, e.entity_type, e.account_type, e.truth_score;`
        );
        console.log(`   ✓ Neo4j verification: ${check.split("\n").slice(1).join(", ").trim()}`);
      } catch (err) {
        console.log(`   ✗ Neo4j verification failed: ${err}`);
      }
    } else {
      console.log(`   ✗ Failed: ${result.error}`);
    }
    console.log();
  }

  // ── 2. Summary stats ────────────────────────────────────────────────────
  console.log("── Summary ──");
  try {
    const countResult = runCypher(
      `MATCH (e:Entity {entity_type: "account"}) RETURN count(e) AS account_count;`
    );
    console.log(`Total account nodes in Neo4j: ${countResult.split("\n").slice(1).join("").trim()}`);
  } catch {
    console.log("Could not query Neo4j for summary stats.");
  }

  console.log("\n=== Integration test complete ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
