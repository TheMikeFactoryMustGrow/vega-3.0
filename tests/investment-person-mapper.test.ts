/**
 * Unit and integration tests for the Investment & Person mapper (US-015).
 *
 * Tests pure functions (ID generation, type checking) and mapper logic
 * with mock and real Neo4j backends.
 *
 * Run: npx tsx --test tests/investment-person-mapper.test.ts
 */

import { describe, it, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import {
  generateBetId,
  generatePositionId,
  generatePersonId,
  mapInvestmentDealToNeo4j,
  mapInvestmentDealNoteString,
  mapInvestmentPositionToNeo4j,
  mapInvestmentPositionNoteString,
  mapPersonToNeo4j,
  mapPersonNoteString,
} from "../src/investment-person-mapper.js";
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

// ── generateBetId ────────────────────────────────────────────────────────────

describe("generateBetId", () => {
  it("generates ID from file path with bet- prefix", () => {
    const id = generateBetId("/vault/WE/Deals/4DX I.md", null);
    assert.strictEqual(id, "bet-4dx-i");
  });

  it("generates ID from asset name when no file path", () => {
    const id = generateBetId(null, "Cooler Screens");
    assert.strictEqual(id, "bet-cooler-screens");
  });

  it("prefers file path over asset name", () => {
    const id = generateBetId("/vault/Deal.md", "Different Name");
    assert.strictEqual(id, "bet-deal");
  });

  it("handles null both arguments with fallback", () => {
    const id = generateBetId(null, null);
    assert.ok(id.startsWith("bet-"));
  });
});

// ── generatePositionId ──────────────────────────────────────────────────────

describe("generatePositionId", () => {
  it("generates ID from file path with pos- prefix", () => {
    const id = generatePositionId(
      "/vault/Finance/Positions/4DX I - Lingle Position.md",
      null
    );
    assert.strictEqual(id, "pos-4dx-i-lingle-position");
  });

  it("generates ID from asset name when no file path", () => {
    const id = generatePositionId(null, "PCT - Mike Position");
    assert.strictEqual(id, "pos-pct-mike-position");
  });

  it("handles null both arguments with fallback", () => {
    const id = generatePositionId(null, null);
    assert.ok(id.startsWith("pos-"));
  });
});

// ── generatePersonId ─────────────────────────────────────────────────────────

describe("generatePersonId", () => {
  it("generates ID from file path (filename slug, no prefix)", () => {
    const id = generatePersonId("/vault/People/Colin Anderson.md", null);
    assert.strictEqual(id, "colin-anderson");
  });

  it("generates ID from name when no file path", () => {
    const id = generatePersonId(null, "Steve Manos");
    assert.strictEqual(id, "steve-manos");
  });

  it("handles special characters", () => {
    const id = generatePersonId("/vault/People/Arthur McMahon III.md", null);
    assert.strictEqual(id, "arthur-mcmahon-iii");
  });

  it("handles null both arguments with fallback", () => {
    const id = generatePersonId(null, null);
    assert.ok(id.startsWith("person-"));
  });
});

// ── mapInvestmentDealNoteString — type rejection ─────────────────────────────

describe("mapInvestmentDealNoteString — type rejection", () => {
  it("rejects non-investment notes", () => {
    const content = dedent(`
      ---
      type: entity
      name: Tiger93 LLC
      ---
      Body text.
    `);
    const result = mapInvestmentDealNoteString(content, "/vault/entity.md");
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("Not an investment deal note"));
  });

  it("rejects position notes (personal perspective)", () => {
    const content = dedent(`
      ---
      type: investment
      perspective: personal
      asset-name: "4DX I - Lingle Position"
      ---
      Body text.
    `);
    const result = mapInvestmentDealNoteString(content, "/vault/pos.md");
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("Not an investment deal note"));
  });
});

// ── mapInvestmentPositionNoteString — type rejection ─────────────────────────

describe("mapInvestmentPositionNoteString — type rejection", () => {
  it("rejects non-investment notes", () => {
    const content = dedent(`
      ---
      type: person
      name: Mike Lingle
      ---
      Body text.
    `);
    const result = mapInvestmentPositionNoteString(content, "/vault/person.md");
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("Not an investment position note"));
  });

  it("rejects deal notes (deal perspective)", () => {
    const content = dedent(`
      ---
      type: investment
      perspective: deal
      asset-name: "4DX I"
      ---
      Body text.
    `);
    const result = mapInvestmentPositionNoteString(content, "/vault/deal.md");
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("Not an investment position note"));
  });
});

