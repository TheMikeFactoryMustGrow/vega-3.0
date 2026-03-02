/**
 * Tests for the cross-domain connection engine (US-019).
 *
 * Unit tests cover: connection scoring, temporal proximity, LLM response parsing,
 * short description generation, insight note writing.
 *
 * Integration tests (require Neo4j + Ollama) cover: full cross-domain connection
 * pipeline with real vector similarity, Neo4j queries, and insight notes.
 *
 * Run: npx tsx --test tests/cross-domain-connections.test.ts
 */

import { describe, it, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  parseConnectionResponse,
  writeConnectionInsightNote,
  computeConnectionScore,
  temporalProximityScore,
  findConnectionsForClaim,
  findCrossDomainConnections,
  type CrossDomainConnection,
} from "../src/cross-domain-connections.js";
import { runCypher, escCypher } from "../src/entity-mapper.js";
import { generateEmbedding } from "../src/embedding.js";

// ── parseConnectionResponse ──────────────────────────────────────────────────

describe("parseConnectionResponse", () => {
  it("parses valid JSON response", () => {
    const response = JSON.stringify({
      explanation: "Both claims relate to data center expansion in the same market.",
      suggested_action: "Cross-reference the capacity numbers.",
    });
    const result = parseConnectionResponse(response);
    assert.ok(result.explanation.includes("data center"));
    assert.ok(result.suggestedAction.includes("Cross-reference"));
  });

  it("handles markdown code fences", () => {
    const response = '```json\n{"explanation": "Related via shared entity.", "suggested_action": "Review."}\n```';
    const result = parseConnectionResponse(response);
    assert.strictEqual(result.explanation, "Related via shared entity.");
    assert.strictEqual(result.suggestedAction, "Review.");
  });

  it("handles <think> tags from qwen3", () => {
    const response =
      '<think>Analyzing connection...</think>\n{"explanation": "Financial link.", "suggested_action": "Investigate."}';
    const result = parseConnectionResponse(response);
    assert.strictEqual(result.explanation, "Financial link.");
    assert.strictEqual(result.suggestedAction, "Investigate.");
  });

  it("returns fallback for invalid JSON", () => {
    const result = parseConnectionResponse("not json at all");
    assert.ok(result.explanation.includes("Could not parse"));
    assert.ok(result.suggestedAction.includes("Review"));
  });

  it("returns fallback for empty string", () => {
    const result = parseConnectionResponse("");
    assert.ok(result.explanation.includes("Could not parse"));
  });

  it("handles suggestedAction as camelCase key", () => {
    const response = '{"explanation": "Test.", "suggestedAction": "Do something."}';
    const result = parseConnectionResponse(response);
    assert.strictEqual(result.suggestedAction, "Do something.");
  });

  it("handles response with surrounding text", () => {
    const response =
      'Here is the analysis:\n{"explanation": "Connected via fiber.", "suggested_action": "Verify."}\nDone.';
    const result = parseConnectionResponse(response);
    assert.strictEqual(result.explanation, "Connected via fiber.");
    assert.strictEqual(result.suggestedAction, "Verify.");
  });

  it("handles missing suggested_action field", () => {
    const response = '{"explanation": "Some connection."}';
    const result = parseConnectionResponse(response);
    assert.strictEqual(result.explanation, "Some connection.");
    assert.ok(result.suggestedAction.includes("Review"));
  });
});

// ── temporalProximityScore ───────────────────────────────────────────────────

describe("temporalProximityScore", () => {
  it("returns 1.0 for same date", () => {
    const score = temporalProximityScore("2026-03-01", "2026-03-01");
    assert.ok(score > 0.99, `Expected ~1.0, got ${score}`);
  });

  it("returns lower score for dates far apart", () => {
    const score = temporalProximityScore("2025-01-01", "2026-03-01");
    assert.ok(score < 0.1, `Expected <0.1 for ~14 months apart, got ${score}`);
  });

  it("returns moderate score for dates weeks apart", () => {
    const score = temporalProximityScore("2026-02-15", "2026-03-01");
    assert.ok(score > 0.5 && score < 1.0, `Expected 0.5-1.0 for ~2 weeks, got ${score}`);
  });

  it("returns 0.5 when one date is null", () => {
    assert.strictEqual(temporalProximityScore(null, "2026-03-01"), 0.5);
    assert.strictEqual(temporalProximityScore("2026-03-01", null), 0.5);
  });

  it("returns 0.5 when both dates are null", () => {
    assert.strictEqual(temporalProximityScore(null, null), 0.5);
  });

  it("returns 0.5 for invalid date strings", () => {
    assert.strictEqual(temporalProximityScore("not-a-date", "2026-03-01"), 0.5);
  });
});

// ── computeConnectionScore ───────────────────────────────────────────────────

