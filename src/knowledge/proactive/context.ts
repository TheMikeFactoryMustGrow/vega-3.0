/**
 * Proactive Context Pipeline — MOCs, Domain Summaries, Pre-Context Packages
 *
 * Generates context artifacts anticipatorily so relevant knowledge is
 * pre-assembled before it's needed rather than only retrieved on demand.
 *
 * Three artifact types:
 *   1. MOC (Map of Content) — index notes for topics with claim density above threshold
 *   2. Domain Summary — periodic distillation of changes in a domain
 *   3. Pre-Context Package — anticipatory context for upcoming calendar events
 *
 * All artifacts written to _agent_insights/ via VaultConnector.
 */

import { randomUUID } from "node:crypto";
import type { Neo4jConnection } from "../neo4j.js";
import type { VaultConnector } from "../vault-connector.js";
import type { TelemetryEmitter } from "../../telemetry/emitter.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface MOCData {
  type: "map_of_content";
  theme: string;
  generated_at: string;
  claims_referenced: number;
  domains_spanned: string[];
  key_entities: string[];
  open_questions: number;
  active_bets: number;
  staleness_assessment: string;
}

export interface MOCClaim {
  id: string;
  content: string;
  domain: string;
  truth_tier: string;
  truth_score: number;
  entity_name: string;
  created_at: string;
}

export interface DomainSummaryData {
  type: "domain_summary";
  domain: string;
  generated_at: string;
  period_start: string;
  period_end: string;
  new_claims: number;
  updated_claims: number;
  new_contradictions: number;
  resolved_questions: number;
  key_changes: string[];
}

export interface DomainVelocity {
  domain: string;
  claims_today: number;
  claims_in_period: number;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  description?: string;
}

export interface PreContextData {
  type: "pre_context_package";
  event_title: string;
  event_start: string;
  generated_at: string;
  attendee_claims: number;
  topic_claims: number;
  relevant_bets: number;
  open_questions: number;
}

export interface PreContextClaim {
  id: string;
  content: string;
  domain: string;
  truth_tier: string;
  entity_name: string;
}

export interface PreContextBet {
  description: string;
  risk_level: string;
}

export interface PreContextQuestion {
  question: string;
  domain: string;
  priority: string;
}

export interface MOCResult {
  generated: boolean;
  theme: string;
  claims_count: number;
  file_path?: string;
  error?: string;
}

export interface DomainSummaryResult {
  generated: boolean;
  domain: string;
  file_path?: string;
  error?: string;
}

export interface PreContextResult {
  generated: boolean;
  event_title: string;
  file_path?: string;
  error?: string;
}

export interface ProactiveContextOptions {
  connection?: Neo4jConnection;
  vault?: VaultConnector;
  emitter?: TelemetryEmitter;
  /** Minimum claims for a theme to trigger MOC generation (default: 10) */
  mocThreshold?: number;
  /** Minimum claims/day for a domain to be "high-velocity" (default: 5) */
  highVelocityThreshold?: number;
  /** Hours before event to generate pre-context (default: 48) */
  preContextWindowHours?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function formatDate(d: Date): string {
  return d.toISOString();
}

// ── ProactiveContext ────────────────────────────────────────────────────

export class ProactiveContext {
  private readonly connection: Neo4jConnection | null;
  private readonly vault: VaultConnector | null;
  private readonly emitter: TelemetryEmitter | null;
  private readonly sessionId: string;
  private readonly mocThreshold: number;
  private readonly highVelocityThreshold: number;
  private readonly preContextWindowHours: number;

  constructor(options?: ProactiveContextOptions) {
    this.connection = options?.connection ?? null;
    this.vault = options?.vault ?? null;
    this.emitter = options?.emitter ?? null;
    this.sessionId = `proactive-${Date.now()}`;
    this.mocThreshold = options?.mocThreshold ?? 10;
    this.highVelocityThreshold = options?.highVelocityThreshold ?? 5;
    this.preContextWindowHours = options?.preContextWindowHours ?? 48;
  }

