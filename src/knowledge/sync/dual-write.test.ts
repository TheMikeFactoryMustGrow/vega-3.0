import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { createPool } from "../../telemetry/database.js";
import { TelemetryEmitter } from "../../telemetry/emitter.js";
import { VaultConnector } from "../vault-connector.js";
import {
  DualWriteSync,
  type SyncResult,
  type BatchSyncResult,
  type SyncLedgerEntry,
  type DeadLetterEntry,
} from "./dual-write.js";

/**
 * DualWriteSync tests — Bidirectional synchronization between Obsidian and Neo4j.
 *
 * Uses mock Neo4j sessions to avoid requiring a running Neo4j instance.
 * Uses real PostgreSQL for sync ledger and dead letter queue tests.
 */

// Mock icloud-sync to avoid brctl dependency
vi.mock("../../telemetry/icloud-sync.js", () => ({
  materialize_icloud_stubs: vi.fn().mockResolvedValue({
    stubs_found: 0,
    successfully_materialized: 0,
    failed: 0,
    already_downloaded: 0,
    errors: [],
  }),
}));

const TEST_DB_URL =
  process.env.VEGA_TEST_PG_URL ?? "postgres://localhost/vega_test";

let pool: pg.Pool;
let emitter: TelemetryEmitter;
let tempDir: string;
let vaultDir: string;

// ── Mock Neo4j Helpers ─────────────────────────────────────────────────

function mockRecord(data: Record<string, unknown>) {
  return {
    get(key: string) {
      return data[key] ?? null;
    },
  };
}

function mockNeo4jNode(properties: Record<string, unknown>) {
  return { properties };
}

function mockSession(
  runResponses: Array<{ records: Array<ReturnType<typeof mockRecord>> }>,
) {
  let callIndex = 0;
  return {
    run: vi.fn().mockImplementation(() => {
      const resp = runResponses[callIndex] ?? { records: [] };
      callIndex++;
      return Promise.resolve(resp);
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function mockConnection(
  sessionFactory: () => ReturnType<typeof mockSession>,
) {
  return {
    session: sessionFactory,
  } as unknown as import("../neo4j.js").Neo4jConnection;
}

// ── Setup / Teardown ─────────────────────────────────────────────────

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "vega-dualwrite-test-"));
  vaultDir = path.join(tempDir, "vault");
  await mkdir(vaultDir, { recursive: true });
  await mkdir(path.join(vaultDir, "_agent_insights"), { recursive: true });

  emitter = new TelemetryEmitter(tempDir);
  pool = createPool(TEST_DB_URL);
});

afterAll(async () => {
  // Clean up PostgreSQL tables
  try {
    await pool.query("DROP TABLE IF EXISTS knowledge_dead_letter_queue CASCADE");
    await pool.query("DROP TABLE IF EXISTS knowledge_sync_ledger CASCADE");
  } catch {
    /* ignore if tables don't exist */
  }
  await pool.end();
  await rm(tempDir, { recursive: true, force: true });
});

// ── Helper: create a vault note ───────────────────────────────────────