describe("computeConnectionScore", () => {
  it("returns high score for high similarity with shared entities", () => {
    const score = computeConnectionScore(0.9, 2, 3, 0.8);
    assert.ok(score > 0.7, `Expected >0.7, got ${score}`);
  });

  it("returns moderate score for similarity alone", () => {
    const score = computeConnectionScore(0.7, 0, 0, 0.5);
    assert.ok(score > 0.3 && score < 0.6, `Expected 0.3-0.6, got ${score}`);
  });

  it("returns low score for low similarity with no entities", () => {
    const score = computeConnectionScore(0.3, 0, 0, 0.5);
    assert.ok(score < 0.4, `Expected <0.4, got ${score}`);
  });

  it("weights components correctly: 50% similarity + 30% entity + 20% temporal", () => {
    // Only similarity = 1.0, others = 0
    const simOnly = computeConnectionScore(1.0, 0, 5, 0);
    assert.ok(Math.abs(simOnly - 0.5) < 0.01, `Expected ~0.5 (50% sim), got ${simOnly}`);

    // Only entities = max, others = 0
    const entOnly = computeConnectionScore(0, 5, 5, 0);
    assert.ok(Math.abs(entOnly - 0.3) < 0.01, `Expected ~0.3 (30% entity), got ${entOnly}`);

    // Only temporal = 1.0, others = 0
    const tempOnly = computeConnectionScore(0, 0, 0, 1.0);
    assert.ok(Math.abs(tempOnly - 0.2) < 0.01, `Expected ~0.2 (20% temporal), got ${tempOnly}`);
  });

  it("caps entity score at 1.0 when shared > total", () => {
    // Edge case: shared can't really exceed total, but guard against it
    const score = computeConnectionScore(0.5, 10, 3, 0.5);
    assert.ok(score <= 1.0, `Score should not exceed 1.0, got ${score}`);
  });
});

// ── writeConnectionInsightNote ───────────────────────────────────────────────

