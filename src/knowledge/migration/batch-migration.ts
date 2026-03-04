import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { Neo4jConnection } from "../neo4j.js";
import { EmbeddingPipeline } from "../embedding.js";
import { TelemetryEmitter } from "../../telemetry/emitter.js";
import { MigrationParser } from "./parser.js";
import { EntityMapper, type MigrationStats, type MapperOptions } from "./entity-mapper.js";
import { PersonMapper } from "./person-mapper.js";
import { AccountMapper } from "./account-mapper.js";
import { InvestmentMapper } from "./investment-mapper.js";
import { CashFlowMapper } from "./cashflow-mapper.js";
import { InstitutionMapper } from "./institution-mapper.js";
import type {
  EntityTemplate,
  PersonTemplate,
  AccountTemplate,
  InvestmentTemplate,
  CashFlowTemplate,
  InstitutionTemplate,
} from "./parser.js";

/**
 * Aggregate statistics across all template types in a batch migration.
 */
export interface BatchMigrationStats {
  total_files: number;
  processed: number;
  skipped: number;
  by_type: Record<string, MigrationStats>;
  aggregate: MigrationStats;
  errors: string[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: null, body: content };
  }
  try {
    const parsed = YAML.parse(match[1]) as Record<string, unknown>;
    return {
      frontmatter: parsed && typeof parsed === "object" ? parsed : null,
      body: match[2],
    };
  } catch {
    return { frontmatter: null, body: content };
  }
}

/**
 * Recursively collect all .md files under a directory.
 */
async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    // Skip hidden directories (.obsidian, .trash, etc.)
    if (entry.name.startsWith(".")) continue;
    // Skip _agent_insights directory
    if (entry.name === "_agent_insights") continue;

    if (entry.isDirectory()) {
      const subFiles = await collectMarkdownFiles(fullPath);
      results.push(...subFiles);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Run batch migration on a vault directory.
 *
 * Scans for all .md files, detects template type from frontmatter,
 * runs the appropriate mapper for each, and returns aggregate statistics.
 */
export async function batchMigrate(
  vaultDir: string,
  options: MapperOptions,
): Promise<BatchMigrationStats> {
  const start = Date.now();
  const emitter = options.emitter ?? new TelemetryEmitter();
  const parser = new MigrationParser({ emitter });

  const entityMapper = new EntityMapper(options);
  const personMapper = new PersonMapper(options);
  const accountMapper = new AccountMapper(options);
  const investmentMapper = new InvestmentMapper(options);
  const cashFlowMapper = new CashFlowMapper(options);
  const institutionMapper = new InstitutionMapper(options);

  const batchStats: BatchMigrationStats = {
    total_files: 0,
    processed: 0,
    skipped: 0,
    by_type: {},
    aggregate: {
      entities_created: 0,
      entities_updated: 0,
      claims_created: 0,
      embeddings_generated: 0,
      errors: [],
    },
    errors: [],
  };

  // Collect all .md files
  let files: string[];
  try {
    files = await collectMarkdownFiles(vaultDir);
  } catch (err) {
    batchStats.errors.push(`Failed to scan directory: ${err}`);
    return batchStats;
  }

  batchStats.total_files = files.length;

  for (const filePath of files) {
    const relativePath = path.relative(vaultDir, filePath);

    try {
      const content = await readFile(filePath, "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);

      if (!frontmatter) {
        batchStats.skipped++;
        continue;
      }

      const parseResult = parser.parse(frontmatter);
      if (!parseResult.valid || !parseResult.template_type || !parseResult.data) {
        batchStats.skipped++;
        continue;
      }

      let stats: MigrationStats;

      switch (parseResult.template_type) {
        case "entity":
          stats = await entityMapper.migrate(
            parseResult.data as EntityTemplate,
            body,
            relativePath,
          );
          break;
        case "person":
          stats = await personMapper.migrate(
            parseResult.data as PersonTemplate,
            body,
            relativePath,
          );
          break;
        case "account":
          stats = await accountMapper.migrate(
            parseResult.data as AccountTemplate,
            body,
            relativePath,
          );
          break;
        case "investment":
          stats = await investmentMapper.migrate(
            parseResult.data as InvestmentTemplate,
            body,
            relativePath,
          );
          break;
        case "cash_flow":
          stats = await cashFlowMapper.migrate(
            parseResult.data as CashFlowTemplate,
            body,
            relativePath,
          );
          break;
        case "institution":
          stats = await institutionMapper.migrate(
            parseResult.data as InstitutionTemplate,
            body,
            relativePath,
          );
          break;
        case "claim":
          // Claim templates don't have their own mapper — skip for now
          batchStats.skipped++;
          continue;
        default:
          batchStats.skipped++;
          continue;
      }

      // Accumulate stats
      const typeKey = parseResult.template_type;
      if (!batchStats.by_type[typeKey]) {
        batchStats.by_type[typeKey] = {
          entities_created: 0,
          entities_updated: 0,
          claims_created: 0,
          embeddings_generated: 0,
          errors: [],
        };
      }

      batchStats.by_type[typeKey].entities_created += stats.entities_created;
      batchStats.by_type[typeKey].entities_updated += stats.entities_updated;
      batchStats.by_type[typeKey].claims_created += stats.claims_created;
      batchStats.by_type[typeKey].embeddings_generated += stats.embeddings_generated;
      batchStats.by_type[typeKey].errors.push(...stats.errors);

      batchStats.aggregate.entities_created += stats.entities_created;
      batchStats.aggregate.entities_updated += stats.entities_updated;
      batchStats.aggregate.claims_created += stats.claims_created;
      batchStats.aggregate.embeddings_generated += stats.embeddings_generated;
      batchStats.aggregate.errors.push(...stats.errors);

      batchStats.processed++;
    } catch (err) {
      batchStats.errors.push(`Failed to process ${relativePath}: ${err}`);
      batchStats.skipped++;
    }
  }

  await emitter.emit({
    agent_name: "knowledge_agent",
    event_type: "knowledge_write",
    event_subtype: "batch_migration",
    session_id: `batch-migration-${Date.now()}`,
    outcome: batchStats.errors.length === 0 ? "success" : "partial",
    latency_ms: Date.now() - start,
    metadata: {
      total_files: batchStats.total_files,
      processed: batchStats.processed,
      skipped: batchStats.skipped,
      ...batchStats.aggregate,
    },
  });

  return batchStats;
}
