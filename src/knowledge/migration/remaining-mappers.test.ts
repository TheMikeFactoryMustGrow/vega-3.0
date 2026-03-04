import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Neo4jConnection } from "../neo4j.js";
import { applySchema } from "../schema.js";
import { EmbeddingPipeline } from "../embedding.js";
import { TelemetryEmitter } from "../../telemetry/emitter.js";
import { AccountMapper } from "./account-mapper.js";
import { InvestmentMapper } from "./investment-mapper.js";
import { CashFlowMapper } from "./cashflow-mapper.js";
import { InstitutionMapper } from "./institution-mapper.js";
import { batchMigrate } from "./batch-migration.js";
import type {
  AccountTemplate,
  InvestmentTemplate,
  CashFlowTemplate,
  InstitutionTemplate,
} from "./parser.js";

/**
 * Tests for AccountMapper, InvestmentMapper, CashFlowMapper, InstitutionMapper,
 * and batchMigrate — requires Neo4j running at bolt://localhost:7687
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
const TEST_DOMAIN = "test_us506";

function makeFakeEmbedding(dim: number = 1536): number[] {
  return Array.from({ length: dim }, (_, i) => Math.sin(i * 0.01));
}

function setupEmbeddingMock() {
  mockEmbeddingsCreate.mockClear();
  mockEmbeddingsCreate.mockImplementation(async () => ({
    data: [{ embedding: makeFakeEmbedding(), index: 0 }],
    usage: { total_tokens: 10 },
  }));
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "vega-us506-test-"));
  emitter = new TelemetryEmitter(tempDir);
  connection = new Neo4jConnection({ password: NEO4J_PASSWORD }, emitter);
  await applySchema(connection, emitter);

  pipeline = new EmbeddingPipeline(connection, {
    apiKey: "test-key",
    emitter,
  });
});

afterAll(async () => {
  // Clean up all test nodes for this story's domain
  const session = connection.session();
  try {
    await session.run(
      `MATCH (n) WHERE n.domain = $domain DETACH DELETE n`,
      { domain: TEST_DOMAIN },
    );
  } finally {
    await session.close();
  }
  if (connection) await connection.close();
  await rm(tempDir, { recursive: true, force: true });
});

// ── AccountMapper tests ──────────────────────────────────────────────

describe("AccountMapper", () => {
  it("migrates an Account note — creates Account Entity, Institution Entity, and BELONGS_TO", async () => {
    setupEmbeddingMock();

    const mapper = new AccountMapper({
      connection,
      embedding: pipeline,
      emitter,
    });

    const frontmatter: AccountTemplate = {
      type: "account",
      name: "Checking Account",
      institution: "First National Bank",
      account_type: "checking",
      domain: TEST_DOMAIN,
      balance: 15000.50,
      currency: "USD",
      last_verified: "2026-01-15",
    };

    const body = "Primary checking account for daily expenses.\n\n- Auto-pay set up for utilities\n- Direct deposit enabled";

    const stats = await mapper.migrate(frontmatter, body, "Finance/Accounts/Checking.md");

    expect(stats.entities_created).toBe(2); // Account + Institution
    expect(stats.claims_created).toBe(3);
    expect(stats.errors).toEqual([]);

    // Verify Account Entity
    const session = connection.session();
    try {
      const acctResult = await session.run(
        `MATCH (e:Entity {name: 'Checking Account', entity_type: 'account'})
         RETURN e.institution AS inst, e.account_type AS acctType, e.balance AS balance, e.currency AS curr`,
      );
      expect(acctResult.records).toHaveLength(1);
      expect(acctResult.records[0].get("inst")).toBe("First National Bank");
      expect(acctResult.records[0].get("acctType")).toBe("checking");
      expect(acctResult.records[0].get("balance")).toBe(15000.50);
      expect(acctResult.records[0].get("curr")).toBe("USD");

      // Verify BELONGS_TO relationship
      const relResult = await session.run(
        `MATCH (a:Entity {name: 'Checking Account', entity_type: 'account'})-[:BELONGS_TO]->(i:Entity {entity_type: 'organization'})
         RETURN i.name AS instName`,
      );
      expect(relResult.records).toHaveLength(1);
      expect(relResult.records[0].get("instName")).toBe("First National Bank");
    } finally {
      await session.close();
    }
  });

  it("MERGE is idempotent for Account notes", async () => {
    setupEmbeddingMock();

    const mapper = new AccountMapper({ connection, embedding: pipeline, emitter });

    const frontmatter: AccountTemplate = {
      type: "account",
      name: "Savings Idempotent",
      institution: "Idempotent Bank",
      account_type: "savings",
      domain: TEST_DOMAIN,
    };

    const stats1 = await mapper.migrate(frontmatter, "", "test/Savings.md");
    expect(stats1.entities_created).toBe(2); // Account + Bank

    const stats2 = await mapper.migrate(frontmatter, "", "test/Savings.md");
    expect(stats2.entities_updated).toBe(1); // Account updated
    expect(stats2.entities_created).toBe(0); // Bank already exists, no new create

    // Verify only one Account Entity
    const session = connection.session();
    try {
      const result = await session.run(
        `MATCH (e:Entity {name: 'Savings Idempotent', entity_type: 'account'})
         RETURN count(e) AS cnt`,
      );
      const cnt = result.records[0].get("cnt");
      expect(typeof cnt === "object" && cnt?.toNumber ? cnt.toNumber() : Number(cnt)).toBe(1);
    } finally {
      await session.close();
    }
  });
});

// ── InvestmentMapper tests ──────────────────────────────────────────

describe("InvestmentMapper", () => {
  it("migrates an Investment note — creates financial_instrument Entity with value Claims", async () => {
    setupEmbeddingMock();

    const mapper = new InvestmentMapper({
      connection,
      embedding: pipeline,
      emitter,
    });

    const frontmatter: InvestmentTemplate = {
      type: "investment",
      name: "VEGA Growth Fund",
      vehicle: "WE Fund III",
      strategy: "venture_capital",
      domain: TEST_DOMAIN,
      current_value: 250000,
      cost_basis: 100000,
      inception_date: "2024-06-01",
    };

    const body = "High-growth venture fund.\n\n- 2.5x MOIC since inception\n- Diversified across 12 portfolio companies";

    const stats = await mapper.migrate(frontmatter, body, "Finance/Investments/VGF.md");

    expect(stats.entities_created).toBe(2); // Investment + Vehicle
    expect(stats.claims_created).toBe(4); // 1 value claim + 3 body claims
    expect(stats.errors).toEqual([]);

    // Verify financial_instrument Entity
    const session = connection.session();
    try {
      const invResult = await session.run(
        `MATCH (e:Entity {name: 'VEGA Growth Fund', entity_type: 'financial_instrument'})
         RETURN e.vehicle AS vehicle, e.strategy AS strat, e.current_value AS val, e.cost_basis AS cost`,
      );
      expect(invResult.records).toHaveLength(1);
      expect(invResult.records[0].get("vehicle")).toBe("WE Fund III");
      expect(invResult.records[0].get("strat")).toBe("venture_capital");
      expect(invResult.records[0].get("val")).toBe(250000);
      expect(invResult.records[0].get("cost")).toBe(100000);

      // Verify RELATED_TO relationship to vehicle
      const relResult = await session.run(
        `MATCH (inv:Entity {name: 'VEGA Growth Fund'})-[:RELATED_TO]->(v:Entity {name: 'WE Fund III'})
         RETURN v.entity_type AS vType`,
      );
      expect(relResult.records).toHaveLength(1);
      expect(relResult.records[0].get("vType")).toBe("financial_instrument");

      // Verify value-tracking claim exists
      const valueResult = await session.run(
        `MATCH (c:Claim {claim_type: 'value_tracking'})-[:ABOUT]->(e:Entity {name: 'VEGA Growth Fund'})
         RETURN c.content AS content`,
      );
      expect(valueResult.records).toHaveLength(1);
      expect(valueResult.records[0].get("content")).toContain("Current value");
      expect(valueResult.records[0].get("content")).toContain("Cost basis");
    } finally {
      await session.close();
    }
  });

  it("migrates Investment without value fields — no value claim created", async () => {
    const mapper = new InvestmentMapper({ connection, emitter });

    const frontmatter: InvestmentTemplate = {
      type: "investment",
      name: "No Value Fund",
      vehicle: "Test Vehicle",
      strategy: "index",
      domain: TEST_DOMAIN,
    };

    const stats = await mapper.migrate(frontmatter, "A simple fact.", "test/NoValue.md");
    expect(stats.entities_created).toBeGreaterThanOrEqual(1);
    expect(stats.claims_created).toBe(1); // Only body claim, no value claim
    expect(stats.errors).toEqual([]);
  });
});

// ── CashFlowMapper tests ──────────────────────────────────────────

describe("CashFlowMapper", () => {
  it("migrates a CashFlow note — creates Claim with direction, frequency, amount", async () => {
    setupEmbeddingMock();

    const mapper = new CashFlowMapper({
      connection,
      embedding: pipeline,
      emitter,
    });

    const frontmatter: CashFlowTemplate = {
      type: "cash_flow",
      name: "Rent Payment",
      direction: "outflow",
      frequency: "monthly",
      amount: 3500,
      source_entity: "Landlord LLC",
      domain: TEST_DOMAIN,
    };

    const body = "Due on the 1st of each month.\n\n- Includes utilities\n- Lease expires Dec 2026";

    const stats = await mapper.migrate(frontmatter, body, "Finance/CashFlows/Rent.md");

    expect(stats.claims_created).toBe(4); // 1 primary + 3 body claims
    expect(stats.entities_created).toBe(1); // Landlord LLC auto-created
    expect(stats.errors).toEqual([]);

    // Verify primary cash flow Claim
    const session = connection.session();
    try {
      const cfResult = await session.run(
        `MATCH (c:Claim {claim_type: 'cash_flow', domain: $domain})
         RETURN c.direction AS dir, c.frequency AS freq, c.amount AS amt, c.content AS content`,
        { domain: TEST_DOMAIN },
      );
      expect(cfResult.records).toHaveLength(1);
      expect(cfResult.records[0].get("dir")).toBe("outflow");
      expect(cfResult.records[0].get("freq")).toBe("monthly");
      expect(cfResult.records[0].get("amt")).toBe(3500);

      // Verify ABOUT relationship to source entity
      const aboutResult = await session.run(
        `MATCH (c:Claim {claim_type: 'cash_flow', domain: $domain})-[:ABOUT]->(e:Entity)
         RETURN e.name AS name, e.entity_type AS etype`,
        { domain: TEST_DOMAIN },
      );
      expect(aboutResult.records).toHaveLength(1);
      expect(aboutResult.records[0].get("name")).toBe("Landlord LLC");
    } finally {
      await session.close();
    }
  });

  it("auto-creates source entity if not found", async () => {
    const mapper = new CashFlowMapper({ connection, emitter });

    const frontmatter: CashFlowTemplate = {
      type: "cash_flow",
      name: "New CF",
      direction: "inflow",
      frequency: "quarterly",
      amount: 5000,
      source_entity: "Auto Created Org",
      domain: TEST_DOMAIN,
    };

    const stats = await mapper.migrate(frontmatter, "", "test/NewCF.md");
    expect(stats.entities_created).toBe(1);

    const session = connection.session();
    try {
      const result = await session.run(
        `MATCH (e:Entity {name: 'Auto Created Org', entity_type: 'organization'})
         RETURN e.domain AS domain`,
      );
      expect(result.records).toHaveLength(1);
    } finally {
      await session.close();
    }
  });
});

// ── InstitutionMapper tests ──────────────────────────────────────────

describe("InstitutionMapper", () => {
  it("migrates an Institution note — creates organization Entity with contacts", async () => {
    setupEmbeddingMock();

    const mapper = new InstitutionMapper({
      connection,
      embedding: pipeline,
      emitter,
    });

    const frontmatter: InstitutionTemplate = {
      type: "institution",
      name: "Goldman Sachs",
      institution_type: "investment_bank",
      domain: TEST_DOMAIN,
      contacts: ["John Smith (Advisor)", "Jane Doe (PM)"],
      relationship_status: "active",
    };

    const body = "Primary investment banking relationship.\n\n- Handles equity portfolio\n- Annual review scheduled";

    const stats = await mapper.migrate(frontmatter, body, "Finance/Institutions/GS.md");

    expect(stats.entities_created).toBe(1);
    expect(stats.claims_created).toBe(5); // 2 contact claims + 3 body claims
    expect(stats.errors).toEqual([]);

    // Verify Institution Entity
    const session = connection.session();
    try {
      const instResult = await session.run(
        `MATCH (e:Entity {name: 'Goldman Sachs', entity_type: 'organization'})
         RETURN e.institution_type AS itype, e.contacts AS contacts, e.relationship_status AS status`,
      );
      expect(instResult.records).toHaveLength(1);
      expect(instResult.records[0].get("itype")).toBe("investment_bank");
      expect(instResult.records[0].get("contacts")).toEqual(["John Smith (Advisor)", "Jane Doe (PM)"]);
      expect(instResult.records[0].get("status")).toBe("active");

      // Verify contact-tracking claims
      const contactResult = await session.run(
        `MATCH (c:Claim {claim_type: 'contact_tracking'})-[:ABOUT]->(e:Entity {name: 'Goldman Sachs'})
         RETURN c.content AS content
         ORDER BY c.content`,
      );
      expect(contactResult.records).toHaveLength(2);
      expect(contactResult.records[0].get("content")).toContain("Jane Doe (PM)");
      expect(contactResult.records[1].get("content")).toContain("John Smith (Advisor)");
    } finally {
      await session.close();
    }
  });

  it("MERGE is idempotent for Institution notes", async () => {
    setupEmbeddingMock();

    const mapper = new InstitutionMapper({ connection, embedding: pipeline, emitter });

    const frontmatter: InstitutionTemplate = {
      type: "institution",
      name: "Idempotent Bank",
      institution_type: "bank",
      domain: TEST_DOMAIN,
    };

    const stats1 = await mapper.migrate(frontmatter, "", "test/Idemp.md");
    // Note: Idempotent Bank may have been created by AccountMapper tests
    // so we just check it doesn't create duplicates

    const stats2 = await mapper.migrate(frontmatter, "", "test/Idemp.md");
    expect(stats2.entities_created).toBe(0);
    expect(stats2.entities_updated).toBe(1);

    const session = connection.session();
    try {
      const result = await session.run(
        `MATCH (e:Entity {name: 'Idempotent Bank', entity_type: 'organization'})
         RETURN count(e) AS cnt`,
      );
      const cnt = result.records[0].get("cnt");
      expect(typeof cnt === "object" && cnt?.toNumber ? cnt.toNumber() : Number(cnt)).toBe(1);
    } finally {
      await session.close();
    }
  });

  it("handles Institution without optional contacts", async () => {
    const mapper = new InstitutionMapper({ connection, emitter });

    const frontmatter: InstitutionTemplate = {
      type: "institution",
      name: "Minimal Institution",
      institution_type: "credit_union",
      domain: TEST_DOMAIN,
    };

    const stats = await mapper.migrate(frontmatter, "", "test/MinInst.md");
    expect(stats.entities_created).toBe(1);
    expect(stats.claims_created).toBe(0); // No contacts, no body
    expect(stats.errors).toEqual([]);
  });
});

// ── Batch Migration tests ──────────────────────────────────────────

describe("batchMigrate", () => {
  let batchDir: string;

  beforeAll(async () => {
    batchDir = path.join(tempDir, "batch-vault");
    await mkdir(path.join(batchDir, "Entities"), { recursive: true });
    await mkdir(path.join(batchDir, "Accounts"), { recursive: true });
    await mkdir(path.join(batchDir, "Investments"), { recursive: true });

    // Entity note
    await writeFile(
      path.join(batchDir, "Entities", "Acme Corp.md"),
      `---
type: entity
name: Acme Corp
entity_type: organization
domain: ${TEST_DOMAIN}
---
Acme is a leading company.
`,
    );

    // Person note
    await writeFile(
      path.join(batchDir, "Entities", "Bob Smith.md"),
      `---
type: person
name: Bob Smith
relationship: business_partner
domain: ${TEST_DOMAIN}
---
Bob runs the operations.
`,
    );

    // Account note
    await writeFile(
      path.join(batchDir, "Accounts", "Brokerage.md"),
      `---
type: account
name: Brokerage Account
institution: Fidelity
account_type: brokerage
domain: ${TEST_DOMAIN}
---
Main brokerage account.
`,
    );

    // Investment note
    await writeFile(
      path.join(batchDir, "Investments", "SP500.md"),
      `---
type: investment
name: SP500 Index
vehicle: Vanguard VOO
strategy: index
domain: ${TEST_DOMAIN}
current_value: 50000
---
Passive index fund.
`,
    );

    // Note without frontmatter (should be skipped)
    await writeFile(
      path.join(batchDir, "readme.md"),
      "This is just a plain readme without frontmatter.\n",
    );

    // Note with unknown type (should be skipped)
    await writeFile(
      path.join(batchDir, "unknown.md"),
      `---
type: unknown_type
name: Unknown
---
Unknown type note.
`,
    );
  });

  it("processes mixed note types and returns aggregate stats", async () => {
    setupEmbeddingMock();

    const stats = await batchMigrate(batchDir, {
      connection,
      embedding: pipeline,
      emitter,
    });

    expect(stats.total_files).toBe(6);
    expect(stats.processed).toBe(4); // entity, person, account, investment
    expect(stats.skipped).toBe(2); // readme (no frontmatter) + unknown type
    expect(stats.aggregate.entities_created).toBeGreaterThanOrEqual(4);
    expect(stats.aggregate.claims_created).toBeGreaterThanOrEqual(4);
    expect(stats.errors).toEqual([]);

    // Verify by_type breakdown
    expect(stats.by_type["entity"]).toBeDefined();
    expect(stats.by_type["person"]).toBeDefined();
    expect(stats.by_type["account"]).toBeDefined();
    expect(stats.by_type["investment"]).toBeDefined();
  });

  it("handles non-existent directory gracefully", async () => {
    const stats = await batchMigrate("/tmp/nonexistent-vault-dir-12345", {
      connection,
      emitter,
    });

    expect(stats.total_files).toBe(0);
    expect(stats.errors.length).toBeGreaterThan(0);
  });
});
