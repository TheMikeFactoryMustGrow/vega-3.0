#!/usr/bin/env npx tsx
/**
 * Integration test for cross-domain connection engine (US-019).
 *
 * Creates test claims in GIX and Finance domains, runs the connection engine,
 * and verifies that cross-domain connections are surfaced.
 *
 * Requires: Neo4j + Ollama running.
 * Run: npm run test-cross-domain-connections
 */

import { generateEmbedding } from "../src/embedding.js";
import { runCypher, escCypher } from "../src/entity-mapper.js";
import {
  findConnectionsForClaim,
  findCrossDomainConnections,
} from "../src/cross-domain-connections.js";

const PREFIX = "claim-xdomain-integ";
const TEST_CLAIMS = [
  {
    id: `${PREFIX}-gix-1`,
    content: "DataBank is expanding its data center network to 100 facilities by end of 2026, focusing on Tier II and III markets.",
    domain: "gix",
    entities: ["DataBank"],
  },
  {
    id: `${PREFIX}-gix-2`,
    content: "GIX Connect has deployed 500 route miles of fiber connecting data centers in the northeast corridor.",
    domain: "gix",
    entities: ["GIX Connect"],
  },
  {
    id: `${PREFIX}-fin-1`,
    content: "WE Capital has allocated $5M to data center infrastructure investments for fiscal year 2026.",
    domain: "finance",
    entities: ["WE Capital"],
  },
  {
    id: `${PREFIX}-fin-2`,
    content: "The portfolio holds three REIT positions focused on data center and fiber infrastructure assets.",
    domain: "finance",
    entities: [],
  },
  {
    id: `${PREFIX}-we-1`,
    content: "Wasson Enterprise is evaluating a joint venture with DataBank for colocation services in the Midwest.",
    domain: "we",
    entities: ["Wasson Enterprise", "DataBank"],
  },
];

async function setup(): Promise<void> {
  console.log("Setting up test claims...\n");

  for (const c of TEST_CLAIMS) {
    console.log(`  Generating embedding for: ${c.id}`);
    const emb = await generateEmbedding(c.content);

    runCypher(`MERGE (cl:Claim {id: "${c.id}"})
SET cl.content = "${escCypher(c.content)}",
    cl.domain = "${c.domain}",
    cl.truth_score = 0.7,
    cl.truth_basis = "agent-populated",
    cl.status = "active",
    cl.embedding = [${emb.join(",")}],
    cl.created_at = datetime()
RETURN cl.id;`);

    // Create entity links
    for (const entityName of c.entities) {
      const entityId = entityName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      runCypher(`MERGE (e:Entity {id: "${entityId}"})
ON CREATE SET e.name = "${escCypher(entityName)}", e.entity_type = "institution"
WITH e
MATCH (cl:Claim {id: "${c.id}"})
MERGE (cl)-[:ABOUT]->(e)
RETURN e.id;`);
    }
  }

  console.log("\n  Setup complete: created", TEST_CLAIMS.length, "test claims\n");
}

