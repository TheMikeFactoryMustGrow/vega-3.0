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
OPTIONS {indexConfig: {`vector.dimensions`: 1536, `vector.similarity_function`: 'cosine'}}

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

Embedding model: xAI embedding endpoint (same base URL).

---

## Resolved Technical Decisions

- **File watcher:** fsnotify (FSEvents on macOS) with 60-second polling fallback
- **Large note chunking:** Sliding window — 2,000-token segments, 200-token overlap, deduplicate claims by >0.95 cosine similarity
- **Drive indexing:** Full content, incremental sync via lastSyncTimestamp + changes.list API
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
| Neo4j | not yet installed | bolt://localhost:7687, http://localhost:7474 |
| Obsidian vault MCP | not yet configured | path TBD |
| Google Calendar MCP | not yet configured | — |
| Gmail MCP | not yet configured | — |
| Google Drive MCP | not yet configured | scoped: GIX, WE, Finance folders |

### Host Details (M1 Max MacBook Pro)

- **OS:** Darwin 25.3.0 (macOS)
- **Node.js:** v25.6.1
- **npm:** 11.9.0
- **Rust toolchain:** via cargo (IronClaw binary at ~/.cargo/bin/ironclaw)
- **pmset:** sleep not yet disabled (US-002 will configure)
- **IronClaw config:** ~/.ironclaw/.env, secrets in macOS keychain
- **IronClaw MCP servers:** 1 configured (imessage) — more to be added in Phase 1

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
