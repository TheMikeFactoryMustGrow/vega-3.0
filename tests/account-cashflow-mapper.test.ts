/**
 * Unit and integration tests for the Account & Cash Flow mapper (US-014).
 *
 * Tests pure functions (ID generation, type checking) and mapper logic
 * with mock and real Neo4j backends.
 *
 * Run: npx tsx --test tests/account-cashflow-mapper.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import {
  generateAccountId,
  generateCashFlowId,
  mapAccountToNeo4j,
  mapAccountNoteString,
  mapCashFlowToNeo4j,
  mapCashFlowNoteString,
} from "../src/account-cashflow-mapper.js";
import { parseNoteString } from "../src/frontmatter-parser.js";

// ── Helper ───────────────────────────────────────────────────────────────────

function dedent(s: string): string {
  const lines = s.replace(/^\n/, "").split("\n");
  const minIndent = lines
    .filter((l) => l.trim().length > 0)
    .reduce((min, l) => {
      const m = l.match(/^(\s*)/);
      return Math.min(min, m ? m[1].length : 0);
    }, Infinity);
  return lines.map((l) => l.slice(minIndent)).join("\n");
}

// ── generateAccountId ────────────────────────────────────────────────────────

describe("generateAccountId", () => {
  it("generates ID from file path (filename without extension, slugified)", () => {
    const id = generateAccountId(
      "/vault/Finance/Accounts/Chase - Mike Checking 1622.md",
      null
    );
    assert.strictEqual(id, "chase-mike-checking-1622");
  });

  it("generates ID from account name when no file path", () => {
    const id = generateAccountId(null, "Wealthfront Stock Investing 2360");
    assert.strictEqual(id, "wealthfront-stock-investing-2360");
  });

  it("prefers file path over account name", () => {
    const id = generateAccountId("/vault/Account.md", "Different Name");
    assert.strictEqual(id, "account");
  });

  it("handles null both arguments with fallback", () => {
    const id = generateAccountId(null, null);
    assert.ok(id.startsWith("account-"));
  });
});

// ── generateCashFlowId ──────────────────────────────────────────────────────

describe("generateCashFlowId", () => {
  it("generates ID from file path with cf- prefix", () => {
    const id = generateCashFlowId(
      "/vault/Finance/Cash Flows/Mortgage Payment.md",
      null
    );
    assert.strictEqual(id, "cf-mortgage-payment");
  });

  it("generates ID from description when no file path", () => {
    const id = generateCashFlowId(null, "Monthly Salary");
    assert.strictEqual(id, "cf-monthly-salary");
  });

  it("handles null both arguments with fallback", () => {
    const id = generateCashFlowId(null, null);
    assert.ok(id.startsWith("cashflow-"));
  });
});

// ── mapAccountNoteString (type checking) ────────────────────────────────────

describe("mapAccountNoteString", () => {
  it("rejects non-account notes", () => {
    const result = mapAccountNoteString(
      "---\ntype: entity\n---\nBody.",
      "/vault/entity.md"
    );
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("Not an account note"));
  });

  it("rejects notes with no frontmatter type", () => {
    const result = mapAccountNoteString(
      "# Just a heading\nBody.",
      "/vault/note.md"
    );
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("Not an account note"));
  });

  it("rejects cash-flow notes", () => {
    const result = mapAccountNoteString(
      "---\ntype: cash-flow\n---\nBody.",
      "/vault/cf.md"
    );
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("Not an account note"));
  });
});

// ── mapCashFlowNoteString (type checking) ───────────────────────────────────

describe("mapCashFlowNoteString", () => {
  it("rejects non-cash-flow notes", () => {
    const result = mapCashFlowNoteString(
      "---\ntype: entity\n---\nBody.",
      "/vault/entity.md"
    );
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("Not a cash-flow note"));
  });

  it("rejects account notes", () => {
    const result = mapCashFlowNoteString(
      "---\ntype: account\n---\nBody.",
      "/vault/account.md"
    );
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("Not a cash-flow note"));
  });
});

// ── mapAccountToNeo4j (integration — requires Docker + Neo4j) ────────────────

function neo4jAvailable(): boolean {
  try {
    const out = execSync(
      "docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026",
      {
        input: "RETURN 1 AS test;",
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    return out.includes("1");
  } catch {
    return false;
  }
}

const HAS_NEO4J = neo4jAvailable();

describe("mapAccountToNeo4j (integration)", { skip: !HAS_NEO4J }, () => {
  const TEST_PREFIX = "test-us014-";

  function cleanTestData(): void {
    try {
      execSync(
        "docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026",
        {
          input: `MATCH (n) WHERE n.id STARTS WITH "${TEST_PREFIX}" OR n.id STARTS WITH "cf-${TEST_PREFIX}" OR n.id STARTS WITH "source-vault-${TEST_PREFIX}" OR n.id STARTS WITH "oq-${TEST_PREFIX}" DETACH DELETE n;`,
          encoding: "utf-8",
          timeout: 10_000,
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
    } catch {
      // Ignore cleanup errors
    }
  }

  beforeEach(() => {
    cleanTestData();
  });

  afterEach(() => {
    cleanTestData();
  });

  it("creates account Entity node with entity_type: account and correct properties", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: account
        account-type: checking
        account-name: "${TEST_PREFIX}College Checking 1622"
        institution: "[[${TEST_PREFIX}Chase]]"
        held-by: "[[${TEST_PREFIX}Mike Lingle]]"
        account-number-last4: "1622"
        status: active
        purpose: household-operations
        currency: USD
        source-system: chase.com
        plaid-connected: true
        is_canonical: true
        truth_score: verified
        tags:
          - account
          - account/checking
          - household
          - lingelpedia/canonical
        ---

        # College Checking
      `),
      `/vault/${TEST_PREFIX}chase-checking.md`
    );

    const result = mapAccountToNeo4j(note);
    assert.strictEqual(result.success, true);
    assert.ok(result.accountId.startsWith(TEST_PREFIX));

    // Verify node in Neo4j
    const check = execSync(
      "docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026",
      {
        input: `MATCH (e:Entity {id: "${result.accountId}"}) RETURN e.entity_type, e.account_type, e.truth_score, e.plaid_connected, e.status, e.purpose;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.ok(check.includes("account"));
    assert.ok(check.includes("checking"));
    assert.ok(check.includes("0.95"));
    assert.ok(check.toUpperCase().includes("TRUE"));
    assert.ok(check.includes("active"));
  });

  it("creates RELATED_TO {held_at} relationship to institution", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: account
        account-type: savings
        account-name: "${TEST_PREFIX}Savings"
        institution: "[[${TEST_PREFIX}Discover]]"
        held-by: "[[${TEST_PREFIX}Mike Lingle]]"
        status: active
        is_canonical: true
        truth_score: unscored
        tags:
          - account
        ---

        Body.
      `),
      `/vault/${TEST_PREFIX}discover-savings.md`
    );

    const result = mapAccountToNeo4j(note);
    assert.strictEqual(result.success, true);
    assert.ok(
      result.relationshipsCreated.some(
        (r) => r.includes("RELATED_TO") && r.includes("held_at")
      )
    );

    // Verify institution node has entity_type: institution
    const check = execSync(
      "docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026",
      {
        input: `MATCH (acct:Entity {id: "${result.accountId}"})-[r:RELATED_TO]->(inst:Entity) WHERE r.type = "held_at" RETURN inst.name, inst.entity_type;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.ok(check.includes(`${TEST_PREFIX}Discover`));
    assert.ok(check.includes("institution"));
  });

  it("creates BELONGS_TO relationship from held-by field", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: account
        account-type: brokerage
        account-name: "${TEST_PREFIX}Brokerage"
        institution: "[[${TEST_PREFIX}Wealthfront]]"
        held-by: "[[${TEST_PREFIX}Mike Lingle]]"
        status: active
        is_canonical: true
        truth_score: unscored
        tags:
          - account
        ---

        Body.
      `),
      `/vault/${TEST_PREFIX}wealthfront-brokerage.md`
    );

    const result = mapAccountToNeo4j(note);
    assert.strictEqual(result.success, true);
    assert.ok(
      result.relationshipsCreated.some(
        (r) => r.includes("BELONGS_TO") && r.includes("Mike Lingle")
      )
    );

    // Verify BELONGS_TO in Neo4j
    const check = execSync(
      "docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026",
      {
        input: `MATCH (acct:Entity {id: "${result.accountId}"})-[:BELONGS_TO]->(holder) RETURN holder.name;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.ok(check.includes(`${TEST_PREFIX}Mike Lingle`));
  });

  it("creates RELATED_TO {joint_holder} relationships", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: account
        account-type: checking
        account-name: "${TEST_PREFIX}Joint Checking"
        institution: "[[${TEST_PREFIX}Chase]]"
        held-by: "[[${TEST_PREFIX}Mike Lingle]]"
        joint-holders:
          - "[[${TEST_PREFIX}Lindsay Lingle]]"
        status: active
        is_canonical: true
        truth_score: unscored
        tags:
          - account
        ---

        Body.
      `),
      `/vault/${TEST_PREFIX}joint-checking.md`
    );

    const result = mapAccountToNeo4j(note);
    assert.strictEqual(result.success, true);
    assert.ok(
      result.relationshipsCreated.some(
        (r) =>
          r.includes("RELATED_TO") &&
          r.includes("joint_holder") &&
          r.includes("Lindsay Lingle")
      )
    );

    // Verify joint holder in Neo4j
    const check = execSync(
      "docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026",
      {
        input: `MATCH (acct:Entity {id: "${result.accountId}"})-[r:RELATED_TO]->(jh) WHERE r.type = "joint_holder" RETURN jh.name;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.ok(check.includes(`${TEST_PREFIX}Lindsay Lingle`));
  });

  it("stores debt-specific fields for mortgage accounts", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: account
        account-type: mortgage
        account-name: "${TEST_PREFIX}Mortgage 5406"
        institution: "[[${TEST_PREFIX}PNC]]"
        held-by: "[[${TEST_PREFIX}Mike Lingle]]"
        status: active
        principal-balance: 528495.19
        interest-rate: "6.25% fixed"
        rate-type: fixed
        monthly-payment: 3946.92
        original-loan-amount: 563200
        origination-date: 2024-12-09
        loan-term: "30 years"
        collateral: "2115 W 261st St"
        deductible: true
        deduction-type: mortgage-interest
        is_canonical: true
        truth_score: verified
        tags:
          - account
          - account/mortgage
        ---

        Body.
      `),
      `/vault/${TEST_PREFIX}pnc-mortgage.md`
    );

    const result = mapAccountToNeo4j(note);
    assert.strictEqual(result.success, true);

    const check = execSync(
      "docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026",
      {
        input: `MATCH (e:Entity {id: "${result.accountId}"}) RETURN e.principal_balance, e.monthly_payment, e.original_balance, e.rate_type, e.collateral, e.deductible, e.loan_term;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.ok(check.includes("528495.19"));
    assert.ok(check.includes("3946.92"));
    assert.ok(check.includes("563200"));
    assert.ok(check.includes("fixed"));
    assert.ok(check.includes("2115 W 261st"));
    assert.ok(check.toUpperCase().includes("TRUE"));
    assert.ok(check.includes("30 years"));
  });

  it("creates Source node with SOURCED_FROM relationship", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: account
        account-type: savings
        account-name: "${TEST_PREFIX}Source Test"
        institution: "[[${TEST_PREFIX}Bank]]"
        held-by: "[[${TEST_PREFIX}Owner]]"
        status: active
        is_canonical: true
        truth_score: unscored
        tags:
          - account
        ---

        Body.
      `),
      `/vault/${TEST_PREFIX}source-acct-test.md`
    );

    const result = mapAccountToNeo4j(note);
    assert.strictEqual(result.success, true);
    assert.ok(
      result.relationshipsCreated.some((r) => r.startsWith("SOURCED_FROM"))
    );

    const check = execSync(
      "docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026",
      {
        input: `MATCH (e:Entity {id: "${result.accountId}"})-[:SOURCED_FROM]->(s:Source) RETURN s.source_type, s.file_path;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.ok(check.includes("obsidian_vault"));
    assert.ok(check.includes(TEST_PREFIX));
  });

  it("creates lender RELATED_TO relationship for loans", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: account
        account-type: loan
        account-name: "${TEST_PREFIX}Auto Loan"
        institution: "[[${TEST_PREFIX}Wells Fargo]]"
        held-by: "[[${TEST_PREFIX}Mike Lingle]]"
        lender: "[[${TEST_PREFIX}Wells Fargo Lending]]"
        status: active
        is_canonical: true
        truth_score: unscored
        tags:
          - account
        ---

        Body.
      `),
      `/vault/${TEST_PREFIX}auto-loan.md`
    );

    const result = mapAccountToNeo4j(note);
    assert.strictEqual(result.success, true);
    assert.ok(
      result.relationshipsCreated.some(
        (r) => r.includes("RELATED_TO") && r.includes("lender")
      )
    );
  });

  it("creates OpenQuestion for conflicted truth score", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: account
        account-type: checking
        account-name: "${TEST_PREFIX}Conflicted Account"
        institution: "[[${TEST_PREFIX}Bank]]"
        held-by: "[[${TEST_PREFIX}Owner]]"
        status: active
        is_canonical: true
        truth_score: conflicted
        tags:
          - account
        ---

        Body.
      `),
      `/vault/${TEST_PREFIX}conflicted-acct.md`
    );

    const result = mapAccountToNeo4j(note);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.openQuestionCreated, true);

    const check = execSync(
      "docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026",
      {
        input: `MATCH (e:Entity {id: "${result.accountId}"})-[:MENTIONS]->(oq:OpenQuestion) RETURN oq.status, oq.question;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.ok(check.includes("open"));
    assert.ok(check.includes("Conflicted truth score"));
  });

  it("is idempotent — running twice produces no duplicates", () => {
    const noteContent = dedent(`
      ---
      type: account
      account-type: savings
      account-name: "${TEST_PREFIX}Idempotent Savings"
      institution: "[[${TEST_PREFIX}Bank]]"
      held-by: "[[${TEST_PREFIX}Owner]]"
      status: active
      is_canonical: true
      truth_score: verified
      tags:
        - account
      ---

      Body.
    `);
    const filePath = `/vault/${TEST_PREFIX}idempotent-acct.md`;

    const note1 = parseNoteString(noteContent, filePath);
    const result1 = mapAccountToNeo4j(note1);
    assert.strictEqual(result1.success, true);

    const note2 = parseNoteString(noteContent, filePath);
    const result2 = mapAccountToNeo4j(note2);
    assert.strictEqual(result2.success, true);

    assert.strictEqual(result1.accountId, result2.accountId);

    const countCheck = execSync(
      "docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026",
      {
        input: `MATCH (e:Entity {id: "${result1.accountId}"}) RETURN count(e) AS cnt;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    const lines = countCheck
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("cnt"));
    assert.ok(lines.some((l) => l.trim() === "1"));
  });

  it("flags stale truth score for re-verification", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: account
        account-type: checking
        account-name: "${TEST_PREFIX}Stale Account"
        institution: "[[${TEST_PREFIX}Bank]]"
        held-by: "[[${TEST_PREFIX}Owner]]"
        status: active
        is_canonical: true
        truth_score: stale
        tags:
          - account
        ---

        Body.
      `),
      `/vault/${TEST_PREFIX}stale-acct.md`
    );

    const result = mapAccountToNeo4j(note);
    assert.strictEqual(result.success, true);

    const check = execSync(
      "docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026",
      {
        input: `MATCH (e:Entity {id: "${result.accountId}"}) RETURN e.needs_reverification;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.ok(check.toUpperCase().includes("TRUE"));
  });

  it("handles wikilinks in body that are not in structured fields", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: account
        account-type: brokerage
        account-name: "${TEST_PREFIX}Wikilink Test"
        institution: "[[${TEST_PREFIX}Wealthfront]]"
        held-by: "[[${TEST_PREFIX}Mike]]"
        status: active
        is_canonical: true
        truth_score: unscored
        tags:
          - account
        ---

        Recommended by [[${TEST_PREFIX}Financial Advisor]].
      `),
      `/vault/${TEST_PREFIX}wikilink-acct.md`
    );

    const result = mapAccountToNeo4j(note);
    assert.strictEqual(result.success, true);
    assert.ok(
      result.relationshipsCreated.some(
        (r) => r.includes("RELATED_TO") && r.includes("Financial Advisor")
      )
    );
  });
});

// ── mapCashFlowToNeo4j (integration — requires Docker + Neo4j) ──────────────

describe("mapCashFlowToNeo4j (integration)", { skip: !HAS_NEO4J }, () => {
  const TEST_PREFIX = "test-us014-cf-";

  function cleanTestData(): void {
    try {
      execSync(
        "docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026",
        {
          input: `MATCH (n) WHERE n.id STARTS WITH "${TEST_PREFIX}" OR n.id STARTS WITH "cf-${TEST_PREFIX}" OR n.id STARTS WITH "source-vault-${TEST_PREFIX}" DETACH DELETE n;`,
          encoding: "utf-8",
          timeout: 10_000,
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
    } catch {
      // Ignore cleanup errors
    }
  }

  beforeEach(() => {
    cleanTestData();
  });

  afterEach(() => {
    cleanTestData();
  });

  it("creates cash flow Entity node with entity_type: cash-flow and correct properties", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: cash-flow
        flow-type: expense
        direction: outflow
        description: "${TEST_PREFIX}Mortgage Payment"
        status: active
        amount: 3946.92
        frequency: monthly
        day-of-month: 1
        category: housing
        tax-deductible: true
        deduction-type: mortgage-interest
        essential: true
        auto-pay: true
        is_canonical: true
        truth_score: verified
        tags:
          - cash-flow
          - cash-flow/expense
          - housing
        ---

        # Mortgage Payment
      `),
      `/vault/${TEST_PREFIX}mortgage-payment.md`
    );

    const result = mapCashFlowToNeo4j(note);
    assert.strictEqual(result.success, true);
    assert.ok(result.cashFlowId.startsWith("cf-"));

    const check = execSync(
      "docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026",
      {
        input: `MATCH (cf:Entity {id: "${result.cashFlowId}"}) RETURN cf.entity_type, cf.flow_type, cf.direction, cf.amount, cf.frequency, cf.tax_deductible, cf.essential, cf.auto_pay;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.ok(check.includes("cash-flow"));
    assert.ok(check.includes("expense"));
    assert.ok(check.includes("outflow"));
    assert.ok(check.includes("3946.92"));
    assert.ok(check.includes("monthly"));
  });

  it("links from-account and to-account via RELATED_TO", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: cash-flow
        flow-type: transfer
        direction: outflow
        description: "${TEST_PREFIX}Savings Transfer"
        status: active
        from-account: "[[${TEST_PREFIX}Checking Account]]"
        to-account: "[[${TEST_PREFIX}Savings Account]]"
        amount: 1000
        frequency: monthly
        is_canonical: true
        truth_score: unscored
        tags:
          - cash-flow
        ---

        Body.
      `),
      `/vault/${TEST_PREFIX}savings-transfer.md`
    );

    const result = mapCashFlowToNeo4j(note);
    assert.strictEqual(result.success, true);
    assert.ok(
      result.relationshipsCreated.some(
        (r) =>
          r.includes("RELATED_TO") &&
          r.includes("from_account") &&
          r.includes("Checking Account")
      )
    );
    assert.ok(
      result.relationshipsCreated.some(
        (r) =>
          r.includes("RELATED_TO") &&
          r.includes("to_account") &&
          r.includes("Savings Account")
      )
    );

    // Verify in Neo4j
    const check = execSync(
      "docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026",
      {
        input: `MATCH (cf:Entity {id: "${result.cashFlowId}"})-[r:RELATED_TO]->(target) RETURN r.type, target.name ORDER BY r.type;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.ok(check.includes("from_account"));
    assert.ok(check.includes("to_account"));
  });

  it("links from-entity and to-entity via RELATED_TO", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: cash-flow
        flow-type: income
        direction: inflow
        description: "${TEST_PREFIX}Salary Payment"
        status: active
        from-entity: "[[${TEST_PREFIX}GIX Inc]]"
        to-entity: "[[${TEST_PREFIX}Mike Lingle]]"
        amount: 15000
        frequency: semi-monthly
        is_canonical: true
        truth_score: verified
        tags:
          - cash-flow
        ---

        Body.
      `),
      `/vault/${TEST_PREFIX}salary.md`
    );

    const result = mapCashFlowToNeo4j(note);
    assert.strictEqual(result.success, true);
    assert.ok(
      result.relationshipsCreated.some(
        (r) => r.includes("from_entity") && r.includes("GIX Inc")
      )
    );
    assert.ok(
      result.relationshipsCreated.some(
        (r) => r.includes("to_entity") && r.includes("Mike Lingle")
      )
    );
  });

  it("links linked-debt and linked-investment via RELATED_TO", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: cash-flow
        flow-type: debt-service
        direction: outflow
        description: "${TEST_PREFIX}Debt Payment"
        status: active
        linked-debt: "[[${TEST_PREFIX}PNC Mortgage]]"
        linked-investment: "[[${TEST_PREFIX}Indiana Farm]]"
        amount: 3946.92
        frequency: monthly
        is_canonical: true
        truth_score: unscored
        tags:
          - cash-flow
        ---

        Body.
      `),
      `/vault/${TEST_PREFIX}debt-payment.md`
    );

    const result = mapCashFlowToNeo4j(note);
    assert.strictEqual(result.success, true);
    assert.ok(
      result.relationshipsCreated.some(
        (r) => r.includes("linked_debt") && r.includes("PNC Mortgage")
      )
    );
    assert.ok(
      result.relationshipsCreated.some(
        (r) => r.includes("linked_investment") && r.includes("Indiana Farm")
      )
    );
  });

  it("creates Source node with SOURCED_FROM for cash flow", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: cash-flow
        flow-type: expense
        direction: outflow
        description: "${TEST_PREFIX}Source Test CF"
        status: active
        amount: 100
        frequency: monthly
        is_canonical: true
        truth_score: unscored
        tags:
          - cash-flow
        ---

        Body.
      `),
      `/vault/${TEST_PREFIX}source-cf-test.md`
    );

    const result = mapCashFlowToNeo4j(note);
    assert.strictEqual(result.success, true);
    assert.ok(
      result.relationshipsCreated.some((r) => r.startsWith("SOURCED_FROM"))
    );

    const check = execSync(
      "docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026",
      {
        input: `MATCH (cf:Entity {id: "${result.cashFlowId}"})-[:SOURCED_FROM]->(s:Source) RETURN s.source_type;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.ok(check.includes("obsidian_vault"));
  });

  it("is idempotent — running twice produces no duplicates", () => {
    const noteContent = dedent(`
      ---
      type: cash-flow
      flow-type: expense
      direction: outflow
      description: "${TEST_PREFIX}Idempotent CF"
      status: active
      from-account: "[[${TEST_PREFIX}Checking]]"
      amount: 500
      frequency: monthly
      is_canonical: true
      truth_score: verified
      tags:
        - cash-flow
      ---

      Body.
    `);
    const filePath = `/vault/${TEST_PREFIX}idempotent-cf.md`;

    const note1 = parseNoteString(noteContent, filePath);
    const result1 = mapCashFlowToNeo4j(note1);
    assert.strictEqual(result1.success, true);

    const note2 = parseNoteString(noteContent, filePath);
    const result2 = mapCashFlowToNeo4j(note2);
    assert.strictEqual(result2.success, true);

    assert.strictEqual(result1.cashFlowId, result2.cashFlowId);

    const countCheck = execSync(
      "docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026",
      {
        input: `MATCH (cf:Entity {id: "${result1.cashFlowId}"}) RETURN count(cf) AS cnt;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    const lines = countCheck
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("cnt"));
    assert.ok(lines.some((l) => l.trim() === "1"));
  });

  it("handles all optional cash flow fields gracefully", () => {
    const note = parseNoteString(
      dedent(`
        ---
        type: cash-flow
        flow-type: one-time
        direction: outflow
        description: "${TEST_PREFIX}Minimal CF"
        status: projected
        is_canonical: false
        truth_score: unscored
        tags:
          - cash-flow
        ---

        Body.
      `),
      `/vault/${TEST_PREFIX}minimal-cf.md`
    );

    const result = mapCashFlowToNeo4j(note);
    assert.strictEqual(result.success, true);

    const check = execSync(
      "docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026",
      {
        input: `MATCH (cf:Entity {id: "${result.cashFlowId}"}) RETURN cf.entity_type, cf.flow_type, cf.status;`,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.ok(check.includes("cash-flow"));
    assert.ok(check.includes("one-time"));
    assert.ok(check.includes("projected"));
  });
});
