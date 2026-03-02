# VEGA 3.0 — Project Context for Build Agents

> **This file is read by every Claude Code instance that Ralph spawns.**
> It provides the architectural context needed to implement user stories correctly.
> Stories that add infrastructure should update the Environment section below.

---

## What You're Building

VEGA is a personal AI agent system for the Lingle family. It operates like a high-performing executive team — each agent owns a domain with full accountability, independent judgment, and the confidence to challenge the CEO (Mike Lingle) when the data says he's wrong. VEGA is not a tool. It's a thinking partner that compounds knowledge so every decision gets smarter over time.

**Phase 0+1 scope:** Get from "vanilla IronClaw" to "Lingelpedia Agent is running, consuming the Obsidian vault + email/calendar/Drive, writing to Neo4j, and surfacing compound insights."

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Mike (Human)                   │
│         Obsidian vault = human interface          │
└────────────────────┬────────────────────────────┘
                     │ reads/writes markdown
┌────────────────────▼────────────────────────────┐
│              IronClaw Runtime                     │
│  Rust · WASM sandboxing · MCP protocol           │
│  PostgreSQL (operational DB) · Identity files     │
│                                                   │
│  ┌─────────────────────────────────────────┐     │
│  │         Lingelpedia Agent                │     │
│  │  Identity: lingelpedia.yaml              │     │
│  │  LLM: Grok-4.20 via xAI API             │     │
│  │  Trust: Observe (Phase 1)                │     │
│  │                                          │     │
│  │  Watches: vault files, email, calendar,  │     │
│  │           Drive docs                     │     │
│  │  Produces: atomic claims, truth scores,  │     │
│  │            contradictions, connections,   │     │
│  │            implicit bets                  │     │
│  └────────────┬────────────────────────────┘     │
│               │ MCP protocol                      │
│  ┌────────────▼────────────────────────────┐     │
│  │  MCP Servers                             │     │
│  │  · Neo4j (Cypher)                        │     │
│  │  · File system (Obsidian vault)          │     │
│  │  · Google Calendar (read-only)           │     │
│  │  · Gmail (read-only)                     │     │
│  │  · Google Drive (read-only)              │     │
│  └─────────────────────────────────────────┘     │
└──────────────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│              Neo4j 5.26+                         │
│  Container: lingelpedia                          │
│  Bolt: localhost:7687                            │
│  HTTP: localhost:7474                            │
│  5 node types · 15 relationship types            │
│  Vector index: 1536-dim cosine (claim_embeddings)│
└──────────────────────────────────────────────────┘
```

**Build tool vs. Runtime:** Ralph + Claude Code (you) BUILD VEGA. IronClaw RUNS VEGA. You write code that runs inside IronClaw, not code that replaces it.

---

## Charter Principles (Non-Negotiable)

These seven principles are load-bearing walls. Every line of code must respect them:

1. **Family-First Fiduciary Duty** — VEGA serves the Lingle family. External interests never override family interests.
2. **Wellbeing and Human Autonomy** — Enhance Mike's agency, never replace it. Build capability, not dependency.
3. **Maximally Truth-Seeking** — Biased toward truth over comfort. No sycophancy. "I don't know" beats false confidence.
4. **Curiosity and First-Principles Thinking** — Default to first-principles over convention. Ask "why?" before accepting any requirement.
5. **Compound Value Over Time** — Every action should make the system more valuable tomorrow. The knowledge graph is the compound interest engine.
6. **Day 1 Mentality** — Bias toward action. 80% confidence now beats 95% next week. Most decisions are two-way doors.
7. **Human Override Is an Architectural Invariant** — Mike can stop/redirect/override any agent at any time. This is hardware interrupt, not software. Cannot be compressed away or deprioritized.

---

## Operating Algorithm (Applied in Order)

From Elon Musk's 5-Step Algorithm — every agent applies this:

1. **Question every requirement** — Who required it? Does the reason still hold?
2. **Delete** — If you aren't adding back 10% of what you deleted, you aren't deleting enough.
3. **Simplify and optimize** — Only after Steps 1-2.
4. **Accelerate cycle time** — Shorter feedback loops. Daily > weekly > monthly.
5. **Automate last** — Don't automate a process that shouldn't exist.

---

## Behavioral Spec Constraints for Lingelpedia Agent

**Single-threaded ownership:** The Lingelpedia knowledge graph — always on, always evaluating, always maintaining truth.

**North Star:** Knowledge truth and retrieval value — truth score accuracy, contradiction detection rate, retrieval impact.

**How it thinks:** Three perspectives per decision:
- Analytical — Claim verification, truth score calibration, knowledge graph quality
- Ambitious — Cross-temporal pattern detection, serendipitous connections
- Contrarian — Are we capturing the right things? Are truth scores inflated? Is signal-to-noise improving?

**Key behaviors:**
- Decomposes every input into atomic, verifiable claims
- Never deletes knowledge in operational mode (Delete step applies to pipeline, not data)
- Surfaces contradictions immediately, doesn't hide them
- Hunts for implicit bets (unrecognized exposures hiding in positions/structures)
- Publishes truth scores and open questions that other agents must account for

**Trust level:** Observe (Phase 1) — reads data, surfaces insights, takes no autonomous action.

---

## Neo4j Schema

### 5 Node Types

```
(:Claim { id, content, truth_score, truth_basis, domain, source_type, created_at, updated_at, created_by, embedding, status })
(:Entity { id, name, entity_type, domain, aliases, created_at, updated_at })
(:Source { id, source_type, content_hash, raw_content, captured_at, processed_at })
(:OpenQuestion { id, question, domain, priority, raised_by, raised_at, related_claims, status })
(:Bet { id, name, bet_type, thesis, disconfirming_evidence, status, domain, urgency, created_at, last_reviewed })
```

### 15 Relationship Types

```cypher
// Claim relationships
(:Claim)-[:SUPPORTS]->(:Claim)
(:Claim)-[:CONTRADICTS]->(:Claim)
(:Claim)-[:SUPERSEDES]->(:Claim)
(:Claim)-[:DERIVED_FROM]->(:Claim)
(:Claim)-[:RELATES_TO]->(:Claim)

