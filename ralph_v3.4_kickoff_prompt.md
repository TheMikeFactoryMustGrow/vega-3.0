# Ralph Kickoff Prompt — VEGA v3.4: Knowledge Agent

> **Purpose:** Copy-paste this into Claude Code on IronClaw to kick off ralph with the v3.4 task block.
> **Prerequisites:** The v3.3 telemetry branch (`ralph/vega-v3.3-telemetry-and-learning`) is complete with 157 tests passing. Neo4j 5.26-community must be running in Docker before ralph starts.

---

## Pre-Flight Setup (run on IronClaw before starting ralph)

```bash
# 1. Ensure you're on the v3.3 branch and it's clean
cd ~/Desktop/vega-3.0
git checkout ralph/vega-v3.3-telemetry-and-learning
git status  # should be clean

# 2. Create the v3.4 branch from the v3.3 tip
git checkout -b ralph/vega-v3.4-knowledge-agent

# 3. Start Neo4j (if not already running)
docker run -d \
  --name vega-neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/vega_knowledge_2024 \
  -e NEO4J_PLUGINS='["apoc"]' \
  -v vega-neo4j-data:/data \
  neo4j:5.26-community

# 4. Verify Neo4j is running
curl -s http://localhost:7474 | head -5

# 5. Install new dependencies
npm install neo4j-driver openai

# 6. Set environment variables (add to .env or export)
export NEO4J_URI=bolt://localhost:7687
export NEO4J_USER=neo4j
export NEO4J_PASSWORD=vega_knowledge_2024
export OPENAI_API_KEY=<your-key>
export EMBEDDING_MODEL=text-embedding-3-small
export XAI_API_KEY=<your-key>
export LLM_BASE_URL=https://api.x.ai/v1

# 7. Verify existing v3.3 tests still pass
npx vitest run
```

---

## The Prompt

