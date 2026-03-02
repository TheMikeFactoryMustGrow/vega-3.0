/**
 * Entity Frontmatter-to-Neo4j Mapper (US-013)
 *
 * Maps Entity notes from the Obsidian vault to Neo4j Entity nodes with correct
 * properties and relationships. Handles ownership chains, truth score mapping,
 * wikilink relationships, and Source node linking.
 *
 * Usage:
 *   import { mapEntityToNeo4j, mapEntityNoteFile } from "../src/entity-mapper.js";
 *
 *   // From a parsed note
 *   const result = mapEntityToNeo4j(parsedNote);
 *
 *   // From a file path
 *   const result = await mapEntityNoteFile("/path/to/entity.md");
 */

import { execSync } from "node:child_process";
import { basename } from "node:path";
import { parseNoteFile, parseNoteString } from "./frontmatter-parser.js";
import type { ParsedNote, TruthScore } from "./frontmatter-parser.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface MapperResult {
  entityId: string;
  sourceId: string;
  nodeProperties: Record<string, unknown>;
  relationshipsCreated: string[];
  openQuestionCreated: boolean;
  success: boolean;
  error?: string;
}

// ── Neo4j Connection ─────────────────────────────────────────────────────────

const NEO4J_CONTAINER = "linglepedia";
const NEO4J_USER = "neo4j";
const NEO4J_PASSWORD = "lingelpedia2026";