  // ── MOC Generation ──────────────────────────────────────────────────

  /**
   * Discover themes that exceed the claim density threshold and generate MOCs.
   * Groups claims by the entities they reference; when an entity has ≥threshold
   * claims, it becomes a MOC theme.
   */
  async generateMOCs(): Promise<MOCResult[]> {
    const start = Date.now();
    const results: MOCResult[] = [];

    if (!this.connection) {
      return [{ generated: false, theme: "", claims_count: 0, error: "No Neo4j connection" }];
    }

    try {
      const themes = await this.discoverThemes();

      for (const theme of themes) {
        if (theme.count >= this.mocThreshold) {
          const result = await this.generateMOC(theme.name, theme.count);
          results.push(result);
        }
      }

      await this.emitEvent("moc_generation", "success", {
        themes_discovered: themes.length,
        mocs_generated: results.filter((r) => r.generated).length,
        latency_ms: Date.now() - start,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ generated: false, theme: "", claims_count: 0, error: msg });
      await this.emitEvent("moc_generation", "failure", { error: msg });
    }

    return results;
  }

  /**
   * Generate a MOC for a specific theme (entity name).
   */
  async generateMOC(theme: string, _hintCount?: number): Promise<MOCResult> {
    if (!this.connection) {
      return { generated: false, theme, claims_count: 0, error: "No Neo4j connection" };
    }

    const session = this.connection.session();
    try {
      // Fetch claims about this theme entity
      const claimsResult = await session.run(
        `MATCH (c:Claim)-[:ABOUT]->(e:Entity {name: $theme})
         OPTIONAL MATCH (c)-[:SOURCED_FROM]->(s:Source)
         RETURN c.id AS id, c.content AS content, c.domain AS domain,
                c.truth_tier AS truth_tier, c.truth_score AS truth_score,
                e.name AS entity_name, c.created_at AS created_at
         ORDER BY c.created_at DESC`,
        { theme },
      );

      const claims: MOCClaim[] = claimsResult.records.map((r) => ({
        id: r.get("id") ?? randomUUID(),
        content: r.get("content") ?? "",
        domain: r.get("domain") ?? "general",
        truth_tier: r.get("truth_tier") ?? "agent_inferred",
        truth_score: Number(r.get("truth_score") ?? 0),
        entity_name: r.get("entity_name") ?? theme,
        created_at: r.get("created_at") ?? new Date().toISOString(),
      }));

      if (claims.length < this.mocThreshold) {
        return { generated: false, theme, claims_count: claims.length };
      }

      // Fetch open questions for this theme
      const oqResult = await session.run(
        `MATCH (oq:OpenQuestion)-[:INVOLVES]->(c:Claim)-[:ABOUT]->(e:Entity {name: $theme})
         WHERE oq.status = 'open'
         RETURN count(DISTINCT oq) AS cnt`,
        { theme },
      );
      const openQuestions = toNumber(oqResult.records[0]?.get("cnt"));

      // Fetch active bets related to this theme
      const betsResult = await session.run(
        `MATCH (b:Bet)-[:EVIDENCED_BY]->(c:Claim)-[:ABOUT]->(e:Entity {name: $theme})
         RETURN count(DISTINCT b) AS cnt`,
        { theme },
      );
      const activeBets = toNumber(betsResult.records[0]?.get("cnt"));

      // Compute MOC metadata
      const domains = [...new Set(claims.map((c) => c.domain))];
      const entities = await this.getRelatedEntities(theme);
      const staleness = this.assessStaleness(claims);

      const mocData: MOCData = {
        type: "map_of_content",
        theme,
        generated_at: formatDate(new Date()),
        claims_referenced: claims.length,
        domains_spanned: domains,
        key_entities: entities,
        open_questions: openQuestions,
        active_bets: activeBets,
        staleness_assessment: staleness,
      };

      // Build markdown body with wiki-linked references
      const body = this.buildMOCBody(theme, claims, domains);

      // Write to vault
      const fileName = `MOC_${slugify(theme)}.md`;
      let filePath: string | undefined;
      if (this.vault) {
        filePath = await this.vault.writeInsight(
          fileName,
          mocData as unknown as Record<string, unknown>,
          body,
        );
      }

      return {
        generated: true,
        theme,
        claims_count: claims.length,
        file_path: filePath,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { generated: false, theme, claims_count: 0, error: msg };
    } finally {
      await session.close();
    }
  }

  /**
   * Discover themes (entities) that have claims, returning name + count.
   */
  async discoverThemes(): Promise<Array<{ name: string; count: number }>> {
    if (!this.connection) return [];

    const session = this.connection.session();
    try {
      const result = await session.run(
        `MATCH (c:Claim)-[:ABOUT]->(e:Entity)
         RETURN e.name AS name, count(c) AS cnt
         ORDER BY cnt DESC`,
      );

      return result.records.map((r) => ({
        name: r.get("name"),
        count: toNumber(r.get("cnt")),
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Get related entities for a theme (entities that share claims with this theme's claims).
   */
  private async getRelatedEntities(theme: string): Promise<string[]> {
    if (!this.connection) return [];

    const session = this.connection.session();
    try {
      const result = await session.run(
        `MATCH (c:Claim)-[:ABOUT]->(e1:Entity {name: $theme})
         MATCH (c)-[:ABOUT]->(e2:Entity)
         WHERE e2.name <> $theme
         RETURN DISTINCT e2.name AS name
         LIMIT 20`,
        { theme },
      );

      return result.records.map((r) => r.get("name") as string);
    } finally {
      await session.close();
    }
  }

  /**
   * Assess staleness of a claim set — how recently was it updated?
   */
  private assessStaleness(claims: MOCClaim[]): string {
    if (claims.length === 0) return "empty";

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const dates = claims
      .map((c) => new Date(c.created_at).getTime())
      .filter((t) => !isNaN(t));

    if (dates.length === 0) return "unknown";

    const newest = Math.max(...dates);
    const ageDays = (now - newest) / dayMs;

    if (ageDays < 1) return "fresh";
    if (ageDays < 7) return "recent";
    if (ageDays < 30) return "aging";
    return "stale";
  }

  /**
   * Build the markdown body for a MOC.
   */
  private buildMOCBody(theme: string, claims: MOCClaim[], domains: string[]): string {
    const lines: string[] = [];
    lines.push(`# Map of Content: ${theme}\n`);
    lines.push(`This MOC organizes ${claims.length} claims about **${theme}** across ${domains.length} domain(s).\n`);

    // Group claims by domain
    const byDomain = new Map<string, MOCClaim[]>();
    for (const claim of claims) {
      const existing = byDomain.get(claim.domain) ?? [];
      existing.push(claim);
      byDomain.set(claim.domain, existing);
    }

    for (const [domain, domainClaims] of byDomain) {
      lines.push(`## ${domain}\n`);
      for (const c of domainClaims) {
        lines.push(`- [[${c.id}]] ${c.content} *(${c.truth_tier}, score: ${c.truth_score})*`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  // ── Domain Summary Generation ───────────────────────────────────────

  /**
   * Generate domain summaries for all domains that had activity in the period.
   * Weekly for normal domains, daily for high-velocity domains.
   */
  async generateDomainSummaries(
    periodEnd: Date = new Date(),
    periodDays: number = 7,
  ): Promise<DomainSummaryResult[]> {
    const start = Date.now();
    const results: DomainSummaryResult[] = [];

    if (!this.connection) {
      return [{ generated: false, domain: "", error: "No Neo4j connection" }];
    }

    try {
      const velocities = await this.getDomainVelocities(periodEnd, periodDays);

      for (const v of velocities) {
        // Generate if: high-velocity domain (≥5 claims/day) regardless, OR
        // any domain with ≥1 claim in the period for weekly summaries
        if (v.claims_in_period > 0) {
          const isHighVelocity = v.claims_today >= this.highVelocityThreshold;
          const result = await this.generateDomainSummary(
            v.domain,
            periodEnd,
            isHighVelocity ? 1 : periodDays,
          );
          results.push(result);
        }
      }

      await this.emitEvent("domain_summary_generation", "success", {
        domains_processed: velocities.length,
        summaries_generated: results.filter((r) => r.generated).length,
        latency_ms: Date.now() - start,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ generated: false, domain: "", error: msg });
      await this.emitEvent("domain_summary_generation", "failure", { error: msg });
    }

    return results;
  }

  /**
   * Generate a domain summary for a specific domain and period.
   */
  async generateDomainSummary(
    domain: string,
    periodEnd: Date = new Date(),
    periodDays: number = 7,
  ): Promise<DomainSummaryResult> {
    if (!this.connection) {
      return { generated: false, domain, error: "No Neo4j connection" };
    }

    const periodStart = new Date(periodEnd.getTime() - periodDays * 24 * 60 * 60 * 1000);
    const session = this.connection.session();

    try {
      // Count new claims in period
      const newClaimsResult = await session.run(
        `MATCH (c:Claim {domain: $domain})
         WHERE c.created_at >= $periodStart AND c.created_at <= $periodEnd
           AND c.created_at = c.updated_at
         RETURN count(c) AS cnt`,
        { domain, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() },
      );
      const newClaims = toNumber(newClaimsResult.records[0]?.get("cnt"));

      // Count updated claims (updated_at > created_at within period)
      const updatedClaimsResult = await session.run(
        `MATCH (c:Claim {domain: $domain})
         WHERE c.updated_at >= $periodStart AND c.updated_at <= $periodEnd
           AND c.updated_at <> c.created_at
         RETURN count(c) AS cnt`,
        { domain, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() },
      );
      const updatedClaims = toNumber(updatedClaimsResult.records[0]?.get("cnt"));

      // Count new contradictions
      const contradictionsResult = await session.run(
        `MATCH (c1:Claim {domain: $domain})-[r:CONTRADICTS]-(c2:Claim)
         WHERE r.created_at >= $periodStart AND r.created_at <= $periodEnd
         RETURN count(DISTINCT r) AS cnt`,
        { domain, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() },
      );
      const newContradictions = toNumber(contradictionsResult.records[0]?.get("cnt"));

      // Count resolved questions
      const resolvedResult = await session.run(
        `MATCH (oq:OpenQuestion {domain: $domain})
         WHERE oq.status = 'resolved'
           AND oq.resolved_at >= $periodStart AND oq.resolved_at <= $periodEnd
         RETURN count(oq) AS cnt`,
        { domain, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() },
      );
      const resolvedQuestions = toNumber(resolvedResult.records[0]?.get("cnt"));

      // Fetch key changes — most recent claims
      const keyChangesResult = await session.run(
        `MATCH (c:Claim {domain: $domain})
         WHERE c.created_at >= $periodStart AND c.created_at <= $periodEnd
         RETURN c.content AS content
         ORDER BY c.created_at DESC
         LIMIT 5`,
        { domain, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() },
      );
      const keyChanges = keyChangesResult.records.map(
        (r) => r.get("content") as string,
      );

      const summaryData: DomainSummaryData = {
        type: "domain_summary",
        domain,
        generated_at: formatDate(new Date()),
        period_start: formatDate(periodStart),
        period_end: formatDate(periodEnd),
        new_claims: newClaims,
        updated_claims: updatedClaims,
        new_contradictions: newContradictions,
        resolved_questions: resolvedQuestions,
        key_changes: keyChanges,
      };

      // Build markdown body
      const body = this.buildDomainSummaryBody(summaryData);

      // Write to vault
      const fileName = `DomainSummary_${slugify(domain)}_${periodEnd.toISOString().slice(0, 10)}.md`;
      let filePath: string | undefined;
      if (this.vault) {
        filePath = await this.vault.writeInsight(
          fileName,
          summaryData as unknown as Record<string, unknown>,
          body,
        );
      }

      return { generated: true, domain, file_path: filePath };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { generated: false, domain, error: msg };
    } finally {
      await session.close();
    }
  }

  /**
   * Get claim velocity per domain for a given period.
   */
  async getDomainVelocities(
    periodEnd: Date = new Date(),
    periodDays: number = 7,
  ): Promise<DomainVelocity[]> {
    if (!this.connection) return [];

    const periodStart = new Date(periodEnd.getTime() - periodDays * 24 * 60 * 60 * 1000);
    const todayStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000);
    const session = this.connection.session();

    try {
      const result = await session.run(
        `MATCH (c:Claim)
         WHERE c.created_at >= $periodStart AND c.created_at <= $periodEnd
         WITH c.domain AS domain,
              count(c) AS total,
              sum(CASE WHEN c.created_at >= $todayStart THEN 1 ELSE 0 END) AS today
         RETURN domain, total, today
         ORDER BY total DESC`,
        {
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
          todayStart: todayStart.toISOString(),
        },
      );

      return result.records.map((r) => ({
        domain: r.get("domain") as string,
        claims_today: toNumber(r.get("today")),
        claims_in_period: toNumber(r.get("total")),
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Build the markdown body for a domain summary.
   */
  private buildDomainSummaryBody(data: DomainSummaryData): string {
    const lines: string[] = [];
    lines.push(`# Domain Summary: ${data.domain}\n`);
    lines.push(`Period: ${data.period_start.slice(0, 10)} to ${data.period_end.slice(0, 10)}\n`);
    lines.push("## Activity\n");
    lines.push(`- **New claims:** ${data.new_claims}`);
    lines.push(`- **Updated claims:** ${data.updated_claims}`);
    lines.push(`- **New contradictions:** ${data.new_contradictions}`);
    lines.push(`- **Resolved questions:** ${data.resolved_questions}`);
    lines.push("");

    if (data.key_changes.length > 0) {
      lines.push("## Key Changes\n");
      for (const change of data.key_changes) {
        lines.push(`- ${change}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  // ── Pre-Context Package Generation ──────────────────────────────────

  /**
   * Generate pre-context packages for upcoming calendar events.
   * Accepts calendar events and assembles relevant knowledge for each.
   */
  async generatePreContextPackages(
    events: CalendarEvent[],
  ): Promise<PreContextResult[]> {
    const start = Date.now();
    const results: PreContextResult[] = [];

    if (!this.connection) {
      return [{ generated: false, event_title: "", error: "No Neo4j connection" }];
    }

    const now = new Date();
    const windowEnd = new Date(now.getTime() + this.preContextWindowHours * 60 * 60 * 1000);

    for (const event of events) {
      const eventStart = new Date(event.start);
      // Only generate for events within the pre-context window (24-48 hours)
      if (eventStart >= now && eventStart <= windowEnd) {
        const result = await this.generatePreContextPackage(event);
        results.push(result);
      }
    }

    await this.emitEvent("pre_context_generation", "success", {
      events_checked: events.length,
      packages_generated: results.filter((r) => r.generated).length,
      latency_ms: Date.now() - start,
    });

    return results;
  }

  /**
   * Generate a pre-context package for a single calendar event.
   */
  async generatePreContextPackage(event: CalendarEvent): Promise<PreContextResult> {
    if (!this.connection) {
      return { generated: false, event_title: event.title, error: "No Neo4j connection" };
    }

    const session = this.connection.session();

    try {
      // Extract keywords from event title and description
      const keywords = this.extractEventKeywords(event);

      // Find claims about attendees
      const attendeeClaims = await this.findAttendeeClaims(session, event.attendees);

      // Find claims about topics mentioned in the event
      const topicClaims = await this.findTopicClaims(session, keywords);

      // Find relevant bets
      const bets = await this.findRelevantBets(session, keywords);

      // Find open questions in relevant domains
      const openQuestions = await this.findRelevantOpenQuestions(session, keywords);

      const preContextData: PreContextData = {
        type: "pre_context_package",
        event_title: event.title,
        event_start: event.start,
        generated_at: formatDate(new Date()),
        attendee_claims: attendeeClaims.length,
        topic_claims: topicClaims.length,
        relevant_bets: bets.length,
        open_questions: openQuestions.length,
      };

      // Build markdown body
      const body = this.buildPreContextBody(event, attendeeClaims, topicClaims, bets, openQuestions);

      // Write to vault
      const fileName = `PreContext_${slugify(event.title)}_${event.start.slice(0, 10)}.md`;
      let filePath: string | undefined;
      if (this.vault) {
        filePath = await this.vault.writeInsight(
          fileName,
          preContextData as unknown as Record<string, unknown>,
          body,
        );
      }

      return { generated: true, event_title: event.title, file_path: filePath };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { generated: false, event_title: event.title, error: msg };
    } finally {
      await session.close();
    }
  }

  /**
   * Extract keywords from an event title and description.
   */
  extractEventKeywords(event: CalendarEvent): string[] {
    const text = `${event.title} ${event.description ?? ""}`;
    // Extract words that look like proper nouns or significant terms (>2 chars, not common words)
    const stopWords = new Set([
      "the", "and", "for", "with", "about", "from", "that", "this", "will",
      "are", "was", "has", "had", "have", "been", "being", "would", "should",
      "could", "their", "there", "where", "when", "what", "which", "who",
      "how", "not", "but", "can", "may", "its", "our", "your", "his", "her",
      "meeting", "call", "sync", "update", "review",
    ]);

    return text
      .split(/\s+/)
      .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
      .filter((w) => w.length > 2 && !stopWords.has(w.toLowerCase()));
  }

  /**
   * Find claims about event attendees.
   */
  private async findAttendeeClaims(
    session: import("neo4j-driver").Session,
    attendees: string[],
  ): Promise<PreContextClaim[]> {
    if (attendees.length === 0) return [];

    const result = await session.run(
      `UNWIND $attendees AS attendee
       MATCH (c:Claim)-[:ABOUT]->(e:Entity)
       WHERE toLower(e.name) CONTAINS toLower(attendee)
       RETURN c.id AS id, c.content AS content, c.domain AS domain,
              c.truth_tier AS truth_tier, e.name AS entity_name
       LIMIT 20`,
      { attendees },
    );

    return result.records.map((r) => ({
      id: r.get("id") ?? randomUUID(),
      content: r.get("content") ?? "",
      domain: r.get("domain") ?? "general",
      truth_tier: r.get("truth_tier") ?? "agent_inferred",
      entity_name: r.get("entity_name") ?? "",
    }));
  }

  /**
   * Find claims about topics matching event keywords.
   */
  private async findTopicClaims(
    session: import("neo4j-driver").Session,
    keywords: string[],
  ): Promise<PreContextClaim[]> {
    if (keywords.length === 0) return [];

    // Use full-text search if available, otherwise regex match
    const pattern = keywords.map((k) => `(?i).*${k}.*`).join("|");
    const result = await session.run(
      `MATCH (c:Claim)-[:ABOUT]->(e:Entity)
       WHERE any(kw IN $keywords WHERE toLower(c.content) CONTAINS toLower(kw))
          OR any(kw IN $keywords WHERE toLower(e.name) CONTAINS toLower(kw))
       RETURN DISTINCT c.id AS id, c.content AS content, c.domain AS domain,
              c.truth_tier AS truth_tier, e.name AS entity_name
       LIMIT 30`,
      { keywords },
    );

    return result.records.map((r) => ({
      id: r.get("id") ?? randomUUID(),
      content: r.get("content") ?? "",
      domain: r.get("domain") ?? "general",
      truth_tier: r.get("truth_tier") ?? "agent_inferred",
      entity_name: r.get("entity_name") ?? "",
    }));
  }

  /**
   * Find bets relevant to event keywords.
   */
  private async findRelevantBets(
    session: import("neo4j-driver").Session,
    keywords: string[],
  ): Promise<PreContextBet[]> {
    if (keywords.length === 0) return [];

    const result = await session.run(
      `MATCH (b:Bet)
       WHERE any(kw IN $keywords WHERE toLower(b.description) CONTAINS toLower(kw))
       RETURN b.description AS description, b.risk_level AS risk_level
       LIMIT 10`,
      { keywords },
    );

    return result.records.map((r) => ({
      description: r.get("description") ?? "",
      risk_level: r.get("risk_level") ?? "medium",
    }));
  }

  /**
   * Find open questions relevant to event keywords.
   */
  private async findRelevantOpenQuestions(
    session: import("neo4j-driver").Session,
    keywords: string[],
  ): Promise<PreContextQuestion[]> {
    if (keywords.length === 0) return [];

    const result = await session.run(
      `MATCH (oq:OpenQuestion)
       WHERE oq.status = 'open'
         AND any(kw IN $keywords WHERE toLower(oq.question) CONTAINS toLower(kw))
       RETURN oq.question AS question, oq.domain AS domain, oq.priority AS priority
       LIMIT 10`,
      { keywords },
    );

    return result.records.map((r) => ({
      question: r.get("question") ?? "",
      domain: r.get("domain") ?? "general",
      priority: r.get("priority") ?? "medium",
    }));
  }

  /**
   * Build the markdown body for a pre-context package.
   */
  private buildPreContextBody(
    event: CalendarEvent,
    attendeeClaims: PreContextClaim[],
    topicClaims: PreContextClaim[],
    bets: PreContextBet[],
    openQuestions: PreContextQuestion[],
  ): string {
    const lines: string[] = [];
    lines.push(`# Pre-Context Package: ${event.title}\n`);
    lines.push(`**Event:** ${event.start}\n`);

    if (event.attendees.length > 0) {
      lines.push(`**Attendees:** ${event.attendees.join(", ")}\n`);
    }

    if (attendeeClaims.length > 0) {
      lines.push("## Attendee Context\n");
      for (const c of attendeeClaims) {
        lines.push(`- [[${c.id}]] ${c.content} *(${c.truth_tier})*`);
      }
      lines.push("");
    }

    if (topicClaims.length > 0) {
      lines.push("## Topic Context\n");
      for (const c of topicClaims) {
        lines.push(`- [[${c.id}]] ${c.content} *(${c.truth_tier})*`);
      }
      lines.push("");
    }

    if (bets.length > 0) {
      lines.push("## Relevant Bets\n");
      for (const b of bets) {
        lines.push(`- **[${b.risk_level}]** ${b.description}`);
      }
      lines.push("");
    }

    if (openQuestions.length > 0) {
      lines.push("## Open Questions\n");
      for (const q of openQuestions) {
        lines.push(`- [${q.priority}] ${q.question} *(${q.domain})*`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  // ── Telemetry ───────────────────────────────────────────────────────

  private async emitEvent(
    subtype: string,
    outcome: "success" | "failure" | "partial" | "skipped",
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!this.emitter) return;
    try {
      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_write",
        event_subtype: subtype,
        session_id: this.sessionId,
        outcome,
        metadata,
      });
    } catch {
      // Non-blocking
    }
  }
}

// ── Utility ──────────────────────────────────────────────────────────

function toNumber(val: unknown): number {
  if (val == null) return 0;
  if (typeof val === "number") return val;
  if (typeof val === "object" && val !== null && "toNumber" in val) {
    return (val as { toNumber: () => number }).toNumber();
  }
  return Number(val) || 0;
}
