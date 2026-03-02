/**
 * Unit tests for the Entity frontmatter-to-Neo4j mapper (US-013).
 *
 * Tests pure functions (ID generation, truth score mapping, wikilink extraction)
 * and the mapper logic with a mock Neo4j backend.
 *
 * Run: npx tsx --test tests/entity-mapper.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import {
  generateEntityId,
  generateSourceId,
  extractWikilinkTarget,
  mapTruthScore,
  escCypher,
  mapEntityToNeo4j,
  mapEntityNoteString,
} from "../src/entity-mapper.js";
import { parseNoteString } from "../src/frontmatter-parser.js";

// ── Helper ───────────────────────────────────────────────────────────────────

function dedent(s: string): string {
  const lines = s.replace(/^\n/, "").split("\n");
  const minIndent = lines
    .filter((l) => l.trim().length > 0)
    .reduce((min, l) => {
      const m = l.match(/^(\s*)/);
      return Math.min(min, m ? m[1].length : 0);
    }, Infinity);
  return lines.map((l) => l.slice(minIndent)).join("\n");
}

// ── generateEntityId ─────────────────────────────────────────────────────────

describe("generateEntityId", () => {
  it("generates ID from file path (filename without extension, slugified)", () => {
    const id = generateEntityId("/vault/Finance/Entities/Tiger93 LLC.md", null);
    assert.strictEqual(id, "tiger93-llc");
  });

  it("generates ID from legal name when no file path", () => {
    const id = generateEntityId(null, "Wasson Enterprise LLC");
    assert.strictEqual(id, "wasson-enterprise-llc");
  });

  it("handles special characters in file path", () => {
    const id = generateEntityId(
      "/vault/Lindsay R. Lingle Declaration of Trust.md",
      null
    );
    assert.strictEqual(id, "lindsay-r-lingle-declaration-of-trust");
  });

  it("prefers file path over legal name", () => {
    const id = generateEntityId("/vault/Note.md", "Different Name");
    assert.strictEqual(id, "note");
  });

  it("handles null both arguments with fallback", () => {
    const id = generateEntityId(null, null);
    assert.ok(id.startsWith("entity-"));
  });
});

// ── generateSourceId ─────────────────────────────────────────────────────────

describe("generateSourceId", () => {
  it("generates Source ID from file path", () => {
    const id = generateSourceId("/vault/Finance/Entities/Tiger93 LLC.md");
    assert.strictEqual(id, "source-vault-finance-entities-tiger93-llc-md");
  });

  it("handles special characters", () => {
    const id = generateSourceId("/path/to/Lindsay R. Lingle Trust.md");
    assert.strictEqual(id, "source-path-to-lindsay-r-lingle-trust-md");
  });
});

// ── extractWikilinkTarget ────────────────────────────────────────────────────

describe("extractWikilinkTarget", () => {
  it("extracts target from [[wikilink]]", () => {
    assert.strictEqual(extractWikilinkTarget("[[Mike Lingle]]"), "Mike Lingle");
  });

  it("extracts target from [[wikilink]] with surrounding text", () => {
    assert.strictEqual(
      extractWikilinkTarget("[[Greg Wasson]] (grantor)"),
      "Greg Wasson"
    );
  });

  it("handles aliased [[wikilink|display]]", () => {
    assert.strictEqual(
      extractWikilinkTarget("[[Harrison Lingle|Harrison]]"),
      "Harrison Lingle"
    );
  });

  it("returns plain string if no wikilink", () => {
    assert.strictEqual(extractWikilinkTarget("Mike Lingle"), "Mike Lingle");
  });

  it("trims whitespace", () => {
    assert.strictEqual(extractWikilinkTarget("  [[ Chase ]]  "), "Chase");
  });
});

// ── mapTruthScore ────────────────────────────────────────────────────────────

describe("mapTruthScore", () => {
  it("maps verified to 0.95", () => {
    assert.strictEqual(mapTruthScore("verified"), 0.95);
  });

  it("maps agent-populated to 0.7", () => {
    assert.strictEqual(mapTruthScore("agent-populated"), 0.7);
  });

  it("maps stale to 0.5", () => {
    assert.strictEqual(mapTruthScore("stale"), 0.5);
  });

  it("maps conflicted to 0.5", () => {
    assert.strictEqual(mapTruthScore("conflicted"), 0.5);
  });

  it("maps unscored to 0.5", () => {
    assert.strictEqual(mapTruthScore("unscored"), 0.5);
  });

  it("maps undefined to 0.5", () => {
    assert.strictEqual(mapTruthScore(undefined), 0.5);
  });

  it("maps null to 0.5", () => {
    assert.strictEqual(mapTruthScore(null), 0.5);
  });
});

// ── escCypher ────────────────────────────────────────────────────────────────

describe("escCypher", () => {
  it("escapes double quotes", () => {
    assert.strictEqual(escCypher('He said "hello"'), 'He said \\"hello\\"');
  });

  it("escapes backslashes", () => {
    assert.strictEqual(escCypher("path\\to\\file"), "path\\\\to\\\\file");
  });

  it("escapes newlines", () => {
    assert.strictEqual(escCypher("line1\nline2"), "line1\\nline2");
  });

  it("handles combined special characters", () => {
    assert.strictEqual(
      escCypher('a "b" \\ c\nd'),
      'a \\"b\\" \\\\ c\\nd'
    );
  });
});

// ── mapEntityNoteString ──────────────────────────────────────────────────────

describe("mapEntityNoteString", () => {
  it("rejects non-entity notes", () => {
    const result = mapEntityNoteString(
      "---\ntype: account\n---\nBody.",
      "/vault/account.md"
    );
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("Not an entity note"));
  });

  it("rejects notes with no frontmatter type", () => {
    const result = mapEntityNoteString(
      "# Just a heading\nBody.",
      "/vault/note.md"
    );
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("Not an entity note"));
  });
});

// ── mapEntityToNeo4j (integration — requires Docker + Neo4j) ─────────────────

/**
 * Check if Neo4j is available for integration tests.
 */
