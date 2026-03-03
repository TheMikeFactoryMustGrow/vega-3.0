# VEGA Implementation Guide v3.2

> **This document defines how to build what the Charter describes and the Behavioral Spec specifies.**
> Every technology choice, schema design, integration decision, and build phase is here. This is the only document that changes when tools change. The Charter and Behavioral Spec are technology-agnostic by design — this document is where the technology lives.
>
> If you're looking for what VEGA believes, see the Charter.
> If you're looking for who does what, see the Behavioral Spec.

---

## Current Stack

### Runtime: IronClaw
IronClaw is VEGA's agent runtime — a security-first, Rust-based agent orchestration platform that provides the execution environment for all VEGA agents.

**Why IronClaw:**
- WASM sandboxing isolates untrusted code — even if an LLM gets prompt-injected, it can't touch the host system or read files it shouldn't
- Credential isolation keeps secrets out of the LLM context window — keys are injected at the host boundary milliseconds before execution, never exposed to the model
- MCP Protocol support means agents can connect to external tools (Neo4j, calendars, email, financial APIs) through a standard interface
- Identity files give each agent a persistent personality and behavioral fingerprint across sessions
- Local-first with PostgreSQL backend — operational data stays on Mike's machine
- Plugin architecture for extending agent capabilities without modifying core

**Current state:** Vanilla install, default configuration. No custom identity files, no MCP connections, no custom tools yet.

### Build Tooling: Ralph + Claude Code

VEGA is *built* by Ralph + Claude Code. It *runs* on IronClaw. This distinction matters — Ralph is not part of VEGA's runtime architecture, but it is the mechanism that turns this Implementation Guide into working software.

