import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  materialize_icloud_stubs,
  find_icloud_stubs,
  get_materialized_path,
} from "./icloud-sync.js";

describe("iCloud Sync Handler", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "icloud-sync-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("find_icloud_stubs", () => {
    it("detects .icloud stub files in a directory", async () => {
      // Create stub files mimicking iCloud behavior
      await writeFile(path.join(tmpDir, ".notes.md.icloud"), "");
      await writeFile(path.join(tmpDir, ".photo.jpg.icloud"), "");
      await writeFile(path.join(tmpDir, "regular-file.md"), "content");

      const stubs = await find_icloud_stubs(tmpDir);

      expect(stubs).toHaveLength(2);
      expect(stubs.some((s) => s.endsWith(".notes.md.icloud"))).toBe(true);
      expect(stubs.some((s) => s.endsWith(".photo.jpg.icloud"))).toBe(true);
    });

    it("detects stubs in nested directories", async () => {
      const subDir = path.join(tmpDir, "subfolder");
      await mkdir(subDir, { recursive: true });
      await writeFile(path.join(tmpDir, ".top-level.md.icloud"), "");
      await writeFile(path.join(subDir, ".nested-file.txt.icloud"), "");

      const stubs = await find_icloud_stubs(tmpDir);

      expect(stubs).toHaveLength(2);
    });

    it("returns empty array for directory with no stubs", async () => {
      await writeFile(path.join(tmpDir, "normal.md"), "content");

      const stubs = await find_icloud_stubs(tmpDir);

      expect(stubs).toHaveLength(0);
    });

    it("returns empty array for non-existent directory", async () => {
      const stubs = await find_icloud_stubs(path.join(tmpDir, "nonexistent"));

      expect(stubs).toHaveLength(0);
    });
  });

  describe("get_materialized_path", () => {
    it("converts stub path to expected materialized path", () => {
      const stubPath = "/vault/.my-note.md.icloud";
      const result = get_materialized_path(stubPath);
      expect(result).toBe("/vault/my-note.md");
    });

    it("handles nested paths correctly", () => {
      const stubPath = "/vault/subfolder/.document.pdf.icloud";
      const result = get_materialized_path(stubPath);
      expect(result).toBe("/vault/subfolder/document.pdf");
    });
  });

  describe("materialize_icloud_stubs", () => {
    it("detects stubs and attempts download via brctl", async () => {
      // Create a stub file
      await writeFile(path.join(tmpDir, ".test-note.md.icloud"), "");

      const brctlCalls: Array<{ command: string; args: string[] }> = [];

      // Mock exec that simulates successful brctl download
      const mockExec = async (command: string, args: string[]) => {
        brctlCalls.push({ command, args });
        // Simulate materialization by writing the real file
        const stubPath = args[1];
        const materializedPath = get_materialized_path(stubPath);
        await writeFile(materializedPath, "materialized content");
        return { stdout: "", stderr: "" };
      };

      const report = await materialize_icloud_stubs(tmpDir, {
        exec_fn: mockExec,
        timeout_ms: 5000,
        poll_interval_ms: 100,
      });

      expect(report.total_stubs_found).toBe(1);
      expect(report.successfully_materialized).toBe(1);
      expect(report.failed).toHaveLength(0);

      // Verify brctl was called with correct args
      expect(brctlCalls).toHaveLength(1);
      expect(brctlCalls[0].args[0]).toBe("download");
      expect(brctlCalls[0].args[1]).toContain(".test-note.md.icloud");
    });

    it("reports timeout on failed materialization", async () => {
      // Create a stub file
      await writeFile(path.join(tmpDir, ".stuck-file.md.icloud"), "");

      // Mock exec that does NOT create the materialized file (simulates timeout)
      const mockExec = async (_command: string, _args: string[]) => {
        return { stdout: "", stderr: "" };
      };

      const report = await materialize_icloud_stubs(tmpDir, {
        exec_fn: mockExec,
        timeout_ms: 500,
        poll_interval_ms: 100,
      });

      expect(report.total_stubs_found).toBe(1);
      expect(report.successfully_materialized).toBe(0);
      expect(report.failed).toHaveLength(1);
      expect(report.failed[0].file).toContain(".stuck-file.md.icloud");
      expect(report.failed[0].success).toBe(false);
      expect(report.failed[0].error).toContain("Timeout");
    });

    it("handles brctl command failure gracefully", async () => {
      // Create a stub file
      await writeFile(path.join(tmpDir, ".error-file.md.icloud"), "");

      // Mock exec that throws an error
      const mockExec = async (_command: string, _args: string[]) => {
        throw new Error("brctl: command not found");
      };

      const report = await materialize_icloud_stubs(tmpDir, {
        exec_fn: mockExec,
        timeout_ms: 500,
        poll_interval_ms: 100,
      });

      expect(report.total_stubs_found).toBe(1);
      expect(report.successfully_materialized).toBe(0);
      expect(report.failed).toHaveLength(1);
      expect(report.failed[0].error).toContain("brctl: command not found");
    });

    it("returns zero stubs for directory with no icloud files", async () => {
      await writeFile(path.join(tmpDir, "regular.md"), "content");

      const report = await materialize_icloud_stubs(tmpDir);

      expect(report.total_stubs_found).toBe(0);
      expect(report.successfully_materialized).toBe(0);
      expect(report.failed).toHaveLength(0);
    });

    it("handles multiple stubs with mixed results", async () => {
      // Create multiple stub files
      await writeFile(path.join(tmpDir, ".success.md.icloud"), "");
      await writeFile(path.join(tmpDir, ".failure.md.icloud"), "");

      let callCount = 0;
      const mockExec = async (_command: string, args: string[]) => {
        callCount++;
        // First call succeeds (materializes the file)
        if (args[1].includes("success")) {
          const materializedPath = get_materialized_path(args[1]);
          await writeFile(materializedPath, "content");
        }
        // Second call doesn't materialize (timeout)
        return { stdout: "", stderr: "" };
      };

      const report = await materialize_icloud_stubs(tmpDir, {
        exec_fn: mockExec,
        timeout_ms: 500,
        poll_interval_ms: 100,
      });

      expect(report.total_stubs_found).toBe(2);
      expect(report.successfully_materialized).toBe(1);
      expect(report.failed).toHaveLength(1);
      expect(report.failed[0].file).toContain("failure");
    });
  });
});