describe("writeConnectionInsightNote", () => {
  const originalVaultDir = process.env["VAULT_DIR"];
  const testVaultDir = join(process.cwd(), "test-vault-connections-root");
  const insightsDir = join(testVaultDir, "_agent_insights");
  const createdFiles: string[] = [];

  afterEach(() => {
    for (const f of createdFiles) {
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch { /* ok */ }
    }
    createdFiles.length = 0;
    if (originalVaultDir) {
      process.env["VAULT_DIR"] = originalVaultDir;
    } else {
      delete process.env["VAULT_DIR"];
    }
  });

  it("creates insight note with correct YAML frontmatter and body", () => {
    process.env["VAULT_DIR"] = testVaultDir;
    mkdirSync(insightsDir, { recursive: true });

    const connection: CrossDomainConnection = {
      claimAId: "claim-gix-test-0",
      claimAContent: "DataBank operates 65 data centers in 30 markets.",
      claimADomain: "gix",
      claimBId: "claim-finance-test-0",
      claimBContent: "WE Capital has $2M deployed in data center infrastructure.",
      claimBDomain: "finance",
      similarityScore: 0.78,
      sharedEntities: ["databank"],
      connectionScore: 0.72,
      explanation: "DataBank's data center operations connect to WE Capital's infrastructure investment.",
      suggestedAction: "Verify if WE Capital's investment includes DataBank directly.",
    };

    const filePath = writeConnectionInsightNote(connection);
    createdFiles.push(filePath);

    assert.ok(existsSync(filePath), `File should exist: ${filePath}`);

    const content = readFileSync(filePath, "utf-8");
    assert.ok(content.includes("type: connection"), "Should have connection type");
    assert.ok(content.includes("created_by: lingelpedia_agent"), "Should credit agent");
    assert.ok(content.includes("claim-gix-test-0"), "Should reference claim A");
    assert.ok(content.includes("claim-finance-test-0"), "Should reference claim B");
    assert.ok(content.includes("gix"), "Should include domain A");
    assert.ok(content.includes("finance"), "Should include domain B");
    assert.ok(content.includes("0.720"), "Should include connection score");
    assert.ok(content.includes("DataBank"), "Should include claim content");
    assert.ok(content.includes("[[databank]]"), "Should include shared entities as wikilinks");
    assert.ok(content.includes("suggested_action:"), "Should have suggested action in frontmatter");

    const today = new Date().toISOString().split("T")[0];
    assert.ok(filePath.includes(`${today}_connection_`), "Should follow naming convention");
  });

  it("handles connection with no shared entities", () => {
    process.env["VAULT_DIR"] = testVaultDir;
    mkdirSync(insightsDir, { recursive: true });

    const connection: CrossDomainConnection = {
      claimAId: "claim-test-a",
      claimAContent: "Claim A content.",
      claimADomain: "gix",
      claimBId: "claim-test-b",
      claimBContent: "Claim B content.",
      claimBDomain: "finance",
      similarityScore: 0.65,
      sharedEntities: [],
      connectionScore: 0.5,
      explanation: "Indirect connection.",
      suggestedAction: "Review.",
    };

    const filePath = writeConnectionInsightNote(connection);
    createdFiles.push(filePath);

    const content = readFileSync(filePath, "utf-8");
    assert.ok(content.includes("None identified"), "Should show 'None identified' for empty shared entities");
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

describe("Integration: findConnectionsForClaim (requires Neo4j + Ollama)", { skip: !isOllamaAvailable() || !isNeo4jAvailable() }, () => {
  const PREFIX = "claim-xdomain-test";
  const GIX_ID = `${PREFIX}-gix`;
  const FIN_ID = `${PREFIX}-fin`;
  const GIX2_ID = `${PREFIX}-gix2`;

  it("setup: create claims in different domains with embeddings", { timeout: 60_000 }, async () => {
    const claims = [
      {
        id: GIX_ID,
        content: "DataBank is expanding its data center footprint to 100 facilities by end of 2026.",
        domain: "gix",
      },
      {
        id: FIN_ID,
        content: "WE Capital allocated $5M to data center infrastructure investments in Q1 2026.",
        domain: "finance",
      },
      {
        id: GIX2_ID,
        content: "GIX Connect fiber network serves 25 data centers in the Midwest region.",
        domain: "gix",
      },
    ];

    for (const c of claims) {
      const emb = await generateEmbedding(c.content);
      runCypher(`MERGE (cl:Claim {id: "${c.id}"})
SET cl.content = "${escCypher(c.content)}", cl.domain = "${c.domain}", cl.truth_score = 0.7, cl.truth_basis = "agent-populated", cl.status = "active", cl.embedding = [${emb.join(",")}], cl.created_at = datetime()
RETURN cl.id;`);
    }

    // Create a shared entity link
    runCypher(`MERGE (e:Entity {id: "databank"})
ON CREATE SET e.name = "DataBank", e.entity_type = "institution"
WITH e
MATCH (c:Claim {id: "${GIX_ID}"})
MERGE (c)-[:ABOUT]->(e)
RETURN e.id;`);

    runCypher(`MATCH (c:Claim {id: "${FIN_ID}"})
MERGE (e:Entity {id: "databank"})
MERGE (c)-[:ABOUT]->(e)
RETURN e.id;`);
  });

  it("finds cross-domain connections between GIX and Finance claims", { timeout: 600_000 }, async () => {
    const result = await findConnectionsForClaim(GIX_ID, {
      topK: 10,
      similarityThreshold: 0.3,
      connectionScoreThreshold: 0.2,
      skipInsightNote: true,
      skipLLMExplanation: true,
    });

    assert.ok(result.success, `Detection failed: ${result.errors.join(", ")}`);

    // Should have checked at least the finance claim (different domain)
    assert.ok(result.candidatesChecked >= 1, `Expected >=1 cross-domain candidates, got ${result.candidatesChecked}`);

    // Should NOT include the same-domain GIX2 claim
    const sameDomain = result.connectionsFound.filter((c) => c.claimBDomain === "gix");
    assert.strictEqual(sameDomain.length, 0, "Should not include same-domain claims");

    // Finance claim should be a connection candidate
    if (result.connectionsFound.length > 0) {
      const finConnection = result.connectionsFound.find((c) => c.claimBId === FIN_ID);
      if (finConnection) {
        assert.ok(finConnection.connectionScore > 0, "Connection score should be positive");
        assert.ok(finConnection.claimBDomain === "finance", "Should be from finance domain");
      }
    }
  });

  it("batch mode finds connections and deduplicates pairs", { timeout: 600_000 }, async () => {
    const result = await findCrossDomainConnections([GIX_ID, FIN_ID], {
      topK: 10,
      similarityThreshold: 0.3,
      connectionScoreThreshold: 0.2,
      skipInsightNotes: true,
      skipLLMExplanation: true,
    });

    assert.strictEqual(result.claimsChecked, 2, "Should check both claims");
    assert.ok(result.success, `Batch failed: ${result.errors.join(", ")}`);

    // Verify no duplicate pairs (A→B and B→A should be deduplicated)
    const pairKeys = new Set<string>();
    for (const c of result.connections) {
      const key1 = `${c.claimAId}::${c.claimBId}`;
      const key2 = `${c.claimBId}::${c.claimAId}`;
      assert.ok(!pairKeys.has(key1) && !pairKeys.has(key2), `Duplicate pair found: ${key1}`);
      pairKeys.add(key1);
    }
  });

  it("cleanup: remove test data", () => {
    try {
      runCypher(`MATCH (c:Claim) WHERE c.id STARTS WITH "${PREFIX}" DETACH DELETE c;`);
      runCypher(`MATCH (e:Entity {id: "databank"}) DETACH DELETE e;`);
    } catch { /* ok */ }
  });
});