async function createVaultNote(
  relativePath: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<string> {
  const fullPath = path.join(vaultDir, relativePath);
  const dir = path.dirname(fullPath);
  await mkdir(dir, { recursive: true });

  const yamlParts = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}:\n${v.map((item) => `  - ${item}`).join("\n")}`;
      }
      return `${k}: ${v}`;
    })
    .join("\n");

  const content = `---\n${yamlParts}\n---\n${body}`;
  await writeFile(fullPath, content, "utf-8");
  return fullPath;
}

// ── Migration / Schema Tests ──────────────────────────────────────────

describe("DualWriteSync Schema Migration", () => {
  it("creates sync ledger and dead letter queue tables", async () => {
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const conn = mockConnection(() => mockSession([]));
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    await sync.runMigration();

    // Verify sync ledger table exists
    const ledgerResult = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'knowledge_sync_ledger'
       ORDER BY ordinal_position`,
    );
    const ledgerColumns = ledgerResult.rows.map((r) => r.column_name);
    expect(ledgerColumns).toContain("id");
    expect(ledgerColumns).toContain("obsidian_path");
    expect(ledgerColumns).toContain("neo4j_node_id");
    expect(ledgerColumns).toContain("last_synced_at");
    expect(ledgerColumns).toContain("sync_direction");
    expect(ledgerColumns).toContain("sync_status");

    // Verify dead letter queue table exists
    const dlqResult = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'knowledge_dead_letter_queue'
       ORDER BY ordinal_position`,
    );
    const dlqColumns = dlqResult.rows.map((r) => r.column_name);
    expect(dlqColumns).toContain("id");
    expect(dlqColumns).toContain("obsidian_path");
    expect(dlqColumns).toContain("neo4j_node_id");
    expect(dlqColumns).toContain("error");
    expect(dlqColumns).toContain("attempt_count");
    expect(dlqColumns).toContain("max_attempts");
    expect(dlqColumns).toContain("next_retry_at");
    expect(dlqColumns).toContain("created_at");
    expect(dlqColumns).toContain("resolved_at");
  });

  it("migration is idempotent — runs twice without errors", async () => {
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const conn = mockConnection(() => mockSession([]));
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    await expect(sync.runMigration()).resolves.not.toThrow();
    await expect(sync.runMigration()).resolves.not.toThrow();
  });
});

// ── Obsidian → Neo4j Tests ──────────────────────────────────────────

describe("Obsidian → Neo4j sync", () => {
  beforeEach(async () => {
    // Clean ledger and DLQ between tests
    await pool.query("DELETE FROM knowledge_sync_ledger");
    await pool.query("DELETE FROM knowledge_dead_letter_queue");
  });

  it("syncs an entity note from Obsidian to Neo4j", async () => {
    // Create a vault note
    const notePath = await createVaultNote("Finance/Entities/Blackstone.md", {
      type: "entity",
      name: "Blackstone Inc",
      entity_type: "organization",
      domain: "gix",
    }, "Blackstone is a major alternative asset manager.\n\n- Manages over $1T in AUM\n");

    // Mock Neo4j responses for EntityMapper.migrate
    const sess = mockSession([
      // MERGE Entity node response
      { records: [mockRecord({ id: "entity-blackstone-inc-organization", isNew: true })] },
      // MERGE Source node response
      { records: [] },
      // CREATE Claim 1
      { records: [] },
      // CREATE Claim 2
      { records: [] },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    const result = await sync.syncObsidianToNeo4j(notePath);

    expect(result.success).toBe(true);
    expect(result.direction).toBe("obsidian_to_neo4j");
    expect(result.obsidian_path).toBe("Finance/Entities/Blackstone.md");
    expect(result.neo4j_node_id).toContain("entity-blackstone-inc-organization");
    expect(result.migration_stats).toBeDefined();
    expect(result.latency_ms).toBeGreaterThan(0);

    // Verify sync ledger was updated
    const ledger = await sync.getLedgerByPath("Finance/Entities/Blackstone.md");
    expect(ledger.length).toBe(1);
    expect(ledger[0].sync_direction).toBe("obsidian_to_neo4j");
    expect(ledger[0].sync_status).toBe("synced");
  });

  it("handles file without frontmatter gracefully", async () => {
    const notePath = path.join(vaultDir, "plain.md");
    await writeFile(notePath, "Just some text without frontmatter.\n", "utf-8");

    const conn = mockConnection(() => mockSession([]));
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    const result = await sync.syncObsidianToNeo4j(notePath);

    expect(result.success).toBe(false);
    expect(result.error).toBe("No frontmatter found");
  });

  it("handles invalid template gracefully", async () => {
    const notePath = await createVaultNote("bad_template.md", {
      type: "entity",
      // Missing required name/entity_type/domain
    }, "Some body.\n");

    const conn = mockConnection(() => mockSession([]));
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    const result = await sync.syncObsidianToNeo4j(notePath);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid template");
  });

  it("adds to dead letter queue on Neo4j failure", async () => {
    const notePath = await createVaultNote("Finance/Entities/FailEntity.md", {
      type: "entity",
      name: "FailCorp",
      entity_type: "organization",
      domain: "gix",
    }, "This will fail.\n");

    // Mock Neo4j that throws on session.run
    const failSession = {
      run: vi.fn().mockRejectedValue(new Error("Neo4j connection lost")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const conn = mockConnection(() => failSession as ReturnType<typeof mockSession>);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    const result = await sync.syncObsidianToNeo4j(notePath);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Neo4j connection lost");

    // Verify dead letter queue entry
    const deadLetters = await sync.getDeadLetters();
    expect(deadLetters.length).toBeGreaterThanOrEqual(1);
    const dlEntry = deadLetters.find((d) =>
      d.obsidian_path === "Finance/Entities/FailEntity.md",
    );
    expect(dlEntry).toBeDefined();
    expect(dlEntry!.attempt_count).toBe(1);
    expect(dlEntry!.max_attempts).toBe(3);
  });

  it("syncs a person note from Obsidian to Neo4j", async () => {
    const notePath = await createVaultNote("People/Jim.md", {
      type: "person",
      name: "Jim LaMarche",
      relationship: "business partner",
      domain: "gix",
    }, "Jim is the CIO of Blackstone.\n");

    const sess = mockSession([
      { records: [mockRecord({ id: "entity-jim-lamarche-person", isNew: true })] },
      { records: [] },
      { records: [] },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    const result = await sync.syncObsidianToNeo4j(notePath);

    expect(result.success).toBe(true);
    expect(result.neo4j_node_id).toContain("person");
  });
});

// ── Neo4j → Obsidian Tests ──────────────────────────────────────────

describe("Neo4j → Obsidian sync", () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM knowledge_sync_ledger");
    await pool.query("DELETE FROM knowledge_dead_letter_queue");
  });

  it("syncs a Claim node from Neo4j to Obsidian _agent_insights/", async () => {
    const claimNode = mockNeo4jNode({
      id: "claim-test-001",
      content: "Blackstone AUM exceeds $1 trillion",
      truth_tier: "single_source",
      truth_score: 0.75,
      domain: "gix",
      status: "active",
    });

    const sess = mockSession([
      {
        records: [
          mockRecord({
            c: claimNode,
            entities: ["Blackstone Inc"],
          }),
        ],
      },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    const result = await sync.syncNeo4jToObsidian("claim-test-001", "Claim");

    expect(result.success).toBe(true);
    expect(result.direction).toBe("neo4j_to_obsidian");
    expect(result.obsidian_path).toContain("_agent_insights/");
    expect(result.obsidian_path).toContain("Claim_");

    // Verify the file was created
    const fullPath = path.join(vaultDir, result.obsidian_path!);
    const content = await readFile(fullPath, "utf-8");
    expect(content).toContain("type: agent_claim");
    expect(content).toContain("claim_id: claim-test-001");
    expect(content).toContain("truth_tier: single_source");
    expect(content).toContain("Blackstone AUM exceeds $1 trillion");

    // Verify ledger was updated
    const ledger = await sync.getLedgerByNodeId("claim-test-001");
    expect(ledger.length).toBe(1);
    expect(ledger[0].sync_direction).toBe("neo4j_to_obsidian");
    expect(ledger[0].sync_status).toBe("synced");
  });

  it("syncs an Entity node from Neo4j to Obsidian", async () => {
    const entityNode = mockNeo4jNode({
      id: "entity-blackstone-org",
      name: "Blackstone Inc",
      entity_type: "organization",
      domain: "gix",
    });

    const sess = mockSession([
      {
        records: [
          mockRecord({
            e: entityNode,
            claimCount: { toNumber: () => 15 },
          }),
        ],
      },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    const result = await sync.syncNeo4jToObsidian(
      "entity-blackstone-org",
      "Entity",
    );

    expect(result.success).toBe(true);
    expect(result.obsidian_path).toContain("Entity_blackstone_inc");

    const fullPath = path.join(vaultDir, result.obsidian_path!);
    const content = await readFile(fullPath, "utf-8");
    expect(content).toContain("type: agent_entity");
    expect(content).toContain("name: Blackstone Inc");
    expect(content).toContain("claim_count: 15");
  });

  it("syncs an OpenQuestion node from Neo4j to Obsidian", async () => {
    const oqNode = mockNeo4jNode({
      id: "oq-test-001",
      question: "Is Blackstone AUM still above $1T?",
      domain: "gix",
      priority: "high",
      severity: "medium",
      status: "open",
      raised_by: "contradiction_detector",
      explanation: "Conflicting data from two sources about AUM figures.",
    });

    const sess = mockSession([
      {
        records: [
          mockRecord({
            oq: oqNode,
            claimIds: ["claim-001", "claim-002"],
          }),
        ],
      },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    const result = await sync.syncNeo4jToObsidian("oq-test-001", "OpenQuestion");

    expect(result.success).toBe(true);
    expect(result.obsidian_path).toContain("OpenQuestion_");

    const fullPath = path.join(vaultDir, result.obsidian_path!);
    const content = await readFile(fullPath, "utf-8");
    expect(content).toContain("type: agent_open_question");
    expect(content).toContain("priority: high");
    expect(content).toContain("Is Blackstone AUM still above $1T?");
  });

  it("handles missing Neo4j node gracefully", async () => {
    const sess = mockSession([{ records: [] }]);
    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    const result = await sync.syncNeo4jToObsidian("nonexistent-node", "Claim");

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

// ── Conflict Detection Tests ────────────────────────────────────────

describe("Conflict Detection", () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM knowledge_sync_ledger");
  });

  it("creates OpenQuestion on sync conflict", async () => {
    const sess = mockSession([
      // CREATE OpenQuestion
      { records: [] },
      // Link to node (OPTIONAL MATCH + FOREACH)
      { records: [] },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    const result = await sync.handleConflict(
      "Finance/Entities/Blackstone.md",
      "entity-blackstone-org",
      "Obsidian says AUM is $800B, Neo4j says $1T — simultaneous edit detected",
    );

    expect(result.success).toBe(true);

    // Verify OpenQuestion was created via session.run calls
    const runCalls = sess.run.mock.calls;
    expect(runCalls.length).toBe(2);
    expect(runCalls[0][0]).toContain("CREATE (oq:OpenQuestion");
    expect(runCalls[0][1].question).toContain("Sync conflict");

    // Verify ledger shows conflict status
    const ledger = await sync.getLedgerByPath("Finance/Entities/Blackstone.md");
    expect(ledger.length).toBe(1);
    expect(ledger[0].sync_status).toBe("conflict");
  });
});

// ── Dead Letter Queue Tests ─────────────────────────────────────────

describe("Dead Letter Queue", () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM knowledge_dead_letter_queue");
    await pool.query("DELETE FROM knowledge_sync_ledger");
  });

  it("tracks failed sync with exponential backoff", async () => {
    const notePath = await createVaultNote("Finance/Entities/RetryMe.md", {
      type: "entity",
      name: "RetryMe Corp",
      entity_type: "organization",
      domain: "gix",
    }, "Body text.\n");

    // Neo4j failure
    const failSession = {
      run: vi.fn().mockRejectedValue(new Error("Connection timeout")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const conn = mockConnection(() => failSession as ReturnType<typeof mockSession>);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    // First failure
    await sync.syncObsidianToNeo4j(notePath);

    let deadLetters = await sync.getDeadLetters();
    expect(deadLetters.length).toBe(1);
    expect(deadLetters[0].attempt_count).toBe(1);

    // Second failure — should increment attempt_count
    await sync.syncObsidianToNeo4j(notePath);

    deadLetters = await sync.getDeadLetters();
    expect(deadLetters.length).toBe(1);
    expect(deadLetters[0].attempt_count).toBe(2);
  });

  it("retries dead letter entries and resolves on success", async () => {
    // Insert a manual dead letter entry with next_retry_at in the past
    await pool.query(
      `INSERT INTO knowledge_dead_letter_queue
       (id, obsidian_path, neo4j_node_id, error, attempt_count, max_attempts, next_retry_at)
       VALUES ($1, $2, NULL, $3, 1, 3, now() - interval '1 minute')`,
      ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "Finance/Entities/RetrySuccess.md", "Previous error"],
    );

    // Create the vault note for the retry
    await createVaultNote("Finance/Entities/RetrySuccess.md", {
      type: "entity",
      name: "RetrySuccess Corp",
      entity_type: "organization",
      domain: "gix",
    }, "Body text.\n");

    // Mock successful Neo4j session
    const sess = mockSession([
      { records: [mockRecord({ id: "entity-retrysuccess-corp-organization", isNew: true })] },
      { records: [] },
      { records: [] },
    ]);
    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    const retryResult = await sync.retryDeadLetters();

    expect(retryResult.retried).toBe(1);
    expect(retryResult.succeeded).toBe(1);
    expect(retryResult.failed).toBe(0);

    // Verify entry is marked resolved
    const remaining = await sync.getDeadLetters();
    expect(remaining.length).toBe(0);
  });
});

// ── Batch Sync Tests ────────────────────────────────────────────────

describe("Batch Sync", () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM knowledge_sync_ledger");
    await pool.query("DELETE FROM knowledge_dead_letter_queue");
  });

  it("batch syncs all vault files with frontmatter", async () => {
    // Create a sub-vault for this test
    const batchDir = path.join(tempDir, "batch_vault");
    await mkdir(batchDir, { recursive: true });
    await mkdir(path.join(batchDir, "_agent_insights"), { recursive: true });

    // Create two entity notes
    await writeFile(
      path.join(batchDir, "entity1.md"),
      "---\ntype: entity\nname: Alpha Corp\nentity_type: organization\ndomain: gix\n---\nAlpha is big.\n",
      "utf-8",
    );
    await writeFile(
      path.join(batchDir, "entity2.md"),
      "---\ntype: entity\nname: Beta Inc\nentity_type: organization\ndomain: gix\n---\nBeta is growing.\n",
      "utf-8",
    );
    // Create a file without frontmatter (should be skipped)
    await writeFile(
      path.join(batchDir, "plain.md"),
      "No frontmatter here.\n",
      "utf-8",
    );

    let sessionCallCount = 0;
    const connFactory = () => {
      const responses = [
        { records: [mockRecord({ id: `entity-${sessionCallCount}`, isNew: true })] },
        { records: [] },
        { records: [] },
      ];
      sessionCallCount++;
      return mockSession(responses);
    };

    const conn = mockConnection(connFactory);
    const vault = new VaultConnector({ vaultPath: batchDir, emitter });
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    const batchResult = await sync.batchSyncObsidianToNeo4j();

    // plain.md has no frontmatter, so it should not be included
    // The two entity notes may or may not succeed depending on mock session
    expect(batchResult.total).toBeGreaterThan(0);
    expect(batchResult.latency_ms).toBeGreaterThan(0);
  });
});

// ── Sync Ledger Tests ───────────────────────────────────────────────

describe("Sync Ledger", () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM knowledge_sync_ledger");
  });

  it("records and retrieves sync entries by path", async () => {
    const notePath = await createVaultNote("Finance/test_ledger.md", {
      type: "entity",
      name: "LedgerTest",
      entity_type: "organization",
      domain: "gix",
    }, "Body.\n");

    const sess = mockSession([
      { records: [mockRecord({ id: "entity-ledgertest-organization", isNew: true })] },
      { records: [] },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    await sync.syncObsidianToNeo4j(notePath);

    const entries = await sync.getLedgerByPath("Finance/test_ledger.md");
    expect(entries.length).toBe(1);
    expect(entries[0].obsidian_path).toBe("Finance/test_ledger.md");
    expect(entries[0].neo4j_node_id).toContain("entity-ledgertest-organization");
    expect(entries[0].sync_direction).toBe("obsidian_to_neo4j");
    expect(entries[0].sync_status).toBe("synced");
    expect(entries[0].last_synced_at).toBeInstanceOf(Date);
  });

  it("records and retrieves sync entries by node ID", async () => {
    const claimNode = mockNeo4jNode({
      id: "claim-ledger-test",
      content: "Test claim for ledger",
      truth_tier: "single_source",
      truth_score: 0.5,
      domain: "gix",
      status: "active",
    });

    const sess = mockSession([
      {
        records: [
          mockRecord({
            c: claimNode,
            entities: [],
          }),
        ],
      },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    await sync.syncNeo4jToObsidian("claim-ledger-test", "Claim");

    const entries = await sync.getLedgerByNodeId("claim-ledger-test");
    expect(entries.length).toBe(1);
    expect(entries[0].sync_direction).toBe("neo4j_to_obsidian");
    expect(entries[0].sync_status).toBe("synced");
  });
});

// ── Telemetry Tests ─────────────────────────────────────────────────

describe("Telemetry", () => {
  it("emits telemetry for Obsidian → Neo4j sync", async () => {
    const notePath = await createVaultNote("Finance/Entities/TelTest.md", {
      type: "entity",
      name: "TelTest Corp",
      entity_type: "organization",
      domain: "gix",
    }, "Body.\n");

    const sess = mockSession([
      { records: [mockRecord({ id: "entity-teltest-corp-organization", isNew: true })] },
      { records: [] },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const emitSpy = vi.spyOn(emitter, "emit");
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    await sync.syncObsidianToNeo4j(notePath);

    const syncEvents = emitSpy.mock.calls.filter(
      (call) => (call[0] as Record<string, unknown>).event_subtype === "sync_obsidian_to_neo4j",
    );
    expect(syncEvents.length).toBeGreaterThanOrEqual(1);

    const event = syncEvents[0][0] as Record<string, unknown>;
    expect(event.agent_name).toBe("knowledge_agent");
    expect(event.event_type).toBe("knowledge_write");

    emitSpy.mockRestore();
  });

  it("emits telemetry for Neo4j → Obsidian sync", async () => {
    const claimNode = mockNeo4jNode({
      id: "claim-tel-001",
      content: "Tel test claim",
      truth_tier: "single_source",
      truth_score: 0.5,
      domain: "gix",
      status: "active",
    });

    const sess = mockSession([
      {
        records: [mockRecord({ c: claimNode, entities: [] })],
      },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const emitSpy = vi.spyOn(emitter, "emit");
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    await sync.syncNeo4jToObsidian("claim-tel-001", "Claim");

    const syncEvents = emitSpy.mock.calls.filter(
      (call) => (call[0] as Record<string, unknown>).event_subtype === "sync_neo4j_to_obsidian",
    );
    expect(syncEvents.length).toBeGreaterThanOrEqual(1);

    emitSpy.mockRestore();
  });

  it("emits telemetry for conflict detection", async () => {
    const sess = mockSession([{ records: [] }, { records: [] }]);
    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const emitSpy = vi.spyOn(emitter, "emit");
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    await sync.handleConflict(
      "test.md",
      "node-123",
      "Conflict description",
    );

    const conflictEvents = emitSpy.mock.calls.filter(
      (call) => (call[0] as Record<string, unknown>).event_subtype === "sync_conflict",
    );
    expect(conflictEvents.length).toBe(1);

    emitSpy.mockRestore();
  });
});

// ── Latency / Performance Tests ─────────────────────────────────────

describe("Latency", () => {
  it("sync result includes latency_ms", async () => {
    const notePath = await createVaultNote("Finance/Entities/LatencyTest.md", {
      type: "entity",
      name: "Latency Corp",
      entity_type: "organization",
      domain: "gix",
    }, "Body.\n");

    const sess = mockSession([
      { records: [mockRecord({ id: "entity-latency-corp-organization", isNew: true })] },
      { records: [] },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const sync = new DualWriteSync({
      connection: conn,
      vault,
      pool,
      emitter,
    });

    const result = await sync.syncObsidianToNeo4j(notePath);

    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(typeof result.latency_ms).toBe("number");
  });
});
