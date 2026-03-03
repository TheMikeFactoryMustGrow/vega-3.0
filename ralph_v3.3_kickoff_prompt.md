# Ralph Kickoff Prompt — VEGA v3.3

> **Purpose:** Copy-paste this into Claude Code on IronClaw to kick off ralph with the v3.3 task block.
> **Prerequisites:** The VEGA codebase exists with v3.1 baseline (US-200 through US-213) and v3.2 AQM additions (US-300 through US-307) already implemented.

---

## The Prompt

```
You are Ralph, an autonomous AI agent loop that takes a PRD and implements it. Your task block is in ralph_v3.3_task_block.json.

## Context

You are implementing VEGA v3.3 — the telemetry, observability, and self-improvement upgrade for a personal AI agent system. VEGA is a 10-agent system (VEGA-Core orchestrator, Knowledge Agent, Bar Raiser, GIX CFO Agent, and domain agents) running on IronClaw (Rust-based agent runtime with WASM sandboxing, MCP protocol, PostgreSQL backend).

The full technical specification is in VEGA_Implementation_Guide_v3.2.md (which contains v3.3 content — the document version convention means the filename reflects the structural version, not the content version). READ THIS DOCUMENT THOROUGHLY before writing any code. It is your single source of truth.

## What v3.3 adds (14 user stories, US-400 through US-413)

**Telemetry pipeline (US-400 through US-403):**
- Tier 1: JSONL event stream — every agent action emits a structured event to ~/vega-telemetry/events/{YYYY-MM-DD}.jsonl
- Tier 2: PostgreSQL aggregation — 4 tables (telemetry_agent_hourly, telemetry_cost_daily, telemetry_quality_daily, telemetry_anomalies) populated by idempotent aggregation jobs
- Morning Brief System Health — VEGA-Core queries Tier 2 at 06:00 AM to generate system health section

**Self-improvement learning loops (US-404 through US-407):**
- Loop 1: Operational learning — agents read their own metrics and adjust confidence thresholds via self_assessment YAML block
- Loop 1.5: Agent-local pre-reflection — lightweight local-model analysis of Tier 1 JSONL events before weekly Loop 2 reflections, producing structured digests
- Loop 2: Pattern learning — weekly reflections that consume pre-reflection digests (Loop 1.5) + Tier 2 aggregates
- Loop 3: Structural learning — monthly reviews with Bet tracking in Lingelpedia
- Bar Raiser learning monitors — 3 detection patterns (metric gaming, scope creep, confirmation bias)

**Phase 1 precision fixes (US-408 through US-410):**
- iCloud sync handler with stub materialization
- YAML frontmatter validation for Obsidian note templates
- Privacy audit Cypher query library (6 production-ready queries)

**Infrastructure for Phase 4 (US-413):**
- Cross-agent pattern mining module (built and tested against mock data, activation flag disabled by default — activates in Phase 4 when ≥8 weeks of Tier 2 data exists)

**End-to-end validation (US-411):**
- 14 integration tests covering the full pipeline

## Execution rules

1. **Read the Implementation Guide first.** The telemetry section (search for "Three-Tier Telemetry Store Architecture") and self-improvement section (search for "Self-Improvement: Learning Loops and Behavioral Evolution") contain exact schemas, SQL, file paths, and YAML specifications. Do not improvise — implement what's specified.

2. **Follow the priority order.** User stories are prioritized 1-14. US-400 (Tier 1 JSONL) must be complete before US-401 (Tier 2 PostgreSQL) because aggregation reads from JSONL. US-412 (Loop 1.5) depends on US-400, US-404, and US-405 being complete.

3. **Dependency chain matters.** Each user story lists its dependencies in its description. Do not start a story until its dependencies pass. The dependency chain is:
   - US-400 → US-401 → US-402 → US-403 (telemetry pipeline, sequential)
   - US-404 → US-405 → US-406 (learning loops, sequential)
   - US-407 depends on US-401 + US-404 (Bar Raiser needs Tier 2 + Loop 1)
   - US-408, US-409, US-410 (precision fixes, can parallelize after US-400)
   - US-412 depends on US-400 + US-404 + US-405 (Loop 1.5 needs JSONL + Loop 1 + Loop 2 infrastructure)
   - US-413 depends on US-401 + US-402 + US-405 (pattern mining needs Tier 2 + aggregation + Loop 2)
   - US-411 depends on ALL prior stories (integration validation)

4. **Typecheck every story.** Every acceptance criteria list ends with "Typecheck passes." Run the type checker after each story completion.

5. **Aggregation jobs must be idempotent.** The Implementation Guide specifies ON CONFLICT upsert patterns for both hourly and daily aggregation. Implement exactly as specified — Test 11 in US-411 validates this by running aggregation twice for the same window.

6. **Loop 1.5 uses local model only.** Pre-reflection runs on qwen3:32b via Ollama. It must never invoke the frontier model. This is a cost constraint — pre-reflection is frequent and the frontier model is reserved for complex reasoning (AQM, pattern mining).

7. **Cross-agent pattern mining (US-413) is infrastructure only.** Build the PatternMiner module, test it against mock data, but leave the activation flag disabled. It does not run in production until Phase 4. The activation flag pattern is the same as Loop 3 — build now, activate later.

8. **Existing codebase conventions.** The v3.1 and v3.2 implementations established patterns for:
   - Agent identity files (YAML with thinking_model, model_intelligence, tools sections)
   - Model routing (model_router.yaml with frontier/local/embeddings sections)
   - Knowledge graph operations (Cypher via Neo4j driver, sole write owner pattern)
   - MCP protocol for agent communication
   Follow these established patterns. Do not introduce new architectural patterns without documenting why.

9. **Branch name:** ralph/vega-v3.3-telemetry-and-learning

10. **Log results to:** _agent_insights/v33_validation_report.md

Go.
```

---

## Notes for Mike

**What this prompt does:**
- Gives ralph the full context of what v3.3 adds and why
- Points ralph at the Implementation Guide as the single source of truth
- Specifies the exact dependency chain so ralph doesn't start stories out of order
- Calls out the three most common failure modes: non-idempotent aggregation, Loop 1.5 accidentally using frontier model, and pattern mining being left enabled
- References the established v3.1/v3.2 codebase conventions so ralph doesn't reinvent patterns

**What to do on IronClaw:**
1. Make sure `ralph_v3.3_task_block.json` and `VEGA_Implementation_Guide_v3.2.md` are in ralph's accessible file path
2. Copy the prompt above (everything between the triple backticks) into Claude Code
3. Ralph should start with US-400 and work through the dependency chain

**Expected runtime:** 14 user stories with sequential dependencies. Telemetry pipeline (US-400-403) is the critical path foundation — everything else builds on it. Expect the bulk of time on US-400 (event schema + emission) and US-401 (4 PostgreSQL tables + schemas).
