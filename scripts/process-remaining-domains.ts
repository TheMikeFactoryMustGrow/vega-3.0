/**
 * Process Remaining Vault Domains (US-020)
 *
 * Extends the Phase 1 migration to cover all remaining vault domains:
 *   - Structured notes (People, WE/Deals, WE/Entities) → mappers
 *   - Unstructured notes (GIX, Family Offices, etc.) → claim decomposition
 *
 * Usage: npx tsx scripts/process-remaining-domains.ts
 *   --dry-run          Log what would be processed without writing to Neo4j
 *   --structured-only  Only run the structured mappers (skip claim decomposition)
 *   --unstructured-only Only run the claim decomposition (skip structured mappers)
 *   --dir=X            Process only directories matching X
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { parseNoteString } from "../src/frontmatter-parser.js";
import { mapEntityToNeo4j, runCypher } from "../src/entity-mapper.js";
import {
  mapInvestmentDealToNeo4j,
  mapInvestmentPositionToNeo4j,
  mapPersonToNeo4j,
} from "../src/investment-person-mapper.js";
import { mapGenericToNeo4j } from "../src/generic-mapper.js";
import { decomposeNoteString } from "../src/claim-decomposition.js";

// ── Configuration ──────────────────────────────────────────────────────────

const VAULT_ROOT =
  "/Users/VEGA/Library/Mobile Documents/com~apple~CloudDocs/Linglepedia";

// Structured directories — notes with template types routed to mappers
const STRUCTURED_DIRS = [
  "People",
  "WE/Deals",
  "WE/Entities",
];

// Unstructured directories — notes processed via claim decomposition
const UNSTRUCTURED_DIRS = [
  "GIX",
  "GIX/GIX Customers",
  "GIX/Meeting Notes",
  "GIX/MetroConnect 2026 Notes",
  "GIX/Shareholders",
  "Family Offices",
  "Family Offices/RWN Management",
  "Fiber Infrastructure Businesses",
];

// Domain mapping for unstructured directories
const DIR_DOMAIN_MAP: Record<string, string> = {
  "GIX": "gix",
  "GIX/GIX Customers": "gix",
  "GIX/Meeting Notes": "gix",
  "GIX/MetroConnect 2026 Notes": "gix",
  "GIX/Shareholders": "gix",
  "Family Offices": "family-offices",
  "Family Offices/RWN Management": "family-offices",
  "Fiber Infrastructure Businesses": "telecommunications",
};

// Files/directories to skip
const SKIP_NAMES = new Set([
  "_schemas",
  "Templates",
  "README.md",
  ".DS_Store",
  "Dashboards",
]);

// Types handled by the generic mapper
const GENERIC_MAPPER_TYPES = new Set([
  "institution",
  "vehicle",
  "property",
  "vendor",
]);

// Types to skip entirely
const SKIP_TYPES = new Set(["dashboard"]);

// ── Types ───────────────────────────────────────────────────────────────────

interface StructuredLogEntry {
  filePath: string;
  relativePath: string;
  templateType: string;
  nodeType: string;
  entityId: string;
  relationshipCount: number;
  relationships: string[];
  openQuestionCreated: boolean;
  success: boolean;
  error?: string;
  durationMs: number;
}

interface DecompositionLogEntry {
  filePath: string;
  relativePath: string;
  domain: string;
  totalChunks: number;
  rawClaims: number;
  storedClaims: number;
  entitiesLinked: number;
  success: boolean;
  errors: string[];
  durationMs: number;
}

interface MigrationSummary {
  structured: {
    totalFiles: number;
    processed: number;
    succeeded: number;
    failed: number;
    skipped: number;
    totalRelationships: number;
    byType: Record<string, { count: number; succeeded: number; failed: number }>;
    entries: StructuredLogEntry[];
    errors: Array<{ file: string; error: string }>;
  };
  unstructured: {
    totalFiles: number;
    processed: number;
    succeeded: number;
    failed: number;
    totalClaims: number;
    totalEntities: number;
    entries: DecompositionLogEntry[];
    errors: Array<{ file: string; errors: string[] }>;
  };
  totalDurationMs: number;
}

// ── File Discovery ──────────────────────────────────────────────────────────

function discoverNotes(dir: string, recursive: boolean = false): string[] {
  const notes: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    console.warn(`  [WARN] Cannot read directory: ${dir}`);
    return notes;
  }

  for (const entry of entries) {
    if (SKIP_NAMES.has(entry)) continue;
    if (entry.startsWith("_")) continue;
    if (entry.startsWith(".")) continue;

    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (recursive) {
        notes.push(...discoverNotes(fullPath, true));
      }
      continue;
    }

    if (!entry.endsWith(".md")) continue;
    if (entry.endsWith(" MOC.md")) continue;

    notes.push(fullPath);
  }

  return notes.sort();
}

// ── Structured Note Processing ──────────────────────────────────────────────

function processStructuredNote(
  filePath: string,
  dryRun: boolean
): StructuredLogEntry {
  const relPath = relative(VAULT_ROOT, filePath);
  const start = Date.now();

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    return {
      filePath, relativePath: relPath, templateType: "unknown",
      nodeType: "unknown", entityId: "", relationshipCount: 0,
      relationships: [], openQuestionCreated: false, success: false,
      error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }

  let note;
  try {
    note = parseNoteString(content, filePath);
  } catch (err) {
    return {
      filePath, relativePath: relPath, templateType: "unknown",
      nodeType: "unknown", entityId: "", relationshipCount: 0,
      relationships: [], openQuestionCreated: false, success: false,
      error: `Failed to parse: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }

  const templateType = String(note.frontmatter.type || "none");
  const perspective = note.investmentPerspective;

  if (templateType === "none" || SKIP_TYPES.has(templateType)) {
    return {
      filePath, relativePath: relPath, templateType,
      nodeType: "skipped", entityId: "", relationshipCount: 0,
      relationships: [], openQuestionCreated: false, success: true,
      error: `Skipped: type=${templateType}`,
      durationMs: Date.now() - start,
    };
  }

  if (dryRun) {
    let nodeType = "Entity";
    if (templateType === "investment" && perspective === "deal") nodeType = "Bet";
    return {
      filePath, relativePath: relPath,
      templateType: perspective ? `${templateType}/${perspective}` : templateType,
      nodeType, entityId: "(dry-run)",
      relationshipCount: note.allWikilinks.length,
      relationships: note.allWikilinks.map((w) => `-> ${w}`),
      openQuestionCreated: false, success: true,
      durationMs: Date.now() - start,
    };
  }

  try {
    if (templateType === "entity" || templateType === "organization") {
      const result = mapEntityToNeo4j(note);
      return {
        filePath, relativePath: relPath, templateType,
        nodeType: "Entity", entityId: result.entityId,
        relationshipCount: result.relationshipsCreated.length,
        relationships: result.relationshipsCreated,
        openQuestionCreated: result.openQuestionCreated,
        success: result.success, error: result.error,
        durationMs: Date.now() - start,
      };
    }

    if (templateType === "investment" && perspective === "deal") {
      const result = mapInvestmentDealToNeo4j(note);
      return {
        filePath, relativePath: relPath, templateType: "investment/deal",
        nodeType: "Bet", entityId: result.betId,
        relationshipCount: result.relationshipsCreated.length,
        relationships: result.relationshipsCreated,
        openQuestionCreated: result.openQuestionCreated,
        success: result.success, error: result.error,
        durationMs: Date.now() - start,
      };
    }

    if (templateType === "investment" && perspective === "personal") {
      const result = mapInvestmentPositionToNeo4j(note);
      return {
        filePath, relativePath: relPath, templateType: "investment/personal",
        nodeType: "Entity {investment-position}",
        entityId: result.positionId,
        relationshipCount: result.relationshipsCreated.length,
        relationships: result.relationshipsCreated,
        openQuestionCreated: result.openQuestionCreated,
        success: result.success, error: result.error,
        durationMs: Date.now() - start,
      };
    }

    if (templateType === "person") {
      const result = mapPersonToNeo4j(note);
      return {
        filePath, relativePath: relPath, templateType: "person",
        nodeType: "Entity {person}", entityId: result.personId,
        relationshipCount: result.relationshipsCreated.length,
        relationships: result.relationshipsCreated,
        openQuestionCreated: result.openQuestionCreated,
        success: result.success, error: result.error,
        durationMs: Date.now() - start,
      };
    }

    if (GENERIC_MAPPER_TYPES.has(templateType)) {
      const result = mapGenericToNeo4j(note);
      return {
        filePath, relativePath: relPath, templateType,
        nodeType: `Entity {${templateType}}`, entityId: result.entityId,
        relationshipCount: result.relationshipsCreated.length,
        relationships: result.relationshipsCreated,
        openQuestionCreated: result.openQuestionCreated,
        success: result.success, error: result.error,
        durationMs: Date.now() - start,
      };
    }

    return {
      filePath, relativePath: relPath, templateType,
      nodeType: "unknown", entityId: "", relationshipCount: 0,
      relationships: [], openQuestionCreated: false, success: false,
      error: `Unknown template type: ${templateType}`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      filePath, relativePath: relPath, templateType,
      nodeType: "unknown", entityId: "", relationshipCount: 0,
      relationships: [], openQuestionCreated: false, success: false,
      error: `Mapper error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

// ── Unstructured Note Processing ────────────────────────────────────────────

async function processUnstructuredNote(
  filePath: string,
  domain: string,
  dryRun: boolean
): Promise<DecompositionLogEntry> {
  const relPath = relative(VAULT_ROOT, filePath);
  const start = Date.now();

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    return {
      filePath, relativePath: relPath, domain,
      totalChunks: 0, rawClaims: 0, storedClaims: 0,
      entitiesLinked: 0, success: false,
      errors: [`Failed to read file: ${err instanceof Error ? err.message : String(err)}`],
      durationMs: Date.now() - start,
    };
  }

  // Check if the note has meaningful body text (beyond just a title)
  const parsed = parseNoteString(content, filePath);
  const bodyText = parsed.body.trim();

  if (bodyText.length < 50) {
    return {
      filePath, relativePath: relPath, domain,
      totalChunks: 0, rawClaims: 0, storedClaims: 0,
      entitiesLinked: 0, success: true,
      errors: [],
      durationMs: Date.now() - start,
    };
  }

  if (dryRun) {
    const estimatedChunks = Math.max(1, Math.ceil(bodyText.length / 8000));
    return {
      filePath, relativePath: relPath, domain,
      totalChunks: estimatedChunks, rawClaims: 0, storedClaims: 0,
      entitiesLinked: 0, success: true, errors: [],
      durationMs: Date.now() - start,
    };
  }

  try {
    const result = await decomposeNoteString(content, filePath, domain);
    return {
      filePath, relativePath: relPath, domain,
      totalChunks: result.totalChunks,
      rawClaims: result.rawClaimsExtracted,
      storedClaims: result.claimsStored.length,
      entitiesLinked: result.entitiesLinked.length,
      success: result.success,
      errors: result.errors,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      filePath, relativePath: relPath, domain,
      totalChunks: 0, rawClaims: 0, storedClaims: 0,
      entitiesLinked: 0, success: false,
      errors: [err instanceof Error ? err.message : String(err)],
      durationMs: Date.now() - start,
    };
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const structuredOnly = args.includes("--structured-only");
  const unstructuredOnly = args.includes("--unstructured-only");
  const dirFilter = args.find((a) => a.startsWith("--dir="))?.split("=")[1];

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  VEGA Phase 1 — Process Remaining Vault Domains (US-020)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Vault: ${VAULT_ROOT}`);
  console.log(`  Mode:  ${dryRun ? "DRY RUN (no Neo4j writes)" : "LIVE"}`);
  if (structuredOnly) console.log("  Scope: structured only");
  if (unstructuredOnly) console.log("  Scope: unstructured only");
  if (dirFilter) console.log(`  Filter: ${dirFilter}`);
  console.log("───────────────────────────────────────────────────────────────\n");

  // Verify Neo4j connectivity
  if (!dryRun) {
    try {
      const result = runCypher("RETURN 1 AS test;");
      if (!result.includes("1")) {
        console.error("ERROR: Neo4j connectivity check failed.");
        process.exit(1);
      }
      console.log("  [OK] Neo4j connected\n");
    } catch (err) {
      console.error(
        `ERROR: Cannot connect to Neo4j: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(1);
    }
  }

  const summary: MigrationSummary = {
    structured: {
      totalFiles: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0,
      totalRelationships: 0, byType: {}, entries: [], errors: [],
    },
    unstructured: {
      totalFiles: 0, processed: 0, succeeded: 0, failed: 0,
      totalClaims: 0, totalEntities: 0, entries: [], errors: [],
    },
    totalDurationMs: 0,
  };

  const migrationStart = Date.now();

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 1: Structured notes (People, WE/Deals, WE/Entities)
  // ══════════════════════════════════════════════════════════════════════════

  if (!unstructuredOnly) {
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║  Phase 1: Structured Notes (Mappers)                        ║");
    console.log("╚══════════════════════════════════════════════════════════════╝\n");

    const scanDirs = dirFilter
      ? STRUCTURED_DIRS.filter((d) => d.toLowerCase().includes(dirFilter.toLowerCase()))
      : STRUCTURED_DIRS;

    for (const dir of scanDirs) {
      const fullDir = join(VAULT_ROOT, dir);
      const files = discoverNotes(fullDir);
      summary.structured.totalFiles += files.length;
      console.log(`  [SCAN] ${dir}: ${files.length} notes`);

      if (files.length === 0) continue;
      console.log(`\n  ── Processing: ${dir} ──\n`);

      for (const filePath of files) {
        const fileName = basename(filePath);
        const entry = processStructuredNote(filePath, dryRun);
        summary.structured.entries.push(entry);
        summary.structured.processed++;

        const typeKey = entry.templateType;
        if (!summary.structured.byType[typeKey]) {
          summary.structured.byType[typeKey] = { count: 0, succeeded: 0, failed: 0 };
        }
        summary.structured.byType[typeKey].count++;

        if (entry.nodeType === "skipped") {
          summary.structured.skipped++;
          console.log(`    [SKIP] ${fileName} — ${entry.error}`);
          continue;
        }

        if (entry.success) {
          summary.structured.succeeded++;
          summary.structured.byType[typeKey].succeeded++;
          summary.structured.totalRelationships += entry.relationshipCount;
          console.log(
            `    [OK]   ${fileName} → ${entry.nodeType} (${entry.entityId}) — ` +
              `${entry.relationshipCount} rels, ${entry.durationMs}ms`
          );
        } else {
          summary.structured.failed++;
          summary.structured.byType[typeKey].failed++;
          summary.structured.errors.push({
            file: entry.relativePath,
            error: entry.error || "Unknown error",
          });
          console.log(`    [FAIL] ${fileName} — ${entry.error}`);
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 2: Unstructured notes (Claim Decomposition)
  // ══════════════════════════════════════════════════════════════════════════

  if (!structuredOnly) {
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║  Phase 2: Unstructured Notes (Claim Decomposition)          ║");
    console.log("╚══════════════════════════════════════════════════════════════╝\n");

    // Collect all unstructured files, avoiding duplicates from parent/child dirs
    const seenFiles = new Set<string>();
    const unstructuredFiles: Array<{ file: string; domain: string; dir: string }> = [];

    const scanDirs = dirFilter
      ? UNSTRUCTURED_DIRS.filter((d) => d.toLowerCase().includes(dirFilter.toLowerCase()))
      : UNSTRUCTURED_DIRS;

    for (const dir of scanDirs) {
      const fullDir = join(VAULT_ROOT, dir);
      // Only discover direct files (not recursive) to avoid double-counting
      const files = discoverNotes(fullDir, false);
      const domain = DIR_DOMAIN_MAP[dir] || "unknown";

      for (const f of files) {
        if (!seenFiles.has(f)) {
          seenFiles.add(f);
          unstructuredFiles.push({ file: f, domain, dir });
        }
      }
    }

    summary.unstructured.totalFiles = unstructuredFiles.length;
    console.log(`  Total unstructured notes to process: ${unstructuredFiles.length}\n`);

    if (dryRun) {
      for (const { file, domain, dir } of unstructuredFiles) {
        const fileName = basename(file);
        const entry = await processUnstructuredNote(file, domain, true);
        summary.unstructured.entries.push(entry);
        summary.unstructured.processed++;
        summary.unstructured.succeeded++;
        console.log(
          `    [DRY]  ${dir}/${fileName} — domain: ${domain}, ~${entry.totalChunks} chunks`
        );
      }
    } else {
      for (const { file, domain, dir } of unstructuredFiles) {
        const fileName = basename(file);
        console.log(`    [PROC] ${dir}/${fileName} (domain: ${domain})...`);

        const entry = await processUnstructuredNote(file, domain, false);
        summary.unstructured.entries.push(entry);
        summary.unstructured.processed++;

        if (entry.success) {
          summary.unstructured.succeeded++;
          summary.unstructured.totalClaims += entry.storedClaims;
          summary.unstructured.totalEntities += entry.entitiesLinked;
          console.log(
            `    [OK]   ${fileName} — ${entry.storedClaims} claims, ` +
              `${entry.entitiesLinked} entities, ${entry.totalChunks} chunks, ` +
              `${(entry.durationMs / 1000).toFixed(1)}s`
          );
        } else {
          summary.unstructured.failed++;
          summary.unstructured.errors.push({
            file: entry.relativePath,
            errors: entry.errors,
          });
          console.log(
            `    [FAIL] ${fileName} — ${entry.errors.join("; ")}`
          );
        }

        if (entry.errors.length > 0 && entry.success) {
          console.log(
            `    [WARN] ${fileName} — partial errors: ${entry.errors.join("; ")}`
          );
        }
      }
    }
  }

  summary.totalDurationMs = Date.now() - migrationStart;

  // ── Print summary ───────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Migration Summary");
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (!unstructuredOnly) {
    console.log("  ── Structured Notes ──\n");
    console.log(`    Total files:        ${summary.structured.totalFiles}`);
    console.log(`    Processed:          ${summary.structured.processed}`);
    console.log(`    Succeeded:          ${summary.structured.succeeded}`);
    console.log(`    Failed:             ${summary.structured.failed}`);
    console.log(`    Skipped:            ${summary.structured.skipped}`);
    console.log(`    Total relationships:${summary.structured.totalRelationships}`);

    if (Object.keys(summary.structured.byType).length > 0) {
      console.log("\n    By Type:");
      for (const [type, stats] of Object.entries(summary.structured.byType).sort()) {
        console.log(
          `      ${type.padEnd(25)} ${stats.count} total, ${stats.succeeded} OK, ${stats.failed} failed`
        );
      }
    }
  }

  if (!structuredOnly) {
    console.log("\n  ── Unstructured Notes (Claim Decomposition) ──\n");
    console.log(`    Total files:        ${summary.unstructured.totalFiles}`);
    console.log(`    Processed:          ${summary.unstructured.processed}`);
    console.log(`    Succeeded:          ${summary.unstructured.succeeded}`);
    console.log(`    Failed:             ${summary.unstructured.failed}`);
    console.log(`    Total claims:       ${summary.unstructured.totalClaims}`);
    console.log(`    Total entities:     ${summary.unstructured.totalEntities}`);
  }

  console.log(`\n    Total duration:     ${(summary.totalDurationMs / 1000).toFixed(1)}s`);

  // ── Print errors ──────────────────────────────────────────────────────────

  const allErrors = [
    ...summary.structured.errors.map((e) => `${e.file}: ${e.error}`),
    ...summary.unstructured.errors.map((e) => `${e.file}: ${e.errors.join("; ")}`),
  ];

  if (allErrors.length > 0) {
    console.log("\n  ── Errors ──\n");
    for (const err of allErrors) {
      console.log(`    ${err}`);
    }
  }

  // ── Verify node counts in Neo4j ─────────────────────────────────────────

  if (!dryRun) {
    console.log("\n  ── Neo4j Verification ──\n");
    try {
      const entityCount = runCypher("MATCH (e:Entity) RETURN count(e) AS c;");
      const betCount = runCypher("MATCH (b:Bet) RETURN count(b) AS c;");
      const claimCount = runCypher("MATCH (c:Claim) RETURN count(c) AS c;");
      const sourceCount = runCypher("MATCH (s:Source) RETURN count(s) AS c;");
      const oqCount = runCypher("MATCH (oq:OpenQuestion) RETURN count(oq) AS c;");
      const relCount = runCypher("MATCH ()-[r]->() RETURN count(r) AS c;");

      console.log(`    Entity nodes:       ${entityCount.trim()}`);
      console.log(`    Bet nodes:          ${betCount.trim()}`);
      console.log(`    Claim nodes:        ${claimCount.trim()}`);
      console.log(`    Source nodes:        ${sourceCount.trim()}`);
      console.log(`    OpenQuestion nodes:  ${oqCount.trim()}`);
      console.log(`    Total relationships: ${relCount.trim()}`);
    } catch {
      console.log("    [WARN] Could not verify Neo4j counts");
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════════\n");

  const totalFailed = summary.structured.failed + summary.unstructured.failed;
  const totalSucceeded = summary.structured.succeeded + summary.unstructured.succeeded;

  if (totalFailed > 0) {
    console.log(
      `  RESULT: PARTIAL — ${totalFailed} failures out of ${totalSucceeded + totalFailed} processed\n`
    );
    process.exit(1);
  } else {
    console.log(
      `  RESULT: SUCCESS — ${totalSucceeded} notes processed ` +
        `(${summary.structured.succeeded} structured, ${summary.unstructured.succeeded} decomposed)\n`
    );
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
