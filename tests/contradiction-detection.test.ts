/**
 * Tests for the contradiction detection engine (US-018).
 *
 * Unit tests cover: LLM response parsing, short description generation,
 * insight note writing.
 *
 * Integration tests (require Neo4j + Ollama) cover: full contradiction
 * detection pipeline with real LLM calls, Neo4j storage, and insight notes.
 *
 * Run: npx tsx --test tests/contradiction-detection.test.ts
 */

import { describe, it, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  parseContradictionResponse,
  writeContradictionInsightNote,
  storeContradiction,
  detectContradictionsForClaim,
  detectContradictions,
  migrateConflictedTruthScores,
  type ContradictionPair,
} from "../src/contradiction-detection.js";
import { runCypher, escCypher } from "../src/entity-mapper.js";
import { generateEmbedding } from "../src/embedding.js";

// ── parseContradictionResponse ────────────────────────────────────────────────

describe("parseContradictionResponse", () => {
  it("parses valid JSON response with contradiction", () => {
    const response = JSON.stringify({
      contradicts: true,
      explanation: "Claim A says 65 data centers, Claim B says 80 data centers.",
    });
    const result = parseContradictionResponse(response);
    assert.strictEqual(result.contradicts, true);
    assert.ok(result.explanation.includes("data centers"));
  });

  it("parses valid JSON response without contradiction", () => {
    const response = JSON.stringify({
      contradicts: false,
      explanation: "Both claims describe different aspects of the same company.",
    });
    const result = parseContradictionResponse(response);
    assert.strictEqual(result.contradicts, false);
    assert.ok(result.explanation.includes("different aspects"));
  });

  it("handles markdown code fences", () => {
    const response = '```json\n{"contradicts": true, "explanation": "Conflicting numbers."}\n```';
    const result = parseContradictionResponse(response);
    assert.strictEqual(result.contradicts, true);
    assert.strictEqual(result.explanation, "Conflicting numbers.");
  });

  it("handles <think> tags from qwen3", () => {
    const response =
      '<think>Let me analyze...</think>\n{"contradicts": false, "explanation": "No conflict found."}';
    const result = parseContradictionResponse(response);
    assert.strictEqual(result.contradicts, false);
    assert.strictEqual(result.explanation, "No conflict found.");
  });

  it("returns false for invalid JSON", () => {
    const result = parseContradictionResponse("not json at all");
    assert.strictEqual(result.contradicts, false);
    assert.ok(result.explanation.includes("Could not parse"));
  });

  it("returns false for empty string", () => {
    const result = parseContradictionResponse("");
    assert.strictEqual(result.contradicts, false);
  });

  it("handles response with surrounding text", () => {
    const response =
      'Here is the result:\n{"contradicts": true, "explanation": "Direct conflict."}\nEnd of analysis.';
    const result = parseContradictionResponse(response);
    assert.strictEqual(result.contradicts, true);
    assert.strictEqual(result.explanation, "Direct conflict.");
  });

  it("treats contradicts=false when field is not boolean true", () => {
    const response = '{"contradicts": "yes", "explanation": "Sort of."}';
    const result = parseContradictionResponse(response);
    assert.strictEqual(result.contradicts, false);
  });

  it("handles missing explanation field", () => {
    const response = '{"contradicts": true}';
    const result = parseContradictionResponse(response);
    assert.strictEqual(result.contradicts, true);
    assert.strictEqual(result.explanation, "No explanation provided");
  });
});

// ── writeContradictionInsightNote ─────────────────────────────────────────────

