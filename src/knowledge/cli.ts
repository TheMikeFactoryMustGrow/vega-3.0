/**
 * Knowledge Agent CLI Entrypoint (v3.5)
 *
 * Provides the main interface for Knowledge Agent operations:
 * - migrate: Initial vault migration pipeline with validation
 * - query: AQM (Answer Quality Monitoring) pipeline for question answering
 * - watch: Dual-write file watcher for continuous sync
 * - status: Health check dashboard and Phase 1 validation
 * - privacy-audit: 6-point privacy audit with escalation warnings
 *
 * Uses TypeScript ESM with Zod runtime validation, non-blocking error handling,
 * and graceful shutdown for long-running processes.
 */

import process from 'process';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import pg from 'pg';
import { z } from 'zod';
import { Neo4jConnection } from './neo4j.js';
import { VaultConnector } from './vault-connector.js';
import { KnowledgePrivacyAuditor } from './privacy-auditor.js';
import { applySchema } from './schema.js';
import { MigrationParser } from './migration/parser.js';
import { EntityMapper, type MigrationStats } from './migration/entity-mapper.js';
import { PersonMapper } from './migration/person-mapper.js';
import { AccountMapper } from './migration/account-mapper.js';
import { InvestmentMapper } from './migration/investment-mapper.js';
import { CashFlowMapper } from './migration/cashflow-mapper.js';
import { InstitutionMapper } from './migration/institution-mapper.js';
import { ClaimDecomposer } from './decomposition/decomposer.js';
import { ContradictionDetector } from './decomposition/contradiction.js';
import { ConnectionDiscovery } from './decomposition/connections.js';
import { EmbeddingPipeline } from './embedding.js';
import { ModelRouter } from './model-router.js';
import { AQMPipeline } from './aqm/pipeline.js';
import { DualWriteSync } from './sync/dual-write.js';

const { Pool } = pg;

/**
 * Environment validation schema
 */
const DEFAULT_VAULT_PATH = `${process.env.HOME}/Library/Mobile Documents/com~apple~CloudDocs/Lingelpedia`;

