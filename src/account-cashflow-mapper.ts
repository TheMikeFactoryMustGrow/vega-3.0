/**
 * Account & Cash Flow Frontmatter-to-Neo4j Mapper (US-014)
 *
 * Maps Account notes to (:Entity {entity_type: "account"}) nodes with institution
 * links, held-by references, and Plaid connection status. Maps Cash Flow notes to
 * relationship edges between entities/accounts with amount, frequency, direction,
 * tax-deductible, and essential properties.
 *
 * Usage:
 *   import { mapAccountToNeo4j, mapCashFlowToNeo4j } from "../src/account-cashflow-mapper.js";
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

export interface AccountMapperResult {
  accountId: string;
  sourceId: string;
  nodeProperties: Record<string, unknown>;
  relationshipsCreated: string[];
  openQuestionCreated: boolean;
  success: boolean;
  error?: string;
}

export interface CashFlowMapperResult {
  cashFlowId: string;
  sourceId: string;
  edgeProperties: Record<string, unknown>;
  relationshipsCreated: string[];
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

function toCypherBool(val: unknown): boolean | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    const s = val.toLowerCase().trim();
    if (s === "true" || s === "yes") return true;
    if (s === "false" || s === "no") return false;
  }
  return null;
}

/**
 * Derive the domain from tags array for account/cash-flow notes.
 */
function deriveDomain(tags: unknown): string {
  if (!Array.isArray(tags)) return "finance";
  const tagStrings = tags.filter((t): t is string => typeof t === "string");
  if (tagStrings.includes("personal")) return "personal";
  if (tagStrings.includes("household")) return "household";
  if (tagStrings.includes("we")) return "we";
  if (tagStrings.includes("real-estate")) return "real-estate";
  if (tagStrings.includes("auto")) return "auto";
  return "finance";
}

/**
 * Generate a deterministic account ID from file path or account name.
 */
