/**
 * AQM Stage 1 — Schema Inspection
 *
 * Runs Cypher queries to discover relevant node labels, relationship types,
 * property keys, and data density for the question's domain. Produces a
 * SchemaContext object consumed by the Query Constructor (Stage 2).
 */

import { type Session } from "neo4j-driver";
import type { Neo4jConnection } from "../neo4j.js";
import type { TelemetryEmitter } from "../../telemetry/emitter.js";
import { randomUUID } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SchemaContext {
  labels: string[];
  relationshipTypes: string[];
  propertyKeys: Record<string, string[]>; // label → property keys
  nodeCounts: Record<string, number>; // label → count
  sampleData: Record<string, Record<string, unknown>[]>; // label → sample nodes
  domainFilter?: string;
}

export interface SchemaInspectorOptions {
  connection?: Neo4jConnection;
  emitter?: TelemetryEmitter;
  sampleSize?: number; // default: 3
}

// ── Schema Inspector ───────────────────────────────────────────────────────

export class SchemaInspector {
  private readonly connection: Neo4jConnection | null;
  private readonly emitter: TelemetryEmitter | null;
  private readonly sampleSize: number;
  private readonly sessionId: string;

  constructor(options?: SchemaInspectorOptions) {
    this.connection = options?.connection ?? null;
    this.emitter = options?.emitter ?? null;
    this.sampleSize = options?.sampleSize ?? 3;
    this.sessionId = randomUUID();
  }

  /**
   * Inspect the graph schema, optionally filtering to a specific domain.
   */
  async inspect(domain?: string): Promise<SchemaContext> {
    const start = Date.now();

    if (!this.connection) {
      return this.emptyContext(domain);
    }

    const session = this.connection.session();
    try {
      const [labels, relationshipTypes, nodeCounts, propertyKeys, sampleData] =
        await Promise.all([
          this.getLabels(session),
          this.getRelationshipTypes(session),
          this.getNodeCounts(session),
          this.getPropertyKeys(session),
          this.getSampleData(session, domain),
        ]);

      const context: SchemaContext = {
        labels,
        relationshipTypes,
        propertyKeys,
        nodeCounts,
        sampleData,
        domainFilter: domain,
      };

      await this.emitEvent("schema_inspection_complete", "success", {
        label_count: labels.length,
        relationship_type_count: relationshipTypes.length,
        domain,
        latency_ms: Date.now() - start,
      });

      return context;
    } catch (error) {
      await this.emitEvent("schema_inspection_error", "failure", {
        error: error instanceof Error ? error.message : String(error),
        domain,
        latency_ms: Date.now() - start,
      });
      return this.emptyContext(domain);
    } finally {
      await session.close();
    }
  }

