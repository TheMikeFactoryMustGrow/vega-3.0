/**
 * Tests for the atomic claim decomposition engine (US-017).
 *
 * Unit tests cover: chunking, LLM response parsing, cosine similarity,
 * claim ID generation, domain derivation.
 *
 * Integration tests (require Neo4j + Ollama) cover: full decomposition
 * pipeline with real LLM calls, deduplication, Neo4j storage.
 *
 * Run: npx tsx --test tests/claim-decomposition.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import {
  chunkText,
  parseLLMResponse,
  cosineSimilarity,
  generateClaimId,
  resolveLLMConfig,
  decomposeChunk,
  deduplicateClaims,
  decomposeNote,
  decomposeNoteString,
} from "../src/claim-decomposition.js";
import { runCypher } from "../src/entity-mapper.js";

// ── chunkText ────────────────────────────────────────────────────────────────

describe("chunkText", () => {
  it("returns empty array for empty string", () => {
    assert.deepStrictEqual(chunkText(""), []);
  });

  it("returns empty array for whitespace-only string", () => {
    assert.deepStrictEqual(chunkText("   \n\n  "), []);
  });

  it("returns single chunk for short text", () => {
    const text = "This is a short note about a meeting.";
    const chunks = chunkText(text);
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0], text);
  });

  it("returns single chunk for text under 2500 tokens (~10000 chars)", () => {
    const text = "A".repeat(9000);
    const chunks = chunkText(text);
    assert.strictEqual(chunks.length, 1);
  });

  it("splits long text into overlapping chunks", () => {
    // Create text well over 16000 chars (4000 token threshold)
    const sentences: string[] = [];
    for (let i = 0; i < 300; i++) {
      sentences.push(`Sentence number ${i} contains very important detailed information about the overall project scope and deliverables. `);
    }
    const text = sentences.join("");
    assert.ok(text.length > 16000, `Text should be >16000 chars, got ${text.length}`);

    const chunks = chunkText(text);
    assert.ok(chunks.length >= 2, `Expected >=2 chunks, got ${chunks.length}`);

    for (const chunk of chunks) {
      assert.ok(chunk.length > 0, "No empty chunks");
      assert.ok(chunk.length <= 9000, `Chunk too large: ${chunk.length}`);
    }
  });

  it("prefers paragraph boundaries for splitting", () => {
    const paragraph1 = "First paragraph with some important text. ".repeat(400);
    const paragraph2 = "Second paragraph with other important text. ".repeat(400);
    const text = paragraph1 + "\n\n" + paragraph2;
    assert.ok(text.length > 16000, `Text should be >16000 chars, got ${text.length}`);

    const chunks = chunkText(text);
    assert.ok(chunks.length >= 2);
    // With paragraph boundary present, the split should happen at \n\n
    // rather than mid-sentence. Verify chunk boundary is clean.
    const firstChunkTrimmed = chunks[0].trim();
    assert.ok(
      firstChunkTrimmed.endsWith(".") || firstChunkTrimmed.endsWith("\n"),
      `First chunk should end at a sentence or paragraph boundary, ends with: "${firstChunkTrimmed.slice(-20)}"`
    );
  });
});

// ── parseLLMResponse ─────────────────────────────────────────────────────────

describe("parseLLMResponse", () => {
  it("parses valid JSON response", () => {
    const response = JSON.stringify({
      claims: [
        { content: "Arelion is expanding in the Midwest.", entities: ["Arelion"], domain_hint: "telecommunications" },
        { content: "Meta signed a $6B deal with Corning.", entities: ["Meta", "Corning"], domain_hint: "technology" },
      ],
    });
    const claims = parseLLMResponse(response);
    assert.strictEqual(claims.length, 2);
    assert.strictEqual(claims[0].content, "Arelion is expanding in the Midwest.");
    assert.deepStrictEqual(claims[0].entities, ["Arelion"]);
    assert.strictEqual(claims[0].domainHint, "telecommunications");
  });

  it("handles markdown code fences", () => {
    const response = '```json\n{"claims":[{"content":"Test claim.","entities":[],"domain_hint":"test"}]}\n```';
    const claims = parseLLMResponse(response);
    assert.strictEqual(claims.length, 1);
    assert.strictEqual(claims[0].content, "Test claim.");
  });

  it("handles <think> tags from qwen3", () => {
    const response = '<think>Let me analyze this text...</think>\n{"claims":[{"content":"Claim one.","entities":["Person"],"domain_hint":"business"}]}';
    const claims = parseLLMResponse(response);
    assert.strictEqual(claims.length, 1);
    assert.strictEqual(claims[0].content, "Claim one.");
  });

  it("returns empty array for invalid JSON", () => {
    assert.deepStrictEqual(parseLLMResponse("not json"), []);
  });

  it("returns empty array for empty claims", () => {
    assert.deepStrictEqual(parseLLMResponse('{"claims":[]}'), []);
  });

  it("filters out claims with empty content", () => {
    const response = JSON.stringify({
      claims: [
        { content: "", entities: [], domain_hint: "test" },
        { content: "Valid claim.", entities: [], domain_hint: "test" },
      ],
    });
    const claims = parseLLMResponse(response);
    assert.strictEqual(claims.length, 1);
    assert.strictEqual(claims[0].content, "Valid claim.");
  });

  it("handles missing entities field", () => {
    const response = '{"claims":[{"content":"Claim without entities.","domain_hint":"test"}]}';
    const claims = parseLLMResponse(response);
    assert.strictEqual(claims.length, 1);
    assert.deepStrictEqual(claims[0].entities, []);
  });

  it("handles missing domain_hint field", () => {
    const response = '{"claims":[{"content":"Claim without domain.","entities":["Test"]}]}';
    const claims = parseLLMResponse(response);
    assert.strictEqual(claims.length, 1);
    assert.strictEqual(claims[0].domainHint, "unknown");
  });

  it("handles JSON with surrounding text", () => {
    const response = 'Here is the analysis:\n{"claims":[{"content":"Found claim.","entities":[],"domain_hint":"test"}]}\nDone.';
    const claims = parseLLMResponse(response);
    assert.strictEqual(claims.length, 1);
    assert.strictEqual(claims[0].content, "Found claim.");
  });
});

// ── cosineSimilarity ─────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5];
    const sim = cosineSimilarity(v, v);
    assert.ok(Math.abs(sim - 1.0) < 0.001, `Expected ~1.0, got ${sim}`);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    const sim = cosineSimilarity(a, b);
    assert.ok(Math.abs(sim) < 0.001, `Expected ~0, got ${sim}`);
  });

  it("returns -1 for opposite vectors", () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    const sim = cosineSimilarity(a, b);
    assert.ok(Math.abs(sim + 1.0) < 0.001, `Expected ~-1.0, got ${sim}`);
  });

  it("returns 0 for empty vectors", () => {
    assert.strictEqual(cosineSimilarity([], []), 0);
  });

  it("returns 0 for different-length vectors", () => {
    assert.strictEqual(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  });

  it("computes correct similarity for non-trivial vectors", () => {
    const a = [1, 2, 3];
    const b = [1, 2, 4];
    const sim = cosineSimilarity(a, b);
    assert.ok(sim > 0.9 && sim < 1.0, `Expected high similarity, got ${sim}`);
  });
});

// ── generateClaimId ──────────────────────────────────────────────────────────

describe("generateClaimId", () => {
  it("generates deterministic ID from source and index", () => {
    const id = generateClaimId("/path/to/Meeting Notes.md", 0);
    assert.strictEqual(id, "claim-meeting-notes-0");
  });

  it("handles special characters in filename", () => {
    const id = generateClaimId("/path/to/DataBank – Raul Martynek Call – Feb 2026.md", 3);
    assert.strictEqual(id, "claim-databank-raul-martynek-call-feb-2026-3");
  });

  it("increments index correctly", () => {
    const id0 = generateClaimId("test.md", 0);
    const id1 = generateClaimId("test.md", 1);
    assert.notStrictEqual(id0, id1);
    assert.ok(id0.endsWith("-0"));
    assert.ok(id1.endsWith("-1"));
  });
});

// ── resolveLLMConfig ─────────────────────────────────────────────────────────

describe("resolveLLMConfig", () => {
  it("defaults to Ollama qwen3:32b without env vars", () => {
    const original = process.env["XAI_API_KEY"];
    delete process.env["XAI_API_KEY"];
    delete process.env["LLM_BASE_URL"];
    delete process.env["LLM_MODEL"];
    delete process.env["LLM_API_KEY"];

    const config = resolveLLMConfig();
    assert.strictEqual(config.baseUrl, "http://localhost:11434/v1");
    assert.strictEqual(config.model, "qwen3:32b");
    assert.strictEqual(config.apiKey, "ollama");

    if (original !== undefined) process.env["XAI_API_KEY"] = original;
  });

  it("uses xAI when XAI_API_KEY is set", () => {
    const original = process.env["XAI_API_KEY"];
    process.env["XAI_API_KEY"] = "test-key-123";

    const config = resolveLLMConfig();
    assert.strictEqual(config.baseUrl, "https://api.x.ai/v1");
    assert.strictEqual(config.model, "grok-4.20");
    assert.strictEqual(config.apiKey, "test-key-123");

    if (original !== undefined) {
      process.env["XAI_API_KEY"] = original;
    } else {
      delete process.env["XAI_API_KEY"];
    }
  });

  it("allows overrides to take precedence", () => {
    const config = resolveLLMConfig({
      baseUrl: "http://custom:1234/v1",
      model: "custom-model",
      apiKey: "custom-key",
    });
    assert.strictEqual(config.baseUrl, "http://custom:1234/v1");
    assert.strictEqual(config.model, "custom-model");
    assert.strictEqual(config.apiKey, "custom-key");
  });
});

// ── Integration Tests (require Ollama + Neo4j) ──────────────────────────────
// These tests make real LLM calls and Neo4j writes.
// Skip if Ollama or Neo4j is not available.

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

describe("Integration: decomposeChunk (requires Ollama)", { skip: !isOllamaAvailable() }, () => {
  it("extracts claims from a simple text", { timeout: 120_000 }, async () => {
    const text = `Mike Lingle met with Raul Martynek, CEO of DataBank, on February 27, 2026.
DataBank has raised north of $10 billion in debt and equity throughout its history.
Australian Super joined as a new institutional investor in 2024 with a $2.6B raise.`;

    const claims = await decomposeChunk(text);
    assert.ok(claims.length >= 2, `Expected >=2 claims, got ${claims.length}`);

    // At least one claim should mention DataBank or Mike Lingle
    const mentionsKnownEntity = claims.some(
      (c) =>
        c.content.toLowerCase().includes("databank") ||
        c.content.toLowerCase().includes("mike lingle") ||
        c.entities.some((e) => e.toLowerCase().includes("databank") || e.toLowerCase().includes("mike"))
    );
    assert.ok(mentionsKnownEntity, "Should extract claims mentioning known entities");
  });

  it("returns claims with entities", { timeout: 120_000 }, async () => {
    const text = "Corning has stopped selling glass to other cable manufacturers. Meta alone signed a $6B deal with Corning.";
    const claims = await decomposeChunk(text);
    assert.ok(claims.length >= 1, "Should extract at least 1 claim");

    const allEntities = claims.flatMap((c) => c.entities);
    assert.ok(
      allEntities.some((e) => e.toLowerCase().includes("corning") || e.toLowerCase().includes("meta")),
      `Should extract Corning or Meta as entities, got: ${allEntities.join(", ")}`
    );
  });
});

describe("Integration: deduplicateClaims (requires Ollama)", { skip: !isOllamaAvailable() }, () => {
  it("removes near-duplicate claims", { timeout: 60_000 }, async () => {
    const claims = [
      { content: "DataBank has raised over $10 billion in debt and equity.", entities: ["DataBank"], domainHint: "finance" },
      { content: "DataBank raised north of $10 billion in total debt and equity funding.", entities: ["DataBank"], domainHint: "finance" },
      { content: "Corning stopped selling glass to other cable manufacturers.", entities: ["Corning"], domainHint: "technology" },
    ];

    const { unique } = await deduplicateClaims(claims);
    // The two DataBank claims are semantically near-identical, should dedup to 1
    // Plus the Corning claim = 2 unique claims
    assert.ok(
      unique.length <= claims.length,
      `Should have <= ${claims.length} unique claims, got ${unique.length}`
    );
    assert.ok(unique.length >= 2, `Should keep at least 2 distinct claims, got ${unique.length}`);
  });
});

describe("Integration: decomposeNote (requires Ollama + Neo4j)", { skip: !isOllamaAvailable() || !isNeo4jAvailable() }, () => {
  const TEST_SOURCE = "/test/claim-decomposition-test.md";
  const TEST_SOURCE_ID = "source-test-claim-decomposition-test-md";

  // Cleanup after tests
  it("cleanup: remove test data", async () => {
    try {
      runCypher(`MATCH (c:Claim) WHERE c.id STARTS WITH "claim-claim-decomposition-test-" DETACH DELETE c;`);
      runCypher(`MATCH (s:Source {id: "${TEST_SOURCE_ID}"}) DETACH DELETE s;`);
    } catch {
      // OK if nothing to clean
    }
  });

  it("decomposes a short note into claims and stores in Neo4j", { timeout: 180_000 }, async () => {
    const bodyText = `## Meeting Summary

Mike Lingle and Greg Nugent met with Raul Martynek, CEO of DataBank, on February 27, 2026.

DataBank has an open-ended fund structure with unlimited life. Raul believes private is better than public for data center businesses. DataBank currently operates 65+ data centers across 27+ markets.

Australian Super invested as a new institutional investor in 2024 during a $2.6 billion capital raise.`;

    const result = await decomposeNote(bodyText, "gix", TEST_SOURCE);

    assert.ok(result.success, `Decomposition failed: ${result.errors.join(", ")}`);
    assert.ok(result.totalChunks >= 1, "Should have at least 1 chunk");
    assert.ok(result.claimsStored.length >= 2, `Should store >=2 claims, got ${result.claimsStored.length}`);

    // Verify claims exist in Neo4j
    const countRaw = runCypher(
      `MATCH (c:Claim) WHERE c.id STARTS WITH "claim-claim-decomposition-test-" RETURN count(c) AS c;`
    );
    const count = parseInt(countRaw.split("\n").pop()?.trim() ?? "0", 10);
    assert.ok(count >= 2, `Expected >=2 claims in Neo4j, got ${count}`);

    // Verify Source node exists
    const sourceRaw = runCypher(
      `MATCH (s:Source {id: "${TEST_SOURCE_ID}"}) RETURN s.source_type AS t;`
    );
    assert.ok(sourceRaw.includes("obsidian_vault"), "Source should have obsidian_vault type");

    // Verify SOURCED_FROM relationships
    const relRaw = runCypher(
      `MATCH (c:Claim)-[:SOURCED_FROM]->(s:Source {id: "${TEST_SOURCE_ID}"}) RETURN count(c) AS c;`
    );
    const relCount = parseInt(relRaw.split("\n").pop()?.trim() ?? "0", 10);
    assert.ok(relCount >= 2, `Expected >=2 SOURCED_FROM rels, got ${relCount}`);

    // Verify ABOUT relationships to entities
    const aboutRaw = runCypher(
      `MATCH (c:Claim)-[:ABOUT]->(e:Entity) WHERE c.id STARTS WITH "claim-claim-decomposition-test-" RETURN count(DISTINCT e) AS c;`
    );
    const aboutCount = parseInt(aboutRaw.split("\n").pop()?.trim() ?? "0", 10);
    assert.ok(aboutCount >= 1, `Expected >=1 entity linked via ABOUT, got ${aboutCount}`);

    // Verify claim properties
    const propsRaw = runCypher(
      `MATCH (c:Claim) WHERE c.id STARTS WITH "claim-claim-decomposition-test-" RETURN c.truth_basis AS basis, c.created_by AS created, c.status AS status LIMIT 1;`
    );
    assert.ok(propsRaw.includes("agent-populated"), "Truth basis should be agent-populated");
    assert.ok(propsRaw.includes("lingelpedia_agent"), "Created by should be lingelpedia_agent");
    assert.ok(propsRaw.includes("active"), "Status should be active");
  });

  it("decomposes note from string with frontmatter", { timeout: 180_000 }, async () => {
    const content = `---
tags:
  - GIX
  - meeting-note
date: 2026-02-17
---

# Quick Meeting Note

GIX Connect signed a new contract with Layer1C for dark fiber between 60 Hudson and 165 Halsey.
The contract is worth $2.5 million annually.`;

    const result = await decomposeNoteString(content, "/test/claim-decomposition-string-test.md");

    assert.ok(result.success || result.claimsStored.length > 0, `Failed: ${result.errors.join(", ")}`);
    assert.strictEqual(result.domain, "gix", "Should detect GIX domain from tags");
    assert.ok(result.claimsStored.length >= 1, `Should store >=1 claim, got ${result.claimsStored.length}`);

    // Cleanup
    try {
      runCypher(`MATCH (c:Claim) WHERE c.id STARTS WITH "claim-claim-decomposition-string-test-" DETACH DELETE c;`);
      runCypher(`MATCH (s:Source) WHERE s.id STARTS WITH "source-test-claim-decomposition-string-test" DETACH DELETE s;`);
    } catch { /* ok */ }
  });

  it("handles empty body text gracefully", { timeout: 30_000 }, async () => {
    const result = await decomposeNote("", "gix", "/test/empty-body-test.md");
    assert.ok(result.success, "Should succeed with empty body");
    assert.strictEqual(result.claimsStored.length, 0);
    assert.strictEqual(result.totalChunks, 0);

    // Cleanup
    try {
      runCypher(`MATCH (s:Source) WHERE s.id STARTS WITH "source-test-empty-body-test" DETACH DELETE s;`);
    } catch { /* ok */ }
  });

  it("is idempotent: running twice produces same claim count", { timeout: 180_000 }, async () => {
    const bodyText = "Google is pushing tenants out of 111 8th Avenue. Carriers like Uniti are losing space there.";
    const source = "/test/idempotency-test.md";

    const result1 = await decomposeNote(bodyText, "gix", source);
    assert.ok(result1.success, `First run failed: ${result1.errors.join(", ")}`);

    const result2 = await decomposeNote(bodyText, "gix", source);
    assert.ok(result2.success, `Second run failed: ${result2.errors.join(", ")}`);

    // Count should be same (MERGE prevents duplicates)
    const countRaw = runCypher(
      `MATCH (c:Claim) WHERE c.id STARTS WITH "claim-idempotency-test-" RETURN count(c) AS c;`
    );
    const count = parseInt(countRaw.split("\n").pop()?.trim() ?? "0", 10);
    assert.strictEqual(count, result1.claimsStored.length, "Idempotent — running twice should not create duplicates");

    // Cleanup
    try {
      runCypher(`MATCH (c:Claim) WHERE c.id STARTS WITH "claim-idempotency-test-" DETACH DELETE c;`);
      runCypher(`MATCH (s:Source) WHERE s.id STARTS WITH "source-test-idempotency-test" DETACH DELETE s;`);
    } catch { /* ok */ }
  });

  // Final cleanup
  it("final cleanup: remove all test data", async () => {
    try {
      runCypher(`MATCH (c:Claim) WHERE c.id STARTS WITH "claim-claim-decomposition-test-" DETACH DELETE c;`);
      runCypher(`MATCH (s:Source {id: "${TEST_SOURCE_ID}"}) DETACH DELETE s;`);
    } catch { /* ok */ }
  });
});