// Entity relationships
(:Claim)-[:ABOUT]->(:Entity)
(:Entity)-[:RELATED_TO]->(:Entity)
(:Entity)-[:BELONGS_TO]->(:Entity)

// Provenance
(:Claim)-[:SOURCED_FROM]->(:Source)
(:Source)-[:AUTHORED_BY]->(:Entity)

// Bets
(:Bet)-[:EVIDENCED_BY]->(:Claim)
(:Bet)-[:TRACKED_BY]->(:Entity)
(:Bet)-[:CONFLICTS_WITH]->(:Bet)

// Open Questions
(:OpenQuestion)-[:INVOLVES]->(:Claim)
(:OpenQuestion)-[:BLOCKS]->(:Bet)
```

### Indexes

```cypher
CREATE VECTOR INDEX claim_embeddings FOR (c:Claim) ON c.embedding
OPTIONS {indexConfig: {`vector.dimensions`: 768, `vector.similarity_function`: 'cosine'}}

CREATE FULLTEXT INDEX claim_content FOR (c:Claim) ON EACH [c.content]

CREATE INDEX claim_domain FOR (c:Claim) ON (c.domain)
CREATE INDEX claim_status FOR (c:Claim) ON (c.status)
CREATE INDEX entity_type FOR (e:Entity) ON (e.entity_type)
CREATE INDEX bet_type FOR (b:Bet) ON (b.bet_type)
CREATE INDEX bet_status FOR (b:Bet) ON (b.status)
CREATE INDEX open_question_status FOR (oq:OpenQuestion) ON (oq.status)
```

### Truth Score Mapping

| Obsidian truth_score | Neo4j truth_score (Float) | Action |
|---------------------|---------------------------|--------|
| verified | 0.95 | High confidence |
| agent-populated | 0.7 | Medium confidence |
| stale | flagged | Re-verification needed |
| conflicted | creates OpenQuestion | Surface contradiction |
| unscored | 0.5 | Default |

---

## Obsidian Vault Structure

The Lingelpedia vault uses YAML frontmatter contracts defined in `_schemas/README.md`. Template types:
- Entity, Account, Investment (Deal), Investment (Personal Position), Cash Flow, Person, Institution, Vehicle

Domains: Finance, GIX, WE, People, Properties, Auto, Family Offices

Cross-domain linking uses `[[wikilinks]]` — these must be preserved as Neo4j relationships.

Agent insights are written to `_agent_insights/` using convention: `YYYY-MM-DD_[type]_[short-description].md` where type is `contradiction`, `connection`, `implicit_bet`, or `stale_claim`.

---

## LLM Configuration

```env
LLM_BACKEND=openai_compatible
LLM_BASE_URL=https://api.x.ai/v1
LLM_API_KEY=<from environment>
LLM_MODEL=grok-4.20
```

### Embedding Pipeline

```env
EMBEDDING_BASE_URL=http://localhost:11434/v1  # Ollama (local)
EMBEDDING_MODEL=nomic-embed-text               # 768-dim vectors
EMBEDDING_API_KEY=ollama                        # Ollama ignores auth
```

Embedding model: nomic-embed-text via Ollama (768 dimensions, cosine similarity).
xAI does not currently offer embedding models — the pipeline uses Ollama locally.
To switch providers, set `EMBEDDING_BASE_URL` and `EMBEDDING_API_KEY` env vars.

Usage: `import { generateEmbedding, storeClaimEmbedding, findSimilarClaims } from "../src/embedding.js"`

---

## Resolved Technical Decisions

- **File watcher:** fsnotify (FSEvents on macOS) with 60-second polling fallback
- **Large note chunking:** Sliding window — 2,000-token segments, 200-token overlap, deduplicate claims by >0.95 cosine similarity
- **Drive indexing:** Full content, incremental sync via lastSyncTimestamp + changes.list API
- **Embedding model:** nomic-embed-text (768-dim) via Ollama — xAI has no embedding models as of 2026-03-02
- **Neo4j heap:** 8GB initial (can increase to 16GB if workload allows)
- **Docker restart policy:** `--restart unless-stopped` for all containers
- **Always-on:** pmset sleep 0, disksleep 0, Docker starts on boot

---

## Environment Details

*Updated by stories as infrastructure is added.*

| Component | Status | Connection |
|-----------|--------|------------|
| Docker | **verified** (v23.0.5) | docker CLI |
| IronClaw | **verified** (v0.12.0) | ~/.ironclaw/, PostgreSQL backend |
| PostgreSQL (IronClaw) | **verified** (v15.16 Homebrew) | /tmp:5432 — accepting connections |
| xAI API | **verified** (via IronClaw keychain) | LLM_BASE_URL=https://api.x.ai/v1, model=grok-4.20 |
| Neo4j | **verified** (v5.26.0 community, APOC 5.26.0, GDS 2.13.2) | bolt://localhost:7687, http://localhost:7474, container: linglepedia |
| Neo4j MCP | **verified** (mcp-neo4j-cypher 0.5.3) | http://127.0.0.1:8765/mcp/ → bolt://localhost:7687 |
| Obsidian vault MCP | **verified** (custom vault-filesystem 1.0.0) | http://127.0.0.1:8766/mcp → ~/Library/Mobile Documents/com~apple~CloudDocs/Linglepedia |
| Embedding pipeline | **verified** (nomic-embed-text 768-dim via Ollama) | http://localhost:11434/v1/embeddings |
| Lingelpedia Agent identity | **verified** (lingelpedia.yaml → IronClaw workspace) | `npm run setup-agent` |
| Google Calendar MCP | **configured** (custom google-calendar 1.0.0, OAuth required) | http://127.0.0.1:8767/mcp |
| Gmail MCP | **configured** (custom gmail 1.0.0, OAuth required) | http://127.0.0.1:8768/mcp |
| Google Drive MCP | **configured** (custom google-drive 1.0.0, OAuth required) | http://127.0.0.1:8770/mcp |

### Host Details (M1 Max MacBook Pro)

- **OS:** Darwin 25.3.0 (macOS)
- **Node.js:** v25.6.1
- **npm:** 11.9.0
- **Rust toolchain:** via cargo (IronClaw binary at ~/.cargo/bin/ironclaw)
- **pmset:** sleep=0, disksleep=0 on AC power (always-on, configured by US-002)
- **Docker autoStart:** enabled (starts on login)
- **Docker restart policy:** all containers use `--restart unless-stopped`
- **IronClaw config:** ~/.ironclaw/.env, secrets in macOS keychain
- **IronClaw MCP servers:** 6 configured (imessage, neo4j, vault, google-calendar, gmail, google-drive) — more to be added in Phase 1

### Always-On Configuration

The host is configured for continuous operation:

| Setting | Value | How |
|---------|-------|-----|
| pmset sleep (AC) | 0 (never) | `sudo pmset -c sleep 0 disksleep 0` |
| pmset disksleep (AC) | 0 (never) | (same command) |
| Docker Desktop | autoStart on login | settings.json `autoStart: true` |
| Container restart | `--restart unless-stopped` | Convention for all `docker run` commands |

To apply or verify: `sudo npm run configure-always-on`

### Neo4j Configuration

| Setting | Value |
|---------|-------|
| Image | `neo4j:5.26.0-community` |
| Container | `linglepedia` |
| HTTP (Browser) | http://localhost:7474 |
| Bolt | bolt://localhost:7687 |
| Auth | `neo4j` / `lingelpedia2026` |
| Data volume | `$HOME/neo4j/data` |
| Heap | 8GB initial / 8GB max |
| Plugins | APOC 5.26.0, Graph Data Science 2.13.2 |
| Restart | `--restart unless-stopped` |
| Docker memory | 16GB (increased from 8GB for Neo4j heap) |

To set up or recreate: `npm run setup-neo4j`

### Neo4j MCP Server

| Setting | Value |
|---------|-------|
| Package | `mcp-neo4j-cypher@0.5.3` (via uvx) |
| Transport | HTTP |
| Endpoint | `http://127.0.0.1:8765/mcp/` |
| Neo4j URI | `bolt://localhost:7687` |
| IronClaw name | `neo4j` |
| LaunchAgent | `com.vega.mcp-neo4j` (RunAtLoad, KeepAlive) |
| Logs | `~/Library/Logs/mcp-neo4j.log`, `~/Library/Logs/mcp-neo4j.err` |
| Tools | `get_neo4j_schema`, `read_neo4j_cypher`, `write_neo4j_cypher` |

