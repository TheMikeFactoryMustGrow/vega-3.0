/**
 * Generic Frontmatter-to-Neo4j Mapper (US-016)
 *
 * Handles template types not covered by dedicated mappers: institution, vehicle,
 * property, vendor. Maps them all to :Entity nodes with the appropriate entity_type
 * and type-specific properties and relationships.
 *
 * Usage:
 *   import { mapGenericNoteFile, mapGenericToNeo4j } from "../src/generic-mapper.js";
 *   const result = await mapGenericNoteFile("/path/to/note.md");
 */

import { basename } from "node:path";
import { parseNoteFile, parseNoteString } from "./frontmatter-parser.js";
import type { ParsedNote, TruthScore } from "./frontmatter-parser.js";
import {
  runCypher,
  escCypher,
  mapTruthScore,
  generateEntityId,
  generateSourceId,
  extractWikilinkTarget,
} from "./entity-mapper.js";
import type { MapperResult } from "./entity-mapper.js";

// ── Relationship field definitions per template type ────────────────────────

interface RelFieldDef {
  field: string;
  relType: string;
  direction: "BELONGS_TO" | "RELATED_TO";
  targetEntityType?: string;
  isArray?: boolean;
}

const INSTITUTION_REL_FIELDS: RelFieldDef[] = [
  { field: "entities-served", relType: "serves", direction: "RELATED_TO", isArray: true, targetEntityType: "person" },
  { field: "accounts-held", relType: "holds_account", direction: "RELATED_TO", isArray: true, targetEntityType: "account" },
];

const VEHICLE_REL_FIELDS: RelFieldDef[] = [
  { field: "owner", relType: "owner", direction: "BELONGS_TO", targetEntityType: "person" },
  { field: "co-owner", relType: "co_owner", direction: "RELATED_TO", targetEntityType: "person" },
  { field: "loan-account", relType: "loan_account", direction: "RELATED_TO", targetEntityType: "account" },
  { field: "insurance-policy", relType: "insurance", direction: "RELATED_TO", targetEntityType: "institution" },
];

const PROPERTY_REL_FIELDS: RelFieldDef[] = [
  { field: "owned-by", relType: "owner", direction: "BELONGS_TO", targetEntityType: "person" },
  { field: "joint-owners", relType: "joint_owner", direction: "RELATED_TO", isArray: true, targetEntityType: "person" },
  { field: "mortgage", relType: "mortgage", direction: "RELATED_TO", targetEntityType: "account" },
  { field: "insurance-provider", relType: "insurance", direction: "RELATED_TO", targetEntityType: "institution" },
  { field: "property-manager", relType: "property_manager", direction: "RELATED_TO", targetEntityType: "vendor" },
];

const VENDOR_REL_FIELDS: RelFieldDef[] = [
  { field: "properties-managed", relType: "manages", direction: "RELATED_TO", isArray: true, targetEntityType: "property" },
];

const REL_FIELDS_BY_TYPE: Record<string, RelFieldDef[]> = {
  institution: INSTITUTION_REL_FIELDS,
  vehicle: VEHICLE_REL_FIELDS,
  property: PROPERTY_REL_FIELDS,
  vendor: VENDOR_REL_FIELDS,
};

// ── Property fields to map (scalars only — wikilink fields handled separately) ──

const INSTITUTION_PROPS = [
  "institution-type", "name", "legal-name", "website", "status",
  "primary-contact", "source-system", "portal-url", "relationship-since",
];

const VEHICLE_PROPS = [
  "make", "model", "year", "trim", "vin", "color", "interior", "status",
  "drivetrain", "horsepower", "range", "battery", "seating",
  "purchase-price", "purchase-date", "order-date", "order-number",
  "amount-financed", "apr", "loan-term", "monthly-payment",
];

const PROPERTY_PROPS = [
  "property-type", "address", "city", "state", "zip", "status",
  "acquired-date", "sold-date", "purchase-price", "current-value",
  "value-source", "as-of-date", "mortgage-balance", "equity-estimate",
  "hoa", "hoa-monthly", "hoa-quarterly", "hoa-annual", "hoa-name",
  "acreage", "sqft", "bedrooms", "bathrooms", "year-built", "neighborhood",
  "rental-type",
];

const VENDOR_PROPS = [
  "vendor-type", "name", "website", "status", "primary-contact",
  "contact-email", "office-address", "fee-structure",
];

const PROPS_BY_TYPE: Record<string, string[]> = {
  institution: INSTITUTION_PROPS,
  vehicle: VEHICLE_PROPS,
  property: PROPERTY_PROPS,
  vendor: VENDOR_PROPS,
};

// ── Supported types ─────────────────────────────────────────────────────────

const SUPPORTED_TYPES = new Set(["institution", "vehicle", "property", "vendor"]);

// ── Helpers ─────────────────────────────────────────────────────────────────

