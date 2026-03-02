/**
 * Unit tests for the YAML frontmatter parser (US-012).
 *
 * Covers all template types: Entity, Account, Investment (Deal),
 * Investment (Personal Position), Cash Flow, Person, Institution, Vehicle.
 *
 * Run: npx tsx --test tests/frontmatter-parser.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  parseNoteString,
  extractWikilinks,
} from "../src/frontmatter-parser.js";

// ── Helper ───────────────────────────────────────────────────────────────────

function dedent(s: string): string {
  // Remove leading newline and common leading whitespace
  const lines = s.replace(/^\n/, "").split("\n");
  const minIndent = lines
    .filter((l) => l.trim().length > 0)
    .reduce((min, l) => {
      const m = l.match(/^(\s*)/);
      return Math.min(min, m ? m[1].length : 0);
    }, Infinity);
  return lines.map((l) => l.slice(minIndent)).join("\n");
}

// ── extractWikilinks ─────────────────────────────────────────────────────────

describe("extractWikilinks", () => {
  it("extracts simple wikilinks", () => {
    const links = extractWikilinks("Held by [[Mike Lingle]] at [[Chase]]");
    assert.deepStrictEqual(links, ["Mike Lingle", "Chase"]);
  });

  it("handles aliased wikilinks (returns target, not display name)", () => {
    const links = extractWikilinks("See [[Harrison Lingle|Harrison]]");
    assert.deepStrictEqual(links, ["Harrison Lingle"]);
  });

  it("deduplicates wikilinks", () => {
    const links = extractWikilinks("[[Chase]] is great. We use [[Chase]].");
    assert.deepStrictEqual(links, ["Chase"]);
  });

  it("returns empty array for text without wikilinks", () => {
    const links = extractWikilinks("No links here.");
    assert.deepStrictEqual(links, []);
  });

  it("handles wikilinks with spaces and special characters", () => {
    const links = extractWikilinks(
      "Owned by [[Wasson Enterprise LLC]] and [[Lingle Family Dynasty Trust]]"
    );
    assert.deepStrictEqual(links, [
      "Wasson Enterprise LLC",
      "Lingle Family Dynasty Trust",
    ]);
  });
});

// ── Entity Template ──────────────────────────────────────────────────────────

describe("Entity template", () => {
  const entityNote = dedent(`
    ---
    type: entity
    subtype: trust-irrevocable
    legal-name: "Gregory D. Wasson and Kim R. Wasson Irrevocable Trust"
    aliases: ["Wasson Family 2015 GST Trust", "Wasson GST Trust"]
    status: active
    state: IL
    purpose: "Irrevocable generation-skipping trust"
    grantor: "[[Greg Wasson]]"
    trustees:
      - "[[Lindsay Lingle]]"
    beneficiaries:
      - "[[Lindsay Lingle]]"
    owned-by:
      - "[[Greg Wasson]] (grantor)"
      - "[[Kim Wasson]] (grantor)"
    tax-treatment: non-grantor-trust
    tax-year-end: "12/31"
    k1-issuer: false
    cpa: "[[Plante Moran]]"
    attorney: "[[Schiff Hardin]]"
    trust-date: 2015-06-23
    trust-state: IL
    irrevocable-type: dynasty
    is_canonical: true
    truth_score: unscored
    last_verified:
    verification_source: ""
    tags:
      - entity
      - entity/trust-irrevocable
      - family
      - estate-planning
      - lingelpedia/canonical
    ---

    # Wasson Family 2015 GST Trust

    Irrevocable trust established by [[Greg Wasson]] and [[Kim Wasson]].
    [[Lindsay Lingle]] is the sole trustee.
  `);

  it("identifies entity template type", () => {
    const result = parseNoteString(entityNote);
    assert.strictEqual(result.templateType, "entity");
  });

  it("parses required entity fields", () => {
    const result = parseNoteString(entityNote);
    assert.strictEqual(result.frontmatter["subtype"], "trust-irrevocable");
    assert.strictEqual(
      result.frontmatter["legal-name"],
      "Gregory D. Wasson and Kim R. Wasson Irrevocable Trust"
    );
    assert.strictEqual(result.frontmatter["status"], "active");
  });

  it("parses optional entity fields", () => {
    const result = parseNoteString(entityNote);
    assert.strictEqual(result.frontmatter["state"], "IL");
    assert.strictEqual(
      result.frontmatter["tax-treatment"],
      "non-grantor-trust"
    );
    assert.strictEqual(result.frontmatter["k1-issuer"], false);
    assert.strictEqual(result.frontmatter["irrevocable-type"], "dynasty");
  });

  it("parses aliases as array", () => {
    const result = parseNoteString(entityNote);
    const aliases = result.frontmatter["aliases"] as string[];
    assert.ok(Array.isArray(aliases));
    assert.strictEqual(aliases.length, 2);
    assert.ok(aliases.includes("Wasson Family 2015 GST Trust"));
  });

  it("parses ownership list with wikilinks", () => {
    const result = parseNoteString(entityNote);
    const ownedBy = result.frontmatter["owned-by"] as string[];
    assert.ok(Array.isArray(ownedBy));
    assert.strictEqual(ownedBy.length, 2);
    assert.ok(ownedBy[0].includes("[[Greg Wasson]]"));
  });

  it("extracts frontmatter wikilinks", () => {
    const result = parseNoteString(entityNote);
    assert.ok(result.frontmatterWikilinks.includes("Greg Wasson"));
    assert.ok(result.frontmatterWikilinks.includes("Lindsay Lingle"));
    assert.ok(result.frontmatterWikilinks.includes("Plante Moran"));
    assert.ok(result.frontmatterWikilinks.includes("Schiff Hardin"));
    assert.ok(result.frontmatterWikilinks.includes("Kim Wasson"));
  });

  it("extracts body wikilinks", () => {
    const result = parseNoteString(entityNote);
    assert.ok(result.bodyWikilinks.includes("Greg Wasson"));
    assert.ok(result.bodyWikilinks.includes("Kim Wasson"));
    assert.ok(result.bodyWikilinks.includes("Lindsay Lingle"));
  });

  it("parses lingelpedia fields", () => {
    const result = parseNoteString(entityNote);
    assert.strictEqual(result.frontmatter.is_canonical, true);
    assert.strictEqual(result.frontmatter.truth_score, "unscored");
  });

  it("parses tags as array", () => {
    const result = parseNoteString(entityNote);
    const tags = result.frontmatter["tags"] as string[];
    assert.ok(Array.isArray(tags));
    assert.ok(tags.includes("entity"));
    assert.ok(tags.includes("entity/trust-irrevocable"));
    assert.ok(tags.includes("lingelpedia/canonical"));
  });
});

// ── Account Template ─────────────────────────────────────────────────────────

describe("Account template", () => {
  const accountNote = dedent(`
    ---
    type: account
    account-type: checking
    account-name: "College Checking 1622"
    institution: "[[Chase]]"
    held-by: "[[Mike Lingle]]"
    joint-holders: ["[[Lindsay Lingle]]"]
    account-number-last4: "1622"
    status: active
    purpose: household-operations
    currency: USD
    source-system: chase.com
    plaid-connected: true
    is_canonical: true
    truth_score: agent-populated
    last_verified: 2026-03-01
    verification_source: "agent schema audit 2026-03-01"
    tags:
      - account
      - account/checking
      - household
      - lingelpedia/canonical
      - lingelpedia/agent-populated
    ---

    # Chase - College Checking 1622

    Household operations and bills checking account.
    Held by [[Mike Lingle]] and [[Lindsay Lingle]].
  `);

  it("identifies account template type", () => {
    const result = parseNoteString(accountNote);
    assert.strictEqual(result.templateType, "account");
  });

  it("parses account-specific fields", () => {
    const result = parseNoteString(accountNote);
    assert.strictEqual(result.frontmatter["account-type"], "checking");
    assert.strictEqual(
      result.frontmatter["account-name"],
      "College Checking 1622"
    );
    assert.strictEqual(result.frontmatter["purpose"], "household-operations");
    assert.strictEqual(result.frontmatter["currency"], "USD");
    assert.strictEqual(result.frontmatter["plaid-connected"], true);
  });

  it("extracts institution wikilink from frontmatter", () => {
    const result = parseNoteString(accountNote);
    assert.ok(result.frontmatterWikilinks.includes("Chase"));
    assert.ok(result.frontmatterWikilinks.includes("Mike Lingle"));
    assert.ok(result.frontmatterWikilinks.includes("Lindsay Lingle"));
  });

  it("parses joint-holders as array", () => {
    const result = parseNoteString(accountNote);
    const holders = result.frontmatter["joint-holders"] as string[];
    assert.ok(Array.isArray(holders));
    assert.strictEqual(holders.length, 1);
    assert.ok(holders[0].includes("[[Lindsay Lingle]]"));
  });

  it("parses truth_score as agent-populated", () => {
    const result = parseNoteString(accountNote);
    assert.strictEqual(result.frontmatter.truth_score, "agent-populated");
  });

  it("parses date fields", () => {
    const result = parseNoteString(accountNote);
    // yaml package parses dates - it might return a Date object or string
    const lastVerified = result.frontmatter["last_verified"];
    assert.ok(lastVerified !== null && lastVerified !== undefined);
  });
});

// ── Account Template (Debt) ──────────────────────────────────────────────────

describe("Account template (debt/loan)", () => {
  const debtNote = dedent(`
    ---
    type: account
    account-type: loan
    account-name: "Auto Loan 3660"
    institution: "[[Wells Fargo]]"
    held-by: "[[Mike Lingle]]"
    status: active
    purpose: debt-service
    currency: USD
    principal-balance: 88328.33
    as-of-date: 2026-02-01
    interest-rate: 6.29
    rate-type: fixed
    monthly-payment: 1982.82
    original-balance: 118353.81
    collateral: "[[2024 Tesla Cybertruck]]"
    lender: "[[Wells Fargo]]"
    deductible: false
    is_canonical: true
    truth_score: verified
    tags:
      - account
      - account/loan
      - personal
      - lingelpedia/canonical
    ---

    # Wells Fargo - Auto Loan 3660

    Cybertruck financing. Originated by Tesla, assigned to [[Wells Fargo]].
  `);

  it("parses debt-specific fields", () => {
    const result = parseNoteString(debtNote);
    assert.strictEqual(result.frontmatter["principal-balance"], 88328.33);
    assert.strictEqual(result.frontmatter["interest-rate"], 6.29);
    assert.strictEqual(result.frontmatter["rate-type"], "fixed");
    assert.strictEqual(result.frontmatter["monthly-payment"], 1982.82);
    assert.strictEqual(result.frontmatter["original-balance"], 118353.81);
    assert.strictEqual(result.frontmatter["deductible"], false);
  });

  it("extracts collateral wikilink", () => {
    const result = parseNoteString(debtNote);
    assert.ok(result.frontmatterWikilinks.includes("2024 Tesla Cybertruck"));
  });
});

// ── Investment (Deal) Template ───────────────────────────────────────────────

describe("Investment (Deal) template", () => {
  const dealNote = dedent(`
    ---
    type: investment
    perspective: deal
    asset-name: "4DX I"
    asset-class: private-equity
    status: active
    deal-sponsor: "[[Wasson Enterprise LLC]]"
    vehicle: "[[WE 4DX I LLC]]"
    vintage-year:
    valuation:
    valuation-date:
    we-commitment:
    we-invested:
    we-ownership-pct: ""
    projected-irr: ""
    projected-moic: ""
    hold-period: ""
    exit-strategy: ""
    source-system: juniper-square
    source-system-id: ""
    total-raise:
    total-shares-outstanding:
    is_canonical: true
    truth_score: unscored
    last_verified:
    verification_source: ""
    investment-origin: we
    market_data_source: ""
    tags:
      - investment
      - investment/pe
      - we
      - needs-review
      - lingelpedia/canonical
    ---

    # 4DX I

    4DX Ventures through [[Wasson Enterprise LLC]].

    ## Current Cap Table

    | Investor | Entity | Shares / Units | Class | Commitment | Called | Ownership % | Notes |
    |----------|--------|----------------|-------|------------|-------|-------------|-------|
    | | | | | | | | |
  `);

  it("identifies investment template type with deal perspective", () => {
    const result = parseNoteString(dealNote);
    assert.strictEqual(result.templateType, "investment");
    assert.strictEqual(result.investmentPerspective, "deal");
  });

  it("parses deal-specific fields", () => {
    const result = parseNoteString(dealNote);
    assert.strictEqual(result.frontmatter["asset-name"], "4DX I");
    assert.strictEqual(result.frontmatter["asset-class"], "private-equity");
    assert.strictEqual(result.frontmatter["investment-origin"], "we");
    assert.strictEqual(result.frontmatter["source-system"], "juniper-square");
  });

  it("handles empty/null fields gracefully", () => {
    const result = parseNoteString(dealNote);
    assert.strictEqual(result.frontmatter["vintage-year"], null);
    assert.strictEqual(result.frontmatter["valuation"], null);
    assert.strictEqual(result.frontmatter["we-ownership-pct"], "");
    assert.strictEqual(result.frontmatter["projected-irr"], "");
  });

  it("extracts deal sponsor and vehicle wikilinks", () => {
    const result = parseNoteString(dealNote);
    assert.ok(
      result.frontmatterWikilinks.includes("Wasson Enterprise LLC")
    );
    assert.ok(result.frontmatterWikilinks.includes("WE 4DX I LLC"));
  });
});

// ── Investment (Personal Position) Template ──────────────────────────────────

describe("Investment (Personal Position) template", () => {
  const positionNote = dedent(`
    ---
    type: investment
    perspective: personal
    asset-name: "4DX I - Lingle Position"
    asset-class: private-equity
    status: active
    deal: "[[4DX I]]"
    held-by: "[[Lindsay Lingle]]"
    held-alongside: "[[Wasson Enterprise LLC]]"
    commitment:
    invested-capital:
    cost-basis: 15491
    current-value:
    value-date:
    ownership-pct: "1.5625%"
    distributions-received: 1097.77
    k1-entity: "[[WE 4DX I LLC]]"
    tax-character: mixed
    liquidity: illiquid
    source-system: juniper-square
    shares-owned:
    units-owned:
    is_canonical: true
    canonical_note: "Position-level facts only. Company-level data lives in [[4DX I]]."
    truth_score: unscored
    investment-origin: we
    tags:
      - investment
      - investment/pe
      - personal
      - needs-review
      - lingelpedia/canonical
    ---

    # 4DX I - Lingle Position

    Lingle household position in the [[4DX I]] deal.
    Held by [[Lindsay Lingle]]. K-1 entity: [[WE 4DX I LLC]].
  `);

  it("identifies investment template type with personal perspective", () => {
    const result = parseNoteString(positionNote);
    assert.strictEqual(result.templateType, "investment");
    assert.strictEqual(result.investmentPerspective, "personal");
  });

  it("parses position-specific fields", () => {
    const result = parseNoteString(positionNote);
    assert.strictEqual(result.frontmatter["cost-basis"], 15491);
    assert.strictEqual(result.frontmatter["distributions-received"], 1097.77);
    assert.strictEqual(result.frontmatter["ownership-pct"], "1.5625%");
    assert.strictEqual(result.frontmatter["tax-character"], "mixed");
    assert.strictEqual(result.frontmatter["liquidity"], "illiquid");
  });

  it("extracts deal backlink wikilink", () => {
    const result = parseNoteString(positionNote);
    assert.ok(result.frontmatterWikilinks.includes("4DX I"));
    assert.ok(result.frontmatterWikilinks.includes("Lindsay Lingle"));
    assert.ok(result.frontmatterWikilinks.includes("WE 4DX I LLC"));
  });

  it("extracts canonical_note wikilink reference", () => {
    const result = parseNoteString(positionNote);
    // canonical_note contains a wikilink inside the description string
    assert.ok(result.frontmatterWikilinks.includes("4DX I"));
  });
});

// ── Cash Flow Template ───────────────────────────────────────────────────────

describe("Cash Flow template", () => {
  const cashFlowNote = dedent(`
    ---
    type: cash-flow
    flow-type: expense
    direction: outflow
    description: "Duke Energy - Monthly electricity"
    status: active
    from-account: "[[Chase - College Checking 1622]]"
    to-entity: "[[Duke Energy]]"
    amount: 250
    frequency: monthly
    day-of-month: 15
    start-date: 2020-01-01
    category: housing
    tax-deductible: false
    essential: true
    auto-pay: true
    notes-on-flow: "Variable amount, average ~$250/mo. Summer months higher due to AC."
    is_canonical: true
    truth_score: agent-populated
    tags:
      - cash-flow
      - cash-flow/expense
      - household
      - lingelpedia/canonical
    ---

    # Duke Energy - Monthly Electricity

    Monthly electricity bill for primary residence.
    Paid from [[Chase - College Checking 1622]] to [[Duke Energy]].
  `);

  it("identifies cash-flow template type", () => {
    const result = parseNoteString(cashFlowNote);
    assert.strictEqual(result.templateType, "cash-flow");
  });

  it("parses cash-flow-specific fields", () => {
    const result = parseNoteString(cashFlowNote);
    assert.strictEqual(result.frontmatter["flow-type"], "expense");
    assert.strictEqual(result.frontmatter["direction"], "outflow");
    assert.strictEqual(result.frontmatter["amount"], 250);
    assert.strictEqual(result.frontmatter["frequency"], "monthly");
    assert.strictEqual(result.frontmatter["day-of-month"], 15);
    assert.strictEqual(result.frontmatter["category"], "housing");
    assert.strictEqual(result.frontmatter["tax-deductible"], false);
    assert.strictEqual(result.frontmatter["essential"], true);
    assert.strictEqual(result.frontmatter["auto-pay"], true);
  });

  it("extracts from-account and to-entity wikilinks", () => {
    const result = parseNoteString(cashFlowNote);
    assert.ok(
      result.frontmatterWikilinks.includes("Chase - College Checking 1622")
    );
    assert.ok(result.frontmatterWikilinks.includes("Duke Energy"));
  });
});

// ── Person Template ──────────────────────────────────────────────────────────

describe("Person template", () => {
  const personNote = dedent(`
    ---
    type: person
    name: Mike Lingle
    aliases:
      - Mike
    role: CEO / Chief Strategy Officer
    company: GIX / Wasson Enterprise
    location: Westfield, IN
    email: "michael.t.lingle@gmail.com"
    phone_mobile: (317) 507-6896
    birthday: 1987-06-19
    relationship: family
    circle: inner
    status: active
    spouse: "[[Lindsay Lingle]]"
    parent:
      - "[[Tom Lingle]]"
      - "[[Teresa Lingle]]"
    child:
      - "[[Harrison Lingle]]"
      - "[[Beckham Lingle]]"
    sibling:
      - "[[Sarah Lingle]]"
    financial-roles:
      - role: ceo
        entity: "[[Global InterXchange LLC]]"
      - role: cso
        entity: "[[Wasson Enterprise LLC]]"
    cpa: "[[Plante Moran]]"
    estate-attorney: "[[Schiff Hardin]]"
    trusts:
      - "[[Michael T Lingle Declaration of Trust]]"
      - "[[Lingle Family Dynasty Trust]]"
    tax-filing-status: married-filing-jointly
    source-systems:
      - copilot-money
      - juniper-square
      - chase
    is_canonical: true
    truth_score: unscored
    tags:
      - person
      - person/family
      - org/WE
      - org/GIX
      - family
    ---

    # Mike Lingle

    CEO of **[[Global InterXchange (GIX)]]** and CSO at **[[Wasson Enterprise LLC]]**.
    Lives in Westfield, IN with [[Lindsay Lingle]], [[Harrison Lingle|Harrison]], and [[Beckham Lingle|Beckham]].
  `);

  it("identifies person template type", () => {
    const result = parseNoteString(personNote);
    assert.strictEqual(result.templateType, "person");
  });

  it("parses person-specific fields", () => {
    const result = parseNoteString(personNote);
    assert.strictEqual(result.frontmatter["name"], "Mike Lingle");
    assert.strictEqual(result.frontmatter["relationship"], "family");
    assert.strictEqual(result.frontmatter["circle"], "inner");
    assert.strictEqual(result.frontmatter["email"], "michael.t.lingle@gmail.com");
    assert.strictEqual(
      result.frontmatter["tax-filing-status"],
      "married-filing-jointly"
    );
  });

  it("parses family relationships as wikilinks", () => {
    const result = parseNoteString(personNote);
    assert.ok(result.frontmatterWikilinks.includes("Lindsay Lingle"));
    assert.ok(result.frontmatterWikilinks.includes("Tom Lingle"));
    assert.ok(result.frontmatterWikilinks.includes("Teresa Lingle"));
    assert.ok(result.frontmatterWikilinks.includes("Harrison Lingle"));
    assert.ok(result.frontmatterWikilinks.includes("Beckham Lingle"));
    assert.ok(result.frontmatterWikilinks.includes("Sarah Lingle"));
  });

  it("parses financial-roles as nested objects with wikilinks", () => {
    const result = parseNoteString(personNote);
    const roles = result.frontmatter["financial-roles"] as Array<{
      role: string;
      entity: string;
    }>;
    assert.ok(Array.isArray(roles));
    assert.strictEqual(roles.length, 2);
    assert.strictEqual(roles[0].role, "ceo");
    assert.ok(roles[0].entity.includes("[[Global InterXchange LLC]]"));
    assert.ok(
      result.frontmatterWikilinks.includes("Global InterXchange LLC")
    );
    assert.ok(
      result.frontmatterWikilinks.includes("Wasson Enterprise LLC")
    );
  });

  it("parses trusts as array of wikilinks", () => {
    const result = parseNoteString(personNote);
    const trusts = result.frontmatter["trusts"] as string[];
    assert.ok(Array.isArray(trusts));
    assert.strictEqual(trusts.length, 2);
    assert.ok(
      result.frontmatterWikilinks.includes(
        "Michael T Lingle Declaration of Trust"
      )
    );
  });

  it("extracts aliased wikilinks from body text", () => {
    const result = parseNoteString(personNote);
    assert.ok(result.bodyWikilinks.includes("Harrison Lingle"));
    assert.ok(result.bodyWikilinks.includes("Beckham Lingle"));
    assert.ok(result.bodyWikilinks.includes("Global InterXchange (GIX)"));
  });

  it("parses aliases as array", () => {
    const result = parseNoteString(personNote);
    const aliases = result.frontmatter["aliases"] as string[];
    assert.ok(Array.isArray(aliases));
    assert.ok(aliases.includes("Mike"));
  });

  it("parses source-systems as array", () => {
    const result = parseNoteString(personNote);
    const systems = result.frontmatter["source-systems"] as string[];
    assert.ok(Array.isArray(systems));
    assert.ok(systems.includes("copilot-money"));
    assert.ok(systems.includes("chase"));
  });
});

// ── Institution Template ─────────────────────────────────────────────────────

describe("Institution template", () => {
  const institutionNote = dedent(`
    ---
    type: institution
    institution-type: bank
    name: "Chase"
    legal-name: "JPMorgan Chase Bank, N.A."
    website: https://www.chase.com
    status: active
    services:
      - banking
      - credit-cards
      - lending
    entities-served:
      - "[[Mike Lingle]]"
      - "[[Lindsay Lingle]]"
    accounts-held:
      - "[[Chase - Lindsay Checking 8838]]"
      - "[[Chase - College Checking 1622]]"
      - "[[Chase - Credit Card 6548]]"
    portal-url: https://www.chase.com
    source-system: chase.com
    is_canonical: true
    truth_score: unscored
    tags:
      - institution
      - institution/bank
      - personal
      - joint
      - lingelpedia/canonical
    ---

    # Chase

    Primary household bank for [[Mike Lingle]] and [[Lindsay Lingle]].
  `);

  it("identifies institution template type", () => {
    const result = parseNoteString(institutionNote);
    assert.strictEqual(result.templateType, "institution");
  });

  it("parses institution-specific fields", () => {
    const result = parseNoteString(institutionNote);
    assert.strictEqual(result.frontmatter["institution-type"], "bank");
    assert.strictEqual(result.frontmatter["name"], "Chase");
    assert.strictEqual(
      result.frontmatter["legal-name"],
      "JPMorgan Chase Bank, N.A."
    );
    assert.strictEqual(
      result.frontmatter["website"],
      "https://www.chase.com"
    );
    assert.strictEqual(result.frontmatter["source-system"], "chase.com");
  });

  it("parses services as array", () => {
    const result = parseNoteString(institutionNote);
    const services = result.frontmatter["services"] as string[];
    assert.ok(Array.isArray(services));
    assert.strictEqual(services.length, 3);
    assert.ok(services.includes("banking"));
    assert.ok(services.includes("credit-cards"));
  });

  it("extracts account backlinks from frontmatter", () => {
    const result = parseNoteString(institutionNote);
    assert.ok(
      result.frontmatterWikilinks.includes("Chase - Lindsay Checking 8838")
    );
    assert.ok(
      result.frontmatterWikilinks.includes("Chase - College Checking 1622")
    );
    assert.ok(
      result.frontmatterWikilinks.includes("Chase - Credit Card 6548")
    );
  });

  it("extracts entities-served wikilinks", () => {
    const result = parseNoteString(institutionNote);
    assert.ok(result.frontmatterWikilinks.includes("Mike Lingle"));
    assert.ok(result.frontmatterWikilinks.includes("Lindsay Lingle"));
  });
});

// ── Vehicle Template ─────────────────────────────────────────────────────────

describe("Vehicle template", () => {
  const vehicleNote = dedent(`
    ---
    type: vehicle
    status: active
    make: Tesla
    model: Cybertruck
    year: 2024
    trim: Cyberbeast Foundation Series
    vin: 7G2CEHEE5RA023591
    color: Stainless Steel
    owner: "[[Mike Lingle]]"
    co-owner: "[[Lindsay Lingle]]"
    drivetrain: Tri-Motor AWD (Cyberbeast)
    horsepower: 845
    torque: "10,296 lb-ft"
    zero-to-sixty: 2.6s
    top-speed: 130 mph
    range: 320 mi
    battery: 123 kWh
    towing-capacity: "11,000 lbs"
    seating: 5
    purchase-price: 129104.45
    purchase-date: 2024-08-12
    loan-account: "[[Wells Fargo - Auto Loan 3660]]"
    insurance-policy: "[[Link-Hellmuth Insurance]]"
    replaces: "[[2020 Tesla Model 3]]"
    is_canonical: true
    truth_score: verified
    tags:
      - vehicle
      - vehicle/active
      - tesla
      - data-verified
      - lingelpedia/canonical
    ---

    # 2024 Tesla Cybertruck

    Mike's daily driver. [[Mike Lingle]] and [[Lindsay Lingle]] co-own.
    Financed through [[Wells Fargo]].
  `);

  it("identifies vehicle template type", () => {
    const result = parseNoteString(vehicleNote);
    assert.strictEqual(result.templateType, "vehicle");
  });

  it("parses vehicle-specific fields", () => {
    const result = parseNoteString(vehicleNote);
    assert.strictEqual(result.frontmatter["make"], "Tesla");
    assert.strictEqual(result.frontmatter["model"], "Cybertruck");
    assert.strictEqual(result.frontmatter["year"], 2024);
    assert.strictEqual(
      result.frontmatter["trim"],
      "Cyberbeast Foundation Series"
    );
    assert.strictEqual(result.frontmatter["vin"], "7G2CEHEE5RA023591");
    assert.strictEqual(result.frontmatter["horsepower"], 845);
    assert.strictEqual(result.frontmatter["seating"], 5);
    assert.strictEqual(result.frontmatter["purchase-price"], 129104.45);
  });

  it("handles string number values with units", () => {
    const result = parseNoteString(vehicleNote);
    // YAML treats "10,296 lb-ft" as a string (not a number) because of comma
    assert.strictEqual(result.frontmatter["torque"], "10,296 lb-ft");
    assert.strictEqual(result.frontmatter["top-speed"], "130 mph");
    assert.strictEqual(result.frontmatter["range"], "320 mi");
    assert.strictEqual(result.frontmatter["battery"], "123 kWh");
  });

  it("extracts owner, co-owner, loan-account, insurance, replaces wikilinks", () => {
    const result = parseNoteString(vehicleNote);
    assert.ok(result.frontmatterWikilinks.includes("Mike Lingle"));
    assert.ok(result.frontmatterWikilinks.includes("Lindsay Lingle"));
    assert.ok(
      result.frontmatterWikilinks.includes("Wells Fargo - Auto Loan 3660")
    );
    assert.ok(
      result.frontmatterWikilinks.includes("Link-Hellmuth Insurance")
    );
    assert.ok(
      result.frontmatterWikilinks.includes("2020 Tesla Model 3")
    );
  });

  it("parses date fields", () => {
    const result = parseNoteString(vehicleNote);
    const purchaseDate = result.frontmatter["purchase-date"];
    assert.ok(purchaseDate !== null && purchaseDate !== undefined);
  });
});

// ── Edge Cases ───────────────────────────────────────────────────────────────

describe("Edge cases", () => {
  it("handles note with no frontmatter", () => {
    const result = parseNoteString("# Just a heading\n\nSome text.");
    assert.strictEqual(result.templateType, null);
    assert.deepStrictEqual(result.frontmatter, {});
    assert.ok(result.body.includes("# Just a heading"));
  });

  it("handles empty file", () => {
    const result = parseNoteString("");
    assert.strictEqual(result.templateType, null);
    assert.deepStrictEqual(result.frontmatter, {});
    assert.strictEqual(result.body, "");
  });

  it("handles frontmatter with only --- delimiters and no fields", () => {
    const result = parseNoteString("---\n---\n\nBody text.");
    assert.strictEqual(result.templateType, null);
    assert.ok(result.body.includes("Body text."));
  });

  it("handles frontmatter with unknown type", () => {
    const result = parseNoteString("---\ntype: unknown-type\n---\nBody.");
    assert.strictEqual(result.templateType, null);
    assert.strictEqual(result.frontmatter["type"], "unknown-type");
  });

  it("handles malformed YAML gracefully", () => {
    const result = parseNoteString("---\n  bad:\n    - [unclosed\n---\nBody.");
    // Should not throw — returns empty frontmatter
    assert.strictEqual(result.templateType, null);
  });

  it("handles frontmatter with null values", () => {
    const note = dedent(`
      ---
      type: entity
      subtype: llc
      legal-name: "Test LLC"
      status: active
      ein:
      owned-by:
      accounts: []
      tags:
        - entity
      ---

      Body text.
    `);
    const result = parseNoteString(note);
    assert.strictEqual(result.templateType, "entity");
    assert.strictEqual(result.frontmatter["ein"], null);
    assert.strictEqual(result.frontmatter["owned-by"], null);
    assert.deepStrictEqual(result.frontmatter["accounts"], []);
  });

  it("preserves file path when provided", () => {
    const result = parseNoteString("---\ntype: entity\n---\nBody.", "/path/to/note.md");
    assert.strictEqual(result.filePath, "/path/to/note.md");
  });

  it("sets filePath to null when not provided", () => {
    const result = parseNoteString("---\ntype: entity\n---\nBody.");
    assert.strictEqual(result.filePath, null);
  });

  it("combines frontmatter and body wikilinks without duplicates", () => {
    const note = dedent(`
      ---
      type: entity
      owned-by: "[[Mike Lingle]]"
      ---

      Owned by [[Mike Lingle]] and managed by [[Lindsay Lingle]].
    `);
    const result = parseNoteString(note);
    // Mike Lingle appears in both frontmatter and body
    const mikeCount = result.allWikilinks.filter(
      (l) => l === "Mike Lingle"
    ).length;
    assert.strictEqual(mikeCount, 1);
    assert.ok(result.allWikilinks.includes("Lindsay Lingle"));
  });

  it("handles Windows-style line endings (CRLF)", () => {
    const note =
      "---\r\ntype: entity\r\nstatus: active\r\n---\r\n\r\nBody text.";
    const result = parseNoteString(note);
    assert.strictEqual(result.templateType, "entity");
    assert.strictEqual(result.frontmatter["status"], "active");
  });

  it("handles type field with mixed case", () => {
    const result = parseNoteString("---\ntype: Entity\n---\nBody.");
    assert.strictEqual(result.templateType, "entity");
  });

  it("investmentPerspective is null for non-investment types", () => {
    const result = parseNoteString("---\ntype: entity\n---\nBody.");
    assert.strictEqual(result.investmentPerspective, null);
  });

  it("investmentPerspective is null when perspective field is missing", () => {
    const result = parseNoteString("---\ntype: investment\n---\nBody.");
    assert.strictEqual(result.templateType, "investment");
    assert.strictEqual(result.investmentPerspective, null);
  });
});
