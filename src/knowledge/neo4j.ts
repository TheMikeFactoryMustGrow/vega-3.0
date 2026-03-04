import neo4j, { type Driver, type Session } from "neo4j-driver";
import { TelemetryEmitter } from "../telemetry/emitter.js";

export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
  maxConnectionPoolSize?: number;
}

export interface HealthCheckResult {
  connected: boolean;
  version: string;
  nodeCount: number;
}

/**
 * Neo4jConnection — Manages Neo4j driver lifecycle and provides session access.
 *
 * Uses environment variables:
 *   NEO4J_URI (default: bolt://localhost:7687)
 *   NEO4J_USER (default: neo4j)
 *   NEO4J_PASSWORD (required)
 *
 * All operations emit telemetry via TelemetryEmitter.
 */
export class Neo4jConnection {
  private readonly driver: Driver;
  private readonly emitter: TelemetryEmitter;
  private readonly sessionId: string;

  constructor(
    config?: Partial<Neo4jConfig>,
    emitter?: TelemetryEmitter,
  ) {
    const uri = config?.uri ?? process.env.NEO4J_URI ?? "bolt://localhost:7687";
    const user = config?.user ?? process.env.NEO4J_USER ?? "neo4j";
    const password = config?.password ?? process.env.NEO4J_PASSWORD;

    if (!password) {
      throw new Error("NEO4J_PASSWORD is required (set via config or environment variable)");
    }

    this.driver = neo4j.driver(
      uri,
      neo4j.auth.basic(user, password),
      { maxConnectionPoolSize: config?.maxConnectionPoolSize ?? 25 },
    );

    this.emitter = emitter ?? new TelemetryEmitter();
    this.sessionId = `neo4j-${Date.now()}`;
  }

  /** Get a new Neo4j session for running queries */
  session(database?: string): Session {
    return this.driver.session({ database: database ?? "neo4j" });
  }

  /** Health check — returns connection status, version, and node count */
  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    const sess = this.session();
    try {
      const versionResult = await sess.run(
        "CALL dbms.components() YIELD name, versions RETURN versions[0] AS version",
      );
      const version = versionResult.records[0]?.get("version") ?? "unknown";

      const countResult = await sess.run(
        "MATCH (n) RETURN count(n) AS cnt",
      );
      const nodeCount = countResult.records[0]?.get("cnt")?.toNumber?.() ?? 0;

      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_query",
        event_subtype: "neo4j_health_check",
        session_id: this.sessionId,
        outcome: "success",
        latency_ms: Date.now() - start,
        metadata: { version, nodeCount },
      });

      return { connected: true, version, nodeCount };
    } catch (err) {
      await this.emitter.emit({
        agent_name: "knowledge_agent",
        event_type: "knowledge_query",
        event_subtype: "neo4j_health_check",
        session_id: this.sessionId,
        outcome: "failure",
        latency_ms: Date.now() - start,
        metadata: { error: String(err) },
      });

      return { connected: false, version: "unknown", nodeCount: 0 };
    } finally {
      await sess.close();
    }
  }

  /** Close the driver and release all connections */
  async close(): Promise<void> {
    await this.driver.close();
  }

  /** Get the underlying driver (for advanced usage) */
  getDriver(): Driver {
    return this.driver;
  }
}