// ── mapPersonNoteString — type rejection ─────────────────────────────────────

describe("mapPersonNoteString — type rejection", () => {
  it("rejects non-person notes", () => {
    const content = dedent(`
      ---
      type: account
      account-name: Chase Checking
      ---
      Body text.
    `);
    const result = mapPersonNoteString(content, "/vault/account.md");
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("Not a person note"));
  });
});

// ── Integration tests (require Neo4j) ────────────────────────────────────────

function neo4jAvailable(): boolean {
  try {
    execSync(
      'docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026',
      { input: "RETURN 1;", encoding: "utf-8", timeout: 5_000, stdio: ["pipe", "pipe", "pipe"] }
    );
    return true;
  } catch {
    return false;
  }
}

function runCypher(query: string): string {
  return execSync(
    'docker exec -i linglepedia cypher-shell -u neo4j -p lingelpedia2026',
    { input: query, encoding: "utf-8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] }
  ).trim();
}

function cleanupNodes(ids: string[]): void {
  for (const id of ids) {
    try {
      runCypher(`MATCH (n {id: "${id}"}) DETACH DELETE n;`);
    } catch {
      // ignore cleanup failures
    }
  }
}

// ── Investment Deal Integration Tests ────────────────────────────────────────

describe("mapInvestmentDealToNeo4j — integration", { skip: !neo4jAvailable() }, () => {
  const testIds: string[] = [];

  afterEach(() => {
    cleanupNodes(testIds);
    testIds.length = 0;
  });

  it("creates a Bet node with correct properties", () => {
    const content = dedent(`
      ---
      type: investment
      perspective: deal
      asset-name: "Test Deal Alpha"
      asset-class: private-equity
      status: active
      deal-sponsor: "[[Test Sponsor LLC]]"
      vehicle: "[[Test Vehicle LLC]]"
      vintage-year: "2024"
      projected-irr: "15%"
      projected-moic: "2.5x"
      source-system: juniper-square
      investment-origin: we
      is_canonical: true
      truth_score: unscored
      tags:
        - investment
        - we
      ---
      # Test Deal Alpha
    `);
    const note = parseNoteString(content, "/vault/WE/Deals/Test Deal Alpha.md");
    const result = mapInvestmentDealToNeo4j(note);
    testIds.push(result.betId, result.sourceId, "test-sponsor-llc", "test-vehicle-llc");

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.betId, "bet-test-deal-alpha");
    assert.strictEqual(result.nodeProperties.bet_type, "intentional");

    // Verify node exists in Neo4j
    const betOut = runCypher(`MATCH (b:Bet {id: "${result.betId}"}) RETURN b.name, b.bet_type, b.asset_class, b.projected_irr;`);
    assert.ok(betOut.includes("Test Deal Alpha"));
    assert.ok(betOut.includes("intentional"));
    assert.ok(betOut.includes("private-equity"));
    assert.ok(betOut.includes("15%"));

    // Verify SOURCED_FROM relationship
    const srcOut = runCypher(`MATCH (b:Bet {id: "${result.betId}"})-[:SOURCED_FROM]->(s:Source) RETURN s.source_type;`);
    assert.ok(srcOut.includes("obsidian_vault"));

    // Verify deal-sponsor RELATED_TO
    assert.ok(result.relationshipsCreated.some(r => r.includes("deal_sponsor")));
    const sponsorOut = runCypher(`MATCH (b:Bet {id: "${result.betId}"})-[r:RELATED_TO]->(e:Entity {id: "test-sponsor-llc"}) RETURN r.type;`);
    assert.ok(sponsorOut.includes("deal_sponsor"));

    // Verify vehicle RELATED_TO
    assert.ok(result.relationshipsCreated.some(r => r.includes("vehicle")));
    const vehicleOut = runCypher(`MATCH (b:Bet {id: "${result.betId}"})-[r:RELATED_TO]->(e:Entity {id: "test-vehicle-llc"}) RETURN r.type, e.entity_type;`);
    assert.ok(vehicleOut.includes("vehicle"));
  });

  it("is idempotent — running twice produces exactly one Bet node", () => {
    const content = dedent(`
      ---
      type: investment
      perspective: deal
      asset-name: "Idempotent Deal"
      asset-class: venture
      status: active
      is_canonical: true
      truth_score: unscored
      tags:
        - investment
      ---
      # Idempotent Deal
    `);
    const note = parseNoteString(content, "/vault/Idempotent Deal.md");
    const r1 = mapInvestmentDealToNeo4j(note);
    testIds.push(r1.betId, r1.sourceId);
    assert.strictEqual(r1.success, true);

    const r2 = mapInvestmentDealToNeo4j(note);
    assert.strictEqual(r2.success, true);

    const countOut = runCypher(`MATCH (b:Bet {id: "${r1.betId}"}) RETURN count(b);`);
    assert.ok(countOut.includes("1"));
  });

  it("handles conflicted truth score — creates OpenQuestion", () => {
    const content = dedent(`
      ---
      type: investment
      perspective: deal
      asset-name: "Conflicted Deal"
      asset-class: pe
      status: active
      is_canonical: true
      truth_score: conflicted
      tags:
        - investment
      ---
      # Conflicted Deal
    `);
    const note = parseNoteString(content, "/vault/Conflicted Deal.md");
    const result = mapInvestmentDealToNeo4j(note);
    testIds.push(result.betId, result.sourceId, `oq-${result.betId}-conflicted`);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.openQuestionCreated, true);

    const oqOut = runCypher(`MATCH (b:Bet {id: "${result.betId}"})-[:MENTIONS]->(oq:OpenQuestion) RETURN oq.status;`);
    assert.ok(oqOut.includes("open"));
  });
});

