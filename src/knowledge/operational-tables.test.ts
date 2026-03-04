import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import {
  runOperationalMigration,
  verifyOperationalTables,
  EXPECTED_TABLES,
  EXPECTED_COLUMNS,
  ALL_TABLE_SQLS,
  type MigrationResult,
  type OperationalTableName,
} from "./operational-tables.js";
import { TelemetryEmitter } from "../telemetry/emitter.js";

const { Pool } = pg;

// ── Test setup ─────────────────────────────────────────────────────────

const TEST_PG_URL =
  process.env.VEGA_TEST_PG_URL ?? "postgres://localhost/vega_test";

let pool: pg.Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: TEST_PG_URL, max: 2 });
});

afterAll(async () => {
  // Clean up all 6 tables + dead letter queue after tests
  const tables = [
    ...EXPECTED_TABLES,
    "knowledge_dead_letter_queue",
  ];
  for (const table of tables) {
    try {
      await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    } catch {
      // Ignore cleanup errors
    }
  }
  await pool.end();
});

// ── Migration tests ───────────────────────────────────────────────────

describe("runOperationalMigration", () => {
  it("creates all 6 tables on first run", async () => {
    // Drop all tables first to ensure clean state
    for (const name of EXPECTED_TABLES) {
      await pool.query(`DROP TABLE IF EXISTS ${name} CASCADE`);
    }

    const result = await runOperationalMigration(pool);

    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.tables_created).toHaveLength(6);
    expect(result.tables_created).toEqual(expect.arrayContaining([...EXPECTED_TABLES]));
    expect(result.already_existed).toHaveLength(0);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("is idempotent — second run reports already_existed, no errors", async () => {
    const result = await runOperationalMigration(pool);

    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.tables_created).toHaveLength(0);
    expect(result.already_existed).toHaveLength(6);
    expect(result.already_existed).toEqual(expect.arrayContaining([...EXPECTED_TABLES]));
  });

  it("emits telemetry on migration", async () => {
    const emitter = new TelemetryEmitter();
    const events: unknown[] = [];
    const spy = vi.spyOn(emitter, "emit").mockImplementation((e) => {
      events.push(e);
    });

    await runOperationalMigration(pool, emitter);

    expect(spy).toHaveBeenCalledOnce();
    const event = events[0] as Record<string, unknown>;
    expect(event.agent_name).toBe("knowledge_agent");
    expect(event.event_type).toBe("knowledge_write");
    expect(event.event_subtype).toBe("operational_migration");
    expect(event.outcome).toBe("success");

    spy.mockRestore();
  });
});

// ── Verification tests ───────────────────────────────────────────────

describe("verifyOperationalTables", () => {
  it("reports all tables valid after migration", async () => {
    const verification = await verifyOperationalTables(pool);

    expect(verification.valid).toBe(true);
    for (const name of EXPECTED_TABLES) {
      expect(verification.tables[name].exists).toBe(true);
      expect(verification.tables[name].columns).toEqual(
        expect.arrayContaining(EXPECTED_COLUMNS[name]),
      );
    }
  });

  it("reports invalid when a table is missing", async () => {
    await pool.query("DROP TABLE IF EXISTS trust_levels CASCADE");

    const verification = await verifyOperationalTables(pool);

    expect(verification.valid).toBe(false);
    expect(verification.tables.trust_levels.exists).toBe(false);

    // Re-create for subsequent tests
    await runOperationalMigration(pool);
  });
});

// ── Schema detail tests ───────────────────────────────────────────────

describe("trust_levels table schema", () => {
  it("has all required columns", async () => {
    const res = await pool.query(
      `SELECT column_name, data_type, column_default, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'trust_levels'
       ORDER BY ordinal_position`,
    );
    const cols = res.rows as { column_name: string; data_type: string; column_default: string | null; is_nullable: string }[];
    const colMap = Object.fromEntries(cols.map((c) => [c.column_name, c]));

    expect(colMap.id.data_type).toBe("uuid");
    expect(colMap.agent_name.is_nullable).toBe("NO");
    expect(colMap.integration.is_nullable).toBe("NO");
    expect(colMap.trust_level.column_default).toContain("observe");
    expect(colMap.granted_by.is_nullable).toBe("NO");
    expect(colMap.revoked_at.is_nullable).toBe("YES");
    expect(colMap.revoked_reason.is_nullable).toBe("YES");
  });

  it("accepts valid trust level insert", async () => {
    const res = await pool.query(
      `INSERT INTO trust_levels (agent_name, integration, trust_level, granted_by, evidence)
       VALUES ('knowledge_agent', 'neo4j', 'act', 'system', 'initial setup')
       RETURNING id, trust_level, granted_at`,
    );
    expect(res.rows[0].trust_level).toBe("act");
    expect(res.rows[0].granted_at).toBeInstanceOf(Date);

    // Cleanup
    await pool.query("DELETE FROM trust_levels WHERE id = $1", [res.rows[0].id]);
  });
});

