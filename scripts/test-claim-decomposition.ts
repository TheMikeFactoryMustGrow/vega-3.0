/**
 * Integration test script for the atomic claim decomposition engine (US-017).
 *
 * Tests with 3 representative unstructured notes from the Obsidian vault:
 * 1. Meeting note (customer call)
 * 2. Deep-dive meeting note (capital structure discussion)
 * 3. Trip summary / operational debrief
 *
 * Run: npm run test-claim-decomposition
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { decomposeNoteFile } from "../src/claim-decomposition.js";
import { runCypher } from "../src/entity-mapper.js";

const VAULT_BASE = join(
  process.env["HOME"] ?? "/Users/VEGA",
  "Library/Mobile Documents/com~apple~CloudDocs/Linglepedia"
);

interface TestCase {
  label: string;
  path: string;
  domain: string;
  minExpectedClaims: number;
}

// ── Find test notes ──────────────────────────────────────────────────────────

async function findMeetingNotes(): Promise<string[]> {
  const meetingNotesDir = join(VAULT_BASE, "GIX/Meeting Notes");
  try {
    const files = await readdir(meetingNotesDir);
    return files
      .filter((f) => f.endsWith(".md") && !f.startsWith("README"))
      .map((f) => join(meetingNotesDir, f));
  } catch {
    return [];
  }
}

async function findTripSummary(): Promise<string | null> {
  const metroDir = join(VAULT_BASE, "GIX/MetroConnect 2026 Notes");
  try {
    const files = await readdir(metroDir);
    const summary = files.find((f) => f.includes("Trip Summary"));
    return summary ? join(metroDir, summary) : null;
  } catch {
    return null;
  }
}

async function selectTestCases(): Promise<TestCase[]> {
  const cases: TestCase[] = [];

  // 1. Meeting note — pick shortest meeting note for faster testing
  const meetingNotes = await findMeetingNotes();
  if (meetingNotes.length > 0) {
    let bestPath = meetingNotes[0];
    let bestSize = Infinity;
    for (const p of meetingNotes) {
      const s = await stat(p);
      if (s.size < bestSize && s.size > 500) {
        bestSize = s.size;
        bestPath = p;
      }
    }
    cases.push({
      label: "Meeting Note (Customer Call)",
      path: bestPath,
      domain: "gix",
      minExpectedClaims: 2,
    });
  }

  // 2. Deep-dive meeting note
  const deepDive = meetingNotes.find((n) =>
    n.toLowerCase().includes("databank") || n.toLowerCase().includes("raul")
  );
  if (deepDive) {
    cases.push({
      label: "Deep-Dive Meeting Note (Capital Structure)",
      path: deepDive,
      domain: "gix",
      minExpectedClaims: 5,
    });
  } else if (meetingNotes.length > 1) {
    // Pick second meeting note
    cases.push({
      label: "Deep-Dive Meeting Note",
      path: meetingNotes[1],
      domain: "gix",
      minExpectedClaims: 3,
    });
  }

  // 3. Trip summary
  const tripSummary = await findTripSummary();
  if (tripSummary) {
    cases.push({
      label: "Trip Summary / Operational Debrief",
      path: tripSummary,
      domain: "gix",
      minExpectedClaims: 5,
    });
  }

  return cases;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║  Claim Decomposition Integration Test (US-017)       ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  // Verify Ollama is available
  try {
    const resp = await fetch("http://localhost:11434/api/tags");
    if (!resp.ok) throw new Error("Ollama not responding");
    console.log("  [OK] Ollama is available\n");
  } catch {
    console.error("  [FAIL] Ollama not available at localhost:11434");
    console.error("         Start Ollama and ensure qwen3:32b is pulled.\n");
    process.exit(1);
  }

  // Verify Neo4j
  try {
    runCypher("RETURN 1;");
    console.log("  [OK] Neo4j is available\n");
  } catch {
    console.error("  [FAIL] Neo4j not available");
    process.exit(1);
  }

  const testCases = await selectTestCases();
  if (testCases.length === 0) {
    console.error("  [FAIL] No test notes found in vault");
    process.exit(1);
  }

  console.log(`Found ${testCases.length} test cases:\n`);
  for (const tc of testCases) {
    console.log(`  - ${tc.label}`);
    console.log(`    Path: ${tc.path}`);
  }
  console.log();

  let totalClaims = 0;
  let totalEntities = 0;
  let allPassed = true;

  for (const tc of testCases) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Testing: ${tc.label}`);
    console.log(`File: ${tc.path}`);
    console.log(`${"─".repeat(60)}`);

    const fileContent = await readFile(tc.path, "utf-8");
    const bodyStart = fileContent.indexOf("---", 3);
    const bodyText = bodyStart > -1 ? fileContent.slice(bodyStart + 3).trim() : fileContent;
    const bodyTokens = Math.round(bodyText.length / 4);
    console.log(`  Body: ~${bodyTokens} tokens (${bodyText.length} chars)`);

    const startTime = Date.now();
    try {
      const result = await decomposeNoteFile(tc.path, tc.domain);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      console.log(`  Chunks: ${result.totalChunks}`);
      console.log(`  Raw claims extracted: ${result.rawClaimsExtracted}`);
      console.log(`  After dedup: ${result.claimsAfterDedup}`);
      console.log(`  Stored in Neo4j: ${result.claimsStored.length}`);
      console.log(`  Entities linked: ${result.entitiesLinked.length} (${result.entitiesLinked.slice(0, 5).join(", ")}${result.entitiesLinked.length > 5 ? "..." : ""})`);
      console.log(`  Time: ${elapsed}s`);

      if (result.errors.length > 0) {
        console.log(`  Errors: ${result.errors.length}`);
        for (const err of result.errors) {
          console.log(`    - ${err}`);
        }
      }

      // Sample claims
      console.log(`\n  Sample claims:`);
      for (const claim of result.claimsStored.slice(0, 3)) {
        console.log(`    [${claim.domain}] ${claim.content.slice(0, 100)}${claim.content.length > 100 ? "..." : ""}`);
        if (claim.entities.length > 0) {
          console.log(`           Entities: ${claim.entities.join(", ")}`);
        }
      }

      // Verify quality
      const passed = result.claimsStored.length >= tc.minExpectedClaims;
      console.log(`\n  Result: ${passed ? "PASS" : "FAIL"} (${result.claimsStored.length} claims, min ${tc.minExpectedClaims} expected)`);

      if (!passed) allPassed = false;

      totalClaims += result.claimsStored.length;
      totalEntities += result.entitiesLinked.length;
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  FAIL: ${err instanceof Error ? err.message : String(err)} (${elapsed}s)`);
      allPassed = false;
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log(`\n${"═".repeat(60)}`);
  console.log("SUMMARY");
  console.log(`${"═".repeat(60)}`);
  console.log(`  Notes processed: ${testCases.length}`);
  console.log(`  Total claims stored: ${totalClaims}`);
  console.log(`  Total entities linked: ${totalEntities}`);

  // Verify in Neo4j
  try {
    const claimCountRaw = runCypher(
      `MATCH (c:Claim) WHERE c.created_by = "lingelpedia_agent" RETURN count(c) AS c;`
    );
    const claimCount = parseInt(claimCountRaw.split("\n").pop()?.trim() ?? "0", 10);
    console.log(`  Claims in Neo4j (all): ${claimCount}`);

    const aboutCountRaw = runCypher(
      `MATCH (c:Claim)-[:ABOUT]->(e:Entity) WHERE c.created_by = "lingelpedia_agent" RETURN count(DISTINCT e) AS c;`
    );
    const aboutCount = parseInt(aboutCountRaw.split("\n").pop()?.trim() ?? "0", 10);
    console.log(`  Entities linked via ABOUT: ${aboutCount}`);

    const sourcedCountRaw = runCypher(
      `MATCH (c:Claim)-[:SOURCED_FROM]->(s:Source) WHERE c.created_by = "lingelpedia_agent" RETURN count(DISTINCT s) AS c;`
    );
    const sourcedCount = parseInt(sourcedCountRaw.split("\n").pop()?.trim() ?? "0", 10);
    console.log(`  Source nodes linked: ${sourcedCount}`);
  } catch (err) {
    console.log(`  Neo4j verification error: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`\n  Overall: ${allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED"}`);

  if (!allPassed) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