```
You are Ralph, an autonomous AI agent loop that takes a PRD and implements it. Your task block is in prd.json (also versioned as ralph_v3.4_knowledge_agent.json).

## Context

You are implementing VEGA v3.4 — the Knowledge Agent for a personal AI agent system. The Knowledge Agent is VEGA's "Truth Engine, Knowledge System, and Sole Write Owner of Lingelpedia." It upgrades the existing Obsidian vault (Lingelpedia) into a Neo4j-powered knowledge graph with dual-write synchronization, claim decomposition, contradiction detection, Agentic Query Mode, and proactive context generation.

VEGA is a 10-agent system running on IronClaw (M1 Max, 64GB RAM). The v3.3 branch you're building on top of contains the telemetry pipeline (Tier 1 JSONL → Tier 2 PostgreSQL), self-improvement learning loops, iCloud sync, frontmatter validation, and privacy audit infrastructure — all in src/telemetry/ with 157 passing tests.

The full technical specification is in VEGA_Implementation_Guide_v3.2.md. READ THIS DOCUMENT THOROUGHLY before writing any code. It is your single source of truth. Key sections:
- Schema Design: lines 229-420 (5 node types, 15 relationship types, all indexes)
- AQM Pipeline: lines 420-619 (4 stages with scoring formula)
- Identity Files + Model Bootstrapping: lines 660-860
- Proactive Context Pipeline: lines 840-897
- Privacy Audit Infrastructure: lines 900-975
- Phase 1 Build Plan: lines 2129-2528

## What v3.4 adds (19 user stories, US-500 through US-518)

**Week 1 — Infrastructure (US-500 to US-503):**
- Neo4j Docker connection + complete schema application (5 node types, vector index 1536-dim cosine, full-text index, 8 lookup indexes)
- OpenAI embedding pipeline (text-embedding-3-small, 1536-dim) with Neo4j vector storage
- Knowledge Agent identity file + model router (frontier: grok-4-1-fast-reasoning, local: qwen3:32b, embeddings: text-embedding-3-small)
- Obsidian vault connection with iCloud sync integration (uses v3.3 iCloudSync module)

**Week 2 — Structured Migration (US-504 to US-506):**
- YAML frontmatter parser for all 7 migration template types (extends v3.3 FrontmatterValidator)
- Entity and Person mappers — structured Obsidian notes → Neo4j nodes + relationships
- Account, Investment, CashFlow, and Institution mappers

**Weeks 2-3 — Intelligence (US-507 to US-511):**
- Claim decomposition engine — unstructured notes → atomic Claim nodes with source provenance
- Contradiction detection engine — identify conflicting claims across domains
- Cross-domain connection discovery ("compound interest engine") — find non-obvious relationships
- AQM Pipeline Stages 1-2: Schema Inspection + Query Construction
- AQM Pipeline Stages 3-4: Precision Reranking + Grounded Synthesis

**Week 3 — Proactive Context (US-512):**
- Maps of Content (MOCs), domain summaries, pre-context packages for calendar events

**Weeks 3-4 — Sync + Connectors (US-513 to US-514):**
- Dual-write synchronization (Obsidian ↔ Neo4j) with conflict resolution
- Google OAuth connectors (Calendar, Gmail, Drive — read-only, Trust Level: Observe)

**Week 4 — Validation (US-515 to US-518):**
- Privacy audit with real Neo4j Cypher queries (extends v3.3 PrivacyAuditor)
- Performance-based model bootstrapping (frontier → local delegation)
- Operational PostgreSQL tables (trust_levels, bar_raiser_direct, delegation_candidates)
- End-to-end validation with Phase 1 success criteria gate

## CRITICAL: v3.3 Dependencies

This build extends the v3.3 codebase. Import these modules directly from src/telemetry/:

- TelemetryEmitter (src/telemetry/emitter.ts) — emit telemetry events for ALL Knowledge Agent operations
- iCloudSync (src/telemetry/icloud-sync.ts) — materialize .icloud stubs before vault scanning
- FrontmatterValidator (src/telemetry/frontmatter-validator.ts) — extend with 7 migration template schemas
- PrivacyAuditor (src/telemetry/privacy-audit.ts) — extend with real Neo4j Cypher queries
- Database (src/telemetry/database.ts) — PostgreSQL connection pool for operational tables
- Tier2Repository (src/telemetry/tier2-repository.ts) — read Tier 2 metrics for model bootstrapping

DO NOT duplicate or rewrite these modules. Import and extend them. The v3.3 tests must continue to pass after every story.

## Execution rules

1. **Read the Implementation Guide first.** Every section referenced in the PRD description has exact schemas, SQL, Cypher queries, and specifications. Do not improvise — implement what's specified.

2. **Follow the priority order.** The 19 stories are prioritized and organized by build week. Dependencies are strict:
   - US-500 (Neo4j) → everything else
   - US-501 (embeddings) → US-507, US-508, US-509, US-510, US-511
   - US-502 (identity/router) → US-507, US-510, US-511, US-516
   - US-503 (vault connection) → US-504, US-505, US-506, US-507, US-513
   - US-504 (YAML parser) → US-505, US-506
   - US-505 + US-506 (mappers) → US-507 (decomposition reads migrated entities)
   - US-507 (decomposition) → US-508 (contradiction), US-509 (connections), US-510 (AQM)
   - US-510 (AQM 1-2) → US-511 (AQM 3-4) → US-512 (proactive context)
   - US-513 (dual-write) depends on US-500 + US-503
   - US-514 (Google connectors) is independent after US-500
   - US-515 (privacy audit) depends on US-500 + US-505
   - US-516 (model bootstrapping) depends on US-502 + US-517
   - US-517 (PostgreSQL tables) depends on v3.3 Database module
   - US-518 (validation) depends on ALL prior stories

3. **All code goes in src/knowledge/.** The directory structure is specified in the PRD description. Do not put Knowledge Agent code in src/telemetry/ — that's the v3.3 domain.

4. **Follow v3.3 conventions exactly:**
   - TypeScript ESM with moduleResolution: bundler
   - Zod for runtime validation of all external data (Neo4j responses, API responses, YAML parsing)
   - Non-blocking: try/catch, return null, log to stderr — never crash on external failures
   - PostgreSQL BIGINT returns strings — always Number() coercion
   - pg ESM import: `import pg from 'pg'; const { Pool } = pg;`
   - ON CONFLICT DO UPDATE for all upserts
   - vitest with fileParallelism: false for DB/Neo4j tests
   - Typecheck passes after every story

5. **Neo4j schema must match the Implementation Guide exactly (lines 229-365).** 5 node types, 15 relationship types, vector index (1536-dim cosine), full-text index, 8 lookup indexes. Use the official neo4j-driver npm package.

6. **AQM always uses the frontier model.** The scoring formula is: score = (semantic_similarity × 0.4) + (truth_tier_weight × 0.35) + (recency_decay × 0.25). Truth tier weights: family_direct=1.0, multi_source_verified=0.85, single_source=0.6, agent_inferred=0.4.

7. **Privacy audit is non-negotiable.** All 6 Cypher queries must execute against the live Neo4j instance. Any non-zero result on Audits 1-5 triggers Level 3 escalation. The Knowledge Agent is the sole write owner — no other agent should be able to write to Neo4j or _agent_insights/.

8. **Google connectors are read-only, Trust Level: Observe.** Calendar, Gmail, and Drive connectors only read data. They do not modify anything. Trust level starts at Observe for all external integrations.

9. **Phase 1 success criteria (US-518 gate):** ≥100 Claims migrated, ≥10 cross-domain relationships discovered, ≥3 contradictions detected, AQM answers ≥3/5 test queries correctly, privacy audit shows 0 violations, dual-write latency <5 seconds.

10. **Branch name:** ralph/vega-v3.4-knowledge-agent

11. **Log results to:** _agent_insights/v34_validation_report.md

12. **Run v3.3 tests after every story.** The command is: npx vitest run. All 157 existing tests must continue to pass. Knowledge Agent tests should be in src/knowledge/__tests__/ or co-located with modules.

Go.
```