To set up or restart: `npm run setup-neo4j-mcp`

### Vault Filesystem MCP Server

| Setting | Value |
|---------|-------|
| Package | Custom `vault-filesystem` 1.0.0 (TypeScript, `@modelcontextprotocol/sdk`) |
| Transport | HTTP (Streamable HTTP, stateless) |
| Endpoint | `http://127.0.0.1:8766/mcp` |
| Vault path | `~/Library/Mobile Documents/com~apple~CloudDocs/Linglepedia` |
| Write scope | `_agent_insights/` only |
| File watching | FSEvents (macOS native, recursive) + 60s polling fallback |
| IronClaw name | `vault` |
| LaunchAgent | `com.vega.mcp-vault` (RunAtLoad, KeepAlive) |
| Logs | `~/Library/Logs/mcp-vault.log`, `~/Library/Logs/mcp-vault.err` |
| Health | `http://127.0.0.1:8766/health` |
| Tools | `list_directory`, `read_file`, `write_file`, `search_files`, `get_changed_files` |

To set up or restart: `npm run setup-vault-mcp`

### Lingelpedia Agent Identity

| Setting | Value |
|---------|-------|
| Identity file | `agents/lingelpedia.yaml` (version-controlled canonical definition) |
| IronClaw IDENTITY.md | Written to workspace memory (name, role, vibe, operating mode) |
| IronClaw AGENTS.md | Written to workspace memory (session instructions, core loop, tools) |
| Agent name | Lingelpedia |
| Role | Chief Knowledge Architect |
| Trust level | Observe (Phase 1 — read-only, surfaces insights) |
| Thinking model | Analytical / Ambitious / Contrarian (3 perspectives per decision) |
| Charter principles | 7 non-negotiable (Family-First through Human Override) |
| Operating algorithm | 5-step (Question, Delete, Simplify, Accelerate, Automate) |
| Startup instructions | Read _schemas/README.md + all schema files + Open Questions |

