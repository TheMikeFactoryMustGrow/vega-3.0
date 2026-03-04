import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Neo4jConnection } from "../neo4j.js";
import { applySchema } from "../schema.js";
import { EmbeddingPipeline } from "../embedding.js";
import { TelemetryEmitter } from "../../telemetry/emitter.js";
import { EntityMapper, extractClaimsFromBody } from "./entity-mapper.js";
import { PersonMapper } from "./person-mapper.js";
import type { EntityTemplate, PersonTemplate } from "./parser.js";

/**
 * EntityMapper + PersonMapper tests — requires Neo4j running at bolt://localhost:7687
 *
 * Tests migration of Entity and Person Obsidian notes into Neo4j nodes
 * with claims, sources, and relationships.
 */

// Mock OpenAI client for embedding pipeline
const mockEmbeddingsCreate = vi.fn();
vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      embeddings = { create: mockEmbeddingsCreate };
      constructor() {}
    },
  };
});

let connection: Neo4jConnection;
let emitter: TelemetryEmitter;
let pipeline: EmbeddingPipeline;
let tempDir: string;

const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "testpassword";

function makeFakeEmbedding(dim: number = 1536): number[] {
  return Array.from({ length: dim }, (_, i) => Math.sin(i * 0.01));
}

function setupEmbeddingMock() {
  mockEmbeddingsCreate.mockImplementation(async () => ({
    data: [{ embedding: makeFakeEmbedding(), index: 0 }],
    usage: { total_tokens: 10 },
  }));
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "vega-mapper-test-"));
  emitter = new TelemetryEmitter(tempDir);
  connection = new Neo4jConnection({ password: NEO4J_PASSWORD }, emitter);
  await applySchema(connection, emitter);

  pipeline = new EmbeddingPipeline(connection, {
    apiKey: "test-key",
    emitter,
  });
});

afterAll(async () => {
  // Clean up all test nodes
  const session = connection.session();
  try {
    await session.run(
      `MATCH (n) WHERE n.domain = 'test_migration' DETACH DELETE n`,
    );
  } finally {
    await session.close();
  }
  if (connection) await connection.close();
  await rm(tempDir, { recursive: true, force: true });
});

// ── extractClaimsFromBody unit tests ────────────────────────────────

describe("extractClaimsFromBody", () => {
  it("extracts paragraphs as separate claims", () => {
    const body = "First paragraph about the entity.\n\nSecond paragraph with more details.";
    const claims = extractClaimsFromBody(body);
    expect(claims).toEqual([
      "First paragraph about the entity.",
      "Second paragraph with more details.",
    ]);
  });

  it("extracts bullet points as individual claims", () => {
    const body = "- First bullet point\n- Second bullet point\n- Third bullet point";
    const claims = extractClaimsFromBody(body);
    expect(claims).toEqual([
      "First bullet point",
      "Second bullet point",
      "Third bullet point",
    ]);
  });

  it("handles mixed paragraphs and bullets", () => {
    const body = "Overview paragraph.\n\n- Detail one\n- Detail two\n\nAnother paragraph.";
    const claims = extractClaimsFromBody(body);
    expect(claims).toEqual([
      "Overview paragraph.",
      "Detail one",
      "Detail two",
      "Another paragraph.",
    ]);
  });

  it("handles numbered lists", () => {
    const body = "1. First item\n2. Second item\n3. Third item";
    const claims = extractClaimsFromBody(body);
    expect(claims).toEqual(["First item", "Second item", "Third item"]);
  });

  it("skips headings", () => {
    const body = "# Heading\n\nParagraph content.\n\n## Subheading\n\nMore content.";
    const claims = extractClaimsFromBody(body);
    expect(claims).toEqual(["Paragraph content.", "More content."]);
  });

  it("returns empty array for empty body", () => {
    expect(extractClaimsFromBody("")).toEqual([]);
    expect(extractClaimsFromBody("  \n\n  ")).toEqual([]);
  });

  it("joins multi-line paragraphs", () => {
    const body = "This is a long paragraph\nthat spans multiple lines\nbut is one claim.";
    const claims = extractClaimsFromBody(body);
    expect(claims).toEqual([
      "This is a long paragraph that spans multiple lines but is one claim.",
    ]);
  });

  it("handles asterisk and plus bullets", () => {
    const body = "* Asterisk bullet\n+ Plus bullet";
    const claims = extractClaimsFromBody(body);
    expect(claims).toEqual(["Asterisk bullet", "Plus bullet"]);
  });
});

// ── EntityMapper integration tests ──────────────────────────────────

