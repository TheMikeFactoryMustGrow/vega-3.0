import { describe, it, expect, afterAll } from "vitest";
import { initNeo4j } from "./cli.js";
import type { Neo4jConnection } from "./neo4j.js";

/**
 * CLI initNeo4j wiring tests — verifies real Neo4j driver integration.
 *
 * Requires Neo4j running at bolt://localhost:7687.
 */

const NEO4J_URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "testpassword";

const connections: Neo4jConnection[] = [];

afterAll(async () => {
  for (const conn of connections) {
    await conn.close();
  }
});

describe("initNeo4j (CLI wiring)", () => {
  it("returns a Neo4jConnection with valid credentials", async () => {
    const conn = await initNeo4j(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
    expect(conn).not.toBeNull();
    if (conn) {
      connections.push(conn);
      const health = await conn.healthCheck();
      expect(health.connected).toBe(true);
      expect(health.version).toBeTruthy();
    }
  });

  it("returns null with invalid credentials", async () => {
    const conn = await initNeo4j(NEO4J_URI, NEO4J_USER, "wrong-password-12345");
    expect(conn).toBeNull();
  });

  it("returns null with unreachable URI", async () => {
    const conn = await initNeo4j("bolt://localhost:19999", NEO4J_USER, NEO4J_PASSWORD);
    expect(conn).toBeNull();
  });
});