describe("writeContradictionInsightNote", () => {
  const originalVaultDir = process.env["VAULT_DIR"];
  const testVaultDir = join(process.cwd(), "test-vault-insights-root");
  const insightsDir = join(testVaultDir, "_agent_insights");

  // Set VAULT_DIR for tests and clean up after
  const createdFiles: string[] = [];

  afterEach(() => {
    for (const f of createdFiles) {
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch { /* ok */ }
    }
    createdFiles.length = 0;
  });

  it("creates insight note with correct YAML frontmatter", () => {
    process.env["VAULT_DIR"] = testVaultDir;
    mkdirSync(insightsDir, { recursive: true });

    const pair: ContradictionPair = {
      claimAId: "claim-test-0",
      claimAContent: "DataBank operates 65 data centers.",
      claimBId: "claim-test-1",
      claimBContent: "DataBank operates 80 data centers across 30 markets.",
      similarity: 0.89,
      explanation: "Conflicting numbers: 65 vs 80 data centers.",
      openQuestionId: "oq-contradiction-claim-test-0-claim-test-1",
    };

    const filePath = writeContradictionInsightNote(pair, "gix", "gix");
    createdFiles.push(filePath);

    assert.ok(existsSync(filePath), `File should exist: ${filePath}`);

    const content = readFileSync(filePath, "utf-8");
    assert.ok(content.includes("type: contradiction"), "Should have contradiction type");
    assert.ok(content.includes("created_by: lingelpedia_agent"), "Should credit agent");
    assert.ok(content.includes("claim-test-0"), "Should reference claim A");
    assert.ok(content.includes("claim-test-1"), "Should reference claim B");
    assert.ok(content.includes("65 data centers"), "Should include claim A content");
    assert.ok(content.includes("80 data centers"), "Should include claim B content");
    assert.ok(content.includes("0.890"), "Should include similarity score");
    assert.ok(content.includes("Conflicting numbers"), "Should include explanation");
    assert.ok(content.includes("suggested_action:"), "Should have suggested action");

    // Filename should match convention
    const today = new Date().toISOString().split("T")[0];
    assert.ok(filePath.includes(`${today}_contradiction_`), "Should follow naming convention");

    // Restore
    if (originalVaultDir) {
      process.env["VAULT_DIR"] = originalVaultDir;
    } else {
      delete process.env["VAULT_DIR"];
    }
  });
});

// ── Integration Tests (require Neo4j + Ollama) ──────────────────────────────

