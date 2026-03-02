// Lingelpedia Neo4j Schema
// Idempotent — safe to run multiple times (all statements use IF NOT EXISTS).
//
// 5 Node Types: Claim, Entity, Source, OpenQuestion, Bet
// 15 Relationship Types: created on use (no DDL required)
// Indexes: vector, full-text, and property lookup

// ─── Uniqueness Constraints (also create implicit indexes on id) ────────────

CREATE CONSTRAINT claim_id_unique IF NOT EXISTS
  FOR (c:Claim) REQUIRE c.id IS UNIQUE;

CREATE CONSTRAINT entity_id_unique IF NOT EXISTS
  FOR (e:Entity) REQUIRE e.id IS UNIQUE;

CREATE CONSTRAINT source_id_unique IF NOT EXISTS
  FOR (s:Source) REQUIRE s.id IS UNIQUE;

CREATE CONSTRAINT open_question_id_unique IF NOT EXISTS
  FOR (oq:OpenQuestion) REQUIRE oq.id IS UNIQUE;

CREATE CONSTRAINT bet_id_unique IF NOT EXISTS
  FOR (b:Bet) REQUIRE b.id IS UNIQUE;

// ─── Vector Index (768-dim cosine for nomic-embed-text via Ollama) ───────────
// Dimension matches the embedding model. If switching to a different model
// (e.g., text-embedding-3-small = 1536), drop and recreate this index.

CREATE VECTOR INDEX claim_embeddings IF NOT EXISTS
  FOR (c:Claim) ON (c.embedding)
  OPTIONS {indexConfig: {
    `vector.dimensions`: 768,
    `vector.similarity_function`: 'cosine'
  }};

// ─── Full-Text Index ────────────────────────────────────────────────────────

CREATE FULLTEXT INDEX claim_content IF NOT EXISTS
  FOR (c:Claim) ON EACH [c.content];

// ─── Property Lookup Indexes ────────────────────────────────────────────────

CREATE INDEX claim_domain IF NOT EXISTS
  FOR (c:Claim) ON (c.domain);

CREATE INDEX claim_status IF NOT EXISTS
  FOR (c:Claim) ON (c.status);

CREATE INDEX entity_type IF NOT EXISTS
  FOR (e:Entity) ON (e.entity_type);

CREATE INDEX bet_type IF NOT EXISTS
  FOR (b:Bet) ON (b.bet_type);

CREATE INDEX bet_status IF NOT EXISTS
  FOR (b:Bet) ON (b.status);

CREATE INDEX open_question_status IF NOT EXISTS
  FOR (oq:OpenQuestion) ON (oq.status);