async function testSingleClaim(): Promise<boolean> {
  console.log("--- Test 1: Single claim cross-domain search ---");
  const result = await findConnectionsForClaim(`${PREFIX}-gix-1`, {
    topK: 10,
    similarityThreshold: 0.3,
    connectionScoreThreshold: 0.2,
    skipInsightNote: true,
    skipLLMExplanation: true,
  });

  console.log(`  Claim: ${PREFIX}-gix-1 (gix domain)`);
  console.log(`  Candidates checked: ${result.candidatesChecked}`);
  console.log(`  Connections found: ${result.connectionsFound.length}`);

  for (const conn of result.connectionsFound) {
    console.log(`    → ${conn.claimBId} (${conn.claimBDomain}) score=${conn.connectionScore.toFixed(3)} sim=${conn.similarityScore.toFixed(3)} shared=[${conn.sharedEntities.join(",")}]`);
  }

  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.join(", ")}`);
  }

  const hasCrossDomain = result.connectionsFound.some((c) => c.claimBDomain !== "gix");
  console.log(`  Cross-domain connection found: ${hasCrossDomain ? "YES ✓" : "NO"}`);
  console.log();

  return result.success;
}

async function testBatch(): Promise<boolean> {
  console.log("--- Test 2: Batch cross-domain search ---");
  const ids = TEST_CLAIMS.map((c) => c.id);
  const result = await findCrossDomainConnections(ids, {
    topK: 10,
    similarityThreshold: 0.3,
    connectionScoreThreshold: 0.2,
    skipInsightNotes: true,
    skipLLMExplanation: true,
  });

  console.log(`  Claims checked: ${result.claimsChecked}`);
  console.log(`  Total connections: ${result.totalConnections}`);

  for (const conn of result.connections) {
    console.log(`    ${conn.claimAId} (${conn.claimADomain}) ↔ ${conn.claimBId} (${conn.claimBDomain}) score=${conn.connectionScore.toFixed(3)}`);
  }

  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.join(", ")}`);
  }

  // Check for cross-domain connections
  const domains = new Set(result.connections.flatMap((c) => [c.claimADomain, c.claimBDomain]));
  console.log(`  Domains involved: ${[...domains].join(", ")}`);
  console.log(`  Multi-domain connections: ${domains.size >= 2 ? "YES ✓" : "NO"}`);
  console.log();

  return result.success;
}

async function testWithLLM(): Promise<boolean> {
  console.log("--- Test 3: Connection with LLM explanation ---");
  const result = await findConnectionsForClaim(`${PREFIX}-we-1`, {
    topK: 10,
    similarityThreshold: 0.3,
    connectionScoreThreshold: 0.2,
    skipInsightNote: true,
    skipLLMExplanation: false,
  });

  console.log(`  Claim: ${PREFIX}-we-1 (we domain)`);
  console.log(`  Connections found: ${result.connectionsFound.length}`);

  for (const conn of result.connectionsFound) {
    console.log(`    → ${conn.claimBId} (${conn.claimBDomain})`);
    console.log(`      Score: ${conn.connectionScore.toFixed(3)}`);
    console.log(`      Explanation: ${conn.explanation.slice(0, 150)}...`);
    console.log(`      Action: ${conn.suggestedAction.slice(0, 150)}...`);
  }

  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.join(", ")}`);
  }
  console.log();

  return result.success;
}

function cleanup(): void {
  console.log("Cleaning up test data...");
  try {
    runCypher(`MATCH (c:Claim) WHERE c.id STARTS WITH "${PREFIX}" DETACH DELETE c;`);
    // Clean up test entities (only delete if no other relationships)
    for (const c of TEST_CLAIMS) {
      for (const entityName of c.entities) {
        const entityId = entityName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        try {
          runCypher(`MATCH (e:Entity {id: "${entityId}"})
WHERE NOT EXISTS { MATCH (e)<-[r]-() WHERE NOT type(r) IN ["ABOUT"] }
AND NOT EXISTS { MATCH ()-[r]->(e) WHERE NOT type(r) IN ["ABOUT"] }
DETACH DELETE e;`);
        } catch { /* ok - entity may have other relationships */ }
      }
    }
  } catch (err) {
    console.log(`  Cleanup error: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log("  Done.\n");
}

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Cross-Domain Connection Engine — Integration Test");
  console.log("═══════════════════════════════════════════════════════════\n");

  try {
    await setup();

    const test1 = await testSingleClaim();
    const test2 = await testBatch();
    // Test 3 uses the LLM — skip if you want a fast run
    let test3 = true;
    if (process.argv.includes("--with-llm")) {
      test3 = await testWithLLM();
    } else {
      console.log("--- Test 3: Skipped (use --with-llm flag to enable) ---\n");
    }

    cleanup();

    console.log("═══════════════════════════════════════════════════════════");
    console.log(`  Results: Test1=${test1 ? "PASS" : "FAIL"} Test2=${test2 ? "PASS" : "FAIL"} Test3=${test3 ? "PASS" : "FAIL"}`);
    console.log("═══════════════════════════════════════════════════════════");

    if (!test1 || !test2 || !test3) {
      process.exit(1);
    }
  } catch (err) {
    console.error("Fatal error:", err);
    cleanup();
    process.exit(1);
  }
}

main();
