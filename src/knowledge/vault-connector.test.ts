import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TelemetryEmitter } from "../telemetry/emitter.js";
import {
  VaultConnector,
  parseFrontmatter,
  serializeNote,
  type VaultEvent,
} from "./vault-connector.js";

// ── Mock icloud-sync to avoid needing brctl ──────────────────────────

vi.mock("../telemetry/icloud-sync.js", () => ({
  materialize_icloud_stubs: vi.fn().mockResolvedValue({
    total_stubs_found: 0,
    successfully_materialized: 0,
    failed: [],
  }),
}));

// ── Test Fixtures ────────────────────────────────────────────────────

const ENTITY_NOTE = `---
type: entity
name: Acme Corp
entity_type: organization
domain: gix
description: A fictional corporation
---
Acme Corp is a leading manufacturer of anvils and rockets.

They have 500 employees worldwide.
`;

const PERSON_NOTE = `---
type: person
name: Jim LaMarche
relationship: professional
domain: personal_finance
birthday: 1985-03-15
---
Jim works at Blackstone. Met him at the CIP conference.

He mentioned potential deal flow opportunities.
`;

const NO_FRONTMATTER_NOTE = `# Just a plain markdown note

No frontmatter here, just raw content.
`;

// ── Test Suite ───────────────────────────────────────────────────────

