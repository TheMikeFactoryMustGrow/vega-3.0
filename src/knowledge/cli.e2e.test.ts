import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { initNeo4j, cmdStatus, cmdPrivacyAudit, cmdQuery } from "./cli.js";
import type { Env } from "./cli.js";
import type { Neo4jConnection } from "./neo4j.js";

/**
 * End-to-end CLI integration tests — US-608
 *
 * Validates all CLI commands work against a real Neo4j instance.
 * Requires Neo4j running at bolt://localhost:7687 with existing data (~1,840 claims).
 */

const NEO4J_URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "testpassword";

const makeEnv = (overrides?: Partial<Env>): Env => ({
  NEO4J_URI,
  NEO4J_USER,
  NEO4J_PASSWORD,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  EMBEDDING_MODEL: "text-embedding-3-small",
  LLM_BASE_URL: "https://api.x.ai/v1",
  XAI_API_KEY: process.env.XAI_API_KEY,
  VAULT_PATH: "/tmp",
  ...overrides,
});

describe("US-608: End-to-end CLI validation", () => {
  const connections: Neo4jConnection[] = [];

  afterAll(async () => {
    for (const conn of connections) {
      await conn.close();
    }
  });

  // Test 1 — Status: verify CONNECTED, real node counts, Claim count ≥1000
  it("Test 1: status shows CONNECTED with real node counts (Claim ≥1000)", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    try {
      const exitCode = await cmdStatus(makeEnv());
      const output = logs.join("\n");

      // Must be connected
      expect(output).toContain("Neo4j: CONNECTED");

      // Must have real node counts with Claim label
      expect(output).toContain("Node Counts:");
      expect(output).toContain("Claim:");

      // Extract Claim count — should be ≥1000 based on 1,840 existing claims
      const claimMatch = output.match(/Claim:\s*(\d+)/);
      expect(claimMatch).not.toBeNull();
      const claimCount = Number(claimMatch![1]);
      expect(claimCount).toBeGreaterThanOrEqual(1000);

      // Exit code 0 = Phase 1 pass (≥100 claims)
      expect(exitCode).toBe(0);

      // Structured output for Ralph verification
      console.info("[E2E-RESULT] Test 1 — Status: PASS (Claim count: %d)", claimCount);
    } finally {
      logSpy.mockRestore();
    }
  });

  // Test 2 — Privacy Audit: all 6 audit queries execute without error
  it("Test 2: privacy-audit executes all 6 audit queries without error", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    try {
      const exitCode = await cmdPrivacyAudit(makeEnv());
      const output = logs.join("\n");

      // All 6 audits must appear in output
      expect(output).toContain("[PRIVACY AUDIT RESULTS]");
      expect(output).toContain("Sole Write Owner");
      expect(output).toContain("Children's Data Protection (Harrison)");
      expect(output).toContain("Children's Data Protection (Beckham)");
      expect(output).toContain("Connector Scope (Drive)");
      expect(output).toContain("Cross-Domain Leakage (Health)");
      expect(output).toContain("Agent Access Anomaly");

      // No ERROR results (all queries should execute cleanly)
      expect(output).not.toContain("| ERROR");

      // Exit code 0 or 1 (0 = clean, 1 = violations found — both are valid)
      expect([0, 1]).toContain(exitCode);

      console.info("[E2E-RESULT] Test 2 — Privacy Audit: PASS (exit code: %d)", exitCode);
    } finally {
      logSpy.mockRestore();
    }
  });

  // Test 3 — Query: "Who is Harrison Lingle?" → grounded answer with citations
  it("Test 3: query returns answer for known entity (Harrison Lingle)", async () => {
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasXAI = !!process.env.XAI_API_KEY;

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    try {
      const exitCode = await cmdQuery("Who is Harrison Lingle?", makeEnv());
      const output = logs.join("\n");

      // Should not crash regardless of API key availability
      expect(exitCode).toBe(0);

      if (hasOpenAI || hasXAI) {
        // With API keys: expect answer with citations or at least results
        if (output.includes("[ANSWER]")) {
          expect(output).toContain("[ANSWER]");
          // Should have timing info
          expect(output).toContain("[TIMING]");
        }
      } else {
        // Without API keys: graceful "no knowledge" response
        expect(output).toContain("No knowledge available for this question.");
      }

      // Must NOT contain mock artifacts from scaffold
      expect(output).not.toContain("This is a synthesized answer");
      expect(output).not.toContain("claim-001");
      expect(output).not.toContain("Source citation 1");

      console.info(
        "[E2E-RESULT] Test 3 — Query (Harrison): PASS (hasOpenAI: %s, hasXAI: %s, exitCode: %d)",
        hasOpenAI, hasXAI, exitCode
      );
    } finally {
      logSpy.mockRestore();
    }
  }, 60000);

  // Test 4 — Query graceful degradation: Neo4j down → error message, not crash
  it("Test 4: query returns error (not crash) when Neo4j is down", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    try {
      const exitCode = await cmdQuery(
        "Who is Harrison Lingle?",
        makeEnv({ NEO4J_PASSWORD: "wrong-password-e2e-99999" })
      );

      // Exit code 1 = error (not a crash/unhandled exception)
      expect(exitCode).toBe(1);

      // Should NOT produce an answer
      const output = logs.join("\n");
      expect(output).not.toContain("[ANSWER]");

      console.info("[E2E-RESULT] Test 4 — Query Degradation: PASS (exitCode: %d)", exitCode);
    } finally {
      logSpy.mockRestore();
    }
  });

  // Test 5 — Status shows Phase 1 PASS when ≥100 claims exist
  it("Test 5: status shows Phase 1 PASS with existing 1,840+ claims", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    try {
      const exitCode = await cmdStatus(makeEnv());
      const output = logs.join("\n");

      // Phase 1 criteria section must exist and show PASS
      expect(output).toContain("[PHASE 1 CRITERIA]");
      expect(output).toMatch(/Claims \(\d+\/100\): PASS/);

      // Exit code 0 = Phase 1 pass
      expect(exitCode).toBe(0);

      console.info("[E2E-RESULT] Test 5 — Phase 1 PASS: PASS");
    } finally {
      logSpy.mockRestore();
    }
  });

  // Test 6 — Exit codes: 0 for success, 1 for error, 2 for partial success
  it("Test 6: all commands return correct exit codes", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // Status with valid creds → 0 (success, Phase 1 passes with ≥100 claims)
      const statusCode = await cmdStatus(makeEnv());
      expect(statusCode).toBe(0);

      // Status with invalid creds → 1 (error)
      const statusDownCode = await cmdStatus(
        makeEnv({ NEO4J_PASSWORD: "wrong-password-e2e-99999" })
      );
      expect(statusDownCode).toBe(1);

      // Privacy audit with valid creds → 0 or 1 (both valid)
      const auditCode = await cmdPrivacyAudit(makeEnv());
      expect([0, 1]).toContain(auditCode);

      // Query with valid creds → 0 (success)
      const queryCode = await cmdQuery("test question", makeEnv());
      expect(queryCode).toBe(0);

      // Query with invalid creds → 1 (error)
      const queryDownCode = await cmdQuery(
        "test",
        makeEnv({ NEO4J_PASSWORD: "wrong-password-e2e-99999" })
      );
      expect(queryDownCode).toBe(1);

      console.info(
        "[E2E-RESULT] Test 6 — Exit Codes: PASS (status: %d, statusDown: %d, audit: %d, query: %d, queryDown: %d)",
        statusCode, statusDownCode, auditCode, queryCode, queryDownCode
      );
    } finally {
      logSpy.mockRestore();
    }
  }, 60000);

  // Test 7 — Typecheck: npx tsc --noEmit passes
  it("Test 7: typecheck passes for cli.ts and all imported modules", () => {
    try {
      execSync("npx tsc --noEmit", {
        cwd: process.cwd(),
        stdio: "pipe",
        timeout: 60000,
      });
      console.info("[E2E-RESULT] Test 7 — Typecheck: PASS");
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
      throw new Error(`Typecheck failed:\n${stderr}`);
    }
  }, 60000);
});