// ── Investment Position Integration Tests ────────────────────────────────────

describe("mapInvestmentPositionToNeo4j — integration", { skip: !neo4jAvailable() }, () => {
  const testIds: string[] = [];

  afterEach(() => {
    cleanupNodes(testIds);
    testIds.length = 0;
  });

  it("creates a position Entity and links to Deal Bet via STAKED_ON", () => {
    const content = dedent(`
      ---
      type: investment
      perspective: personal
      asset-name: "Test Position Alpha"
      asset-class: private-equity
      status: active
      deal: "[[Test Deal Alpha]]"
      held-by: "[[Test Holder]]"
      held-alongside: "[[WE LLC]]"
      cost-basis: 50000
      current-value: 75000
      ownership-pct: "5%"
      distributions-received: 2000
      k1-entity: "[[Test Vehicle LLC]]"
      tax-character: mixed
      liquidity: illiquid
      investment-origin: we
      is_canonical: true
      truth_score: unscored
      tags:
        - investment
        - personal
      ---
      # Test Position Alpha
    `);
    const note = parseNoteString(content, "/vault/Finance/Positions/Test Position Alpha.md");
    const result = mapInvestmentPositionToNeo4j(note);
    testIds.push(result.positionId, result.sourceId, "bet-test-deal-alpha", "test-holder", "we-llc", "test-vehicle-llc");

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.positionId, "pos-test-position-alpha");

    // Verify Entity node
    const posOut = runCypher(`MATCH (p:Entity {id: "${result.positionId}"}) RETURN p.entity_type, p.cost_basis, p.current_value;`);
    assert.ok(posOut.includes("investment-position"));
    assert.ok(posOut.includes("50000"));
    assert.ok(posOut.includes("75000"));

    // Verify STAKED_ON to Bet
    assert.ok(result.relationshipsCreated.some(r => r.includes("STAKED_ON")));
    const stakedOut = runCypher(`MATCH (p:Entity {id: "${result.positionId}"})-[:STAKED_ON]->(b:Bet) RETURN b.id;`);
    assert.ok(stakedOut.includes("bet-test-deal-alpha"));

    // Verify BELONGS_TO to held-by
    assert.ok(result.relationshipsCreated.some(r => r.includes("BELONGS_TO")));
    const heldByOut = runCypher(`MATCH (p:Entity {id: "${result.positionId}"})-[:BELONGS_TO]->(h:Entity) RETURN h.id;`);
    assert.ok(heldByOut.includes("test-holder"));

    // Verify held-alongside RELATED_TO
    const alongsideOut = runCypher(`MATCH (p:Entity {id: "${result.positionId}"})-[r:RELATED_TO {type: "held_alongside"}]->(e:Entity) RETURN e.id;`);
    assert.ok(alongsideOut.includes("we-llc"));

    // Verify k1-entity RELATED_TO
    const k1Out = runCypher(`MATCH (p:Entity {id: "${result.positionId}"})-[r:RELATED_TO {type: "k1_entity"}]->(e:Entity) RETURN e.id;`);
    assert.ok(k1Out.includes("test-vehicle-llc"));
  });

  it("handles direct investment position (no deal backlink)", () => {
    const content = dedent(`
      ---
      type: investment
      perspective: personal
      asset-name: "Direct Stock Position"
      asset-class: public-equity
      status: active
      deal:
      held-by: "[[Mike Lingle]]"
      ticker: PCT
      exchange: NYSE
      shares: 10000
      current-value: 60000
      liquidity: locked
      lock-up-end: 2026-03-15
      custodian: "[[Continental Stock Transfer]]"
      investment-origin: direct
      is_canonical: true
      truth_score: unscored
      tags:
        - investment
        - personal
      ---
      # Direct Stock Position
    `);
    const note = parseNoteString(content, "/vault/Finance/Positions/Direct Stock Position.md");
    const result = mapInvestmentPositionToNeo4j(note);
    testIds.push(result.positionId, result.sourceId, "mike-lingle", "continental-stock-transfer");

    assert.strictEqual(result.success, true);

    // Verify no STAKED_ON (deal is empty)
    assert.ok(!result.relationshipsCreated.some(r => r.includes("STAKED_ON")));

    // Verify ticker and exchange
    const posOut = runCypher(`MATCH (p:Entity {id: "${result.positionId}"}) RETURN p.ticker, p.exchange, p.lock_up_end;`);
    assert.ok(posOut.includes("PCT"));
    assert.ok(posOut.includes("NYSE"));

    // Verify custodian linked as institution
    const custOut = runCypher(`MATCH (p:Entity {id: "${result.positionId}"})-[r:RELATED_TO {type: "custodian"}]->(e:Entity) RETURN e.entity_type;`);
    assert.ok(custOut.includes("institution"));
  });

  it("is idempotent — running twice produces exactly one position node", () => {
    const content = dedent(`
      ---
      type: investment
      perspective: personal
      asset-name: "Idempotent Position"
      asset-class: pe
      status: active
      is_canonical: true
      truth_score: unscored
      tags:
        - investment
      ---
      # Idempotent Position
    `);
    const note = parseNoteString(content, "/vault/Idempotent Position.md");
    const r1 = mapInvestmentPositionToNeo4j(note);
    testIds.push(r1.positionId, r1.sourceId);
    assert.strictEqual(r1.success, true);

    const r2 = mapInvestmentPositionToNeo4j(note);
    assert.strictEqual(r2.success, true);

    const countOut = runCypher(`MATCH (p:Entity {id: "${r1.positionId}"}) RETURN count(p);`);
    assert.ok(countOut.includes("1"));
  });

  it("handles stale truth score — flags for re-verification", () => {
    const content = dedent(`
      ---
      type: investment
      perspective: personal
      asset-name: "Stale Position"
      asset-class: pe
      status: active
      is_canonical: true
      truth_score: stale
      tags:
        - investment
      ---
    `);
    const note = parseNoteString(content, "/vault/Stale Position.md");
    const result = mapInvestmentPositionToNeo4j(note);
    testIds.push(result.positionId, result.sourceId);

    assert.strictEqual(result.success, true);
    const flagOut = runCypher(`MATCH (p:Entity {id: "${result.positionId}"}) RETURN p.needs_reverification;`);
    assert.ok(flagOut.toUpperCase().includes("TRUE"));
  });
});