export function generateAccountId(
  filePath: string | null,
  accountName: string | null
): string {
  const base = filePath ? basename(filePath, ".md") : accountName;
  if (!base) return `account-${Date.now()}`;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Generate a deterministic cash flow ID from file path or description.
 */
export function generateCashFlowId(
  filePath: string | null,
  description: string | null
): string {
  const base = filePath ? basename(filePath, ".md") : description;
  if (!base) return `cashflow-${Date.now()}`;
  return "cf-" + base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Account Mapper ───────────────────────────────────────────────────────────

/**
 * Map a parsed Account note to Neo4j, creating an Entity node (entity_type: account),
 * Source node, institution links, held-by references, and joint holder edges.
 *
 * Idempotent: uses MERGE on id fields to avoid duplicates.
 */
export function mapAccountToNeo4j(note: ParsedNote): AccountMapperResult {
  const fm = note.frontmatter;
  const filePath = note.filePath ?? "unknown";

  const accountName =
    toCypherString(fm["account-name"]) ?? basename(filePath, ".md");
  const accountId = generateAccountId(note.filePath, accountName);
  const sourceId = generateSourceId(filePath);

  const result: AccountMapperResult = {
    accountId,
    sourceId,
    nodeProperties: {},
    relationshipsCreated: [],
    openQuestionCreated: false,
    success: false,
  };

  try {
    // ── 1. Create/update Entity node (entity_type: account) ───────────────
    const accountType = toCypherString(fm["account-type"]) ?? "unknown";
    const truthScoreNum = mapTruthScore(fm.truth_score);
    const domain = deriveDomain(fm["tags"]);
    const status = toCypherString(fm["status"]) ?? "unknown";
    const purpose = toCypherString(fm["purpose"]);
    const currency = toCypherString(fm["currency"]) ?? "USD";
    const sourceSystem = toCypherString(fm["source-system"]);
    const plaidConnected = toCypherBool(fm["plaid-connected"]);
    const accountNumberLast4 = toCypherString(fm["account-number-last4"]);
    const isCanonical = fm.is_canonical === true;

    const setProps: string[] = [
      `e.name = "${escCypher(accountName)}"`,
      `e.entity_type = "account"`,
      `e.account_type = "${escCypher(accountType)}"`,
      `e.domain = "${escCypher(domain)}"`,
      `e.truth_score = ${truthScoreNum}`,
      `e.truth_basis = "${escCypher(fm.truth_score ?? "unscored")}"`,
      `e.is_canonical = ${isCanonical}`,
      `e.status = "${escCypher(status)}"`,
      `e.currency = "${escCypher(currency)}"`,
      `e.source_file = "${escCypher(filePath)}"`,
      `e.updated_at = datetime()`,
    ];

    if (purpose) {
      setProps.push(`e.purpose = "${escCypher(purpose)}"`);
    }
    if (sourceSystem) {
      setProps.push(`e.source_system = "${escCypher(sourceSystem)}"`);
    }
    if (plaidConnected !== null) {
      setProps.push(`e.plaid_connected = ${plaidConnected}`);
    }
    if (accountNumberLast4) {
      setProps.push(
        `e.account_number_last4 = "${escCypher(accountNumberLast4)}"`
      );
    }

    // Debt-specific fields
    const principalBalance = toCypherNumber(fm["principal-balance"]);
    if (principalBalance !== null) {
      setProps.push(`e.principal_balance = ${principalBalance}`);
    }
    const balance = toCypherNumber(fm["balance"]);
    if (balance !== null) {
      setProps.push(`e.balance = ${balance}`);
    }
    const asOfDate = toCypherString(fm["as-of-date"]);
    if (asOfDate) {
      setProps.push(`e.as_of_date = "${escCypher(asOfDate)}"`);
    }
    const interestRate = toCypherString(fm["interest-rate"]);
    if (interestRate) {
      setProps.push(`e.interest_rate = "${escCypher(interestRate)}"`);
    }
    const rateType = toCypherString(fm["rate-type"]);
    if (rateType) {
      setProps.push(`e.rate_type = "${escCypher(rateType)}"`);
    }
    const monthlyPayment = toCypherNumber(fm["monthly-payment"]);
    if (monthlyPayment !== null) {
      setProps.push(`e.monthly_payment = ${monthlyPayment}`);
    }
    const paymentDueDate = toCypherString(fm["payment-due-date"]);
    if (paymentDueDate) {
      setProps.push(`e.payment_due_date = "${escCypher(paymentDueDate)}"`);
    }
    const originalBalance = toCypherNumber(fm["original-balance"]) ?? toCypherNumber(fm["original-loan-amount"]);
    if (originalBalance !== null) {
      setProps.push(`e.original_balance = ${originalBalance}`);
    }
    const originationDate = toCypherString(fm["origination-date"]);
    if (originationDate) {
      setProps.push(`e.origination_date = "${escCypher(originationDate)}"`);
    }
    const maturityDate = toCypherString(fm["maturity-date"]);
    if (maturityDate) {
      setProps.push(`e.maturity_date = "${escCypher(maturityDate)}"`);
    }
    const collateral = toCypherString(fm["collateral"]);
    if (collateral) {
      setProps.push(`e.collateral = "${escCypher(collateral)}"`);
    }
    const deductible = toCypherBool(fm["deductible"]);
    if (deductible !== null) {
      setProps.push(`e.deductible = ${deductible}`);
    }
    const deductionType = toCypherString(fm["deduction-type"]);
    if (deductionType) {
      setProps.push(`e.deduction_type = "${escCypher(deductionType)}"`);
    }
    const loanTerm = toCypherString(fm["loan-term"]);
    if (loanTerm) {
      setProps.push(`e.loan_term = "${escCypher(loanTerm)}"`);
    }

    const entityCypher = `MERGE (e:Entity {id: "${escCypher(accountId)}"})
SET ${setProps.join(", ")}
RETURN e.id;`;

    runCypher(entityCypher);
    result.nodeProperties = {
      id: accountId,
      name: accountName,
      entity_type: "account",
      account_type: accountType,
      domain,
      truth_score: truthScoreNum,
      is_canonical: isCanonical,
      status,
      plaid_connected: plaidConnected,
    };

    // ── 2. Create Source node and SOURCED_FROM relationship ────────────────
    const sourceName = basename(filePath);
    const sourceCypher = `MERGE (s:Source {id: "${escCypher(sourceId)}"})
SET s.source_type = "obsidian_vault", s.file_path = "${escCypher(filePath)}", s.name = "${escCypher(sourceName)}", s.updated_at = datetime()
WITH s
MATCH (e:Entity {id: "${escCypher(accountId)}"})
MERGE (e)-[:SOURCED_FROM]->(s)
RETURN s.id;`;

    runCypher(sourceCypher);
    result.relationshipsCreated.push(`SOURCED_FROM -> ${sourceId}`);

    // ── 3. Create institution RELATED_TO {type: "held_at"} relationship ───
    const institutionRef = fm["institution"];
    if (typeof institutionRef === "string" && institutionRef.trim()) {
      const instName = extractWikilinkTarget(institutionRef);
      if (instName) {
        const instId = generateEntityId(null, instName);
        const instCypher = `MERGE (inst:Entity {id: "${escCypher(instId)}"})
ON CREATE SET inst.name = "${escCypher(instName)}", inst.entity_type = "institution", inst.truth_score = 0.5, inst.created_at = datetime()
SET inst.updated_at = datetime()
WITH inst
MATCH (acct:Entity {id: "${escCypher(accountId)}"})
MERGE (acct)-[r:RELATED_TO]->(inst)
SET r.type = "held_at"
RETURN inst.id;`;

        runCypher(instCypher);
        result.relationshipsCreated.push(
          `RELATED_TO {held_at} -> ${instName}`
        );
      }
    }

    // ── 4. Create held-by BELONGS_TO relationship ─────────────────────────
    const heldBy = fm["held-by"];
    const belongsToTargets = new Set<string>();
    if (typeof heldBy === "string" && heldBy.trim()) {
      const holderName = extractWikilinkTarget(heldBy);
      if (holderName) {
        belongsToTargets.add(holderName);
        const holderId = generateEntityId(null, holderName);
        const holderCypher = `MERGE (holder:Entity {id: "${escCypher(holderId)}"})
ON CREATE SET holder.name = "${escCypher(holderName)}", holder.entity_type = "unknown", holder.truth_score = 0.5, holder.created_at = datetime()
SET holder.updated_at = datetime()
WITH holder
MATCH (acct:Entity {id: "${escCypher(accountId)}"})
MERGE (acct)-[:BELONGS_TO]->(holder)
RETURN holder.id;`;

        runCypher(holderCypher);
        result.relationshipsCreated.push(`BELONGS_TO -> ${holderName}`);
      }
    }

    // ── 5. Create joint-holder RELATED_TO {type: "joint_holder"} edges ────
    const jointHolders = fm["joint-holders"];
    if (Array.isArray(jointHolders)) {
      for (const jh of jointHolders) {
        if (typeof jh !== "string") continue;
        const jhName = extractWikilinkTarget(jh);
        if (!jhName) continue;
        belongsToTargets.add(jhName);
        const jhId = generateEntityId(null, jhName);
        const jhCypher = `MERGE (jh:Entity {id: "${escCypher(jhId)}"})
ON CREATE SET jh.name = "${escCypher(jhName)}", jh.entity_type = "unknown", jh.truth_score = 0.5, jh.created_at = datetime()
SET jh.updated_at = datetime()
WITH jh
MATCH (acct:Entity {id: "${escCypher(accountId)}"})
MERGE (acct)-[r:RELATED_TO]->(jh)
SET r.type = "joint_holder"
RETURN jh.id;`;

        runCypher(jhCypher);
        result.relationshipsCreated.push(
          `RELATED_TO {joint_holder} -> ${jhName}`
        );
      }
    }

    // ── 6. Create lender RELATED_TO {type: "lender"} relationship ─────────
    const lenderRef = fm["lender"];
    if (typeof lenderRef === "string" && lenderRef.trim()) {
      const lenderName = extractWikilinkTarget(lenderRef);
      if (lenderName) {
        const lenderId = generateEntityId(null, lenderName);
        const lenderCypher = `MERGE (lender:Entity {id: "${escCypher(lenderId)}"})
ON CREATE SET lender.name = "${escCypher(lenderName)}", lender.entity_type = "institution", lender.truth_score = 0.5, lender.created_at = datetime()
SET lender.updated_at = datetime()
WITH lender
MATCH (acct:Entity {id: "${escCypher(accountId)}"})
MERGE (acct)-[r:RELATED_TO]->(lender)
SET r.type = "lender"
RETURN lender.id;`;

        runCypher(lenderCypher);
        result.relationshipsCreated.push(
          `RELATED_TO {lender} -> ${lenderName}`
        );
      }
    }

    // ── 7. Create RELATED_TO edges for remaining wikilinks ────────────────
    // Track targets already linked via institution, held-by, joint-holders, lender
    const alreadyLinked = new Set<string>(belongsToTargets);
    if (typeof institutionRef === "string") {
      alreadyLinked.add(extractWikilinkTarget(institutionRef));
    }
    if (typeof lenderRef === "string") {
      alreadyLinked.add(extractWikilinkTarget(lenderRef));
    }

    for (const link of note.allWikilinks) {
      if (alreadyLinked.has(link)) continue;
      const linkedId = generateEntityId(null, link);
      const relCypher = `MERGE (linked:Entity {id: "${escCypher(linkedId)}"})
ON CREATE SET linked.name = "${escCypher(link)}", linked.entity_type = "unknown", linked.truth_score = 0.5, linked.created_at = datetime()
SET linked.updated_at = datetime()
WITH linked
MATCH (e:Entity {id: "${escCypher(accountId)}"})
MERGE (e)-[:RELATED_TO]->(linked)
RETURN linked.id;`;

      runCypher(relCypher);
      result.relationshipsCreated.push(`RELATED_TO -> ${link}`);
    }

    // ── 8. Handle conflicted truth score -> OpenQuestion ──────────────────
    if (fm.truth_score === "conflicted") {
      const oqId = `oq-${accountId}-conflicted`;
      const oqCypher = `MERGE (oq:OpenQuestion {id: "${escCypher(oqId)}"})
SET oq.question = "Conflicted truth score on account: ${escCypher(accountName)}",
    oq.status = "open",
    oq.domain = "${escCypher(domain)}",
    oq.source_entity = "${escCypher(accountId)}",
    oq.created_at = datetime(),
    oq.updated_at = datetime()
WITH oq
MATCH (e:Entity {id: "${escCypher(accountId)}"})
MERGE (e)-[:MENTIONS]->(oq)
RETURN oq.id;`;

      runCypher(oqCypher);
      result.openQuestionCreated = true;
      result.relationshipsCreated.push(`MENTIONS -> OpenQuestion(${oqId})`);
    }

    // ── 9. Handle stale truth score -> flag for re-verification ───────────
    if (fm.truth_score === "stale") {
      const flagCypher = `MATCH (e:Entity {id: "${escCypher(accountId)}"})
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

// ── Cash Flow Mapper ─────────────────────────────────────────────────────────

/**
 * Map a parsed Cash Flow note to Neo4j. Creates a dedicated CashFlow-labeled
 * node (since cash flows are standalone entities with many properties) plus
 * relationship edges linking from-entity/account and to-entity/account.
 *
 * Cash flows reference entities/accounts via wikilinks in from-account,
 * to-account, from-entity, to-entity fields.
 *
 * Idempotent: uses MERGE on id fields to avoid duplicates.
 */
export function mapCashFlowToNeo4j(note: ParsedNote): CashFlowMapperResult {
  const fm = note.frontmatter;
  const filePath = note.filePath ?? "unknown";

  const description =
    toCypherString(fm["description"]) ?? basename(filePath, ".md");
  const cashFlowId = generateCashFlowId(note.filePath, description);
  const sourceId = generateSourceId(filePath);

  const result: CashFlowMapperResult = {
    cashFlowId,
    sourceId,
    edgeProperties: {},
    relationshipsCreated: [],
    success: false,
  };

  try {
    // ── 1. Create/update the CashFlow node ────────────────────────────────
    const flowType = toCypherString(fm["flow-type"]) ?? "unknown";
    const direction = toCypherString(fm["direction"]) ?? "unknown";
    const status = toCypherString(fm["status"]) ?? "active";
    const amount = toCypherNumber(fm["amount"]);
    const frequency = toCypherString(fm["frequency"]) ?? "unknown";
    const domain = deriveDomain(fm["tags"]);
    const truthScoreNum = mapTruthScore(fm.truth_score);
    const isCanonical = fm.is_canonical === true;
    const taxDeductible = toCypherBool(fm["tax-deductible"]);
    const essential = toCypherBool(fm["essential"]);
    const category = toCypherString(fm["category"]);
    const dayOfMonth = toCypherNumber(fm["day-of-month"]);
    const startDate = toCypherString(fm["start-date"]);
    const endDate = toCypherString(fm["end-date"]);
    const autoPay = toCypherBool(fm["auto-pay"]);
    const deductionType = toCypherString(fm["deduction-type"]);
    const notesOnFlow = toCypherString(fm["notes-on-flow"]);

    const setProps: string[] = [
      `cf.description = "${escCypher(description)}"`,
      `cf.flow_type = "${escCypher(flowType)}"`,
      `cf.direction = "${escCypher(direction)}"`,
      `cf.status = "${escCypher(status)}"`,
      `cf.frequency = "${escCypher(frequency)}"`,
      `cf.domain = "${escCypher(domain)}"`,
      `cf.truth_score = ${truthScoreNum}`,
      `cf.truth_basis = "${escCypher(fm.truth_score ?? "unscored")}"`,
      `cf.is_canonical = ${isCanonical}`,
      `cf.source_file = "${escCypher(filePath)}"`,
      `cf.updated_at = datetime()`,
    ];

    if (amount !== null) {
      setProps.push(`cf.amount = ${amount}`);
    }
    if (taxDeductible !== null) {
      setProps.push(`cf.tax_deductible = ${taxDeductible}`);
    }
    if (essential !== null) {
      setProps.push(`cf.essential = ${essential}`);
    }
    if (category) {
      setProps.push(`cf.category = "${escCypher(category)}"`);
    }
    if (dayOfMonth !== null) {
      setProps.push(`cf.day_of_month = ${dayOfMonth}`);
    }
    if (startDate) {
      setProps.push(`cf.start_date = "${escCypher(startDate)}"`);
    }
    if (endDate) {
      setProps.push(`cf.end_date = "${escCypher(endDate)}"`);
    }
    if (autoPay !== null) {
      setProps.push(`cf.auto_pay = ${autoPay}`);
    }
    if (deductionType) {
      setProps.push(`cf.deduction_type = "${escCypher(deductionType)}"`);
    }
    if (notesOnFlow) {
      setProps.push(`cf.notes = "${escCypher(notesOnFlow)}"`);
    }

    // Use Entity label so it participates in the graph uniformly
    // The entity_type: "cash-flow" distinguishes it
    const cfCypher = `MERGE (cf:Entity {id: "${escCypher(cashFlowId)}"})
SET cf.entity_type = "cash-flow", ${setProps.join(", ")}
RETURN cf.id;`;

    runCypher(cfCypher);
    result.edgeProperties = {
      id: cashFlowId,
      description,
      flow_type: flowType,
      direction,
      amount,
      frequency,
      status,
      tax_deductible: taxDeductible,
      essential,
    };

    // ── 2. Create Source node and SOURCED_FROM relationship ────────────────
    const sourceName = basename(filePath);
    const sourceCypher = `MERGE (s:Source {id: "${escCypher(sourceId)}"})
SET s.source_type = "obsidian_vault", s.file_path = "${escCypher(filePath)}", s.name = "${escCypher(sourceName)}", s.updated_at = datetime()
WITH s
MATCH (cf:Entity {id: "${escCypher(cashFlowId)}"})
MERGE (cf)-[:SOURCED_FROM]->(s)
RETURN s.id;`;

    runCypher(sourceCypher);
    result.relationshipsCreated.push(`SOURCED_FROM -> ${sourceId}`);

    // ── 3. Link from-account ──────────────────────────────────────────────
    const fromAccount = fm["from-account"];
    if (typeof fromAccount === "string" && fromAccount.trim()) {
      const fromName = extractWikilinkTarget(fromAccount);
      if (fromName) {
        const fromId = generateAccountId(null, fromName);
        const fromCypher = `MERGE (from:Entity {id: "${escCypher(fromId)}"})
ON CREATE SET from.name = "${escCypher(fromName)}", from.entity_type = "account", from.truth_score = 0.5, from.created_at = datetime()
SET from.updated_at = datetime()
WITH from
MATCH (cf:Entity {id: "${escCypher(cashFlowId)}"})
MERGE (cf)-[r:RELATED_TO]->(from)
SET r.type = "from_account"
RETURN from.id;`;

        runCypher(fromCypher);
        result.relationshipsCreated.push(
          `RELATED_TO {from_account} -> ${fromName}`
        );
      }
    }

    // ── 4. Link to-account ────────────────────────────────────────────────
    const toAccount = fm["to-account"];
    if (typeof toAccount === "string" && toAccount.trim()) {
      const toName = extractWikilinkTarget(toAccount);
      if (toName) {
        const toId = generateAccountId(null, toName);
        const toCypher = `MERGE (to:Entity {id: "${escCypher(toId)}"})
ON CREATE SET to.name = "${escCypher(toName)}", to.entity_type = "account", to.truth_score = 0.5, to.created_at = datetime()
SET to.updated_at = datetime()
WITH to
MATCH (cf:Entity {id: "${escCypher(cashFlowId)}"})
MERGE (cf)-[r:RELATED_TO]->(to)
SET r.type = "to_account"
RETURN to.id;`;

        runCypher(toCypher);
        result.relationshipsCreated.push(
          `RELATED_TO {to_account} -> ${toName}`
        );
      }
    }

    // ── 5. Link from-entity ───────────────────────────────────────────────
    const fromEntity = fm["from-entity"];
    if (typeof fromEntity === "string" && fromEntity.trim()) {
      const fromName = extractWikilinkTarget(fromEntity);
      if (fromName) {
        const fromId = generateEntityId(null, fromName);
        const fromCypher = `MERGE (from:Entity {id: "${escCypher(fromId)}"})
ON CREATE SET from.name = "${escCypher(fromName)}", from.entity_type = "unknown", from.truth_score = 0.5, from.created_at = datetime()
SET from.updated_at = datetime()
WITH from
MATCH (cf:Entity {id: "${escCypher(cashFlowId)}"})
MERGE (cf)-[r:RELATED_TO]->(from)
SET r.type = "from_entity"
RETURN from.id;`;

        runCypher(fromCypher);
        result.relationshipsCreated.push(
          `RELATED_TO {from_entity} -> ${fromName}`
        );
      }
    }

    // ── 6. Link to-entity ─────────────────────────────────────────────────
    const toEntity = fm["to-entity"];
    if (typeof toEntity === "string" && toEntity.trim()) {
      const toName = extractWikilinkTarget(toEntity);
      if (toName) {
        const toId = generateEntityId(null, toName);
        const toCypher = `MERGE (to:Entity {id: "${escCypher(toId)}"})
ON CREATE SET to.name = "${escCypher(toName)}", to.entity_type = "unknown", to.truth_score = 0.5, to.created_at = datetime()
SET to.updated_at = datetime()
WITH to
MATCH (cf:Entity {id: "${escCypher(cashFlowId)}"})
MERGE (cf)-[r:RELATED_TO]->(to)
SET r.type = "to_entity"
RETURN to.id;`;

        runCypher(toCypher);
        result.relationshipsCreated.push(
          `RELATED_TO {to_entity} -> ${toName}`
        );
      }
    }

    // ── 7. Link linked-debt ───────────────────────────────────────────────
    const linkedDebt = fm["linked-debt"];
    if (typeof linkedDebt === "string" && linkedDebt.trim()) {
      const debtName = extractWikilinkTarget(linkedDebt);
      if (debtName) {
        const debtId = generateAccountId(null, debtName);
        const debtCypher = `MERGE (debt:Entity {id: "${escCypher(debtId)}"})
ON CREATE SET debt.name = "${escCypher(debtName)}", debt.entity_type = "account", debt.truth_score = 0.5, debt.created_at = datetime()
SET debt.updated_at = datetime()
WITH debt
MATCH (cf:Entity {id: "${escCypher(cashFlowId)}"})
MERGE (cf)-[r:RELATED_TO]->(debt)
SET r.type = "linked_debt"
RETURN debt.id;`;

        runCypher(debtCypher);
        result.relationshipsCreated.push(
          `RELATED_TO {linked_debt} -> ${debtName}`
        );
      }
    }

    // ── 8. Link linked-investment ─────────────────────────────────────────
    const linkedInvestment = fm["linked-investment"];
    if (typeof linkedInvestment === "string" && linkedInvestment.trim()) {
      const investName = extractWikilinkTarget(linkedInvestment);
      if (investName) {
        const investId = generateEntityId(null, investName);
        const investCypher = `MERGE (invest:Entity {id: "${escCypher(investId)}"})
ON CREATE SET invest.name = "${escCypher(investName)}", invest.entity_type = "unknown", invest.truth_score = 0.5, invest.created_at = datetime()
SET invest.updated_at = datetime()
WITH invest
MATCH (cf:Entity {id: "${escCypher(cashFlowId)}"})
MERGE (cf)-[r:RELATED_TO]->(invest)
SET r.type = "linked_investment"
RETURN invest.id;`;

        runCypher(investCypher);
        result.relationshipsCreated.push(
          `RELATED_TO {linked_investment} -> ${investName}`
        );
      }
    }

    // ── 9. Create RELATED_TO edges for remaining wikilinks ────────────────
    const alreadyLinked = new Set<string>();
    for (const ref of [fromAccount, toAccount, fromEntity, toEntity, linkedDebt, linkedInvestment]) {
      if (typeof ref === "string" && ref.trim()) {
        alreadyLinked.add(extractWikilinkTarget(ref));
      }
    }

    for (const link of note.allWikilinks) {
      if (alreadyLinked.has(link)) continue;
      const linkedId = generateEntityId(null, link);
      const relCypher = `MERGE (linked:Entity {id: "${escCypher(linkedId)}"})
ON CREATE SET linked.name = "${escCypher(link)}", linked.entity_type = "unknown", linked.truth_score = 0.5, linked.created_at = datetime()
SET linked.updated_at = datetime()
WITH linked
MATCH (cf:Entity {id: "${escCypher(cashFlowId)}"})
MERGE (cf)-[:RELATED_TO]->(linked)
RETURN linked.id;`;

      runCypher(relCypher);
      result.relationshipsCreated.push(`RELATED_TO -> ${link}`);
    }

    result.success = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

// ── File-level convenience functions ─────────────────────────────────────────

/**
 * Map an Account note from a file path to Neo4j.
 */
export async function mapAccountNoteFile(
  filePath: string
): Promise<AccountMapperResult> {
  const note = await parseNoteFile(filePath);
  if (note.templateType !== "account") {
    return {
      accountId: "",
      sourceId: "",
      nodeProperties: {},
      relationshipsCreated: [],
      openQuestionCreated: false,
      success: false,
      error: `Not an account note (type: ${note.templateType ?? "none"})`,
    };
  }
  return mapAccountToNeo4j(note);
}

/**
 * Map an Account note from a raw string to Neo4j.
 */
export function mapAccountNoteString(
  content: string,
  filePath: string
): AccountMapperResult {
  const note = parseNoteString(content, filePath);
  if (note.templateType !== "account") {
    return {
      accountId: "",
      sourceId: "",
      nodeProperties: {},
      relationshipsCreated: [],
      openQuestionCreated: false,
      success: false,
      error: `Not an account note (type: ${note.templateType ?? "none"})`,
    };
  }
  return mapAccountToNeo4j(note);
}

/**
 * Map a Cash Flow note from a file path to Neo4j.
 */
export async function mapCashFlowNoteFile(
  filePath: string
): Promise<CashFlowMapperResult> {
  const note = await parseNoteFile(filePath);
  if (note.templateType !== "cash-flow") {
    return {
      cashFlowId: "",
      sourceId: "",
      edgeProperties: {},
      relationshipsCreated: [],
      success: false,
      error: `Not a cash-flow note (type: ${note.templateType ?? "none"})`,
    };
  }
  return mapCashFlowToNeo4j(note);
}

/**
 * Map a Cash Flow note from a raw string to Neo4j.
 */
export function mapCashFlowNoteString(
  content: string,
  filePath: string
): CashFlowMapperResult {
  const note = parseNoteString(content, filePath);
  if (note.templateType !== "cash-flow") {
    return {
      cashFlowId: "",
      sourceId: "",
      edgeProperties: {},
      relationshipsCreated: [],
      success: false,
      error: `Not a cash-flow note (type: ${note.templateType ?? "none"})`,
    };
  }
  return mapCashFlowToNeo4j(note);
}
