import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initNeo4j, initVaultConnector } from "./cli.js";
import type { Neo4jConnection } from "./neo4j.js";

/**
 * CLI wiring tests — verifies real Neo4j driver and VaultConnector integration.
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

describe("initVaultConnector (CLI wiring)", () => {
  let tempDir: string;

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a VaultConnector with valid vault path", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "vault-test-"));
    const connector = await initVaultConnector(tempDir);
    expect(connector).not.toBeNull();
    expect(connector!.getVaultPath()).toBe(tempDir);
  });

  it("returns null with nonexistent path", async () => {
    const connector = await initVaultConnector("/nonexistent/path/to/vault-99999");
    expect(connector).toBeNull();
  });
});
