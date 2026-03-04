/**
 * Google OAuth Connectors — Calendar, Gmail, Drive (read-only)
 *
 * Wraps Google REST API connections for the Knowledge Agent.
 * Phase 1: read-only access to Mike's personal Google account.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { TelemetryEmitter } from "../../telemetry/emitter.js";

// ─── Zod Schemas ────────────────────────────────────────────────────────────────

export const CalendarEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  attendees: z.array(z.string()).default([]),
  location: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
});
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

export const EmailSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.array(z.string()).default([]),
  subject: z.string(),
  body: z.string(),
  date: z.string(),
  labels: z.array(z.string()).default([]),
  attachments_count: z.number().default(0),
});
export type Email = z.infer<typeof EmailSchema>;

export const DriveDocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  content: z.string(),
  folder: z.string().nullable().default(null),
  lastModified: z.string(),
});
export type DriveDocument = z.infer<typeof DriveDocumentSchema>;

// ─── Fetch type alias ───────────────────────────────────────────────────────────

type FetchFunction = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

// ─── OAuth Token Manager ────────────────────────────────────────────────────────

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenEndpoint?: string;
}

export class OAuthTokenManager {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly tokenEndpoint: string;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private readonly fetchFn: FetchFunction;

  constructor(config: OAuthConfig, fetchFn?: FetchFunction) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.refreshToken = config.refreshToken;
    this.tokenEndpoint =
      config.tokenEndpoint ?? "https://oauth2.googleapis.com/token";
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }
    return this.refresh();
  }

  async refresh(): Promise<string> {
    const resp = await this.fetchFn(this.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!resp.ok) {
      throw new Error(
        `OAuth token refresh failed: ${resp.status} ${resp.statusText}`,
      );
    }

    const data = (await resp.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.accessToken = data.access_token;
    // Expire 60 seconds early to avoid edge cases
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return this.accessToken;
  }
}

// ─── Transport Interface (injectable for testing / MCP) ─────────────────────────

export interface GoogleTransport {
  calendarListEvents(
    timeMin: string,
    timeMax: string,
    maxResults?: number,
  ): Promise<CalendarEvent[]>;
  gmailSearch(query: string, maxResults?: number): Promise<Email[]>;
  driveListFiles(
    folderIds: string[],
    maxResults?: number,
  ): Promise<DriveDocument[]>;
}

// ─── Google REST API Transport ──────────────────────────────────────────────────

export class GoogleRESTTransport implements GoogleTransport {
  private readonly tokenManager: OAuthTokenManager;
  private readonly fetchFn: FetchFunction;
  private readonly maxRetries: number;

  constructor(
    tokenManager: OAuthTokenManager,
    options?: { fetchFn?: FetchFunction; maxRetries?: number },
  ) {
    this.tokenManager = tokenManager;
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
    this.maxRetries = options?.maxRetries ?? 3;
  }

  private async authFetch(url: string): Promise<Response> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const token = await this.tokenManager.getAccessToken();
      const resp = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (resp.status === 429) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (resp.status === 401 && attempt < this.maxRetries - 1) {
        await this.tokenManager.refresh();
        continue;
      }

      if (!resp.ok) {
        throw new Error(
          `Google API error: ${resp.status} ${resp.statusText}`,
        );
      }

      return resp;
    }
    throw new Error("Google API: max retries exceeded");
  }

  async calendarListEvents(
    timeMin: string,
    timeMax: string,
    maxResults = 100,
  ): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      maxResults: String(maxResults),
      singleEvents: "true",
      orderBy: "startTime",
    });
    const resp = await this.authFetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    );
    const data = (await resp.json()) as {
      items?: Record<string, unknown>[];
    };

    return (data.items ?? []).map((item) =>
      CalendarEventSchema.parse({
        id: (item.id as string) ?? randomUUID(),
        title: (item.summary as string) ?? "",
        start:
          ((item.start as Record<string, unknown>)?.dateTime as string) ??
          ((item.start as Record<string, unknown>)?.date as string) ??
          "",
        end:
          ((item.end as Record<string, unknown>)?.dateTime as string) ??
          ((item.end as Record<string, unknown>)?.date as string) ??
          "",
        attendees: (
          (item.attendees as Record<string, unknown>[]) ?? []
        ).map((a) => (a.email as string) ?? ""),
        location: (item.location as string) ?? null,
        description: (item.description as string) ?? null,
      }),
    );
  }

  async gmailSearch(query: string, maxResults = 50): Promise<Email[]> {
    const listParams = new URLSearchParams({
      q: query,
      maxResults: String(maxResults),
    });
    const listResp = await this.authFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${listParams}`,
    );
    const listData = (await listResp.json()) as {
      messages?: { id: string }[];
    };
    const messages = listData.messages ?? [];
    const emails: Email[] = [];

    for (const msg of messages) {
      const detailResp = await this.authFetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
      );
      const detail = (await detailResp.json()) as Record<string, unknown>;
      const payload = detail.payload as Record<string, unknown> | undefined;
      const headers = (payload?.headers as Record<string, unknown>[]) ?? [];

      const getHeader = (name: string): string => {
        const found = headers.find(
          (h) => (h.name as string).toLowerCase() === name.toLowerCase(),
        );
        return found ? (found.value as string) : "";
      };

      let body = "";
      const payloadBody = payload?.body as Record<string, unknown> | undefined;
      if (payloadBody?.data) {
        body = Buffer.from(payloadBody.data as string, "base64url").toString(
          "utf-8",
        );
      } else {
        const parts = (payload?.parts as Record<string, unknown>[]) ?? [];
        const textPart = parts.find(
          (p) => (p.mimeType as string) === "text/plain",
        );
        if (textPart) {
          const partBody = textPart.body as Record<string, unknown> | undefined;
          if (partBody?.data) {
            body = Buffer.from(partBody.data as string, "base64url").toString(
              "utf-8",
            );
          }
        }
      }

      const parts = (payload?.parts as Record<string, unknown>[]) ?? [];
      const attachmentCount = parts.filter(
        (p) => (p.filename as string) && (p.filename as string).length > 0,
      ).length;

      emails.push(
        EmailSchema.parse({
          id: (detail.id as string) ?? msg.id,
          from: getHeader("From"),
          to: getHeader("To")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          subject: getHeader("Subject"),
          body,
          date: getHeader("Date"),
          labels: (detail.labelIds as string[]) ?? [],
          attachments_count: attachmentCount,
        }),
      );
    }

    return emails;
  }

  async driveListFiles(
    folderIds: string[],
    maxResults = 100,
  ): Promise<DriveDocument[]> {
    const docs: DriveDocument[] = [];

    for (const folderId of folderIds) {
      const query = `'${folderId}' in parents and trashed = false`;
      const params = new URLSearchParams({
        q: query,
        pageSize: String(maxResults),
        fields: "files(id,name,mimeType,modifiedTime,parents)",
      });
      const resp = await this.authFetch(
        `https://www.googleapis.com/drive/v3/files?${params}`,
      );
      const data = (await resp.json()) as {
        files?: Record<string, unknown>[];
      };

      for (const file of data.files ?? []) {
        let content = "";
        if (
          (file.mimeType as string) ===
          "application/vnd.google-apps.document"
        ) {
          const exportResp = await this.authFetch(
            `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`,
          );
          content = await exportResp.text();
        } else {
          try {
            const mediaResp = await this.authFetch(
              `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
            );
            content = await mediaResp.text();
          } catch {
            content = "";
          }
        }

        docs.push(
          DriveDocumentSchema.parse({
            id: file.id as string,
            name: (file.name as string) ?? "",
            mimeType: (file.mimeType as string) ?? "",
            content,
            folder: folderId,
            lastModified:
              (file.modifiedTime as string) ?? new Date().toISOString(),
          }),
        );
      }
    }

    return docs;
  }
}

// ─── Main GoogleConnectors Class ────────────────────────────────────────────────

export interface GoogleConnectorsOptions {
  emitter?: TelemetryEmitter;
  transport?: GoogleTransport;
  oauthConfig?: OAuthConfig;
  calendarWindow?: { pastDays?: number; futureDays?: number };
  gmailDefaults?: { query?: string; maxResults?: number };
  driveFolderIds?: string[];
}

export interface ConnectorResult<T> {
  data: T;
  count: number;
  error?: string;
}

export class GoogleConnectors {
  private readonly transport: GoogleTransport | null;
  private readonly emitter: TelemetryEmitter | null;
  private readonly sessionId: string;
  private readonly calendarPastDays: number;
  private readonly calendarFutureDays: number;
  private readonly gmailDefaultQuery: string;
  private readonly gmailDefaultMaxResults: number;
  private readonly driveFolderIds: string[];

  constructor(options?: GoogleConnectorsOptions) {
    this.emitter = options?.emitter ?? null;
    this.sessionId = `google-${Date.now()}`;
    this.calendarPastDays = options?.calendarWindow?.pastDays ?? 30;
    this.calendarFutureDays = options?.calendarWindow?.futureDays ?? 14;
    this.gmailDefaultQuery =
      options?.gmailDefaults?.query ?? "in:inbox newer_than:7d";
    this.gmailDefaultMaxResults = options?.gmailDefaults?.maxResults ?? 50;
    this.driveFolderIds = options?.driveFolderIds ?? [];

    if (options?.transport) {
      this.transport = options.transport;
    } else if (options?.oauthConfig) {
      const tokenManager = new OAuthTokenManager(options.oauthConfig);
      this.transport = new GoogleRESTTransport(tokenManager);
    } else {
      this.transport = null;
    }
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
      // Non-blocking: telemetry failures never block operations
    }
  }

  async getCalendarEvents(options?: {
    timeMin?: string;
    timeMax?: string;
    maxResults?: number;
  }): Promise<ConnectorResult<CalendarEvent[]>> {
    const start = Date.now();

    if (!this.transport) {
      await this.emitEvent("google_calendar_read", "skipped", {
        reason: "No transport configured",
      });
      return { data: [], count: 0, error: "No transport configured" };
    }

    const now = new Date();
    const timeMin =
      options?.timeMin ??
      new Date(
        now.getTime() - this.calendarPastDays * 86400000,
      ).toISOString();
    const timeMax =
      options?.timeMax ??
      new Date(
        now.getTime() + this.calendarFutureDays * 86400000,
      ).toISOString();

    try {
      const events = await this.transport.calendarListEvents(
        timeMin,
        timeMax,
        options?.maxResults,
      );
      await this.emitEvent("google_calendar_read", "success", {
        events_count: events.length,
        time_range: { timeMin, timeMax },
        latency_ms: Date.now() - start,
      });
      return { data: events, count: events.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.emitEvent("google_calendar_read", "failure", {
        error: msg,
        latency_ms: Date.now() - start,
      });
      return { data: [], count: 0, error: msg };
    }
  }

  async getEmails(options?: {
    query?: string;
    maxResults?: number;
  }): Promise<ConnectorResult<Email[]>> {
    const start = Date.now();

    if (!this.transport) {
      await this.emitEvent("google_gmail_read", "skipped", {
        reason: "No transport configured",
      });
      return { data: [], count: 0, error: "No transport configured" };
    }

    const query = options?.query ?? this.gmailDefaultQuery;
    const maxResults = options?.maxResults ?? this.gmailDefaultMaxResults;

    try {
      const emails = await this.transport.gmailSearch(query, maxResults);
      await this.emitEvent("google_gmail_read", "success", {
        emails_count: emails.length,
        query,
        latency_ms: Date.now() - start,
      });
      return { data: emails, count: emails.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.emitEvent("google_gmail_read", "failure", {
        error: msg,
        latency_ms: Date.now() - start,
      });
      return { data: [], count: 0, error: msg };
    }
  }

  async getDriveDocuments(options?: {
    folderIds?: string[];
    maxResults?: number;
  }): Promise<ConnectorResult<DriveDocument[]>> {
    const start = Date.now();

    if (!this.transport) {
      await this.emitEvent("google_drive_read", "skipped", {
        reason: "No transport configured",
      });
      return { data: [], count: 0, error: "No transport configured" };
    }

    const folderIds = options?.folderIds ?? this.driveFolderIds;
    if (folderIds.length === 0) {
      await this.emitEvent("google_drive_read", "skipped", {
        reason: "No folder IDs configured",
      });
      return { data: [], count: 0, error: "No folder IDs configured" };
    }

    try {
      const docs = await this.transport.driveListFiles(
        folderIds,
        options?.maxResults,
      );
      await this.emitEvent("google_drive_read", "success", {
        documents_count: docs.length,
        folder_count: folderIds.length,
        latency_ms: Date.now() - start,
      });
      return { data: docs, count: docs.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.emitEvent("google_drive_read", "failure", {
        error: msg,
        latency_ms: Date.now() - start,
      });
      return { data: [], count: 0, error: msg };
    }
  }

  // ─── Read-only enforcement ──────────────────────────────────────────────────

  async writeCalendarEvent(): Promise<never> {
    throw new Error(
      "Write operations are not permitted — Google connectors are read-only in Phase 1",
    );
  }

  async sendEmail(): Promise<never> {
    throw new Error(
      "Write operations are not permitted — Google connectors are read-only in Phase 1",
    );
  }

  async writeDriveDocument(): Promise<never> {
    throw new Error(
      "Write operations are not permitted — Google connectors are read-only in Phase 1",
    );
  }
}
