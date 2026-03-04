import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Neo4jConnection } from "./neo4j.js";
import { applySchema, verifySchema } from "./schema.js";
import { TelemetryEmitter } from "../telemetry/emitter.js";

/**
 * Neo4j integration tests — requires Neo4j running at bolt://localhost:7687
 *
 * These tests verify:
 * 1. Connection and health check
 * 2. Schema application (constraints + indexes)
 * 3. Schema idempotency (apply twice without errors)
 * 4. Telemetry emission during operations
 */

let connection: Neo4jConnection;
let emitter: TelemetryEmitter;
let tempDir: string;

const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "testpassword";

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "vega-knowledge-test-"));
  emitter = new TelemetryEmitter(tempDir);
  connection = new Neo4jConnection(
    { password: NEO4J_PASSWORD },
    emitter,
  );
});

afterAll(async () => {
  if (connection) await connection.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("Neo4jConnection", () => {
  it("throws if NEO4J_PASSWORD is not provided", () => {
    const origPassword = process.env.NEO4J_PASSWORD;
    delete process.env.NEO4J_PASSWORD;
    try {
      expect(() => new Neo4jConnection({ password: undefined as unknown as string })).toThrow(
        "NEO4J_PASSWORD is required",
      );
    } finally {
      if (origPassword) process.env.NEO4J_PASSWORD = origPassword;
    }
  });

  it("uses default URI and user when not specified", () => {
    const conn = new Neo4jConnection({ password: "test" });
    expect(conn).toBeDefined();
    // Don't try to connect — just verify it created without errors
    conn.close();
  });

  it("health check returns valid response", async () => {
    const health = await connection.healthCheck();
    expect(health.connected).toBe(true);
    expect(health.version).toBeTruthy();
    expect(typeof health.version).toBe("string");
    expect(typeof health.nodeCount).toBe("number");
    expect(health.nodeCount).toBeGreaterThanOrEqual(0);
  });

  it("health check emits telemetry", async () => {
    await connection.healthCheck();
    const events = await emitter.readEvents(new Date());
    const healthEvents = events.filter(
      (e) => e.event_subtype === "neo4j_health_check",
    );
    expect(healthEvents.length).toBeGreaterThanOrEqual(1);
    expect(healthEvents[0].event_type).toBe("knowledge_query");
    expect(healthEvents[0].outcome).toBe("success");
  });
});

describe("Schema Application", () => {
  it("applies schema — creates all constraints and indexes", async () => {
    const result = await applySchema(connection, emitter);
    expect(result.errors).toEqual([]);
    expect(result.constraintsCreated).toBe(5);
    // 1 vector + 1 fulltext + 8 lookup = 10
    expect(result.indexesCreated).toBe(10);
  });

  it("schema is idempotent — applying twice produces no errors", async () => {
    const result = await applySchema(connection, emitter);
    expect(result.errors).toEqual([]);
    expect(result.constraintsCreated).toBe(5);
    expect(result.indexesCreated).toBe(10);
  });

  it("verify schema confirms all expected constraints and indexes", async () => {
    const verification = await verifySchema(connection);

    // Check all 5 uniqueness constraints exist
    expect(verification.constraints).toContain("claim_id_unique");
    expect(verification.constraints).toContain("entity_id_unique");
    expect(verification.constraints).toContain("source_id_unique");
    expect(verification.constraints).toContain("open_question_id_unique");
    expect(verification.constraints).toContain("bet_id_unique");

    // Check vector index
    expect(verification.indexes).toContain("claim_embeddings");

    // Check full-text index
    expect(verification.indexes).toContain("claim_content");

    // Check 8 lookup indexes
    expect(verification.indexes).toContain("claim_domain");
    expect(verification.indexes).toContain("claim_status");
    expect(verification.indexes).toContain("claim_truth_tier");
    expect(verification.indexes).toContain("entity_type");
    expect(verification.indexes).toContain("bet_type");
    expect(verification.indexes).toContain("bet_status");
    expect(verification.indexes).toContain("open_question_status");
    expect(verification.indexes).toContain("source_account");

    // Nothing missing
    expect(verification.missing).toEqual([]);
  });

  it("schema application emits telemetry", async () => {
    const events = await emitter.readEvents(new Date());
    const schemaEvents = events.filter(
      (e) => e.event_subtype === "schema_application",
    );
    expect(schemaEvents.length).toBeGreaterThanOrEqual(1);
    expect(schemaEvents[0].event_type).toBe("knowledge_write");
  });
});