const EnvSchema = z.object({
  NEO4J_URI: z.string().default('bolt://localhost:7687'),
  NEO4J_USER: z.string().default('neo4j'),
  NEO4J_PASSWORD: z.string(),
  OPENAI_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  XAI_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().default('https://api.x.ai/v1'),
  VAULT_PATH: z.string().default(DEFAULT_VAULT_PATH),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse and validate environment variables
 */
function loadEnv(): Env | null {
  try {
    return EnvSchema.parse(process.env);
  } catch (err) {
    console.error(
      '[ENV ERROR]',
      err instanceof z.ZodError ? err.errors[0].message : String(err)
    );
    return null;
  }
}

/**
 * Initialize Neo4j connection
 * Returns Neo4jConnection on success, null on connection failure (non-blocking)
 */
export async function initNeo4j(uri: string, user: string, password: string): Promise<Neo4jConnection | null> {
  try {
    console.error('[NEO4J] Connecting to', uri);
    const connection = new Neo4jConnection({ uri, user, password });
    const health = await connection.healthCheck();
    if (!health.connected) {
      console.error('[NEO4J ERROR] Health check failed — could not verify connectivity');
      await connection.close();
      return null;
    }
    console.error(`[NEO4J] Connected — version: ${health.version}, nodes: ${health.nodeCount}`);
    return connection;
  } catch (err) {
    console.error('[NEO4J ERROR]', String(err));
    return null;
  }
}

/**
 * Initialize Obsidian vault connector
 * Returns VaultConnector on success, null on failure (non-blocking)
 */
export async function initVaultConnector(vaultPath: string): Promise<VaultConnector | null> {
  try {
    console.error('[VAULT] Connecting to vault at', vaultPath);

    // Verify vault path exists and is accessible
    const pathStat = await stat(vaultPath);
    if (!pathStat.isDirectory()) {
      console.error('[VAULT ERROR] Path is not a directory:', vaultPath);
      return null;
    }

    const connector = new VaultConnector({ vaultPath });
    console.error(`[VAULT] Connected to vault at ${vaultPath}`);
    return connector;
  } catch (err) {
    console.error('[VAULT ERROR]', String(err));
    return null;
  }
}

/**
 * MIGRATE Command
 *
 * Runs the initial vault migration pipeline:
 * 1. Initialize Neo4j connection
 * 2. Apply schema if not already applied
 * 3. Connect to Obsidian vault
 * 4. Parse all notes with YAML frontmatter
 * 5. Run entity/person/account/investment/cashflow/institution mappers
 * 6. Run claim decomposition
 * 7. Run contradiction detection
 * 8. Run cross-domain connection discovery
 * 9. Print summary
 * 10. Validate against Phase 1 thresholds
 */
export async function cmdMigrate(env: Env): Promise<number> {
  let neo4j: Neo4jConnection | null = null;
  try {
    console.error('[MIGRATE] Starting vault migration pipeline...');

    // Step 1: Initialize Neo4j
    neo4j = await initNeo4j(env.NEO4J_URI, env.NEO4J_USER, env.NEO4J_PASSWORD);
    if (!neo4j) {
      console.error('[MIGRATE] Failed to connect to Neo4j');
      return 1;
    }

    // Step 2: Apply schema (constraints + indexes)
    console.error('[MIGRATE] Applying Neo4j schema...');
    const schemaResult = await applySchema(neo4j);
    if (schemaResult.errors.length > 0) {
      console.error('[MIGRATE] Schema errors (non-blocking):', schemaResult.errors.join('; '));
    }
    console.error(`[MIGRATE] Schema applied — ${schemaResult.constraintsCreated} constraints, ${schemaResult.indexesCreated} indexes`);

    // Step 3: Connect to vault
    const vault = await initVaultConnector(env.VAULT_PATH);
    if (!vault) {
      console.error('[MIGRATE] Failed to connect to vault');
      return 1;
    }

    // Step 4: Parse all vault notes
    console.error('[MIGRATE] Scanning vault and parsing notes...');
    const scanResult = await vault.scan();
    console.error(`[MIGRATE] Found ${scanResult.files.length} notes (${scanResult.errors.length} scan errors)`);

    const parser = new MigrationParser();

    // Initialize optional embedding pipeline (non-blocking if OPENAI_API_KEY missing)
    let embedding: EmbeddingPipeline | null = null;
    if (env.OPENAI_API_KEY) {
      try {
        embedding = new EmbeddingPipeline(neo4j, {
          apiKey: env.OPENAI_API_KEY,
          model: env.EMBEDDING_MODEL,
        });
      } catch (err) {
        console.error('[MIGRATE] Embedding pipeline init failed (non-blocking):', String(err));
      }
    }

    // Initialize mappers
    const mapperOpts = { connection: neo4j, embedding };
    const entityMapper = new EntityMapper(mapperOpts);
    const personMapper = new PersonMapper(mapperOpts);
    const accountMapper = new AccountMapper(mapperOpts);
    const investmentMapper = new InvestmentMapper(mapperOpts);
    const cashFlowMapper = new CashFlowMapper(mapperOpts);
    const institutionMapper = new InstitutionMapper(mapperOpts);

    // Step 5: Route each note through the correct mapper based on template type
    console.error('[MIGRATE] Running entity mappers...');
    let totalEntitiesCreated = 0;
    let totalEntitiesUpdated = 0;
    let totalClaimsFromMappers = 0;
    let totalEmbeddingsGenerated = 0;
    const mapperErrors: string[] = [];
    const unstructuredNotes: Array<{ body: string; path: string }> = [];
    let notesProcessed = 0;

    for (const file of scanResult.files) {
      notesProcessed++;
      if (notesProcessed % 50 === 0) {
        console.error(`[MIGRATE] Progress: ${notesProcessed}/${scanResult.files.length} notes processed`);
      }

      // Skip notes with no frontmatter — treat as unstructured
      if (!file.frontmatter) {
        if (file.body.trim()) {
          unstructuredNotes.push({ body: file.body, path: file.path });
        }
        continue;
      }

      const parseResult = parser.parse(file.frontmatter);

      if (!parseResult.valid || !parseResult.template_type) {
        // Unrecognized template — treat body as unstructured text for decomposition
        if (file.body.trim()) {
          unstructuredNotes.push({ body: file.body, path: file.path });
        }
        continue;
      }

      try {
        let stats: MigrationStats;
        switch (parseResult.template_type) {
          case 'entity':
            stats = await entityMapper.migrate(parseResult.data as Parameters<EntityMapper['migrate']>[0], file.body, file.path);
            break;
          case 'person':
            stats = await personMapper.migrate(parseResult.data as Parameters<PersonMapper['migrate']>[0], file.body, file.path);
            break;
          case 'account':
            stats = await accountMapper.migrate(parseResult.data as Parameters<AccountMapper['migrate']>[0], file.body, file.path);
            break;
          case 'investment':
            stats = await investmentMapper.migrate(parseResult.data as Parameters<InvestmentMapper['migrate']>[0], file.body, file.path);
            break;
          case 'cash_flow':
            stats = await cashFlowMapper.migrate(parseResult.data as Parameters<CashFlowMapper['migrate']>[0], file.body, file.path);
            break;
          case 'institution':
            stats = await institutionMapper.migrate(parseResult.data as Parameters<InstitutionMapper['migrate']>[0], file.body, file.path);
            break;
          case 'claim':
            // Claim template notes have their body treated as unstructured for decomposition
            if (file.body.trim()) {
              unstructuredNotes.push({ body: file.body, path: file.path });
            }
            continue;
          default:
            if (file.body.trim()) {
              unstructuredNotes.push({ body: file.body, path: file.path });
            }
            continue;
        }

        totalEntitiesCreated += stats.entities_created;
        totalEntitiesUpdated += stats.entities_updated;
        totalClaimsFromMappers += stats.claims_created;
        totalEmbeddingsGenerated += stats.embeddings_generated;
        if (stats.errors.length > 0) {
          mapperErrors.push(...stats.errors);
        }
      } catch (err) {
        mapperErrors.push(`[${file.path}] ${String(err)}`);
        console.error(`[MIGRATE] Mapper error for ${file.path}: ${String(err)}`);
      }
    }
    console.error(`[MIGRATE] Mappers complete — ${totalEntitiesCreated} entities created, ${totalEntitiesUpdated} updated, ${totalClaimsFromMappers} claims from mappers`);

    // Step 6: Claim decomposition for unstructured notes
    console.error(`[MIGRATE] Running claim decomposition on ${unstructuredNotes.length} unstructured notes...`);
    let totalDecomposedClaims = 0;
    const decomposerErrors: string[] = [];

    // Only run decomposition if we have an xAI key (frontier model required)
    if (env.XAI_API_KEY && unstructuredNotes.length > 0) {
      try {
        const router = new ModelRouter();
        const decomposer = new ClaimDecomposer({
          connection: neo4j,
          embedding,
          router,
        });

        for (const note of unstructuredNotes) {
          try {
            const result = await decomposer.decompose(note.body, {
              sourceType: 'obsidian_note',
              sourcePath: note.path,
            });
            totalDecomposedClaims += result.claims_created;
            if (result.errors.length > 0) {
              decomposerErrors.push(...result.errors);
            }
          } catch (err) {
            decomposerErrors.push(`[${note.path}] ${String(err)}`);
            console.error(`[MIGRATE] Decomposition error for ${note.path}: ${String(err)}`);
          }
        }
      } catch (err) {
        decomposerErrors.push(`Decomposer init failed: ${String(err)}`);
        console.error('[MIGRATE] Decomposer initialization failed:', String(err));
      }
    } else if (!env.XAI_API_KEY) {
      console.error('[MIGRATE] Skipping claim decomposition — XAI_API_KEY not set');
    }
    console.error(`[MIGRATE] Decomposition complete — ${totalDecomposedClaims} claims decomposed`);

    // Step 7: Contradiction detection
    console.error('[MIGRATE] Running contradiction detection...');
    let contradictionsFound = 0;
    if (env.XAI_API_KEY) {
      try {
        const router = new ModelRouter();
        const detector = new ContradictionDetector({
          connection: neo4j,
          embedding,
          router,
        });
        const contradictionResult = await detector.periodicScan();
        contradictionsFound = contradictionResult.contradictions_found;
        console.error(`[MIGRATE] Contradictions found: ${contradictionsFound}, open questions created: ${contradictionResult.open_questions_created}`);
      } catch (err) {
        console.error('[MIGRATE] Contradiction detection error (non-blocking):', String(err));
      }
    } else {
      console.error('[MIGRATE] Skipping contradiction detection — XAI_API_KEY not set');
    }

    // Step 8: Cross-domain connection discovery
    console.error('[MIGRATE] Discovering cross-domain connections...');
    let connectionsDiscovered = 0;
    if (env.XAI_API_KEY) {
      try {
        const router = new ModelRouter();
        const discovery = new ConnectionDiscovery({
          connection: neo4j,
          embedding,
          router,
        });
        const connectionResult = await discovery.detectImplicitBets();
        connectionsDiscovered = connectionResult.connections_found + connectionResult.bets_detected;
        console.error(`[MIGRATE] Connections: ${connectionResult.connections_found}, implicit bets: ${connectionResult.bets_detected}`);
      } catch (err) {
        console.error('[MIGRATE] Connection discovery error (non-blocking):', String(err));
      }
    } else {
      console.error('[MIGRATE] Skipping connection discovery — XAI_API_KEY not set');
    }

    // Step 9: Query real totals from Neo4j for summary
    let realClaimCount = totalClaimsFromMappers + totalDecomposedClaims;
    try {
      const session = neo4j.session();
      try {
        const result = await session.run('MATCH (c:Claim) RETURN count(c) AS count');
        realClaimCount = result.records[0]?.get('count')?.toNumber?.() ?? realClaimCount;
      } finally {
        await session.close();
      }
    } catch {
      // Use aggregate from mappers as fallback
    }

    console.log('[MIGRATION SUMMARY]');
    console.log(`Entities created: ${totalEntitiesCreated}`);
    console.log(`Entities updated: ${totalEntitiesUpdated}`);
    console.log(`Claims from mappers: ${totalClaimsFromMappers}`);
    console.log(`Claims from decomposition: ${totalDecomposedClaims}`);
    console.log(`Total claims in graph: ${realClaimCount}`);
    console.log(`Contradictions found: ${contradictionsFound}`);
    console.log(`Connections discovered: ${connectionsDiscovered}`);
    console.log(`Embeddings generated: ${totalEmbeddingsGenerated}`);
    console.log(`Errors: ${mapperErrors.length + decomposerErrors.length}`);

    // Step 10: Validate against Phase 1 thresholds using real Neo4j count
    const phase1Thresholds = {
      minClaims: 100,
    };

    const phase1Pass = realClaimCount >= phase1Thresholds.minClaims;

    console.log('[PHASE 1 VALIDATION]');
    console.log(`Claims (${realClaimCount}/${phase1Thresholds.minClaims}): ${phase1Pass ? 'PASS' : 'FAIL'}`);

    return phase1Pass ? 0 : 2;
  } catch (err) {
    console.error('[MIGRATE ERROR]', String(err));
    return 1;
  } finally {
    if (neo4j) await neo4j.close();
  }
}

/**
 * QUERY Command
 *
 * Runs a question through the AQM pipeline:
 * 1. Initialize Neo4j + embedding pipeline
 * 2. Pass question through 4-stage AQM pipeline
 *    - Stage 1: Schema Inspection
 *    - Stage 2: Query Construction
 *    - Stage 3: Precision Reranking (semantic_similarity×0.4 + truth_tier×0.35 + recency×0.25)
 *    - Stage 4: Grounded Synthesis
 * 3. Print synthesized answer with source citations and confidence score
 */
export async function cmdQuery(question: string, env: Env): Promise<number> {
  let neo4j: Neo4jConnection | null = null;
  try {
    console.error('[QUERY] Processing question through AQM pipeline...');
    console.error(`[QUERY] Question: "${question}"`);

    // Initialize Neo4j
    neo4j = await initNeo4j(env.NEO4J_URI, env.NEO4J_USER, env.NEO4J_PASSWORD);
    if (!neo4j) {
      console.error('[QUERY] Failed to initialize Neo4j connection');
      return 1;
    }

    // Initialize optional embedding pipeline (non-blocking if OPENAI_API_KEY missing)
    let embedding: EmbeddingPipeline | null = null;
    if (env.OPENAI_API_KEY) {
      try {
        embedding = new EmbeddingPipeline(neo4j, {
          apiKey: env.OPENAI_API_KEY,
          model: env.EMBEDDING_MODEL,
        });
      } catch (err) {
        console.error('[QUERY] Embedding pipeline init failed (non-blocking):', String(err));
      }
    }

    // Initialize model router
    const router = new ModelRouter({
      xaiApiKey: env.XAI_API_KEY,
      llmBaseURL: env.LLM_BASE_URL,
    });

    // Initialize AQM pipeline with real dependencies
    const pipeline = new AQMPipeline({
      connection: neo4j,
      router,
      embedding,
    });

    // Run question through the 4-stage AQM pipeline
    const result = await pipeline.query(question);

    // Handle simple retrieval results
    if (result.classification === 'simple' && result.simpleResults) {
      if (result.simpleResults.length === 0) {
        console.log('No knowledge available for this question.');
        return 0;
      }

      console.log('[ANSWER]');
      console.log('(Simple retrieval — semantic search results)');
      for (const sr of result.simpleResults) {
        console.log(`  [Claim ID: ${sr.claimId} | score: ${sr.score.toFixed(3)}]`);
        console.log(`  ${sr.content}`);
        console.log('');
      }

      // Timing
      console.log('[TIMING]');
      console.log(`  Classification: ${result.timing.classification_ms}ms`);
      console.log(`  Total: ${result.timing.total_ms}ms`);

      return 0;
    }

    // Handle AQM pipeline results
    if (!result.answer && !result.simpleResults?.length) {
      console.log('No knowledge available for this question.');
      return 0;
    }

    // Print synthesized answer
    console.log('[ANSWER]');
    console.log(result.answer ?? '(No synthesized answer available)');

    // Print confidence
    if (result.confidence !== undefined) {
      console.log(`\n[CONFIDENCE] ${(result.confidence * 100).toFixed(1)}%`);
    }

    // Print source citations
    if (result.citations && result.citations.length > 0) {
      console.log('[SOURCES]');
      for (const citation of result.citations) {
        console.log(`  [Claim ID: ${citation.claimId} | truth_tier: ${citation.truthTier} | truth_score: ${citation.truthScore}]`);
        console.log(`  ${citation.content}`);
      }
    }

    // Print identified gaps
    if (result.gaps && result.gaps.length > 0) {
      console.log('[GAPS]');
      for (const gap of result.gaps) {
        console.log(`  - ${gap}`);
      }
    }

    // Print timing breakdown
    console.log('[TIMING]');
    console.log(`  Classification: ${result.timing.classification_ms}ms`);
    if (result.timing.stage1_ms !== undefined) console.log(`  Stage 1 (Schema Inspection): ${result.timing.stage1_ms}ms`);
    if (result.timing.stage2_ms !== undefined) console.log(`  Stage 2 (Query Construction): ${result.timing.stage2_ms}ms`);
    if (result.timing.stage3_ms !== undefined) console.log(`  Stage 3 (Precision Reranking): ${result.timing.stage3_ms}ms`);
    if (result.timing.stage4_ms !== undefined) console.log(`  Stage 4 (Grounded Synthesis): ${result.timing.stage4_ms}ms`);
    console.log(`  Total: ${result.timing.total_ms}ms`);

    if (result.fallbackUsed) {
      console.error('[QUERY] Note: Vector search fallback was used');
    }

    return 0;
  } catch (err) {
    console.error('[QUERY ERROR]', String(err));
    return 1;
  } finally {
    if (neo4j) await neo4j.close();
  }
}

/**
 * WATCH Command
 *
 * Starts the dual-write file watcher:
 * 1. Initialize Neo4j + vault connector
 * 2. Initialize DualWriteSync with PostgreSQL sync ledger
 * 3. Start file watcher on Lingelpedia vault
 * 4. Log file change events to stderr
 * 5. Handle SIGINT/SIGTERM gracefully
 */
export async function cmdWatch(env: Env): Promise<number> {
  let neo4j: Neo4jConnection | null = null;
  let pool: pg.Pool | null = null;

  try {
    console.error('[WATCH] Starting dual-write file watcher...');

    // Initialize Neo4j
    neo4j = await initNeo4j(env.NEO4J_URI, env.NEO4J_USER, env.NEO4J_PASSWORD);
    if (!neo4j) {
      console.error('[WATCH] Failed to connect to Neo4j');
      return 1;
    }

    // Initialize vault connector
    const vault = await initVaultConnector(env.VAULT_PATH);
    if (!vault) {
      console.error('[WATCH] Failed to connect to vault');
      return 1;
    }

    // Initialize optional embedding pipeline
    let embedding: EmbeddingPipeline | null = null;
    if (env.OPENAI_API_KEY) {
      try {
        embedding = new EmbeddingPipeline(neo4j, {
          apiKey: env.OPENAI_API_KEY,
          model: env.EMBEDDING_MODEL,
        });
      } catch (err) {
        console.error('[WATCH] Embedding pipeline init failed (non-blocking):', String(err));
      }
    }

    // Initialize PostgreSQL pool for sync ledger
    pool = new Pool();

    // Initialize DualWriteSync
    const dualWrite = new DualWriteSync({
      connection: neo4j,
      vault,
      pool,
      embedding,
    });

    // Ensure sync tables exist (non-blocking if PG unavailable)
    try {
      await dualWrite.runMigration();
      console.error('[WATCH] Sync ledger tables ready');
    } catch (err) {
      console.error('[WATCH] Sync table migration failed (non-blocking):', String(err));
    }

    console.error('[WATCH] Watcher initialized. Listening for file changes...');

    // Start watching with event logging and _agent_insights filtering
    vault.startWatching(async (event) => {
      const relativePath = path.relative(vault.getVaultPath(), event.filePath);

      // Filter _agent_insights/ to prevent infinite sync loops
      if (relativePath.startsWith('_agent_insights')) return;

      console.error(`[WATCH] ${event.type}: ${relativePath} at ${event.timestamp.toISOString()}`);

      // Skip deletions (DualWriteSync handles create/modify only)
      if (event.type === 'deleted') return;

      try {
        const result = await dualWrite.syncObsidianToNeo4j(event.filePath);

        if (result.success) {
          console.error(`[SYNC] success: ${relativePath} → ${result.neo4j_node_id ?? 'N/A'} (${result.latency_ms}ms)`);
        } else {
          console.error(`[SYNC] failed: ${relativePath} — ${result.error ?? 'unknown error'} (${result.latency_ms}ms)`);
        }
      } catch (err) {
        console.error(`[SYNC] error: ${relativePath} — ${String(err)}`);
      }
    });

    // Graceful shutdown handlers
    const cleanup = async () => {
      console.error('[WATCH] Shutting down gracefully...');
      vault.stopWatching();
      if (neo4j) await neo4j.close();
      if (pool) await pool.end();
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // Keep process running until SIGINT/SIGTERM
    await new Promise(() => {});

    return 0;
  } catch (err) {
    console.error('[WATCH ERROR]', String(err));
    if (neo4j) await neo4j.close();
    if (pool) await pool.end();
    return 1;
  }
}

/**
 * STATUS Command
 *
 * Health check dashboard:
 * 1. Check Neo4j connection — node counts per label
 * 2. Check relationship counts
 * 3. Check latest claim timestamp
 * 4. Check dual-write sync status
 * 5. Print environment status
 * 6. Print pass/fail against Phase 1 criteria
 */
export async function cmdStatus(env: Env): Promise<number> {
  let neo4j: Neo4jConnection | null = null;
  try {
    console.error('[STATUS] Running health check...');

    // Initialize Neo4j
    neo4j = await initNeo4j(env.NEO4J_URI, env.NEO4J_USER, env.NEO4J_PASSWORD);
    if (!neo4j) {
      console.error('[STATUS] Neo4j connection failed');
      console.log('[STATUS DASHBOARD]');
      console.log('Neo4j: DISCONNECTED');
      return 1;
    }

    // Query real node counts per label
    const nodeCounts: Record<string, string> = {};
    let claimCount = 0;
    try {
      const session = neo4j.session();
      try {
        const result = await session.run(
          'MATCH (n) RETURN labels(n)[0] AS label, count(n) AS count ORDER BY count DESC'
        );
        for (const record of result.records) {
          const label = record.get('label') as string;
          const count = record.get('count')?.toNumber?.() ?? record.get('count');
          nodeCounts[label] = String(count);
          if (label === 'Claim') claimCount = Number(count);
        }
      } finally {
        await session.close();
      }
    } catch (err) {
      console.error('[STATUS ERROR] Failed to query node counts:', String(err));
    }

    // Query real relationship count
    let relationshipCount = 'N/A';
    try {
      const session = neo4j.session();
      try {
        const result = await session.run('MATCH ()-[r]->() RETURN count(r) AS count');
        const count = result.records[0]?.get('count')?.toNumber?.() ?? result.records[0]?.get('count');
        relationshipCount = String(count ?? 'N/A');
      } finally {
        await session.close();
      }
    } catch (err) {
      console.error('[STATUS ERROR] Failed to query relationship count:', String(err));
    }

    // Query latest claim timestamp
    let latestClaimTs = 'N/A';
    try {
      const session = neo4j.session();
      try {
        const result = await session.run(
          'MATCH (c:Claim) RETURN c.created_date ORDER BY c.created_date DESC LIMIT 1'
        );
        const ts = result.records[0]?.get('c.created_date');
        if (ts) latestClaimTs = String(ts);
      } finally {
        await session.close();
      }
    } catch (err) {
      console.error('[STATUS ERROR] Failed to query latest claim:', String(err));
    }

    console.log('[STATUS DASHBOARD]');
    console.log('Neo4j: CONNECTED');
    console.log(`  URI: ${env.NEO4J_URI}`);
    console.log('Node Counts:');
    if (Object.keys(nodeCounts).length === 0) {
      console.log('  N/A');
    } else {
      Object.entries(nodeCounts).forEach(([label, count]) => {
        console.log(`  ${label}: ${count}`);
      });
    }
    console.log(`Relationships: ${relationshipCount}`);
    console.log(`Latest Claim: ${latestClaimTs}`);

    // Phase 1 validation using real Claim count
    const phase1Criteria = {
      minClaims: 100,
    };

    const phase1Pass = claimCount >= phase1Criteria.minClaims;

    console.log('[PHASE 1 CRITERIA]');
    console.log(`Claims (${claimCount}/${phase1Criteria.minClaims}): ${phase1Pass ? 'PASS' : 'FAIL'}`);

    // Environment status
    console.log('[ENVIRONMENT STATUS]');
    console.log(`API Keys Loaded: ${env.OPENAI_API_KEY ? 'YES' : 'NO'}`);
    console.log(`Embedding Model: ${env.EMBEDDING_MODEL}`);
    console.log(`LLM Base URL: ${env.LLM_BASE_URL}`);

    // Vault accessibility
    console.log(`Vault Path: ${env.VAULT_PATH}`);

    return phase1Pass ? 0 : 2;
  } catch (err) {
    console.error('[STATUS ERROR]', String(err));
    return 1;
  } finally {
    if (neo4j) await neo4j.close();
  }
}

/**
 * PRIVACY-AUDIT Command
 *
 * Runs 6-point privacy audit:
 * 1-6. Execute privacy audit Cypher queries against live Neo4j
 * Print results in table format
 * Trigger Level 3 escalation warning on violations (Audits 1-5)
 * Exit code 0 if clean, 1 if violations found
 */
export async function cmdPrivacyAudit(env: Env): Promise<number> {
  let neo4j: Neo4jConnection | null = null;
  try {
    console.error('[PRIVACY-AUDIT] Starting privacy audit...');

    // Initialize Neo4j
    neo4j = await initNeo4j(env.NEO4J_URI, env.NEO4J_USER, env.NEO4J_PASSWORD);
    if (!neo4j) {
      console.error('[PRIVACY-AUDIT] Failed to connect to Neo4j');
      return 1;
    }

    // Initialize KnowledgePrivacyAuditor with real Neo4j connection (no PG pool for CLI)
    const auditor = new KnowledgePrivacyAuditor({ connection: neo4j });

    // Run all 6 audit queries
    const report = await auditor.runAllAudits();

    console.log('[PRIVACY AUDIT RESULTS]');
    console.log('');
    console.log('Audit ID             | Audit Name                              | Result');
    console.log('-'.repeat(78));

    for (const finding of report.findings) {
      const result = finding.finding_count === 0 ? 'PASS'
        : finding.finding_count < 0 ? 'ERROR'
        : `FAIL (${finding.finding_count})`;
      console.log(
        `${finding.audit_id.padEnd(21)}| ${finding.audit_name.padEnd(40)}| ${result}`
      );
    }

    if (report.has_escalations) {
      console.log('');
      console.log('[ESCALATION WARNING - LEVEL 3]');
      for (const esc of report.escalations) {
        console.log(`  ${esc.audit_id}: ${esc.description}`);
      }
      console.log('Privacy violations detected. Immediate remediation required.');
      return 1;
    }

    console.log('');
    console.log('[AUDIT RESULT] All privacy checks passed.');
    return 0;
  } catch (err) {
    console.error('[PRIVACY-AUDIT ERROR]', String(err));
    return 1;
  } finally {
    if (neo4j) await neo4j.close();
  }
}

/**
 * Print CLI usage help
 */
function printUsage(): void {
  const usage = `
Knowledge Agent CLI (v3.5)

Usage: npx tsx src/knowledge/cli.ts <command> [options]

Commands:
  migrate              Run the initial vault migration pipeline
                       Validates against Phase 1 thresholds

  query <question>     Run a question through the AQM pipeline
                       Synthesizes answer with source citations

  watch                Start dual-write file watcher
                       Monitors vault for continuous sync

  status               Health check dashboard
                       Shows Neo4j status and Phase 1 validation

  privacy-audit        Run 6-point privacy audit
                       Detects data exposure risks

Examples:
  npx tsx src/knowledge/cli.ts migrate
  npx tsx src/knowledge/cli.ts query "What are John's investments?"
  npx tsx src/knowledge/cli.ts watch
  npx tsx src/knowledge/cli.ts status
  npx tsx src/knowledge/cli.ts privacy-audit

Environment Variables (from Apple Keychain via .zshrc):
  NEO4J_URI           Neo4j connection URI (default: bolt://localhost:7687)
  NEO4J_USER          Neo4j username (default: neo4j)
  NEO4J_PASSWORD      Neo4j password (required)
  OPENAI_API_KEY      OpenAI API key for embeddings
  EMBEDDING_MODEL     Embedding model (default: text-embedding-3-small)
  XAI_API_KEY         xAI Grok API key for synthesis
  LLM_BASE_URL        xAI API base URL (default: https://api.x.ai/v1)
`;
  console.log(usage);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const env = loadEnv();
  if (!env) {
    console.error('[ERROR] Failed to load environment variables');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const command = args[0];

  let exitCode = 0;

  switch (command) {
    case 'migrate':
      exitCode = await cmdMigrate(env);
      break;
    case 'query':
      if (args.length < 2) {
        console.error('[ERROR] query command requires a question');
        printUsage();
        exitCode = 1;
      } else {
        const question = args.slice(1).join(' ');
        exitCode = await cmdQuery(question, env);
      }
      break;
    case 'watch':
      exitCode = await cmdWatch(env);
      break;
    case 'status':
      exitCode = await cmdStatus(env);
      break;
    case 'privacy-audit':
      exitCode = await cmdPrivacyAudit(env);
      break;
    case '--help':
    case '-h':
    case 'help':
      printUsage();
      break;
    default:
      console.error(`[ERROR] Unknown command: ${command || '(none)'}`);
      printUsage();
      exitCode = 1;
  }

  process.exit(exitCode);
}

// Only run main() when executed directly (not when imported as a module)
const isDirectExecution = process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js');
if (isDirectExecution) {
  main().catch((err) => {
    console.error('[FATAL ERROR]', String(err));
    process.exit(1);
  });
}
