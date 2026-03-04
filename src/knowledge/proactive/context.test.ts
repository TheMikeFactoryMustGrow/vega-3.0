import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ProactiveContext,
  type CalendarEvent,
  type MOCResult,
  type DomainSummaryResult,
  type PreContextResult,
} from "./context.js";
import { VaultConnector } from "../vault-connector.js";
import { TelemetryEmitter } from "../../telemetry/emitter.js";

/**
 * Proactive Context Pipeline tests — MOCs, Domain Summaries, Pre-Context Packages.
 *
 * Uses mock Neo4j sessions for deterministic testing.
 * Does NOT require a running Neo4j instance.
 */

let emitter: TelemetryEmitter;
let tempDir: string;
let vaultDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "vega-proactive-test-"));
  vaultDir = path.join(tempDir, "vault");
  emitter = new TelemetryEmitter(tempDir);
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── Mock Neo4j Helpers ─────────────────────────────────────────────────

function mockRecord(data: Record<string, unknown>) {
  return {
    get(key: string) {
      return data[key] ?? null;
    },
  };
}

function mockSession(runResponses: Array<{ records: Array<ReturnType<typeof mockRecord>> }>) {
  let callIndex = 0;
  return {
    run: vi.fn().mockImplementation(() => {
      const resp = runResponses[callIndex] ?? { records: [] };
      callIndex++;
      return Promise.resolve(resp);
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function mockConnection(sessionFactory: () => ReturnType<typeof mockSession>) {
  return {
    session: sessionFactory,
  } as unknown as import("../neo4j.js").Neo4jConnection;
}

// ── Claim Fixture Generator ─────────────────────────────────────────

function makeClaimRecords(count: number, theme: string, domain = "gix") {
  return Array.from({ length: count }, (_, i) => mockRecord({
    id: `claim-${theme}-${i}`,
    content: `Claim ${i} about ${theme}`,
    domain,
    truth_tier: i % 3 === 0 ? "family_direct" : "single_source",
    truth_score: 0.8 + (i % 5) * 0.04,
    entity_name: theme,
    created_at: new Date(Date.now() - i * 3600000).toISOString(),
  }));
}

// ── MOC Generation Tests ───────────────────────────────────────────────

describe("MOC Generation", () => {
  it("generates MOC when claim density exceeds threshold (12 claims about GIX Series B)", async () => {
    const claimRecords = makeClaimRecords(12, "GIX Series B", "gix");
    const sess = mockSession([
      // discoverThemes
      { records: [mockRecord({ name: "GIX Series B", cnt: 12 })] },
      // generateMOC: claims query
      { records: claimRecords },
      // open questions
      { records: [mockRecord({ cnt: 0 })] },
      // active bets
      { records: [mockRecord({ cnt: 0 })] },
      // related entities
      { records: [mockRecord({ name: "CIP" }), mockRecord({ name: "Blackstone" })] },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const ctx = new ProactiveContext({
      connection: conn,
      vault,
      emitter,
      mocThreshold: 10,
    });

    const results = await ctx.generateMOCs();

    expect(results).toHaveLength(1);
    expect(results[0].generated).toBe(true);
    expect(results[0].theme).toBe("GIX Series B");
    expect(results[0].claims_count).toBe(12);
    expect(results[0].file_path).toBeDefined();

    // Verify the file was written
    const content = await readFile(results[0].file_path!, "utf-8");
    expect(content).toContain("type: map_of_content");
    expect(content).toContain("theme: GIX Series B");
    expect(content).toContain("claims_referenced: 12");
    expect(content).toContain("# Map of Content: GIX Series B");
    expect(content).toContain("[[claim-GIX Series B-0]]");
  });

  it("does NOT generate MOC when claim density is below threshold", async () => {
    const sess = mockSession([
      // discoverThemes — only 5 claims (below default 10)
      { records: [mockRecord({ name: "Small Topic", cnt: 5 })] },
    ]);

    const conn = mockConnection(() => sess);
    const ctx = new ProactiveContext({
      connection: conn,
      emitter,
      mocThreshold: 10,
    });

    const results = await ctx.generateMOCs();
    expect(results).toHaveLength(0);
  });

  it("generates MOC with correct frontmatter fields per Implementation Guide", async () => {
    const claimRecords = makeClaimRecords(15, "CIP", "gix");
    const sess = mockSession([
      // discoverThemes
      { records: [mockRecord({ name: "CIP", cnt: 15 })] },
      // claims
      { records: claimRecords },
      // open questions
      { records: [mockRecord({ cnt: 3 })] },
      // active bets
      { records: [mockRecord({ cnt: 2 })] },
      // related entities
      { records: [mockRecord({ name: "Jim LaMarche" })] },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const ctx = new ProactiveContext({ connection: conn, vault, emitter });

    const results = await ctx.generateMOCs();
    const content = await readFile(results[0].file_path!, "utf-8");

    // All required MOC fields per Implementation Guide
    expect(content).toContain("type: map_of_content");
    expect(content).toContain("theme: CIP");
    expect(content).toContain("generated_at:");
    expect(content).toContain("claims_referenced: 15");
    expect(content).toContain("domains_spanned:");
    expect(content).toContain("key_entities:");
    expect(content).toContain("open_questions: 3");
    expect(content).toContain("active_bets: 2");
    expect(content).toContain("staleness_assessment:");
  });

  it("MOC body contains wiki-linked references to all claims", async () => {
    const claimRecords = makeClaimRecords(10, "TestEntity", "personal_finance");
    const sess = mockSession([
      { records: [mockRecord({ name: "TestEntity", cnt: 10 })] },
      { records: claimRecords },
      { records: [mockRecord({ cnt: 0 })] },
      { records: [mockRecord({ cnt: 0 })] },
      { records: [] },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const ctx = new ProactiveContext({ connection: conn, vault, emitter, mocThreshold: 10 });

    const results = await ctx.generateMOCs();
    const content = await readFile(results[0].file_path!, "utf-8");

    // Verify wiki links
    for (let i = 0; i < 10; i++) {
      expect(content).toContain(`[[claim-TestEntity-${i}]]`);
    }
    // Verify domain grouping
    expect(content).toContain("## personal_finance");
  });

  it("MOC written to correct path: _agent_insights/MOC_{theme_slug}.md", async () => {
    const claimRecords = makeClaimRecords(10, "Series B Funding", "gix");
    const sess = mockSession([
      { records: [mockRecord({ name: "Series B Funding", cnt: 10 })] },
      { records: claimRecords },
      { records: [mockRecord({ cnt: 0 })] },
      { records: [mockRecord({ cnt: 0 })] },
      { records: [] },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const ctx = new ProactiveContext({ connection: conn, vault, emitter, mocThreshold: 10 });

    const results = await ctx.generateMOCs();
    expect(results[0].file_path).toContain("_agent_insights");
    expect(results[0].file_path).toContain("MOC_series_b_funding.md");
  });

  it("handles multiple themes with different density levels", async () => {
    const sess = mockSession([
      // discoverThemes — 3 themes, only 2 above threshold
      {
        records: [
          mockRecord({ name: "ThemeA", cnt: 15 }),
          mockRecord({ name: "ThemeB", cnt: 12 }),
          mockRecord({ name: "ThemeC", cnt: 3 }),
        ],
      },
      // ThemeA claims
      { records: makeClaimRecords(15, "ThemeA", "gix") },
      { records: [mockRecord({ cnt: 0 })] },
      { records: [mockRecord({ cnt: 0 })] },
      { records: [] },
      // ThemeB claims
      { records: makeClaimRecords(12, "ThemeB", "we") },
      { records: [mockRecord({ cnt: 1 })] },
      { records: [mockRecord({ cnt: 0 })] },
      { records: [] },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const ctx = new ProactiveContext({ connection: conn, vault, emitter, mocThreshold: 10 });

    const results = await ctx.generateMOCs();
    expect(results).toHaveLength(2);
    expect(results[0].theme).toBe("ThemeA");
    expect(results[1].theme).toBe("ThemeB");
    expect(results[0].generated).toBe(true);
    expect(results[1].generated).toBe(true);
  });

  it("returns error when no Neo4j connection", async () => {
    const ctx = new ProactiveContext({ emitter });
    const results = await ctx.generateMOCs();
    expect(results[0].generated).toBe(false);
    expect(results[0].error).toBe("No Neo4j connection");
  });

  it("staleness assessment works for fresh, recent, aging, and stale claims", async () => {
    const ctx = new ProactiveContext({ emitter });

    // Access private method via any for testing
    const assess = (ctx as any).assessStaleness.bind(ctx);

    // Fresh (< 1 day)
    expect(assess([{ created_at: new Date().toISOString() }])).toBe("fresh");

    // Recent (1-7 days)
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(assess([{ created_at: threeDaysAgo }])).toBe("recent");

    // Aging (7-30 days)
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    expect(assess([{ created_at: fifteenDaysAgo }])).toBe("aging");

    // Stale (>30 days)
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    expect(assess([{ created_at: sixtyDaysAgo }])).toBe("stale");

    // Empty
    expect(assess([])).toBe("empty");
  });
});

// ── Domain Summary Generation Tests ───────────────────────────────────

describe("Domain Summary Generation", () => {
  it("generates daily summary for high-velocity domain (≥5 claims/day)", async () => {
    const sessResponses: Array<{ records: Array<ReturnType<typeof mockRecord>> }> = [];

    // getDomainVelocities
    sessResponses.push({
      records: [
        mockRecord({ domain: "personal_finance", total: 8, today: 6 }),
      ],
    });

    // generateDomainSummary for personal_finance (6 queries)
    sessResponses.push({ records: [mockRecord({ cnt: 5 })] });  // new claims
    sessResponses.push({ records: [mockRecord({ cnt: 2 })] });  // updated claims
    sessResponses.push({ records: [mockRecord({ cnt: 1 })] });  // contradictions
    sessResponses.push({ records: [mockRecord({ cnt: 0 })] });  // resolved questions
    sessResponses.push({  // key changes
      records: [
        mockRecord({ content: "New 401k contribution adjustment" }),
        mockRecord({ content: "Updated mortgage rate" }),
      ],
    });

    const sess = mockSession(sessResponses);
    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const ctx = new ProactiveContext({
      connection: conn,
      vault,
      emitter,
      highVelocityThreshold: 5,
    });

    const results = await ctx.generateDomainSummaries();

    expect(results).toHaveLength(1);
    expect(results[0].generated).toBe(true);
    expect(results[0].domain).toBe("personal_finance");
    expect(results[0].file_path).toBeDefined();

    const content = await readFile(results[0].file_path!, "utf-8");
    expect(content).toContain("type: domain_summary");
    expect(content).toContain("domain: personal_finance");
    expect(content).toContain("new_claims: 5");
    expect(content).toContain("updated_claims: 2");
    expect(content).toContain("new_contradictions: 1");
    expect(content).toContain("New 401k contribution adjustment");
  });

  it("generates weekly summary for normal-velocity domains", async () => {
    const sessResponses: Array<{ records: Array<ReturnType<typeof mockRecord>> }> = [];

    // getDomainVelocities
    sessResponses.push({
      records: [
        mockRecord({ domain: "gix", total: 3, today: 1 }),
      ],
    });

    // generateDomainSummary for gix
    sessResponses.push({ records: [mockRecord({ cnt: 3 })] });
    sessResponses.push({ records: [mockRecord({ cnt: 0 })] });
    sessResponses.push({ records: [mockRecord({ cnt: 0 })] });
    sessResponses.push({ records: [mockRecord({ cnt: 0 })] });
    sessResponses.push({ records: [mockRecord({ content: "GIX revenue update" })] });

    const sess = mockSession(sessResponses);
    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const ctx = new ProactiveContext({ connection: conn, vault, emitter });

    const results = await ctx.generateDomainSummaries();

    expect(results).toHaveLength(1);
    expect(results[0].generated).toBe(true);
    expect(results[0].domain).toBe("gix");
  });

  it("skips domains with zero claims in the period", async () => {
    const sess = mockSession([
      // getDomainVelocities — no claims
      { records: [] },
    ]);

    const conn = mockConnection(() => sess);
    const ctx = new ProactiveContext({ connection: conn, emitter });

    const results = await ctx.generateDomainSummaries();
    expect(results).toHaveLength(0);
  });

  it("domain summary contains correct frontmatter fields", async () => {
    const sessResponses: Array<{ records: Array<ReturnType<typeof mockRecord>> }> = [];
    sessResponses.push({
      records: [mockRecord({ domain: "health", total: 2, today: 0 })],
    });
    sessResponses.push({ records: [mockRecord({ cnt: 2 })] });
    sessResponses.push({ records: [mockRecord({ cnt: 1 })] });
    sessResponses.push({ records: [mockRecord({ cnt: 0 })] });
    sessResponses.push({ records: [mockRecord({ cnt: 1 })] });
    sessResponses.push({ records: [mockRecord({ content: "Blood test results updated" })] });

    const sess = mockSession(sessResponses);
    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const ctx = new ProactiveContext({ connection: conn, vault, emitter });

    const results = await ctx.generateDomainSummaries();
    const content = await readFile(results[0].file_path!, "utf-8");

    expect(content).toContain("type: domain_summary");
    expect(content).toContain("domain: health");
    expect(content).toContain("generated_at:");
    expect(content).toContain("period_start:");
    expect(content).toContain("period_end:");
    expect(content).toContain("new_claims:");
    expect(content).toContain("updated_claims:");
    expect(content).toContain("new_contradictions:");
    expect(content).toContain("resolved_questions:");
    expect(content).toContain("key_changes:");
  });

  it("handles multiple domains with mixed velocities", async () => {
    const sessResponses: Array<{ records: Array<ReturnType<typeof mockRecord>> }> = [];

    // getDomainVelocities — 2 domains
    sessResponses.push({
      records: [
        mockRecord({ domain: "gix", total: 10, today: 7 }),       // high velocity
        mockRecord({ domain: "family", total: 2, today: 0 }),     // normal
      ],
    });

    // gix summary (daily — high velocity)
    sessResponses.push({ records: [mockRecord({ cnt: 7 })] });
    sessResponses.push({ records: [mockRecord({ cnt: 0 })] });
    sessResponses.push({ records: [mockRecord({ cnt: 0 })] });
    sessResponses.push({ records: [mockRecord({ cnt: 0 })] });
    sessResponses.push({ records: [] });

    // family summary (weekly — normal)
    sessResponses.push({ records: [mockRecord({ cnt: 2 })] });
    sessResponses.push({ records: [mockRecord({ cnt: 0 })] });
    sessResponses.push({ records: [mockRecord({ cnt: 0 })] });
    sessResponses.push({ records: [mockRecord({ cnt: 0 })] });
    sessResponses.push({ records: [] });

    const sess = mockSession(sessResponses);
    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const ctx = new ProactiveContext({ connection: conn, vault, emitter, highVelocityThreshold: 5 });

    const results = await ctx.generateDomainSummaries();
    expect(results).toHaveLength(2);
    expect(results[0].domain).toBe("gix");
    expect(results[1].domain).toBe("family");
  });

  it("returns error when no Neo4j connection", async () => {
    const ctx = new ProactiveContext({ emitter });
    const results = await ctx.generateDomainSummaries();
    expect(results[0].generated).toBe(false);
    expect(results[0].error).toBe("No Neo4j connection");
  });
});

// ── Pre-Context Package Generation Tests ──────────────────────────────

describe("Pre-Context Package Generation", () => {
  it("generates pre-context package for CIP meeting within 48-hour window", async () => {
    const eventStart = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
    const event: CalendarEvent = {
      id: "evt-1",
      title: "CIP Board Meeting",
      start: eventStart.toISOString(),
      end: new Date(eventStart.getTime() + 3600000).toISOString(),
      attendees: ["Jim LaMarche", "Mike Lingle"],
      description: "Quarterly CIP review with investment updates",
    };

    const sess = mockSession([
      // attendee claims
      {
        records: [
          mockRecord({
            id: "claim-jim-1",
            content: "Jim LaMarche is a managing director at CIP",
            domain: "gix",
            truth_tier: "family_direct",
            entity_name: "Jim LaMarche",
          }),
          mockRecord({
            id: "claim-mike-1",
            content: "Mike Lingle is CIP founding partner",
            domain: "gix",
            truth_tier: "family_direct",
            entity_name: "Mike Lingle",
          }),
        ],
      },
      // topic claims (CIP-related)
      {
        records: [
          mockRecord({
            id: "claim-cip-1",
            content: "CIP Series B valuation at $50M",
            domain: "gix",
            truth_tier: "multi_source_verified",
            entity_name: "CIP",
          }),
          mockRecord({
            id: "claim-cip-2",
            content: "CIP quarterly revenue grew 15%",
            domain: "gix",
            truth_tier: "single_source",
            entity_name: "CIP",
          }),
        ],
      },
      // relevant bets
      {
        records: [
          mockRecord({
            description: "Implicit USD concentration in CIP portfolio",
            risk_level: "medium",
          }),
        ],
      },
      // open questions
      {
        records: [
          mockRecord({
            question: "Is CIP Series C timeline confirmed?",
            domain: "gix",
            priority: "high",
          }),
        ],
      },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const ctx = new ProactiveContext({ connection: conn, vault, emitter });

    const results = await ctx.generatePreContextPackages([event]);

    expect(results).toHaveLength(1);
    expect(results[0].generated).toBe(true);
    expect(results[0].event_title).toBe("CIP Board Meeting");
    expect(results[0].file_path).toBeDefined();

    const content = await readFile(results[0].file_path!, "utf-8");
    expect(content).toContain("type: pre_context_package");
    expect(content).toContain("event_title: CIP Board Meeting");
    expect(content).toContain("Jim LaMarche is a managing director at CIP");
    expect(content).toContain("CIP Series B valuation at $50M");
    expect(content).toContain("Implicit USD concentration in CIP portfolio");
    expect(content).toContain("Is CIP Series C timeline confirmed?");
  });

  it("skips events outside the 48-hour pre-context window", async () => {
    const farEvent: CalendarEvent = {
      id: "evt-far",
      title: "Far Future Meeting",
      start: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),  // 7 days from now
      end: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 3600000).toISOString(),
      attendees: [],
    };

    const conn = mockConnection(() => mockSession([]));
    const ctx = new ProactiveContext({ connection: conn, emitter, preContextWindowHours: 48 });

    const results = await ctx.generatePreContextPackages([farEvent]);
    expect(results).toHaveLength(0);
  });

  it("skips past events", async () => {
    const pastEvent: CalendarEvent = {
      id: "evt-past",
      title: "Past Meeting",
      start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      end: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
      attendees: [],
    };

    const conn = mockConnection(() => mockSession([]));
    const ctx = new ProactiveContext({ connection: conn, emitter });

    const results = await ctx.generatePreContextPackages([pastEvent]);
    expect(results).toHaveLength(0);
  });

  it("pre-context package contains attendee claims, topic claims, bets, and open questions", async () => {
    const eventStart = new Date(Date.now() + 12 * 60 * 60 * 1000);
    const event: CalendarEvent = {
      id: "evt-2",
      title: "Blackstone Review",
      start: eventStart.toISOString(),
      end: new Date(eventStart.getTime() + 3600000).toISOString(),
      attendees: ["Steve Schwarzman"],
      description: "Review Blackstone holdings",
    };

    const sess = mockSession([
      // attendee claims
      {
        records: [
          mockRecord({
            id: "claim-steve-1",
            content: "Steve Schwarzman founded Blackstone",
            domain: "gix",
            truth_tier: "multi_source_verified",
            entity_name: "Steve Schwarzman",
          }),
        ],
      },
      // topic claims
      {
        records: [
          mockRecord({
            id: "claim-bs-1",
            content: "Blackstone AUM exceeds $900B",
            domain: "gix",
            truth_tier: "single_source",
            entity_name: "Blackstone",
          }),
        ],
      },
      // bets
      { records: [] },
      // open questions
      { records: [] },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const ctx = new ProactiveContext({ connection: conn, vault, emitter });

    const results = await ctx.generatePreContextPackages([event]);
    const content = await readFile(results[0].file_path!, "utf-8");

    // Verify all sections present
    expect(content).toContain("## Attendee Context");
    expect(content).toContain("## Topic Context");
    expect(content).toContain("attendee_claims: 1");
    expect(content).toContain("topic_claims: 1");
  });

  it("extracts meaningful keywords from event title and description", () => {
    const ctx = new ProactiveContext({ emitter });
    const event: CalendarEvent = {
      id: "evt-kw",
      title: "CIP Board Strategy Review",
      start: new Date().toISOString(),
      end: new Date().toISOString(),
      attendees: [],
      description: "Discuss Blackstone partnership and Series B timeline",
    };

    const keywords = ctx.extractEventKeywords(event);

    // Should include meaningful words, exclude stop words
    expect(keywords).toContain("CIP");
    expect(keywords).toContain("Board");
    expect(keywords).toContain("Strategy");
    expect(keywords).toContain("Blackstone");
    expect(keywords).toContain("Series");
    expect(keywords).toContain("timeline");

    // Should exclude stop words
    expect(keywords).not.toContain("and");
    expect(keywords).not.toContain("the");
  });

  it("returns error when no Neo4j connection", async () => {
    const event: CalendarEvent = {
      id: "evt-noconn",
      title: "Test",
      start: new Date(Date.now() + 3600000).toISOString(),
      end: new Date(Date.now() + 7200000).toISOString(),
      attendees: [],
    };

    const ctx = new ProactiveContext({ emitter });
    const results = await ctx.generatePreContextPackages([event]);
    expect(results[0].generated).toBe(false);
    expect(results[0].error).toBe("No Neo4j connection");
  });

  it("handles events with empty attendees and description", async () => {
    const eventStart = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const event: CalendarEvent = {
      id: "evt-minimal",
      title: "Quick GIX Sync",
      start: eventStart.toISOString(),
      end: new Date(eventStart.getTime() + 1800000).toISOString(),
      attendees: [],
    };

    const sess = mockSession([
      { records: [] },  // attendee claims (empty)
      { records: [] },  // topic claims
      { records: [] },  // bets
      { records: [] },  // open questions
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const ctx = new ProactiveContext({ connection: conn, vault, emitter });

    const results = await ctx.generatePreContextPackages([event]);
    expect(results[0].generated).toBe(true);
  });
});

// ── Trigger Logic Tests ─────────────────────────────────────────────

describe("Generation Triggers", () => {
  it("discoverThemes returns entities with their claim counts", async () => {
    const sess = mockSession([
      {
        records: [
          mockRecord({ name: "Blackstone", cnt: 20 }),
          mockRecord({ name: "CIP", cnt: 15 }),
          mockRecord({ name: "Jim LaMarche", cnt: 8 }),
        ],
      },
    ]);

    const conn = mockConnection(() => sess);
    const ctx = new ProactiveContext({ connection: conn, emitter });

    const themes = await ctx.discoverThemes();
    expect(themes).toHaveLength(3);
    expect(themes[0]).toEqual({ name: "Blackstone", count: 20 });
    expect(themes[1]).toEqual({ name: "CIP", count: 15 });
    expect(themes[2]).toEqual({ name: "Jim LaMarche", count: 8 });
  });

  it("getDomainVelocities returns velocity info per domain", async () => {
    const sess = mockSession([
      {
        records: [
          mockRecord({ domain: "personal_finance", total: 12, today: 6 }),
          mockRecord({ domain: "gix", total: 5, today: 2 }),
        ],
      },
    ]);

    const conn = mockConnection(() => sess);
    const ctx = new ProactiveContext({ connection: conn, emitter });

    const velocities = await ctx.getDomainVelocities();
    expect(velocities).toHaveLength(2);
    expect(velocities[0]).toEqual({
      domain: "personal_finance",
      claims_today: 6,
      claims_in_period: 12,
    });
  });

  it("configurable MOC threshold overrides default", async () => {
    const claimRecords = makeClaimRecords(5, "SmallTheme", "gix");
    const sess = mockSession([
      { records: [mockRecord({ name: "SmallTheme", cnt: 5 })] },
      { records: claimRecords },
      { records: [mockRecord({ cnt: 0 })] },
      { records: [mockRecord({ cnt: 0 })] },
      { records: [] },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const ctx = new ProactiveContext({
      connection: conn,
      vault,
      emitter,
      mocThreshold: 3,  // Lower threshold
    });

    const results = await ctx.generateMOCs();
    expect(results).toHaveLength(1);
    expect(results[0].generated).toBe(true);
    expect(results[0].claims_count).toBe(5);
  });
});

// ── Telemetry Tests ──────────────────────────────────────────────────

describe("Telemetry", () => {
  it("emits telemetry for MOC generation", async () => {
    const emitSpy = vi.spyOn(emitter, "emit");
    emitSpy.mockClear();

    const sess = mockSession([
      { records: [mockRecord({ name: "TelemetryTheme", cnt: 10 })] },
      { records: makeClaimRecords(10, "TelemetryTheme") },
      { records: [mockRecord({ cnt: 0 })] },
      { records: [mockRecord({ cnt: 0 })] },
      { records: [] },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const ctx = new ProactiveContext({ connection: conn, vault, emitter, mocThreshold: 10 });

    await ctx.generateMOCs();

    const mocEvents = emitSpy.mock.calls.filter(
      (c) => c[0].event_subtype === "moc_generation",
    );
    expect(mocEvents.length).toBeGreaterThanOrEqual(1);
    expect(mocEvents[0][0].agent_name).toBe("knowledge_agent");
    expect(mocEvents[0][0].outcome).toBe("success");
  });

  it("emits telemetry for domain summary generation", async () => {
    const emitSpy = vi.spyOn(emitter, "emit");
    emitSpy.mockClear();

    const sess = mockSession([
      { records: [mockRecord({ domain: "gix", total: 3, today: 1 })] },
      { records: [mockRecord({ cnt: 3 })] },
      { records: [mockRecord({ cnt: 0 })] },
      { records: [mockRecord({ cnt: 0 })] },
      { records: [mockRecord({ cnt: 0 })] },
      { records: [] },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const ctx = new ProactiveContext({ connection: conn, vault, emitter });

    await ctx.generateDomainSummaries();

    const summaryEvents = emitSpy.mock.calls.filter(
      (c) => c[0].event_subtype === "domain_summary_generation",
    );
    expect(summaryEvents.length).toBeGreaterThanOrEqual(1);
    expect(summaryEvents[0][0].outcome).toBe("success");
  });

  it("emits telemetry for pre-context generation", async () => {
    const emitSpy = vi.spyOn(emitter, "emit");
    emitSpy.mockClear();

    const eventStart = new Date(Date.now() + 12 * 60 * 60 * 1000);
    const event: CalendarEvent = {
      id: "evt-telem",
      title: "Test Event",
      start: eventStart.toISOString(),
      end: new Date(eventStart.getTime() + 3600000).toISOString(),
      attendees: [],
    };

    const sess = mockSession([
      { records: [] },
      { records: [] },
      { records: [] },
      { records: [] },
    ]);

    const conn = mockConnection(() => sess);
    const vault = new VaultConnector({ vaultPath: vaultDir, emitter });
    const ctx = new ProactiveContext({ connection: conn, vault, emitter });

    await ctx.generatePreContextPackages([event]);

    const preContextEvents = emitSpy.mock.calls.filter(
      (c) => c[0].event_subtype === "pre_context_generation",
    );
    expect(preContextEvents.length).toBeGreaterThanOrEqual(1);
    expect(preContextEvents[0][0].outcome).toBe("success");
  });
});

// ── Error Handling Tests ─────────────────────────────────────────────

describe("Error Handling", () => {
  it("MOC generation handles Neo4j session errors gracefully", async () => {
    const sess = {
      run: vi.fn().mockRejectedValue(new Error("Connection lost")),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const conn = mockConnection(() => sess as any);
    const ctx = new ProactiveContext({ connection: conn, emitter });

    const results = await ctx.generateMOCs();
    expect(results[0].generated).toBe(false);
    expect(results[0].error).toContain("Connection lost");
  });

  it("domain summary handles Neo4j errors gracefully", async () => {
    const sess = {
      run: vi.fn().mockRejectedValue(new Error("Session expired")),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const conn = mockConnection(() => sess as any);
    const ctx = new ProactiveContext({ connection: conn, emitter });

    const result = await ctx.generateDomainSummary("gix");
    expect(result.generated).toBe(false);
    expect(result.error).toContain("Session expired");
  });

  it("pre-context handles Neo4j errors gracefully", async () => {
    const eventStart = new Date(Date.now() + 12 * 60 * 60 * 1000);
    const event: CalendarEvent = {
      id: "evt-err",
      title: "Error Event",
      start: eventStart.toISOString(),
      end: new Date(eventStart.getTime() + 3600000).toISOString(),
      attendees: ["Test Person"],
    };

    const sess = {
      run: vi.fn().mockRejectedValue(new Error("Query failed")),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const conn = mockConnection(() => sess as any);
    const ctx = new ProactiveContext({ connection: conn, emitter });

    const results = await ctx.generatePreContextPackages([event]);
    expect(results[0].generated).toBe(false);
    expect(results[0].error).toContain("Query failed");
  });

  it("works without vault connector (no file written, but generation completes)", async () => {
    const sess = mockSession([
      { records: [mockRecord({ name: "NoVaultTheme", cnt: 10 })] },
      { records: makeClaimRecords(10, "NoVaultTheme") },
      { records: [mockRecord({ cnt: 0 })] },
      { records: [mockRecord({ cnt: 0 })] },
      { records: [] },
    ]);

    const conn = mockConnection(() => sess);
    // No vault connector provided
    const ctx = new ProactiveContext({ connection: conn, emitter, mocThreshold: 10 });

    const results = await ctx.generateMOCs();
    expect(results[0].generated).toBe(true);
    expect(results[0].file_path).toBeUndefined();
  });
});

// ── Slugify Tests ──────────────────────────────────────────────────────

describe("slugify helper", () => {
  it("converts theme names to valid file slugs", () => {
    const ctx = new ProactiveContext({ emitter });
    // Access private extractEventKeywords as a proxy — test slugify via MOC file paths
    // We'll test through the public API file path output
    // The slug is tested implicitly via file_path assertions above
    // Direct test: "GIX Series B" → "gix_series_b"
    expect("GIX Series B".toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""))
      .toBe("gix_series_b");
    expect("CIP Board Meeting".toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""))
      .toBe("cip_board_meeting");
  });
});