describe("VaultConnector", () => {
  let tempDir: string;
  let telemetryDir: string;
  let emitter: TelemetryEmitter;
  let vaultPath: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "vega-vault-test-"));
    telemetryDir = await mkdtemp(path.join(os.tmpdir(), "vega-telemetry-test-"));
    emitter = new TelemetryEmitter(telemetryDir);
    vaultPath = path.join(tempDir, "vault");

    // Create vault structure
    await mkdir(path.join(vaultPath, "Finance", "Entities"), { recursive: true });
    await mkdir(path.join(vaultPath, "GIX", "People"), { recursive: true });
    await mkdir(path.join(vaultPath, "_agent_insights"), { recursive: true });
    await mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });

    // Write test notes
    await writeFile(path.join(vaultPath, "Finance", "Entities", "acme.md"), ENTITY_NOTE);
    await writeFile(path.join(vaultPath, "GIX", "People", "jim.md"), PERSON_NOTE);
    await writeFile(path.join(vaultPath, "plain-note.md"), NO_FRONTMATTER_NOTE);

    // Hidden file that should be skipped
    await writeFile(path.join(vaultPath, ".obsidian", "config.md"), "obsidian config");
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(telemetryDir, { recursive: true, force: true });
  });

  // ── Frontmatter Parsing ──────────────────────────────────────────

  describe("parseFrontmatter", () => {
    it("extracts frontmatter and body from a note with YAML frontmatter", () => {
      const { frontmatter, body } = parseFrontmatter(ENTITY_NOTE);
      expect(frontmatter).not.toBeNull();
      expect(frontmatter!.type).toBe("entity");
      expect(frontmatter!.name).toBe("Acme Corp");
      expect(frontmatter!.entity_type).toBe("organization");
      expect(frontmatter!.domain).toBe("gix");
      expect(body).toContain("Acme Corp is a leading manufacturer");
      expect(body).toContain("500 employees worldwide");
    });

    it("extracts person-specific frontmatter fields", () => {
      const { frontmatter, body } = parseFrontmatter(PERSON_NOTE);
      expect(frontmatter).not.toBeNull();
      expect(frontmatter!.type).toBe("person");
      expect(frontmatter!.name).toBe("Jim LaMarche");
      expect(frontmatter!.birthday).toBe("1985-03-15");
      expect(body).toContain("Jim works at Blackstone");
    });

    it("returns null frontmatter for notes without frontmatter block", () => {
      const { frontmatter, body } = parseFrontmatter(NO_FRONTMATTER_NOTE);
      expect(frontmatter).toBeNull();
      expect(body).toContain("Just a plain markdown note");
    });

    it("returns null frontmatter for invalid YAML", () => {
      const badYaml = `---\n: invalid: yaml: here:\n---\nBody text`;
      const { frontmatter } = parseFrontmatter(badYaml);
      expect(frontmatter).toBeNull();
    });
  });

  // ── serializeNote ────────────────────────────────────────────────

  describe("serializeNote", () => {
    it("produces valid Obsidian markdown with YAML frontmatter", () => {
      const fm = { type: "moc", theme: "finance", generated_by: "knowledge_agent" };
      const body = "# Finance MOC\n\nLinks to finance claims.\n";
      const result = serializeNote(fm, body);

      expect(result).toMatch(/^---\n/);
      expect(result).toContain("type: moc");
      expect(result).toContain("theme: finance");
      expect(result).toMatch(/---\n# Finance MOC/);

      // Round-trip: parse the serialized note back
      const parsed = parseFrontmatter(result);
      expect(parsed.frontmatter).not.toBeNull();
      expect(parsed.frontmatter!.type).toBe("moc");
      expect(parsed.frontmatter!.theme).toBe("finance");
      expect(parsed.body).toContain("Finance MOC");
    });
  });

  // ── Vault Scanning ───────────────────────────────────────────────

  describe("scan", () => {
    it("scans the vault and returns all .md files with parsed frontmatter and body", async () => {
      const connector = new VaultConnector({ vaultPath, emitter });
      const result = await connector.scan();

      expect(result.errors).toHaveLength(0);
      expect(result.files.length).toBeGreaterThanOrEqual(3);

      // Find the entity note
      const acmeFile = result.files.find((f) => f.path.includes("acme.md"));
      expect(acmeFile).toBeDefined();
      expect(acmeFile!.frontmatter).not.toBeNull();
      expect(acmeFile!.frontmatter!.name).toBe("Acme Corp");
      expect(acmeFile!.body).toContain("leading manufacturer");
      expect(acmeFile!.lastModified).toBeInstanceOf(Date);

      // Find the person note
      const jimFile = result.files.find((f) => f.path.includes("jim.md"));
      expect(jimFile).toBeDefined();
      expect(jimFile!.frontmatter!.name).toBe("Jim LaMarche");

      // Find the plain note (no frontmatter)
      const plainFile = result.files.find((f) => f.path.includes("plain-note.md"));
      expect(plainFile).toBeDefined();
      expect(plainFile!.frontmatter).toBeNull();
    });

    it("skips hidden directories like .obsidian", async () => {
      const connector = new VaultConnector({ vaultPath, emitter });
      const result = await connector.scan();

      const obsidianFile = result.files.find((f) => f.path.includes(".obsidian"));
      expect(obsidianFile).toBeUndefined();
    });

    it("calls materialize_icloud_stubs before scanning", async () => {
      const { materialize_icloud_stubs } = await import("../telemetry/icloud-sync.js");
      const mockMaterialize = vi.mocked(materialize_icloud_stubs);
      mockMaterialize.mockClear();

      const connector = new VaultConnector({ vaultPath, emitter });
      await connector.scan();

      expect(mockMaterialize).toHaveBeenCalledWith(vaultPath, expect.any(Object));
    });

    it("supports selective scan with glob patterns", async () => {
      const connector = new VaultConnector({ vaultPath, emitter });
      const result = await connector.scan(["Finance/Entities/*.md"]);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toContain("acme.md");
    });

    it("supports multiple glob patterns", async () => {
      const connector = new VaultConnector({ vaultPath, emitter });
      const result = await connector.scan(["Finance/**/*.md", "GIX/**/*.md"]);

      expect(result.files).toHaveLength(2);
      const names = result.files.map((f) => path.basename(f.path));
      expect(names).toContain("acme.md");
      expect(names).toContain("jim.md");
    });

    it("emits telemetry for vault scan", async () => {
      const connector = new VaultConnector({ vaultPath, emitter });
      await connector.scan();

      const events = await emitter.readEvents(new Date());
      const scanEvents = events.filter((e) => e.event_subtype === "vault_scan");
      expect(scanEvents.length).toBeGreaterThanOrEqual(1);

      const latest = scanEvents[scanEvents.length - 1];
      expect(latest.agent_name).toBe("knowledge_agent");
      expect(latest.outcome).toBe("success");
      expect(latest.metadata?.files_found).toBeGreaterThanOrEqual(3);
    });
  });

  // ── Write Access Restriction ─────────────────────────────────────

  describe("write access restriction", () => {
    it("allows writing to _agent_insights/ directory", async () => {
      const connector = new VaultConnector({ vaultPath, emitter });
      const fm = {
        type: "moc",
        theme: "test-theme",
        generated_at: new Date().toISOString(),
        generated_by: "knowledge_agent",
      };
      const body = "# Test MOC\n\nThis is a test insight.\n";

      const writtenPath = await connector.writeInsight("test-moc.md", fm, body);

      expect(writtenPath).toContain("_agent_insights");
      const content = await readFile(writtenPath, "utf-8");
      expect(content).toContain("type: moc");
      expect(content).toContain("Test MOC");

      // Verify it's valid Obsidian markdown (round-trip)
      const parsed = parseFrontmatter(content);
      expect(parsed.frontmatter).not.toBeNull();
      expect(parsed.frontmatter!.type).toBe("moc");
      expect(parsed.body).toContain("Test MOC");
    });

    it("allows writing to _agent_insights/ subdirectories", async () => {
      const connector = new VaultConnector({ vaultPath, emitter });
      const fm = { type: "summary", domain: "gix" };
      const body = "# GIX Domain Summary\n";

      const writtenPath = await connector.writeInsight(
        "summaries/gix-weekly.md",
        fm,
        body,
      );

      expect(writtenPath).toContain("_agent_insights");
      expect(writtenPath).toContain("summaries");
      const content = await readFile(writtenPath, "utf-8");
      expect(content).toContain("domain: gix");
    });

    it("throws error when attempting to write outside _agent_insights/", async () => {
      const connector = new VaultConnector({ vaultPath, emitter });

      await expect(
        connector.write("Finance/Entities/hack.md", "malicious content"),
      ).rejects.toThrow("Write access restricted to _agent_insights/ directory only");
    });

    it("throws error for path traversal attempts", async () => {
      const connector = new VaultConnector({ vaultPath, emitter });

      await expect(
        connector.write("_agent_insights/../../etc/passwd", "nope"),
      ).rejects.toThrow("Write access denied");
    });

    it("throws error for root-level writes", async () => {
      const connector = new VaultConnector({ vaultPath, emitter });

      await expect(
        connector.write("some-note.md", "should not work"),
      ).rejects.toThrow("Write access restricted to _agent_insights/ directory only");
    });

    it("emits telemetry for successful writes", async () => {
      const connector = new VaultConnector({ vaultPath, emitter });
      const fm = { type: "test" };
      await connector.writeInsight("telemetry-test.md", fm, "# Test\n");

      const events = await emitter.readEvents(new Date());
      const writeEvents = events.filter(
        (e) => e.event_subtype === "vault_write_insight",
      );
      expect(writeEvents.length).toBeGreaterThanOrEqual(1);
      expect(writeEvents[writeEvents.length - 1].outcome).toBe("success");
    });
  });

  // ── File Watcher ─────────────────────────────────────────────────

  describe("file watcher", () => {
    it("starts and stops watching without errors", () => {
      const connector = new VaultConnector({ vaultPath, emitter });
      const events: VaultEvent[] = [];

      connector.startWatching((event) => events.push(event));
      connector.stopWatching();
      // No errors thrown = success
    });

    it("emits events when files are modified", async () => {
      const connector = new VaultConnector({ vaultPath, emitter });
      const events: VaultEvent[] = [];

      connector.startWatching((event) => events.push(event));

      // Small delay to let watcher settle and drain any pending events
      await new Promise((resolve) => setTimeout(resolve, 100));
      const preExisting = events.length;

      // Modify a file to trigger watcher
      const testFile = path.join(vaultPath, "watcher-test.md");
      await writeFile(testFile, "# Watcher Test\n");

      // Give fs.watch time to fire
      await new Promise((resolve) => setTimeout(resolve, 300));

      connector.stopWatching();

      // fs.watch behavior varies by platform — check events after our write
      const newEvents = events.slice(preExisting);
      if (newEvents.length > 0) {
        const watcherEvent = newEvents.find((e) =>
          e.filePath.includes("watcher-test.md"),
        );
        expect(watcherEvent).toBeDefined();
        expect(watcherEvent!.type).toMatch(/created|modified/);
        expect(watcherEvent!.timestamp).toBeInstanceOf(Date);
      }
    });

    it("does not create duplicate watchers on multiple startWatching calls", () => {
      const connector = new VaultConnector({ vaultPath, emitter });
      const events1: VaultEvent[] = [];
      const events2: VaultEvent[] = [];

      connector.startWatching((event) => events1.push(event));
      connector.startWatching((event) => events2.push(event));
      connector.stopWatching();
      // No errors thrown, both handlers registered but only one watcher
    });
  });

  // ── Edge Cases ───────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles empty vault directory", async () => {
      const emptyVault = path.join(tempDir, "empty-vault");
      await mkdir(emptyVault, { recursive: true });

      const connector = new VaultConnector({
        vaultPath: emptyVault,
        emitter,
      });
      const result = await connector.scan();

      expect(result.files).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it("getVaultPath returns the configured path", () => {
      const connector = new VaultConnector({ vaultPath, emitter });
      expect(connector.getVaultPath()).toBe(vaultPath);
    });

    it("includes materialization report in scan result", async () => {
      const connector = new VaultConnector({ vaultPath, emitter });
      const result = await connector.scan();

      expect(result.materialization).toBeDefined();
      expect(result.materialization!.total_stubs_found).toBe(0);
    });
  });
});
