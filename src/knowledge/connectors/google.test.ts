import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OAuthTokenManager,
  GoogleRESTTransport,
  GoogleConnectors,
  CalendarEventSchema,
  EmailSchema,
  DriveDocumentSchema,
  type GoogleTransport,
  type CalendarEvent,
  type Email,
  type DriveDocument,
  type OAuthConfig,
} from "./google.js";
import type { TelemetryEmitter } from "../../telemetry/emitter.js";

// ─── Test Fixtures ──────────────────────────────────────────────────────────────

const TEST_OAUTH: OAuthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  refreshToken: "test-refresh-token",
};

const SAMPLE_CALENDAR_EVENT: CalendarEvent = {
  id: "evt-1",
  title: "CIP Board Meeting",
  start: "2026-03-04T10:00:00-05:00",
  end: "2026-03-04T11:00:00-05:00",
  attendees: ["mike@example.com", "jim@example.com"],
  location: "Conference Room A",
  description: "Quarterly board review",
};

const SAMPLE_EMAIL: Email = {
  id: "msg-1",
  from: "jim@blackstone.com",
  to: ["mike@example.com"],
  subject: "RE: Investment Update",
  body: "Here is the Q4 report...",
  date: "Tue, 03 Mar 2026 14:30:00 -0500",
  labels: ["INBOX", "IMPORTANT"],
  attachments_count: 1,
};

const SAMPLE_DRIVE_DOC: DriveDocument = {
  id: "doc-1",
  name: "GIX Strategy 2026.gdoc",
  mimeType: "application/vnd.google-apps.document",
  content: "GIX investment strategy for fiscal year 2026...",
  folder: "folder-gix",
  lastModified: "2026-03-01T12:00:00Z",
};

function mockTransport(overrides?: Partial<GoogleTransport>): GoogleTransport {
  return {
    calendarListEvents: vi
      .fn()
      .mockResolvedValue([SAMPLE_CALENDAR_EVENT]),
    gmailSearch: vi.fn().mockResolvedValue([SAMPLE_EMAIL]),
    driveListFiles: vi.fn().mockResolvedValue([SAMPLE_DRIVE_DOC]),
    ...overrides,
  };
}

function mockEmitter(): TelemetryEmitter {
  return {
    emit: vi.fn().mockResolvedValue(null),
  } as unknown as TelemetryEmitter;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    statusText: status === 200 ? "OK" : "Error",
  });
}

// ─── OAuthTokenManager ─────────────────────────────────────────────────────────

describe("OAuthTokenManager", () => {
  it("refreshes and caches access token", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: "fresh-token", expires_in: 3600 }),
    );
    const manager = new OAuthTokenManager(TEST_OAUTH, mockFetch);

    const token1 = await manager.getAccessToken();
    expect(token1).toBe("fresh-token");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call returns cached token — no additional fetch
    const token2 = await manager.getAccessToken();
    expect(token2).toBe("fresh-token");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("sends correct OAuth parameters in refresh request", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    const manager = new OAuthTokenManager(TEST_OAUTH, mockFetch);

    await manager.getAccessToken();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    );

    const callBody = mockFetch.mock.calls[0][1].body as URLSearchParams;
    expect(callBody.get("client_id")).toBe("test-client-id");
    expect(callBody.get("grant_type")).toBe("refresh_token");
  });

  it("throws on refresh failure", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("", { status: 400, statusText: "Bad Request" }),
    );
    const manager = new OAuthTokenManager(TEST_OAUTH, mockFetch);

    await expect(manager.getAccessToken()).rejects.toThrow(
      "OAuth token refresh failed: 400 Bad Request",
    );
  });

  it("re-refreshes after manual refresh() call", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "token-2", expires_in: 3600 }),
      );
    const manager = new OAuthTokenManager(TEST_OAUTH, mockFetch);

    const t1 = await manager.getAccessToken();
    expect(t1).toBe("token-1");

    const t2 = await manager.refresh();
    expect(t2).toBe("token-2");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ─── GoogleRESTTransport ────────────────────────────────────────────────────────

