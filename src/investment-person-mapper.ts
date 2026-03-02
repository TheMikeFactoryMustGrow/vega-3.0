/**
 * Investment (Deal + Position) & Person Frontmatter-to-Neo4j Mapper (US-015)
 *
 * - Investment Deal notes map to (:Bet {bet_type: "intentional"}) nodes with
 *   deal-sponsor, vehicle, cap table fields, projected IRR/MOIC, etc.
 * - Investment Position notes map to (:Entity {entity_type: "investment-position"})
 *   nodes that link to the deal's Bet node via the `deal` wikilink / canonical_note.
 * - Person notes map to (:Entity {entity_type: "person"}) nodes with relationship
 *   circle, contact frequency, company links, and family relationships.
 *
 * Usage:
 *   import { mapInvestmentDealToNeo4j, mapInvestmentPositionToNeo4j, mapPersonToNeo4j } from "../src/investment-person-mapper.js";
 */

import { basename } from "node:path";
import { parseNoteFile, parseNoteString } from "./frontmatter-parser.js";
import type { ParsedNote } from "./frontmatter-parser.js";
import {
  runCypher,
  escCypher,
  mapTruthScore,
  generateEntityId,
  generateSourceId,
  extractWikilinkTarget,
} from "./entity-mapper.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DealMapperResult {
  betId: string;
  sourceId: string;
  nodeProperties: Record<string, unknown>;
  relationshipsCreated: string[];
  openQuestionCreated: boolean;
  success: boolean;
  error?: string;
}

export interface PositionMapperResult {
  positionId: string;
  sourceId: string;
  nodeProperties: Record<string, unknown>;
  relationshipsCreated: string[];
  openQuestionCreated: boolean;
  success: boolean;
  error?: string;
}