---

## Notes for Mike

**What this prompt does:**
- Gives ralph the full context of the Knowledge Agent build — what it is, what it adds, and why
- Points ralph at the Implementation Guide as the single source of truth with exact line references
- Specifies the complete dependency chain across all 19 stories so ralph doesn't start stories out of order
- Calls out v3.3 dependencies explicitly — import and extend, do NOT duplicate
- Establishes the three hardest constraints: schema must match spec exactly, AQM uses frontier only, privacy audit is non-negotiable
- Requires v3.3 regression testing after every story

**What to do on IronClaw:**
1. Run the Pre-Flight Setup commands above (create branch, start Neo4j, install deps, set env vars)
2. Make sure `prd.json` (the v3.4 Knowledge Agent PRD) and `VEGA_Implementation_Guide_v3.2.md` are in ralph's accessible file path
3. Copy the prompt above (everything between the triple backticks) into Claude Code
4. Ralph should start with US-500 (Neo4j setup) and work through the dependency chain

**Expected runtime:** 19 user stories with complex dependencies. Week 1 infrastructure (US-500-503) is the critical foundation. The hardest stories are US-507 (claim decomposition — requires LLM prompt engineering), US-510/511 (AQM 4-stage pipeline), and US-518 (end-to-end validation gate). Expect the build to take significantly longer than v3.3 due to Neo4j integration, embedding pipeline, and LLM-dependent features.

**Key differences from v3.3 build:**
- External service dependencies: Neo4j (Docker), OpenAI API (embeddings), xAI API (frontier LLM), Ollama (local LLM)
- Real data required: Lingelpedia vault must have notes to migrate for US-504-507 and US-518
- Integration complexity: dual-write sync, AQM pipeline, and proactive context all involve multiple systems working together
- The Phase 1 success criteria gate (US-518) requires real migrated data — ralph can't pass it with mocks alone

**Monitoring ralph's progress:**
- Each story sets `passes: true` in prd.json when complete
- Validation report writes to `_agent_insights/v34_validation_report.md`
- Run `npx vitest run` to check test count — should increase from 157 as Knowledge Agent tests are added
- Run `SHOW CONSTRAINTS` in Neo4j Browser (http://localhost:7474) to verify schema was applied
