/**
 * Tests for Generic Mapper (US-016)
 *
 * Tests the mapping of institution, vehicle, property, and vendor template
 * types to Neo4j Entity nodes via the generic mapper.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapGenericToNeo4j, mapGenericNoteString } from "../src/generic-mapper.js";
import { parseNoteString } from "../src/frontmatter-parser.js";
import { runCypher } from "../src/entity-mapper.js";

// ── Unit Tests (no Neo4j required) ─────────────────────────────────────────

describe("Generic Mapper — Unit Tests", () => {
  it("rejects unsupported template type", () => {
    const note = parseNoteString(
      `---\ntype: entity\nname: Test\n---\n# Test`,
      "/test/entity.md"
    );
    const result = mapGenericToNeo4j(note);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("Unsupported"));
  });

  it("rejects notes with no type", () => {
    const note = parseNoteString(
      `---\ntags:\n  - moc\n---\n# Test`,
      "/test/moc.md"
    );
    const result = mapGenericToNeo4j(note);
    assert.equal(result.success, false);
  });

  it("rejects dashboard type", () => {
    const note = parseNoteString(
      `---\ntype: dashboard\n---\n# Dashboard`,
      "/test/dash.md"
    );
    const result = mapGenericToNeo4j(note);
    assert.equal(result.success, false);
  });

  it("rejects investment type (handled by dedicated mapper)", () => {
    const note = parseNoteString(
      `---\ntype: investment\nperspective: deal\n---\n# Deal`,
      "/test/deal.md"
    );
    const result = mapGenericToNeo4j(note);
    assert.equal(result.success, false);
  });
});

// ── Integration Tests (require Neo4j) ──────────────────────────────────────

describe("Generic Mapper — Institution Integration", () => {
  const prefix = `test-inst-${Date.now()}`;

  it("maps institution note to Entity node", () => {
    const content = `---
type: institution
institution-type: bank
name: "Test Bank ${prefix}"
legal-name: "Test Bank, N.A."
website: https://testbank.com
status: active
services:
  - banking
  - credit-cards
entities-served:
  - "[[Mike Lingle]]"
accounts-held:
  - "[[Test Bank - Checking 1234]]"
is_canonical: true
truth_score: verified
tags:
  - institution
  - institution/bank
---
# Test Bank`;

    const result = mapGenericNoteString(content, `/test/${prefix}-bank.md`);
    assert.equal(result.success, true);
    assert.ok(result.entityId.includes(prefix));
    assert.ok(result.relationshipsCreated.length >= 3); // SOURCED_FROM + serves + holds_account

    // Verify in Neo4j
    const check = runCypher(
      `MATCH (e:Entity {id: "${result.entityId}"}) RETURN e.entity_type AS t, e.institution_type AS it, e.truth_score AS ts;`
    );
    assert.ok(check.includes("institution"));
    assert.ok(check.includes("bank"));
    assert.ok(check.includes("0.95"));
  });

  it("creates RELATED_TO for entities-served", () => {
    const check = runCypher(
      `MATCH (e:Entity)-[r:RELATED_TO {type: "serves"}]->(t:Entity) WHERE e.id CONTAINS "${prefix}" RETURN t.name;`
    );
    assert.ok(check.includes("Mike Lingle"));
  });

  it("creates RELATED_TO for accounts-held", () => {
    const check = runCypher(
      `MATCH (e:Entity)-[r:RELATED_TO {type: "holds_account"}]->(t:Entity) WHERE e.id CONTAINS "${prefix}" RETURN t.name;`
    );
    assert.ok(check.includes("Test Bank - Checking 1234"));
  });

  // Cleanup
  it("cleanup test data", () => {
    runCypher(
      `MATCH (e) WHERE e.id CONTAINS "${prefix}" DETACH DELETE e;`
    );
  });
});

describe("Generic Mapper — Vehicle Integration", () => {
  const prefix = `test-veh-${Date.now()}`;

  it("maps vehicle note to Entity node", () => {
    const content = `---
type: vehicle
status: active
make: Tesla
model: Cybertruck
year: 2024
vin: TEST123
owner: "[[Mike Lingle]]"
co-owner: "[[Lindsay Lingle]]"
loan-account: "[[Wells Fargo - Auto Loan 3660]]"
insurance-policy: "[[Link-Hellmuth Insurance]]"
purchase-price: 129104
purchase-date: 2024-08-12
is_canonical: true
truth_score: verified
tags:
  - vehicle
---
# Test Vehicle`;

    const result = mapGenericNoteString(content, `/test/${prefix}-vehicle.md`);
    assert.equal(result.success, true);
    assert.ok(result.entityId.includes(prefix));

    // Verify node properties
    const check = runCypher(
      `MATCH (e:Entity {id: "${result.entityId}"}) RETURN e.entity_type AS t, e.make AS m, e.model AS mo, e.domain AS d;`
    );
    assert.ok(check.includes("vehicle"));
    assert.ok(check.includes("Tesla"));
    assert.ok(check.includes("auto"));
  });

  it("creates BELONGS_TO for owner", () => {
    const check = runCypher(
      `MATCH (e:Entity)-[:BELONGS_TO]->(t:Entity) WHERE e.id CONTAINS "${prefix}" RETURN t.name;`
    );
    assert.ok(check.includes("Mike Lingle"));
  });

  it("creates RELATED_TO for co-owner", () => {
    const check = runCypher(
      `MATCH (e:Entity)-[r:RELATED_TO {type: "co_owner"}]->(t:Entity) WHERE e.id CONTAINS "${prefix}" RETURN t.name;`
    );
    assert.ok(check.includes("Lindsay Lingle"));
  });

  it("creates RELATED_TO for loan-account", () => {
    const check = runCypher(
      `MATCH (e:Entity)-[r:RELATED_TO {type: "loan_account"}]->(t:Entity) WHERE e.id CONTAINS "${prefix}" RETURN t.name;`
    );
    assert.ok(check.includes("Wells Fargo - Auto Loan 3660"));
  });

  it("cleanup test data", () => {
    runCypher(`MATCH (e) WHERE e.id CONTAINS "${prefix}" DETACH DELETE e;`);
  });
});

describe("Generic Mapper — Property Integration", () => {
  const prefix = `test-prop-${Date.now()}`;

  it("maps property note to Entity node", () => {
    const content = `---
type: property
status: owned
property-type: primary-residence
address: "123 Test St, Testville, IN 46074"
city: Testville
state: IN
zip: "46074"
owned-by: "[[Mike Lingle]]"
joint-owners:
  - "[[Lindsay Lingle]]"
mortgage: "[[PNC - Mortgage 1234]]"
insurance-provider: "[[Test Insurance]]"
purchase-price: 500000
current-value: 600000
is_canonical: true
truth_score: unscored
tags:
  - property
  - real-estate
---
# Test Property`;

    const result = mapGenericNoteString(content, `/test/${prefix}-property.md`);
    assert.equal(result.success, true);

    // Verify node
    const check = runCypher(
      `MATCH (e:Entity {id: "${result.entityId}"}) RETURN e.entity_type AS t, e.domain AS d, e.property_type AS pt;`
    );
    assert.ok(check.includes("property"));
    assert.ok(check.includes("real-estate"));
    assert.ok(check.includes("primary-residence"));
  });

  it("creates BELONGS_TO for owned-by", () => {
    const check = runCypher(
      `MATCH (e:Entity)-[:BELONGS_TO]->(t:Entity) WHERE e.id CONTAINS "${prefix}" RETURN t.name;`
    );
    assert.ok(check.includes("Mike Lingle"));
  });

  it("creates RELATED_TO for joint-owners", () => {
    const check = runCypher(
      `MATCH (e:Entity)-[r:RELATED_TO {type: "joint_owner"}]->(t:Entity) WHERE e.id CONTAINS "${prefix}" RETURN t.name;`
    );
    assert.ok(check.includes("Lindsay Lingle"));
  });

  it("creates RELATED_TO for mortgage", () => {
    const check = runCypher(
      `MATCH (e:Entity)-[r:RELATED_TO {type: "mortgage"}]->(t:Entity) WHERE e.id CONTAINS "${prefix}" RETURN t.name;`
    );
    assert.ok(check.includes("PNC - Mortgage 1234"));
  });

  it("is idempotent — running twice creates no duplicates", () => {
    const content = `---
type: property
status: owned
property-type: rental
address: "456 Idem St"
owned-by: "[[Mike Lingle]]"
is_canonical: true
truth_score: unscored
tags:
  - property
---
# Idempotency Test`;

    mapGenericNoteString(content, `/test/${prefix}-idem.md`);
    mapGenericNoteString(content, `/test/${prefix}-idem.md`);

    const countResult = runCypher(
      `MATCH (e:Entity) WHERE e.id CONTAINS "${prefix}-idem" RETURN count(e) AS c;`
    );
    assert.ok(countResult.includes("1"));
  });

  it("creates OpenQuestion for conflicted truth_score", () => {
    const content = `---
type: property
status: owned
address: "789 Conflict Ave"
truth_score: conflicted
is_canonical: true
tags:
  - property
---
# Conflicted Property`;

    const result = mapGenericNoteString(content, `/test/${prefix}-conflict.md`);
    assert.equal(result.success, true);
    assert.equal(result.openQuestionCreated, true);

    const check = runCypher(
      `MATCH (oq:OpenQuestion) WHERE oq.id CONTAINS "${prefix}-conflict" RETURN oq.status;`
    );
    assert.ok(check.includes("open"));
  });

  it("cleanup test data", () => {
    runCypher(`MATCH (e) WHERE e.id CONTAINS "${prefix}" DETACH DELETE e;`);
  });
});

describe("Generic Mapper — Vendor Integration", () => {
  const prefix = `test-vnd-${Date.now()}`;

  it("maps vendor note to Entity node", () => {
    const content = `---
type: vendor
vendor-type: property-management
name: "Test PM ${prefix}"
status: active
primary-contact: "Gabe"
contact-email: "gabe@test.com"
services:
  - cleaning
  - maintenance
properties-managed:
  - "[[239 Poplar St]]"
fee-structure: "15% management fee"
is_canonical: true
truth_score: unscored
tags:
  - vendor
---
# Test Vendor`;

    const result = mapGenericNoteString(content, `/test/${prefix}-vendor.md`);
    assert.equal(result.success, true);

    const check = runCypher(
      `MATCH (e:Entity {id: "${result.entityId}"}) RETURN e.entity_type AS t, e.vendor_type AS vt;`
    );
    assert.ok(check.includes("vendor"));
    assert.ok(check.includes("property-management"));
  });

  it("creates RELATED_TO for properties-managed", () => {
    const check = runCypher(
      `MATCH (e:Entity)-[r:RELATED_TO {type: "manages"}]->(t:Entity) WHERE e.id CONTAINS "${prefix}" RETURN t.name;`
    );
    assert.ok(check.includes("239 Poplar St"));
  });

  it("cleanup test data", () => {
    runCypher(`MATCH (e) WHERE e.id CONTAINS "${prefix}" DETACH DELETE e;`);
  });
});

// ── Migration Script Tests ──────────────────────────────────────────────────

describe("Migration Script — Discovery", () => {
  it("discovers notes in Finance/Entities", async () => {
    const { readdirSync } = await import("node:fs");
    const vaultRoot =
      "/Users/VEGA/Library/Mobile Documents/com~apple~CloudDocs/Linglepedia";
    const entityDir = `${vaultRoot}/Finance/Entities`;
    let files: string[];
    try {
      files = readdirSync(entityDir).filter(
        (f: string) => f.endsWith(".md") && !f.startsWith("_")
      );
    } catch {
      // Vault may not be accessible in CI
      return;
    }
    assert.ok(files.length >= 7, `Expected >=7 entity files, got ${files.length}`);
  });
});