export interface PersonMapperResult {
  personId: string;
  sourceId: string;
  nodeProperties: Record<string, unknown>;
  relationshipsCreated: string[];
  openQuestionCreated: boolean;
  success: boolean;
  error?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toCypherString(val: unknown): string | null {
  if (val === null || val === undefined || val === "") return null;
  if (val instanceof Date) return val.toISOString().split("T")[0];
  return String(val);
}

function toCypherNumber(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

function deriveDomain(tags: unknown): string {
  if (!Array.isArray(tags)) return "finance";
  const tagStrings = tags.filter((t): t is string => typeof t === "string");
  if (tagStrings.includes("we")) return "we";
  if (tagStrings.includes("personal")) return "personal";
  if (tagStrings.includes("gix")) return "gix";
  if (tagStrings.includes("real-estate")) return "real-estate";
  return "finance";
}

/**
 * Generate a deterministic Bet ID from file path or asset name.
 */
export function generateBetId(
  filePath: string | null,
  assetName: string | null
): string {
  const base = filePath ? basename(filePath, ".md") : assetName;
  if (!base) return `bet-${Date.now()}`;
  return "bet-" + base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Generate a deterministic Position ID from file path or asset name.
 */
export function generatePositionId(
  filePath: string | null,
  assetName: string | null
): string {
  const base = filePath ? basename(filePath, ".md") : assetName;
  if (!base) return `pos-${Date.now()}`;
  return "pos-" + base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Generate a deterministic Person ID from file path or name.
 */
export function generatePersonId(
  filePath: string | null,
  name: string | null
): string {
  const base = filePath ? basename(filePath, ".md") : name;
  if (!base) return `person-${Date.now()}`;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Investment Deal Mapper ───────────────────────────────────────────────────

/**
 * Map a parsed Investment Deal note to Neo4j as a (:Bet {bet_type: "intentional"})
 * node. Links deal-sponsor and vehicle entities. Stores cap table metadata,
 * projected IRR/MOIC, and hold period.
 *
 * Idempotent: uses MERGE on id fields to avoid duplicates.
 */
export function mapInvestmentDealToNeo4j(note: ParsedNote): DealMapperResult {
  const fm = note.frontmatter;
  const filePath = note.filePath ?? "unknown";

  const assetName =
    toCypherString(fm["asset-name"]) ?? basename(filePath, ".md");
  const betId = generateBetId(note.filePath, assetName);
  const sourceId = generateSourceId(filePath);

  const result: DealMapperResult = {
    betId,
    sourceId,
    nodeProperties: {},
    relationshipsCreated: [],
    openQuestionCreated: false,
    success: false,
  };

  try {
    // ── 1. Create/update Bet node ──────────────────────────────────────────
    const assetClass = toCypherString(fm["asset-class"]) ?? "unknown";
    const status = toCypherString(fm["status"]) ?? "unknown";
    const truthScoreNum = mapTruthScore(fm.truth_score);
    const domain = deriveDomain(fm["tags"]);
    const isCanonical = fm.is_canonical === true;
    const vintageYear = toCypherString(fm["vintage-year"]);
    const valuation = toCypherNumber(fm["valuation"]);
    const valuationDate = toCypherString(fm["valuation-date"]);
    const weCommitment = toCypherNumber(fm["we-commitment"]);
    const weInvested = toCypherNumber(fm["we-invested"]);
    const weOwnershipPct = toCypherString(fm["we-ownership-pct"]);
    const projectedIrr = toCypherString(fm["projected-irr"]);
    const projectedMoic = toCypherString(fm["projected-moic"]);
    const holdPeriod = toCypherString(fm["hold-period"]);
    const exitStrategy = toCypherString(fm["exit-strategy"]);
    const sourceSystem = toCypherString(fm["source-system"]);
    const sourceSystemId = toCypherString(fm["source-system-id"]);
    const totalRaise = toCypherNumber(fm["total-raise"]);
    const totalShares = toCypherNumber(fm["total-shares-outstanding"]);
    const investmentOrigin = toCypherString(fm["investment-origin"]);

    const setProps: string[] = [
      `b.name = "${escCypher(assetName)}"`,
      `b.bet_type = "intentional"`,
      `b.asset_class = "${escCypher(assetClass)}"`,
      `b.status = "${escCypher(status)}"`,
      `b.domain = "${escCypher(domain)}"`,
      `b.truth_score = ${truthScoreNum}`,
      `b.truth_basis = "${escCypher(fm.truth_score ?? "unscored")}"`,
      `b.is_canonical = ${isCanonical}`,
      `b.source_file = "${escCypher(filePath)}"`,
      `b.updated_at = datetime()`,
    ];

    if (vintageYear) setProps.push(`b.vintage_year = "${escCypher(vintageYear)}"`);
    if (valuation !== null) setProps.push(`b.valuation = ${valuation}`);
    if (valuationDate) setProps.push(`b.valuation_date = "${escCypher(valuationDate)}"`);
    if (weCommitment !== null) setProps.push(`b.we_commitment = ${weCommitment}`);
    if (weInvested !== null) setProps.push(`b.we_invested = ${weInvested}`);
    if (weOwnershipPct) setProps.push(`b.we_ownership_pct = "${escCypher(weOwnershipPct)}"`);
    if (projectedIrr) setProps.push(`b.projected_irr = "${escCypher(projectedIrr)}"`);
    if (projectedMoic) setProps.push(`b.projected_moic = "${escCypher(projectedMoic)}"`);
    if (holdPeriod) setProps.push(`b.hold_period = "${escCypher(holdPeriod)}"`);
    if (exitStrategy) setProps.push(`b.exit_strategy = "${escCypher(exitStrategy)}"`);
    if (sourceSystem) setProps.push(`b.source_system = "${escCypher(sourceSystem)}"`);
    if (sourceSystemId) setProps.push(`b.source_system_id = "${escCypher(sourceSystemId)}"`);
    if (totalRaise !== null) setProps.push(`b.total_raise = ${totalRaise}`);
    if (totalShares !== null) setProps.push(`b.total_shares_outstanding = ${totalShares}`);
    if (investmentOrigin) setProps.push(`b.investment_origin = "${escCypher(investmentOrigin)}"`);

    const betCypher = `MERGE (b:Bet {id: "${escCypher(betId)}"})
SET ${setProps.join(", ")}
RETURN b.id;`;

    runCypher(betCypher);
    result.nodeProperties = {
      id: betId,
      name: assetName,
      bet_type: "intentional",
      asset_class: assetClass,
      status,
      domain,
      truth_score: truthScoreNum,
      is_canonical: isCanonical,
    };

    // ── 2. Create Source node and SOURCED_FROM relationship ────────────────
    const sourceName = basename(filePath);
    const sourceCypher = `MERGE (s:Source {id: "${escCypher(sourceId)}"})
SET s.source_type = "obsidian_vault", s.file_path = "${escCypher(filePath)}", s.name = "${escCypher(sourceName)}", s.updated_at = datetime()
WITH s
MATCH (b:Bet {id: "${escCypher(betId)}"})
MERGE (b)-[:SOURCED_FROM]->(s)
RETURN s.id;`;

    runCypher(sourceCypher);
    result.relationshipsCreated.push(`SOURCED_FROM -> ${sourceId}`);

    // ── 3. Link deal-sponsor entity ───────────────────────────────────────
    const dealSponsor = fm["deal-sponsor"];
    const alreadyLinked = new Set<string>();
    if (typeof dealSponsor === "string" && dealSponsor.trim()) {
      const sponsorName = extractWikilinkTarget(dealSponsor);
      if (sponsorName) {
        alreadyLinked.add(sponsorName);
        const sponsorId = generateEntityId(null, sponsorName);
        const sponsorCypher = `MERGE (sponsor:Entity {id: "${escCypher(sponsorId)}"})
ON CREATE SET sponsor.name = "${escCypher(sponsorName)}", sponsor.entity_type = "unknown", sponsor.truth_score = 0.5, sponsor.created_at = datetime()
SET sponsor.updated_at = datetime()
WITH sponsor
MATCH (b:Bet {id: "${escCypher(betId)}"})
MERGE (b)-[r:RELATED_TO]->(sponsor)
SET r.type = "deal_sponsor"
RETURN sponsor.id;`;

        runCypher(sponsorCypher);
        result.relationshipsCreated.push(`RELATED_TO {deal_sponsor} -> ${sponsorName}`);
      }
    }

    // ── 4. Link vehicle entity ────────────────────────────────────────────
    const vehicle = fm["vehicle"];
    if (typeof vehicle === "string" && vehicle.trim()) {
      const vehicleName = extractWikilinkTarget(vehicle);
      if (vehicleName) {
        alreadyLinked.add(vehicleName);
        const vehicleId = generateEntityId(null, vehicleName);
        const vehicleCypher = `MERGE (v:Entity {id: "${escCypher(vehicleId)}"})
ON CREATE SET v.name = "${escCypher(vehicleName)}", v.entity_type = "vehicle", v.truth_score = 0.5, v.created_at = datetime()
SET v.updated_at = datetime()
WITH v
MATCH (b:Bet {id: "${escCypher(betId)}"})
MERGE (b)-[r:RELATED_TO]->(v)
SET r.type = "vehicle"
RETURN v.id;`;

        runCypher(vehicleCypher);
        result.relationshipsCreated.push(`RELATED_TO {vehicle} -> ${vehicleName}`);
      }
    }

    // ── 5. Link investors ─────────────────────────────────────────────────
    const investors = fm["investors"];
    if (Array.isArray(investors)) {
      for (const inv of investors) {
        if (typeof inv !== "string") continue;
        const invName = extractWikilinkTarget(inv);
        if (!invName) continue;
        alreadyLinked.add(invName);
        const invId = generateEntityId(null, invName);
        const invCypher = `MERGE (inv:Entity {id: "${escCypher(invId)}"})
ON CREATE SET inv.name = "${escCypher(invName)}", inv.entity_type = "unknown", inv.truth_score = 0.5, inv.created_at = datetime()
SET inv.updated_at = datetime()
WITH inv
MATCH (b:Bet {id: "${escCypher(betId)}"})
MERGE (b)-[r:STAKED_ON]->(inv)
SET r.type = "investor"
RETURN inv.id;`;

        runCypher(invCypher);
        result.relationshipsCreated.push(`STAKED_ON {investor} -> ${invName}`);
      }
    }

    // ── 6. Create RELATED_TO edges for remaining wikilinks ────────────────
    for (const link of note.allWikilinks) {
      if (alreadyLinked.has(link)) continue;
      const linkedId = generateEntityId(null, link);
      const relCypher = `MERGE (linked:Entity {id: "${escCypher(linkedId)}"})
ON CREATE SET linked.name = "${escCypher(link)}", linked.entity_type = "unknown", linked.truth_score = 0.5, linked.created_at = datetime()
SET linked.updated_at = datetime()
WITH linked
MATCH (b:Bet {id: "${escCypher(betId)}"})
MERGE (b)-[:RELATED_TO]->(linked)
RETURN linked.id;`;

      runCypher(relCypher);
      result.relationshipsCreated.push(`RELATED_TO -> ${link}`);
    }

    // ── 7. Handle conflicted truth score -> OpenQuestion ──────────────────
    if (fm.truth_score === "conflicted") {
      const oqId = `oq-${betId}-conflicted`;
      const oqCypher = `MERGE (oq:OpenQuestion {id: "${escCypher(oqId)}"})
SET oq.question = "Conflicted truth score on deal: ${escCypher(assetName)}",
    oq.status = "open",
    oq.domain = "${escCypher(domain)}",
    oq.source_entity = "${escCypher(betId)}",
    oq.created_at = datetime(),
    oq.updated_at = datetime()
WITH oq
MATCH (b:Bet {id: "${escCypher(betId)}"})
MERGE (b)-[:MENTIONS]->(oq)
RETURN oq.id;`;

      runCypher(oqCypher);
      result.openQuestionCreated = true;
      result.relationshipsCreated.push(`MENTIONS -> OpenQuestion(${oqId})`);
    }

    // ── 8. Handle stale truth score ───────────────────────────────────────
    if (fm.truth_score === "stale") {
      const flagCypher = `MATCH (b:Bet {id: "${escCypher(betId)}"})
SET b.needs_reverification = true, b.reverification_reason = "stale truth score"
RETURN b.id;`;

      runCypher(flagCypher);
    }

    result.success = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

// ── Investment Position Mapper ───────────────────────────────────────────────

/**
 * Map a parsed Investment Position note to Neo4j. Creates an Entity node
 * (entity_type: "investment-position") and links to the deal's Bet node
 * via the `deal` field wikilink. Also links held-by, held-alongside, k1-entity,
 * and custodian references.
 *
 * Idempotent: uses MERGE on id fields to avoid duplicates.
 */
export function mapInvestmentPositionToNeo4j(note: ParsedNote): PositionMapperResult {
  const fm = note.frontmatter;
  const filePath = note.filePath ?? "unknown";

  const assetName =
    toCypherString(fm["asset-name"]) ?? basename(filePath, ".md");
  const positionId = generatePositionId(note.filePath, assetName);
  const sourceId = generateSourceId(filePath);

  const result: PositionMapperResult = {
    positionId,
    sourceId,
    nodeProperties: {},
    relationshipsCreated: [],
    openQuestionCreated: false,
    success: false,
  };

  try {
    // ── 1. Create/update Entity node (entity_type: investment-position) ───
    const assetClass = toCypherString(fm["asset-class"]) ?? "unknown";
    const status = toCypherString(fm["status"]) ?? "unknown";
    const truthScoreNum = mapTruthScore(fm.truth_score);
    const domain = deriveDomain(fm["tags"]);
    const isCanonical = fm.is_canonical === true;
    const commitment = toCypherNumber(fm["commitment"]);
    const investedCapital = toCypherNumber(fm["invested-capital"]);
    const costBasis = toCypherNumber(fm["cost-basis"]);
    const currentValue = toCypherNumber(fm["current-value"]);
    const valueDate = toCypherString(fm["value-date"]);
    const ownershipPct = toCypherString(fm["ownership-pct"]);
    const unrealizedGain = toCypherNumber(fm["unrealized-gain"]);
    const distributionsReceived = toCypherNumber(fm["distributions-received"]);
    const taxCharacter = toCypherString(fm["tax-character"]);
    const liquidity = toCypherString(fm["liquidity"]);
    const lockUpEnd = toCypherString(fm["lock-up-end"]);
    const sourceSystem = toCypherString(fm["source-system"]);
    const sourceSystemId = toCypherString(fm["source-system-id"]);
    const sharesOwned = toCypherNumber(fm["shares-owned"]);
    const unitsOwned = toCypherNumber(fm["units-owned"]);
    const shares = toCypherNumber(fm["shares"]);
    const sharePrice = toCypherNumber(fm["share-price"]);
    const ticker = toCypherString(fm["ticker"]);
    const exchange = toCypherString(fm["exchange"]);
    const restrictionStatus = toCypherString(fm["restriction-status"]);
    const restrictionCode = toCypherString(fm["restriction-code"]);
    const restrictionLiftDate = toCypherString(fm["restriction-lift-date"]);
    const canonicalNote = toCypherString(fm["canonical_note"]);
    const investmentOrigin = toCypherString(fm["investment-origin"]);
    const accountNumberLast4 = toCypherString(fm["account-number-last4"]);
    const estatePlanningNotes = toCypherString(fm["estate-planning-notes"]);

    const setProps: string[] = [
      `p.name = "${escCypher(assetName)}"`,
      `p.entity_type = "investment-position"`,
      `p.asset_class = "${escCypher(assetClass)}"`,
      `p.status = "${escCypher(status)}"`,
      `p.domain = "${escCypher(domain)}"`,
      `p.truth_score = ${truthScoreNum}`,
      `p.truth_basis = "${escCypher(fm.truth_score ?? "unscored")}"`,
      `p.is_canonical = ${isCanonical}`,
      `p.source_file = "${escCypher(filePath)}"`,
      `p.updated_at = datetime()`,
    ];

    if (commitment !== null) setProps.push(`p.commitment = ${commitment}`);
    if (investedCapital !== null) setProps.push(`p.invested_capital = ${investedCapital}`);
    if (costBasis !== null) setProps.push(`p.cost_basis = ${costBasis}`);
    if (currentValue !== null) setProps.push(`p.current_value = ${currentValue}`);
    if (valueDate) setProps.push(`p.value_date = "${escCypher(valueDate)}"`);
    if (ownershipPct) setProps.push(`p.ownership_pct = "${escCypher(ownershipPct)}"`);
    if (unrealizedGain !== null) setProps.push(`p.unrealized_gain = ${unrealizedGain}`);
    if (distributionsReceived !== null) setProps.push(`p.distributions_received = ${distributionsReceived}`);
    if (taxCharacter) setProps.push(`p.tax_character = "${escCypher(taxCharacter)}"`);
    if (liquidity) setProps.push(`p.liquidity = "${escCypher(liquidity)}"`);
    if (lockUpEnd) setProps.push(`p.lock_up_end = "${escCypher(lockUpEnd)}"`);
    if (sourceSystem) setProps.push(`p.source_system = "${escCypher(sourceSystem)}"`);
    if (sourceSystemId) setProps.push(`p.source_system_id = "${escCypher(sourceSystemId)}"`);
    if (sharesOwned !== null) setProps.push(`p.shares_owned = ${sharesOwned}`);
    if (unitsOwned !== null) setProps.push(`p.units_owned = ${unitsOwned}`);
    if (shares !== null) setProps.push(`p.shares = ${shares}`);
    if (sharePrice !== null) setProps.push(`p.share_price = ${sharePrice}`);
    if (ticker) setProps.push(`p.ticker = "${escCypher(ticker)}"`);
    if (exchange) setProps.push(`p.exchange = "${escCypher(exchange)}"`);
    if (restrictionStatus) setProps.push(`p.restriction_status = "${escCypher(restrictionStatus)}"`);
    if (restrictionCode) setProps.push(`p.restriction_code = "${escCypher(restrictionCode)}"`);
    if (restrictionLiftDate) setProps.push(`p.restriction_lift_date = "${escCypher(restrictionLiftDate)}"`);
    if (canonicalNote) setProps.push(`p.canonical_note = "${escCypher(canonicalNote)}"`);
    if (investmentOrigin) setProps.push(`p.investment_origin = "${escCypher(investmentOrigin)}"`);
    if (accountNumberLast4) setProps.push(`p.account_number_last4 = "${escCypher(accountNumberLast4)}"`);
    if (estatePlanningNotes) setProps.push(`p.estate_planning_notes = "${escCypher(estatePlanningNotes)}"`);

    const posCypher = `MERGE (p:Entity {id: "${escCypher(positionId)}"})
SET ${setProps.join(", ")}
RETURN p.id;`;

    runCypher(posCypher);
    result.nodeProperties = {
      id: positionId,
      name: assetName,
      entity_type: "investment-position",
      asset_class: assetClass,
      status,
      domain,
      truth_score: truthScoreNum,
      is_canonical: isCanonical,
    };

    // ── 2. Create Source node and SOURCED_FROM relationship ────────────────
    const sourceName = basename(filePath);
    const sourceCypher = `MERGE (s:Source {id: "${escCypher(sourceId)}"})
SET s.source_type = "obsidian_vault", s.file_path = "${escCypher(filePath)}", s.name = "${escCypher(sourceName)}", s.updated_at = datetime()
WITH s
MATCH (p:Entity {id: "${escCypher(positionId)}"})
MERGE (p)-[:SOURCED_FROM]->(s)
RETURN s.id;`;

    runCypher(sourceCypher);
    result.relationshipsCreated.push(`SOURCED_FROM -> ${sourceId}`);

    // ── 3. Link to Deal's Bet node via `deal` field ───────────────────────
    const dealRef = fm["deal"];
    const alreadyLinked = new Set<string>();
    if (typeof dealRef === "string" && dealRef.trim()) {
      const dealName = extractWikilinkTarget(dealRef);
      if (dealName) {
        alreadyLinked.add(dealName);
        const dealBetId = generateBetId(null, dealName);
        const dealCypher = `MERGE (bet:Bet {id: "${escCypher(dealBetId)}"})
ON CREATE SET bet.name = "${escCypher(dealName)}", bet.bet_type = "intentional", bet.truth_score = 0.5, bet.created_at = datetime()
SET bet.updated_at = datetime()
WITH bet
MATCH (pos:Entity {id: "${escCypher(positionId)}"})
MERGE (pos)-[:STAKED_ON]->(bet)
RETURN bet.id;`;

        runCypher(dealCypher);
        result.relationshipsCreated.push(`STAKED_ON -> Bet(${dealName})`);
      }
    }

    // ── 4. Link held-by entity ────────────────────────────────────────────
    const heldBy = fm["held-by"];
    if (typeof heldBy === "string" && heldBy.trim()) {
      const holderName = extractWikilinkTarget(heldBy);
      if (holderName) {
        alreadyLinked.add(holderName);
        const holderId = generateEntityId(null, holderName);
        const holderCypher = `MERGE (holder:Entity {id: "${escCypher(holderId)}"})
ON CREATE SET holder.name = "${escCypher(holderName)}", holder.entity_type = "unknown", holder.truth_score = 0.5, holder.created_at = datetime()
SET holder.updated_at = datetime()
WITH holder
MATCH (pos:Entity {id: "${escCypher(positionId)}"})
MERGE (pos)-[:BELONGS_TO]->(holder)
RETURN holder.id;`;

        runCypher(holderCypher);
        result.relationshipsCreated.push(`BELONGS_TO -> ${holderName}`);
      }
    }

    // ── 5. Link held-alongside entity ─────────────────────────────────────
    const heldAlongside = fm["held-alongside"];
    if (typeof heldAlongside === "string" && heldAlongside.trim()) {
      const alongsideName = extractWikilinkTarget(heldAlongside);
      if (alongsideName) {
        alreadyLinked.add(alongsideName);
        const alongsideId = generateEntityId(null, alongsideName);
        const alongsideCypher = `MERGE (co:Entity {id: "${escCypher(alongsideId)}"})
ON CREATE SET co.name = "${escCypher(alongsideName)}", co.entity_type = "unknown", co.truth_score = 0.5, co.created_at = datetime()
SET co.updated_at = datetime()
WITH co
MATCH (pos:Entity {id: "${escCypher(positionId)}"})
MERGE (pos)-[r:RELATED_TO]->(co)
SET r.type = "held_alongside"
RETURN co.id;`;

        runCypher(alongsideCypher);
        result.relationshipsCreated.push(`RELATED_TO {held_alongside} -> ${alongsideName}`);
      }
    }

    // ── 6. Link k1-entity ─────────────────────────────────────────────────
    const k1Entity = fm["k1-entity"];
    if (typeof k1Entity === "string" && k1Entity.trim()) {
      const k1Name = extractWikilinkTarget(k1Entity);
      if (k1Name) {
        alreadyLinked.add(k1Name);
        const k1Id = generateEntityId(null, k1Name);
        const k1Cypher = `MERGE (k1:Entity {id: "${escCypher(k1Id)}"})
ON CREATE SET k1.name = "${escCypher(k1Name)}", k1.entity_type = "unknown", k1.truth_score = 0.5, k1.created_at = datetime()
SET k1.updated_at = datetime()
WITH k1
MATCH (pos:Entity {id: "${escCypher(positionId)}"})
MERGE (pos)-[r:RELATED_TO]->(k1)
SET r.type = "k1_entity"
RETURN k1.id;`;

        runCypher(k1Cypher);
        result.relationshipsCreated.push(`RELATED_TO {k1_entity} -> ${k1Name}`);
      }
    }

    // ── 7. Link custodian entity ──────────────────────────────────────────
    const custodian = fm["custodian"];
    if (typeof custodian === "string" && custodian.trim()) {
      const custodianName = extractWikilinkTarget(custodian);
      if (custodianName) {
        alreadyLinked.add(custodianName);
        const custodianId = generateEntityId(null, custodianName);
        const custodianCypher = `MERGE (cust:Entity {id: "${escCypher(custodianId)}"})
ON CREATE SET cust.name = "${escCypher(custodianName)}", cust.entity_type = "institution", cust.truth_score = 0.5, cust.created_at = datetime()
SET cust.updated_at = datetime()
WITH cust
MATCH (pos:Entity {id: "${escCypher(positionId)}"})
MERGE (pos)-[r:RELATED_TO]->(cust)
SET r.type = "custodian"
RETURN cust.id;`;

        runCypher(custodianCypher);
        result.relationshipsCreated.push(`RELATED_TO {custodian} -> ${custodianName}`);
      }
    }

    // ── 8. Create RELATED_TO edges for remaining wikilinks ────────────────
    for (const link of note.allWikilinks) {
      if (alreadyLinked.has(link)) continue;
      const linkedId = generateEntityId(null, link);
      const relCypher = `MERGE (linked:Entity {id: "${escCypher(linkedId)}"})
ON CREATE SET linked.name = "${escCypher(link)}", linked.entity_type = "unknown", linked.truth_score = 0.5, linked.created_at = datetime()
SET linked.updated_at = datetime()
WITH linked
MATCH (pos:Entity {id: "${escCypher(positionId)}"})
MERGE (pos)-[:RELATED_TO]->(linked)
RETURN linked.id;`;

      runCypher(relCypher);
      result.relationshipsCreated.push(`RELATED_TO -> ${link}`);
    }

    // ── 9. Handle conflicted truth score -> OpenQuestion ──────────────────
    if (fm.truth_score === "conflicted") {
      const oqId = `oq-${positionId}-conflicted`;
      const oqCypher = `MERGE (oq:OpenQuestion {id: "${escCypher(oqId)}"})
SET oq.question = "Conflicted truth score on position: ${escCypher(assetName)}",
    oq.status = "open",
    oq.domain = "${escCypher(domain)}",
    oq.source_entity = "${escCypher(positionId)}",
    oq.created_at = datetime(),
    oq.updated_at = datetime()
WITH oq
MATCH (pos:Entity {id: "${escCypher(positionId)}"})
MERGE (pos)-[:MENTIONS]->(oq)
RETURN oq.id;`;

      runCypher(oqCypher);
      result.openQuestionCreated = true;
      result.relationshipsCreated.push(`MENTIONS -> OpenQuestion(${oqId})`);
    }

    // ── 10. Handle stale truth score ──────────────────────────────────────
    if (fm.truth_score === "stale") {
      const flagCypher = `MATCH (p:Entity {id: "${escCypher(positionId)}"})
SET p.needs_reverification = true, p.reverification_reason = "stale truth score"
RETURN p.id;`;

      runCypher(flagCypher);
    }

    result.success = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

// ── Person Mapper ────────────────────────────────────────────────────────────

/**
 * Map a parsed Person note to Neo4j as (:Entity {entity_type: "person"}).
 * Creates relationships for company links, family relationships (spouse,
 * parent, child, sibling), financial roles, trusts, and advisors.
 *
 * Idempotent: uses MERGE on id fields to avoid duplicates.
 */
export function mapPersonToNeo4j(note: ParsedNote): PersonMapperResult {
  const fm = note.frontmatter;
  const filePath = note.filePath ?? "unknown";

  const personName =
    toCypherString(fm["name"]) ?? basename(filePath, ".md");
  const personId = generatePersonId(note.filePath, personName);
  const sourceId = generateSourceId(filePath);

  const result: PersonMapperResult = {
    personId,
    sourceId,
    nodeProperties: {},
    relationshipsCreated: [],
    openQuestionCreated: false,
    success: false,
  };

  try {
    // ── 1. Create/update Entity node (entity_type: person) ────────────────
    const truthScoreNum = mapTruthScore(fm.truth_score);
    const domain = deriveDomain(fm["tags"]);
    const isCanonical = fm.is_canonical === true;
    const status = toCypherString(fm["status"]) ?? "active";
    const role = toCypherString(fm["role"]);
    const company = toCypherString(fm["company"]);
    const location = toCypherString(fm["location"]);
    const email = toCypherString(fm["email"]);
    const linkedin = toCypherString(fm["linkedin"]);
    const phoneMobile = toCypherString(fm["phone_mobile"]);
    const phoneOffice = toCypherString(fm["phone_office"]);
    const birthday = toCypherString(fm["birthday"]);
    const met = toCypherString(fm["met"]);
    const relationship = toCypherString(fm["relationship"]);
    const circle = toCypherString(fm["circle"]);
    const contactFrequency = toCypherNumber(fm["contact-frequency"]);
    const lastContacted = toCypherString(fm["last-contacted"]);
    const taxFilingStatus = toCypherString(fm["tax-filing-status"]);

    const aliases = Array.isArray(fm["aliases"])
      ? fm["aliases"].filter((a): a is string => typeof a === "string")
      : [];

    const setProps: string[] = [
      `e.name = "${escCypher(personName)}"`,
      `e.entity_type = "person"`,
      `e.domain = "${escCypher(domain)}"`,
      `e.truth_score = ${truthScoreNum}`,
      `e.truth_basis = "${escCypher(fm.truth_score ?? "unscored")}"`,
      `e.is_canonical = ${isCanonical}`,
      `e.status = "${escCypher(status)}"`,
      `e.source_file = "${escCypher(filePath)}"`,
      `e.updated_at = datetime()`,
    ];

    if (aliases.length > 0) {
      const aliasStr = aliases.map((a) => `"${escCypher(a)}"`).join(", ");
      setProps.push(`e.aliases = [${aliasStr}]`);
    } else {
      setProps.push(`e.aliases = []`);
    }

    if (role) setProps.push(`e.role = "${escCypher(role)}"`);
    if (company) setProps.push(`e.company = "${escCypher(company)}"`);
    if (location) setProps.push(`e.location = "${escCypher(location)}"`);
    if (email) setProps.push(`e.email = "${escCypher(email)}"`);
    if (linkedin) setProps.push(`e.linkedin = "${escCypher(linkedin)}"`);
    if (phoneMobile) setProps.push(`e.phone_mobile = "${escCypher(phoneMobile)}"`);
    if (phoneOffice) setProps.push(`e.phone_office = "${escCypher(phoneOffice)}"`);
    if (birthday) setProps.push(`e.birthday = "${escCypher(birthday)}"`);
    if (met) setProps.push(`e.met = "${escCypher(met)}"`);
    if (relationship) setProps.push(`e.relationship = "${escCypher(relationship)}"`);
    if (circle) setProps.push(`e.circle = "${escCypher(circle)}"`);
    if (contactFrequency !== null) setProps.push(`e.contact_frequency = ${contactFrequency}`);
    if (lastContacted) setProps.push(`e.last_contacted = "${escCypher(lastContacted)}"`);
    if (taxFilingStatus) setProps.push(`e.tax_filing_status = "${escCypher(taxFilingStatus)}"`);

    const personCypher = `MERGE (e:Entity {id: "${escCypher(personId)}"})
SET ${setProps.join(", ")}
RETURN e.id;`;

    runCypher(personCypher);
    result.nodeProperties = {
      id: personId,
      name: personName,
      entity_type: "person",
      domain,
      truth_score: truthScoreNum,
      is_canonical: isCanonical,
      status,
      relationship,
      circle,
      contact_frequency: contactFrequency,
    };

    // ── 2. Create Source node and SOURCED_FROM relationship ────────────────
    const sourceName = basename(filePath);
    const sourceCypher = `MERGE (s:Source {id: "${escCypher(sourceId)}"})
SET s.source_type = "obsidian_vault", s.file_path = "${escCypher(filePath)}", s.name = "${escCypher(sourceName)}", s.updated_at = datetime()
WITH s
MATCH (e:Entity {id: "${escCypher(personId)}"})
MERGE (e)-[:SOURCED_FROM]->(s)
RETURN s.id;`;

    runCypher(sourceCypher);
    result.relationshipsCreated.push(`SOURCED_FROM -> ${sourceId}`);

    // Track all explicitly linked entities to avoid duplicate RELATED_TO
    const alreadyLinked = new Set<string>();

    // ── 3. Link company as Entity ─────────────────────────────────────────
    if (company) {
      // If company is a wikilink, extract; otherwise use as-is
      const companyName = extractWikilinkTarget(company);
      if (companyName) {
        alreadyLinked.add(companyName);
        const companyId = generateEntityId(null, companyName);
        const companyCypher = `MERGE (comp:Entity {id: "${escCypher(companyId)}"})
ON CREATE SET comp.name = "${escCypher(companyName)}", comp.entity_type = "unknown", comp.truth_score = 0.5, comp.created_at = datetime()
SET comp.updated_at = datetime()
WITH comp
MATCH (e:Entity {id: "${escCypher(personId)}"})
MERGE (e)-[r:RELATED_TO]->(comp)
SET r.type = "works_at"
RETURN comp.id;`;

        runCypher(companyCypher);
        result.relationshipsCreated.push(`RELATED_TO {works_at} -> ${companyName}`);
      }
    }

    // ── 4. Family relationships: spouse, parent, child, sibling ───────────
    const familyFields: Array<{ field: string; relType: string }> = [
      { field: "spouse", relType: "RELATED_TO" },
      { field: "parent", relType: "RELATED_TO" },
      { field: "child", relType: "RELATED_TO" },
      { field: "sibling", relType: "RELATED_TO" },
    ];

    for (const { field, relType } of familyFields) {
      const val = fm[field];
      const refs: string[] = [];
      if (typeof val === "string" && val.trim()) {
        refs.push(val);
      } else if (Array.isArray(val)) {
        for (const v of val) {
          if (typeof v === "string" && v.trim()) refs.push(v);
        }
      }

      for (const ref of refs) {
        const memberName = extractWikilinkTarget(ref);
        if (!memberName) continue;
        alreadyLinked.add(memberName);
        const memberId = generateEntityId(null, memberName);
        const memberCypher = `MERGE (fam:Entity {id: "${escCypher(memberId)}"})
ON CREATE SET fam.name = "${escCypher(memberName)}", fam.entity_type = "person", fam.truth_score = 0.5, fam.created_at = datetime()
SET fam.updated_at = datetime()
WITH fam
MATCH (e:Entity {id: "${escCypher(personId)}"})
MERGE (e)-[r:${relType}]->(fam)
SET r.type = "${field}"
RETURN fam.id;`;

        runCypher(memberCypher);
        result.relationshipsCreated.push(`${relType} {${field}} -> ${memberName}`);
      }
    }

    // ── 5. Financial roles ────────────────────────────────────────────────
    const financialRoles = fm["financial-roles"];
    if (Array.isArray(financialRoles)) {
      for (const fr of financialRoles) {
        if (typeof fr !== "object" || fr === null) continue;
        const roleObj = fr as Record<string, unknown>;
        const frRole = toCypherString(roleObj["role"]);
        const frEntity = toCypherString(roleObj["entity"]);
        if (!frEntity) continue;
        const entName = extractWikilinkTarget(frEntity);
        if (!entName) continue;
        alreadyLinked.add(entName);
        const entId = generateEntityId(null, entName);
        const frCypher = `MERGE (ent:Entity {id: "${escCypher(entId)}"})
ON CREATE SET ent.name = "${escCypher(entName)}", ent.entity_type = "unknown", ent.truth_score = 0.5, ent.created_at = datetime()
SET ent.updated_at = datetime()
WITH ent
MATCH (e:Entity {id: "${escCypher(personId)}"})
MERGE (e)-[r:RELATED_TO]->(ent)
SET r.type = "financial_role", r.role = "${escCypher(frRole ?? "unknown")}"
RETURN ent.id;`;

        runCypher(frCypher);
        result.relationshipsCreated.push(`RELATED_TO {financial_role: ${frRole}} -> ${entName}`);
      }
    }

    // ── 6. Trusts ─────────────────────────────────────────────────────────
    const trusts = fm["trusts"];
    if (Array.isArray(trusts)) {
      for (const t of trusts) {
        if (typeof t !== "string" || !t.trim()) continue;
        const trustName = extractWikilinkTarget(t);
        if (!trustName) continue;
        alreadyLinked.add(trustName);
        const trustId = generateEntityId(null, trustName);
        const trustCypher = `MERGE (trust:Entity {id: "${escCypher(trustId)}"})
ON CREATE SET trust.name = "${escCypher(trustName)}", trust.entity_type = "unknown", trust.truth_score = 0.5, trust.created_at = datetime()
SET trust.updated_at = datetime()
WITH trust
MATCH (e:Entity {id: "${escCypher(personId)}"})
MERGE (e)-[r:RELATED_TO]->(trust)
SET r.type = "trust_beneficiary"
RETURN trust.id;`;

        runCypher(trustCypher);
        result.relationshipsCreated.push(`RELATED_TO {trust_beneficiary} -> ${trustName}`);
      }
    }

    // ── 7. Advisors: CPA, estate attorney, wealth managers ────────────────
    const advisorFields: Array<{ field: string; relType: string }> = [
      { field: "cpa", relType: "cpa" },
      { field: "estate-attorney", relType: "estate_attorney" },
    ];

    for (const { field, relType } of advisorFields) {
      const val = fm[field];
      if (typeof val !== "string" || !val.trim()) continue;
      const advisorName = extractWikilinkTarget(val);
      if (!advisorName) continue;
      alreadyLinked.add(advisorName);
      const advisorId = generateEntityId(null, advisorName);
      const advisorCypher = `MERGE (adv:Entity {id: "${escCypher(advisorId)}"})
ON CREATE SET adv.name = "${escCypher(advisorName)}", adv.entity_type = "institution", adv.truth_score = 0.5, adv.created_at = datetime()
SET adv.updated_at = datetime()
WITH adv
MATCH (e:Entity {id: "${escCypher(personId)}"})
MERGE (e)-[r:RELATED_TO]->(adv)
SET r.type = "${relType}"
RETURN adv.id;`;

      runCypher(advisorCypher);
      result.relationshipsCreated.push(`RELATED_TO {${relType}} -> ${advisorName}`);
    }

    const wealthManagers = fm["wealth-managers"];
    if (Array.isArray(wealthManagers)) {
      for (const wm of wealthManagers) {
        if (typeof wm !== "string" || !wm.trim()) continue;
        const wmName = extractWikilinkTarget(wm);
        if (!wmName) continue;
        alreadyLinked.add(wmName);
        const wmId = generateEntityId(null, wmName);
        const wmCypher = `MERGE (wm:Entity {id: "${escCypher(wmId)}"})
ON CREATE SET wm.name = "${escCypher(wmName)}", wm.entity_type = "institution", wm.truth_score = 0.5, wm.created_at = datetime()
SET wm.updated_at = datetime()
WITH wm
MATCH (e:Entity {id: "${escCypher(personId)}"})
MERGE (e)-[r:RELATED_TO]->(wm)
SET r.type = "wealth_manager"
RETURN wm.id;`;

        runCypher(wmCypher);
        result.relationshipsCreated.push(`RELATED_TO {wealth_manager} -> ${wmName}`);
      }
    }

    // ── 8. Create RELATED_TO edges for remaining wikilinks ────────────────
    for (const link of note.allWikilinks) {
      if (alreadyLinked.has(link)) continue;
      const linkedId = generateEntityId(null, link);
      const relCypher = `MERGE (linked:Entity {id: "${escCypher(linkedId)}"})
ON CREATE SET linked.name = "${escCypher(link)}", linked.entity_type = "unknown", linked.truth_score = 0.5, linked.created_at = datetime()
SET linked.updated_at = datetime()
WITH linked
MATCH (e:Entity {id: "${escCypher(personId)}"})
MERGE (e)-[:RELATED_TO]->(linked)
RETURN linked.id;`;

      runCypher(relCypher);
      result.relationshipsCreated.push(`RELATED_TO -> ${link}`);
    }

    // ── 9. Handle conflicted truth score -> OpenQuestion ──────────────────
    if (fm.truth_score === "conflicted") {
      const oqId = `oq-${personId}-conflicted`;
      const oqCypher = `MERGE (oq:OpenQuestion {id: "${escCypher(oqId)}"})
SET oq.question = "Conflicted truth score on person: ${escCypher(personName)}",
    oq.status = "open",
    oq.domain = "${escCypher(domain)}",
    oq.source_entity = "${escCypher(personId)}",
    oq.created_at = datetime(),
    oq.updated_at = datetime()
WITH oq
MATCH (e:Entity {id: "${escCypher(personId)}"})
MERGE (e)-[:MENTIONS]->(oq)
RETURN oq.id;`;

      runCypher(oqCypher);
      result.openQuestionCreated = true;
      result.relationshipsCreated.push(`MENTIONS -> OpenQuestion(${oqId})`);
    }

    // ── 10. Handle stale truth score ──────────────────────────────────────
    if (fm.truth_score === "stale") {
      const flagCypher = `MATCH (e:Entity {id: "${escCypher(personId)}"})
SET e.needs_reverification = true, e.reverification_reason = "stale truth score"
RETURN e.id;`;

      runCypher(flagCypher);
    }

    result.success = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

// ── File-level convenience functions ─────────────────────────────────────────

export async function mapInvestmentDealNoteFile(
  filePath: string
): Promise<DealMapperResult> {
  const note = await parseNoteFile(filePath);
  if (note.templateType !== "investment" || note.investmentPerspective !== "deal") {
    return {
      betId: "",
      sourceId: "",
      nodeProperties: {},
      relationshipsCreated: [],
      openQuestionCreated: false,
      success: false,
      error: `Not an investment deal note (type: ${note.templateType ?? "none"}, perspective: ${note.investmentPerspective ?? "none"})`,
    };
  }
  return mapInvestmentDealToNeo4j(note);
}

export function mapInvestmentDealNoteString(
  content: string,
  filePath: string
): DealMapperResult {
  const note = parseNoteString(content, filePath);
  if (note.templateType !== "investment" || note.investmentPerspective !== "deal") {
    return {
      betId: "",
      sourceId: "",
      nodeProperties: {},
      relationshipsCreated: [],
      openQuestionCreated: false,
      success: false,
      error: `Not an investment deal note (type: ${note.templateType ?? "none"}, perspective: ${note.investmentPerspective ?? "none"})`,
    };
  }
  return mapInvestmentDealToNeo4j(note);
}

export async function mapInvestmentPositionNoteFile(
  filePath: string
): Promise<PositionMapperResult> {
  const note = await parseNoteFile(filePath);
  if (note.templateType !== "investment" || note.investmentPerspective !== "personal") {
    return {
      positionId: "",
      sourceId: "",
      nodeProperties: {},
      relationshipsCreated: [],
      openQuestionCreated: false,
      success: false,
      error: `Not an investment position note (type: ${note.templateType ?? "none"}, perspective: ${note.investmentPerspective ?? "none"})`,
    };
  }
  return mapInvestmentPositionToNeo4j(note);
}

export function mapInvestmentPositionNoteString(
  content: string,
  filePath: string
): PositionMapperResult {
  const note = parseNoteString(content, filePath);
  if (note.templateType !== "investment" || note.investmentPerspective !== "personal") {
    return {
      positionId: "",
      sourceId: "",
      nodeProperties: {},
      relationshipsCreated: [],
      openQuestionCreated: false,
      success: false,
      error: `Not an investment position note (type: ${note.templateType ?? "none"}, perspective: ${note.investmentPerspective ?? "none"})`,
    };
  }
  return mapInvestmentPositionToNeo4j(note);
}

export async function mapPersonNoteFile(
  filePath: string
): Promise<PersonMapperResult> {
  const note = await parseNoteFile(filePath);
  if (note.templateType !== "person") {
    return {
      personId: "",
      sourceId: "",
      nodeProperties: {},
      relationshipsCreated: [],
      openQuestionCreated: false,
      success: false,
      error: `Not a person note (type: ${note.templateType ?? "none"})`,
    };
  }
  return mapPersonToNeo4j(note);
}

export function mapPersonNoteString(
  content: string,
  filePath: string
): PersonMapperResult {
  const note = parseNoteString(content, filePath);
  if (note.templateType !== "person") {
    return {
      personId: "",
      sourceId: "",
      nodeProperties: {},
      relationshipsCreated: [],
      openQuestionCreated: false,
      success: false,
      error: `Not a person note (type: ${note.templateType ?? "none"})`,
    };
  }
  return mapPersonToNeo4j(note);
}