function deriveDomain(tags: unknown, templateType: string): string {
  if (templateType === "vehicle") return "auto";
  if (templateType === "property") return "real-estate";
  if (templateType === "vendor") return "services";
  if (!Array.isArray(tags)) return "finance";
  const tagStrings = tags.filter((t): t is string => typeof t === "string");
  if (tagStrings.includes("personal")) return "personal";
  if (tagStrings.includes("real-estate")) return "real-estate";
  return "finance";
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().split("T")[0];
  if (typeof v === "boolean") return v.toString();
  if (typeof v === "number") return v.toString();
  return String(v);
}

function getNoteName(filePath: string, fm: Record<string, unknown>): string {
  const name = fm["name"] || fm["asset-name"] || fm["address"];
  if (name && typeof name === "string") return name;
  return basename(filePath, ".md");
}

// ── Core mapper ─────────────────────────────────────────────────────────────

export function mapGenericToNeo4j(note: ParsedNote): MapperResult {
  const fm = note.frontmatter;
  const templateType = String(fm.type || "unknown");

  if (!SUPPORTED_TYPES.has(templateType)) {
    return {
      entityId: "",
      sourceId: "",
      nodeProperties: {},
      relationshipsCreated: [],
      openQuestionCreated: false,
      success: false,
      error: `Unsupported template type: ${templateType}`,
    };
  }

  const filePath = note.filePath || "unknown.md";
  const entityId = generateEntityId(filePath, null);
  const sourceId = generateSourceId(filePath);
  const name = getNoteName(filePath, fm);
  const domain = deriveDomain(fm.tags, templateType);
  const truthScore = mapTruthScore(fm.truth_score as TruthScore | undefined);
  const isCanonical = fm.is_canonical === true;
  const needsReverification = fm.truth_score === "stale";

  const relationshipsCreated: string[] = [];
  let openQuestionCreated = false;

  // ── 1. MERGE the Entity node ──────────────────────────────────────────

  const propFields = PROPS_BY_TYPE[templateType] || [];
  const propSetClauses: string[] = [];
  const nodeProperties: Record<string, unknown> = {
    id: entityId,
    name,
    entity_type: templateType,
    domain,
    truth_score: truthScore,
    is_canonical: isCanonical,
  };

  for (const field of propFields) {
    const val = fm[field];
    if (val === null || val === undefined || val === "") continue;
    const propName = field.replace(/-/g, "_");
    const formatted = formatValue(val);
    if (formatted) {
      if (typeof val === "number") {
        propSetClauses.push(`e.${propName} = ${val}`);
      } else if (typeof val === "boolean") {
        propSetClauses.push(`e.${propName} = ${val}`);
      } else {
        propSetClauses.push(`e.${propName} = "${escCypher(formatted)}"`);
      }
      nodeProperties[propName] = val;
    }
  }

  if (needsReverification) {
    propSetClauses.push(`e.needs_reverification = true`);
    nodeProperties["needs_reverification"] = true;
  }

  // Handle array fields like services, listing-platforms as comma-separated strings
  const arrayFields = ["services", "listing-platforms", "contacts"];
  for (const field of arrayFields) {
    const val = fm[field];
    if (Array.isArray(val) && val.length > 0) {
      const items = val.filter((v): v is string => typeof v === "string" && v.length > 0);
      if (items.length > 0) {
        const propName = field.replace(/-/g, "_");
        propSetClauses.push(`e.${propName} = "${escCypher(items.join(", "))}"`);
        nodeProperties[propName] = items.join(", ");
      }
    }
  }

  const mergeQuery = `
MERGE (e:Entity {id: "${escCypher(entityId)}"})
ON CREATE SET
  e.name = "${escCypher(name)}",
  e.entity_type = "${escCypher(templateType)}",
  e.domain = "${escCypher(domain)}",
  e.truth_score = ${truthScore},
  e.is_canonical = ${isCanonical},
  e.created_at = datetime()
ON MATCH SET
  e.name = "${escCypher(name)}",
  e.entity_type = "${escCypher(templateType)}",
  e.domain = "${escCypher(domain)}",
  e.truth_score = ${truthScore},
  e.is_canonical = ${isCanonical},
  e.updated_at = datetime()
${propSetClauses.length > 0 ? "SET " + propSetClauses.join(",\n    ") : ""}
RETURN e.id;`;

  runCypher(mergeQuery);

  // ── 2. Create Source node ─────────────────────────────────────────────

  const sourceQuery = `
MERGE (s:Source {id: "${escCypher(sourceId)}"})
ON CREATE SET
  s.source_type = "obsidian_vault",
  s.file_path = "${escCypher(filePath)}",
  s.name = "${escCypher(basename(filePath))}",
  s.created_at = datetime()
ON MATCH SET
  s.file_path = "${escCypher(filePath)}",
  s.updated_at = datetime()
WITH s
MATCH (e:Entity {id: "${escCypher(entityId)}"})
MERGE (e)-[:SOURCED_FROM]->(s)
RETURN s.id;`;

  runCypher(sourceQuery);
  relationshipsCreated.push("SOURCED_FROM -> Source");

  // ── 3. Process relationship fields ────────────────────────────────────

  const relFields = REL_FIELDS_BY_TYPE[templateType] || [];
  const belongsToTargets = new Set<string>();

  for (const relDef of relFields) {
    const rawVal = fm[relDef.field];
    if (!rawVal) continue;

    const values: string[] = [];
    if (relDef.isArray && Array.isArray(rawVal)) {
      for (const item of rawVal) {
        if (typeof item === "string" && item.trim()) {
          values.push(item);
        }
      }
    } else if (typeof rawVal === "string" && rawVal.trim()) {
      values.push(rawVal);
    }

    for (const val of values) {
      const target = extractWikilinkTarget(val);
      if (!target) continue;

      const targetId = generateEntityId(null, target);
      const targetType = relDef.targetEntityType || "unknown";

      if (relDef.direction === "BELONGS_TO") {
        belongsToTargets.add(targetId);
        const btQuery = `
MERGE (t:Entity {id: "${escCypher(targetId)}"})
ON CREATE SET t.name = "${escCypher(target)}", t.entity_type = "${escCypher(targetType)}", t.truth_score = 0.5
WITH t
MATCH (e:Entity {id: "${escCypher(entityId)}"})
MERGE (e)-[:BELONGS_TO]->(t)
RETURN t.id;`;
        runCypher(btQuery);
        relationshipsCreated.push(`BELONGS_TO -> ${target}`);
      } else {
        const rtQuery = `
MERGE (t:Entity {id: "${escCypher(targetId)}"})
ON CREATE SET t.name = "${escCypher(target)}", t.entity_type = "${escCypher(targetType)}", t.truth_score = 0.5
WITH t
MATCH (e:Entity {id: "${escCypher(entityId)}"})
MERGE (e)-[r:RELATED_TO]->(t)
ON CREATE SET r.type = "${escCypher(relDef.relType)}"
ON MATCH SET r.type = "${escCypher(relDef.relType)}"
RETURN t.id;`;
        runCypher(rtQuery);
        relationshipsCreated.push(`RELATED_TO {${relDef.relType}} -> ${target}`);
      }
    }
  }

  // ── 4. Process body wikilinks ─────────────────────────────────────────

  for (const wikilink of note.allWikilinks) {
    const targetId = generateEntityId(null, wikilink);
    if (targetId === entityId) continue;
    if (belongsToTargets.has(targetId)) continue;

    // Check if this wikilink was already handled by a relationship field
    const alreadyLinked = relationshipsCreated.some(
      (r) => r.includes(`-> ${wikilink}`)
    );
    if (alreadyLinked) continue;

    const wlQuery = `
MERGE (t:Entity {id: "${escCypher(targetId)}"})
ON CREATE SET t.name = "${escCypher(wikilink)}", t.entity_type = "unknown", t.truth_score = 0.5
WITH t
MATCH (e:Entity {id: "${escCypher(entityId)}"})
MERGE (e)-[r:RELATED_TO]->(t)
ON CREATE SET r.type = "wikilink"
RETURN t.id;`;
    runCypher(wlQuery);
    relationshipsCreated.push(`RELATED_TO {wikilink} -> ${wikilink}`);
  }

  // ── 5. Create OpenQuestion if conflicted ──────────────────────────────

  if (fm.truth_score === "conflicted") {
    const oqId = `oq-${entityId}`;
    const oqQuery = `
MERGE (oq:OpenQuestion {id: "${escCypher(oqId)}"})
ON CREATE SET
  oq.question = "Conflicted truth score for ${escCypher(name)}",
  oq.status = "open",
  oq.domain = "${escCypher(domain)}",
  oq.created_at = datetime()
WITH oq
MATCH (e:Entity {id: "${escCypher(entityId)}"})
MERGE (e)-[:RELATED_TO {type: "has_open_question"}]->(oq)
RETURN oq.id;`;
    runCypher(oqQuery);
    openQuestionCreated = true;
    relationshipsCreated.push("RELATED_TO {has_open_question} -> OpenQuestion");
  }

  return {
    entityId,
    sourceId,
    nodeProperties,
    relationshipsCreated,
    openQuestionCreated,
    success: true,
  };
}

// ── Convenience functions ───────────────────────────────────────────────────

export async function mapGenericNoteFile(filePath: string): Promise<MapperResult> {
  const note = await parseNoteFile(filePath);
  return mapGenericToNeo4j(note);
}

export function mapGenericNoteString(content: string, filePath: string): MapperResult {
  const note = parseNoteString(content, filePath);
  return mapGenericToNeo4j(note);
}
