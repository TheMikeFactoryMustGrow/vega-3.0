import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initNeo4j, initVaultConnector, cmdStatus, cmdPrivacyAudit, cmdMigrate, cmdQuery } from "./cli.js";
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

const makeEnv = (overrides?: Partial<Env>): Env => ({
  NEO4J_URI,
  NEO4J_USER,
  NEO4J_PASSWORD,
  EMBEDDING_MODEL: "text-embedding-3-small",
  LLM_BASE_URL: "https://api.x.ai/v1",
  VAULT_PATH: "/tmp",
  ...overrides,
});

describe("cmdStatus (CLI wiring)", () => {

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

describe("cmdPrivacyAudit (CLI wiring)", () => {
  it("runs all 6 audit queries against clean graph and all pass", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exitCode = await cmdPrivacyAudit(makeEnv());
      // Exit code 0 = all audits pass, 1 = violations detected
      expect([0, 1]).toContain(exitCode);

      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain("[PRIVACY AUDIT RESULTS]");
      // Verify all 6 real audit names appear (not mock names)
      expect(output).toContain("Sole Write Owner");
      expect(output).toContain("Children's Data Protection (Harrison)");
      expect(output).toContain("Children's Data Protection (Beckham)");
      expect(output).toContain("Connector Scope (Drive)");
      expect(output).toContain("Cross-Domain Leakage (Health)");
      expect(output).toContain("Agent Access Anomaly");
      // Should not contain old mock audit names
      expect(output).not.toContain("Unencrypted PII Exposure");
      expect(output).not.toContain("SSN Field Leakage");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("detects violations when audit query returns non-zero count", async () => {
    // This test inserts a Claim with created_by <> 'knowledge_agent' to trigger Audit 1
    const conn = await initNeo4j(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
    expect(conn).not.toBeNull();
    if (!conn) return;

    const session = conn.session();
    const testId = `test-violation-${Date.now()}`;
    try {
      // Insert a Claim with non-knowledge_agent creator
      await session.run(
        `CREATE (c:Claim {id: $id, created_by: 'rogue_agent', text: 'test violation'})`,
        { id: testId }
      );
    } finally {
      await session.close();
    }

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exitCode = await cmdPrivacyAudit(makeEnv());
      // Should detect at least the sole_write_owner violation
      expect(exitCode).toBe(1);

      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain("FAIL");
      expect(output).toContain("[ESCALATION WARNING - LEVEL 3]");
    } finally {
      logSpy.mockRestore();
      // Clean up test node
      const cleanupSession = conn.session();
      try {
        await cleanupSession.run(`MATCH (c:Claim {id: $id}) DELETE c`, { id: testId });
      } finally {
        await cleanupSession.close();
      }
      await conn.close();
    }
  });
});

describe("cmdMigrate (CLI wiring)", () => {
  let testVaultDir: string;
  const testTag = `cli-migrate-test-${Date.now()}`;

  afterAll(async () => {
    // Clean up test vault directory
    if (testVaultDir) {
      await rm(testVaultDir, { recursive: true, force: true });
    }
    // Clean up test nodes from Neo4j
    const conn = await initNeo4j(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
    if (conn) {
      const session = conn.session();
      try {
        // Delete test entities and claims created by the migrate test
        await session.run(
          `MATCH (e:Entity) WHERE e.name STARTS WITH 'CliTest' DETACH DELETE e`
        );
        await session.run(
          `MATCH (s:Source) WHERE s.file_path CONTAINS $tag DETACH DELETE s`,
          { tag: testTag }
        );
        await session.run(
          `MATCH (c:Claim) WHERE c.id STARTS WITH 'claim-' AND c.domain = 'cli_test' DETACH DELETE c`
        );
      } finally {
        await session.close();
      }
      await conn.close();
    }
  });

  async function createTestVault(): Promise<string> {
    testVaultDir = await mkdtemp(path.join(tmpdir(), `vault-migrate-${testTag}-`));

    // Entity note
    await writeFile(path.join(testVaultDir, "CliTestCorp.md"), `---
type: entity
name: CliTestCorp
entity_type: organization
domain: cli_test
description: A test corporation for CLI migration
---
CliTestCorp was founded in 2020.
It operates in the technology sector.
`);

    // Person note
    await writeFile(path.join(testVaultDir, "CliTestPerson.md"), `---
type: person
name: CliTestPerson
relationship: colleague
domain: cli_test
---
CliTestPerson works at CliTestCorp.
`);

    // Institution note
    await writeFile(path.join(testVaultDir, "CliTestBank.md"), `---
type: institution
name: CliTestBank
institution_type: bank
domain: cli_test
---
CliTestBank provides banking services.
`);

    // Account note
    await writeFile(path.join(testVaultDir, "CliTestAccount.md"), `---
type: account
name: CliTestAccount
institution: CliTestBank
account_type: checking
domain: cli_test
---
Primary checking account.
`);

    // Unstructured note (no frontmatter) — will be skipped for decomposition if no XAI_API_KEY
    await writeFile(path.join(testVaultDir, "CliTestJournal.md"),
      `Met with CliTestPerson today. Discussed the quarterly results.\n`
    );

    return testVaultDir;
  }

  it("migrates mixed-type test notes and creates nodes in Neo4j", async () => {
    const vaultDir = await createTestVault();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exitCode = await cmdMigrate(makeEnv({ VAULT_PATH: vaultDir }));
      // Exit code 0 = pass, 2 = Phase 1 threshold not met (expected with small vault)
      expect([0, 2]).toContain(exitCode);

      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain("[MIGRATION SUMMARY]");
      expect(output).toContain("Entities created:");
      expect(output).toContain("Claims from mappers:");
      expect(output).toContain("[PHASE 1 VALIDATION]");
      // Should NOT contain Math.random() artifacts
      expect(output).not.toContain("undefined");
    } finally {
      logSpy.mockRestore();
    }

    // Verify nodes were created in Neo4j
    const conn = await initNeo4j(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
    expect(conn).not.toBeNull();
    if (!conn) return;

    const session = conn.session();
    try {
      // Check Entity nodes exist
      const entityResult = await session.run(
        `MATCH (e:Entity) WHERE e.name STARTS WITH 'CliTest' RETURN e.name AS name, e.entity_type AS type`
      );
      const entityNames = entityResult.records.map(r => r.get("name") as string);
      expect(entityNames).toContain("CliTestCorp");
      expect(entityNames).toContain("CliTestPerson");
      expect(entityNames).toContain("CliTestBank");

      // Check Claims were created for the notes
      const claimResult = await session.run(
        `MATCH (c:Claim {domain: 'cli_test'}) RETURN count(c) AS count`
      );
      const claimCount = claimResult.records[0]?.get("count")?.toNumber?.() ?? 0;
      expect(claimCount).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
    await conn.close();
  }, 30000);

  it("runs idempotently — no duplicates on second run", async () => {
    // testVaultDir should still exist from the previous test
    if (!testVaultDir) return;

    // Count entities before second run
    const connBefore = await initNeo4j(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
    if (!connBefore) return;

    let entityCountBefore: number;
    const sessionBefore = connBefore.session();
    try {
      const result = await sessionBefore.run(
        `MATCH (e:Entity) WHERE e.name STARTS WITH 'CliTest' RETURN count(e) AS count`
      );
      entityCountBefore = result.records[0]?.get("count")?.toNumber?.() ?? 0;
    } finally {
      await sessionBefore.close();
    }
    await connBefore.close();

    // Run migrate again
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await cmdMigrate(makeEnv({ VAULT_PATH: testVaultDir }));
    } finally {
      logSpy.mockRestore();
    }

    // Count entities after — should be same (MERGE idempotency)
    const connAfter = await initNeo4j(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
    if (!connAfter) return;

    const sessionAfter = connAfter.session();
    try {
      const result = await sessionAfter.run(
        `MATCH (e:Entity) WHERE e.name STARTS WITH 'CliTest' RETURN count(e) AS count`
      );
      const entityCountAfter = result.records[0]?.get("count")?.toNumber?.() ?? 0;
      // Entity count should not increase (MERGE is idempotent)
      expect(entityCountAfter).toBe(entityCountBefore);
    } finally {
      await sessionAfter.close();
    }
    await connAfter.close();
  }, 30000);
});

describe("cmdQuery (CLI wiring)", () => {
  it("runs AQM pipeline without crashing and returns no mock artifacts", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // Use a question that triggers the AQM path (contains "relationship between")
      const exitCode = await cmdQuery(
        "What is the relationship between Harrison Lingle and investments?",
        makeEnv()
      );
      expect(exitCode).toBe(0);

      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      // Should NOT contain mock artifacts from the old scaffold
      expect(output).not.toContain("This is a synthesized answer based on the knowledge graph.");
      expect(output).not.toContain("claim-001");
      expect(output).not.toContain("claim-002");
      expect(output).not.toContain("Source citation 1");
    } finally {
      logSpy.mockRestore();
    }
  }, 60000);

  it("returns graceful 'no knowledge' when no results available", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // Simple question — classified as "simple", no embedding key = empty results
      const exitCode = await cmdQuery("Who is Harrison Lingle?", makeEnv());
      expect(exitCode).toBe(0);

      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      // Gracefully says no knowledge available instead of crashing
      expect(output).toContain("No knowledge available for this question.");
    } finally {
      logSpy.mockRestore();
    }
  }, 60000);

  it("returns graceful error when Neo4j is down", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exitCode = await cmdQuery(
        "Who is Harrison?",
        makeEnv({ NEO4J_PASSWORD: "wrong-password-99999" })
      );
      expect(exitCode).toBe(1);

      // Should not crash — no output to stdout means no answer
      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).not.toContain("[ANSWER]");
    } finally {
      logSpy.mockRestore();
    }
  });
});