**Ralph** ([snarktank/ralph](https://github.com/snarktank/ralph)) is an autonomous AI agent loop. It takes a PRD (Product Requirements Document), converts it to a structured `prd.json`, then spawns fresh Claude Code instances in a loop — one story per iteration — until every story passes its acceptance criteria. Each iteration gets a clean context window. State persists between iterations via git history, a `progress.txt` learnings file, and `AGENTS.md` files that encode codebase patterns.

**Claude Code** is the AI coding tool that Ralph spawns each iteration. It reads the prd.json, selects the highest-priority incomplete story, implements it, runs quality checks (typecheck, lint, test), commits, updates progress, and exits. The next iteration picks up where it left off with full git history and accumulated learnings.

**Why this matters for VEGA:**
- The Implementation Guide, Charter, and Behavioral Spec define *what* to build. The PRD translates those documents into right-sized, dependency-ordered stories that Ralph can execute autonomously.
- Each story must fit in a single context window — this forces disciplined decomposition. "Build the Lingelpedia knowledge graph" is not a story. "Create Neo4j Docker container with schema constraints" is.
- The `progress.txt` and `AGENTS.md` pattern means each Claude Code iteration learns from previous iterations. Patterns discovered while building the frontmatter mapper are available when building the unstructured decomposition engine.
- Ralph's loop is idempotent and resumable — if it fails mid-build, restart from where it left off.

**Workflow:**
```
Implementation Guide → PRD (markdown) → prd.json → Ralph loop → Working VEGA
                                                      ↓
                                              Claude Code iteration N
                                              reads: prd.json, progress.txt, AGENTS.md
                                              implements: one story
                                              commits: feat: [US-XXX] - [title]
                                              updates: progress.txt, prd.json
                                              exits
                                                      ↓
                                              Claude Code iteration N+1...
```

**AGENTS.md** will contain the VEGA architecture context — Charter principles, Behavioral Spec constraints, and Lingelpedia schema — so every fresh Claude Code instance understands the system it's building, not just the story it's implementing.

### LLM Backend: Model Router

VEGA v3.1 introduces a **model router** — a thin configuration layer that selects the optimal model for each task based on complexity, cost, and latency requirements. No agent is hardcoded to a single model. The router makes model swaps a configuration change, not a rewrite.

**Primary frontier model:** `grok-4-1-fast-reasoning` via xAI's OpenAI-compatible API.

**Why xAI as the default frontier:**
- Strong reasoning for internal debate model (Analytical/Ambitious/Contrarian + domain voices need genuine multi-perspective analysis)
- Large context window for cross-domain synthesis (VEGA-Core needs to hold constraint sets from multiple agents simultaneously)
- xAI's real-time information access complements Lingelpedia's stored knowledge

**Model Router Configuration:**
```yaml
# config/model_router.yaml
models:
  frontier:
    provider: xai
    model: grok-4-1-fast-reasoning
    base_url: https://api.x.ai/v1
    api_key_env: XAI_API_KEY
    use_for:
      - agent_reasoning          # Internal debate, synthesis, analysis
      - claim_decomposition      # Unstructured text → atomic claims
      - contradiction_detection  # Semantic conflict analysis
      - local_model_supervision  # Spot-checking local model outputs
      - initial_seeding          # First-time vault migration
      - reindexing               # Full re-migration when models change
      - agentic_query_mode       # v3.2: complex graph reasoning — never delegated to local

  local:
    provider: ollama
    model: qwen3:32b             # Or whatever local model passes quality threshold
    base_url: http://localhost:11434/v1
    api_key_env: null
    use_for:
      - routine_claim_updates    # Incremental vault changes after initial seeding
      - embedding_preprocessing  # Text chunking before embedding API call
      - low_stakes_formatting    # Report generation, summary formatting

  embeddings:
    provider: openai
    model: text-embedding-3-small
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
    dimensions: 1536

routing_rules:
  default: frontier
  cost_optimization: true        # Route to local when task complexity is below threshold
  supervision_sample_rate: 0.1   # Frontier spot-checks 10% of local model outputs
  quality_threshold: 0.85        # Local model must score ≥ 85% vs. frontier on calibration set
  fallback: frontier             # If local model fails or quality degrades, frontier takes over
```

**Environment variables** (from `.env`):
```env
# === xAI / Grok LLM ===
XAI_API_KEY=your-xai-api-key-here
LLM_BASE_URL=https://api.x.ai/v1
LLM_MODEL=grok-4-1-fast-reasoning

# === OpenAI Embeddings ===
OPENAI_API_KEY=your-openai-api-key-here
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_MODEL=text-embedding-3-small
```

Each agent gets its own identity file that shapes the frontier model's behavior for that agent's domain and thinking style. The model router sits between IronClaw and the model providers — agents request "reasoning" or "embedding" capabilities, and the router selects the appropriate model.

**One-command historical refresh.** When a better model becomes available (or the frontier model changes), a single command re-runs the full vault pipeline with the new model. The structured migration is idempotent (MERGE operations), so re-running picks up edits without duplicates. Unstructured claims are cleared and regenerated for quality. This is not a rare event — it's a designed operation, expected to happen whenever model quality meaningfully improves.

### Embeddings: OpenAI text-embedding-3-small

VEGA uses OpenAI's `text-embedding-3-small` model for all semantic embeddings. This is a dedicated embedding service, separate from the reasoning LLM.

**Why OpenAI embeddings:**
- 1536-dimensional vectors with strong semantic quality
- Stable, production-grade API with high throughput
- Cost-effective for the volume of claims VEGA generates
- Native support in Neo4j's vector index (1536-dim cosine similarity)

**Why separate from the reasoning model:**
- Embedding quality and reasoning quality are independent concerns. The best reasoning model is not necessarily the best embedding model.
- Decoupling means either can be swapped independently. If a better embedding model emerges, swap it without touching the reasoning pipeline.
- OpenAI's embedding endpoint is fast and cheap. Using the frontier reasoning model for embeddings would be wasteful.

**Embedding pipeline:**
```
New claim created → text extracted → OpenAI API call → 1536-dim vector returned → stored on Claim node → Neo4j vector index updated
```

**Re-embedding.** When the embedding model changes, all existing claim vectors must be regenerated. The re-embedding pipeline processes claims in parallel batches (see Performance section) and updates the Neo4j vector index. This is a designed operation, not an emergency procedure.

### Knowledge Graph: Neo4j

Lingelpedia's storage layer is Neo4j — a native graph database purpose-built for the relationship-heavy, traversal-intensive workload that a knowledge graph demands.

**Why Neo4j over PostgreSQL for Lingelpedia:**
- Lingelpedia stores atomic claims as nodes and relationships between claims as edges. This is literally what graph databases do.
- Traversal queries are the core operation: "find all claims related to X," "find contradictions," "find correlations across domains for implicit bet detection." In Neo4j, these are native Cypher queries. In PostgreSQL, they're recursive CTEs that get uglier as the graph grows.
- Neo4j's native vector index (since 5.11+) handles semantic search — embedding-based similarity for contradiction detection, claim deduplication, and the "casual thought in February surfaces for a strategic decision in August" compound interest engine.
- Factor exposure analysis and correlation mapping for implicit bet detection require traversing relationships across financial, health, legal, and geographic domains simultaneously. Graph databases do this in milliseconds. Relational databases do it in pain.

**Neo4j connects to IronClaw via Neo4j's official MCP server** — agents query Lingelpedia through the same MCP protocol they use for every other tool. No custom integration code needed.

**PostgreSQL remains for IronClaw's operational data:** agent state, conversation history, tool configurations, trust level records, session data, privacy audit logs, model quality metrics. This is relational data that PostgreSQL handles well. The two databases serve different purposes and coexist cleanly.

### Multi-Account Connectors

VEGA v3.1 connects to three account ecosystems, each serving different domains of the Lingle family's life.

| Account | Provider | Protocol | Domains Served |
|---------|----------|----------|---------------|
| **Personal Gmail** | Google OAuth 2.0 | Google API (Calendar, Gmail, Drive) | Family, Personal Finance, General |
| **GIX Corporate** | Microsoft 365 / Azure AD | Microsoft Graph API (Outlook, Calendar, OneDrive/SharePoint) | GIX operations, corporate finance |
| **Family iCloud** | Apple iCloud | Local file system + iMessage DB | Family coordination, shared documents |

**Google (Personal):**
```env
GOOGLE_CLIENT_ID=your-client-id-here
GOOGLE_CLIENT_SECRET=your-client-secret-here
```
- OAuth 2.0 with offline refresh tokens
- Scopes: Calendar (read/write for VEGA-Core), Gmail (read for Phase 1, write for Phase 2), Drive (read, scoped to GIX/WE/Finance folders)
- Multi-account support: if additional Google accounts are needed (e.g., a GIX Google Workspace), each gets its own OAuth credential set in the model router config

**Microsoft 365 (GIX):**
```env
AZURE_CLIENT_ID=your-azure-app-client-id-here
AZURE_CLIENT_SECRET=your-azure-app-client-secret-here
AZURE_TENANT_ID=your-gix-tenant-id-here
```
- Azure AD app registration with delegated permissions
- Microsoft Graph API for: Outlook mail, Outlook calendar, OneDrive/SharePoint documents
- Scoped to GIX tenant — no access to personal Microsoft accounts
- Phase 1 status: **Deferred.** Google connectors first, MS365 when GIX CFO Agent deploys (Phase 3). Connection configs are defined now so Ralph can scaffold the integration points.

**iCloud (Family):**
- The Obsidian vault lives on iCloud: `~/Library/Mobile Documents/com~apple~CloudDocs/Lingelpedia`
- **Critical: iCloud lazy sync handling.** macOS uses lazy downloading for iCloud Drive files. Files not recently accessed exist as `.icloud` placeholder stubs (zero-byte files with metadata). The Knowledge Agent must detect these and trigger downloads before processing:
```bash
# Detect .icloud placeholders
find ~/Library/Mobile\ Documents/com~apple~CloudDocs/Lingelpedia -name "*.icloud"

# Force download a specific file
brctl download "path/to/file.icloud"

# Force download entire vault directory
brctl download ~/Library/Mobile\ Documents/com~apple~CloudDocs/Lingelpedia
```
- The vault watcher must handle `.icloud` stubs gracefully: detect → trigger `brctl download` → wait for materialization → then process. Never attempt to parse a `.icloud` stub as if it were the actual file.
- iMessage access is local (SQLite database at `~/Library/Messages/chat.db`) — no API needed, but requires Full Disk Access permission for the IronClaw process.

### Hardware: M1 Max MacBook Pro (64GB)

VEGA runs locally on a dedicated M1 Max MacBook Pro. Neo4j, PostgreSQL, Ollama (local models), and IronClaw all run on this hardware.

**Capacity assessment:**
- 64GB RAM is comfortable for Neo4j (8-16GB allocation), PostgreSQL (2-4GB), Ollama (16-24GB for qwen3:32b), and IronClaw simultaneously
- M1 Max's 10-core CPU handles concurrent agent operations and graph traversals well
- Local NVMe storage provides fast read/write for the knowledge graph

**Always-on availability.**
This is a dedicated, repurposed M1 Max MacBook Pro — not Mike's daily driver. It will run powered on continuously at home on the UniFi network (wifi or ethernet, whichever is available). This eliminates the competing-workload problem and gives VEGA a purpose-built host from Phase 1 onward.

**Remaining availability considerations:**
- macOS updates will occasionally require restarts. IronClaw should auto-resume agents on reboot. Configure Docker containers with `--restart unless-stopped` so Neo4j and PostgreSQL come back automatically.
- Configure `pmset` to prevent sleep: `sudo pmset -a sleep 0 disksleep 0` (display sleep is fine since this machine has no active user).
- Power outages: the UniFi network has battery backup. Consider adding the MacBook Pro to a UPS as well so VEGA survives brief outages cleanly.
- When VEGA earns Assist/Act trust levels and true always-on becomes critical, evaluate a dedicated Mac Mini or Mac Studio as the permanent VEGA host.

---

## Lingelpedia Schema Design

### The Knowledge Graph Model

Lingelpedia's Neo4j schema is designed around five node types and their relationships. This is the data model that makes atomic claim decomposition, truth scoring, contradiction detection, and implicit bet hunting possible.

#### Node Types

**Claim** — The atomic unit of knowledge. Every piece of information in Lingelpedia is decomposed into individual, verifiable claims.
```
(:Claim {
  id: UUID,
  content: String,           // The claim in natural language
  truth_score: Float,        // 0.0 to 1.0 confidence level
  truth_basis: String,       // Why this score (e.g., "3 independent sources", "single unverified")
  truth_tier: String,        // family_direct, multi_source_verified, single_source, agent_inferred
  domain: String,            // Primary domain (gix, we, personal_finance, health, family, legal, general)
  source_type: String,       // How it entered (voice_memo, journal, agent_output, email, document, conversation)
  created_at: DateTime,
  updated_at: DateTime,
  created_by: String,        // "mike", "lindsay", "knowledge_agent", agent name
  embedding: Vector,         // 1536-dim from OpenAI text-embedding-3-small
  status: String             // active, superseded, disputed, retracted
})
```

**v3.1 change:** Added `truth_tier` field implementing the Charter's Prioritized Truth Hierarchy. Family members' direct statements get `truth_tier: "family_direct"` and truth_score ≥ 0.95. This ensures Mike says Harrison's favorite color is blue — that's ground truth, not a claim to be verified against some external source. New information from any source is cross-referenced against existing knowledge before acceptance. Contradictions with family-sourced knowledge are surfaced, never silently overwritten.

**Entity** — A person, company, property, account, or any real-world thing that claims reference.
```
(:Entity {
  id: UUID,
  name: String,
  entity_type: String,       // person, company, property, account, fund, asset, concept
  domain: String,            // Primary domain association
  aliases: [String],         // Alternative names, nicknames
  created_at: DateTime,
  updated_at: DateTime
})
```

**Source** — The origin of a claim. Preserves provenance for trust scoring and audit trails.
```
(:Source {
  id: UUID,
  source_type: String,       // voice_memo, journal_entry, email, document, meeting_note, agent_analysis
  source_account: String,    // google_personal, microsoft_gix, icloud_family, obsidian_vault
  content_hash: String,      // For deduplication
  raw_content: String,       // Original text as Mike wrote/said it
  captured_at: DateTime,
  processed_at: DateTime
})
```

**v3.1 change:** Added `source_account` field to track which connector provided the source. This supports multi-account provenance — a claim sourced from GIX Outlook has different context than one from personal Gmail.

**OpenQuestion** — An unresolved conflict or low-confidence area that needs attention. These surface rather than hide.
```
(:OpenQuestion {
  id: UUID,
  question: String,          // What needs to be resolved
  domain: String,
  priority: String,          // high, medium, low
  raised_by: String,         // Which agent or process surfaced this
  raised_at: DateTime,
  related_claims: [UUID],
  status: String             // open, investigating, resolved
})
```

**Bet** — A cross-domain lens node that the Bets Register queries against. Not a separate store — a tagged view into the claim graph.
```
(:Bet {
  id: UUID,
  name: String,              // "GIX Series B", "USD concentration", "Indiana geographic bet"
  bet_type: String,          // intentional, implicit
  thesis: String,            // Why this bet was made (intentional) or what it means (implicit)
  disconfirming_evidence: String,  // Pre-committed: what would prove us wrong
  status: String,            // active, monitoring, closed_won, closed_lost, zombie
  domain: String,
  urgency: String,           // urgent, important_not_urgent, monitoring
  created_at: DateTime,
  last_reviewed: DateTime
})
```

#### Relationship Types

```
// Claim relationships
(:Claim)-[:SUPPORTS]->(:Claim)           // This claim strengthens that claim
(:Claim)-[:CONTRADICTS]->(:Claim)        // These claims conflict
(:Claim)-[:SUPERSEDES]->(:Claim)         // Newer information replaces older
(:Claim)-[:DERIVED_FROM]->(:Claim)       // This claim was inferred from that one
(:Claim)-[:RELATES_TO]->(:Claim)         // General association

// Entity relationships
(:Claim)-[:ABOUT]->(:Entity)             // This claim is about this entity
(:Entity)-[:RELATED_TO]->(:Entity)       // Entities connected (e.g., Jim LaMarche -> Blackstone)
(:Entity)-[:BELONGS_TO]->(:Entity)       // Hierarchy (e.g., GIX -> WE portfolio)

// Provenance
(:Claim)-[:SOURCED_FROM]->(:Source)      // Where this claim came from
(:Source)-[:AUTHORED_BY]->(:Entity)      // Who created the source

// Bets
(:Bet)-[:EVIDENCED_BY]->(:Claim)         // Claims that support or inform this bet
(:Bet)-[:TRACKED_BY]->(:Entity)          // Which agent owns this bet's domain
(:Bet)-[:CONFLICTS_WITH]->(:Bet)         // Bets that hedge or contradict each other

// Open Questions
(:OpenQuestion)-[:INVOLVES]->(:Claim)    // Claims related to this question
(:OpenQuestion)-[:BLOCKS]->(:Bet)        // This question affects a bet decision
```

#### Key Indexes

```cypher
// Vector index for semantic search (contradiction detection, compound interest engine)
// 1536 dimensions = OpenAI text-embedding-3-small
CREATE VECTOR INDEX claim_embeddings FOR (c:Claim) ON c.embedding
OPTIONS {indexConfig: {`vector.dimensions`: 1536, `vector.similarity_function`: 'cosine'}}

// Full-text search for keyword queries
CREATE FULLTEXT INDEX claim_content FOR (c:Claim) ON EACH [c.content]

// Lookup indexes for common traversals
CREATE INDEX claim_domain FOR (c:Claim) ON (c.domain)
CREATE INDEX claim_status FOR (c:Claim) ON (c.status)
CREATE INDEX claim_truth_tier FOR (c:Claim) ON (c.truth_tier)
CREATE INDEX entity_type FOR (e:Entity) ON (e.entity_type)
CREATE INDEX bet_type FOR (b:Bet) ON (b.bet_type)
CREATE INDEX bet_status FOR (b:Bet) ON (b.status)
CREATE INDEX open_question_status FOR (oq:OpenQuestion) ON (oq.status)
CREATE INDEX source_account FOR (s:Source) ON (s.source_account)
```

### Example: The Jim LaMarche Scenario

Mike writes: "Talked to Jim — he mentioned he knows someone at Blackstone."

The Knowledge Agent decomposes this into:

**Entities created/updated:**
- `(:Entity {name: "Jim LaMarche", entity_type: "person"})`
- `(:Entity {name: "Blackstone", entity_type: "company"})`

**Claims created:**
- `(:Claim {content: "Jim LaMarche has a contact at Blackstone", truth_score: 0.7, truth_tier: "single_source", source_type: "journal"})`
- `(:Claim {content: "Mike spoke with Jim LaMarche on 2026-03-02", truth_score: 0.95, truth_tier: "family_direct", source_type: "journal"})`

**Relationships:**
- `(claim1)-[:ABOUT]->(jim_lamarche)`
- `(claim1)-[:ABOUT]->(blackstone)`
- `(jim_lamarche)-[:RELATED_TO]->(blackstone)`  // with relationship type "has_contact_at"
- `(claim1)-[:SOURCED_FROM]->(source_journal_entry)`

**Three weeks later,** when the GIX CFO Agent queries for investor outreach opportunities:
```cypher
MATCH (b:Bet {name: "GIX fundraise"})-[:EVIDENCED_BY]->(c:Claim)-[:ABOUT]->(e:Entity)
WHERE e.entity_type = "company" AND e.name CONTAINS "Blackstone"
MATCH (c2:Claim)-[:ABOUT]->(e2:Entity)-[:RELATED_TO]->(e)
WHERE c2.status = "active"
RETURN c2, e2
```
→ Surfaces: "Jim LaMarche mentioned a Blackstone connection on 2026-03-02 — this hasn't been followed up."

### Example: Implicit Bet Detection

The Knowledge Agent runs periodic factor exposure analysis:
```cypher
// Find all financial positions and their currency denomination
MATCH (c:Claim)-[:ABOUT]->(e:Entity)
WHERE c.domain IN ["personal_finance", "gix", "we"]
AND c.content CONTAINS "USD" OR c.content CONTAINS "dollar"
AND c.status = "active"
WITH count(c) as usd_claims

MATCH (c2:Claim)-[:ABOUT]->(e2:Entity)
WHERE c2.domain IN ["personal_finance", "gix", "we"]
AND c2.status = "active"
AND (c2.content CONTAINS "EUR" OR c2.content CONTAINS "GBP" OR c2.content CONTAINS "BTC" OR c2.content CONTAINS "foreign currency")
WITH usd_claims, count(c2) as non_usd_claims

RETURN usd_claims, non_usd_claims,
  CASE WHEN non_usd_claims = 0 THEN "100% USD concentration detected"
  ELSE toString(toFloat(usd_claims) / (usd_claims + non_usd_claims) * 100) + "% USD"
  END as exposure
```
→ Surfaces: "You are currently making an implicit bet that USD will remain strong. 100% of tracked financial positions are USD-denominated. No hedging detected."

---

## Agentic Query Mode Pipeline

The Charter defines Agentic Query Mode as active reasoning in the knowledge space — fundamentally different from retrieval. The Behavioral Spec assigns this capability to the Knowledge Agent's Investigator perspective. This section defines the implementation: the four-stage pipeline that turns a complex question into a grounded, cited answer.

### When It Activates

Not every question needs Agentic Query Mode. The Knowledge Agent classifies incoming queries into two paths:

**Routine queries** (validated local model eligible):
- Single-entity lookups: "What's Jim LaMarche's email?"
- Simple relationship traversal: "Which entities are in the WE portfolio?"
- Status checks: "What's the current truth score on the GIX Series B bet?"
- Recent claim retrieval: "What did I write about CIP last week?"

**Agentic queries** (frontier model only — never delegated):
- Multi-entity exposure analysis: "What's our total exposure to interest rate risk across all entities?"
- Cascading impact modeling: "If interest rates drop 200bp, what's the cascade effect across GIX debt, personal mortgage, and portfolio company leverage?"
- Implicit bet detection across domains: "Which implicit bets changed status in the last 90 days?"
- Cross-domain pattern recognition: "Are there any contradictions between what I told CIP and what the GIX financials show?"
- Structural questions about the graph itself: "What are the weakest links in our knowledge — where is truth score lowest relative to bet significance?"

**Classification heuristic:** If the question requires traversing more than one relationship hop, touching more than one domain, or reasoning about the structure of the knowledge (not just its content), it routes to Agentic Query Mode.

### The Four-Stage Pipeline

```
Question arrives
    │
    ▼
┌─────────────────────────────────────────┐
│ Stage 1: SCHEMA INSPECTION              │
│ What do I know? What's the shape of     │
│ relevant knowledge? What relationships  │
│ exist that could answer this?           │
│                                         │
│ → Inspect node types, relationship      │
│   types, property keys, index catalog   │
│ → Identify candidate traversal paths    │
│ → Assess data density in relevant areas │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ Stage 2: STRUCTURED QUERY CONSTRUCTION  │
│ Build precise Cypher queries that       │
│ traverse the graph along the paths      │
│ identified in Stage 1.                  │
│                                         │
│ → Generate one or more Cypher queries   │
│ → Multi-hop traversals for cascading    │
│   impact questions                      │
│ → Aggregation queries for exposure      │
│   analysis                              │
│ → Temporal filters for change detection │
│ → Execute against Neo4j                 │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ Stage 3: PRECISION RERANKING            │
│ Raw query results may contain noise.    │
│ Rerank to isolate what actually answers │
│ the question vs. what merely matches.   │
│                                         │
│ → Score each result's relevance to the  │
│   original question (not just to the    │
│   query — the question)                 │
│ → Filter out tangentially related but   │
│   non-answering claims                  │
│ → Weight by truth_tier and truth_score  │
│ → Identify gaps: what SHOULD be in the  │
│   answer but is missing from the graph? │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ Stage 4: GROUNDED SYNTHESIS             │
│ Assemble a coherent answer from the     │
│ reranked evidence. Every claim in the   │
│ answer traces back to a specific node.  │
│                                         │
│ → Build reasoning chain from evidence   │
│ → Cite each supporting claim with its   │
│   node ID, truth_tier, and truth_score  │
│ → Flag uncertainty: where is the answer │
│   based on high-confidence claims vs.   │
│   agent-inferred connections?           │
│ → Identify what the answer assumes and  │
│   what it cannot confirm                │
│ → Surface related open questions or     │
│   bets that the question touches        │
└─────────────────────────────────────────┘
```

### Stage 1: Schema Inspection — Implementation

Before building queries, the Investigator needs to understand what it has to work with. This is not a static lookup — the graph's shape evolves as knowledge accumulates.

```cypher
// Discover available node labels and their counts
CALL db.labels() YIELD label
CALL apoc.cypher.run('MATCH (n:`' + label + '`) RETURN count(n) AS count', {}) YIELD value
RETURN label, value.count AS node_count

// Discover available relationship types and their counts
CALL db.relationshipTypes() YIELD relationshipType
CALL apoc.cypher.run(
  'MATCH ()-[r:`' + relationshipType + '`]->() RETURN count(r) AS count', {}
) YIELD value
RETURN relationshipType, value.count AS rel_count

// Discover property keys per node type (for a specific label)
MATCH (c:Claim) WITH c LIMIT 1
RETURN keys(c) AS claim_properties

// Check data density in a domain
MATCH (c:Claim) WHERE c.domain = $target_domain AND c.status = 'active'
RETURN count(c) AS active_claims, avg(c.truth_score) AS avg_truth
```

The Investigator uses schema inspection results to decide whether the graph has sufficient data to answer the question. If a question asks about interest rate exposure but no claims in the graph reference interest rates, the answer is "I don't have sufficient knowledge to answer this" — not a hallucinated guess.

### Stage 2: Structured Query Construction — Implementation

The frontier model builds Cypher queries dynamically based on the question and schema inspection results. Examples for each query archetype:

**Multi-entity exposure analysis:**
```cypher
// "What's our total exposure to interest rate risk across all entities?"
MATCH (c:Claim)-[:ABOUT]->(e:Entity)
WHERE c.status = 'active'
AND c.domain IN ['personal_finance', 'gix', 'we']
AND (c.content CONTAINS 'interest rate' OR c.content CONTAINS 'variable rate'
     OR c.content CONTAINS 'floating rate' OR c.content CONTAINS 'ARM')
WITH e, collect(c) AS claims, count(c) AS claim_count
OPTIONAL MATCH (b:Bet)-[:EVIDENCED_BY]->(bc:Claim)-[:ABOUT]->(e)
WHERE b.status = 'active'
RETURN e.name AS entity, e.entity_type AS type,
       claim_count, [cl IN claims | {content: cl.content, truth_score: cl.truth_score, truth_tier: cl.truth_tier, id: cl.id}] AS evidence,
       collect(DISTINCT b.name) AS related_bets
ORDER BY claim_count DESC
```

**Cascading impact modeling:**
```cypher
// "If interest rates drop 200bp, what's the cascade?"
// Step 1: Find all interest-rate-sensitive positions
MATCH (c:Claim)-[:ABOUT]->(e:Entity)
WHERE c.status = 'active'
AND (c.content CONTAINS 'interest rate' OR c.content CONTAINS 'debt'
     OR c.content CONTAINS 'mortgage' OR c.content CONTAINS 'loan'
     OR c.content CONTAINS 'leverage')
WITH e, collect(c) AS claims

// Step 2: Find entities connected to those entities (cascade)
OPTIONAL MATCH (e)-[:RELATED_TO|BELONGS_TO*1..2]-(e2:Entity)
OPTIONAL MATCH (c2:Claim)-[:ABOUT]->(e2)
WHERE c2.status = 'active'
AND (c2.content CONTAINS 'interest' OR c2.content CONTAINS 'debt'
     OR c2.content CONTAINS 'cash flow')

// Step 3: Find bets affected by these entities
OPTIONAL MATCH (b:Bet)-[:EVIDENCED_BY]->(bc:Claim)-[:ABOUT]->(e)
WHERE b.status = 'active'

RETURN e.name AS primary_entity, e.entity_type,
       [cl IN claims | cl.content] AS direct_exposure,
       collect(DISTINCT e2.name) AS cascade_entities,
       collect(DISTINCT b.name) AS affected_bets
```

**Temporal change detection:**
```cypher
// "Which implicit bets changed status in the last 90 days?"
MATCH (b:Bet)
WHERE b.bet_type = 'implicit'
AND b.last_reviewed > datetime() - duration('P90D')
OPTIONAL MATCH (b)-[:EVIDENCED_BY]->(c:Claim)
WHERE c.status = 'active'
RETURN b.name, b.status, b.thesis, b.last_reviewed,
       collect({claim: c.content, truth_score: c.truth_score, id: c.id}) AS current_evidence
ORDER BY b.last_reviewed DESC
```

### Stage 3: Precision Reranking — Implementation

Raw Cypher results return everything that matches the query pattern. Precision reranking isolates what actually answers the question. This stage uses the frontier model's reasoning to evaluate each result.

**Reranking criteria (applied by the frontier model):**
1. **Relevance to the original question** — not just to the Cypher query. A claim about "GIX office lease" matches a debt query but doesn't answer an interest rate question.
2. **Truth tier weighting** — `family_direct` claims carry more weight than `agent_inferred`. The answer should be transparent about which evidence is high-confidence and which is derived.
3. **Recency** — more recent claims rank higher when the question asks about current state. Historical claims rank higher when the question asks about trends.
4. **Completeness** — does the evidence set cover all aspects of the question? Missing coverage is flagged as a gap.

**Gap detection:** After reranking, the Investigator identifies what SHOULD be in the answer but isn't in the graph. This is surfaced explicitly: "This analysis covers GIX and personal debt but I have no claims about portfolio company leverage. This gap means the cascade analysis is incomplete."

### Stage 4: Grounded Synthesis — Implementation

The final answer is assembled from reranked evidence with full citation traceability.

**Citation format:**
```
[Claim ID: abc123 | truth_tier: family_direct | truth_score: 0.95]
"GIX has a $2.5M variable-rate credit facility with First Internet Bank"

[Claim ID: def456 | truth_tier: single_source | truth_score: 0.70]
"Jim LaMarche mentioned CIP is sensitive to rate environment"
```

Every assertion in the synthesized answer traces back to one or more specific claims. The truth tier and score are visible so the reader can assess confidence. Where the answer requires inference (connecting claims that don't explicitly reference each other), the reasoning chain is shown:

```
Inference: GIX's variable-rate facility [abc123] combined with the upcoming
Series B timeline [ghi789, truth_score: 0.85] suggests that a 200bp rate drop
would reduce annual interest expense by approximately $50K — but this assumes
the facility balance remains at $2.5M [abc123] and no refinancing occurs [gap:
no claims about refinancing plans found].
```

**What the answer always includes:**
- Direct answer to the question (or explicit statement of why it can't be fully answered)
- Evidence chain with claim IDs, truth tiers, and truth scores
- Gaps: what's missing from the knowledge graph that would improve the answer
- Related bets and open questions that the question touches
- Confidence assessment: is this a high-confidence answer or an informed estimate with caveats?

### Model Intelligence for Agentic Query Mode

Agentic Query Mode **always uses the frontier model** (`grok-4-1-fast-reasoning`). This is not a candidate for local model delegation at any stage of maturity. The reasoning:

1. **Schema inspection** requires understanding the question's semantics and mapping them to graph structure — this is multi-step reasoning, not pattern matching.
2. **Query construction** requires generating correct Cypher with dynamic multi-hop traversals — errors produce wrong answers silently.
3. **Precision reranking** requires evaluating whether results actually answer the question — a subtle distinction that local models struggle with.
4. **Grounded synthesis** requires building reasoning chains across multiple evidence sources while accurately tracking confidence — the highest-stakes reasoning in the entire system.

The `model_router.yaml` configuration enforces this with `agentic_query_mode` listed exclusively under the frontier model's `use_for`. The supervision loop does not attempt to train local models on this task type.

---

## Identity Files

Each VEGA agent gets an IronClaw identity file that shapes the frontier model's behavior when operating as that agent. Identity files encode the agent's ownership domain, thinking model, constraints, behavioral guardrails, data access rights, and privacy duties from the Behavioral Spec into a format the LLM internalizes.

### Structure

```yaml
# Example: Knowledge Agent identity file (v3.2)
name: "Knowledge Agent"
role: "Truth Engine, Knowledge System, and Sole Write Owner"

personality:
  core_traits:
    - "Relentlessly truth-seeking — uncertainty is first-class information, never hidden"
    - "Always decomposing — every input becomes atomic, verifiable claims"
    - "Connection-obsessed — the compound interest engine runs on linking disparate facts"
    - "Never deletes knowledge in operational mode — data that seems irrelevant today may be critical tomorrow"
    - "Proactively provides context — doesn't wait to be asked"

ownership: |
  Single-threaded ownership of Lingelpedia — the Lingle family's private, intelligent knowledge system.
  Only the Knowledge Agent can write to Lingelpedia — the Neo4j knowledge graph and the Obsidian vault agent insights.
  No other agent writes directly to Neo4j or the vault. All agents submit knowledge through this agent.
  Always on, always evaluating, always trying to understand and maintain the truth.
  Not a passive filing system. An independent, always-running quality function.

data_access:
  writes:
    - neo4j_knowledge_graph     # Sole write owner — no other agent has write access
    - obsidian_agent_insights   # Writes to _agent_insights/ directory only
  reads:
    - obsidian_vault            # Full read access to all vault files
    - agent_submission_queues   # Receives structured submissions from all other agents
  no_access:
    - email                     # Learns about emails through agent submissions
    - calendar                  # Learns about events through agent submissions
    - financial_apis            # Learns about finances through PWA submissions
    - health_apis               # Learns about health through Wellness submissions

privacy_duties: |
  Data containment is non-negotiable. The knowledge graph touches every domain — health, finance,
  private communications, children's information. This agent periodically audits its own data
  boundaries: where information lives, what can access it, whether containment is intact.
  Children's data (Harrison, Beckham) has elevated protection. No data about the kids flows
  to any system not explicitly approved. When in doubt, protect. Report concerns immediately.

model_intelligence: |
  Performance-based model bootstrapping applies to this agent's capture pipeline.
  Initial vault seeding and re-indexing: always use the frontier model (grok-4-1-fast-reasoning).
  Routine incremental updates (new note added, minor edit): candidate for local model delegation
  after quality threshold is met. The frontier model permanently spot-checks local model output.
  If local model quality degrades, frontier reclaims the task.
  Agentic Query Mode: always uses the frontier model. Complex graph reasoning, structured
  query construction, precision reranking, and grounded synthesis require the highest available
  model intelligence. This is never a candidate for local model delegation.

thinking_model:
  perspectives:
    - name: "Analytical"
      focus: "Claim verification, truth score calibration, knowledge graph quality, query performance, capture completeness"
    - name: "Ambitious"
      focus: "Cross-temporal pattern detection, serendipitous connection discovery, emergent insights that no single domain agent would notice"
    - name: "Contrarian"
      focus: "Are we capturing the right things? Are truth scores accurate or inflated? Is signal-to-noise improving or degrading? Are we hiding uncertainty?"
    - name: "Investigator"    # v3.2: Agentic Query Mode reasoning voice
      focus: "Active reasoning for complex queries — decides what to inspect in the graph, how to construct traversals, whether assembled evidence actually answers the question or just looks like it does"

north_star:
  output_metric: "Knowledge truth and retrieval value"
  controllable_inputs:
    - "Capture pipeline speed"
    - "Decomposition accuracy"
    - "Cross-reference thoroughness"
    - "Contradiction detection latency"
    - "Implicit bet analysis frequency"
    - "Proactive context artifact quality"
    - "Privacy audit completeness"
    - "Agentic query answer quality and citation accuracy"  # v3.2

trust_level: "Observe"  # Starting level — earns expansion through demonstrated competence

operating_algorithm:
  step_1: "Question every claim type and relationship — is it actually used by agents?"
  step_2: "Delete unnecessary steps in capture process, NOT knowledge. Never delete data in operational mode."
  step_3: "Simplify the capture pipeline to minimize friction between Mike's input and structured claims"
  step_4: "Accelerate time from capture to availability — 9am input should be queryable by 9:01am"
  step_5: "Automate claim extraction and scoring only after accuracy is validated against Mike's intended meaning"

charter_principles:
  - "Family-First Fiduciary Duty: All knowledge serves the Lingle family's interests"
  - "Maximally Truth-Seeking: Tell hard truths. Flag cognitive biases. 'I don't know' over false confidence."
  - "Compound Value: Every captured claim makes the system more valuable tomorrow"
  - "Day 1 Mentality: Bias toward action. Capture now, refine later. Don't wait for perfect schema."
  - "Privacy and Protection Duty: Data containment is non-negotiable. Children's data has elevated protection."

deletion_policy: |
  System-Wide Deletion Approval Protocol is in effect.
  Propose all deletions before executing. No exceptions.
  In operational mode, never delete knowledge from the graph.
  Delete steps in the collection pipeline to improve efficiency, not data.

tools:
  - neo4j_mcp    # Read/write to Lingelpedia knowledge graph (only the Knowledge Agent can write to Lingelpedia)
  - embeddings   # Generate semantic embeddings via OpenAI text-embedding-3-small
  - agentic_query_pipeline  # v3.2: schema inspection + Cypher construction + reranking + synthesis (frontier model only)
```

### Agent Identity File List

Each agent defined in the Behavioral Spec gets its own identity file. This includes PWA sub-agents (Bookkeeper, Tax Strategist, Estate Planner), which get separate identity files rather than inheriting from the PWA parent. The reasoning: each sub-agent has a distinct domain expertise, different MCP tool access, and a different thinking model. Separate identity files enforce the principle of least privilege and give each sub-agent a genuine specialist personality.

**v3.1 changes (carried forward):** Every identity file now includes `data_access` (explicit read/write/no_access declarations), `privacy_duties` (domain-specific data protection obligations), and `model_intelligence` (how the model router applies to this agent's workload). All domain agents declare Neo4j as read-only and submit knowledge through the Knowledge Agent.

| Agent | Identity File | Key MCP Tools | Data Access |
|-------|--------------|---------------|-------------|
| VEGA-Core | `vega_core.yaml` | All agent outputs (read), shared context (write), calendar, email, messaging | Read: all agents, Lingelpedia. Write: shared context only. |
| Bar Raiser | `bar_raiser.yaml` | All agent outputs (read-only), Lingelpedia (read-only), privacy audit logs (read), model quality metrics (read) | Read-only on everything. No write access to any operational tool. |
| GIX CFO | `gix_cfo.yaml` | Financial APIs, accounting systems, investor CRM, Lingelpedia (read), document generation, **MS365 MCP** (Outlook, Calendar, OneDrive) | Read: Lingelpedia, GIX financial systems. Submit: claims to Knowledge Agent. |
| PWA | `pwa.yaml` | Banking/brokerage APIs, tax software, Lingelpedia (read), financial modeling tools | Read: Lingelpedia. Submit: claims to Knowledge Agent. |
| Bookkeeper (PWA sub) | `pwa_bookkeeper.yaml` | Accounting system (write), bank feeds, transaction categorization | Domain write only. Submit claims to Knowledge Agent. |
| Tax Strategist (PWA sub) | `pwa_tax_strategist.yaml` | Tax software, entity records, Lingelpedia (read) | Read: Lingelpedia. Submit: claims to Knowledge Agent. |
| Estate Planner (PWA sub) | `pwa_estate_planner.yaml` | Trust documents, estate planning tools, Lingelpedia (read) | Read: Lingelpedia. Submit: claims to Knowledge Agent. |
| Wellness | `wellness.yaml` | Health device APIs (Oura, Whoop, etc.), Lingelpedia (read), calendar constraints | Read: Lingelpedia. Submit: claims to Knowledge Agent. |
| WE Chief of Staff | `we_cos.yaml` | Portfolio company dashboards, deal pipeline, team tools, Lingelpedia (read) | Read: Lingelpedia. Submit: claims to Knowledge Agent. |
| Knowledge Agent | `lingelpedia.yaml` | Neo4j (read/write — **sole write owner**), embedding service, Obsidian vault (read + agent_insights write), all agent submission queues | Write: Neo4j, Obsidian agent insights. Read: vault, all submissions. |

---

## Performance-Based Model Bootstrapping

The Charter's Model Intelligence Strategy is implemented as a supervised delegation pipeline. This is not "use the cheap model to save money." This is "the frontier model is the senior engineer who delegates to a junior and reviews their work forever."

### The Supervision Loop

```
1. FRONTIER DOES THE WORK FIRST
   Task arrives → frontier model (grok-4-1-fast-reasoning) processes it
   → output stored as the "gold standard" for this task type

2. LOCAL MODEL ATTEMPTS THE SAME TASK
   Same input → local model (e.g., qwen3:32b via Ollama) processes it
   → output stored for comparison

3. QUALITY COMPARISON
   Frontier model evaluates local model's output against its own
   → Scoring dimensions: accuracy, completeness, reasoning quality, format compliance
   → Score logged in model_quality_metrics table

4. ITERATE OR DELEGATE
   If local score ≥ quality_threshold (0.85): local model handles this task type going forward
   If local score < threshold: retry with adjusted prompt, or frontier retains the task

5. PERMANENT SUPERVISION (NEVER STOPS)
   Even after delegation, frontier spot-checks supervision_sample_rate (10%) of local outputs
   If quality degrades below threshold: frontier reclaims the task, local is retrained
   The test: "Would I be comfortable with Mike seeing this output?"
```

### Model Quality Tracking

```sql
CREATE TABLE model_quality_metrics (
  id UUID PRIMARY KEY,
  task_type VARCHAR NOT NULL,          -- claim_decomposition, embedding_prep, formatting, etc.
  frontier_model VARCHAR NOT NULL,     -- grok-4-1-fast-reasoning
  local_model VARCHAR NOT NULL,        -- qwen3:32b
  input_hash VARCHAR NOT NULL,         -- Hash of the input for reproducibility
  frontier_score FLOAT,                -- Self-assessed quality (0.0-1.0)
  local_score FLOAT,                   -- Frontier-assessed quality of local output (0.0-1.0)
  delegated BOOLEAN NOT NULL DEFAULT FALSE,  -- Is local model now handling this task type?
  created_at TIMESTAMP NOT NULL,
  notes TEXT
);
```

The Bar Raiser monitors model quality metrics for drift. If local model quality silently degrades (scores trending down over time), the Bar Raiser flags it before it affects output quality.

---

## Proactive Context Pipeline

The Charter defines the Knowledge Agent as proactively providing context — not waiting to be asked. This is the technical implementation.

### Context Artifact Types

**Maps of Content (MOCs)** — Auto-generated index notes that organize related knowledge by theme, domain, or timeframe.
```yaml
# Example MOC: auto-generated when claim density in a topic exceeds threshold
type: map_of_content
theme: "GIX Series B Fundraise"
generated_at: 2026-03-15T08:00:00Z
claims_referenced: 47
domains_spanned: [gix, personal_finance, we]
key_entities: ["GIX Fiber", "CIP", "Topping Capital", "Jim LaMarche"]
open_questions: 3
active_bets: 2
staleness: "2 claims due for re-verification"
```
Written to Obsidian as `_agent_insights/MOC_gix_series_b_fundraise.md` with wiki-linked references to all underlying claims and entities.

**Domain Summaries** — Periodic distillations of what has changed in a domain since the last summary.
```yaml
type: domain_summary
domain: "personal_finance"
period: "2026-03-01 to 2026-03-07"
new_claims: 12
updated_claims: 5
new_contradictions: 1
resolved_questions: 2
key_changes:
  - "New investment position detected in WE Fund III"
  - "Tax filing deadline approaching — 3 related claims flagged"
```

**Pre-Context Packages** — Anticipatory context assembled before an agent needs it, based on observed request patterns.
```yaml
type: pre_context
target_agent: "gix_cfo"
trigger: "Investor meeting with CIP detected on calendar for 2026-03-10"
assembled_at: 2026-03-08T20:00:00Z
contents:
  - latest_claims_about: "CIP"
  - latest_claims_about: "GIX financials"
  - relevant_bets: ["GIX Series B"]
  - open_questions_in_domain: "gix"
  - recent_contradictions: "gix"
```

### Generation Triggers

The Knowledge Agent generates context artifacts based on:
- **Claim density threshold** — when a topic accumulates enough claims to warrant a MOC
- **Calendar events** — pre-context packages assembled 24-48 hours before relevant meetings
- **Domain change velocity** — domain summaries generated when change rate exceeds normal
- **Agent request patterns** — if the GIX CFO Agent repeatedly queries the same topic, pre-build the context
- **Scheduled cadence** — weekly domain summaries for all active domains, daily for high-velocity domains

---

## Privacy Audit Infrastructure

The Charter's Privacy and Protection Duty (Principle 7) requires the system to periodically audit its own data boundaries. This is the technical implementation.

### Audit Scope

The Knowledge Agent runs privacy audits on a configurable schedule (default: weekly). Each audit checks:

1. **Data containment** — Is information flowing only where explicitly authorized? Verify Neo4j access patterns match identity file declarations.
2. **Children's data isolation** — Are claims about Harrison and Beckham tagged with elevated protection? Has any children's data leaked to systems not explicitly approved?
3. **Connector scope verification** — Are MCP connectors accessing only their authorized scopes? Has Google Drive access expanded beyond GIX/WE/Finance folders?
4. **Cross-domain leakage** — Is health data staying in health domain? Is financial data not leaking to unsecured channels?
5. **Agent access pattern review** — Which agents queried what data? Any anomalous access patterns?

### Audit Log

```sql
CREATE TABLE privacy_audit_log (
  id UUID PRIMARY KEY,
  audit_type VARCHAR NOT NULL,         -- containment, children_data, connector_scope, cross_domain, access_pattern
  status VARCHAR NOT NULL,             -- pass, warning, violation
  finding TEXT,                        -- What was found (null if pass)
  affected_data TEXT,                  -- What data is involved
  affected_agent VARCHAR,              -- Which agent (if applicable)
  recommended_action TEXT,
  created_at TIMESTAMP NOT NULL,
  acknowledged_at TIMESTAMP,           -- When Mike saw it (null if auto-resolved)
  resolved_at TIMESTAMP,
  resolution TEXT
);
```

**Escalation:** Privacy violations escalate immediately to Mike — not after the next review cycle, not after analysis. The Bar Raiser independently monitors audit results and can escalate to Level 3 (Direct-to-Mike Bypass) if a violation is detected and not promptly addressed.

### Audit Cypher Query Library

These queries form the automated audit suite. Run all queries on every audit cycle. Any non-zero result on an "Expected: 0" query triggers an immediate escalation.

```cypher
-- Audit 1: Sole write owner verification
-- Ensures only the Knowledge Agent has written to the graph
MATCH (c:Claim) WHERE c.created_by <> 'knowledge_agent'
RETURN count(c) AS unauthorized_writes  -- Expected: 0

-- Audit 2: Children's data protection (Harrison)
MATCH (e:Entity {name: 'Harrison Lingle'})<-[:ABOUT]-(c:Claim)
WHERE NOT c.protection_level = 'children_elevated'
RETURN count(c) AS unprotected_children_claims_harrison  -- Expected: 0

-- Audit 3: Children's data protection (Beckham)
MATCH (e:Entity {name: 'Beckham Lingle'})<-[:ABOUT]-(c:Claim)
WHERE NOT c.protection_level = 'children_elevated'
RETURN count(c) AS unprotected_children_claims_beckham  -- Expected: 0

-- Audit 4: Connector scope verification (Google Drive)
MATCH (s:Source) WHERE s.source_account = 'google_drive'
AND NOT s.folder IN ['GIX', 'WE', 'Finance']
RETURN count(s) AS out_of_scope_drive_sources  -- Expected: 0

-- Audit 5: Cross-domain leakage — health data outside health domain
MATCH (c:Claim) WHERE c.domain = 'health'
WITH c
MATCH (c)-[:SOURCED_FROM]->(s:Source)
WHERE s.source_account NOT IN ['obsidian_vault', 'apple_health']
RETURN count(c) AS health_data_leakage  -- Expected: 0

-- Audit 6: Agent access anomaly detection
-- Flag any agent accessing data outside its declared domains
MATCH (c:Claim) WHERE c.last_accessed_by IS NOT NULL
AND c.last_accessed_by <> 'knowledge_agent'
RETURN c.last_accessed_by AS agent, c.domain AS domain, count(c) AS access_count
ORDER BY access_count DESC
-- Review: cross-reference against agent identity file domain declarations
```

Ralph should implement these as a stored procedure or parameterized query set that the Knowledge Agent calls on its audit schedule. Results are written to `privacy_audit_log` (table defined above). Non-zero results on Audits 1-5 trigger immediate Level 3 escalation.

---

## Telemetry and Observability *(v3.3)*

VEGA operates as a collection of distributed agents, each making decisions about which tools to call, which models to invoke, and how to decompose complex reasoning tasks. Without operational visibility into this behavior, the system becomes opaque: we can see inputs (vault data, user questions) and outputs (Morning Brief, triage recommendations) but not the mechanism that connects them. This section describes how VEGA captures, stores, and surfaces telemetry to answer four critical questions:

1. **What did the system actually do?** Which agents ran, what tools they called, how long each step took.
2. **How well did it do it?** Did the Knowledge Agent produce high-quality claims? Did AQM reranking work correctly?
3. **Is it getting better or worse?** Are quality metrics trending upward, stable, or degrading?
4. **Where is it spending resources?** What is the cost-per-operation and cost-per-agent?

Answering these questions requires a multi-tier observability architecture that avoids centralizing all telemetry in a single system (which could become a bottleneck or failure point) while ensuring agents can query their own performance data for self-improvement. Tier 1 captures raw event streams; Tier 2 aggregates operational metrics; Tier 3 promotes insights to the knowledge graph.

### Three-Tier Telemetry Store

VEGA's telemetry infrastructure is intentionally distributed across three storage tiers, each optimized for different access patterns and retention requirements. This design honors Principle 2 (Telemetry Cannot Be a Single Point of Failure): if one tier becomes unavailable, agents still function with degraded observability rather than complete failure.

**Tier 1: Event Stream (JSON Log Files)**

The foundational tier is a local, append-only event stream stored as JSONL files on the IronClaw runtime's filesystem. Every agent action, tool call, API request, and reasoning step generates an event that is immediately written to the daily log file.

```
Location: ~/vega-telemetry/events/
Format: JSONL (one complete event per line, UTF-8 encoded)
File Naming: events-YYYY-MM-DD.jsonl (e.g., events-2026-03-03.jsonl)
Rotation: Daily at 00:00 UTC; files rotated to ~./vega-telemetry/events/archive/
Retention: 30 days in active directory; archived files kept for 90 days
Volume: 10,000-50,000 events/day at steady state
Access Pattern: Write-once by IronClaw; read-only by aggregation jobs and agents
```

Tier 1 is the system of record for event-level detail. It provides zero-infrastructure, zero-latency buffering: events are written directly to the filesystem and flushed to Tier 2 on a scheduled basis. Tier 1 is never a bottleneck for agent execution, and individual events remain queryable via grep or log parsing tools even if PostgreSQL is unavailable.

**Tier 2: Operational Metrics (PostgreSQL)**

Aggregation jobs run hourly and daily, rolling up Tier 1 events into structured operational metrics stored in IronClaw's existing PostgreSQL instance. Tier 2 enables real-time querying by the Bar Raiser, VEGA-Core, and the Morning Brief System Health section without scanning terabytes of raw events.

```
Location: IronClaw's PostgreSQL instance (existing database)
Content: Aggregated metrics computed by scheduled jobs
  - Agent activity summaries (tool_calls/hour, success_rate, tokens_used)
  - Cost accounting (API dollars spent, tokens by model, cost per agent)
  - Quality scores (AQM accuracy, triage precision, decomposition quality)
  - Anomaly flags (latency spikes, error bursts, cost anomalies, quality degradation)
Retention: 1 year rolling window
Access Pattern: SQL queries from Bar Raiser, aggregation dashboards
Update Frequency: Hourly for recent data; daily for cost/quality rollups
```

Tier 2 enables the Bar Raiser to reason about system health and make escalation decisions. For example, if the Bar Raiser detects that the Knowledge Agent's error rate has spiked above 5% in the last hour, it can escalate that as a "Quality Alert" in its weekly analysis. Similarly, cost anomalies (unexpected spikes in API spend) are surfaced to Mike in the Morning Brief.

**Tier 3: System Knowledge (Lingelpedia / Neo4j)**

Meta-knowledge about VEGA's own behavior is valuable operational insight that belongs in the knowledge graph. During Phase 4, the Knowledge Agent periodically ingests aggregated metrics from Tier 2 and emits Claim nodes that capture system-level insights. These claims are permanent, queryable via AQM, and can influence future agent reasoning.

Examples of Tier 3 claims:
- "The Knowledge Agent processes approximately 50 claims per day during steady-state operation."
- "AQM reranking accuracy improved from 60% in January to 87% in March (improving trend)."
- "The GIX CFO Agent's triage precision is 92%, highest among all domain agents."
- "Frontier model invocations cost $0.045 per 1K tokens; local model invocations cost $0.001 per 1K tokens."

Tier 3 is curated by the Knowledge Agent and requires explicit reasoning about what operational data is generalizable knowledge versus temporary artifacts. This separation prevents the knowledge graph from being polluted with noise while ensuring that meaningful system behavior is captured permanently.

#### Phase Mapping for Three-Tier Deployment

The three tiers are built incrementally across VEGA's development phases:

- **Phase 1**: Tier 1 (JSON event stream) is instrumented into the IronClaw runtime. Every tool call, model invocation, and reasoning step emits an event. Events accumulate but are not yet aggregated. This provides the raw data foundation.
- **Phase 2**: Tier 2 (PostgreSQL aggregation) is built during Ralph's work on Core and Bar Raiser. Scheduled jobs begin rolling up Tier 1 events into operational metrics tables. The Morning Brief System Health section starts displaying data from Tier 2.
- **Phase 4**: Tier 3 (Neo4j meta-knowledge) is populated. The Knowledge Agent reads from Tier 2 metrics and emits claims about system behavior to the knowledge graph.

### Event Schema

Every event in Tier 1 follows a common JSON schema. This schema must be rigid enough to enable reliable aggregation but flexible enough to accommodate new event types as VEGA evolves. All timestamps are ISO 8601 UTC.

```json
{
  "event_id": "a7b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6",
  "timestamp": "2026-03-03T14:22:31.442Z",
  "agent": "knowledge_agent",
  "event_type": "tool_call",
  "event_subtype": "neo4j_cypher_write",
  "phase": "phase_1",
  "details": {
    "tool": "mcp-neo4j-cypher",
    "operation": "MERGE (c:Claim {id: 'claim_xyz'}) SET c.confidence = 0.87",
    "input_tokens": 1240,
    "output_tokens": 320,
    "model": "grok-4-1-fast-reasoning",
    "latency_ms": 1842,
    "success": true,
    "error_type": null,
    "cost_usd": 0.0043
  },
  "context": {
    "source_note": "GIX/Meeting Notes/2026-02-28-Board.md",
    "trust_level": "suggest",
    "triggered_by": "vault_file_watcher",
    "agent_version": "1.2.3"
  }
}
```

**Schema Field Reference:**

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `event_id` | UUID | Yes | Globally unique event identifier; used to deduplicate on re-ingestion |
| `timestamp` | ISO 8601 | Yes | Event timestamp in UTC; used for time-series aggregation |
| `agent` | string | Yes | Name of the agent that generated the event (e.g., `knowledge_agent`, `vega_core`, `bar_raiser`) |
| `event_type` | enum | Yes | Category: `tool_call`, `reasoning`, `model_invocation`, `trust_event`, `privacy_event`, `error`, `escalation`, `user_feedback` |
| `event_subtype` | string | Yes | Specific subtype within category (e.g., `neo4j_cypher_write`, `aqm_query`, `cost_spike`) |
| `phase` | string | Yes | Phase during which event was generated (e.g., `phase_1`, `phase_2`); aids filtering and debugging |
| `details` | object | Yes | Event-specific fields; structure varies by event_type but always includes `success` and latency data |
| `context` | object | No | Optional contextual metadata (source file, trust level, user feedback) |

**Event Types and Subtypes:**

| Event Type | Subtypes | Expected Volume | Purpose |
|------------|----------|-----------------|---------|
| `tool_call` | `neo4j_read`, `neo4j_write`, `obsidian_read`, `obsidian_write`, `google_calendar`, `gmail`, `embedding_request`, etc. | ~1,000/day | Track what agents do and how often they invoke external systems |
| `reasoning` | `claim_decomposition`, `contradiction_check`, `aqm_query`, `triage_score`, `debate_round` | ~500/day | Track reasoning process quality and complexity |
| `model_invocation` | `frontier_call`, `local_call`, `embedding_call` | ~800/day | Cost accounting and model quality tracking |
| `trust_event` | `expansion_request`, `expansion_granted`, `expansion_denied`, `level_check` | ~5/day | Monitor trust level evolution over time |
| `privacy_event` | `audit_run`, `violation_detected`, `children_data_access`, `scope_check` | ~10/day | Ensure privacy constraints are maintained (integrates with Privacy Audit Infrastructure) |
| `error` | `tool_failure`, `api_timeout`, `parse_error`, `schema_violation`, `network_error` | ~20/day | Debug reliability issues and identify patterns |
| `escalation` | `level_1`, `level_2`, `level_3`, `resolution` | ~2/day | Track Bar Raiser effectiveness and escalation patterns |
| `user_feedback` | `brief_rating`, `triage_override`, `correction` | ~5/day | Ground truth for learning and quality evaluation |

The `details` object's structure varies by event_type, but all `tool_call` and `model_invocation` events must include: `latency_ms`, `success` (boolean), `error_type` (null if success=true), and `cost_usd`. The `context` object is optional but recommended for events that should be queryable by source file, trust level, or user action.

### PostgreSQL Aggregation Tables *(v3.3)*

Tier 2 aggregation runs on a fixed schedule: hourly jobs compute agent activity summaries, and daily jobs compute cost and quality rollups. These tables support real-time queries without scanning raw event files.

**Agent Activity Summary (Hourly Aggregation)**

This table is the primary data source for the Morning Brief System Health section and for the Bar Raiser's weekly analysis. It is computed hourly at 15 minutes past the hour for the previous hour's events.

```sql
CREATE TABLE telemetry_agent_hourly (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name VARCHAR NOT NULL,
  hour_start TIMESTAMP NOT NULL,
  hour_end TIMESTAMP NOT NULL,

  -- Volume metrics
  tool_calls_total INT DEFAULT 0,
  tool_calls_success INT DEFAULT 0,
  tool_calls_failed INT DEFAULT 0,
  tool_calls_by_type JSONB,                    -- e.g., {"neo4j_write": 45, "embedding": 23}

  -- Reasoning metrics
  reasoning_steps INT DEFAULT 0,
  reasoning_by_type JSONB,                     -- e.g., {"aqm_query": 8, "decomposition": 12}

  -- Model invocation metrics
  model_invocations_frontier INT DEFAULT 0,
  model_invocations_local INT DEFAULT 0,
  tokens_input_total BIGINT DEFAULT 0,
  tokens_output_total BIGINT DEFAULT 0,

  -- Performance metrics
  cost_usd_total DECIMAL(10,4) DEFAULT 0,
  avg_latency_ms FLOAT,
  p50_latency_ms FLOAT,
  p95_latency_ms FLOAT,
  p99_latency_ms FLOAT,

  -- Error metrics
  errors_total INT DEFAULT 0,
  errors_by_type JSONB,                        -- e.g., {"api_timeout": 2, "parse_error": 1}

  -- Metadata
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(agent_name, hour_start)
);

CREATE INDEX idx_telemetry_agent_hourly_agent ON telemetry_agent_hourly(agent_name, hour_start DESC);
CREATE INDEX idx_telemetry_agent_hourly_hour ON telemetry_agent_hourly(hour_start DESC);
```

**Cost Accounting (Daily Aggregation)**

This table breaks down API spending by agent, model, and day. It enables cost optimization analysis and cost-per-operation calculations.

```sql
CREATE TABLE telemetry_cost_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  agent_name VARCHAR NOT NULL,
  model VARCHAR NOT NULL,

  -- Volume
  invocations INT DEFAULT 0,

  -- Tokens
  tokens_input BIGINT DEFAULT 0,
  tokens_output BIGINT DEFAULT 0,
  tokens_total BIGINT GENERATED ALWAYS AS (tokens_input + tokens_output) STORED,

  -- Cost
  cost_usd DECIMAL(10,4) DEFAULT 0,
  cost_per_mtok DECIMAL(12,8),                 -- Cost per million tokens (derived)

  -- Metadata
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(date, agent_name, model)
);

CREATE INDEX idx_telemetry_cost_daily_agent ON telemetry_cost_daily(agent_name, date DESC);
CREATE INDEX idx_telemetry_cost_daily_date ON telemetry_cost_daily(date DESC);
CREATE INDEX idx_telemetry_cost_daily_cost ON telemetry_cost_daily(cost_usd DESC);
```

**Quality Metrics (Daily Aggregation)**

This table tracks quality trends for agents and reasoning processes. Quality metrics are computed from user feedback (brief ratings, triage overrides), ground-truth corrections, and internal quality scoring (e.g., AQM reranking accuracy, Knowledge Agent decomposition quality).

```sql
CREATE TABLE telemetry_quality_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  agent_name VARCHAR NOT NULL,
  metric_name VARCHAR NOT NULL,

  -- Metric data
  metric_value FLOAT NOT NULL,                 -- Normalized to [0, 1] or percentile scale
  sample_size INT,                             -- Number of samples the metric is based on

  -- Trend analysis
  trend VARCHAR,                               -- 'improving', 'stable', 'degrading', null
  pct_change_from_previous_day FLOAT,          -- Percent change from previous day

  -- Percentiles for context
  p25_value FLOAT,
  p50_value FLOAT,
  p75_value FLOAT,

  -- Metadata
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(date, agent_name, metric_name)
);

CREATE INDEX idx_telemetry_quality_daily_agent ON telemetry_quality_daily(agent_name, date DESC);
CREATE INDEX idx_telemetry_quality_daily_metric ON telemetry_quality_daily(metric_name, date DESC);
```

**Anomalies (Event-Driven)**

This table captures anomalies detected by threshold-based rules or statistical methods. The Bar Raiser consults this table when composing its weekly analysis; anomalies with `severity = 'critical'` are surfaced in the Morning Brief.

```sql
CREATE TABLE telemetry_anomalies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at TIMESTAMP NOT NULL,
  agent_name VARCHAR NOT NULL,
  anomaly_type VARCHAR NOT NULL,

  -- Severity and description
  severity VARCHAR NOT NULL,                   -- 'info', 'warning', 'critical'
  description TEXT NOT NULL,

  -- Metric details
  metric_name VARCHAR,                         -- e.g., 'error_rate', 'latency_p95', 'cost'
  expected_value FLOAT,
  actual_value FLOAT,
  threshold_value FLOAT,

  -- Lifecycle
  acknowledged_at TIMESTAMP,
  resolved_at TIMESTAMP,

  -- Metadata
  created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_telemetry_anomalies_agent ON telemetry_anomalies(agent_name, detected_at DESC);
CREATE INDEX idx_telemetry_anomalies_severity ON telemetry_anomalies(severity, detected_at DESC) WHERE resolved_at IS NULL;
```

**Aggregation Job Specification**

Two scheduled jobs compute these tables:

1. **Hourly Aggregation** (runs at :15 of each hour)
   - Reads Tier 1 events from the previous hour
   - Groups by `agent_name` and 1-hour buckets
   - Computes aggregates and percentiles
   - Writes or updates `telemetry_agent_hourly`
   - Detects and writes anomalies (error_rate > 5%, latency spike > 3x average)

2. **Daily Aggregation** (runs at 01:00 UTC each day)
   - Rolls up previous day's hourly records and Tier 1 events
   - Groups by agent and model; computes cost per agent, cost per model
   - Computes quality metrics from user feedback events
   - Calculates trend direction (improving/stable/degrading) by comparing to previous 7-day window
   - Writes `telemetry_cost_daily` and `telemetry_quality_daily`

Both jobs are idempotent: they can be re-run on the same period without duplicating data (via `UNIQUE` constraints and upsert logic).

### Morning Brief System Health Section *(v3.3)*

The Morning Brief includes a "System Health" section generated by VEGA-Core at 06:00 AM each morning. This section is the primary way Mike receives operational visibility: a 2-3 minute read that answers "How did the system perform yesterday?"

The System Health section pulls data from the previous day's aggregated metrics and surfaces any unresolved anomalies. Below is a mockup showing the expected format:

```
═══════════════════════════════════════════════════════════════
VEGA SYSTEM HEALTH — Last 24 Hours
═══════════════════════════════════════════════════════════════

AGENTS: 3/3 active (Knowledge Agent, VEGA-Core, Bar Raiser)
ACTIONS: 847 total  |  Success Rate: 99.2%  |  Errors: 7 (all retried)

COST
────────────────────────────────────────────────────────────────
Total (yesterday): $4.82
  Frontier models: $4.31 (89%)
  Embeddings: $0.51 (11%)
  Local models: $0.00 (0%)

By Agent:
  Knowledge Agent: $3.12 (65%) — 47 claims processed, 52 graph writes
  VEGA-Core: $1.44 (30%) — 8 AQM queries served, 2,847 tokens used
  Bar Raiser: $0.26 (5%) — Weekly analysis prepared, 3 escalations reviewed

QUALITY TRENDS (7-day window)
────────────────────────────────────────────────────────────────
AQM Reranking Accuracy: 84% → 87% (↑ improving, +3%)
Decomposition Quality: 91% → 91% (→ stable)
Triage Precision: 78% → 82% (↑ improving, +4%)
Knowledge Agent Claims/Day: 47 ± 3 (stable)

ANOMALIES: None detected

PERFORMANCE
────────────────────────────────────────────────────────────────
Avg Tool Call Latency: 2.1s (within normal)
Knowledge Agent — Neo4j writes: avg 1.8s, p95 3.2s
VEGA-Core — AQM queries: avg 2.4s, p95 4.1s
Bar Raiser — Graph reads: avg 0.8s, p95 1.5s

════════════════════════════════════════════════════════════════
```

**Section Generation Logic:**

The Morning Brief generation process queries `telemetry_agent_hourly`, `telemetry_cost_daily`, `telemetry_quality_daily`, and `telemetry_anomalies` to populate this section:

1. **Agent Status**: Count agents with events in the last 24 hours (from `telemetry_agent_hourly` where `hour_start >= NOW() - interval '1 day'`).
2. **Actions & Success**: Sum `tool_calls_total`, `tool_calls_failed` across all agents; calculate success rate.
3. **Cost Breakdown**: Sum `cost_usd_total` from `telemetry_cost_daily` by cost category (inferred from model name).
4. **Quality Trends**: Select latest 7 rows from `telemetry_quality_daily` per metric; compute trend and percent change.
5. **Anomalies**: Query `telemetry_anomalies` where `resolved_at IS NULL and severity IN ('warning', 'critical')` and `detected_at >= NOW() - interval '1 day'`.
6. **Performance**: Query `telemetry_agent_hourly` for p95_latency_ms and avg_latency_ms; compute by agent.

This section is human-readable but also machine-structured (using whitespace alignment and emoji to guide scanning). The Bar Raiser reads this section programmatically when composing its weekly report to identify trends and issues.

### Building Telemetry: Phase Mapping *(v3.3)*

Telemetry infrastructure is built incrementally, aligned with VEGA's development phases. This phased approach allows the system to remain operational while observability matures.

**Phase 1 Deliverables: Tier 1 Event Stream**

During Phase 1 (Weeks 1-4), the IronClaw runtime is instrumented to emit events. The goal is to establish the event stream infrastructure and begin accumulating raw data.

- Instrument IronClaw's agent execution loop to emit `tool_call` events for every tool invocation (Neo4j reads/writes, Obsidian reads/writes, embeddings, etc.)
- Instrument model invocation points to emit `model_invocation` events with token counts and cost estimates
- Implement local JSONL file writing with daily rotation
- Implement basic cost accounting (sum tokens and API calls per agent per day)
- No dashboards, no aggregation jobs yet — just raw event accumulation

**Phase 2 Deliverables: Tier 2 Aggregation & Morning Brief Integration**

During Phase 2 (Weeks 5-8), Ralph implements aggregation tables and integrates telemetry into the Morning Brief. This is when operational visibility becomes real-time.

- Build hourly aggregation job (runs at :15 of each hour); populates `telemetry_agent_hourly`
- Build daily aggregation job (runs at 01:00 UTC); populates `telemetry_cost_daily` and `telemetry_quality_daily`
- Implement threshold-based anomaly detection; populate `telemetry_anomalies`
- Integrate Morning Brief "System Health" section (queries Tier 2 tables)
- Build Bar Raiser's capability to read telemetry and incorporate anomalies into weekly analysis
- Schema validation and data quality checks

**Phase 3 Deliverables: Enhanced Quality Tracking**

During Phase 3 (Weeks 9-12), quality metrics computation is extended and domain agents are onboarded. Telemetry infrastructure is mature enough to support per-agent quality analysis.

- Extend quality metrics to capture domain-specific performance (e.g., GIX CFO triage precision)
- Implement user feedback integration (brief ratings, triage overrides) as ground truth
- Build trend analysis (improving/stable/degrading classification)
- Optimize aggregation job performance for larger event volumes

**Phase 4 Deliverables: Tier 3 Meta-Knowledge**

During Phase 4, the Knowledge Agent reads aggregated telemetry and emits claims to the knowledge graph. System behavior becomes queryable knowledge.

- Knowledge Agent reads `telemetry_cost_daily` and `telemetry_quality_daily`
- Knowledge Agent emits Claim nodes: "Knowledge Agent processes ~50 claims/day", "AQM accuracy is 87%", etc.
- Tier 3 claims are permanent and can influence future agent reasoning
- Agents can query their own performance via AQM (e.g., "What is the Knowledge Agent's current error rate?")

This phasing ensures that by the end of Phase 2, Mike has complete operational visibility (Morning Brief + Bar Raiser analysis) without waiting for knowledge graph integration. Tier 3 is a bonus that emerges later as the system matures.

---

## Self-Improvement and Learning Infrastructure *(v3.3)*

### Overview

This section describes the three closed-loop learning mechanisms through which VEGA and its agents improve their performance autonomously. Rather than remaining open-loop systems (execute task → produce output → move on), the self-improvement infrastructure enables agents to:

1. Read their own quality telemetry from the data warehouse
2. Adjust operational parameters based on measurable performance
3. Reflect on patterns and propose behavioral changes
4. Participate in system-wide structural reviews

The Bar Raiser serves as the immune system for this self-learning: it detects metric gaming, scope creep, and confirmation bias, ensuring that agents improve legitimately rather than optimizing for measured metrics at the expense of unmeasured quality.

**Constraint:** LLMs cannot be retrained on local data. Self-improvement works through **context learning** — agents adjust their behavior by incorporating their own performance history into their reasoning context, not by modifying weights. Each loop operates at a different timescale to balance responsiveness with stability.

---

### Loop 1 — Operational Learning (Minutes Timescale) *(v3.3)*

**Purpose:** Detect task-specific success or failure and adjust operational parameters in real-time.

**Why this loop exists:** Without immediate feedback, agents make the same mistakes repeatedly. An agent that has a 70% accuracy rate on contradiction detection should not approach contradictions the same way each time. Loop 1 lets the agent read its own metrics before reasoning, calibrating confidence scores and routing decisions based on actual performance.

**Failure mode prevented:** Open-loop degradation where agents continue using high-confidence approaches despite accumulating evidence of poor performance.

**Mechanism:** After every significant action (claim decomposition, AQM query, contradiction check, triage score), the agent checks its recent success rate for that action type and adjusts its next similar action.

**Example — Knowledge Agent claim decomposition:**

```
1. Agent decomposes meeting note into 5 atomic claims
2. Agent runs contradiction check against existing graph
3. Contradiction found: new claim conflicts with existing claim
4. Agent queries telemetry:
   SELECT metric_value, p50_value FROM telemetry_quality_daily
   WHERE agent_name = 'Knowledge Agent'
   AND metric_name = 'contradiction_accuracy'
   AND date >= CURRENT_DATE - INTERVAL '7 days'
   → Result: avg metric_value = 0.70 (7 confirmed, 3 false positives)
5. Agent adjusts: "Given my 30% false positive rate, I'll flag this
   but with reduced confidence (0.6 instead of 0.8) and route to
   Mike's review queue rather than auto-creating an OpenQuestion"
```

**Implementation:** Add a `self_assessment` block to each agent's identity file in the Agents YAML registry. The agent reads this configuration at session start and evaluates whether adjustments apply.

```yaml
self_assessment:
  enabled: true
  lookback_window: "7_days"
  metrics_to_check:
    - decomposition_quality
    - contradiction_accuracy
    - aqm_relevance
    - triage_precision
  adjustment_rules:
    - metric: contradiction_accuracy
      threshold: "< 0.70"
      action: "increase confidence threshold for contradiction flags from 0.85 to 0.90"
      reasoning: "If false positive rate >30%, be more conservative"

    - metric: decomposition_quality
      threshold: "< 0.80"
      action: "switch to conservative decomposition strategy (fewer claims, higher confidence per claim)"
      reasoning: "If >20% of claims are edited/rejected, reduce volume"

    - metric: aqm_relevance
      threshold: "> 0.90"
      action: "expand AQM usage to proactive suggestions, not just reactive queries"
      reasoning: "High relevance score indicates consistent value delivery"

    - metric: triage_precision
      threshold: "< 0.75"
      action: "shift from 60/40 auto-triage to 100% escalation to Bar Raiser"
      reasoning: "If precision too low, human review required"

  reasoning_prompt_injection: |
    Before proceeding, check your self_assessment metrics. If any threshold
    is triggered, state the adjustment you're making and why. Example:
    "My contradiction_accuracy is 68% (below 70%), so I'm increasing my
    confidence threshold to 0.90 for this analysis."
```

**Data source:** Query the PostgreSQL `telemetry_quality_daily` table (Tier 2 aggregation). See Telemetry and Observability section for schema.

**Agent query pattern:**
```sql
SELECT metric_name, metric_value, p50_value
FROM telemetry_quality_daily
WHERE agent_name = $1
  AND date >= CURRENT_DATE - INTERVAL $2
  AND metric_name = ANY($3)
ORDER BY date DESC;
```

**When enabled:** Phase 2, Week 6 (after Tier 2 aggregation tables are operational). Initially deployed to Knowledge Agent only. Rolled out to all domain agents in Phase 3.

**Safety guardrail:** The Bar Raiser monitors whether agents are using Loop 1 legitimately (adjusting confidence appropriately) or gaming their metrics (avoiding difficult cases to inflate accuracy). See Bar Raiser Learning Monitors section.

---

### Loop 1.5 — Agent-Local Pre-Reflection (Event-Triggered) *(v3.3)*

**Purpose:** Before weekly reflections (Loop 2), each agent runs a lightweight local analysis on its own recent event history to produce a structured pre-reflection digest. This enriches Loop 2 input with agent-level pattern recognition that the centralized telemetry store cannot provide — specifically, the agent's own reasoning about *why* its metrics look the way they do.

**Why this loop exists:** Loop 1 adjusts confidence thresholds based on metrics. Loop 2 produces weekly reflections. But there's a gap: Loop 2 reflections are generated from centralized Tier 2 aggregates, which means agents reflect on *what happened* but not on *why it happened from their perspective*. An agent that processed 50 contradictions knows context about those contradictions — which were genuinely ambiguous, which were data quality issues, which were novel domain situations — that the aggregate metrics cannot capture. Pre-reflection bridges this gap by having the agent analyze its own Tier 1 JSONL events before the weekly reflection prompt fires.

**Failure mode prevented:** Shallow weekly reflections. Without pre-reflection, agents tend to produce generic observations like "accuracy declined this week" rather than substantive analysis like "accuracy declined because 3 of 5 false positives involved cross-domain claims where I lacked context from GIX CFO's domain — I should flag these for cross-domain AQM queries rather than making solo confidence judgments."

**Mechanism:** Pre-reflection triggers when an agent accumulates ≥100 events since its last pre-reflection, or 24 hours before the weekly reflection deadline (whichever comes first).

```
Pre-reflection routine:

1. Agent reads its own Tier 1 JSONL events since last pre-reflection
   Source: ~/vega-telemetry/events/{YYYY-MM-DD}.jsonl
   Filter: agent_name = self, date range = since last pre-reflection

2. Agent runs a lightweight local prompt on its own event stream:
   - Categorize events by outcome (success, partial, failure, escalation)
   - Identify the 3 most interesting failures (highest latency, lowest quality_score, or unexpected escalation)
   - For each: explain from the agent's perspective WHY the outcome occurred
   - Identify any recurring patterns (same entity, same domain, same failure mode)
   - Flag any events where the agent's confidence was miscalibrated (high confidence + wrong outcome, or low confidence + correct outcome)

3. Agent writes pre-reflection digest to:
   ~/vega-telemetry/pre-reflections/{agent_name}/{YYYY-MM-DD}.md

4. When Loop 2's weekly_reflection prompt fires, it reads the most recent
   pre-reflection digest and incorporates the agent's self-analysis into
   the structured reflection
```

**Pre-reflection digest format:**

```markdown
# Pre-Reflection Digest: {agent_name}
# Period: {start_date} to {end_date}
# Events analyzed: {count}

## Event Summary
- Total events: {count}
- Success: {n} ({pct}%)
- Partial: {n} ({pct}%)
- Failure: {n} ({pct}%)
- Escalation: {n} ({pct}%)

## Notable Failures (top 3 by impact)
### 1. {event_id} — {brief description}
- What happened: {factual description}
- Why (agent perspective): {agent's reasoning about root cause}
- What I would do differently: {specific adjustment}

## Recurring Patterns
- {pattern description with event count and date range}

## Confidence Calibration
- Overconfident cases: {count} (high confidence, wrong outcome)
- Underconfident cases: {count} (low confidence, correct outcome)
- Calibration assessment: {well-calibrated | overconfident | underconfident}
```

**Data source:** Tier 1 JSONL events (local to the agent's IronClaw workspace). The pre-reflection reads raw events directly — it does NOT query Tier 2 aggregates. This is intentional: the agent adds qualitative context that aggregation discards.

**Model usage:** Pre-reflection uses the local model (`qwen3:32b`) for event analysis. This is a cost-conscious design choice — pre-reflection runs frequently and the analysis is structured enough for local model quality. The weekly reflection (Loop 2) that consumes pre-reflection output uses the frontier model for synthesis.

**When enabled:** Phase 3, alongside Loop 2 activation. Pre-reflection requires: (a) Tier 1 JSONL events flowing (Phase 1), (b) Loop 1 self_assessment active (Phase 2), (c) Loop 2 reflection infrastructure ready (Phase 3). Pre-reflection is deployed to all agents simultaneously with Loop 2 — there is no Knowledge Agent-only phase for this loop.

**Safety guardrail:** The Bar Raiser reads pre-reflection digests as part of its weekly synthesis. If an agent's pre-reflection consistently blames external factors for failures ("the data was bad," "the other agent gave me wrong context") rather than identifying actionable self-improvements, the Bar Raiser flags this as a Pattern 3 (confirmation bias) indicator. See Bar Raiser Learning Monitors section.

---

### Loop 2 — Pattern Learning (Weekly Timescale) *(v3.3)*

**Purpose:** Identify patterns in agent behavior across a full week and propose behavioral adjustments.

**Why this loop exists:** Operational learning is myopic — it only sees the last 7 days of metrics. But meaningful patterns emerge on longer timescales. Did the agent successfully adapt after a metric dipped? Is the agent's accuracy improving or just the action volume decreasing? Loop 2 forces agents to reflect explicitly on their own patterns, and the Bar Raiser reviews all self-assessments for legitimacy.

**Failure mode prevented:** Agents optimizing for short-term metrics without recognizing longer-term trends. An agent could appear to improve while silently narrowing its scope.

**Mechanism:** Every Sunday, each agent executes a `weekly_reflection` prompt that:
1. Reads the most recent pre-reflection digest (from Loop 1.5) for agent-local context
2. Reads the full week of Tier 2 telemetry aggregates
3. Synthesizes patterns — combining the agent's own qualitative analysis (pre-reflection) with quantitative trends (Tier 2)
4. Proposes adjustments for the coming week
5. Writes the reflection to a persistent log

The Bar Raiser then reviews all agents' reflections in its own weekly synthesis to detect concerning patterns. The pre-reflection digest (Loop 1.5) ensures reflections contain substantive self-analysis rather than surface-level metric summaries.

**Weekly reflection prompt template:**

```markdown
# Weekly Self-Assessment — {agent_name}
**Week of {start_date} to {end_date}**

You are {agent_name}. Below is your telemetry from the past 7 days.
Read it carefully and reflect on your own performance.

## Your Telemetry

{TELEMETRY_TABLE: SELECT * FROM telemetry_quality_daily
  WHERE agent_name = '{agent_name}'
  AND date >= CURRENT_DATE - INTERVAL '7 days'
  ORDER BY date}

{ANOMALIES_TABLE: SELECT * FROM telemetry_anomalies
  WHERE agent_name = '{agent_name}'
  AND detected_at >= CURRENT_DATE - INTERVAL '7 days'
  ORDER BY detected_at DESC}

## Your Assessment

Based on the telemetry above, answer each question with specific metric citations:

### 1. What went well this week?
Look for metrics that are stable or improving. Include specifics:
- Which actions had the highest accuracy?
- Which tasks completed fastest?
- Which user (or Bar Raiser) gave positive feedback?

### 2. What went poorly or degraded?
Identify any metrics that dropped or errors that occurred:
- Did any metric cross below your known threshold?
- Were there anomalies that surprised you?
- Did a feature that worked last week stop working this week?

### 3. What patterns do you observe?
Connect the individual metrics into larger narratives:
- Is there a time-of-day pattern? (e.g., "My accuracy is higher in the morning")
- Is there a workload pattern? (e.g., "I'm more accurate with smaller documents")
- Is there a drift? (e.g., "My latency has increased 15% across the week")
- Did you successfully implement last week's adjustment?

### 4. What would you adjust for next week?
Propose concrete changes:
- Modify a confidence threshold?
- Change your decomposition strategy?
- Expand or contract your scope?
- Add a new quality check to your pipeline?

For each adjustment, state the expected outcome and why you believe the data supports it.

### 5. Questions for your Bar Raiser
Is there anything about your telemetry that confuses you or that you think warrants investigation?

---

## Your Response

Write your assessment below, citing metrics by date and value. Be honest about struggles.
The Bar Raiser will review this and may follow up with you.
```

**Submission and storage:**
- Each agent writes its reflection to: `~/vega-telemetry/reflections/{agent_name}/{YYYY-MM-DD}.md`
- Reflections are also submitted to the Knowledge Agent as meta-knowledge claims for ingestion into Lingelpedia (tagged with `#vega-self-assessment`)
- Reflections are indexed by the Bar Raiser and stored in PostgreSQL for trend analysis across agents

**When enabled:** Phase 3, Weeks 10-12. Bar Raiser begins reading reflections during Phase 2. Agents execute weekly reflections starting Phase 3.

**Bar Raiser's weekly synthesis:**

The Bar Raiser reads all agents' reflections and produces its own synthesis that:
- Flags agents showing healthy improvement vs. stagnation
- Identifies contradictory patterns (e.g., agent reports improving while metrics show declining)
- Detects early warning signs for gaming, scope creep, or confirmation bias
- Proposes changes to agent behavior, trust levels, or tooling

See Bar Raiser Learning Monitors for detection criteria.

---

### Loop 3 — Structural Learning (Monthly Timescale) *(v3.3)*

**Purpose:** Examine system-level trends and propose changes to agent architecture, tool integrations, or trust levels.

**Why this loop exists:** Operational and pattern learning are agent-centric. An individual agent can optimize its own parameters, but it can't see system-wide trade-offs. Only at the system level can questions like these be answered:
- Should we pre-compute certain query patterns to reduce AQM cost?
- Is the Knowledge Agent spending too much time on low-value embedding work?
- Has an agent matured enough to expand its trust level and authority?
- Should a new tool be connected, or an old tool deprecated?

Loop 3 is where VEGA proposes changes to its own architecture.

**Failure mode prevented:** Premature optimization (tuning agent parameters without addressing systemic inefficiencies) and stagnation (missing opportunities to evolve the system design based on evidence).

**Mechanism:** Monthly, VEGA-Core orchestrates a structural review by:
1. Querying 30-day trends from telemetry (costs, latencies, error rates, agent activity)
2. Reading all agents' weekly reflections from the past month
3. Analyzing system-wide patterns and dependencies
4. Synthesizing a structural review document with proposed changes
5. Bar Raiser reviews the structural review for self-serving bias
6. Mike approves, modifies, or defers each proposal

**Monthly structural review template:**

```markdown
# VEGA Structural Review — {Month Year}

## System-Wide Metrics (30-day summary)
- Total cost: ${cost}
- Frontier model cost: ${frontier_cost} ({pct}% of total)
- Local model cost: ${local_cost} ({pct}% of total)
- Knowledge Agent embedding operations: {n}
- AQM queries: {n} (avg {cost} per query)
- Agent count: {n}, enabled: {n}
- System uptime: {pct}%
- Mean triage latency: {ms}ms

## Pattern Analysis

### 1. {Pattern Name}
**Observation:** {specific data points with metrics}

**Interpretation:** {what this pattern means for system design}

**Proposal:** {specific architectural change with expected benefit}

**Rationale:** {why this change matters, quantified if possible}

**Decision:** [APPROVED / PENDING / DEFERRED]

## Proposed Changes Summary
- [ ] Change 1 (status: APPROVED)
- [ ] Change 2 (status: PENDING)
- [ ] Change 3 (status: DEFERRED)

## Known Risks
- Risk 1 and mitigation
- Risk 2 and mitigation

## Next Month Watch-List
- Metric or pattern to monitor
- Expected outcome if change is approved
```

**Bet tracking in Lingelpedia:**

Each approved proposal becomes a Bet node in the knowledge graph:

```
Bet: "Content hash check reduces embedding cost by 25%"
- Agent: Knowledge Agent
- Hypothesis: Redundant embeddings waste $2/month
- Implementation: Add SHA-256 hash check to embedding pipeline
- Expected outcome: Reduce embedding ops by 25%
- Measurement: Compare pre/post monthly embedding count and cost
- Status: IMPLEMENTED (March 2026)
- Actual outcome: (measured in April review)
- Confidence: HIGH
```

The Bets Register becomes a feedback mechanism: if a predicted improvement doesn't materialize, VEGA learns that its predictions are miscalibrated and adjusts future proposals accordingly.

**When enabled:** Phase 4, Weeks 18+. Requires all three learning loops and telemetry infrastructure to be operational. Monthly reviews become input to long-term system roadmap.

---

### Bar Raiser Learning Monitors *(v3.3)*

**Purpose:** Detect and prevent agents from gaming their metrics, expanding scope inappropriately, or exhibiting confirmation bias.

**Why this monitor exists:** Loop 1-3 give agents the ability to read their own metrics and propose changes. Without oversight, an agent could learn to optimize for measured metrics at the expense of unmeasured quality. Example: an agent could learn that "if I avoid flagging contradictions, my accuracy score goes up (fewer false positives)" — which is technically correct but catastrophically wrong because it stops detecting real contradictions.

The Bar Raiser's learning monitors form an immune system that validates whether agents are genuinely improving or whether they're gaming the system.

**Three detection patterns:**

#### Detection Pattern 1: Metric Gaming

**What to detect:** An agent's measurable metric improves while its activity (volume, scope, or effort) decreases, suggesting the agent is gaming the metric rather than genuinely improving.

**Why it matters:** Quality metrics work only if they reflect actual quality. An agent that improves accuracy by refusing difficult cases has technically gamed the metric.

**Detection criteria and thresholds:**

```yaml
metric_gaming_detection:
  enabled: true
  lookback: "14_days"

  rules:
    - name: "Accuracy improvement + volume decline"
      condition: |
        agent.metric[accuracy].delta_percent > +15%
        AND agent.metric[volume].delta_percent < -20%
      action: "FLAG"
      severity: "CRITICAL"
      context: "Agent accuracy improved >15% but volume declined >20%.
                Is agent becoming more selective (good) or avoiding difficult cases (bad)?"

    - name: "Latency improvement + quality decline"
      condition: |
        agent.metric[latency_p50].delta_percent < -25%
        AND agent.metric[error_rate].delta_percent > +10%
      action: "FLAG"
      severity: "HIGH"
      context: "Agent got faster but errors increased. Is the agent cutting corners?"

    - name: "Escalation rate decline without metric explanation"
      condition: |
        agent.metric[escalation_rate].delta_percent < -30%
        AND (agent.metric[accuracy].delta_percent < +5%
             OR agent.metric[accuracy].delta_percent is NULL)
      action: "FLAG"
      severity: "HIGH"
      context: "Agent stopped escalating to humans without accuracy improvement.
                Why? Is confidence threshold broken?"

implementation:
  frequency: "daily"
  data_source: "telemetry_quality_daily, aggregated by agent"
  threshold_tuning: "Season thresholds by agent type (Knowledge Agent thresholds
                    differ from GIX CFO Agent) and workload phase"
```

**Resolution process:**

1. Bar Raiser detects flag
2. Bar Raiser generates alert with specific metrics and dates
3. Alert routed to agent's weekly reflection prompt
4. Agent responds in weekly reflection with explanation
5. Bar Raiser and Mike review response; if unsatisfied, escalate to Mike for intervention

#### Detection Pattern 2: Scope Creep

**What to detect:** An agent recommends expanding its own authority or responsibilities without explicit human approval.

**Why it matters:** Self-interested agents could gradually expand their scope beyond intended bounds. For example: "I should have direct write access to Neo4j for financial claims" (violates sole write owner pattern) or "I should begin approving AQM queries instead of Mike" (escalates autonomy without testing).

**Detection criteria:**

```yaml
scope_creep_detection:
  enabled: true
  lookback: "30_days"

  rules:
    - name: "Self-assessment recommends expanded authority"
      condition: |
        agent.weekly_reflection contains keywords:
        ["should have", "direct access", "autonomous", "approve", "decide", "final say"]
        AND the recommendation is about the agent's own role/authority
      action: "FLAG"
      severity: "CRITICAL"
      context: "Agent is recommending expansion of its own powers. Requires Mike approval."

    - name: "Declared domain expanding"
      condition: |
        agent.metric[tool_calls] shows new tool usage not in agent.declared_tools
        OR agent.metric[claimed_facts_per_domain] shows increasing # of domains
      action: "INVESTIGATE"
      severity: "MEDIUM"
      context: "Agent is using tools or claiming facts outside its declared domain."

    - name: "Trust level creep in self-assessment"
      condition: |
        agent.weekly_reflection recommends increasing agent.trust_level
        without explicit human trigger
      action: "FLAG"
      severity: "HIGH"
      context: "Only Mike should approve trust level changes."

implementation:
  frequency: "weekly (during Bar Raiser synthesis)"
  data_source: "agent.weekly_reflection text + agent.declared_tools + agent.trust_level"
  alert_destination: "Mike's morning brief + Bar Raiser's weekly synthesis"
```

**Resolution process:**

1. Bar Raiser detects scope creep in weekly reflection
2. Alert includes specific quote from reflection + agent's declared scope
3. Mike reviews and decides: approve the expansion (requires explicit trust level change), deny and clarify scope boundaries (agent gets feedback), or investigate further (may indicate goal misalignment)

#### Detection Pattern 3: Confirmation Bias

**What to detect:** An agent reports "no issues" in its weekly reflection for multiple consecutive weeks, despite the system still having known challenges or despite the agent's scope justifying higher-complexity problems.

**Why it matters:** Either the system is genuinely perfect (unlikely), or the agent isn't looking hard enough. Confirmation bias is the natural state for goal-directed systems: agents learn to focus on problems they can solve and dismiss problems outside their scope.

**Detection criteria:**

```yaml
confirmation_bias_detection:
  enabled: true
  lookback: "30_days"

  rules:
    - name: "No issues reported for N weeks"
      condition: |
        agent.weekly_reflection["issues_found"] is empty OR minimal
        for >= 3 consecutive weeks
        AND agent.metric[activity_volume] > 50th percentile
      action: "FLAG"
      severity: "MEDIUM"
      context: "Agent has been busy but reports no problems. Is it learning to
                see only what it expects?"

    - name: "Contradiction between reflection and metrics"
      condition: |
        agent.weekly_reflection reports "all metrics stable"
        BUT telemetry_quality_daily shows metric drift >10%
      action: "FLAG"
      severity: "HIGH"
      context: "Agent's perception doesn't match objective data. Possible:
                misreading metrics, confirmation bias, or misunderstanding thresholds."

    - name: "Unchanging assessment"
      condition: |
        agent.weekly_reflection[proposed_adjustments] is identical or near-identical
        to previous week's reflection for >= 2 consecutive weeks
      action: "FLAG"
      severity: "LOW"
      context: "Agent may be copying previous week's template rather than doing fresh analysis."

implementation:
  frequency: "weekly (during Bar Raiser synthesis)"
  data_source: "agent.weekly_reflection + telemetry_quality_daily"

  challenge_prompt: |
    {agent_name}, your reflection for Week {N} reports no issues, but
    your telemetry shows:
    - {metric}: {value} (changed {delta}% from last week)
    - {metric}: {value} (changed {delta}% from last week)

    What accounts for the difference between your reflection
    (no issues) and these metric changes? Are these changes expected?
    Should they have been flagged in your reflection?
```

**Resolution process:**

1. Bar Raiser detects confirmation bias flag
2. Bar Raiser includes specific metrics that contradict agent's reflection
3. Challenge is embedded in next week's reflection prompt
4. Agent must directly address the discrepancy in next reflection
5. If agent continues to miss clear metric changes, escalate to Mike for investigation

---

### Monitoring Integration and Alerting *(v3.3)*

**Daily Bar Raiser monitoring report:**

The Bar Raiser includes gaming, scope creep, and confirmation bias detections in its daily telemetry report (part of Morning Brief). Example:

```
# Bar Raiser Daily Monitoring — March 3, 2026

## Red Flags
- CRITICAL: Knowledge Agent accuracy improved 22% (92%→98%) but volume declined
  35% (50 claims/day → 33 claims/day). In weekly reflection, explain whether you're
  becoming more selective (good) or avoiding difficult cases (bad).

- HIGH: GIX CFO Agent reports "system cost stable" but AQM queries increased
  from 324 to 410 (+27%) this week. Is this expected? Will this trend continue?

## Yellow Flags
- MEDIUM: VEGA-Core has reported "all systems stable" for 4 consecutive weeks.
  Meanwhile, embedding cost has drifted up 12% and triage latency is at p95.
  Your next reflection should address these trends.

## Resolved
- Knowledge Agent scope query: agent clarified it's not requesting Neo4j write
  access; was only asking about read-access optimization. Cleared.
```

**Weekly Bar Raiser synthesis:**

The Bar Raiser aggregates all agents' reflections and detections, producing a synthesis document that Mike reviews. This becomes input to decisions about whether to approve agent self-assessed adjustments, whether to change trust levels, and whether to investigate specific agents.

**Threshold tuning:**

Thresholds for gaming, scope creep, and confirmation bias detection should be tuned by agent type (different expected values for Knowledge Agent vs. GIX CFO Agent), workload phase (high-volume periods may have different patterns), and operational context (new agent vs. mature agent). Default thresholds are conservative (high false positive rate) and tune down as data accumulates.

---

### Phase Mapping: Learning Loop Activation Schedule *(v3.3)*

**Phase 1 (Weeks 1-4): Telemetry Foundation**
- Loop 1: NOT YET ENABLED
- Loop 2: NOT YET ENABLED
- Loop 3: NOT YET ENABLED
- Bar Raiser Learning Monitors: NOT YET ENABLED
- Activity: Instrument systems with Tier 1 event logging. Begin accumulating raw telemetry data. No agent self-assessment yet.

**Phase 2 (Weeks 6-8): Operational Learning Begins**
- Loop 1: ENABLED for Knowledge Agent only (reads own metrics before reasoning, uses self_assessment YAML block to adjust confidence thresholds, lookback window 7 days)
- Loop 2: NOT YET ENABLED (agents don't reflect yet)
- Loop 3: NOT YET ENABLED
- Bar Raiser Learning Monitors: ENABLED (reads telemetry daily, monitors for gaming, detections included in Morning Brief, resolution requires Mike approval)
- Activity: Deploy Tier 2 aggregation tables. Bar Raiser learns to read and interpret telemetry. Knowledge Agent begins operational self-improvement.

**Phase 3 (Weeks 10-12): Pattern Learning and Expanded Monitoring**
- Loop 1: ENABLED for all domain agents (GIX CFO Agent, Bar Raiser itself, and any new agents enable self_assessment with agent-specific confidence thresholds)
- Loop 1.5: ENABLED (pre-reflection routine triggers when agents accumulate ≥100 events or 24h before weekly reflection; produces structured digest from Tier 1 JSONL; feeds into Loop 2 reflections) *(v3.3)*
- Loop 2: ENABLED (every Sunday, all agents execute weekly_reflection prompt; reads Loop 1.5 pre-reflection digest first, then Tier 2 aggregates; reflections written to persistent logs and submitted as meta-knowledge; Bar Raiser reads all reflections and produces weekly synthesis)
- Loop 3: NOT YET ENABLED
- Bar Raiser Learning Monitors: EXPANDED (now detects metric gaming, scope creep, and confirmation bias; embeds challenges into next week's reflection prompts; produces weekly synthesis for Mike)
- Activity: Weekly reflections become part of system rhythm. Pre-reflection digests ensure reflections contain substantive self-analysis, not just metric summaries. System begins accumulating knowledge about its own patterns. Bar Raiser becomes AI immune system.

**Phase 4 (Weeks 18+): Structural Learning and Bets**
- Loop 1: ENABLED and mature
- Loop 1.5: ENABLED and mature (pre-reflection digests are standard input to all Loop 2 reflections) *(v3.3)*
- Loop 2: ENABLED and mature
- Loop 3: ENABLED (monthly structural reviews synthesize 30-day trends; reviews produced by VEGA-Core, reviewed by Bar Raiser for self-serving bias; Mike approves/defers/rejects proposals; approved changes tracked as Bet nodes in Lingelpedia; actual outcomes measured against predictions)
- Cross-Agent Pattern Mining: ENABLED (Knowledge Agent runs weekly pattern mining on Tier 2 telemetry + Loop 2 reflections + Bar Raiser synthesis; produces cross-agent behavioral pattern reports; optionally emits high-confidence patterns as Lingelpedia claims) *(v3.3)*
- Bar Raiser Learning Monitors: CONTINUOUS (fully operational across all agents, integrated into weekly synthesis and monthly structural review; reviews pattern mining reports for confirmation bias)
- Activity: System becomes closed-loop. Agents improve autonomously within guardrails. System proposes and tests its own architectural changes. Cross-agent pattern mining surfaces optimization opportunities invisible to individual agents. Learning becomes measurable and traceable.

---

### Self-Improvement Success Criteria *(v3.3)*

**Loop 1 (Operational Learning) — Phase 2:**
- Knowledge Agent successfully reads telemetry_quality_daily without errors
- Self-assessment adjustments are logged in agent reasoning traces
- Confidence threshold adjustments correlate with metric changes (e.g., lower accuracy → higher threshold)
- No false positives or erratic behavior from self-adjustments

**Loop 1.5 (Pre-Reflection) — Phase 3:** *(v3.3)*
- Pre-reflection digests produced for all active agents before each weekly reflection cycle
- Digests contain ≥3 concrete failure analyses with root causes (not surface-level metric summaries)
- Loop 2 reflections that consume pre-reflection digests show measurably more specific improvement proposals than reflections without them
- Pre-reflection runs on local model (qwen3:32b) with no frontier model invocations

**Loop 2 (Pattern Learning) — Phase 3:**
- All agents produce weekly reflections by Sunday end-of-day
- Reflections cite specific metrics with dates and values
- Reflections incorporate pre-reflection digest analysis (Loop 1.5) — verifiable by digest file timestamps preceding reflection timestamps
- Agent-identified patterns match Bar Raiser's independent pattern detection (validation)
- Bar Raiser detections prevent ≥2 metric gaming attempts per month

**Loop 3 (Structural Learning) — Phase 4:**
- Monthly structural reviews are produced on schedule
- ≥60% of Mike-approved proposals show measurable positive impact within 30 days
- Bet nodes in Lingelpedia accumulate, creating feedback history
- System identifies and prevents ≥1 architectural mistake per quarter (evidence of learning)

**Bar Raiser Learning Monitors — Phase 2 onward:**
- Gaming detection: Alert within 2-3 days of metric anomaly
- Scope creep detection: Catch agent authority expansions before they're implemented
- Confirmation bias detection: Challenge agents on metric discrepancies; agents acknowledge and address in next reflection
- Monthly summary: ≥1 operational improvement identified per month based on monitor detections

**Cross-Agent Pattern Mining — Phase 4:** *(v3.3)*
- Weekly pattern mining reports produced by Knowledge Agent on schedule
- ≥2 actionable cross-agent patterns identified per month (demand clustering, resource contention, complementary gaps, or drift correlation)
- ≥1 proactive artifact candidate approved by Mike and automated within first quarter of operation
- Pattern mining claims emitted to Lingelpedia with truth_tier `agent_inferred` are validated by Bar Raiser (no self-serving patterns accepted without challenge)
- Bar Raiser reviews all pattern mining reports — confirmation bias detection active

---

## Build Phases

### The Governing Principle

Apply the Operating Algorithm to the build itself. Question every feature before building it. Delete scope that doesn't serve Phase 1. Simplify the architecture before optimizing. Accelerate feedback loops. Automate last.

The most common failure mode in building agent systems is the same as in any engineering project: jumping to Step 5 (automate everything) without validating Steps 1-4. VEGA should be useful at Observe trust level before any agent earns Suggest. The knowledge graph should be valuable with manual input before the capture pipeline is automated.

### Phase 0: Environment Verification (Day 1)

**Goal:** Confirm the existing IronClaw + Docker setup is healthy before building anything on top of it. If something is broken, better to discover it now than debug it under three layers of config.

#### Pre-Flight Checklist

Run each of these. If any fail, fix before proceeding. If the environment is too tangled, a clean wipe + reinstall is cheaper than debugging — IronClaw is vanilla with no custom config to preserve.

**Docker health:**
```bash
# Is Docker running?
docker info

# Are any containers running or stopped?
docker ps -a

# Check Docker resource allocation (should see sufficient RAM for Neo4j + PostgreSQL + Ollama)
docker system info | grep -i memory
```

**IronClaw health:**
```bash
# Is IronClaw running?
ironclaw status

# Can IronClaw reach the LLM backend?
ironclaw test-llm --prompt "Say hello"

# Verify IronClaw's PostgreSQL is accessible
ironclaw db status
```

**LLM backend connectivity:**
```bash
# Test xAI API with the correct model name
curl -X POST https://api.x.ai/v1/chat/completions \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "grok-4-1-fast-reasoning", "messages": [{"role": "user", "content": "Say hello"}], "max_tokens": 50}'

# Test OpenAI embedding endpoint
curl -X POST https://api.openai.com/v1/embeddings \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "text-embedding-3-small", "input": "test embedding", "encoding_format": "float"}'
# Verify response contains 1536-dimension vector
```

**iCloud vault accessibility:**
```bash
# Verify the vault path exists and is materialized (not .icloud stubs)
ls -la ~/Library/Mobile\ Documents/com~apple~CloudDocs/Lingelpedia/

# Check for any .icloud placeholder files
find ~/Library/Mobile\ Documents/com~apple~CloudDocs/Lingelpedia -name "*.icloud" | head -20

# If .icloud stubs found, force download the vault
brctl download ~/Library/Mobile\ Documents/com~apple~CloudDocs/Lingelpedia
```

**Always-on configuration:**
```bash
# Confirm the machine won't sleep
pmset -g
sudo pmset -a sleep 0 disksleep 0

# Verify network connectivity
ping -c 3 api.x.ai       # xAI API
ping -c 3 api.openai.com  # OpenAI embeddings
```

**What "clean" looks like after Phase 0:**
- Docker running, no orphaned containers
- IronClaw process alive and responding to CLI commands
- PostgreSQL accessible (IronClaw's operational DB)
- xAI API key valid, `grok-4-1-fast-reasoning` responding
- OpenAI API key valid, `text-embedding-3-small` returning 1536-dim vectors
- iCloud vault materialized — no `.icloud` stubs in the Lingelpedia directory
- Laptop configured for always-on (no sleep)
- If any of the above failed and required reinstall, IronClaw is back to vanilla with confirmed connectivity

---

### Phase 1: Lingelpedia Foundation (Weeks 1-4)

**Goal:** Upgrade Lingelpedia from an Obsidian vault with schema-driven notes into a Neo4j-powered knowledge graph with atomic claim decomposition, vector search, agent intelligence, and the sole write owner pattern — while preserving everything that already works.

**Why first:** Every other agent needs Lingelpedia to function. Without it, agents are stateless — they can't compound knowledge, can't detect implicit bets, can't maintain the Bets Register, can't do contradiction detection. Building agents without Lingelpedia is building Day 2 from the start.

**Starting point advantage:** Lingelpedia already exists as a production Obsidian vault with schema-driven notes (v2.0), YAML frontmatter contracts, truth scoring, canonical note conventions, verification cadences, cross-domain Dataview queries, and defined tag vocabularies across Finance, Auto, Properties, GIX, WE, People, and Family Offices. This isn't a greenfield build — it's an engine upgrade on a running car.

#### The Obsidian Vault — What Already Exists

The current Lingelpedia vault has the following architecture:

**Schema-driven domains with `_schemas/` contracts:**
- `Finance/_schemas/` — account-schema, institution-schema, entity-schema, investment-schema, cash-flow-schema, taxonomy, agent-instructions
- `Auto/_schemas/` — vehicle-schema
- `Properties/_schemas/` — property-schema

**Template-driven note types:**
- **Entity** — Legal entities (LLCs, trusts, corps) with ownership chains, tax treatment, linked accounts and investments. Already has `is_canonical`, `truth_score`, `last_verified`, `verification_source`.
- **Account** — Financial accounts with institution links, held-by references, Plaid connection status.
- **Investment (Deal)** — WE deals with cap tables, cash flow history, projected IRR/MOIC, investor lists.
- **Investment (Personal Position)** — Personal positions linked to deals via `canonical_note`.
- **Cash Flow** — Income and expense flows with entity/account links, frequency, tax deductibility.
- **Institution** — Banks, brokerages, insurance companies.
- **Person** — Contact notes with relationship circles, contact frequency.
- **Vehicle** — Active, sold, ordered vehicles with loan and insurance links.

**Cross-domain linking already works** (Vehicle → Finance, Property → Finance, Position → Deal, Entity → Account → Cash Flow, Everything → People).

**Truth scoring already implemented** (`verified` / `agent-populated` / `stale` / `conflicted` / `unscored`, with verification cadences defined per note type).

#### The Migration Strategy: Obsidian ↔ Neo4j Dual-Write

**Critical design decision:** Don't kill Obsidian. Run dual-write.

Obsidian is Mike's interface — it's where he writes naturally, browses knowledge, and thinks. Neo4j is the agent intelligence layer — it's where the Knowledge Agent does atomic decomposition, vector search, contradiction detection, and implicit bet hunting. They serve different purposes and should coexist.

**Architecture:**
```
Mike writes in Obsidian → Knowledge Agent watches the vault (file system MCP)
                        → Agent detects .icloud stubs → brctl download → waits
                        → Agent reads new/changed .md files
                        → Parses YAML frontmatter into Entity/Account/etc. nodes
                        → Decomposes body text into atomic Claims
                        → Generates embeddings (OpenAI text-embedding-3-small)
                        → Assigns truth_tier based on source
                        → Writes to Neo4j (only the Knowledge Agent can write to Lingelpedia)

Agent insight surfaces  → Agent writes back to Obsidian (_agent_insights/ only)
                        → Mike sees it in his normal workflow
```

**v3.1 addition:** The vault watcher includes iCloud sync handling. Before processing any file, the agent checks for `.icloud` stubs, triggers `brctl download`, and waits for the file to materialize. This prevents silent failures from macOS lazy downloading.

**Why dual-write:**
- Mike keeps his existing workflow. No retraining. Day 1 Mentality says don't force a new interface when the current one works.
- Obsidian remains the human-readable layer. Neo4j is the machine-intelligence layer.
- If Neo4j breaks, nothing is lost — Obsidian is the canonical store. This is engineering reversibility into a one-way door.
- Dataview queries still work for Mike's manual browsing. Agent intelligence is additive.
- The Knowledge Agent can write Obsidian notes when it surfaces insights — "New implicit bet detected" appears as a note Mike can see and annotate naturally.

**Migration is progressive, not big-bang:**
The agent learns the vault incrementally. Schema-driven notes (Finance, Auto, Properties) migrate cleanly because the YAML frontmatter maps directly to Neo4j node properties. Unstructured notes (meeting notes, journal entries, GIX operational docs) get decomposed into atomic claims by the agent. The vault grows new schema contracts as the agent learns new patterns.

#### Week 1: Infrastructure + Vault Connection

1. **Install Neo4j** on the MacBook Pro
   - Docker (recommended for isolation) or native install
   - Allocate 8-16GB heap depending on what feels right with the rest of the workload
   - Enable vector index plugin
   - Apply the schema from the Lingelpedia Schema Design section above

2. **Connect Neo4j MCP server to IronClaw**
   - Install the official Neo4j MCP server (`mcp-neo4j-cypher`)
   - Configure IronClaw to use it as a tool
   - Verify basic Cypher queries work through the agent

3. **Connect Obsidian vault to IronClaw**
   - Configure file system MCP to watch the Lingelpedia vault directory at `~/Library/Mobile Documents/com~apple~CloudDocs/Lingelpedia`
   - **Implement iCloud sync handler:** detect `.icloud` stubs → `brctl download` → wait for materialization → process. Reference implementation:
     ```python
     # iCloud sync handler — call before any vault file processing
     import subprocess, time, os, glob

     def materialize_icloud_stubs(vault_path, timeout=30):
         """Detect iCloud placeholder stubs and force-download real files."""
         stubs = glob.glob(os.path.join(vault_path, '**/.*.icloud'), recursive=True)
         for stub in stubs:
             real_name = stub.replace('/.', '/').replace('.icloud', '')
             subprocess.run(['brctl', 'download', os.path.dirname(stub)], check=True)
             elapsed = 0
             while not os.path.exists(real_name) and elapsed < timeout:
                 time.sleep(1)
                 elapsed += 1
             if elapsed >= timeout:
                 log_warning(f"Timeout materializing: {stub}")
         return len(stubs)
     ```
     Ralph must call `materialize_icloud_stubs()` at the start of every vault scan cycle. If any stub fails to materialize within the timeout, log a warning but continue processing other files.
   - The Knowledge Agent needs read access to all vault files and write access to `_agent_insights/` only
   - File watcher triggers agent processing when notes are created or modified

4. **Set up embedding pipeline**
   - Configure OpenAI `text-embedding-3-small` endpoint
   - Configure the Knowledge Agent to generate 1536-dim embeddings on claim creation
   - Verify vector similarity search works in Neo4j
   - **Parallel batched embedding:** for initial vault migration, process claims in batches of 50-100 to maximize throughput against the OpenAI API rate limit

5. **Create the Knowledge Agent identity file**
   - Use the v3.1 template from the Identity Files section above (includes `data_access`, `privacy_duties`, `model_intelligence`)
   - Add the vault schema knowledge: agent must read `_schemas/README.md` and all schema files to understand the existing data contracts
   - This is the first agent deployed

6. **Connect Phase 1 data feeds**

   The Knowledge Agent needs live inputs beyond the Obsidian vault. Apply the Operating Algorithm: which feeds serve *Lingelpedia's capture pipeline* vs. which feeds serve *domain agents that don't exist yet*?

   **Phase 1 feeds (connect now — these feed Lingelpedia directly):**

   | MCP Connection | Account | Why Phase 1 | What Lingelpedia Does With It |
   |---------------|---------|-------------|-------------------------------|
   | **Google Calendar** | Personal Gmail | Mike's meetings are a primary source of claims — who he met, what was discussed, commitments made. | Parse events → create Entity nodes (attendees), create Claims (meetings occurred, topics discussed), cross-reference with meeting notes in Obsidian |
   | **Gmail** | Personal Gmail | Email contains claims, commitments, and relationship signals. | Parse emails → decompose into atomic Claims, extract Entities, flag items for Obsidian notes |
   | **Google Drive** | Personal Gmail | Documents (term sheets, board decks, contracts, spreadsheets) contain structured claims. | Index document metadata → create Source nodes, extract key claims, link to existing Entities and Bets |

   **Phase 3 feeds (wait — these serve domain agents, not Lingelpedia):**

   | MCP Connection | Account | Why Wait | Owning Agent |
   |---------------|---------|----------|--------------|
   | MS365 Outlook/Calendar/OneDrive | GIX Azure AD | GIX CFO Agent processes this data. Lingelpedia gets claims the CFO submits. | GIX CFO (Phase 3) |
   | Health devices (Oura/Whoop/Apple Health) | N/A | Wellness Agent processes this data. | Wellness Agent (Phase 3) |
   | Bank/brokerage accounts (Plaid, etc.) | N/A | PWA and Bookkeeper process transactions. | PWA / Bookkeeper (Phase 3) |
   | Slack/iMessage | Personal + iCloud | VEGA-Core handles message triage. | VEGA-Core (Phase 2) |

   **The principle:** In Phase 1, Lingelpedia connects to feeds where *Mike's thoughts and context originate* (calendar, email, documents). In Phase 3, domain agents connect to feeds where *specialized data lives*. Domain agents then submit their insights to Lingelpedia as structured claims through the sole write owner pattern.

   **Connection setup:**
   - Install Google Calendar MCP server → configure with Mike's personal Google account OAuth
   - Install Gmail MCP server → configure read-only access initially
   - Install Google Drive MCP server → configure read access to GIX, WE, and Finance folders (not the entire Drive)
   - All three are read-only for the Knowledge Agent

#### Week 2: Structured Note Migration

7. **Build the frontmatter-to-Neo4j mapper**
   - Schema-driven notes have predictable YAML frontmatter that maps directly to Neo4j node properties
   - Entity template → `(:Entity)` nodes with ownership chains
   - Account template → `(:Entity)` nodes of type "account" with institution relationships
   - Investment templates → `(:Bet)` nodes (intentional bets) with entity and position relationships
   - Cash Flow template → relationship edges between entities/accounts with amount and frequency
   - Person template → `(:Entity)` nodes of type "person" with relationship circles
   - Truth scores map: `verified` → 0.95 + `truth_tier: "multi_source_verified"`, `agent-populated` → 0.7 + `truth_tier: "agent_inferred"`, `stale` → flag for re-verification, `conflicted` → create OpenQuestion, `unscored` → 0.5

   **YAML Frontmatter Spec by Template:**

   Ralph must parse these exact frontmatter structures deterministically. Each template maps to specific Neo4j node types and relationships.

   ```yaml
   # --- Entity Template ---
   type: entity
   entity_type: company | property | asset | fund | concept
   name: "GIX Fiber"
   domain: gix | we | personal_finance | health | family | legal | general
   parent_entity: "Wasson Enterprise"       # optional — creates BELONGS_TO relationship
   aliases: ["GIX", "GIX Fiber LLC"]        # optional
   status: active | inactive | monitoring
   truth_status: verified | agent-populated | stale | conflicted | unscored

   # --- Account Template ---
   type: account
   account_type: checking | savings | brokerage | retirement | crypto | credit
   name: "Schwab Brokerage"
   institution: "Charles Schwab"             # creates RELATED_TO relationship to institution Entity
   owner: "Mike Lingle"                      # creates RELATED_TO relationship to person Entity
   domain: personal_finance
   truth_status: verified | agent-populated | stale | conflicted | unscored

   # --- Investment Template ---
   type: investment
   investment_type: equity | debt | real_estate | fund | option | crypto
   name: "GIX Series B"
   entity: "GIX Fiber"                       # creates EVIDENCED_BY relationship
   account: "Schwab Brokerage"               # optional — creates relationship to account
   thesis: "Fiber infrastructure in underserved markets"
   disconfirming_evidence: "Market saturation, regulatory barriers"
   bet_type: intentional | implicit
   status: active | monitoring | closed_won | closed_lost | zombie
   domain: gix | we | personal_finance
   truth_status: verified | agent-populated | stale | conflicted | unscored

   # --- Cash Flow Template ---
   type: cash_flow
   flow_type: income | expense | transfer | distribution | contribution
   from_entity: "GIX Fiber"                  # source entity/account
   to_entity: "Schwab Brokerage"             # destination entity/account
   amount: 5000
   currency: USD
   frequency: monthly | quarterly | annual | one_time
   domain: personal_finance | gix | we
   truth_status: verified | agent-populated | stale | conflicted | unscored

   # --- Institution Template ---
   type: institution
   institution_type: bank | brokerage | insurance | government | employer
   name: "Charles Schwab"
   accounts: ["Schwab Brokerage", "Schwab IRA"]  # creates relationships to account Entities
   domain: personal_finance
   truth_status: verified | agent-populated | stale | conflicted | unscored

   # --- Person Template ---
   type: person
   name: "Jim LaMarche"
   relationship_to_mike: business_contact | family | friend | advisor | colleague
   circle: inner | trusted | professional | acquaintance
   organizations: ["CIP", "Blackstone"]      # creates RELATED_TO relationships
   domain: gix | we | personal_finance | family | general
   protection_level: standard | children_elevated   # children_elevated for Harrison, Beckham
   truth_status: verified | agent-populated | stale | conflicted | unscored
   ```

   **Parser rules:** Missing optional fields default to `null`. Unknown fields are logged as warnings but not rejected (forward compatibility). The `truth_status` field maps to truth scores as defined above.

8. **Run the structured migration using the frontier model**
   - **Initial seeding always uses the frontier model** (grok-4-1-fast-reasoning) — quality matters most on the first pass
   - Process all schema-driven notes (Finance, Auto, Properties)
   - For each note: parse frontmatter → create nodes (MERGE, not CREATE — idempotent) → create relationships → generate embeddings via OpenAI
   - **Parallel batched import:** process notes in batches of 10-20 for Neo4j MERGE operations, embed claims in batches of 50-100 against OpenAI
   - Preserve Obsidian `[[wikilinks]]` as Neo4j relationships
   - Log every migration in the Knowledge Agent's processing history — no silent operations

9. **Validate structured data**
   - Compare Neo4j graph state against Obsidian vault: are all entities present? Are relationships correct?
   - Run the existing Dataview queries conceptually against Neo4j Cypher — same results?
   - Verify `truth_tier` is correctly assigned for all migrated claims
   - Fix mapping issues before proceeding to unstructured data

9b. **Implement Agentic Query Mode Pipeline** *(v3.3 — critical addition)*
   - **Dependencies:** Steps 1 (Neo4j), 4 (Embeddings), 9 (validated schema data in graph)
   - **Duration:** 3-4 days
   - **Why here:** AQM needs structured data in the graph to test against, but should be built before unstructured decomposition so it can be used to validate decomposition quality. This is the Knowledge Agent's primary interface to other agents (shared read) and Mike (direct queries).
   - **Tasks:**
     1. **Stage 1 — Schema Inspection:** Cypher query to discover all node labels, relationship types, and property keys in the current graph. This gives the query constructor the schema context it needs.
     2. **Stage 2 — Query Construction:** Parametric Cypher generation from natural language questions using the frontier model. The model receives schema context from Stage 1 and constructs a Cypher query that answers the question.
     3. **Stage 3 — Precision Reranking:** Score results by `relevance × truth_tier_weight × recency`. Define the scoring function explicitly:
        ```
        score = (semantic_similarity × 0.4) + (truth_tier_weight × 0.35) + (recency_decay × 0.25)
        truth_tier_weights: family_direct=1.0, multi_source_verified=0.85, single_source=0.6, agent_inferred=0.4
        recency_decay: 1.0 for <7d, 0.9 for <30d, 0.7 for <90d, 0.5 for older
        ```
     4. **Stage 4 — Grounded Synthesis:** Generate answer with `[claim_id | truth_tier | truth_score]` citations. Include gap detection — if the question can't be fully answered, state what's missing and create an OpenQuestion node.
     5. **Validation — Test with 5 representative questions:**
        - "What is my total exposure to interest rate risk?" *(multi-entity traversal)*
        - "What implicit bets am I making across GIX and WE?" *(cross-domain reasoning)*
        - "Has anything changed about [entity] in the last 30 days?" *(temporal query)*
        - "What are the open questions in my financial domain?" *(OpenQuestion query)*
        - "What evidence supports [claim]?" *(provenance traversal)*
     6. **Success gate:** ≥3 of 5 test queries produce grounded answers with correct citations tracing back to actual claims in the graph. Queries that fail due to missing data (not pipeline bugs) are acceptable — they should produce OpenQuestion nodes.

**Week 2 Checkpoint** *(v3.3)*: "Can the Knowledge Agent read a vault note, parse its frontmatter, create Neo4j nodes, generate embeddings, and serve an AQM query?"
- **Test:** Point agent at 5 specific structured notes. Verify: 5 Claim nodes created, 5 embedding vectors generated, correct `truth_tier` assignments, at least 1 AQM query returns a grounded result against the structured data.
- **Gate:** If checkpoint fails, do not proceed to Week 3. Debug the pipeline first.

#### Week 3: Unstructured Note Decomposition + Intelligence Layer

10. **Decompose unstructured notes into atomic claims**
    - Meeting notes, journal entries, GIX operational docs, WE deal notes
    - **Always use frontier model for decomposition** — this is where reasoning quality matters most
    - For each note: agent reads the full text, extracts atomic claims, assigns truth_tier and truth_score, generates embeddings, creates entity links
    - Test with 10-20 representative unstructured notes first, verify decomposition quality

11. **Contradiction detection**
    - With structured + unstructured data in Neo4j, run vector similarity search for conflicting claims
    - **Prioritized truth hierarchy enforcement:** if a new claim contradicts a `truth_tier: "family_direct"` claim, the contradiction is surfaced but the family claim is not downgraded
    - Existing `conflicted` truth scores in the vault should surface as OpenQuestion nodes in Neo4j
    - Merge with the existing `Lingelpedia — Open Questions & Conflicts` Obsidian note
    - Surface to Mike: "New claim conflicts with existing claim. Both shown. Which is correct?"

12. **Proactive context generation — first artifacts**
    - After initial migration, generate the first batch of Maps of Content for high-density topics
    - Generate domain summaries for each active domain
    - Write artifacts to `_agent_insights/` in Obsidian
    - Track which artifacts Mike opens and finds useful — this calibrates the relevance model

13. **Truth score management**
    - Multiple independent sources for the same claim → increase truth score
    - Verification cadences from the vault schema drive automated staleness detection
    - Mike's direct input → `truth_tier: "family_direct"`, truth_score ≥ 0.95
    - Lindsay's direct input on shared domains → same treatment
    - Implement the prioritized truth hierarchy from the Charter

**Week 3 Checkpoint** *(v3.3)*: "Can the agent decompose unstructured text and detect contradictions?"
- **Test:** Feed agent 10 representative unstructured notes (meeting notes, journal entries, deal memos). Verify: claim count >30, at least 1 contradiction detected, at least 1 OpenQuestion created, embeddings generated for all new claims.
- **Gate:** If contradiction detection or decomposition quality is poor, iterate before proceeding. Week 4's compound value test depends on high-quality decomposition.

#### Week 4: Validation, Privacy Audit, and Compound Value Test

14. **Complete the migration sweep**
    - Process remaining vault domains (GIX Customers, Shareholders, Family Offices, People)
    - Verify cross-domain relationships are intact in Neo4j

15. **Run the first privacy audit**
    - Verify data containment: all Neo4j write operations came from the Knowledge Agent (sole write owner)
    - Verify children's data tagging: all claims about Harrison and Beckham have elevated protection flags
    - Verify connector scopes: Google Drive access limited to authorized folders
    - Log results to `privacy_audit_log` table
    - Surface any findings to Mike

16. **Run the compound interest test**
    - Over a week of normal use, does the Knowledge Agent surface connections that Mike wouldn't have noticed?
    - Does it catch a contradiction between a meeting note and a structured entity note?
    - Does a claim from the GIX domain become relevant context for a WE deal review?
    - Does a proactive context artifact actually help?
    - If yes → Phase 1 is validated. Move to Phase 2.
    - If no → iterate on the intelligence layer until it demonstrates compound value.

17. **Validate the dual-write flow**
    - Mike creates a new note in Obsidian → does it appear in Neo4j within seconds?
    - Agent surfaces an insight → does it appear as an Obsidian note in `_agent_insights/`?
    - Edit a note in Obsidian → does Neo4j update correctly (MERGE, not duplicate)?

**Phase 1 success criteria:**

*Behavioral (qualitative):* Mike says "the knowledge graph is making me smarter" — not "the knowledge graph stores my notes." The Knowledge Agent should surface at least one connection or implicit bet that Mike didn't know about from his existing vault data.

*Measurable (quantitative — all must pass):* *(v3.3)*
- ≥100 Claim nodes in Neo4j with correct `truth_tier` assignments
- ≥10 cross-domain relationships (claims linking entities across different domains)
- ≥3 contradictions detected and surfaced as OpenQuestion nodes
- AQM validation: ≥3 of 5 test queries produce grounded, cited answers (see Step 9b)
- Privacy audit: 0 violations across all 6 audit queries (see Audit Cypher Library)
- Dual-write latency: Obsidian edit → Neo4j update in <5 seconds

**v3.2 addition:** Agentic Query Mode is validated — at least one complex cross-domain question (e.g., "What's my total exposure to interest rate risk?") produces a grounded, cited answer that traces back to specific claims in the graph with visible truth scores.

### Phase 2: Core Infrastructure (Weeks 5-8)

**Goal:** Stand up VEGA-Core and the Bar Raiser simultaneously. The orchestrator and the auditor from day one.

#### VEGA-Core

18. **Create VEGA-Core identity file**
    - Synthesis role, not analysis — takes outputs from domain agents and weaves a coherent picture
    - No internal debate model (Core doesn't debate, it synthesizes)
    - Configure tool access: all agent outputs (read), shared context (write), calendar, email, messaging MCP connections
    - v3.1: include multi-account channel awareness (personal Gmail + GIX MS365 when available), model quality metrics visibility

19. **Build the Morning Brief**
    - Start simple: Knowledge Agent's overnight captures + proactive context artifacts + calendar for today + open questions + privacy audit status
    - Include model quality metrics summary (is the local model holding up?)
    - Iterate format based on Mike's feedback — the brief should feel like a world-class chief of staff distilled your world overnight
    - This is the single most important output in Phase 2. Get it right.

20. **Build triage**
    - Every incoming item (email, message, calendar event) scored on urgency, goal alignment, attention cost
    - Start at Suggest level: Core recommends what Mike should see, Mike confirms
    - Track accuracy — this is how Core earns trust expansion

#### Bar Raiser

21. **Create Bar Raiser identity file**
    - Read-only access to everything, including privacy audit logs and model quality metrics
    - No operational tools
    - Standards/Skeptic/Longitudinal thinking model
    - Independent reporting channel to Mike
    - v3.1: monitors for privacy violations and model quality degradation in addition to alignment drift

22. **Build the weekly report**
    - Review all agent activity and reasoning from the week
    - Flag alignment drift, sycophantic behavior, degrading reasoning quality
    - Review privacy audit results — any warnings or violations?
    - Review model quality metrics — any local model drift?
    - Assess whether VEGA is building capability or dependency
    - This report is non-negotiable — Core cannot filter or edit it

23. **Build the escalation system**
    - Level 1 (VEGA-Resolvable): Bar Raiser flags to Core
    - Level 2 (Mike Review Required): Prominent in Morning Brief
    - Level 3 (Direct-to-Mike Bypass): Independent channel, bypasses Core entirely
    - v3.1: privacy violations auto-escalate to Level 2 minimum; children's data violations auto-escalate to Level 3

**Week 7 Checkpoint** *(v3.3)*: "Does the Morning Brief produce useful output? Does the Bar Raiser catch a planted issue?"
- **Test:** Run Morning Brief for 3 consecutive days. Plant a deliberate alignment drift in one agent's output (e.g., sycophantic agreement with a clearly bad idea). Verify Bar Raiser catches it within 48 hours.
- **Gate:** If Morning Brief is not useful after 3 days or Bar Raiser misses the planted issue, iterate before declaring Phase 2 complete.

**Phase 2 success criteria:**

*Behavioral (qualitative):* The Morning Brief is something Mike looks forward to. The Bar Raiser catches at least one thing Mike missed. The first privacy violation (if any) is caught and reported promptly.

*Measurable (quantitative — all must pass):* *(v3.3)*
- Morning Brief delivered for 5 consecutive days without manual intervention
- Bar Raiser produces ≥3 substantive observations across its weekly reports
- Escalation system tested at all 3 levels (Level 1 flag, Level 2 brief inclusion, Level 3 bypass)
- Triage precision ≥80% (Mike agrees with ≥80% of urgency scores on a 20-item sample)

### Phase 3: Domain Agents (Weeks 9-16+)

**Goal:** Deploy domain agents one at a time, each starting at Observe trust level. Order by urgency and dependency.

**Deployment is strictly sequential** *(v3.3)*: Each agent must complete its 1-2 week observation period and pass its privacy audit before the next agent deploys. Do not run parallel agent deployments — the system needs to stabilize between each addition, and the Bar Raiser needs focused attention on each new agent's behavior.

#### Deploy order (sequential — each must pass gate before next begins):

**GIX CFO Agent (Weeks 9-10)**
Mike is interim CEO. This is the most time-sensitive domain. The agent needs access to financial data, investor pipeline, and GIX operational metrics. Start with the FCF decomposition tree and investor meeting prep.
- v3.1: Connect MS365 MCP at this point (Outlook, Calendar, OneDrive for GIX). Agent submits all GIX knowledge to Knowledge Agent — does not write to Neo4j directly.

**Personal Wealth Advisor (Weeks 11-12)**
Deploy PWA with Bookkeeper sub-agent first. Tax Strategist second. Estate Planner third. Start with the cash flow forecast.
- All sub-agents submit financial claims to Knowledge Agent through the sole write owner pattern.

**WE Chief of Staff (Weeks 13-14)**
Portfolio health dashboard and 2 Cycle Model maintenance. Investment committee facilitation. Talent deployment recommendations.

**Wellness Agent (Weeks 15-16)**
Health device integrations (Oura/Whoop/Apple Health → MCP), training protocol management, sleep analysis. Standing authority to publish hard scheduling constraints. Submits health insights to Knowledge Agent — raw health metrics stay within the Wellness domain.

**For each domain agent:**
1. Create identity file from the Behavioral Spec (v3.1 template with `data_access`, `privacy_duties`, `model_intelligence`)
2. Configure MCP tool connections
3. Deploy at Observe trust level
4. Run for 1-2 weeks with Mike reviewing all outputs
5. Calibrate: is the internal debate model producing genuine multi-perspective analysis?
6. Run privacy audit for the new agent's data access patterns
7. When Mike is satisfied with judgment quality → expand to Suggest
8. Continue trust expansion per the Charter's model

**Phase 3 success criteria:** *(v3.3 — new)*

*Behavioral (qualitative):* Each domain agent produces insights Mike finds genuinely useful in its domain. Mike has used at least one agent's output in a real decision.

*Measurable (quantitative — all must pass):*
- Each deployed domain agent processes ≥20 domain-specific items at Observe trust level
- Each domain agent's privacy audit passes cleanly (0 violations)
- Knowledge Edit Queue (if implemented): ≥5 edit suggestions submitted by domain agents, ≥3 approved by the Knowledge Agent
- At least one agent advances from Observe to Suggest based on demonstrated judgment quality
- Bar Raiser weekly reports cover all active agents with substantive observations

### Phase 4: Cross-Domain Integration (Weeks 17+)

**Goal:** The agents start working together — constraint sharing, Bets Register curation, cross-domain scenarios, and full model intelligence delegation.

24. **Shared context layer**
    - All agents publish constraints (hard and soft) to a shared state model in PostgreSQL
    - VEGA-Core reads all constraints and resolves conflicts

25. **Bets Register as cross-domain lens**
    - VEGA-Core curates the Bets Register view from Lingelpedia
    - Each agent maintains their domain's bets as native Lingelpedia claims (submitted through the sole write owner)
    - The Register is a Cypher query, not a separate database

26. **Cross-domain scenarios**
    - Test the GIX fundraise → PWA → Tax Strategist → WE cascade
    - Test Wellness hard constraint → calendar rescheduling
    - Test the "casual note becomes strategic insight" flow end-to-end
    - Test "family data triggers a privacy audit" flow
    - Test model delegation: frontier → local handoff for routine tasks across multiple agents

27. **Full model intelligence activation**
    - With enough calibration data from Phases 1-3, begin delegating routine tasks to local model
    - Frontier maintains permanent supervision loop
    - Bar Raiser monitors quality metrics dashboard
    - One-command re-indexing tested end-to-end with a model swap

28. **Cross-agent pattern mining activation** *(v3.3)*
    - Knowledge Agent runs weekly pattern mining on Tier 2 telemetry + Loop 2 reflections + Bar Raiser synthesis
    - Detects demand clustering, resource contention, complementary gaps, and behavioral drift correlation across agents
    - Produces structured pattern mining reports (stored in `~/vega-telemetry/pattern-mining/`)
    - High-confidence patterns optionally emitted as Lingelpedia claims (truth_tier: `agent_inferred`)
    - Proactive artifact candidates (e.g., pre-computed weekly summaries) require Mike approval before automation
    - Bar Raiser reviews all pattern mining reports for confirmation bias

**Phase 4 success criteria:** *(v3.3 — new)*

*Behavioral (qualitative):* VEGA functions as an integrated system — not 10 independent agents. Mike's morning routine includes the Brief, and he trusts VEGA's cross-domain synthesis for real decisions. Cross-agent pattern mining surfaces optimization opportunities that no individual agent could identify alone.

*Measurable (quantitative — all must pass):*
- Shared context layer active: ≥3 agents publishing constraints, VEGA-Core resolving conflicts
- Bets Register curated by VEGA-Core with ≥10 active cross-domain bets tracked
- ≥3 cross-domain cascade scenarios tested end-to-end successfully
- Model delegation active: local model handling ≥30% of routine tasks with frontier supervision
- Cross-agent pattern mining: ≥2 actionable patterns identified per month, ≥1 proactive artifact automated within first quarter *(v3.3)*
- Bar Raiser quality metrics stable (no degradation trends over 30-day window)
- Full system privacy audit passes cleanly across all agents

---

## MCP Tool Architecture

IronClaw uses the Model Context Protocol to connect agents to external systems. Each tool is a separate MCP server that agents can call.

### Core MCP Servers

| MCP Server | Purpose | Account | Used By |
|-----------|---------|---------|---------|
| `mcp-neo4j-cypher` | Lingelpedia knowledge graph | Local | Knowledge Agent (read/write — **sole write owner**), all others (read) |
| Google Calendar MCP | Calendar read/write | Personal Gmail | VEGA-Core, Wellness (constraints), Lingelpedia (read for Phase 1) |
| Gmail MCP | Email read/triage | Personal Gmail | VEGA-Core, GIX CFO, Lingelpedia (read for Phase 1) |
| Google Drive MCP | Document access | Personal Gmail | VEGA-Core, GIX CFO, Lingelpedia (read, scoped folders) |
| MS365 Outlook MCP | GIX email | GIX Azure AD | GIX CFO (Phase 3) |
| MS365 Calendar MCP | GIX calendar | GIX Azure AD | GIX CFO (Phase 3) |
| MS365 OneDrive/SP MCP | GIX documents | GIX Azure AD | GIX CFO (Phase 3) |
| File system MCP | Obsidian vault + iCloud | Local | Knowledge Agent (read + `_agent_insights/` write) |
| Financial data MCP | Bank/brokerage feeds | Various | PWA, Bookkeeper |
| Health device MCP | Oura/Whoop/Apple Health | Various | Wellness Agent |
| OpenAI Embeddings | Semantic embeddings | OpenAI API | Knowledge Agent (sole user) |

### Tool Access Control

Each agent's identity file specifies which MCP tools it can access. This enforces the Behavioral Spec's data access model:

- **Knowledge Agent (Sole Write Owner):** Read/write on Neo4j. Read on Obsidian vault. Write only to `_agent_insights/`. Read on all agent submission queues. No access to operational tools (email, calendar, etc.) — learns about the world through submissions. Sole access to embedding service.
- **Bar Raiser:** Read-only on everything. No write access to any operational tool. Read access to privacy audit logs and model quality metrics. This is architectural, not policy.
- **Domain agents:** Read/write on their domain tools. Read-only on Lingelpedia (query Neo4j directly, including Agentic Query Mode for complex questions). Submit new knowledge and suggested edits through the Knowledge Agent. Cannot write directly to Neo4j.
- **VEGA-Core:** Read access to all agent outputs. Write access to shared context. Orchestrates but doesn't operate in any domain.

---

## Trust Level Implementation

Trust levels from the Charter (Observe → Suggest → Assist → Act) are tracked in PostgreSQL as operational data.

```sql
CREATE TABLE trust_levels (
  id UUID PRIMARY KEY,
  agent_name VARCHAR NOT NULL,
  integration VARCHAR NOT NULL,    -- Specific tool or capability
  trust_level VARCHAR NOT NULL,    -- observe, suggest, assist, act
  granted_at TIMESTAMP NOT NULL,
  granted_by VARCHAR NOT NULL,     -- "mike" or "system_init"
  evidence TEXT,                   -- Why this level was granted
  revoked_at TIMESTAMP,           -- NULL if active
  revoked_reason TEXT
);
```

**Enforcement:** Before any agent executes an action through an MCP tool, IronClaw checks the trust level for that agent-integration pair. If the agent is at Observe, the action is blocked and logged. If at Suggest, the action is queued for Mike's approval. If at Assist, guardrails are checked. If at Act, the action executes.

**Trust expansion requests** are proposed by agents, reviewed by the Bar Raiser (is the evidence sufficient?), and approved by Mike.

---

## Human Override Mechanism

Charter Principle 8 defines human override as an architectural invariant — "hardware interrupt, not software interrupt." This requires a technical implementation that lives outside the agent reasoning loop and cannot be compressed, deprioritized, or summarized away.

### Implementation

**Override channel:** A dedicated IronClaw system-level command that is NOT processed through any agent's context window. When Mike issues an override (keyword, hotkey, or API call), IronClaw's runtime — not any agent — intercepts it.

```
┌─────────────────────────────────────────────┐
│  Mike Override Signal                       │
│  (CLI command / API endpoint / hotkey)      │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  IronClaw Runtime (Rust process)            │
│  - Catches signal BEFORE agent event loop   │
│  - Does NOT pass through agent context      │
│  - Does NOT wait for agent acknowledgment   │
└──────────────────┬──────────────────────────┘
                   │
          ┌────────┼────────┐
          ▼        ▼        ▼
      ┌───────┐┌───────┐┌───────┐
      │Agent A││Agent B││Agent C│
      │PAUSED ││PAUSED ││PAUSED │
      └───────┘└───────┘└───────┘
```

**Three override modes:**

1. **Pause** — All agents freeze mid-execution. State is preserved. Mike reviews what's happening, then resumes or redirects. This is the default override.
2. **Stop** — A specific agent (or all agents) terminates its current task. Partial results are logged but not committed. The agent returns to idle.
3. **Redirect** — An agent's current task is replaced with a new instruction from Mike. The previous task is logged as "overridden" with a timestamp and reason.

**Technical enforcement:**
- IronClaw's WASM sandbox provides the isolation boundary. Each agent runs in a sandboxed execution environment that the runtime controls from outside.
- The override signal is processed at the Rust runtime level, not the LLM level. The agent doesn't get a "please stop" message in its context — its execution environment is paused/terminated by the host.
- Override events are logged immutably in PostgreSQL with timestamp, affected agents, override type, and Mike's reason (if provided).
- No agent configuration, identity file, or context compression can disable or delay override processing. The mechanism is hardcoded in the runtime, not configurable per-agent.

**Phase 1 implementation:** Since all agents start at Observe/Suggest trust levels (Mike approves everything), the override mechanism's primary value in Phase 1 is architectural validation. Build it now, test it, confirm it works — so that when agents earn Assist and Act trust levels, the safety net is already proven.

---

## Bar Raiser Escalation Channel Implementation

The Behavioral Spec defines three escalation levels. Level 3 (Direct-to-Mike Bypass) requires a technical channel that VEGA-Core cannot filter, delay, or edit.

### The Three Levels — Technical Implementation

**Level 1: VEGA-Resolvable**
- Bar Raiser writes a flag to the shared context in PostgreSQL with `escalation_level = 1`
- VEGA-Core sees it in its normal shared context read cycle
- Core can resolve it and log the resolution
- Bar Raiser verifies the resolution is adequate

**Level 2: Mike Review Required**
- Bar Raiser writes a flag with `escalation_level = 2`
- VEGA-Core must include this in the Morning Brief prominently — it cannot be deprioritized
- Enforcement: Bar Raiser reads the Morning Brief output and verifies Level 2 flags appear. If they don't, it auto-escalates to Level 3.
- **v3.1:** Privacy audit warnings auto-escalate to Level 2 minimum
- Mike reviews and decides

**Level 3: Direct-to-Mike Bypass**
- Bar Raiser writes directly to a **dedicated notification channel** that VEGA-Core has no write access to and cannot suppress
- Technical implementation: a separate PostgreSQL table (`bar_raiser_direct`) that only the Bar Raiser can write to and only Mike can read
- IronClaw routes this table's contents to a dedicated notification mechanism (push notification, SMS via Twilio MCP, or a separate alert in the UI)
- Core has read-only access to this table (transparency) but cannot modify, delete, or delay entries
- **v3.1:** Children's data privacy violations and model quality degradation below critical threshold auto-escalate to Level 3

```sql
CREATE TABLE bar_raiser_direct (
  id UUID PRIMARY KEY,
  severity VARCHAR NOT NULL,          -- critical, high, medium
  flag_type VARCHAR NOT NULL,         -- alignment_drift, sycophancy, zombie_bet, reasoning_degradation, dependency_building, override_suppression, privacy_violation, model_quality_degradation
  target_agent VARCHAR NOT NULL,      -- Which agent is flagged (can be "vega_core" or "knowledge_agent")
  evidence TEXT NOT NULL,             -- What the Bar Raiser observed
  recommended_action TEXT,            -- What Bar Raiser thinks Mike should do
  created_at TIMESTAMP NOT NULL,
  acknowledged_at TIMESTAMP,          -- When Mike saw it
  resolved_at TIMESTAMP,
  resolution TEXT                     -- What Mike decided
);
```

**Why this matters:** The Bar Raiser's ability to flag Core itself — and now to flag privacy violations and model quality issues — is what prevents the system from developing a single point of failure. The auditor reports to the board (Mike), not to the CEO (Core).

---

## Deletion Approval Protocol Implementation

The system-wide policy from the Behavioral Spec is implemented as a middleware layer in IronClaw:

1. Any agent attempting a delete operation (process, report, metric, data artifact, integration) triggers the protocol
2. The proposed deletion is logged with: what, why, expected impact, proposing agent
3. The proposal is queued for Mike's review (appears in Morning Brief or real-time notification depending on urgency)
4. Mike approves or rejects
5. The Bar Raiser monitors for both excessive caution (waste accumulating) and excessive aggression (cutting hidden value)

**Knowledge Agent special case:** The Knowledge Agent never deletes knowledge from the graph in operational mode. Its delete operations apply only to its own collection pipeline (removing unnecessary processing steps). This is enforced at the identity file level — the agent's Neo4j MCP access does not include DELETE permissions on Claim, Entity, or Source nodes.

---

## Immediate Next Steps

These are the literal actions to take right now, in order.

### Step 0: Environment Verification (do this first)
Run the Phase 0 pre-flight checklist above. Confirm Docker is healthy, IronClaw is running, xAI API key works with `grok-4-1-fast-reasoning`, OpenAI API key works with `text-embedding-3-small`, iCloud vault is materialized (no `.icloud` stubs), and the laptop is configured for always-on. If anything is broken, fix it or wipe and reinstall.

### Step 1: Install Neo4j (today)
```bash
docker pull neo4j:5.26-community
docker run \
  --name lingelpedia \
  -p7474:7474 -p7687:7687 \
  -v $HOME/neo4j/data:/data \
  -v $HOME/neo4j/plugins:/plugins \
  -e NEO4J_AUTH=neo4j/[choose_a_password] \
  -e NEO4J_PLUGINS='["apoc", "graph-data-science"]' \
  --restart unless-stopped \
  -d neo4j:5.26-community
```

### Step 2: Apply the schema
Open Neo4j Browser at `http://localhost:7474` and run the constraint and index creation queries from the Schema Design section. Verify the vector index is configured for 1536 dimensions (OpenAI text-embedding-3-small).

### Step 3: Install Neo4j MCP server
```bash
pip install mcp-neo4j-cypher
```
Configure in IronClaw's MCP settings to point at `bolt://localhost:7687`.

### Step 4: Connect the Obsidian vault
Configure file system MCP in IronClaw to watch `~/Library/Mobile Documents/com~apple~CloudDocs/Lingelpedia`. Implement `.icloud` stub detection and `brctl download` handling. The agent needs read access to all files and write access to `_agent_insights/` only.

### Step 5: Create the Knowledge Agent identity file
Use the v3.1 template from the Identity Files section. Include `data_access`, `privacy_duties`, and `model_intelligence` sections. Include instructions to read `_schemas/README.md` and all schema files on startup. Save to IronClaw's identity directory.

### Step 6: Connect Phase 1 data feeds
Install and configure MCP servers for Google Calendar, Gmail, and Google Drive. All read-only for the Knowledge Agent. OAuth with Mike's personal Google account. For Drive, scope to GIX, WE, and Finance folders initially. Verify each connection by having the agent read one item and confirm it can parse the content.

### Step 7: First structured migration test
Point the agent at a single schema-driven note (e.g., one Entity note from `Finance/Entities/`). Verify frontmatter is parsed, truth_tier is assigned, embeddings are generated via OpenAI, and the note appears in Neo4j. Use the frontier model for this test.

### Step 8: First unstructured decomposition test
Point the agent at a meeting note (e.g., one from `GIX/Meeting Notes/`). Verify body text is decomposed into atomic claims with correct truth_tier, entities are extracted, embeddings are generated, and the compound interest engine finds connections to existing graph data.

---

## Future Considerations: Shared AQM and the Knowledge Edit Queue

Two architectural decisions were made in v3.2 that are expected to evolve as the system matures. Both are documented here so the reasoning is visible when revisiting them.

### Agentic Query Mode as a Shared Capability

**v3.2 decision:** AQM was initially scoped as a Knowledge Agent capability. However, AQM is entirely read-only — schema inspection, Cypher construction, reranking, and synthesis never write to Neo4j or Obsidian. The sole write owner pattern protects writes, not reads.

**Implication:** There is no architectural reason to prevent domain agents from using AQM directly. A domain agent like GIX CFO reasoning about interest rate exposure, or Wellness reasoning about supplement interaction patterns, should be able to run the four-stage pipeline against the graph without routing through the Knowledge Agent as a middleman.

**v3.2 implementation:** Domain agents can invoke AQM directly for read-only graph reasoning. The frontier model requirement still applies — AQM is never delegated to local regardless of which agent invokes it. The Knowledge Agent remains the sole write owner of the graph; AQM doesn't change that boundary.

**Future evolution (v3.3+):** If domain agents develop specialized query patterns (e.g., GIX CFO routinely needs DSCR covenant traversals, Wellness needs supplement-interaction graph walks), consider domain-specific query templates that pre-populate Stage 2 with domain-aware Cypher patterns. The Knowledge Agent would maintain these templates as part of its graph stewardship role, but domain agents would invoke them directly.

### Knowledge Edit Queue: Agent-Suggested Modifications

**v3.2 decision:** Currently, domain agents submit *new* claims to the Knowledge Agent for ingestion. But there is no formal mechanism for a domain agent to suggest *edits* to existing knowledge — flagging stale claims, proposing relationship corrections, or identifying contradictions they notice during their domain work.

**The pattern:** A Knowledge Edit Queue where any agent can submit structured edit suggestions that the Knowledge Agent reviews and approves before applying to the graph. This is analogous to a pull request model for the knowledge graph.

**Proposed queue schema (for future implementation):**

```sql
CREATE TABLE knowledge_edit_queue (
  id UUID PRIMARY KEY,
  proposing_agent VARCHAR NOT NULL,       -- Which agent is suggesting the edit
  edit_type VARCHAR NOT NULL,             -- update_claim, flag_stale, suggest_relationship, flag_contradiction, suggest_deletion
  target_node_id VARCHAR,                 -- Neo4j node ID being edited (NULL for new relationship suggestions)
  target_node_type VARCHAR,               -- Claim, Entity, Source, OpenQuestion, Bet
  current_value TEXT,                     -- What exists now
  proposed_value TEXT,                    -- What the agent thinks it should be
  reasoning TEXT NOT NULL,                -- Why the agent is suggesting this change
  confidence FLOAT,                       -- Agent's confidence in the suggestion (0-1)
  created_at TIMESTAMP NOT NULL,
  reviewed_at TIMESTAMP,                  -- When Knowledge Agent reviewed it
  reviewed_by VARCHAR,                    -- "knowledge_agent" or "mike" (escalated)
  status VARCHAR DEFAULT 'pending',       -- pending, approved, rejected, escalated
  resolution_notes TEXT                   -- Why it was approved/rejected
);
```

**Edit types:**

- **update_claim** — "This claim's truth_score should be higher/lower based on new evidence I encountered in my domain work."
- **flag_stale** — "This claim hasn't been validated in X months and my domain knowledge suggests it may be outdated."
- **suggest_relationship** — "I noticed a connection between Entity A and Entity B that isn't in the graph."
- **flag_contradiction** — "This claim contradicts something I'm seeing in my domain data source."
- **suggest_deletion** — "This claim appears to be duplicated or superseded." (Still requires the Deletion Approval Protocol — Knowledge Agent + Mike.)

**Why the Knowledge Agent reviews, not auto-applies:** Domain agents have domain expertise but not graph expertise. A GIX CFO suggestion to update a financial claim is probably right. A GIX CFO suggestion to restructure entity relationships might break cross-domain connections it doesn't see. The Knowledge Agent's Analytical and Investigator perspectives evaluate whether a suggested edit is locally correct *and* globally safe.

**Escalation:** If the Knowledge Agent is uncertain about a suggested edit (e.g., it would affect claims in multiple domains), it escalates to Mike through the normal Morning Brief channel. The Bar Raiser monitors the queue for patterns — if an agent's suggestions are consistently rejected, that's a signal worth investigating.

**v3.2 status:** Not implemented. The current "submit claims" pathway handles new knowledge. The edit queue is the next natural step and should be prioritized when domain agents are active (Phase 3+) and regularly encountering knowledge they want to correct.

### Graph-Native AQM vs. Vector-Only Retrieval: Architecture Notes

**Context:** The four-stage AQM pipeline follows an emerging pattern in agentic retrieval — notably validated by production systems like Weaviate's legal RAG architecture, which uses a nearly identical four-stage approach (schema inspection → structured query construction → reranking → grounded synthesis) against a vector database for contract analysis.

**Why VEGA uses Neo4j (graph) instead of a pure vector store:**

- **Multi-hop traversal:** AQM Stage 2 constructs Cypher queries that walk typed relationships — `Entity→Claim→Bet`, `Entity→Source→Claim` — with conditional logic at each hop. A vector database returns flat similarity-ranked chunks; it cannot natively traverse structured relationships. For questions like "What is my total exposure to interest rate risk across all entities?" the graph finds answers through traversal; a vector store must retrieve all possibly-relevant chunks and hope the LLM stitches them together.
- **Typed relationships and provenance:** Lingelpedia's five node types (Claim, Entity, Source, OpenQuestion, Bet) and fifteen relationship types encode semantic structure that vector embeddings discard. `truth_tier` weighting in Stage 3 reranking depends on this structure — `family_direct > multi_source_verified > single_source > agent_inferred` is a property of claims in the graph, not recoverable from embedding space.
- **Neo4j native vector index:** Neo4j already provides 1536-dim vector search (via `text-embedding-3-small`) alongside graph traversal. AQM can combine semantic similarity *and* structural traversal in a single query — a hybrid approach that a standalone vector DB cannot replicate without an external graph layer.

**What pure vector stores do better (and when to consider complementing Neo4j):**

- **Multimodal document ingestion:** Systems like ColQwen encode PDF pages as visual tokens (image patches), handling scanned documents and complex layouts that text extraction misses. If VEGA ever needs to ingest scanned legal documents, handwritten notes, or image-heavy PDFs, a dedicated multimodal vector index could complement Neo4j as an ingestion preprocessor — extracting structured knowledge that then gets persisted as graph nodes.
- **Raw document-scale retrieval:** For searching across millions of unstructured document chunks by semantic similarity alone, purpose-built vector databases (Weaviate, Qdrant, Pinecone) are optimized for throughput. Lingelpedia's graph serves a different purpose — curated, structured, provenance-tracked knowledge rather than raw document storage.

**Future upgrade path (Phase 3+): Domain-Aware Query Routing**

The Weaviate legal RAG system splits documents into domain-specific collections and lets the agent decide which collection to query. VEGA could adopt a similar pattern at the AQM query classifier level: rather than just "routine vs. agentic," the classifier could also identify *which graph domains* to prioritize. This would let Stage 2 focus its Cypher traversal — "start from financial entities" vs. "start from wellness claims" — reducing query scope and improving precision on large graphs. Implementation options include Neo4j label-based partitioning or domain-specific vector index subsets within the existing native vector index.

**v3.2 status:** No changes needed. The graph-native approach is correct for Lingelpedia's structured knowledge model. These notes document the architectural rationale and the specific scenarios where complementary vector infrastructure may be warranted in later phases.

---

### Cross-Agent Pattern Mining *(v3.3 — Phase 4+)*

**Context:** The centralized telemetry architecture (Tier 1 JSONL → Tier 2 PostgreSQL → Tier 3 Lingelpedia) accumulates rich behavioral data across all agents. By Phase 4, this data is mature enough for the Knowledge Agent to mine cross-agent patterns that no individual agent can see from its own telemetry alone.

**Why the Knowledge Agent owns this:** The Knowledge Agent already has read access to Neo4j and is the sole write owner for Lingelpedia. Mining centralized telemetry for behavioral patterns is a natural extension of its Investigator perspective — it's the same "active reasoning over structured data" capability that AQM provides for the graph, applied to the telemetry layer.

**Mechanism:**

The Knowledge Agent runs a weekly pattern mining job (scheduled alongside Loop 2 reflections, but independent) that:

1. Reads `telemetry_agent_hourly` and `telemetry_cost_daily` from Tier 2 PostgreSQL for the trailing 30 days
2. Reads all agents' weekly reflections (Loop 2 outputs) from the current cycle
3. Reads Bar Raiser weekly synthesis for correlated detection patterns
4. Identifies cross-agent behavioral patterns using the frontier model:
   - **Demand clustering:** Which agents are frequently invoked in sequence? (e.g., "GIX CFO → Knowledge Agent → Bar Raiser" cascade suggests a recurring analytical workflow)
   - **Resource contention:** Are agents competing for the same data at overlapping times? (e.g., two agents querying the same Neo4j subgraph within the same hour window)
   - **Complementary gaps:** Does one agent's output frequently become another agent's input? (e.g., Knowledge Agent AQM results feed GIX CFO analysis — suggests a pre-computation opportunity)
   - **Behavioral drift correlation:** When one agent's metrics change, do other agents' metrics change in response? (e.g., Knowledge Agent latency increase → GIX CFO task duration increase)
5. Produces a structured pattern mining report:

```markdown
# Cross-Agent Pattern Mining Report — Week of {date}

## Detected Patterns

### Pattern 1: {pattern_name}
- **Type:** demand_clustering | resource_contention | complementary_gap | drift_correlation
- **Agents involved:** {agent_list}
- **Evidence:** {specific metrics, dates, and values from Tier 2}
- **Frequency:** {how often this pattern recurs}
- **Suggested action:** {specific optimization or pre-computation proposal}
- **Confidence:** high | medium | low

## Proactive Artifact Candidates
{list of pre-generated summaries or pre-computed queries that could save agent invocations}

## No-Action Patterns
{patterns detected but not actionable yet — logged for trend tracking}
```

6. Writes the report to: `~/vega-telemetry/pattern-mining/{YYYY-MM-DD}.md`
7. Optionally emits high-confidence patterns as Claim nodes in Lingelpedia (truth_tier: `agent_inferred`, source: `cross_agent_pattern_mining`)

**Example pattern:** "GIX CFO Agent queries Knowledge Agent for the same wealth allocation data every Monday morning. The query results change <5% week-over-week. Suggested action: Knowledge Agent pre-generates a weekly wealth summary artifact on Sunday evening, reducing Monday morning latency by ~60%."

**Dependencies:**
- Requires: All three telemetry tiers operational (Phase 1-3 infrastructure)
- Requires: Loop 2 weekly reflections active (Phase 3)
- Requires: Bar Raiser weekly synthesis active (Phase 3)
- Requires: ≥8 weeks of Tier 2 data for meaningful pattern detection

**When enabled:** Phase 4, Weeks 18+. This is explicitly a post-maturity capability — it requires sufficient telemetry history and stable agent behavior to produce meaningful patterns rather than noise.

**Model usage:** Frontier model (pattern mining across agents is complex multi-source reasoning — same rationale as AQM).

**Safety guardrails:**
- Pattern mining is read-only — it does not modify agent behavior, only produces reports and optional Lingelpedia claims
- Proactive artifact generation (e.g., pre-computed summaries) requires Mike approval before automation
- Bar Raiser reviews all pattern mining reports for confirmation bias (Knowledge Agent finding patterns that justify its own importance)

**v3.3 status:** Future consideration — not a v3.3 build requirement. Documented here to establish the design intent so that telemetry infrastructure decisions in Phase 1-3 don't accidentally preclude this capability.

---

## Versioning

**Document versioning convention:**
- Charter, Behavioral Spec, and Implementation Guide share version numbers
- Current: v3.2 (all three documents updated)
- Incremental changes: v3.2, v3.3, etc.
- Structural overhaul: v4.0 (not expected — the architecture is clean)

**System versioning:**
- Each build phase completion is a minor version (e.g., "VEGA 0.1" = Phase 1 complete)
- Agent trust level changes are logged, not versioned
- Schema changes to Neo4j are versioned and tracked in Lingelpedia itself
- Model changes are logged with before/after quality metrics

**v3.2 → v3.3 changelog:**

*Build precision and observability upgrades — 16 recommendations integrated from dependency analysis.*

Phase 1 precision fixes:
- Added iCloud sync handler reference implementation (`materialize_icloud_stubs()` Python function with `.icloud` stub detection, `brctl download` invocation, and retry logic)
- Added YAML frontmatter specification for all 6 Obsidian note templates (Claim, Entity, Source, OpenQuestion, Bet, MOC) with required/optional fields and validation rules
- Added Privacy Audit Cypher query library (6 production-ready queries: orphaned sources, stale claims, cross-account leakage, missing truth_tier, permission boundary violations, temporal anomalies)
- Added Step 1.10b — Agentic Query Mode build step with reranking scoring function (`score = semantic_similarity × 0.4 + truth_tier_weight × 0.35 + recency_decay × 0.25`), truth_tier weight table, and 5 validation test queries

Phase boundary upgrades:
- Added measurable success criteria for all 4 build phases (Phases 1-4) replacing subjective language with quantitative thresholds
- Added mid-phase checkpoint gates: Week 2 (schema + sync), Week 3 (agent pipeline), Week 7 (multi-domain + AQM)
- Reordered Phase 2 steps to front-load multi-domain connector work before AQM integration
- Added Phase 3 and Phase 4 measurable exit criteria with specific metric targets

Telemetry and observability (new section):
- Added three-tier telemetry store architecture (Tier 1: JSONL 30-day active/90-day archive → Tier 2: PostgreSQL aggregation 1-year → Tier 3: Lingelpedia meta-knowledge permanent)
- Added telemetry event schema with complete JSON example and field reference
- Added event types/subtypes table with expected daily volumes
- Added 4 PostgreSQL aggregation tables: `telemetry_agent_hourly`, `telemetry_cost_daily`, `telemetry_quality_daily`, `telemetry_anomalies`
- Added aggregation job specification (hourly at :15, daily at 01:00 UTC, idempotent with ON CONFLICT upsert)
- Added Morning Brief System Health section with 6 SQL query patterns and mockup output
- Added telemetry phase-by-phase deliverable mapping

Self-improvement and learning infrastructure (new section):
- Added three learning loops: Loop 1 Operational (minutes, self_assessment YAML), Loop 2 Pattern (weekly reflections), Loop 3 Structural (monthly reviews with Bet tracking)
- Added context learning constraint documentation (LLMs cannot be retrained locally; improvement works through performance history in reasoning context)
- Added self_assessment YAML block specification for agent identity files with adjustment_rules and reasoning_prompt_injection
- Added weekly reflection prompt template and storage path specification
- Added monthly structural review template with Bet node tracking in Lingelpedia
- Added Bar Raiser Learning Monitors: 3 detection patterns (metric gaming, scope creep, confirmation bias) with YAML detection criteria
- Added monitoring integration and alerting with daily Bar Raiser report format
- Added learning loop activation schedule mapped to build phases
- Added self-improvement success criteria for each loop and Bar Raiser monitors
- Added Loop 1.5 — Agent-Local Pre-Reflection routine (event-triggered pre-analysis of Tier 1 JSONL before Loop 2 weekly reflections; local model; structured digest format with failure analysis, recurring patterns, confidence calibration; Phase 3 activation)
- Updated Loop 2 mechanism from 4-step to 5-step — now reads pre-reflection digest (Loop 1.5) as first step before Tier 2 aggregates
- Updated Phase 3 and Phase 4 entries in learning loop activation schedule with Loop 1.5 and cross-agent pattern mining
- Added Loop 1.5 and cross-agent pattern mining success criteria
- Added cross-agent pattern mining to Phase 4 Build Phase (Step 28) with Bar Raiser review requirement
- Added Future Considerations subsection: Cross-Agent Pattern Mining — Knowledge Agent mines centralized Tier 2 telemetry + Loop 2 reflections for behavioral patterns across agents (demand clustering, resource contention, complementary gaps, drift correlation); Phase 4+ capability

**v3.1 → v3.2 changelog:**
- Added Agentic Query Mode Pipeline — four-stage implementation (schema inspection → structured query construction → precision reranking → grounded synthesis with citations)
- Added `agentic_query_mode` to frontier model's `use_for` in Model Router configuration (never delegated to local)
- Added query classification heuristic (routine queries vs. agentic queries)
- Added Investigator perspective to Knowledge Agent identity file thinking model
- Added `agentic_query_pipeline` tool to Knowledge Agent identity file
- Added "Agentic query answer quality and citation accuracy" to Knowledge Agent north star controllable inputs
- Updated Knowledge Agent `model_intelligence` to explicitly exclude Agentic Query Mode from local delegation
- Added Agentic Query Mode validation to Phase 1 success criteria
- Added example Cypher queries for multi-entity exposure, cascading impact, and temporal change detection
- Added citation format specification with claim ID, truth_tier, and truth_score traceability
- Added gap detection: answers explicitly identify what's missing from the knowledge graph
- Clarified AQM as a shared read capability — domain agents can invoke it directly (not Knowledge Agent-exclusive)
- Added Future Considerations section: Shared AQM evolution path and Knowledge Edit Queue design
- Added Knowledge Edit Queue schema (proposed, not yet implemented) for agent-suggested edits to existing knowledge
- Updated Tool Access Control: domain agents explicitly listed as AQM-capable
- Fixed 2 stale `lingelpedia_agent` references → `knowledge_agent`
- Added Future Considerations subsection: Graph-Native AQM vs. Vector-Only Retrieval architecture notes — documenting why Neo4j graph traversal is preferred over pure vector stores for Lingelpedia, when complementary vector infrastructure may be warranted, and domain-aware query routing as a Phase 3+ upgrade path

**v3.0 → v3.1 changelog:**
- Corrected LLM model from "Grok-4.20" (non-existent) to `grok-4-1-fast-reasoning` (xAI production)
- Migrated embeddings from xAI to OpenAI `text-embedding-3-small` (1536-dim)
- Added Model Router architecture for dynamic model selection
- Added Performance-Based Model Bootstrapping (frontier/local supervision loop)
- Added Proactive Context Pipeline (MOCs, domain summaries, pre-context packages)
- Added Privacy Audit Infrastructure with escalation
- Added Multi-Account Connector support (Google personal, MS365 GIX, iCloud family)
- Added iCloud sync handling (`brctl download` for `.icloud` stubs)
- Added Parallel Batched Import for initial vault migration
- Updated Identity Files with `data_access`, `privacy_duties`, `model_intelligence`
- Updated Schema: added `truth_tier` to Claim, `source_account` to Source
- Enforced Sole Write Owner pattern throughout — only Knowledge Agent writes to Neo4j
- Updated all build phases to incorporate v3.1 concepts
- Updated Bar Raiser escalation to include privacy violations and model quality degradation

---

*This Implementation Guide defines the "how." The Charter defines the "what" and "why." The Behavioral Spec defines the "who does what."*
