/**
 * VEGA 3.0 — Google Drive MCP Server (US-011)
 *
 * Custom MCP server providing read-only access to Google Drive via the
 * Drive API v3. Access is scoped to GIX, WE, and Finance folders.
 * Supports Google Docs text export, Sheets metadata, PDF text extraction,
 * sliding window chunking for large documents, and incremental sync
 * via lastSyncTimestamp tracking.
 *
 * Tools: list_files, read_document, get_sync_status
 * Transport: Streamable HTTP on 127.0.0.1:8770/mcp
 * Auth: OAuth 2.0 (drive.readonly scope)
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// --- Configuration ---

const PORT = parseInt(process.env.MCP_PORT || "8770", 10);
const HOST = process.env.MCP_HOST || "127.0.0.1";
const MCP_ENDPOINT = "/mcp";

const CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH ||
  join(homedir(), "Library", "Application Support", "gogcli", "credentials.json");

const KEYCHAIN_SERVICE = "vega-google-drive";
const KEYCHAIN_ACCOUNT = "refresh_token";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

// Scoped folders — only these top-level folders are accessible
const SCOPED_FOLDER_NAMES = ["GIX", "WE", "Finance"];

// Sync timestamp tracking file
const SYNC_STATE_PATH = join(homedir(), ".vega", "drive-sync-state.json");

// Approximate tokens per character (rough estimate for English text)
const CHARS_PER_TOKEN = 4;
const MAX_TOKENS = 4000;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;
const CHUNK_TOKENS = 2000;
const CHUNK_CHARS = CHUNK_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_TOKENS = 200;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;

// --- OAuth Token Management ---

interface GoogleCredentials {
  client_id: string;
  client_secret: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  refresh_token?: string;
}

let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;

function loadCredentials(): GoogleCredentials {
  const raw = readFileSync(CREDENTIALS_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed.client_id || !parsed.client_secret) {
    throw new Error(`Missing client_id or client_secret in ${CREDENTIALS_PATH}`);
  }
  return parsed;
}

function getRefreshToken(): string {
  try {
    const result = execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -w`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (!result) throw new Error("Empty token");
    return result;
  } catch {
    throw new Error(
      `No refresh token in Keychain (service=${KEYCHAIN_SERVICE}). Run: npm run setup-google-drive-mcp`,
    );
  }
}

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const creds = loadCredentials();
  const refreshToken = getRefreshToken();

  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${errText}`);
  }

  const data = (await resp.json()) as TokenResponse;
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  console.log("[OAuth] Access token refreshed, expires in", data.expires_in, "s");
  return cachedAccessToken;
}

// --- Google Drive API ---

async function driveFetch(endpoint: string, params?: Record<string, string>): Promise<unknown> {
  const token = await getAccessToken();
  const url = new URL(`${DRIVE_API_BASE}${endpoint}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Drive API error (${resp.status}): ${errText}`);
  }

  return resp.json();
}

async function driveExport(fileId: string, mimeType: string): Promise<string> {
  const token = await getAccessToken();
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mimeType)}`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Drive export error (${resp.status}): ${errText}`);
  }

  return resp.text();
}

async function driveDownload(fileId: string): Promise<string> {
  const token = await getAccessToken();
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Drive download error (${resp.status}): ${errText}`);
  }

  return resp.text();
}

// --- Sync State ---

interface SyncState {
  folderTimestamps: Record<string, string>; // folderId -> ISO timestamp
}

function loadSyncState(): SyncState {
  try {
    if (existsSync(SYNC_STATE_PATH)) {
      return JSON.parse(readFileSync(SYNC_STATE_PATH, "utf-8")) as SyncState;
    }
  } catch {
    // Corrupted state — reset
  }
  return { folderTimestamps: {} };
}

function saveSyncState(state: SyncState): void {
  const dir = join(homedir(), ".vega");
  if (!existsSync(dir)) {
    execSync(`mkdir -p "${dir}"`);
  }
  writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// --- Folder Resolution ---

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  parents?: string[];
}

// Cache scoped folder IDs (resolved on first use)
let scopedFolderIds: Record<string, string> | null = null;

async function resolveScopedFolders(): Promise<Record<string, string>> {
  if (scopedFolderIds) return scopedFolderIds;

  scopedFolderIds = {};

  for (const folderName of SCOPED_FOLDER_NAMES) {
    const data = (await driveFetch("/files", {
      q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id,name)",
      pageSize: "5",
    })) as { files?: Array<{ id: string; name: string }> };

    if (data.files && data.files.length > 0) {
      scopedFolderIds[folderName] = data.files[0].id;
      console.log(`[Scope] Resolved folder '${folderName}' → ${data.files[0].id}`);
    } else {
      console.warn(`[Scope] Folder '${folderName}' not found in Drive`);
    }
  }

  return scopedFolderIds;
}

async function isInScopedFolder(fileId: string): Promise<boolean> {
  const folders = await resolveScopedFolders();
  const scopedIds = new Set(Object.values(folders));

  // Walk up the parent chain to check if any ancestor is a scoped folder
  let currentId = fileId;
  const visited = new Set<string>();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    if (scopedIds.has(currentId)) return true;

    try {
      const file = (await driveFetch(`/files/${encodeURIComponent(currentId)}`, {
        fields: "parents",
      })) as { parents?: string[] };

      if (!file.parents || file.parents.length === 0) break;
      currentId = file.parents[0];
    } catch {
      break;
    }
  }

  return false;
}

// --- Document Content Extraction ---

async function extractDocumentContent(file: DriveFile): Promise<string> {
  const { id, mimeType } = file;

  if (mimeType === "application/vnd.google-apps.document") {
    // Google Docs → export as plain text
    return driveExport(id, "text/plain");
  }

  if (mimeType === "application/vnd.google-apps.spreadsheet") {
    // Google Sheets → export as CSV for text representation
    const csv = await driveExport(id, "text/csv");
    return `[Google Sheets: ${file.name}]\n\n${csv}`;
  }

  if (mimeType === "application/vnd.google-apps.presentation") {
    // Google Slides → export as plain text
    return driveExport(id, "text/plain");
  }

  if (mimeType === "application/pdf") {
    // PDF → download raw content (text extraction is best-effort)
    // The Drive API doesn't do OCR, so we download and note limitation
    try {
      const content = await driveDownload(id);
      // PDF binary content — try to extract readable text
      const textContent = content.replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s{3,}/g, " ").trim();
      if (textContent.length > 100) {
        return `[PDF: ${file.name}]\n\n${textContent}`;
      }
      return `[PDF: ${file.name}] (binary content — text extraction limited without OCR)`;
    } catch {
      return `[PDF: ${file.name}] (unable to extract text)`;
    }
  }

  if (
    mimeType === "text/plain" ||
    mimeType === "text/markdown" ||
    mimeType === "text/csv" ||
    mimeType === "application/json" ||
    mimeType?.startsWith("text/")
  ) {
    // Plain text files → download directly
    return driveDownload(id);
  }

  // Unsupported format
  return `[${file.name}] (unsupported format: ${mimeType})`;
}

// --- Sliding Window Chunking ---

interface DocumentChunk {
  chunk_index: number;
  total_chunks: number;
  content: string;
  char_start: number;
  char_end: number;
}

function chunkDocument(content: string): DocumentChunk[] {
  if (content.length <= MAX_CHARS) {
    return [
      {
        chunk_index: 0,
        total_chunks: 1,
        content,
        char_start: 0,
        char_end: content.length,
      },
    ];
  }

  const chunks: DocumentChunk[] = [];
  let start = 0;

  while (start < content.length) {
    const end = Math.min(start + CHUNK_CHARS, content.length);
    chunks.push({
      chunk_index: chunks.length,
      total_chunks: 0, // filled in after loop
      content: content.substring(start, end),
      char_start: start,
      char_end: end,
    });

    if (end >= content.length) break;
    start = end - OVERLAP_CHARS;
  }

  // Fill in total_chunks
  for (const chunk of chunks) {
    chunk.total_chunks = chunks.length;
  }

  return chunks;
}

// --- MCP Server Factory ---

function createDriveMcpServer(): McpServer {
  const server = new McpServer(
    { name: "google-drive", version: "1.0.0" },
    {
      capabilities: { logging: {} },
      instructions:
        "Google Drive read-only access for Lingelpedia Agent. " +
        "Access is scoped to GIX, WE, and Finance folders. " +
        "Provides tools to list files, read document content (with chunking for large docs), " +
        "and check incremental sync status.",
    },
  );

  // Tool: list_files
  server.registerTool(
    "list_files",
    {
      description:
        "List files in a scoped Google Drive folder (GIX, WE, or Finance). " +
        "Returns file names, types, modification times, and sizes. " +
        "Supports filtering by folder name and optional query. " +
        "Use modified_after to get only files changed since a specific timestamp (incremental sync).",
      inputSchema: {
        folder: z
          .enum(["GIX", "WE", "Finance"])
          .describe("Scoped folder to list files from"),
        subfolder: z
          .string()
          .optional()
          .describe("Optional subfolder path within the scoped folder (e.g., 'Entities' or 'Meeting Notes')"),
        query: z
          .string()
          .optional()
          .describe("Optional search query to filter files by name or content"),
        modified_after: z
          .string()
          .optional()
          .describe("Only return files modified after this ISO timestamp (for incremental sync)"),
        max_results: z
          .number()
          .default(50)
          .describe("Maximum number of files to return (default: 50, max: 100)"),
      },
    },
    async ({ folder, subfolder, query, modified_after, max_results }) => {
      const folders = await resolveScopedFolders();
      const folderId = folders[folder];

      if (!folderId) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Folder '${folder}' not found in Google Drive` }),
            },
          ],
        };
      }

      // Resolve subfolder if specified
      let targetFolderId = folderId;
      if (subfolder) {
        const parts = subfolder.split("/");
        for (const part of parts) {
          const subData = (await driveFetch("/files", {
            q: `'${targetFolderId}' in parents and name='${part}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: "files(id,name)",
            pageSize: "1",
          })) as { files?: Array<{ id: string; name: string }> };

          if (!subData.files || subData.files.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ error: `Subfolder '${part}' not found in ${folder}/${subfolder}` }),
                },
              ],
            };
          }
          targetFolderId = subData.files[0].id;
        }
      }

      // Build query
      const maxResults = Math.min(max_results, 100);
      let q = `'${targetFolderId}' in parents and trashed=false`;
      if (query) {
        q += ` and (name contains '${query}' or fullText contains '${query}')`;
      }
      if (modified_after) {
        q += ` and modifiedTime > '${modified_after}'`;
      }

      const data = (await driveFetch("/files", {
        q,
        fields: "files(id,name,mimeType,modifiedTime,size,parents),nextPageToken",
        pageSize: String(maxResults),
        orderBy: "modifiedTime desc",
      })) as {
        files?: DriveFile[];
        nextPageToken?: string;
      };

      const files = (data.files || []).map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        modifiedTime: f.modifiedTime || "",
        size: f.size || "N/A",
        isGoogleDoc: f.mimeType === "application/vnd.google-apps.document",
        isGoogleSheet: f.mimeType === "application/vnd.google-apps.spreadsheet",
        isFolder: f.mimeType === "application/vnd.google-apps.folder",
      }));

      // Update sync timestamp for this folder
      const state = loadSyncState();
      state.folderTimestamps[targetFolderId] = new Date().toISOString();
      saveSyncState(state);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                folder,
                subfolder: subfolder || null,
                folderId: targetFolderId,
                count: files.length,
                hasMore: !!data.nextPageToken,
                files,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // Tool: read_document
  server.registerTool(
    "read_document",
    {
      description:
        "Read the full content of a Google Drive document by file ID. " +
        "Supports Google Docs (exported as text), Google Sheets (exported as CSV), " +
        "PDFs (best-effort text extraction), and plain text files. " +
        "Large documents (>4000 tokens) are automatically chunked into 2000-token segments " +
        "with 200-token overlap. Use chunk_index to retrieve specific chunks.",
      inputSchema: {
        file_id: z.string().describe("The Google Drive file ID (from list_files results)"),
        chunk_index: z
          .number()
          .optional()
          .describe("Specific chunk index to retrieve (0-based). Omit to get chunk 0 or the full document if small enough."),
      },
    },
    async ({ file_id, chunk_index }) => {
      // Verify the file is in a scoped folder
      const inScope = await isInScopedFolder(file_id);
      if (!inScope) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "File is not in a scoped folder (GIX, WE, or Finance). Access denied.",
              }),
            },
          ],
        };
      }

      // Get file metadata
      const file = (await driveFetch(`/files/${encodeURIComponent(file_id)}`, {
        fields: "id,name,mimeType,modifiedTime,size",
      })) as DriveFile;

      // Extract content
      const content = await extractDocumentContent(file);

      // Chunk if needed
      const chunks = chunkDocument(content);
      const requestedIndex = chunk_index ?? 0;

      if (requestedIndex >= chunks.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Chunk index ${requestedIndex} out of range (0-${chunks.length - 1})`,
              }),
            },
          ],
        };
      }

      const chunk = chunks[requestedIndex];

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                file_id: file.id,
                name: file.name,
                mimeType: file.mimeType,
                modifiedTime: file.modifiedTime || "",
                total_chars: content.length,
                estimated_tokens: Math.ceil(content.length / CHARS_PER_TOKEN),
                chunk_index: chunk.chunk_index,
                total_chunks: chunk.total_chunks,
                content: chunk.content,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // Tool: get_sync_status
  server.registerTool(
    "get_sync_status",
    {
      description:
        "Get the incremental sync status for scoped folders. " +
        "Shows the last sync timestamp per folder so you know which files to re-process. " +
        "Use the timestamps with list_files modified_after parameter for incremental indexing.",
      inputSchema: {},
    },
    async () => {
      const state = loadSyncState();
      const folders = await resolveScopedFolders();

      const status: Record<string, { folderId: string; lastSync: string | null }> = {};
      for (const [name, id] of Object.entries(folders)) {
        status[name] = {
          folderId: id,
          lastSync: state.folderTimestamps[id] || null,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                scoped_folders: SCOPED_FOLDER_NAMES,
                sync_status: status,
                sync_state_path: SYNC_STATE_PATH,
              },
              null,
              2,
            ),
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
  console.log("║  VEGA 3.0 — Google Drive MCP Server (US-011)         ║");
  console.log("╚═══════════════════════════════════════════════════════╝");

  // Verify credentials exist
  try {
    loadCredentials();
    console.log(`\n[Credentials] ${CREDENTIALS_PATH}`);
  } catch (err) {
    console.error("[Error] Cannot load Google credentials:", err);
    process.exit(1);
  }

  // Verify refresh token exists
  try {
    getRefreshToken();
    console.log("[OAuth] Refresh token found in Keychain");
  } catch (err) {
    console.error("[Error]", err);
    process.exit(1);
  }

  // Test token refresh on startup
  try {
    await getAccessToken();
    console.log("[OAuth] Access token acquired successfully");
  } catch (err) {
    console.error("[Error] Failed to get access token:", err);
    process.exit(1);
  }

  // Resolve scoped folders on startup
  try {
    const folders = await resolveScopedFolders();
    const count = Object.keys(folders).length;
    console.log(`[Scope] ${count}/${SCOPED_FOLDER_NAMES.length} folders resolved`);
  } catch (err) {
    console.warn("[Scope] Failed to resolve folders on startup:", err);
  }

  // Create Express app
  const app = express();
  app.use(express.json());

  // MCP endpoint — stateless: fresh server + transport per request
  app.post(MCP_ENDPOINT, async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const server = createDriveMcpServer();
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
  app.get("/health", async (_req, res) => {
    let tokenStatus = "unknown";
    try {
      await getAccessToken();
      tokenStatus = "valid";
    } catch {
      tokenStatus = "expired";
    }
    const folders = scopedFolderIds ? Object.keys(scopedFolderIds).length : 0;
    res.json({
      status: "ok",
      token: tokenStatus,
      scoped_folders: folders,
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