describe("GoogleRESTTransport", () => {
  let tokenManager: OAuthTokenManager;
  let tokenFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tokenFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ access_token: "test-access-token", expires_in: 3600 }),
      ),
    );
    tokenManager = new OAuthTokenManager(TEST_OAUTH, tokenFetch);
  });

  it("lists calendar events from Google Calendar API", async () => {
    const apiFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: "evt-1",
            summary: "CIP Board Meeting",
            start: { dateTime: "2026-03-04T10:00:00-05:00" },
            end: { dateTime: "2026-03-04T11:00:00-05:00" },
            attendees: [
              { email: "mike@example.com" },
              { email: "jim@example.com" },
            ],
            location: "Conference Room A",
            description: "Quarterly board review",
          },
        ],
      }),
    );

    const transport = new GoogleRESTTransport(tokenManager, {
      fetchFn: apiFetch,
    });
    const events = await transport.calendarListEvents(
      "2026-03-01T00:00:00Z",
      "2026-03-31T23:59:59Z",
    );

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("evt-1");
    expect(events[0].title).toBe("CIP Board Meeting");
    expect(events[0].attendees).toEqual([
      "mike@example.com",
      "jim@example.com",
    ]);
    expect(events[0].location).toBe("Conference Room A");

    // Verify the API URL contains calendar endpoint
    const calledUrl = apiFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("googleapis.com/calendar/v3");
    expect(calledUrl).toContain("singleEvents=true");
  });

  it("searches Gmail and returns typed emails", async () => {
    let callIndex = 0;
    const apiFetch = vi.fn().mockImplementation((url: string) => {
      callIndex++;
      if (callIndex === 1) {
        // List messages
        return Promise.resolve(
          jsonResponse({ messages: [{ id: "msg-1" }] }),
        );
      }
      // Get message detail
      return Promise.resolve(
        jsonResponse({
          id: "msg-1",
          payload: {
            headers: [
              { name: "From", value: "jim@blackstone.com" },
              { name: "To", value: "mike@example.com" },
              { name: "Subject", value: "RE: Investment Update" },
              { name: "Date", value: "Tue, 03 Mar 2026 14:30:00 -0500" },
            ],
            body: {
              data: Buffer.from("Here is the Q4 report...").toString(
                "base64url",
              ),
            },
            parts: [
              {
                mimeType: "application/pdf",
                filename: "Q4-Report.pdf",
                body: { size: 1024 },
              },
            ],
          },
          labelIds: ["INBOX", "IMPORTANT"],
        }),
      );
    });

    const transport = new GoogleRESTTransport(tokenManager, {
      fetchFn: apiFetch,
    });
    const emails = await transport.gmailSearch("in:inbox newer_than:7d");

    expect(emails).toHaveLength(1);
    expect(emails[0].id).toBe("msg-1");
    expect(emails[0].from).toBe("jim@blackstone.com");
    expect(emails[0].subject).toBe("RE: Investment Update");
    expect(emails[0].body).toBe("Here is the Q4 report...");
    expect(emails[0].labels).toContain("INBOX");
    expect(emails[0].attachments_count).toBe(1);
  });

  it("lists Drive files with content", async () => {
    let callIndex = 0;
    const apiFetch = vi.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        // List files
        return Promise.resolve(
          jsonResponse({
            files: [
              {
                id: "doc-1",
                name: "GIX Strategy.gdoc",
                mimeType: "application/vnd.google-apps.document",
                modifiedTime: "2026-03-01T12:00:00Z",
              },
            ],
          }),
        );
      }
      // Export content
      return Promise.resolve(textResponse("GIX strategy content..."));
    });

    const transport = new GoogleRESTTransport(tokenManager, {
      fetchFn: apiFetch,
    });
    const docs = await transport.driveListFiles(["folder-gix"]);

    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe("doc-1");
    expect(docs[0].name).toBe("GIX Strategy.gdoc");
    expect(docs[0].content).toBe("GIX strategy content...");
    expect(docs[0].folder).toBe("folder-gix");
  });

  it("retries on 429 with exponential backoff", async () => {
    let callIndex = 0;
    const apiFetch = vi.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex <= 2) {
        return Promise.resolve(
          new Response("", { status: 429, statusText: "Too Many Requests" }),
        );
      }
      return Promise.resolve(jsonResponse({ items: [] }));
    });

    const transport = new GoogleRESTTransport(tokenManager, {
      fetchFn: apiFetch,
      maxRetries: 3,
    });
    const events = await transport.calendarListEvents(
      "2026-03-01T00:00:00Z",
      "2026-03-31T23:59:59Z",
    );

    expect(events).toEqual([]);
    // Token fetch + 3 API calls (2 retries + 1 success)
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });

  it("refreshes token on 401 and retries", async () => {
    let callIndex = 0;
    const apiFetch = vi.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve(
          new Response("", { status: 401, statusText: "Unauthorized" }),
        );
      }
      return Promise.resolve(jsonResponse({ items: [] }));
    });

    const transport = new GoogleRESTTransport(tokenManager, {
      fetchFn: apiFetch,
      maxRetries: 3,
    });
    const events = await transport.calendarListEvents(
      "2026-03-01T00:00:00Z",
      "2026-03-31T23:59:59Z",
    );

    expect(events).toEqual([]);
    // 2 API calls: 1 unauthorized + 1 success after refresh
    expect(apiFetch).toHaveBeenCalledTimes(2);
    // Token refresh called twice: initial + after 401
    expect(tokenFetch).toHaveBeenCalledTimes(2);
  });

  it("throws after max retries exceeded", async () => {
    const apiFetch = vi.fn().mockResolvedValue(
      new Response("", { status: 429, statusText: "Too Many Requests" }),
    );

    const transport = new GoogleRESTTransport(tokenManager, {
      fetchFn: apiFetch,
      maxRetries: 2,
    });

    await expect(
      transport.calendarListEvents(
        "2026-03-01T00:00:00Z",
        "2026-03-31T23:59:59Z",
      ),
    ).rejects.toThrow("max retries exceeded");
  });

  it("throws on non-retryable error", async () => {
    const apiFetch = vi.fn().mockResolvedValue(
      new Response("", { status: 403, statusText: "Forbidden" }),
    );

    const transport = new GoogleRESTTransport(tokenManager, {
      fetchFn: apiFetch,
    });

    await expect(
      transport.calendarListEvents(
        "2026-03-01T00:00:00Z",
        "2026-03-31T23:59:59Z",
      ),
    ).rejects.toThrow("Google API error: 403 Forbidden");
  });
});