  /**
   * Inspect schema focused on entities relevant to a question.
   * Extracts entity-like nouns from the question and fetches their property keys & samples.
   */
  async inspectForQuestion(question: string): Promise<SchemaContext> {
    const start = Date.now();

    if (!this.connection) {
      return this.emptyContext();
    }

    const session = this.connection.session();
    try {
      // Get full schema context first
      const [labels, relationshipTypes, nodeCounts] = await Promise.all([
        this.getLabels(session),
        this.getRelationshipTypes(session),
        this.getNodeCounts(session),
      ]);

      // Get property keys for all labels (needed by query constructor)
      const propertyKeys = await this.getPropertyKeys(session);

      // Get sample data relevant to the question
      const sampleData = await this.getQuestionRelevantSamples(
        session,
        question,
      );

      const context: SchemaContext = {
        labels,
        relationshipTypes,
        propertyKeys,
        nodeCounts,
        sampleData,
      };

      await this.emitEvent("schema_inspection_for_question", "success", {
        question_length: question.length,
        label_count: labels.length,
        sample_labels: Object.keys(sampleData),
        latency_ms: Date.now() - start,
      });

      return context;
    } catch (error) {
      await this.emitEvent("schema_inspection_error", "failure", {
        error: error instanceof Error ? error.message : String(error),
        latency_ms: Date.now() - start,
      });
      return this.emptyContext();
    } finally {
      await session.close();
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private async getLabels(session: Session): Promise<string[]> {
    const result = await session.run("CALL db.labels()");
    return result.records.map(
      (r) => r.get("label") as string,
    );
  }

  private async getRelationshipTypes(session: Session): Promise<string[]> {
    const result = await session.run("CALL db.relationshipTypes()");
    return result.records.map(
      (r) => r.get("relationshipType") as string,
    );
  }

  private async getNodeCounts(
    session: Session,
  ): Promise<Record<string, number>> {
    const result = await session.run(
      "CALL db.labels() YIELD label " +
        "CALL { WITH label " +
        "  MATCH (n) WHERE label IN labels(n) " +
        "  RETURN count(n) AS cnt " +
        "} RETURN label, cnt",
    );

    const counts: Record<string, number> = {};
    for (const record of result.records) {
      const label = record.get("label") as string;
      const cnt = record.get("cnt");
      counts[label] =
        typeof cnt === "object" && cnt?.toNumber
          ? cnt.toNumber()
          : Number(cnt);
    }
    return counts;
  }

  private async getPropertyKeys(
    session: Session,
  ): Promise<Record<string, string[]>> {
    const result = await session.run(
      "CALL db.labels() YIELD label " +
        "CALL { WITH label " +
        "  MATCH (n) WHERE label IN labels(n) " +
        "  WITH n LIMIT 1 " +
        "  RETURN keys(n) AS props " +
        "} RETURN label, props",
    );

    const propertyKeys: Record<string, string[]> = {};
    for (const record of result.records) {
      const label = record.get("label") as string;
      const props = record.get("props");
      propertyKeys[label] = Array.isArray(props) ? (props as string[]) : [];
    }
    return propertyKeys;
  }

  private async getSampleData(
    session: Session,
    domain?: string,
  ): Promise<Record<string, Record<string, unknown>[]>> {
    const sampleData: Record<string, Record<string, unknown>[]> = {};

    // For each label, get sample nodes
    const labelsResult = await session.run("CALL db.labels()");
    const labels = labelsResult.records.map(
      (r) => r.get("label") as string,
    );

    for (const label of labels) {
      const cypher = domain
        ? `MATCH (n:\`${label}\`) WHERE n.domain = $domain RETURN properties(n) AS props LIMIT $limit`
        : `MATCH (n:\`${label}\`) RETURN properties(n) AS props LIMIT $limit`;

      const params = domain
        ? { domain, limit: this.sampleSize }
        : { limit: this.sampleSize };

      const result = await session.run(cypher, params);
      if (result.records.length > 0) {
        sampleData[label] = result.records.map(
          (r) => r.get("props") as Record<string, unknown>,
        );
      }
    }

    return sampleData;
  }

  private async getQuestionRelevantSamples(
    session: Session,
    question: string,
  ): Promise<Record<string, Record<string, unknown>[]>> {
    const sampleData: Record<string, Record<string, unknown>[]> = {};

    // Get samples from key node labels that are likely relevant to questions
    const relevantLabels = ["Claim", "Entity", "Source", "OpenQuestion", "Bet"];

    for (const label of relevantLabels) {
      try {
        // Try full-text search first for Claim nodes
        if (label === "Claim") {
          const ftResult = await session.run(
            "CALL db.index.fulltext.queryNodes('claim_fulltext', $query) " +
              "YIELD node, score " +
              "RETURN properties(node) AS props, score " +
              "ORDER BY score DESC LIMIT $limit",
            { query: question, limit: this.sampleSize },
          );

          if (ftResult.records.length > 0) {
            sampleData[label] = ftResult.records.map(
              (r) => r.get("props") as Record<string, unknown>,
            );
            continue;
          }
        }

        // Fallback: get generic samples
        const result = await session.run(
          `MATCH (n:\`${label}\`) RETURN properties(n) AS props LIMIT $limit`,
          { limit: this.sampleSize },
        );
        if (result.records.length > 0) {
          sampleData[label] = result.records.map(
            (r) => r.get("props") as Record<string, unknown>,
          );
        }
      } catch {
        // Full-text index may not exist — skip silently
      }
    }

    return sampleData;
  }

  private emptyContext(domain?: string): SchemaContext {
    return {
      labels: [],
      relationshipTypes: [],
      propertyKeys: {},
      nodeCounts: {},
      sampleData: {},
      domainFilter: domain,
    };
  }

  private async emitEvent(
    subtype: string,
    outcome: "success" | "failure" | "partial" | "skipped",
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!this.emitter) return;
    try {
      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_query",
        event_subtype: subtype,
        session_id: this.sessionId,
        outcome,
        metadata,
      });
    } catch {
      // Non-blocking — telemetry failure never blocks operations
    }
  }
}
