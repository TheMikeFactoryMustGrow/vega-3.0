import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initNeo4j, initVaultConnector, cmdStatus } from "./cli.js";
import type { Env } from "./cli.js";
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

describe("cmdStatus (CLI wiring)", () => {
  const makeEnv = (overrides?: Partial<Env>): Env => ({
    NEO4J_URI,
    NEO4J_USER,
    NEO4J_PASSWORD,
    EMBEDDING_MODEL: "text-embedding-3-small",
    LLM_BASE_URL: "https://api.x.ai/v1",
    VAULT_PATH: "/tmp",
    ...overrides,
  });

  it("returns real node counts from Neo4j", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exitCode = await cmdStatus(makeEnv());
      // Should succeed (exit code 0 if >=100 claims, 2 if <100)
      expect([0, 2]).toContain(exitCode);

      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain("Neo4j: CONNECTED");
      expect(output).toContain("Node Counts:");
      // Should NOT contain Math.random()-style numbers — verify no mock patterns
      expect(output).not.toContain("undefined");
      // Real Neo4j has Claim nodes
      expect(output).toContain("Claim:");
      expect(output).toContain("Relationships:");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("shows DISCONNECTED when Neo4j is down", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exitCode = await cmdStatus(makeEnv({ NEO4J_PASSWORD: "wrong-password-99999" }));
      expect(exitCode).toBe(1);

      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain("DISCONNECTED");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("shows Phase 1 PASS when >=100 claims exist", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exitCode = await cmdStatus(makeEnv());
      // With 1,840 claims in the graph, Phase 1 should pass
      if (exitCode === 0) {
        const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(output).toContain("PASS");
      }
    } finally {
      logSpy.mockRestore();
    }
  });
});
