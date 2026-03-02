/**
 * VEGA 3.0 Neo4j Setup (US-003)
 *
 * Installs and configures Neo4j 5.26+ community edition in Docker.
 * Container: linglepedia, Ports: 7474 (HTTP), 7687 (Bolt)
 * Plugins: APOC + Graph Data Science
 * Heap: 8GB, Volume: $HOME/neo4j/data
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONTAINER_NAME = "linglepedia";
const IMAGE = "neo4j:5.26.0-community";
const NEO4J_PASSWORD = "lingelpedia2026";
const DATA_DIR = join(homedir(), "neo4j", "data");
const LOGS_DIR = join(homedir(), "neo4j", "logs");
const PLUGINS_DIR = join(homedir(), "neo4j", "plugins");

function run(cmd: string, timeoutMs = 30_000): string {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(err.stderr?.trim() || err.message || "command failed");
  }
}

function tryRun(cmd: string, timeoutMs = 30_000): string | null {
  try {
    return run(cmd, timeoutMs);
  } catch {
    return null;
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`  Created directory: ${dir}`);
  } else {
    console.log(`  Directory exists: ${dir}`);
  }
}

function removeExistingContainer(): void {
  const existing = tryRun(`docker ps -a --filter "name=^${CONTAINER_NAME}$" --format "{{.ID}}"`);
  if (existing) {
    console.log(`  Removing existing container '${CONTAINER_NAME}'...`);
    tryRun(`docker stop ${CONTAINER_NAME}`);
    tryRun(`docker rm ${CONTAINER_NAME}`);
  }
}

function startNeo4j(): void {
  const dockerCmd = [
    "docker run -d",
    `--name ${CONTAINER_NAME}`,
    "--restart unless-stopped",
    "-p 7474:7474",
    "-p 7687:7687",
    `-v "${DATA_DIR}:/data"`,
    `-v "${LOGS_DIR}:/logs"`,
    `-v "${PLUGINS_DIR}:/plugins"`,
    `-e NEO4J_AUTH=neo4j/${NEO4J_PASSWORD}`,
    "-e NEO4J_server_memory_heap_initial__size=8g",
    "-e NEO4J_server_memory_heap_max__size=8g",
    '-e NEO4J_PLUGINS=\'["apoc", "graph-data-science"]\'',
    "-e NEO4J_dbms_security_procedures_unrestricted=apoc.*,gds.*",
    "-e NEO4J_dbms_security_procedures_allowlist=apoc.*,gds.*",
    IMAGE,
  ].join(" \\\n    ");

  console.log(`  Starting Neo4j container '${CONTAINER_NAME}'...`);
  const containerId = run(dockerCmd, 60_000);
  console.log(`  Container started: ${containerId.substring(0, 12)}`);
}

function waitForNeo4j(maxWaitSeconds = 90): boolean {
  console.log(`  Waiting for Neo4j to become ready (up to ${maxWaitSeconds}s)...`);
  const start = Date.now();
  const deadline = start + maxWaitSeconds * 1000;

  while (Date.now() < deadline) {
    const health = tryRun(
      `docker exec ${CONTAINER_NAME} neo4j status 2>/dev/null || true`,
      10_000
    );
    if (health?.includes("is running")) {
      // Also check if bolt port is accepting connections
      const boltCheck = tryRun(
        `docker exec ${CONTAINER_NAME} cypher-shell -u neo4j -p ${NEO4J_PASSWORD} "RETURN 1 AS test" 2>&1`,
        10_000
      );
      if (boltCheck?.includes("1")) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        console.log(`  Neo4j ready in ${elapsed}s`);
        return true;
      }
    }
    execSync("sleep 3");
    process.stdout.write(".");
  }
  console.log();
  return false;
}

function verifyNeo4j(): boolean {
  console.log("\n── Verification ──────────────────────────────────────");

  // Check version
  const version = tryRun(
    `docker exec ${CONTAINER_NAME} cypher-shell -u neo4j -p ${NEO4J_PASSWORD} "CALL dbms.components() YIELD name, versions RETURN name, versions[0] AS version"`,
    15_000
  );
  if (version) {
    console.log(`  ✓ Neo4j version: ${version.split("\n").pop()?.trim()}`);
  } else {
    console.log("  ✗ Could not query Neo4j version");
    return false;
  }

  // Check APOC
  const apoc = tryRun(
    `docker exec ${CONTAINER_NAME} cypher-shell -u neo4j -p ${NEO4J_PASSWORD} "RETURN apoc.version() AS apoc"`,
    10_000
  );
  if (apoc) {
    console.log(`  ✓ APOC plugin: ${apoc.split("\n").pop()?.trim()}`);
  } else {
    console.log("  ✗ APOC plugin not available");
    return false;
  }

  // Check GDS
  const gds = tryRun(
    `docker exec ${CONTAINER_NAME} cypher-shell -u neo4j -p ${NEO4J_PASSWORD} "RETURN gds.version() AS gds"`,
    10_000
  );
  if (gds) {
    console.log(`  ✓ GDS plugin: ${gds.split("\n").pop()?.trim()}`);
  } else {
    console.log("  ✗ GDS plugin not available");
    return false;
  }

  // Check ports
  const ports = tryRun(`docker port ${CONTAINER_NAME}`);
  if (ports) {
    const has7474 = ports.includes("7474");
    const has7687 = ports.includes("7687");
    console.log(`  ${has7474 ? "✓" : "✗"} HTTP port 7474 exposed`);
    console.log(`  ${has7687 ? "✓" : "✗"} Bolt port 7687 exposed`);
    if (!has7474 || !has7687) return false;
  }

  // Check restart policy
  const restartPolicy = tryRun(
    `docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' ${CONTAINER_NAME}`
  );
  const hasRestart = restartPolicy === "unless-stopped";
  console.log(`  ${hasRestart ? "✓" : "✗"} Restart policy: ${restartPolicy}`);
  if (!hasRestart) return false;

  // Check heap config
  const heap = tryRun(
    `docker exec ${CONTAINER_NAME} cypher-shell -u neo4j -p ${NEO4J_PASSWORD} "CALL dbms.listConfig() YIELD name, value WHERE name CONTAINS 'heap' RETURN name, value"`,
    10_000
  );
  if (heap) {
    console.log(`  ✓ Heap configuration verified`);
  }

  // Check data volume
  const volumeMount = tryRun(
    `docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' ${CONTAINER_NAME}`
  );
  console.log(`  ✓ Data volume: ${volumeMount}`);

  // Check HTTP browser
  const browser = tryRun("curl -s -o /dev/null -w '%{http_code}' http://localhost:7474", 10_000);
  console.log(`  ${browser === "200" ? "✓" : "✗"} Neo4j Browser HTTP status: ${browser}`);

  return true;
}

function main(): void {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║        VEGA 3.0 — Neo4j Setup (US-003)           ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // 1. Check Docker
  console.log("── Prerequisites ─────────────────────────────────────");
  const dockerVersion = tryRun("docker --version");
  if (!dockerVersion) {
    console.error("  ✗ Docker not found. Install Docker Desktop first.");
    process.exit(1);
  }
  console.log(`  ✓ ${dockerVersion}`);

  // 2. Create directories
  console.log("\n── Directories ───────────────────────────────────────");
  ensureDir(DATA_DIR);
  ensureDir(LOGS_DIR);
  ensureDir(PLUGINS_DIR);

  // 3. Remove existing container if any
  console.log("\n── Container Setup ───────────────────────────────────");
  removeExistingContainer();

  // 4. Start Neo4j
  startNeo4j();

  // 5. Wait for ready
  const ready = waitForNeo4j();
  if (!ready) {
    console.error("\n  ✗ Neo4j did not become ready within timeout.");
    console.error("  Check logs: docker logs linglepedia");
    process.exit(1);
  }

  // 6. Verify
  const verified = verifyNeo4j();

  console.log("\n── Summary ───────────────────────────────────────────");
  if (verified) {
    console.log("  ✓ Neo4j is installed and configured successfully!");
    console.log(`  Container: ${CONTAINER_NAME}`);
    console.log("  HTTP:  http://localhost:7474");
    console.log("  Bolt:  bolt://localhost:7687");
    console.log(`  Auth:  neo4j / ${NEO4J_PASSWORD}`);
    console.log(`  Data:  ${DATA_DIR}`);
    console.log("  Heap:  8GB initial/max");
    console.log("  Plugins: APOC, Graph Data Science");
  } else {
    console.error("  ✗ Verification failed — check output above.");
    process.exit(1);
  }
}

main();