describe("EntityMapper", () => {
  it("migrates an Entity note — creates Entity, Source, and Claim nodes", async () => {
    setupEmbeddingMock();

    const mapper = new EntityMapper({
      connection,
      embedding: pipeline,
      emitter,
    });

    const frontmatter: EntityTemplate = {
      type: "entity",
      name: "Test Corp",
      entity_type: "organization",
      domain: "test_migration",
      aliases: ["TC", "TestCorp"],
      description: "A test corporation",
    };

    const body = "Test Corp was founded in 2020.\n\n- Revenue grew 20% year over year\n- Headquartered in New York";

    const stats = await mapper.migrate(frontmatter, body, "Finance/Entities/Test Corp.md");

    expect(stats.entities_created).toBe(1);
    expect(stats.entities_updated).toBe(0);
    expect(stats.claims_created).toBe(3);
    expect(stats.embeddings_generated).toBe(3);
    expect(stats.errors).toEqual([]);

    // Verify Entity node exists in Neo4j
    const session = connection.session();
    try {
      const entityResult = await session.run(
        `MATCH (e:Entity {name: 'Test Corp', entity_type: 'organization'})
         RETURN e.domain AS domain, e.aliases AS aliases, e.description AS desc`,
      );
      expect(entityResult.records).toHaveLength(1);
      expect(entityResult.records[0].get("domain")).toBe("test_migration");
      expect(entityResult.records[0].get("aliases")).toEqual(["TC", "TestCorp"]);
      expect(entityResult.records[0].get("desc")).toBe("A test corporation");

      // Verify Claim nodes exist with ABOUT relationship
      const claimResult = await session.run(
        `MATCH (c:Claim)-[:ABOUT]->(e:Entity {name: 'Test Corp'})
         RETURN c.content AS content, c.truth_tier AS tier, c.domain AS domain
         ORDER BY c.content`,
      );
      expect(claimResult.records).toHaveLength(3);
      expect(claimResult.records[0].get("tier")).toBe("single_source");
      expect(claimResult.records[0].get("domain")).toBe("test_migration");

      // Verify Source node exists with SOURCED_FROM relationship
      const sourceResult = await session.run(
        `MATCH (c:Claim)-[:SOURCED_FROM]->(s:Source)
         WHERE c.domain = 'test_migration'
         RETURN DISTINCT s.source_type AS stype, s.source_account AS sacct`,
      );
      expect(sourceResult.records).toHaveLength(1);
      expect(sourceResult.records[0].get("stype")).toBe("obsidian_note");
      expect(sourceResult.records[0].get("sacct")).toBe("obsidian_vault");
    } finally {
      await session.close();
    }
  });

  it("MERGE is idempotent — migrating same note twice does not create duplicates", async () => {
    setupEmbeddingMock();

    const mapper = new EntityMapper({
      connection,
      embedding: pipeline,
      emitter,
    });

    const frontmatter: EntityTemplate = {
      type: "entity",
      name: "Idempotent Corp",
      entity_type: "organization",
      domain: "test_migration",
    };

    const body = "Single claim about idempotency.";

    // Migrate twice
    const stats1 = await mapper.migrate(frontmatter, body, "test/Idempotent.md");
    expect(stats1.entities_created).toBe(1);

    const stats2 = await mapper.migrate(frontmatter, body, "test/Idempotent.md");
    expect(stats2.entities_updated).toBe(1);
    expect(stats2.entities_created).toBe(0);

    // Verify only one Entity node exists
    const session = connection.session();
    try {
      const result = await session.run(
        `MATCH (e:Entity {name: 'Idempotent Corp', entity_type: 'organization'})
         RETURN count(e) AS cnt`,
      );
      const cnt = result.records[0].get("cnt");
      expect(typeof cnt === "object" && cnt?.toNumber ? cnt.toNumber() : Number(cnt)).toBe(1);
    } finally {
      await session.close();
    }
  });

  it("migrates entity with no body — zero claims created", async () => {
    const mapper = new EntityMapper({ connection, emitter });

    const frontmatter: EntityTemplate = {
      type: "entity",
      name: "Empty Body Corp",
      entity_type: "organization",
      domain: "test_migration",
    };

    const stats = await mapper.migrate(frontmatter, "", "test/EmptyBody.md");
    expect(stats.entities_created).toBe(1);
    expect(stats.claims_created).toBe(0);
    expect(stats.errors).toEqual([]);
  });

  it("works without embedding pipeline", async () => {
    const mapper = new EntityMapper({ connection, emitter });

    const frontmatter: EntityTemplate = {
      type: "entity",
      name: "No Embed Corp",
      entity_type: "concept",
      domain: "test_migration",
      description: "Test entity without embeddings",
    };

    const body = "A claim without an embedding.";

    const stats = await mapper.migrate(frontmatter, body, "test/NoEmbed.md");
    expect(stats.claims_created).toBe(1);
    expect(stats.embeddings_generated).toBe(0);
    expect(stats.errors).toEqual([]);
  });
});

// ── PersonMapper integration tests ──────────────────────────────────