function neo4jAvailable(): boolean {
  try {
    const out = execSync(
      'docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026',
      {
        input: "RETURN 1 AS test;",
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    return out.includes("1");
  } catch {
    return false;
  }
}

const HAS_NEO4J = neo4jAvailable();

describe("mapEntityToNeo4j (integration)", { skip: !HAS_NEO4J }, () => {
  const TEST_PREFIX = "test-us013-";

  // Clean up test data before and after each test
  function cleanTestData(): void {
    try {
      execSync(
        'docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026',
        {
          input: `MATCH (n) WHERE n.id STARTS WITH "${TEST_PREFIX}" DETACH DELETE n;`,
          encoding: "utf-8",
          timeout: 10_000,
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
    } catch {
      // Ignore cleanup errors
    }
  }

  beforeEach(() => {
    cleanTestData();
  });

  afterEach(() => {
    cleanTestData();
  });

  it("creates Entity node with correct properties from a basic entity note", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: entity
        subtype: llc
        legal-name: "${TEST_PREFIX}Test LLC"
        aliases: ["Test Company"]
        status: active
        state: IL
        ein: "12-3456789"
        tax-treatment: pass-through
        purpose: "Test entity for US-013"
        is_canonical: true
        truth_score: verified
        tags:
          - entity
          - entity/llc
          - personal
          - lingelpedia/canonical
        ---

        # Test LLC

        A test entity.
      `),
      `/vault/${TEST_PREFIX}test-llc.md`
    );

    const result = mapEntityToNeo4j(note);
    assert.strictEqual(result.success, true);
    assert.ok(result.entityId.startsWith(TEST_PREFIX));

    // Verify node exists in Neo4j
    const check = execSync(
      'docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026',
      {
        input: `MATCH (e:Entity {id: "${result.entityId}"}) RETURN e.name, e.entity_type, e.truth_score, e.is_canonical, e.ein, e.tax_treatment, e.state;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.ok(check.includes(TEST_PREFIX));
    assert.ok(check.includes("llc"));
    assert.ok(check.includes("0.95"));
    assert.ok(check.toUpperCase().includes("TRUE"));
  });

  it("creates Source node with SOURCED_FROM relationship", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: entity
        subtype: llc
        legal-name: "${TEST_PREFIX}Source Test LLC"
        status: active
        is_canonical: true
        truth_score: unscored
        tags:
          - entity
        ---

        Body text.
      `),
      `/vault/${TEST_PREFIX}source-test.md`
    );

    const result = mapEntityToNeo4j(note);
    assert.strictEqual(result.success, true);
    assert.ok(result.relationshipsCreated.some((r) => r.startsWith("SOURCED_FROM")));

    // Verify Source node and relationship
    const check = execSync(
      'docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026',
      {
        input: `MATCH (e:Entity {id: "${result.entityId}"})-[:SOURCED_FROM]->(s:Source) RETURN s.source_type, s.file_path;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.ok(check.includes("obsidian_vault"));
    assert.ok(check.includes(TEST_PREFIX));
  });

  it("creates BELONGS_TO relationships from owned-by field", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: entity
        subtype: trust-irrevocable
        legal-name: "${TEST_PREFIX}Dynasty Trust"
        status: active
        owned-by:
          - "[[${TEST_PREFIX}Mike Lingle]] (grantor)"
          - "[[${TEST_PREFIX}Kim Wasson]] (grantor)"
        is_canonical: true
        truth_score: unscored
        tags:
          - entity
        ---

        Body text.
      `),
      `/vault/${TEST_PREFIX}dynasty-trust.md`
    );

    const result = mapEntityToNeo4j(note);
    assert.strictEqual(result.success, true);
    const belongsToRels = result.relationshipsCreated.filter((r) =>
      r.startsWith("BELONGS_TO")
    );
    assert.strictEqual(belongsToRels.length, 2);

    // Verify BELONGS_TO relationships exist
    const check = execSync(
      'docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026',
      {
        input: `MATCH (child:Entity {id: "${result.entityId}"})-[:BELONGS_TO]->(parent) RETURN parent.name ORDER BY parent.name;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.ok(check.includes(`${TEST_PREFIX}Kim Wasson`));
    assert.ok(check.includes(`${TEST_PREFIX}Mike Lingle`));
  });

  it("creates RELATED_TO edges for wikilinks (excluding owned-by targets)", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: entity
        subtype: llc
        legal-name: "${TEST_PREFIX}Related Test LLC"
        status: active
        owned-by:
          - "[[${TEST_PREFIX}Owner Entity]]"
        cpa: "[[${TEST_PREFIX}Plante Moran]]"
        is_canonical: true
        truth_score: unscored
        tags:
          - entity
        ---

        Managed by [[${TEST_PREFIX}Schiff Hardin]].
      `),
      `/vault/${TEST_PREFIX}related-test.md`
    );

    const result = mapEntityToNeo4j(note);
    assert.strictEqual(result.success, true);

    // Should have BELONGS_TO for owner, RELATED_TO for CPA and attorney
    assert.ok(result.relationshipsCreated.some((r) => r.includes("BELONGS_TO")));
    assert.ok(
      result.relationshipsCreated.some(
        (r) => r.includes("RELATED_TO") && r.includes("Plante Moran")
      )
    );
    assert.ok(
      result.relationshipsCreated.some(
        (r) => r.includes("RELATED_TO") && r.includes("Schiff Hardin")
      )
    );
    // Owner should NOT have a RELATED_TO edge (only BELONGS_TO)
    assert.ok(
      !result.relationshipsCreated.some(
        (r) => r.includes("RELATED_TO") && r.includes("Owner Entity")
      )
    );
  });

  it("creates OpenQuestion node for conflicted truth score", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: entity
        subtype: llc
        legal-name: "${TEST_PREFIX}Conflicted LLC"
        status: active
        is_canonical: true
        truth_score: conflicted
        tags:
          - entity
        ---

        Body text.
      `),
      `/vault/${TEST_PREFIX}conflicted.md`
    );

    const result = mapEntityToNeo4j(note);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.openQuestionCreated, true);

    // Verify OpenQuestion node exists
    const check = execSync(
      'docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026',
      {
        input: `MATCH (e:Entity {id: "${result.entityId}"})-[:MENTIONS]->(oq:OpenQuestion) RETURN oq.status, oq.question;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.ok(check.includes("open"));
    assert.ok(check.includes("Conflicted truth score"));
  });

  it("flags stale truth score for re-verification", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: entity
        subtype: llc
        legal-name: "${TEST_PREFIX}Stale LLC"
        status: active
        is_canonical: true
        truth_score: stale
        tags:
          - entity
        ---

        Body text.
      `),
      `/vault/${TEST_PREFIX}stale.md`
    );

    const result = mapEntityToNeo4j(note);
    assert.strictEqual(result.success, true);

    // Verify stale flag
    const check = execSync(
      'docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026',
      {
        input: `MATCH (e:Entity {id: "${result.entityId}"}) RETURN e.needs_reverification;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.ok(check.toUpperCase().includes("TRUE"));
  });

  it("is idempotent — running twice produces the same graph", () => {
    const noteContent = dedent(`
      ---
      type: entity
      subtype: llc
      legal-name: "${TEST_PREFIX}Idempotent LLC"
      status: active
      owned-by:
        - "[[${TEST_PREFIX}Some Owner]]"
      is_canonical: true
      truth_score: verified
      tags:
        - entity
      ---

      Linked to [[${TEST_PREFIX}Some Partner]].
    `);
    const filePath = `/vault/${TEST_PREFIX}idempotent.md`;

    const note1 = parseNoteString(noteContent, filePath);
    const result1 = mapEntityToNeo4j(note1);
    assert.strictEqual(result1.success, true);

    const note2 = parseNoteString(noteContent, filePath);
    const result2 = mapEntityToNeo4j(note2);
    assert.strictEqual(result2.success, true);

    // IDs should be identical
    assert.strictEqual(result1.entityId, result2.entityId);
    assert.strictEqual(result1.sourceId, result2.sourceId);

    // Count nodes — should not have duplicates
    const countCheck = execSync(
      'docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026',
      {
        input: `MATCH (e:Entity {id: "${result1.entityId}"}) RETURN count(e) AS cnt;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    // Should contain exactly "1" (not "2")
    const lines = countCheck.split("\n").filter((l) => l.trim() && !l.startsWith("cnt"));
    assert.ok(lines.some((l) => l.trim() === "1"));
  });

  it("handles entity with trust-specific fields", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: entity
        subtype: trust-irrevocable
        legal-name: "${TEST_PREFIX}Dynasty Trust"
        status: active
        trust-date: 2022-03-08
        trust-state: IL
        irrevocable-type: dynasty
        distribution-rules: "Remainder to descendants at age 30."
        is_canonical: true
        truth_score: unscored
        tags:
          - entity
          - entity/trust-irrevocable
        ---

        Body text.
      `),
      `/vault/${TEST_PREFIX}trust-fields.md`
    );

    const result = mapEntityToNeo4j(note);
    assert.strictEqual(result.success, true);

    const check = execSync(
      'docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026',
      {
        input: `MATCH (e:Entity {id: "${result.entityId}"}) RETURN e.trust_state, e.irrevocable_type, e.distribution_rules;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.ok(check.includes("IL"));
    assert.ok(check.includes("dynasty"));
    assert.ok(check.includes("Remainder to descendants"));
  });

  it("handles parent-entity field creating BELONGS_TO", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: entity
        subtype: llc
        legal-name: "${TEST_PREFIX}Child LLC"
        status: active
        parent-entity: "[[${TEST_PREFIX}Parent Corp]]"
        is_canonical: true
        truth_score: unscored
        tags:
          - entity
        ---

        Body text.
      `),
      `/vault/${TEST_PREFIX}child-llc.md`
    );

    const result = mapEntityToNeo4j(note);
    assert.strictEqual(result.success, true);
    assert.ok(
      result.relationshipsCreated.some(
        (r) => r.includes("BELONGS_TO") && r.includes("Parent Corp")
      )
    );
  });
});
