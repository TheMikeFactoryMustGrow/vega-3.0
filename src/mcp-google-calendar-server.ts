/**
 * VEGA 3.0 — Google Calendar MCP Server (US-009)
 *
 * Custom MCP server providing read-only access to Google Calendar via the
 * Google Calendar API v3. Uses OAuth 2.0 with refresh token stored in
 * macOS Keychain for secure credential management.
 *
 * Tools: list_events, get_event
 * Transport: Streamable HTTP on 127.0.0.1:8767/mcp
 * Auth: OAuth 2.0 (calendar.events.readonly scope)
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

const PORT = parseInt(process.env.MCP_PORT || "8767", 10);
const HOST = process.env.MCP_HOST || "127.0.0.1";
const MCP_ENDPOINT = "/mcp";

const CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH ||
  join(homedir(), "Library", "Application Support", "gogcli", "credentials.json");

const KEYCHAIN_SERVICE = "vega-google-calendar";
const KEYCHAIN_ACCOUNT = "refresh_token";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

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
      `No refresh token in Keychain (service=${KEYCHAIN_SERVICE}). Run: npm run setup-google-calendar-mcp`,
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

// --- Google Calendar API ---

async function calendarFetch(endpoint: string, params?: Record<string, string>): Promise<unknown> {
  const token = await getAccessToken();
  const url = new URL(`${GOOGLE_CALENDAR_BASE}${endpoint}`);
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
    throw new Error(`Calendar API error (${resp.status}): ${errText}`);
  }

  return resp.json();
}

// --- MCP Server Factory ---

function createCalendarMcpServer(): McpServer {
  const server = new McpServer(
    { name: "google-calendar", version: "1.0.0" },
    {
      capabilities: { logging: {} },
      instructions:
        "Google Calendar read-only access for Lingelpedia Agent. " +
        "Provides tools to list and read calendar events from Mike's Google Calendar.",
    },
  );

  // Tool: list_events
  server.registerTool(
    "list_events",
    {
      description:
        "List calendar events within a time range. Returns event summaries, times, attendees, and descriptions. " +
        "Defaults to today's events if no time range specified.",
      inputSchema: {
        calendar_id: z
          .string()
          .default("primary")
          .describe("Calendar ID (default: 'primary' for main calendar)"),
        time_min: z
          .string()
          .optional()
          .describe("Start of time range in RFC3339 format (e.g. '2026-03-02T00:00:00Z'). Defaults to start of today."),
        time_max: z
          .string()
          .optional()
          .describe("End of time range in RFC3339 format (e.g. '2026-03-02T23:59:59Z'). Defaults to end of today."),
        max_results: z
          .number()
          .default(25)
          .describe("Maximum number of events to return (default: 25)"),
        query: z
          .string()
          .optional()
          .describe("Free text search terms to filter events"),
      },
    },
    async ({ calendar_id, time_min, time_max, max_results, query }) => {
      // Default to today if no time range provided
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();

      const params: Record<string, string> = {
        timeMin: time_min || todayStart,
        timeMax: time_max || todayEnd,
        maxResults: String(max_results),
        singleEvents: "true",
        orderBy: "startTime",
      };
      if (query) params.q = query;

      const data = (await calendarFetch(`/calendars/${encodeURIComponent(calendar_id)}/events`, params)) as {
        items?: Array<{
          id: string;
          summary?: string;
          description?: string;
          location?: string;
          start?: { dateTime?: string; date?: string };
          end?: { dateTime?: string; date?: string };
          attendees?: Array<{ email: string; displayName?: string; responseStatus?: string }>;
          organizer?: { email: string; displayName?: string };
          status?: string;
          htmlLink?: string;
        }>;
        summary?: string;
      };

      const events = (data.items || []).map((e) => ({
        id: e.id,
        summary: e.summary || "(no title)",
        description: e.description || "",
        location: e.location || "",
        start: e.start?.dateTime || e.start?.date || "",
        end: e.end?.dateTime || e.end?.date || "",
        attendees: (e.attendees || []).map((a) => ({
          email: a.email,
          name: a.displayName || "",
          status: a.responseStatus || "",
        })),
        organizer: e.organizer
          ? { email: e.organizer.email, name: e.organizer.displayName || "" }
          : null,
        status: e.status || "",
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { calendar: data.summary || calendar_id, count: events.length, events },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // Tool: get_event
  server.registerTool(
    "get_event",
    {
      description:
        "Get detailed information about a specific calendar event by ID. " +
        "Returns title, attendees, time, description, location, and status.",
      inputSchema: {
        calendar_id: z
          .string()
          .default("primary")
          .describe("Calendar ID (default: 'primary')"),
        event_id: z.string().describe("The event ID to retrieve"),
      },
    },
    async ({ calendar_id, event_id }) => {
      const data = (await calendarFetch(
        `/calendars/${encodeURIComponent(calendar_id)}/events/${encodeURIComponent(event_id)}`,
      )) as {
        id: string;
        summary?: string;
        description?: string;
        location?: string;
        start?: { dateTime?: string; date?: string; timeZone?: string };
        end?: { dateTime?: string; date?: string; timeZone?: string };
        attendees?: Array<{
          email: string;
          displayName?: string;
          responseStatus?: string;
          organizer?: boolean;
          self?: boolean;
        }>;
        organizer?: { email: string; displayName?: string };
        creator?: { email: string; displayName?: string };
        status?: string;
        htmlLink?: string;
        created?: string;
        updated?: string;
        recurringEventId?: string;
        conferenceData?: { entryPoints?: Array<{ uri: string; entryPointType: string }> };
      };

      const event = {
        id: data.id,
        summary: data.summary || "(no title)",
        description: data.description || "",
        location: data.location || "",
        start: data.start?.dateTime || data.start?.date || "",
        end: data.end?.dateTime || data.end?.date || "",
        timezone: data.start?.timeZone || "",
        attendees: (data.attendees || []).map((a) => ({
          email: a.email,
          name: a.displayName || "",
          status: a.responseStatus || "",
          organizer: a.organizer || false,
          self: a.self || false,
        })),
        organizer: data.organizer
          ? { email: data.organizer.email, name: data.organizer.displayName || "" }
          : null,
        creator: data.creator
          ? { email: data.creator.email, name: data.creator.displayName || "" }
          : null,
        status: data.status || "",
        created: data.created || "",
        updated: data.updated || "",
        recurringEventId: data.recurringEventId || null,
        conferenceLink:
          data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri || null,
        htmlLink: data.htmlLink || "",
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(event, null, 2) }],
      };
    },
  );

  return server;
}

// --- HTTP Server ---

async function main(): Promise<void> {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║  VEGA 3.0 — Google Calendar MCP Server (US-009)      ║");
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
      const server = createCalendarMcpServer();
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