To set up or update: `npm run setup-agent`

### Google Calendar MCP Server

| Setting | Value |
|---------|-------|
| Package | Custom `google-calendar` 1.0.0 (TypeScript, `@modelcontextprotocol/sdk`) |
| Transport | HTTP (Streamable HTTP, stateless) |
| Endpoint | `http://127.0.0.1:8767/mcp` |
| OAuth scope | `calendar.events.readonly` (read-only) |
| Token storage | macOS Keychain (service: `vega-google-calendar`, account: `refresh_token`) |
| Credentials | `~/Library/Application Support/gogcli/credentials.json` (shared OAuth client) |
| IronClaw name | `google-calendar` |
| IronClaw WASM tool | `google-calendar-tool` (also installed, uses IronClaw's native auth) |
| LaunchAgent | `com.vega.mcp-google-calendar` (RunAtLoad, KeepAlive) |
| Logs | `~/Library/Logs/mcp-google-calendar.log`, `~/Library/Logs/mcp-google-calendar.err` |
| Health | `http://127.0.0.1:8767/health` |
| Tools | `list_events`, `get_event` |

To set up (includes interactive OAuth): `npm run setup-google-calendar-mcp`

**Note:** First-time setup requires browser interaction for Google OAuth consent.
The setup script opens a browser, captures the authorization code via local callback,
exchanges it for tokens, and stores the refresh token in macOS Keychain. After initial
setup, the server auto-refreshes access tokens — no further browser interaction needed.

### Gmail MCP Server

| Setting | Value |
|---------|-------|
| Package | Custom `gmail` 1.0.0 (TypeScript, `@modelcontextprotocol/sdk`) |
| Transport | HTTP (Streamable HTTP, stateless) |
| Endpoint | `http://127.0.0.1:8768/mcp` |
| OAuth scope | `gmail.readonly` (read-only) |
| Token storage | macOS Keychain (service: `vega-gmail`, account: `refresh_token`) |
| Credentials | `~/Library/Application Support/gogcli/credentials.json` (shared OAuth client) |
| IronClaw name | `gmail` |
| LaunchAgent | `com.vega.mcp-gmail` (RunAtLoad, KeepAlive) |
| Logs | `~/Library/Logs/mcp-gmail.log`, `~/Library/Logs/mcp-gmail.err` |
| Health | `http://127.0.0.1:8768/health` |
| Tools | `search_emails`, `read_email` |

To set up (includes interactive OAuth): `npm run setup-gmail-mcp`

**Note:** First-time setup requires browser interaction for Google OAuth consent (same pattern as Google Calendar). The `gmail.readonly` scope grants read-only access — no send capability. Email bodies over 10,000 characters are truncated.

### Google Drive MCP Server

| Setting | Value |
|---------|-------|
| Package | Custom `google-drive` 1.0.0 (TypeScript, `@modelcontextprotocol/sdk`) |
| Transport | HTTP (Streamable HTTP, stateless) |
| Endpoint | `http://127.0.0.1:8770/mcp` |
| OAuth scope | `drive.readonly` (read-only) |
| Token storage | macOS Keychain (service: `vega-google-drive`, account: `refresh_token`) |
| Credentials | `~/Library/Application Support/gogcli/credentials.json` (shared OAuth client) |
| Folder scoping | GIX, WE, Finance (only these top-level folders are accessible) |
| IronClaw name | `google-drive` |
| LaunchAgent | `com.vega.mcp-google-drive` (RunAtLoad, KeepAlive) |
| Logs | `~/Library/Logs/mcp-google-drive.log`, `~/Library/Logs/mcp-google-drive.err` |
| Health | `http://127.0.0.1:8770/health` |
| Tools | `list_files`, `read_document`, `get_sync_status` |
| Document formats | Google Docs (text), Sheets (CSV), PDFs (text extraction), plain text |
| Large doc chunking | 2000-token segments, 200-token overlap (sliding window) |
| Incremental sync | `lastSyncTimestamp` per folder in `~/.vega/drive-sync-state.json` |

To set up (includes interactive OAuth): `npm run setup-google-drive-mcp`

**Note:** First-time setup requires browser interaction for Google OAuth consent (same pattern as Gmail/Calendar). The `drive.readonly` scope grants read-only access. Access is scoped to GIX, WE, and Finance folders — the agent cannot browse the entire Drive. Large documents (>4000 tokens) are automatically chunked with 200-token overlap for seamless downstream processing.

### Health Check

Run `npm run health-check` to verify the environment. The script checks:
- Docker daemon and orphaned containers
- IronClaw process and database connectivity
- PostgreSQL accessibility
- xAI API configuration (direct or via IronClaw keychain)
- pmset sleep/disksleep settings

---

## Completed Stories

*Updated after each story passes.*

- **US-001** — Verify Docker and IronClaw health
- **US-002** — Configure always-on and Docker restart policies
- **US-003** — Install and configure Neo4j
- **US-004** — Apply Lingelpedia Neo4j schema
- **US-005** — Connect Neo4j MCP server to IronClaw
- **US-006** — Connect Obsidian vault file system to IronClaw
- **US-007** — Set up embedding pipeline
- **US-008** — Create Lingelpedia Agent identity file
- **US-009** — Connect Google Calendar MCP
- **US-010** — Connect Gmail MCP
- **US-011** — Connect Google Drive MCP
- **US-012** — Build YAML frontmatter parser
- **US-013** — Build frontmatter-to-Neo4j mapper for Entity notes
- **US-014** — Build frontmatter-to-Neo4j mapper for Account and Cash Flow notes
