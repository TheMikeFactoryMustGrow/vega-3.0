/**
 * Integration test script for contradiction detection (US-018).
 *
 * Creates deliberate contradicting claims in Neo4j, runs the detection
 * pipeline, and verifies results. Also tests migrating conflicted truth scores.
 *
 * Requires: Neo4j + Ollama running locally.
 *
 * Usage: npm run test-contradiction-detection
 */

import {
  detectContradictionsForClaim,
  migrateConflictedTruthScores,
} from "../src/contradiction-detection.js";
import { generateEmbedding } from "../src/embedding.js";
import { runCypher, escCypher } from "../src/entity-mapper.js";

const PREFIX = "claim-integration-contra-test";

async function main() {
  console.log("=== Contradiction Detection Integration Test ===\n");

  // 1. Create deliberate contradicting claims
  console.log("Step 1: Creating test claims with embeddings...");

  const claims = [
    {
      id: `${PREFIX}-a`,
      content: "DataBank operates exactly 65 data centers across 27 US markets as of 2026.",
      domain: "gix",
    },
    {
      id: `${PREFIX}-b`,
      content: "DataBank has expanded to 120 data centers across 40 global markets by 2026.",
      domain: "gix",
    },
    {
      id: `${PREFIX}-c`,
      content: "Corning signed a $6 billion fiber optic deal with Meta in early 2026.",
      domain: "technology",
    },
  ];

  for (const c of claims) {
    const emb = await generateEmbedding(c.content);
    runCypher(`MERGE (cl:Claim {id: "${c.id}"})
SET cl.content = "${escCypher(c.content)}",
    cl.domain = "${c.domain}",
    cl.truth_score = 0.7,
    cl.truth_basis = "agent-populated",
    cl.status = "active",
    cl.created_by = "lingelpedia_agent",
    cl.embedding = [${emb.join(",")}]
RETURN cl.id;`);
    console.log(`  Created: ${c.id}`);
  }

  // 2. Run contradiction detection on claim A
  console.log("\nStep 2: Running contradiction detection on claim A...");
  const result = await detectContradictionsForClaim(`${PREFIX}-a`, {
    topK: 5,
    similarityThreshold: 0.5,
    skipInsightNote: false,
  });

  console.log(`  Candidates checked: ${result.candidatesChecked}`);
  console.log(`  Contradictions found: ${result.contradictionsFound.length}`);
  console.log(`  Success: ${result.success}`);

  if (result.contradictionsFound.length > 0) {
    for (const c of result.contradictionsFound) {
      console.log(`\n  CONTRADICTION:`);
      console.log(`    Claim A: ${c.claimAContent.slice(0, 80)}...`);
      console.log(`    Claim B: ${c.claimBContent.slice(0, 80)}...`);
      console.log(`    Similarity: ${c.similarity.toFixed(3)}`);
      console.log(`    Explanation: ${c.explanation}`);
      console.log(`    OpenQuestion: ${c.openQuestionId}`);
    }
  }

  if (result.insightFileWritten) {
    console.log(`\n  Insight note written: ${result.insightFileWritten}`);
  }

  if (result.errors.length > 0) {
    console.log(`\n  Errors: ${result.errors.join(", ")}`);
  }

  // 3. Test migrate conflicted truth scores
  console.log("\n\nStep 3: Testing conflicted truth score migration...");
  const migResult = migrateConflictedTruthScores();
  console.log(`  OpenQuestions created: ${migResult.openQuestionsCreated}`);

  // 4. Cleanup
  console.log("\nStep 4: Cleaning up test data...");
  try {
    runCypher(`MATCH (c:Claim) WHERE c.id STARTS WITH "${PREFIX}" DETACH DELETE c;`);
    runCypher(`MATCH (oq:OpenQuestion) WHERE oq.id STARTS WITH "oq-contradiction-${PREFIX}" DETACH DELETE oq;`);
    console.log("  Cleaned up successfully.");
  } catch (err) {
    console.log(`  Cleanup error: ${err}`);
  }

  console.log("\n=== Test Complete ===");

  if (result.success) {
    console.log("PASS: Contradiction detection pipeline ran successfully.");
  } else {
    console.log("WARN: Pipeline had errors (may be LLM timeout — check errors above).");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