// ── Person Integration Tests ─────────────────────────────────────────────────

describe("mapPersonToNeo4j — integration", { skip: !neo4jAvailable() }, () => {
  const testIds: string[] = [];

  afterEach(() => {
    cleanupNodes(testIds);
    testIds.length = 0;
  });

  it("creates a Person Entity with correct properties", () => {
    const content = dedent(`
      ---
      type: person
      name: Test Person Alpha
      aliases:
        - TPA
        - Alpha
      role: Test Engineer
      company: "Test Corp"
      location: "Chicago, IL"
      email: "test@example.com"
      relationship: colleague
      circle: active
      status: active
      contact-frequency: 30
      is_canonical: true
      truth_score: unscored
      tags:
        - person
        - person/colleague
      ---
      # Test Person Alpha

      Works with [[Another Person]] on projects.
    `);
    const note = parseNoteString(content, "/vault/People/Test Person Alpha.md");
    const result = mapPersonToNeo4j(note);
    testIds.push(result.personId, result.sourceId, "test-corp", "another-person");

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.personId, "test-person-alpha");

    // Verify node
    const personOut = runCypher(`MATCH (e:Entity {id: "${result.personId}"}) RETURN e.entity_type, e.relationship, e.circle, e.contact_frequency, e.email;`);
    assert.ok(personOut.includes("person"));
    assert.ok(personOut.includes("colleague"));
    assert.ok(personOut.includes("active"));
    assert.ok(personOut.includes("30"));
    assert.ok(personOut.includes("test@example.com"));

    // Verify aliases
    const aliasOut = runCypher(`MATCH (e:Entity {id: "${result.personId}"}) RETURN e.aliases;`);
    assert.ok(aliasOut.includes("TPA"));
    assert.ok(aliasOut.includes("Alpha"));

    // Verify SOURCED_FROM
    const srcOut = runCypher(`MATCH (e:Entity {id: "${result.personId}"})-[:SOURCED_FROM]->(s:Source) RETURN s.source_type;`);
    assert.ok(srcOut.includes("obsidian_vault"));

    // Verify company RELATED_TO {works_at}
    const compOut = runCypher(`MATCH (e:Entity {id: "${result.personId}"})-[r:RELATED_TO {type: "works_at"}]->(c:Entity) RETURN c.name;`);
    assert.ok(compOut.includes("Test Corp"));

    // Verify wikilink RELATED_TO for body links
    const wikiOut = runCypher(`MATCH (e:Entity {id: "${result.personId}"})-[:RELATED_TO]->(linked:Entity {id: "another-person"}) RETURN linked.name;`);
    assert.ok(wikiOut.includes("Another Person"));
  });

  it("creates family relationships (spouse, parent, child, sibling)", () => {
    const content = dedent(`
      ---
      type: person
      name: Test Family Person
      relationship: family
      circle: inner
      status: active
      spouse: "[[Test Spouse]]"
      parent:
        - "[[Test Parent One]]"
        - "[[Test Parent Two]]"
      child:
        - "[[Test Child]]"
      sibling:
        - "[[Test Sibling]]"
      is_canonical: true
      truth_score: unscored
      tags:
        - person
      ---
      # Test Family Person
    `);
    const note = parseNoteString(content, "/vault/People/Test Family Person.md");
    const result = mapPersonToNeo4j(note);
    testIds.push(result.personId, result.sourceId, "test-spouse", "test-parent-one", "test-parent-two", "test-child", "test-sibling");

    assert.strictEqual(result.success, true);

    // Verify spouse
    const spouseOut = runCypher(`MATCH (e:Entity {id: "${result.personId}"})-[r:RELATED_TO {type: "spouse"}]->(s:Entity) RETURN s.name;`);
    assert.ok(spouseOut.includes("Test Spouse"));

    // Verify parents
    const parentOut = runCypher(`MATCH (e:Entity {id: "${result.personId}"})-[r:RELATED_TO {type: "parent"}]->(p:Entity) RETURN p.name;`);
    assert.ok(parentOut.includes("Test Parent One"));
    assert.ok(parentOut.includes("Test Parent Two"));

    // Verify child
    const childOut = runCypher(`MATCH (e:Entity {id: "${result.personId}"})-[r:RELATED_TO {type: "child"}]->(c:Entity) RETURN c.name;`);
    assert.ok(childOut.includes("Test Child"));

    // Verify sibling
    const siblingOut = runCypher(`MATCH (e:Entity {id: "${result.personId}"})-[r:RELATED_TO {type: "sibling"}]->(s:Entity) RETURN s.name;`);
    assert.ok(siblingOut.includes("Test Sibling"));

    // Family members should be created as person entity_type
    const spouseTypeOut = runCypher(`MATCH (e:Entity {id: "test-spouse"}) RETURN e.entity_type;`);
    assert.ok(spouseTypeOut.includes("person"));
  });

  it("creates financial-role relationships", () => {
    const content = dedent(`
      ---
      type: person
      name: Test FinRole Person
      relationship: family
      circle: inner
      status: active
      financial-roles:
        - role: ceo
          entity: "[[Test Company LLC]]"
        - role: shareholder
          entity: "[[WE LLC]]"
      is_canonical: true
      truth_score: unscored
      tags:
        - person
      ---
    `);
    const note = parseNoteString(content, "/vault/People/Test FinRole Person.md");
    const result = mapPersonToNeo4j(note);
    testIds.push(result.personId, result.sourceId, "test-company-llc", "we-llc");

    assert.strictEqual(result.success, true);

    // Verify financial role relationships
    const roleOut = runCypher(`MATCH (e:Entity {id: "${result.personId}"})-[r:RELATED_TO {type: "financial_role"}]->(ent:Entity) RETURN ent.name, r.role ORDER BY ent.name;`);
    assert.ok(roleOut.includes("Test Company LLC"));
    assert.ok(roleOut.includes("ceo"));
    assert.ok(roleOut.includes("WE LLC"));
    assert.ok(roleOut.includes("shareholder"));
  });

  it("creates trust and advisor relationships", () => {
    const content = dedent(`
      ---
      type: person
      name: Test Advisor Person
      relationship: family
      circle: inner
      status: active
      trusts:
        - "[[Test Trust A]]"
        - "[[Test Trust B]]"
      cpa: "[[Test CPA Firm]]"
      estate-attorney: "[[Test Law Firm]]"
      is_canonical: true
      truth_score: unscored
      tags:
        - person
      ---
    `);
    const note = parseNoteString(content, "/vault/People/Test Advisor Person.md");
    const result = mapPersonToNeo4j(note);
    testIds.push(result.personId, result.sourceId, "test-trust-a", "test-trust-b", "test-cpa-firm", "test-law-firm");

    assert.strictEqual(result.success, true);

    // Verify trusts
    const trustOut = runCypher(`MATCH (e:Entity {id: "${result.personId}"})-[r:RELATED_TO {type: "trust_beneficiary"}]->(t:Entity) RETURN t.name ORDER BY t.name;`);
    assert.ok(trustOut.includes("Test Trust A"));
    assert.ok(trustOut.includes("Test Trust B"));

    // Verify CPA
    const cpaOut = runCypher(`MATCH (e:Entity {id: "${result.personId}"})-[r:RELATED_TO {type: "cpa"}]->(c:Entity) RETURN c.name, c.entity_type;`);
    assert.ok(cpaOut.includes("Test CPA Firm"));
    assert.ok(cpaOut.includes("institution"));

    // Verify estate attorney
    const attyOut = runCypher(`MATCH (e:Entity {id: "${result.personId}"})-[r:RELATED_TO {type: "estate_attorney"}]->(a:Entity) RETURN a.name;`);
    assert.ok(attyOut.includes("Test Law Firm"));
  });

  it("is idempotent — running twice produces exactly one person node", () => {
    const content = dedent(`
      ---
      type: person
      name: Idempotent Person
      relationship: colleague
      circle: active
      status: active
      is_canonical: true
      truth_score: unscored
      tags:
        - person
      ---
    `);
    const note = parseNoteString(content, "/vault/Idempotent Person.md");
    const r1 = mapPersonToNeo4j(note);
    testIds.push(r1.personId, r1.sourceId);
    assert.strictEqual(r1.success, true);

    const r2 = mapPersonToNeo4j(note);
    assert.strictEqual(r2.success, true);

    const countOut = runCypher(`MATCH (e:Entity {id: "${r1.personId}"}) RETURN count(e);`);
    assert.ok(countOut.includes("1"));
  });

  it("handles conflicted truth score — creates OpenQuestion", () => {
    const content = dedent(`
      ---
      type: person
      name: Conflicted Person
      relationship: advisor
      circle: active
      status: active
      is_canonical: true
      truth_score: conflicted
      tags:
        - person
      ---
    `);
    const note = parseNoteString(content, "/vault/People/Conflicted Person.md");
    const result = mapPersonToNeo4j(note);
    testIds.push(result.personId, result.sourceId, `oq-${result.personId}-conflicted`);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.openQuestionCreated, true);

    const oqOut = runCypher(`MATCH (e:Entity {id: "${result.personId}"})-[:MENTIONS]->(oq:OpenQuestion) RETURN oq.status;`);
    assert.ok(oqOut.includes("open"));
  });

  it("handles agent-populated truth score", () => {
    const content = dedent(`
      ---
      type: person
      name: AgentPop Person
      relationship: partner
      circle: trusted
      status: active
      is_canonical: true
      truth_score: agent-populated
      tags:
        - person
      ---
    `);
    const note = parseNoteString(content, "/vault/People/AgentPop Person.md");
    const result = mapPersonToNeo4j(note);
    testIds.push(result.personId, result.sourceId);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.nodeProperties.truth_score, 0.7);
  });
});