export function runCypher(query: string, timeoutMs = 15_000): string {
  const result = execSync(
    `docker exec -i ${NEO4J_CONTAINER} cypher-shell -u ${NEO4J_USER} -p ${NEO4J_PASSWORD}`,
    {
      input: query,
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  return result.trim();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function escCypher(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Map a truth_score string to a numeric value per the spec:
 *   verified -> 0.95, agent-populated -> 0.7, stale -> 0.5 (flagged),
 *   conflicted -> 0.5 (creates OpenQuestion), unscored -> 0.5
 */
export function mapTruthScore(score: TruthScore | undefined | null): number {
  switch (score) {
    case "verified":
      return 0.95;
    case "agent-populated":
      return 0.7;
    case "stale":
      return 0.5;
    case "conflicted":
      return 0.5;
    case "unscored":
    default:
      return 0.5;
  }
}

/**
 * Generate a deterministic entity ID from a file path or legal name.
 * Uses the filename (without extension) as the base, sanitized to a slug.
 */
export function generateEntityId(
  filePath: string | null,
  legalName: string | null
): string {
  const base = filePath ? basename(filePath, ".md") : legalName;
  if (!base) return `entity-${Date.now()}`;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Generate a Source node ID from a file path.
 */
export function generateSourceId(filePath: string): string {
  return `source-${filePath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

/**
 * Extract the wikilink target from a string that may contain a wikilink.
 * E.g., "[[Mike Lingle]] (grantor)" -> "Mike Lingle"
 * E.g., "[[Mike Lingle]]" -> "Mike Lingle"
 * E.g., "Mike Lingle" -> "Mike Lingle"
 */
export function extractWikilinkTarget(s: string): string {
  const match = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/.exec(s);
  return match ? match[1].trim() : s.trim();
}

/**
 * Derive the domain from tags array.
 */
function deriveDomain(tags: unknown): string {
  if (!Array.isArray(tags)) return "unknown";
  const tagStrings = tags.filter((t): t is string => typeof t === "string");
  if (tagStrings.some((t) => t.startsWith("entity/") || t === "entity")) {
    // Check for domain hints in tags
    if (tagStrings.includes("personal")) return "personal";
    if (tagStrings.includes("family")) return "family";
    if (tagStrings.includes("we")) return "we";
    if (tagStrings.includes("real-estate")) return "real-estate";
    if (tagStrings.includes("estate-planning")) return "estate-planning";
  }
  return "finance";
}

/**
 * Convert a value to a string suitable for Cypher. Handles Date objects.
 */
function toCypherString(val: unknown): string | null {
  if (val === null || val === undefined || val === "") return null;
  if (val instanceof Date) return val.toISOString().split("T")[0];
  return String(val);
}

// ── Core Mapper ──────────────────────────────────────────────────────────────

/**
 * Map a parsed Entity note to Neo4j, creating the Entity node, Source node,
 * ownership relationships, and wikilink edges.
 *
 * Idempotent: uses MERGE on id fields to avoid duplicates.
 */
export function mapEntityToNeo4j(note: ParsedNote): MapperResult {
  const fm = note.frontmatter;
  const filePath = note.filePath ?? "unknown";

  const legalName = toCypherString(fm["legal-name"]) ?? toCypherString(fm["name"]) ?? basename(filePath, ".md");
  const entityId = generateEntityId(note.filePath, legalName);
  const sourceId = generateSourceId(filePath);

  const result: MapperResult = {
    entityId,
    sourceId,
    nodeProperties: {},
    relationshipsCreated: [],
    openQuestionCreated: false,
    success: false,
  };

  try {
    // ── 1. Create/update Entity node ──────────────────────────────────────
    const entityType = toCypherString(fm["subtype"]) ?? "unknown";
    const truthScoreNum = mapTruthScore(fm.truth_score);
    const domain = deriveDomain(fm["tags"]);
    const aliases = Array.isArray(fm["aliases"])
      ? fm["aliases"].filter((a): a is string => typeof a === "string")
      : [];
    const taxTreatment = toCypherString(fm["tax-treatment"]);
    const ein = toCypherString(fm["ein"]);
    const status = toCypherString(fm["status"]) ?? "unknown";
    const state = toCypherString(fm["state"]);
    const purpose = toCypherString(fm["purpose"]);
    const isCanonical = fm.is_canonical === true;

    const setProps: string[] = [
      `e.name = "${escCypher(legalName)}"`,
      `e.entity_type = "${escCypher(entityType)}"`,
      `e.legal_name = "${escCypher(legalName)}"`,
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

    if (taxTreatment) {
      setProps.push(`e.tax_treatment = "${escCypher(taxTreatment)}"`);
    }
    if (ein) {
      setProps.push(`e.ein = "${escCypher(ein)}"`);
    }
    if (state) {
      setProps.push(`e.state = "${escCypher(state)}"`);
    }
    if (purpose) {
      setProps.push(`e.purpose = "${escCypher(purpose)}"`);
    }

    // Trust-specific properties
    const trustDate = toCypherString(fm["trust-date"]);
    if (trustDate) {
      setProps.push(`e.trust_date = "${escCypher(trustDate)}"`);
    }
    const trustState = toCypherString(fm["trust-state"]);
    if (trustState) {
      setProps.push(`e.trust_state = "${escCypher(trustState)}"`);
    }
    const irrevocableType = toCypherString(fm["irrevocable-type"]);
    if (irrevocableType) {
      setProps.push(`e.irrevocable_type = "${escCypher(irrevocableType)}"`);
    }
    const distributionRules = toCypherString(fm["distribution-rules"]);
    if (distributionRules) {
      setProps.push(`e.distribution_rules = "${escCypher(distributionRules)}"`);
    }

    const entityCypher = `MERGE (e:Entity {id: "${escCypher(entityId)}"})
SET ${setProps.join(", ")}
RETURN e.id;`;

    runCypher(entityCypher);
    result.nodeProperties = {
      id: entityId,
      name: legalName,
      entity_type: entityType,
      legal_name: legalName,
      domain,
      truth_score: truthScoreNum,
      truth_basis: fm.truth_score ?? "unscored",
      is_canonical: isCanonical,
      status,
      aliases,
      tax_treatment: taxTreatment,
      ein,
      state,
    };

    // ── 2. Create Source node and SOURCED_FROM relationship ────────────────
    const sourceName = basename(filePath);
    const sourceCypher = `MERGE (s:Source {id: "${escCypher(sourceId)}"})
SET s.source_type = "obsidian_vault", s.file_path = "${escCypher(filePath)}", s.name = "${escCypher(sourceName)}", s.updated_at = datetime()
WITH s
MATCH (e:Entity {id: "${escCypher(entityId)}"})
MERGE (e)-[:SOURCED_FROM]->(s)
RETURN s.id;`;

    runCypher(sourceCypher);
    result.relationshipsCreated.push(`SOURCED_FROM -> ${sourceId}`);

    // ── 3. Create ownership BELONGS_TO relationships ──────────────────────
    const ownedBy = fm["owned-by"];
    if (Array.isArray(ownedBy)) {
      for (const ownerRef of ownedBy) {
        if (typeof ownerRef !== "string") continue;
        const ownerName = extractWikilinkTarget(ownerRef);
        if (!ownerName) continue;
        const ownerId = generateEntityId(null, ownerName);

        const ownerCypher = `MERGE (owner:Entity {id: "${escCypher(ownerId)}"})
ON CREATE SET owner.name = "${escCypher(ownerName)}", owner.entity_type = "unknown", owner.truth_score = 0.5, owner.created_at = datetime()
SET owner.updated_at = datetime()
WITH owner
MATCH (child:Entity {id: "${escCypher(entityId)}"})
MERGE (child)-[:BELONGS_TO]->(owner)
RETURN owner.id;`;

        runCypher(ownerCypher);
        result.relationshipsCreated.push(`BELONGS_TO -> ${ownerName}`);
      }
    }

    // Also handle parent-entity field
    const parentEntity = fm["parent-entity"];
    if (typeof parentEntity === "string" && parentEntity.trim()) {
      const parentName = extractWikilinkTarget(parentEntity);
      if (parentName) {
        const parentId = generateEntityId(null, parentName);
        const parentCypher = `MERGE (parent:Entity {id: "${escCypher(parentId)}"})
ON CREATE SET parent.name = "${escCypher(parentName)}", parent.entity_type = "unknown", parent.truth_score = 0.5, parent.created_at = datetime()
SET parent.updated_at = datetime()
WITH parent
MATCH (child:Entity {id: "${escCypher(entityId)}"})
MERGE (child)-[:BELONGS_TO]->(parent)
RETURN parent.id;`;

        runCypher(parentCypher);
        result.relationshipsCreated.push(`BELONGS_TO -> ${parentName}`);
      }
    }

    // ── 4. Create RELATED_TO edges for wikilinks ──────────────────────────
    // Use allWikilinks but exclude entities already linked via BELONGS_TO
    const belongsToTargets = new Set<string>();
    if (Array.isArray(ownedBy)) {
      for (const ref of ownedBy) {
        if (typeof ref === "string") {
          belongsToTargets.add(extractWikilinkTarget(ref));
        }
      }
    }
    if (typeof parentEntity === "string" && parentEntity.trim()) {
      belongsToTargets.add(extractWikilinkTarget(parentEntity));
    }

    for (const link of note.allWikilinks) {
      if (belongsToTargets.has(link)) continue;
      const linkedId = generateEntityId(null, link);

      const relCypher = `MERGE (linked:Entity {id: "${escCypher(linkedId)}"})
ON CREATE SET linked.name = "${escCypher(link)}", linked.entity_type = "unknown", linked.truth_score = 0.5, linked.created_at = datetime()
SET linked.updated_at = datetime()
WITH linked
MATCH (e:Entity {id: "${escCypher(entityId)}"})
MERGE (e)-[:RELATED_TO]->(linked)
RETURN linked.id;`;

      runCypher(relCypher);
      result.relationshipsCreated.push(`RELATED_TO -> ${link}`);
    }

    // ── 5. Handle conflicted truth score -> OpenQuestion ──────────────────
    if (fm.truth_score === "conflicted") {
      const oqId = `oq-${entityId}-conflicted`;
      const oqCypher = `MERGE (oq:OpenQuestion {id: "${escCypher(oqId)}"})
SET oq.question = "Conflicted truth score on entity: ${escCypher(legalName)}",
    oq.status = "open",
    oq.domain = "${escCypher(domain)}",
    oq.source_entity = "${escCypher(entityId)}",
    oq.created_at = datetime(),
    oq.updated_at = datetime()
WITH oq
MATCH (e:Entity {id: "${escCypher(entityId)}"})
MERGE (e)-[:MENTIONS]->(oq)
RETURN oq.id;`;

      runCypher(oqCypher);
      result.openQuestionCreated = true;
      result.relationshipsCreated.push(`MENTIONS -> OpenQuestion(${oqId})`);
    }

    // ── 6. Handle stale truth score -> flag for re-verification ───────────
    if (fm.truth_score === "stale") {
      const flagCypher = `MATCH (e:Entity {id: "${escCypher(entityId)}"})
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

/**
 * Map an Entity note from a file path to Neo4j.
 */
export async function mapEntityNoteFile(
  filePath: string
): Promise<MapperResult> {
  const note = await parseNoteFile(filePath);
  if (note.templateType !== "entity") {
    return {
      entityId: "",
      sourceId: "",
      nodeProperties: {},
      relationshipsCreated: [],
      openQuestionCreated: false,
      success: false,
      error: `Not an entity note (type: ${note.templateType ?? "none"})`,
    };
  }
  return mapEntityToNeo4j(note);
}

/**
 * Map an Entity note from a raw string to Neo4j.
 */
export function mapEntityNoteString(
  content: string,
  filePath: string
): MapperResult {
  const note = parseNoteString(content, filePath);
  if (note.templateType !== "entity") {
    return {
      entityId: "",
      sourceId: "",
      nodeProperties: {},
      relationshipsCreated: [],
      openQuestionCreated: false,
      success: false,
      error: `Not an entity note (type: ${note.templateType ?? "none"})`,
    };
  }
  return mapEntityToNeo4j(note);
}