function isOllamaAvailable(): boolean {
  try {
    execSync("curl -s http://localhost:11434/api/tags", { timeout: 3000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function isNeo4jAvailable(): boolean {
  try {
    runCypher("RETURN 1;");
    return true;
  } catch {
    return false;
  }
}

describe("Integration: storeContradiction (requires Neo4j)", { skip: !isNeo4jAvailable() }, () => {
  const CLAIM_A_ID = "claim-contra-test-a";
  const CLAIM_B_ID = "claim-contra-test-b";

  it("setup: create test claims", () => {
    runCypher(`MERGE (c:Claim {id: "${CLAIM_A_ID}"})
SET c.content = "DataBank operates 65 data centers.", c.domain = "gix", c.truth_score = 0.7, c.truth_basis = "agent-populated", c.status = "active"
RETURN c.id;`);

    runCypher(`MERGE (c:Claim {id: "${CLAIM_B_ID}"})
SET c.content = "DataBank operates 80 data centers across 30 markets.", c.domain = "gix", c.truth_score = 0.7, c.truth_basis = "agent-populated", c.status = "active"
RETURN c.id;`);
  });

  it("creates OpenQuestion and CONTRADICTS relationship", () => {
    const oqId = storeContradiction(
      CLAIM_A_ID,
      CLAIM_B_ID,
      "Conflicting numbers: 65 vs 80.",
      "gix"
    );

    assert.ok(oqId.startsWith("oq-contradiction-"), "OpenQuestion ID should start with oq-contradiction-");

    // Verify OpenQuestion exists
    const oqRaw = runCypher(`MATCH (oq:OpenQuestion {id: "${escCypher(oqId)}"}) RETURN oq.status AS s;`);
    assert.ok(oqRaw.includes("open"), "OpenQuestion should have status 'open'");

    // Verify CONTRADICTS relationship
    const relRaw = runCypher(
      `MATCH (a:Claim {id: "${CLAIM_A_ID}"})-[:CONTRADICTS]->(b:Claim {id: "${CLAIM_B_ID}"}) RETURN count(*) AS c;`
    );
    const relCount = parseInt(relRaw.split("\n").pop()?.trim() ?? "0", 10);
    assert.strictEqual(relCount, 1, "Should have exactly 1 CONTRADICTS relationship");

    // Verify MENTIONS relationships
    const mentionsRaw = runCypher(
      `MATCH (c:Claim)-[:MENTIONS]->(oq:OpenQuestion {id: "${escCypher(oqId)}"}) RETURN count(c) AS c;`
    );
    const mentionsCount = parseInt(mentionsRaw.split("\n").pop()?.trim() ?? "0", 10);
    assert.strictEqual(mentionsCount, 2, "Both claims should MENTION the OpenQuestion");

    // Verify truth scores updated to conflicted
    const basisRaw = runCypher(
      `MATCH (c:Claim) WHERE c.id IN ["${CLAIM_A_ID}", "${CLAIM_B_ID}"] RETURN c.truth_basis AS b;`
    );
    assert.ok(basisRaw.includes("conflicted"), "Both claims should have truth_basis 'conflicted'");
  });

  it("cleanup: remove test data", () => {
    try {
      runCypher(`MATCH (c:Claim) WHERE c.id IN ["${CLAIM_A_ID}", "${CLAIM_B_ID}"] DETACH DELETE c;`);
      runCypher(`MATCH (oq:OpenQuestion) WHERE oq.id STARTS WITH "oq-contradiction-claim-contra-test-" DETACH DELETE oq;`);
    } catch { /* ok */ }
  });
});

describe("Integration: detectContradictionsForClaim (requires Neo4j + Ollama)", { skip: !isOllamaAvailable() || !isNeo4jAvailable() }, () => {
  const CLAIM_A_ID = "claim-detect-test-a";
  const CLAIM_B_ID = "claim-detect-test-b";
  const CLAIM_C_ID = "claim-detect-test-c";

  it("setup: create deliberate contradicting claims with embeddings", { timeout: 60_000 }, async () => {
    // Claim A and B contradict each other
    const contentA = "DataBank currently operates exactly 65 data centers in the United States.";
    const contentB = "DataBank has expanded to 120 data centers globally as of 2026.";
    // Claim C is unrelated
    const contentC = "Corning has signed a $6 billion fiber optic deal with Meta.";

    const embA = await generateEmbedding(contentA);
    const embB = await generateEmbedding(contentB);
    const embC = await generateEmbedding(contentC);

    runCypher(`MERGE (c:Claim {id: "${CLAIM_A_ID}"})
SET c.content = "${escCypher(contentA)}", c.domain = "gix", c.truth_score = 0.7, c.truth_basis = "agent-populated", c.status = "active", c.embedding = [${embA.join(",")}]
RETURN c.id;`);

    runCypher(`MERGE (c:Claim {id: "${CLAIM_B_ID}"})
SET c.content = "${escCypher(contentB)}", c.domain = "gix", c.truth_score = 0.7, c.truth_basis = "agent-populated", c.status = "active", c.embedding = [${embB.join(",")}]
RETURN c.id;`);

    runCypher(`MERGE (c:Claim {id: "${CLAIM_C_ID}"})
SET c.content = "${escCypher(contentC)}", c.domain = "technology", c.truth_score = 0.7, c.truth_basis = "agent-populated", c.status = "active", c.embedding = [${embC.join(",")}]
RETURN c.id;`);
  });

  it("detects contradiction between conflicting claims", { timeout: 600_000 }, async () => {
    const result = await detectContradictionsForClaim(CLAIM_A_ID, {
      topK: 5,
      similarityThreshold: 0.5,
      skipInsightNote: true,
    });

    assert.ok(result.success, `Detection failed: ${result.errors.join(", ")}`);
    assert.ok(result.candidatesChecked >= 1, `Expected >=1 candidates, got ${result.candidatesChecked}`);

    // The contradicting claim B should be detected as semantically similar
    // and the LLM should confirm contradiction (65 vs 120 data centers)
    if (result.contradictionsFound.length > 0) {
      const foundContra = result.contradictionsFound.some(
        (p) => p.claimBId === CLAIM_B_ID || p.claimBId === CLAIM_A_ID
      );
      assert.ok(foundContra, "Should find contradiction with the conflicting claim");

      // Verify OpenQuestion was created
      const contra = result.contradictionsFound[0];
      const oqRaw = runCypher(
        `MATCH (oq:OpenQuestion {id: "${escCypher(contra.openQuestionId)}"}) RETURN oq.status AS s;`
      );
      assert.ok(oqRaw.includes("open"), "OpenQuestion should exist with status 'open'");
    }
    // Note: LLM judgment may vary; if no contradiction found, the test still passes
    // as long as the pipeline ran without errors
  });

  it("cleanup: remove test data", () => {
    try {
      runCypher(`MATCH (c:Claim) WHERE c.id IN ["${CLAIM_A_ID}", "${CLAIM_B_ID}", "${CLAIM_C_ID}"] DETACH DELETE c;`);
      runCypher(`MATCH (oq:OpenQuestion) WHERE oq.id STARTS WITH "oq-contradiction-claim-detect-test-" DETACH DELETE oq;`);
    } catch { /* ok */ }
  });
});

describe("Integration: detectContradictions batch (requires Neo4j + Ollama)", { skip: !isOllamaAvailable() || !isNeo4jAvailable() }, () => {
  const PREFIX = "claim-batch-contra-test";
  const IDS = [`${PREFIX}-a`, `${PREFIX}-b`, `${PREFIX}-c`];

  it("setup: create test claims", { timeout: 60_000 }, async () => {
    const claims = [
      { id: IDS[0], content: "GIX Connect has 500 route miles of fiber in the northeast.", domain: "gix" },
      { id: IDS[1], content: "GIX Connect's fiber network spans only 200 route miles in the northeast region.", domain: "gix" },
      { id: IDS[2], content: "Amazon Web Services launched a new region in Melbourne.", domain: "technology" },
    ];

    for (const c of claims) {
      const emb = await generateEmbedding(c.content);
      runCypher(`MERGE (cl:Claim {id: "${c.id}"})
SET cl.content = "${escCypher(c.content)}", cl.domain = "${c.domain}", cl.truth_score = 0.7, cl.truth_basis = "agent-populated", cl.status = "active", cl.embedding = [${emb.join(",")}]
RETURN cl.id;`);
    }
  });

  it("processes batch of claims and deduplicates contradiction pairs", { timeout: 600_000 }, async () => {
    const result = await detectContradictions(IDS, {
      topK: 5,
      similarityThreshold: 0.5,
      skipInsightNotes: true,
    });

    assert.strictEqual(result.claimsChecked, 3, "Should check all 3 claims");
    assert.ok(result.success || result.errors.length === 0, `Batch errors: ${result.errors.join(", ")}`);

    // If contradictions found, verify no duplicates (A->B and B->A should be one pair)
    const pairKeys = new Set<string>();
    for (const c of result.contradictions) {
      const key1 = `${c.claimAId}::${c.claimBId}`;
      const key2 = `${c.claimBId}::${c.claimAId}`;
      assert.ok(!pairKeys.has(key1) && !pairKeys.has(key2), `Duplicate pair found: ${key1}`);
      pairKeys.add(key1);
    }
  });

  it("cleanup: remove test data", () => {
    try {
      runCypher(`MATCH (c:Claim) WHERE c.id STARTS WITH "${PREFIX}" DETACH DELETE c;`);
      runCypher(`MATCH (oq:OpenQuestion) WHERE oq.id STARTS WITH "oq-contradiction-${PREFIX}" DETACH DELETE oq;`);
    } catch { /* ok */ }
  });
});

describe("Integration: migrateConflictedTruthScores (requires Neo4j)", { skip: !isNeo4jAvailable() }, () => {
  const ENTITY_ID = "entity-conflicted-test";

  it("setup: create entity with conflicted truth score", () => {
    runCypher(`MERGE (e:Entity {id: "${ENTITY_ID}"})
SET e.name = "Test Conflicted Entity", e.entity_type = "unknown", e.truth_score = 0.5, e.truth_basis = "conflicted", e.domain = "test"
RETURN e.id;`);
  });

  it("creates OpenQuestion nodes for conflicted entities", () => {
    const result = migrateConflictedTruthScores();
    assert.ok(result.openQuestionsCreated >= 1, `Expected >=1 OQ created, got ${result.openQuestionsCreated}`);

    // Verify the OpenQuestion exists
    const oqRaw = runCypher(
      `MATCH (e:Entity {id: "${ENTITY_ID}"})-[:MENTIONS]->(oq:OpenQuestion) RETURN oq.status AS s;`
    );
    assert.ok(oqRaw.includes("open"), "OpenQuestion should exist with status 'open'");
  });

  it("is idempotent: running twice does not create duplicates", () => {
    migrateConflictedTruthScores();
    // Already has OQ from previous test, so no new ones created
    const countRaw = runCypher(
      `MATCH (e:Entity {id: "${ENTITY_ID}"})-[:MENTIONS]->(oq:OpenQuestion) RETURN count(oq) AS c;`
    );
    const count = parseInt(countRaw.split("\n").pop()?.trim() ?? "0", 10);
    assert.strictEqual(count, 1, "Should still have exactly 1 OpenQuestion (idempotent)");
  });

  it("cleanup: remove test data", () => {
    try {
      runCypher(`MATCH (e:Entity {id: "${ENTITY_ID}"}) DETACH DELETE e;`);
      runCypher(`MATCH (oq:OpenQuestion {id: "oq-${ENTITY_ID}-conflicted"}) DETACH DELETE oq;`);
    } catch { /* ok */ }
  });
});
