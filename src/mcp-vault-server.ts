/**
 * VEGA 3.0 — Obsidian Vault MCP Server (US-006)
 *
 * Custom MCP server providing filesystem access to the Lingelpedia Obsidian vault
 * with FSEvents-based file watching and 60-second polling fallback.
 *
 * Tools: list_directory, read_file, write_file, search_files, get_changed_files
 * Transport: Streamable HTTP on 127.0.0.1:8766/mcp
 * Vault: ~/Library/Mobile Documents/com~apple~CloudDocs/Lingelpedia
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// --- Configuration ---

const VAULT_PATH =
  process.env.VAULT_PATH ||
  path.join(
    process.env.HOME || "/Users/VEGA",
    "Library/Mobile Documents/com~apple~CloudDocs/Linglepedia",
  );
const INSIGHTS_DIR = "_agent_insights";
const PORT = parseInt(process.env.MCP_PORT || "8766", 10);
const HOST = process.env.MCP_HOST || "127.0.0.1";
const MCP_ENDPOINT = "/mcp";
const POLL_INTERVAL_MS = 60_000;
const MAX_CHANGES = 1000;

// --- File Change Tracking ---

interface FileChange {
  path: string;
  type: "created" | "modified" | "deleted";
  timestamp: number;
}

const recentChanges: FileChange[] = [];
let fileSnapshot = new Map<string, number>(); // relative path -> mtimeMs

function addChange(change: FileChange): void {
  recentChanges.push(change);
  if (recentChanges.length > MAX_CHANGES) {
    recentChanges.splice(0, recentChanges.length - MAX_CHANGES);
  }
}

// --- Path Validation ---

function resolveVaultPath(relativePath: string): string {
  const resolved = path.resolve(VAULT_PATH, relativePath);
  const normalizedVault = path.normalize(VAULT_PATH);
  const normalizedResolved = path.normalize(resolved);
  if (
    normalizedResolved !== normalizedVault &&
    !normalizedResolved.startsWith(normalizedVault + path.sep)
  ) {
    throw new Error(`Path outside vault: ${relativePath}`);
  }
  return resolved;
}

// --- Directory Scanning ---

async function scanDirectory(
  dirPath: string,
  basePath: string = "",
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relPath = basePath ? path.join(basePath, entry.name) : entry.name;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const sub = await scanDirectory(fullPath, relPath);
      for (const [k, v] of sub) result.set(k, v);
    } else if (entry.isFile()) {
      try {
        const stats = await fsp.stat(fullPath);
        result.set(relPath, stats.mtimeMs);
      } catch {
        // Skip files we can't stat (iCloud placeholders, etc.)
      }
    }
  }
  return result;
}

// --- FSEvents Watcher (macOS native via fs.watch recursive) ---

function startFSEventsWatcher(): fs.FSWatcher | null {
  try {
    const watcher = fs.watch(
      VAULT_PATH,
      { recursive: true },
      (_eventType, filename) => {
        if (!filename || filename.startsWith(".")) return;
        const fullPath = path.join(VAULT_PATH, filename);
        let changeType: FileChange["type"];
        try {
          fs.accessSync(fullPath);
          changeType = "modified";
        } catch {
          changeType = "deleted";
        }
        addChange({ path: filename, type: changeType, timestamp: Date.now() });
      },
    );
    watcher.on("error", (err) => {
      console.error("[FSEvents] Watcher error:", err.message);
    });
    console.log("[FSEvents] Watcher active on vault");
    return watcher;
  } catch (err) {
    console.error("[FSEvents] Failed to start:", err);
    return null;
  }
}

// --- Polling Fallback ---

async function pollForChanges(): Promise<void> {
  const newSnapshot = await scanDirectory(VAULT_PATH);

  for (const [filePath, mtime] of newSnapshot) {
    const oldMtime = fileSnapshot.get(filePath);
    if (oldMtime === undefined) {
      addChange({ path: filePath, type: "created", timestamp: mtime });
    } else if (mtime > oldMtime) {
      addChange({ path: filePath, type: "modified", timestamp: mtime });
    }
  }

  for (const filePath of fileSnapshot.keys()) {
    if (!newSnapshot.has(filePath)) {
      addChange({ path: filePath, type: "deleted", timestamp: Date.now() });
    }
  }

  fileSnapshot = newSnapshot;
}

function startPolling(): NodeJS.Timeout {
  const timer = setInterval(async () => {
    try {
      await pollForChanges();
    } catch (err) {
      console.error("[Polling] Error:", err);
    }
  }, POLL_INTERVAL_MS);
  console.log(`[Polling] Fallback active (${POLL_INTERVAL_MS / 1000}s)`);
  return timer;
}

// --- MCP Server Factory ---

function createVaultMcpServer(): McpServer {
  const server = new McpServer(
    { name: "vault-filesystem", version: "1.0.0" },
    {
      capabilities: { logging: {} },
      instructions: `Obsidian vault filesystem access for Lingelpedia. Vault root: ${VAULT_PATH}. Writes restricted to ${INSIGHTS_DIR}/.`,
    },
  );

  // Tool: list_directory
  server.registerTool(
    "list_directory",
    {
      description:
        "List files and directories in the Obsidian vault. Returns JSON array of {name, type} objects.",
      inputSchema: {
        path: z
          .string()
          .default("")
          .describe("Relative path within the vault (empty for root)"),
      },
    },
    async ({ path: relPath }) => {
      const fullPath = resolveVaultPath(relPath);
      const entries = await fsp.readdir(fullPath, { withFileTypes: true });
      const items = entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "directory" : "file",
        }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }],
      };
    },
  );

  // Tool: read_file
  server.registerTool(
    "read_file",
    {
      description:
        "Read a file from the Obsidian vault. Returns full text including YAML frontmatter.",
      inputSchema: {
        path: z
          .string()
          .describe("Relative path to the file within the vault"),
      },
    },
    async ({ path: relPath }) => {
      const fullPath = resolveVaultPath(relPath);
      const content = await fsp.readFile(fullPath, "utf-8");
      return { content: [{ type: "text" as const, text: content }] };
    },
  );

  // Tool: write_file
  server.registerTool(
    "write_file",
    {
      description:
        "Write a file to the _agent_insights/ directory in the vault. Only writes within _agent_insights/ are permitted.",
      inputSchema: {
        path: z
          .string()
          .describe(
            'Filename or subpath within _agent_insights/ (e.g. "2026-03-01_connection_gix-finance.md")',
          ),
        content: z.string().describe("File content to write"),
      },
    },
    async ({ path: relPath, content }) => {
      // Normalize: strip leading _agent_insights/ if already included
      const stripped = relPath.startsWith(INSIGHTS_DIR)
        ? relPath.slice(INSIGHTS_DIR.length + 1)
        : relPath;
      const insightPath = path.join(INSIGHTS_DIR, stripped);
      const normalized = path.normalize(insightPath);
      if (!normalized.startsWith(INSIGHTS_DIR)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: writes are only permitted within _agent_insights/",
            },
          ],
          isError: true,
        };
      }
      const fullPath = resolveVaultPath(insightPath);
      await fsp.mkdir(path.dirname(fullPath), { recursive: true });
      await fsp.writeFile(fullPath, content, "utf-8");
      return {
        content: [{ type: "text" as const, text: `Written: ${insightPath}` }],
      };
    },
  );

  // Tool: search_files
  server.registerTool(
    "search_files",
    {
      description:
        "Search for files in the vault by extension and/or name substring.",
      inputSchema: {
        directory: z
          .string()
          .default("")
          .describe("Subdirectory to search (empty for vault root)"),
        extension: z
          .string()
          .optional()
          .describe('File extension filter (e.g. ".md")'),
        contains: z
          .string()
          .optional()
          .describe("Substring the filename must contain"),
      },
    },
    async ({ directory, extension, contains }) => {
      const searchDir = resolveVaultPath(directory);
      const allFiles = await scanDirectory(searchDir, directory);
      const matched = [...allFiles.keys()].filter((f) => {
        if (extension && !f.endsWith(extension)) return false;
        if (
          contains &&
          !path.basename(f).toLowerCase().includes(contains.toLowerCase())
        )
          return false;
        return true;
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(matched, null, 2) },
        ],
      };
    },
  );

  // Tool: get_changed_files
  server.registerTool(
    "get_changed_files",
    {
      description:
        "Get files changed since a timestamp. Uses FSEvents for real-time detection with 60-second polling fallback.",
      inputSchema: {
        since: z
          .number()
          .default(0)
          .describe("Unix timestamp in ms. 0 = last 60 seconds."),
      },
    },
    async ({ since }) => {
      const threshold = since > 0 ? since : Date.now() - 60_000;
      const changes = recentChanges.filter((c) => c.timestamp > threshold);
      // Deduplicate: keep latest change per path
      const latest = new Map<string, FileChange>();
      for (const change of changes) {
        latest.set(change.path, change);
      }
      const deduplicated = [...latest.values()].sort(
        (a, b) => a.timestamp - b.timestamp,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(deduplicated, null, 2),
          },
        ],
      };
    },
  );

  return server;
}

// --- HTTP Server ---

async function main(): Promise<void> {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║  VEGA 3.0 — Vault Filesystem MCP Server (US-006)     ║");
  console.log("╚═══════════════════════════════════════════════════════╝");

  // Verify vault exists
  try {
    await fsp.access(VAULT_PATH);
    console.log(`\n[Vault] ${VAULT_PATH}`);
  } catch {
    console.error(`[Error] Vault not found: ${VAULT_PATH}`);
    process.exit(1);
  }

  // Ensure _agent_insights/ exists
  const insightsPath = path.join(VAULT_PATH, INSIGHTS_DIR);
  await fsp.mkdir(insightsPath, { recursive: true });
  console.log(`[Insights] ${insightsPath}`);

  // Start file watching
  startFSEventsWatcher();

  // Take initial snapshot and start polling
  fileSnapshot = await scanDirectory(VAULT_PATH);
  console.log(`[Snapshot] ${fileSnapshot.size} files indexed`);
  startPolling();

  // Create Express app
  const app = express();
  app.use(express.json());

  // MCP endpoint — stateless: fresh server + transport per request
  app.post(MCP_ENDPOINT, async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const server = createVaultMcpServer();
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[MCP] POST error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
      }
    }
  });

  app.get(MCP_ENDPOINT, (_req, res) => {
    res.status(405).json({ error: "GET not supported in stateless mode" });
  });

  app.delete(MCP_ENDPOINT, (_req, res) => {
    res.status(405).json({ error: "DELETE not supported in stateless mode" });
  });

  // Health endpoint
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      vault: VAULT_PATH,
      files: fileSnapshot.size,
      changes: recentChanges.length,
      uptime: process.uptime(),
    });
  });

  // Start listening
  app.listen(PORT, HOST, () => {
    console.log(`\n[Server] http://${HOST}:${PORT}${MCP_ENDPOINT}`);
    console.log(`[Health] http://${HOST}:${PORT}/health`);
  });

  // Graceful shutdown
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}

main().catch((err) => {
  console.error("[Fatal]", err);
  process.exit(1);
});
