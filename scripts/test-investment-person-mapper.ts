/**
 * Integration test script for Investment & Person mapper (US-015).
 *
 * Maps real vault Investment Deal, Position, and Person notes to Neo4j
 * and verifies the results.
 *
 * Run: npx tsx scripts/test-investment-person-mapper.ts
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  mapInvestmentDealNoteFile,
  mapInvestmentPositionNoteFile,
  mapPersonNoteFile,
} from "../src/investment-person-mapper.js";

const VAULT =
  process.env.VAULT_PATH ??
  `${process.env.HOME}/Library/Mobile Documents/com~apple~CloudDocs/Linglepedia`;

const DEALS_DIR = join(VAULT, "WE", "Deals");
const POSITIONS_DIR = join(VAULT, "Finance", "Positions");
const PEOPLE_DIR = join(VAULT, "People");

function runCypher(query: string): string {
  return execSync(
    "docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026",
    { input: query, encoding: "utf-8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] }
  ).trim();
}

async function main() {
  console.log("=== Investment & Person Mapper Integration Test ===\n");

  // ── Test Deal Mapping ──────────────────────────────────────────────────
  console.log("── Investment Deals ──");
  let dealFiles: string[] = [];
  try {
    dealFiles = readdirSync(DEALS_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(DEALS_DIR, f));
  } catch {
    console.log("  No Deal notes found (directory missing).");
  }

  let dealSuccess = 0;
  let dealFail = 0;
  for (const file of dealFiles.slice(0, 5)) {
    const result = await mapInvestmentDealNoteFile(file);
    if (result.success) {
      dealSuccess++;
      console.log(`  ✓ ${result.betId} — ${result.relationshipsCreated.length} relationships`);
    } else {
      dealFail++;
      console.log(`  ✗ ${file} — ${result.error}`);
    }
  }
  console.log(`  Summary: ${dealSuccess} success, ${dealFail} fail out of ${Math.min(dealFiles.length, 5)} tested (${dealFiles.length} total)\n`);

  // ── Test Position Mapping ──────────────────────────────────────────────
  console.log("── Investment Positions ──");
  let posFiles: string[] = [];
  try {
    posFiles = readdirSync(POSITIONS_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(POSITIONS_DIR, f));
  } catch {
    console.log("  No Position notes found (directory missing).");
  }

  let posSuccess = 0;
  let posFail = 0;
  for (const file of posFiles.slice(0, 5)) {
    const result = await mapInvestmentPositionNoteFile(file);
    if (result.success) {
      posSuccess++;
      console.log(`  ✓ ${result.positionId} — ${result.relationshipsCreated.length} relationships`);
    } else {
      posFail++;
      console.log(`  ✗ ${file} — ${result.error}`);
    }
  }
  console.log(`  Summary: ${posSuccess} success, ${posFail} fail out of ${Math.min(posFiles.length, 5)} tested (${posFiles.length} total)\n`);

  // ── Test Person Mapping ────────────────────────────────────────────────
  console.log("── Persons ──");
  let personFiles: string[] = [];
  try {
    personFiles = readdirSync(PEOPLE_DIR)
      .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
      .map((f) => join(PEOPLE_DIR, f));
  } catch {
    console.log("  No Person notes found (directory missing).");
  }

  let personSuccess = 0;
  let personFail = 0;
  for (const file of personFiles.slice(0, 5)) {
    const result = await mapPersonNoteFile(file);
    if (result.success) {
      personSuccess++;
      console.log(`  ✓ ${result.personId} — ${result.relationshipsCreated.length} relationships`);
    } else {
      personFail++;
      console.log(`  ✗ ${file} — ${result.error}`);
    }
  }
  console.log(`  Summary: ${personSuccess} success, ${personFail} fail out of ${Math.min(personFiles.length, 5)} tested (${personFiles.length} total)\n`);

  // ── Verify in Neo4j ────────────────────────────────────────────────────
  console.log("── Neo4j Verification ──");
  try {
    const betCount = runCypher(`MATCH (b:Bet) RETURN count(b);`);
    console.log(`  Bet nodes: ${betCount.split("\n").pop()?.trim()}`);

    const posCount = runCypher(`MATCH (e:Entity {entity_type: "investment-position"}) RETURN count(e);`);
    console.log(`  Position nodes: ${posCount.split("\n").pop()?.trim()}`);

    const personCount = runCypher(`MATCH (e:Entity {entity_type: "person"}) RETURN count(e);`);
    console.log(`  Person nodes: ${personCount.split("\n").pop()?.trim()}`);

    const stakedCount = runCypher(`MATCH ()-[r:STAKED_ON]->() RETURN count(r);`);
    console.log(`  STAKED_ON edges: ${stakedCount.split("\n").pop()?.trim()}`);
  } catch (err) {
    console.log(`  Error querying Neo4j: ${err}`);
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
