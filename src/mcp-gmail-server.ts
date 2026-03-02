/**
 * VEGA 3.0 — Gmail MCP Server (US-010)
 *
 * Custom MCP server providing read-only access to Gmail via the
 * Gmail API v1. Uses OAuth 2.0 with refresh token stored in
 * macOS Keychain for secure credential management.
 *
 * Tools: search_emails, read_email
 * Transport: Streamable HTTP on 127.0.0.1:8768/mcp
 * Auth: OAuth 2.0 (gmail.readonly scope)
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// --- Configuration ---

const PORT = parseInt(process.env.MCP_PORT || "8768", 10);
const HOST = process.env.MCP_HOST || "127.0.0.1";
const MCP_ENDPOINT = "/mcp";

const CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH ||
  join(homedir(), "Library", "Application Support", "gogcli", "credentials.json");

const KEYCHAIN_SERVICE = "vega-gmail";
const KEYCHAIN_ACCOUNT = "refresh_token";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

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
      `No refresh token in Keychain (service=${KEYCHAIN_SERVICE}). Run: npm run setup-gmail-mcp`,
    );
  }
}

async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
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

// --- Gmail API ---

async function gmailFetch(endpoint: string, params?: Record<string, string>): Promise<unknown> {
  const token = await getAccessToken();
  const url = new URL(`${GMAIL_API_BASE}${endpoint}`);
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
    throw new Error(`Gmail API error (${resp.status}): ${errText}`);
  }

  return resp.json();
}

// --- Helper: decode email body ---

function decodeBase64Url(data: string): string {
  // Gmail uses URL-safe base64 encoding
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

function getHeader(headers: GmailHeader[] | undefined, name: string): string {
  if (!headers) return "";
  const h = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

function extractTextBody(payload: GmailPart): string {
  // Direct body on the payload
  if (payload.body?.data) {
    if (payload.mimeType === "text/plain" || payload.mimeType === "text/html") {
      return decodeBase64Url(payload.body.data);
    }
  }

  // Multipart: recurse through parts, prefer text/plain over text/html
  if (payload.parts) {
    let plainText = "";
    let htmlText = "";
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        plainText = decodeBase64Url(part.body.data);
      } else if (part.mimeType === "text/html" && part.body?.data) {
        htmlText = decodeBase64Url(part.body.data);
      } else if (part.parts) {
        const nested = extractTextBody(part);
        if (nested) plainText = plainText || nested;
      }
    }
    // Prefer plain text; fall back to HTML with tags stripped
    if (plainText) return plainText;
    if (htmlText) return htmlText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  return "";
}

// --- MCP Server Factory ---

function createGmailMcpServer(): McpServer {
  const server = new McpServer(
    { name: "gmail", version: "1.0.0" },
    {
      capabilities: { logging: {} },
      instructions:
        "Gmail read-only access for Lingelpedia Agent. " +
        "Provides tools to search and read emails from Mike's Gmail account.",
    },
  );

  // Tool: search_emails
  server.registerTool(
    "search_emails",
    {
      description:
        "Search emails using Gmail search syntax. Returns message summaries (sender, subject, date, snippet). " +
        "Uses the same query syntax as the Gmail search box (e.g., 'from:john subject:meeting after:2026/03/01').",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Gmail search query (e.g., 'from:user@example.com', 'subject:meeting', 'after:2026/03/01', 'is:unread')",
          ),
        max_results: z
          .number()
          .default(10)
          .describe("Maximum number of emails to return (default: 10, max: 50)"),
      },
    },
    async ({ query, max_results }) => {
      const maxResults = Math.min(max_results, 50);

      // Search for message IDs
      const searchData = (await gmailFetch("/users/me/messages", {
        q: query,
        maxResults: String(maxResults),
      })) as {
        messages?: Array<{ id: string; threadId: string }>;
        resultSizeEstimate?: number;
      };

      const messageIds = searchData.messages || [];

      if (messageIds.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ query, count: 0, emails: [] }, null, 2),
            },
          ],
        };
      }

      // Fetch metadata for each message (batch with metadata format for efficiency)
      const emails = await Promise.all(
        messageIds.map(async (msg) => {
          const data = (await gmailFetch(`/users/me/messages/${msg.id}`, {
            format: "metadata",
            metadataHeaders: "From,To,Subject,Date",
          })) as {
            id: string;
            threadId: string;
            snippet: string;
            internalDate: string;
            labelIds?: string[];
            payload?: { headers?: GmailHeader[] };
          };

          const headers = data.payload?.headers;
          return {
            id: data.id,
            threadId: data.threadId,
            from: getHeader(headers, "From"),
            to: getHeader(headers, "To"),
            subject: getHeader(headers, "Subject"),
            date: getHeader(headers, "Date"),
            snippet: data.snippet || "",
            labels: data.labelIds || [],
          };
        }),
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                query,
                count: emails.length,
                estimatedTotal: searchData.resultSizeEstimate || emails.length,
                emails,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // Tool: read_email
  server.registerTool(
    "read_email",
    {
      description:
        "Read the full content of a specific email by message ID. " +
        "Returns sender, recipients, subject, date, body text, and attachment names.",
      inputSchema: {
        message_id: z.string().describe("The Gmail message ID to read (from search_emails results)"),
      },
    },
    async ({ message_id }) => {
      const data = (await gmailFetch(`/users/me/messages/${message_id}`, {
        format: "full",
      })) as {
        id: string;
        threadId: string;
        snippet: string;
        internalDate: string;
        labelIds?: string[];
        payload?: GmailPart & { headers?: GmailHeader[] };
      };

      const headers = data.payload?.headers;
      const body = data.payload ? extractTextBody(data.payload) : "";

      // Extract attachment names
      const attachments: string[] = [];
      function collectAttachments(part: GmailPart): void {
        const filename = getHeader(part.headers, "Content-Disposition");
        if (filename?.includes("attachment") || filename?.includes("filename")) {
          const match = filename.match(/filename="?([^";\n]+)"?/);
          if (match) attachments.push(match[1].trim());
        }
        if (part.parts) part.parts.forEach(collectAttachments);
      }
      if (data.payload?.parts) {
        data.payload.parts.forEach(collectAttachments);
      }

      const email = {
        id: data.id,
        threadId: data.threadId,
        from: getHeader(headers, "From"),
        to: getHeader(headers, "To"),
        cc: getHeader(headers, "Cc"),
        bcc: getHeader(headers, "Bcc"),
        subject: getHeader(headers, "Subject"),
        date: getHeader(headers, "Date"),
        body: body.length > 10_000 ? body.substring(0, 10_000) + "\n\n[...truncated at 10,000 characters]" : body,
        snippet: data.snippet || "",
        labels: data.labelIds || [],
        attachments,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(email, null, 2) }],
      };
    },
  );

  return server;
}

// --- HTTP Server ---

async function main(): Promise<void> {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║  VEGA 3.0 — Gmail MCP Server (US-010)                ║");
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

  // Create Express app
  const app = express();
  app.use(express.json());

  // MCP endpoint — stateless: fresh server + transport per request
  app.post(MCP_ENDPOINT, async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const server = createGmailMcpServer();
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
    res.json({
      status: "ok",
      token: tokenStatus,
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