describe("PersonMapper", () => {
  it("migrates a Person note with birthday and person-specific properties", async () => {
    setupEmbeddingMock();

    const mapper = new PersonMapper({
      connection,
      embedding: pipeline,
      emitter,
    });

    const frontmatter: PersonTemplate = {
      type: "person",
      name: "Jane Doe",
      relationship: "colleague",
      domain: "test_migration",
      birthday: "1990-05-15",
      contact_info: "jane@example.com",
      notes: "Met at conference",
    };

    const body = "Jane is a software engineer.\n\n- Expert in distributed systems\n- Previously at Google";

    const stats = await mapper.migrate(frontmatter, body, "People/Jane Doe.md");

    expect(stats.entities_created).toBe(1);
    expect(stats.claims_created).toBe(3);
    expect(stats.embeddings_generated).toBe(3);
    expect(stats.errors).toEqual([]);

    // Verify Entity node with person-specific properties
    const session = connection.session();
    try {
      const result = await session.run(
        `MATCH (e:Entity {name: 'Jane Doe', entity_type: 'person'})
         RETURN e.birthday AS birthday, e.relationship AS rel, e.contact_info AS contact, e.domain AS domain`,
      );
      expect(result.records).toHaveLength(1);
      expect(result.records[0].get("birthday")).toBe("1990-05-15");
      expect(result.records[0].get("rel")).toBe("colleague");
      expect(result.records[0].get("contact")).toBe("jane@example.com");
      expect(result.records[0].get("domain")).toBe("test_migration");

      // Verify claims linked to the person entity
      const claimResult = await session.run(
        `MATCH (c:Claim)-[:ABOUT]->(e:Entity {name: 'Jane Doe', entity_type: 'person'})
         RETURN count(c) AS cnt`,
      );
      const cnt = claimResult.records[0].get("cnt");
      expect(typeof cnt === "object" && cnt?.toNumber ? cnt.toNumber() : Number(cnt)).toBe(3);
    } finally {
      await session.close();
    }
  });

  it("MERGE is idempotent for Person notes", async () => {
    setupEmbeddingMock();

    const mapper = new PersonMapper({
      connection,
      embedding: pipeline,
      emitter,
    });

    const frontmatter: PersonTemplate = {
      type: "person",
      name: "John Idempotent",
      relationship: "friend",
      domain: "test_migration",
    };

    const body = "Known John for years.";

    const stats1 = await mapper.migrate(frontmatter, body, "People/John.md");
    expect(stats1.entities_created).toBe(1);

    const stats2 = await mapper.migrate(frontmatter, body, "People/John.md");
    expect(stats2.entities_updated).toBe(1);
    expect(stats2.entities_created).toBe(0);

    // Verify only one Entity node
    const session = connection.session();
    try {
      const result = await session.run(
        `MATCH (e:Entity {name: 'John Idempotent', entity_type: 'person'})
         RETURN count(e) AS cnt`,
      );
      const cnt = result.records[0].get("cnt");
      expect(typeof cnt === "object" && cnt?.toNumber ? cnt.toNumber() : Number(cnt)).toBe(1);
    } finally {
      await session.close();
    }
  });

  it("handles Person without optional fields", async () => {
    const mapper = new PersonMapper({ connection, emitter });

    const frontmatter: PersonTemplate = {
      type: "person",
      name: "Minimal Person",
      relationship: "acquaintance",
      domain: "test_migration",
    };

    const stats = await mapper.migrate(frontmatter, "", "People/Minimal.md");
    expect(stats.entities_created).toBe(1);
    expect(stats.claims_created).toBe(0);
    expect(stats.errors).toEqual([]);

    // Verify null optional fields
    const session = connection.session();
    try {
      const result = await session.run(
        `MATCH (e:Entity {name: 'Minimal Person', entity_type: 'person'})
         RETURN e.birthday AS birthday, e.contact_info AS contact`,
      );
      expect(result.records).toHaveLength(1);
      expect(result.records[0].get("birthday")).toBeNull();
      expect(result.records[0].get("contact")).toBeNull();
    } finally {
      await session.close();
    }
  });

  it("emits telemetry for person migration", async () => {
    setupEmbeddingMock();

    const testEmitter = new TelemetryEmitter(tempDir);
    const emitSpy = vi.spyOn(testEmitter, "emit");

    const mapper = new PersonMapper({
      connection,
      embedding: pipeline,
      emitter: testEmitter,
    });

    const frontmatter: PersonTemplate = {
      type: "person",
      name: "Telemetry Person",
      relationship: "mentor",
      domain: "test_migration",
    };

    await mapper.migrate(frontmatter, "A fact about this person.", "People/Telemetry.md");

    const migrationEvents = emitSpy.mock.calls.filter(
      (call) => call[0].event_subtype === "person_migration",
    );
    expect(migrationEvents.length).toBeGreaterThanOrEqual(1);
    expect(migrationEvents[0][0].outcome).toBe("success");
  });
});