describe("knowledge_edit_queue table schema", () => {
  it("has all required columns with correct defaults", async () => {
    const res = await pool.query(
      `SELECT column_name, data_type, column_default, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'knowledge_edit_queue'
       ORDER BY ordinal_position`,
    );
    const cols = res.rows as { column_name: string; data_type: string; column_default: string | null; is_nullable: string }[];
    const colMap = Object.fromEntries(cols.map((c) => [c.column_name, c]));

    expect(colMap.id.data_type).toBe("uuid");
    expect(colMap.proposing_agent.is_nullable).toBe("NO");
    expect(colMap.edit_type.is_nullable).toBe("NO");
    expect(colMap.target_node_id.is_nullable).toBe("NO");
    expect(colMap.target_node_type.is_nullable).toBe("NO");
    expect(colMap.status.column_default).toContain("pending");
    expect(colMap.confidence.data_type).toBe("double precision");
    expect(colMap.reviewed_at.is_nullable).toBe("YES");
    expect(colMap.reviewed_by.is_nullable).toBe("YES");
    expect(colMap.resolution_notes.is_nullable).toBe("YES");
  });

  it("accepts valid edit queue insert with default status", async () => {
    const res = await pool.query(
      `INSERT INTO knowledge_edit_queue
        (proposing_agent, edit_type, target_node_id, target_node_type, proposed_value, reasoning, confidence)
       VALUES ('knowledge_agent', 'update_claim', 'claim-123', 'Claim', 'new value', 'evidence updated', 0.92)
       RETURNING id, status, created_at`,
    );
    expect(res.rows[0].status).toBe("pending");
    expect(res.rows[0].created_at).toBeInstanceOf(Date);

    // Cleanup
    await pool.query("DELETE FROM knowledge_edit_queue WHERE id = $1", [res.rows[0].id]);
  });
});

describe("knowledge_sync_ledger table schema", () => {
  it("has correct columns", async () => {
    const res = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'knowledge_sync_ledger'
       ORDER BY ordinal_position`,
    );
    const cols = res.rows.map((r: { column_name: string }) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(EXPECTED_COLUMNS.knowledge_sync_ledger));
  });
});

describe("bar_raiser_direct table schema", () => {
  it("has correct columns", async () => {
    const res = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'bar_raiser_direct'
       ORDER BY ordinal_position`,
    );
    const cols = res.rows.map((r: { column_name: string }) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(EXPECTED_COLUMNS.bar_raiser_direct));
  });
});

describe("privacy_audit_log table schema", () => {
  it("has correct columns", async () => {
    const res = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'privacy_audit_log'
       ORDER BY ordinal_position`,
    );
    const cols = res.rows.map((r: { column_name: string }) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(EXPECTED_COLUMNS.privacy_audit_log));
  });
});

describe("model_quality_metrics table schema", () => {
  it("has correct columns including UNIQUE constraint", async () => {
    const res = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'model_quality_metrics'
       ORDER BY ordinal_position`,
    );
    const cols = res.rows.map((r: { column_name: string }) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(EXPECTED_COLUMNS.model_quality_metrics));

    // Verify UNIQUE constraint on (task_type, model)
    const constraints = await pool.query(
      `SELECT constraint_name, constraint_type
       FROM information_schema.table_constraints
       WHERE table_name = 'model_quality_metrics' AND constraint_type = 'UNIQUE'`,
    );
    expect(constraints.rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Index verification ───────────────────────────────────────────────

describe("indexes", () => {
  it("creates expected indexes for all tables", async () => {
    const res = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
       AND indexname LIKE 'idx_%'
       ORDER BY indexname`,
    );
    const indexNames = res.rows.map((r: { indexname: string }) => r.indexname);

    // Trust levels indexes
    expect(indexNames).toContain("idx_trust_levels_agent");
    expect(indexNames).toContain("idx_trust_levels_active");

    // Edit queue indexes
    expect(indexNames).toContain("idx_edit_queue_status");
    expect(indexNames).toContain("idx_edit_queue_agent");
    expect(indexNames).toContain("idx_edit_queue_pending");

    // Sync ledger indexes
    expect(indexNames).toContain("idx_sync_ledger_path");
    expect(indexNames).toContain("idx_sync_ledger_node");

    // Bar raiser indexes
    expect(indexNames).toContain("idx_bar_raiser_direct_severity");
    expect(indexNames).toContain("idx_bar_raiser_direct_unresolved");

    // Privacy audit indexes
    expect(indexNames).toContain("idx_privacy_audit_log_type");
    expect(indexNames).toContain("idx_privacy_audit_log_status");

    // Model quality indexes
    expect(indexNames).toContain("idx_model_quality_task");
    expect(indexNames).toContain("idx_model_quality_status");
  });
});

// ── Table count constant ────────────────────────────────────────────

describe("constants", () => {
  it("ALL_TABLE_SQLS has 6 entries", () => {
    expect(ALL_TABLE_SQLS).toHaveLength(6);
  });

  it("EXPECTED_TABLES has 6 entries", () => {
    expect(EXPECTED_TABLES).toHaveLength(6);
  });

  it("EXPECTED_COLUMNS covers all tables", () => {
    for (const name of EXPECTED_TABLES) {
      expect(EXPECTED_COLUMNS[name]).toBeDefined();
      expect(EXPECTED_COLUMNS[name].length).toBeGreaterThan(0);
    }
  });
});