// ─── GoogleConnectors ───────────────────────────────────────────────────────────

describe("GoogleConnectors", () => {
  describe("Calendar", () => {
    it("retrieves calendar events with typed response", async () => {
      const transport = mockTransport();
      const connectors = new GoogleConnectors({ transport });

      const result = await connectors.getCalendarEvents({
        timeMin: "2026-03-01T00:00:00Z",
        timeMax: "2026-03-31T23:59:59Z",
      });

      expect(result.count).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.error).toBeUndefined();

      const event = result.data[0];
      expect(event.id).toBe("evt-1");
      expect(event.title).toBe("CIP Board Meeting");
      expect(event.start).toBe("2026-03-04T10:00:00-05:00");
      expect(event.end).toBe("2026-03-04T11:00:00-05:00");
      expect(event.attendees).toEqual([
        "mike@example.com",
        "jim@example.com",
      ]);
      expect(event.location).toBe("Conference Room A");
      expect(event.description).toBe("Quarterly board review");

      // Verify schema compliance
      expect(() => CalendarEventSchema.parse(event)).not.toThrow();
    });

    it("uses configurable time window defaults", async () => {
      const transport = mockTransport();
      const connectors = new GoogleConnectors({
        transport,
        calendarWindow: { pastDays: 7, futureDays: 3 },
      });

      await connectors.getCalendarEvents();

      const calledArgs = (
        transport.calendarListEvents as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      const timeMin = new Date(calledArgs[0] as string);
      const timeMax = new Date(calledArgs[1] as string);
      const now = new Date();

      // timeMin should be ~7 days ago
      const daysDiff =
        (now.getTime() - timeMin.getTime()) / 86400000;
      expect(daysDiff).toBeCloseTo(7, 0);

      // timeMax should be ~3 days in the future
      const futureDiff =
        (timeMax.getTime() - now.getTime()) / 86400000;
      expect(futureDiff).toBeCloseTo(3, 0);
    });

    it("returns error when no transport configured", async () => {
      const connectors = new GoogleConnectors();
      const result = await connectors.getCalendarEvents();

      expect(result.data).toEqual([]);
      expect(result.count).toBe(0);
      expect(result.error).toBe("No transport configured");
    });
  });

  describe("Gmail", () => {
    it("retrieves emails with typed response and all fields", async () => {
      const transport = mockTransport();
      const connectors = new GoogleConnectors({ transport });

      const result = await connectors.getEmails({ query: "in:inbox" });

      expect(result.count).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.error).toBeUndefined();

      const email = result.data[0];
      expect(email.id).toBe("msg-1");
      expect(email.from).toBe("jim@blackstone.com");
      expect(email.to).toEqual(["mike@example.com"]);
      expect(email.subject).toBe("RE: Investment Update");
      expect(email.body).toBe("Here is the Q4 report...");
      expect(email.date).toBe("Tue, 03 Mar 2026 14:30:00 -0500");
      expect(email.labels).toContain("INBOX");
      expect(email.attachments_count).toBe(1);

      // Verify schema compliance
      expect(() => EmailSchema.parse(email)).not.toThrow();
    });

    it("uses default query when none provided", async () => {
      const transport = mockTransport();
      const connectors = new GoogleConnectors({
        transport,
        gmailDefaults: { query: "label:finance", maxResults: 10 },
      });

      await connectors.getEmails();

      const calledArgs = (
        transport.gmailSearch as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(calledArgs[0]).toBe("label:finance");
      expect(calledArgs[1]).toBe(10);
    });

    it("returns error when no transport configured", async () => {
      const connectors = new GoogleConnectors();
      const result = await connectors.getEmails();

      expect(result.data).toEqual([]);
      expect(result.count).toBe(0);
      expect(result.error).toBe("No transport configured");
    });
  });

  describe("Drive", () => {
    it("retrieves documents with typed response", async () => {
      const transport = mockTransport();
      const connectors = new GoogleConnectors({
        transport,
        driveFolderIds: ["folder-gix"],
      });

      const result = await connectors.getDriveDocuments();

      expect(result.count).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.error).toBeUndefined();

      const doc = result.data[0];
      expect(doc.id).toBe("doc-1");
      expect(doc.name).toBe("GIX Strategy 2026.gdoc");
      expect(doc.mimeType).toBe("application/vnd.google-apps.document");
      expect(doc.content).toBe(
        "GIX investment strategy for fiscal year 2026...",
      );
      expect(doc.folder).toBe("folder-gix");
      expect(doc.lastModified).toBe("2026-03-01T12:00:00Z");

      // Verify schema compliance
      expect(() => DriveDocumentSchema.parse(doc)).not.toThrow();
    });

    it("returns error when no folder IDs configured", async () => {
      const transport = mockTransport();
      const connectors = new GoogleConnectors({ transport });

      const result = await connectors.getDriveDocuments();

      expect(result.data).toEqual([]);
      expect(result.count).toBe(0);
      expect(result.error).toBe("No folder IDs configured");
    });

    it("accepts folder IDs as override", async () => {
      const transport = mockTransport();
      const connectors = new GoogleConnectors({ transport });

      const result = await connectors.getDriveDocuments({
        folderIds: ["folder-we", "folder-finance"],
      });

      expect(result.count).toBe(1);
      const calledArgs = (
        transport.driveListFiles as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(calledArgs[0]).toEqual(["folder-we", "folder-finance"]);
    });

    it("returns error when no transport configured", async () => {
      const connectors = new GoogleConnectors();
      const result = await connectors.getDriveDocuments({
        folderIds: ["folder-gix"],
      });

      expect(result.data).toEqual([]);
      expect(result.count).toBe(0);
      expect(result.error).toBe("No transport configured");
    });
  });

  describe("Read-only enforcement", () => {
    it("writeCalendarEvent throws read-only error", async () => {
      const connectors = new GoogleConnectors({
        transport: mockTransport(),
      });
      await expect(connectors.writeCalendarEvent()).rejects.toThrow(
        "read-only in Phase 1",
      );
    });

    it("sendEmail throws read-only error", async () => {
      const connectors = new GoogleConnectors({
        transport: mockTransport(),
      });
      await expect(connectors.sendEmail()).rejects.toThrow(
        "read-only in Phase 1",
      );
    });

    it("writeDriveDocument throws read-only error", async () => {
      const connectors = new GoogleConnectors({
        transport: mockTransport(),
      });
      await expect(connectors.writeDriveDocument()).rejects.toThrow(
        "read-only in Phase 1",
      );
    });
  });

  describe("Telemetry", () => {
    it("emits success events for all connectors", async () => {
      const emitter = mockEmitter();
      const transport = mockTransport();
      const connectors = new GoogleConnectors({
        transport,
        emitter,
        driveFolderIds: ["folder-gix"],
      });

      await connectors.getCalendarEvents({
        timeMin: "2026-03-01T00:00:00Z",
        timeMax: "2026-03-31T23:59:59Z",
      });
      await connectors.getEmails({ query: "in:inbox" });
      await connectors.getDriveDocuments();

      const emitCalls = (emitter.emit as ReturnType<typeof vi.fn>).mock.calls;
      expect(emitCalls).toHaveLength(3);

      // Calendar event
      expect(emitCalls[0][0]).toMatchObject({
        agent_name: "knowledge_agent",
        event_type: "knowledge_query",
        event_subtype: "google_calendar_read",
        outcome: "success",
      });
      expect(emitCalls[0][0].metadata.events_count).toBe(1);

      // Gmail event
      expect(emitCalls[1][0]).toMatchObject({
        event_subtype: "google_gmail_read",
        outcome: "success",
      });
      expect(emitCalls[1][0].metadata.emails_count).toBe(1);

      // Drive event
      expect(emitCalls[2][0]).toMatchObject({
        event_subtype: "google_drive_read",
        outcome: "success",
      });
      expect(emitCalls[2][0].metadata.documents_count).toBe(1);
    });

    it("emits failure events on transport errors", async () => {
      const emitter = mockEmitter();
      const transport = mockTransport({
        calendarListEvents: vi
          .fn()
          .mockRejectedValue(new Error("API quota exceeded")),
      });
      const connectors = new GoogleConnectors({ transport, emitter });

      const result = await connectors.getCalendarEvents();

      expect(result.error).toBe("API quota exceeded");

      const emitCalls = (emitter.emit as ReturnType<typeof vi.fn>).mock.calls;
      expect(emitCalls[0][0]).toMatchObject({
        event_subtype: "google_calendar_read",
        outcome: "failure",
      });
      expect(emitCalls[0][0].metadata.error).toBe("API quota exceeded");
    });

    it("emits skipped events when no transport", async () => {
      const emitter = mockEmitter();
      const connectors = new GoogleConnectors({ emitter });

      await connectors.getCalendarEvents();

      const emitCalls = (emitter.emit as ReturnType<typeof vi.fn>).mock.calls;
      expect(emitCalls[0][0]).toMatchObject({
        event_subtype: "google_calendar_read",
        outcome: "skipped",
      });
    });

    it("includes latency_ms in metadata", async () => {
      const emitter = mockEmitter();
      const transport = mockTransport();
      const connectors = new GoogleConnectors({ transport, emitter });

      await connectors.getCalendarEvents();

      const metadata = (emitter.emit as ReturnType<typeof vi.fn>).mock
        .calls[0][0].metadata;
      expect(metadata.latency_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Error handling", () => {
    it("handles transport errors gracefully without throwing", async () => {
      const transport = mockTransport({
        gmailSearch: vi
          .fn()
          .mockRejectedValue(new Error("Network unreachable")),
        driveListFiles: vi
          .fn()
          .mockRejectedValue(new Error("Permission denied")),
      });
      const connectors = new GoogleConnectors({
        transport,
        driveFolderIds: ["folder-gix"],
      });

      const emailResult = await connectors.getEmails();
      expect(emailResult.data).toEqual([]);
      expect(emailResult.error).toBe("Network unreachable");

      const driveResult = await connectors.getDriveDocuments();
      expect(driveResult.data).toEqual([]);
      expect(driveResult.error).toBe("Permission denied");
    });

    it("creates transport from oauthConfig when no transport provided", () => {
      const connectors = new GoogleConnectors({
        oauthConfig: TEST_OAUTH,
      });
      // Should not throw — transport created from OAuth config
      expect(connectors).toBeDefined();
    });
  });

  describe("Zod schema validation", () => {
    it("CalendarEventSchema validates correct data", () => {
      const event = CalendarEventSchema.parse({
        id: "evt-1",
        title: "Meeting",
        start: "2026-03-04T10:00:00Z",
        end: "2026-03-04T11:00:00Z",
      });
      expect(event.attendees).toEqual([]);
      expect(event.location).toBeNull();
      expect(event.description).toBeNull();
    });

    it("EmailSchema validates correct data with defaults", () => {
      const email = EmailSchema.parse({
        id: "msg-1",
        from: "test@example.com",
        subject: "Test",
        body: "Hello",
        date: "2026-03-04T10:00:00Z",
      });
      expect(email.to).toEqual([]);
      expect(email.labels).toEqual([]);
      expect(email.attachments_count).toBe(0);
    });

    it("DriveDocumentSchema validates correct data", () => {
      const doc = DriveDocumentSchema.parse({
        id: "doc-1",
        name: "test.txt",
        mimeType: "text/plain",
        content: "Hello world",
        lastModified: "2026-03-04T10:00:00Z",
      });
      expect(doc.folder).toBeNull();
    });

    it("CalendarEventSchema rejects missing required fields", () => {
      expect(() =>
        CalendarEventSchema.parse({ id: "evt-1" }),
      ).toThrow();
    });
  });
});
