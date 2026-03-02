/**
 * Full Structured Migration Script (US-016)
 *
 * Discovers all schema-driven notes in Finance/, Auto/, Properties/ directories
 * and processes them through the appropriate mapper to populate Neo4j.
 *
 * Usage: npx tsx scripts/run-migration.ts
 *   --dry-run   Log what would be processed without writing to Neo4j
 *   --dir=X     Process only a specific subdirectory (e.g., --dir=Finance/Entities)
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { parseNoteString } from "../src/frontmatter-parser.js";
import { mapEntityToNeo4j, runCypher } from "../src/entity-mapper.js";
import { mapAccountToNeo4j, mapCashFlowToNeo4j } from "../src/account-cashflow-mapper.js";
import {
  mapInvestmentDealToNeo4j,
  mapInvestmentPositionToNeo4j,
  mapPersonToNeo4j,
} from "../src/investment-person-mapper.js";
import { mapGenericToNeo4j } from "../src/generic-mapper.js";

// ── Configuration ──────────────────────────────────────────────────────────

const VAULT_ROOT =
  "/Users/VEGA/Library/Mobile Documents/com~apple~CloudDocs/Linglepedia";

const SCAN_DIRS = [
  "Finance/Entities",
  "Finance/Accounts",
  "Finance/Institutions",
  "Finance/Positions",
  "Finance/Cash Flows",
  "Auto",
  "Properties/Current",
  "Properties/Previous",
  "Properties/Prospective",
  "Properties/Vendors",
];

// Files/directories to skip
const SKIP_NAMES = new Set([
  "_schemas",
  "Templates",
  "README.md",
  ".DS_Store",
]);

const SKIP_PREFIXES = ["_"];

// Types handled by the generic mapper
const GENERIC_MAPPER_TYPES = new Set([
  "institution",
  "vehicle",
  "property",
  "vendor",
]);

// Types to skip entirely (MOC pages, dashboards, etc.)
const SKIP_TYPES = new Set(["dashboard"]);

// ── Types ───────────────────────────────────────────────────────────────────

interface MigrationLogEntry {
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

interface MigrationSummary {
  totalFiles: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  skipReasons: Record<string, number>;
  byType: Record<string, { count: number; succeeded: number; failed: number }>;
  totalRelationships: number;
  openQuestionsCreated: number;
  totalDurationMs: number;
  entries: MigrationLogEntry[];
  errors: Array<{ file: string; error: string }>;
}

// ── File Discovery ──────────────────────────────────────────────────────────

function discoverNotes(dir: string): string[] {
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
    if (SKIP_PREFIXES.some((p) => entry.startsWith(p))) continue;

    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      // Don't recurse — we explicitly list subdirectories in SCAN_DIRS
      continue;
    }

    if (!entry.endsWith(".md")) continue;

    // Skip MOC files and non-schema files
    if (entry.endsWith(" MOC.md")) continue;
    if (entry.endsWith(".jsx")) continue;

    notes.push(fullPath);
  }

  return notes.sort();
}

// ── Route to Mapper ─────────────────────────────────────────────────────────

function processNote(
  filePath: string,
  dryRun: boolean
): MigrationLogEntry {
  const relPath = relative(VAULT_ROOT, filePath);
  const start = Date.now();

  // Parse the note
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    return {
      filePath,
      relativePath: relPath,
      templateType: "unknown",
      nodeType: "unknown",
      entityId: "",
      relationshipCount: 0,
      relationships: [],
      openQuestionCreated: false,
      success: false,
      error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }

  let note;
  try {
    note = parseNoteString(content, filePath);
  } catch (err) {
    return {
      filePath,
      relativePath: relPath,
      templateType: "unknown",
      nodeType: "unknown",
      entityId: "",
      relationshipCount: 0,
      relationships: [],
      openQuestionCreated: false,
      success: false,
      error: `Failed to parse: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }

  const templateType = String(note.frontmatter.type || "none");
  const perspective = note.investmentPerspective;

  // Skip types that aren't schema-driven
  if (templateType === "none" || SKIP_TYPES.has(templateType)) {
    return {
      filePath,
      relativePath: relPath,
      templateType,
      nodeType: "skipped",
      entityId: "",
      relationshipCount: 0,
      relationships: [],
      openQuestionCreated: false,
      success: true,
      error: `Skipped: type=${templateType}`,
      durationMs: Date.now() - start,
    };
  }

  if (dryRun) {
    let nodeType = "Entity";
    if (templateType === "investment" && perspective === "deal") nodeType = "Bet";
    return {
      filePath,
      relativePath: relPath,
      templateType: perspective ? `${templateType}/${perspective}` : templateType,
      nodeType,
      entityId: `(dry-run)`,
      relationshipCount: note.allWikilinks.length,
      relationships: note.allWikilinks.map((w) => `-> ${w}`),
      openQuestionCreated: false,
      success: true,
      durationMs: Date.now() - start,
    };
  }

  // Route to appropriate mapper
  try {
    if (templateType === "entity") {
      const result = mapEntityToNeo4j(note);
      return {
        filePath,
        relativePath: relPath,
        templateType: "entity",
        nodeType: "Entity",
        entityId: result.entityId,
        relationshipCount: result.relationshipsCreated.length,
        relationships: result.relationshipsCreated,
        openQuestionCreated: result.openQuestionCreated,
        success: result.success,
        error: result.error,
        durationMs: Date.now() - start,
      };
    }

    if (templateType === "account") {
      const result = mapAccountToNeo4j(note);
      return {
        filePath,
        relativePath: relPath,
        templateType: "account",
        nodeType: "Entity {account}",
        entityId: result.accountId,
        relationshipCount: result.relationshipsCreated.length,
        relationships: result.relationshipsCreated,
        openQuestionCreated: result.openQuestionCreated,
        success: result.success,
        error: result.error,
        durationMs: Date.now() - start,
      };
    }

    if (templateType === "cash-flow") {
      const result = mapCashFlowToNeo4j(note);
      return {
        filePath,
        relativePath: relPath,
        templateType: "cash-flow",
        nodeType: "Entity {cash-flow}",
        entityId: result.cashFlowId,
        relationshipCount: result.relationshipsCreated.length,
        relationships: result.relationshipsCreated,
        openQuestionCreated: false,
        success: result.success,
        error: result.error,
        durationMs: Date.now() - start,
      };
    }

    if (templateType === "investment" && perspective === "deal") {
      const result = mapInvestmentDealToNeo4j(note);
      return {
        filePath,
        relativePath: relPath,
        templateType: "investment/deal",
        nodeType: "Bet",
        entityId: result.betId,
        relationshipCount: result.relationshipsCreated.length,
        relationships: result.relationshipsCreated,
        openQuestionCreated: result.openQuestionCreated,
        success: result.success,
        error: result.error,
        durationMs: Date.now() - start,
      };
    }

    if (templateType === "investment" && perspective === "personal") {
      const result = mapInvestmentPositionToNeo4j(note);
      return {
        filePath,
        relativePath: relPath,
        templateType: "investment/personal",
        nodeType: "Entity {investment-position}",
        entityId: result.positionId,
        relationshipCount: result.relationshipsCreated.length,
        relationships: result.relationshipsCreated,
        openQuestionCreated: result.openQuestionCreated,
        success: result.success,
        error: result.error,
        durationMs: Date.now() - start,
      };
    }

    if (templateType === "person") {
      const result = mapPersonToNeo4j(note);
      return {
        filePath,
        relativePath: relPath,
        templateType: "person",
        nodeType: "Entity {person}",
        entityId: result.personId,
        relationshipCount: result.relationshipsCreated.length,
        relationships: result.relationshipsCreated,
        openQuestionCreated: result.openQuestionCreated,
        success: result.success,
        error: result.error,
        durationMs: Date.now() - start,
      };
    }

    if (GENERIC_MAPPER_TYPES.has(templateType)) {
      const result = mapGenericToNeo4j(note);
      return {
        filePath,
        relativePath: relPath,
        templateType,
        nodeType: `Entity {${templateType}}`,
        entityId: result.entityId,
        relationshipCount: result.relationshipsCreated.length,
        relationships: result.relationshipsCreated,
        openQuestionCreated: result.openQuestionCreated,
        success: result.success,
        error: result.error,
        durationMs: Date.now() - start,
      };
    }

    // Unknown type
    return {
      filePath,
      relativePath: relPath,
      templateType,
      nodeType: "unknown",
      entityId: "",
      relationshipCount: 0,
      relationships: [],
      openQuestionCreated: false,
      success: false,
      error: `Unknown template type: ${templateType}`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      filePath,
      relativePath: relPath,
      templateType,
      nodeType: "unknown",
      entityId: "",
      relationshipCount: 0,
      relationships: [],
      openQuestionCreated: false,
      success: false,
      error: `Mapper error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const dirFilter = args.find((a) => a.startsWith("--dir="))?.split("=")[1];

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  VEGA Phase 1 — Full Structured Migration");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Vault: ${VAULT_ROOT}`);
  console.log(`  Mode:  ${dryRun ? "DRY RUN (no Neo4j writes)" : "LIVE"}`);
  if (dirFilter) console.log(`  Filter: ${dirFilter}`);
  console.log("───────────────────────────────────────────────────────────────\n");

  // Verify Neo4j connectivity (unless dry run)
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

  // Discover all notes
  const scanDirs = dirFilter
    ? SCAN_DIRS.filter((d) => d.includes(dirFilter))
    : SCAN_DIRS;

  const allNotes: Array<{ dir: string; files: string[] }> = [];
  let totalFiles = 0;

  for (const dir of scanDirs) {
    const fullDir = join(VAULT_ROOT, dir);
    const files = discoverNotes(fullDir);
    allNotes.push({ dir, files });
    totalFiles += files.length;
    console.log(`  [SCAN] ${dir}: ${files.length} notes`);
  }

  console.log(`\n  Total notes discovered: ${totalFiles}\n`);
  console.log("───────────────────────────────────────────────────────────────\n");

  // Process all notes
  const summary: MigrationSummary = {
    totalFiles,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    skipReasons: {},
    byType: {},
    totalRelationships: 0,
    openQuestionsCreated: 0,
    totalDurationMs: 0,
    entries: [],
    errors: [],
  };

  const migrationStart = Date.now();

  for (const { dir, files } of allNotes) {
    if (files.length === 0) continue;
    console.log(`\n  ── Processing: ${dir} (${files.length} notes) ──\n`);

    for (const filePath of files) {
      const fileName = basename(filePath);
      const entry = processNote(filePath, dryRun);
      summary.entries.push(entry);
      summary.processed++;

      // Track by type
      const typeKey = entry.templateType;
      if (!summary.byType[typeKey]) {
        summary.byType[typeKey] = { count: 0, succeeded: 0, failed: 0 };
      }
      summary.byType[typeKey].count++;

      if (entry.nodeType === "skipped") {
        summary.skipped++;
        const reason = entry.error || "unknown";
        summary.skipReasons[reason] = (summary.skipReasons[reason] || 0) + 1;
        console.log(`    [SKIP] ${fileName} — ${reason}`);
        continue;
      }

      if (entry.success) {
        summary.succeeded++;
        summary.byType[typeKey].succeeded++;
        summary.totalRelationships += entry.relationshipCount;
        if (entry.openQuestionCreated) summary.openQuestionsCreated++;
        console.log(
          `    [OK]   ${fileName} → ${entry.nodeType} (${entry.entityId}) — ` +
            `${entry.relationshipCount} rels, ${entry.durationMs}ms`
        );
      } else {
        summary.failed++;
        summary.byType[typeKey].failed++;
        summary.errors.push({
          file: entry.relativePath,
          error: entry.error || "Unknown error",
        });
        console.log(`    [FAIL] ${fileName} — ${entry.error}`);
      }
    }
  }

  summary.totalDurationMs = Date.now() - migrationStart;

  // ── Print summary ───────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Migration Summary");
  console.log("═══════════════════════════════════════════════════════════════\n");

  console.log(`  Total files:        ${summary.totalFiles}`);
  console.log(`  Processed:          ${summary.processed}`);
  console.log(`  Succeeded:          ${summary.succeeded}`);
  console.log(`  Failed:             ${summary.failed}`);
  console.log(`  Skipped:            ${summary.skipped}`);
  console.log(`  Total relationships:${summary.totalRelationships}`);
  console.log(`  OpenQuestions:       ${summary.openQuestionsCreated}`);
  console.log(`  Duration:           ${(summary.totalDurationMs / 1000).toFixed(1)}s`);

  console.log("\n  ── By Template Type ──\n");
  for (const [type, stats] of Object.entries(summary.byType).sort()) {
    console.log(
      `    ${type.padEnd(25)} ${stats.count} total, ${stats.succeeded} OK, ${stats.failed} failed`
    );
  }

  if (Object.keys(summary.skipReasons).length > 0) {
    console.log("\n  ── Skip Reasons ──\n");
    for (const [reason, count] of Object.entries(summary.skipReasons)) {
      console.log(`    ${reason}: ${count}`);
    }
  }

  if (summary.errors.length > 0) {
    console.log("\n  ── Errors ──\n");
    for (const err of summary.errors) {
      console.log(`    ${err.file}: ${err.error}`);
    }
  }

  // ── Verify node counts in Neo4j ─────────────────────────────────────────

  if (!dryRun && summary.succeeded > 0) {
    console.log("\n  ── Neo4j Verification ──\n");
    try {
      const entityCount = runCypher("MATCH (e:Entity) RETURN count(e) AS c;");
      const betCount = runCypher("MATCH (b:Bet) RETURN count(b) AS c;");
      const sourceCount = runCypher("MATCH (s:Source) RETURN count(s) AS c;");
      const oqCount = runCypher("MATCH (oq:OpenQuestion) RETURN count(oq) AS c;");
      const relCount = runCypher("MATCH ()-[r]->() RETURN count(r) AS c;");

      console.log(`    Entity nodes:       ${entityCount}`);
      console.log(`    Bet nodes:          ${betCount}`);
      console.log(`    Source nodes:        ${sourceCount}`);
      console.log(`    OpenQuestion nodes:  ${oqCount}`);
      console.log(`    Total relationships: ${relCount}`);
    } catch {
      console.log("    [WARN] Could not verify Neo4j counts");
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════════\n");

  // Exit with error if any failures
  if (summary.failed > 0) {
    console.log(
      `  RESULT: PARTIAL — ${summary.failed} of ${summary.processed} notes failed\n`
    );
    process.exit(1);
  } else {
    console.log(
      `  RESULT: SUCCESS — ${summary.succeeded} notes migrated, ${summary.skipped} skipped\n`
    );
  }
}

main();
