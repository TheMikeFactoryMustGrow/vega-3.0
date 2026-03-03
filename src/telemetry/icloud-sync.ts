import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface MaterializationResult {
  file: string;
  success: boolean;
  error?: string;
}

export interface MaterializationReport {
  total_stubs_found: number;
  successfully_materialized: number;
  failed: MaterializationResult[];
}

export interface MaterializeOptions {
  /** Timeout per file in milliseconds (default: 30000) */
  timeout_ms?: number;
  /** Polling interval in milliseconds (default: 1000) */
  poll_interval_ms?: number;
  /** Custom brctl command path (for testing) */
  brctl_command?: string;
  /** Custom exec function (for testing) */
  exec_fn?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Find all .icloud stub files in a directory (recursively).
 *
 * iCloud Drive creates stub files with a `.icloud` extension when content
 * is evicted from local storage. The actual file name is stored with a
 * leading dot: e.g., `.myfile.md.icloud` is the stub for `myfile.md`.
 */
export async function find_icloud_stubs(directory: string): Promise<string[]> {
  const stubs: string[] = [];

  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const subStubs = await find_icloud_stubs(fullPath);
        stubs.push(...subStubs);
      } else if (entry.name.endsWith(".icloud")) {
        stubs.push(fullPath);
      }
    }
  } catch (err) {
    process.stderr.write(`[iCloudSync] Failed to scan directory ${directory}: ${err}\n`);
  }

  return stubs;
}

/**
 * Get the expected materialized file path from a .icloud stub path.
 *
 * iCloud stubs follow the pattern: `.filename.ext.icloud` → `filename.ext`
 * The leading dot is added by iCloud and the `.icloud` extension is appended.
 */
export function get_materialized_path(stubPath: string): string {
  const dir = path.dirname(stubPath);
  const stubName = path.basename(stubPath);
  // Remove leading dot and trailing .icloud
  const materializedName = stubName.replace(/^\./, "").replace(/\.icloud$/, "");
  return path.join(dir, materializedName);
}

/**
 * Wait for a file to materialize (appear on disk) with polling.
 */
async function wait_for_materialization(
  filePath: string,
  timeout_ms: number,
  poll_interval_ms: number,
): Promise<boolean> {
  const deadline = Date.now() + timeout_ms;

  while (Date.now() < deadline) {
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > 0) {
        return true;
      }
    } catch {
      // File doesn't exist yet, keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, poll_interval_ms));
  }

  return false;
}

/**
 * Materialize iCloud stub files by invoking `brctl download`.
 *
 * Detects `.icloud` stub files in the target directory, triggers iCloud
 * download for each one, and waits for materialization with a configurable
 * timeout.
 *
 * Failed materializations are logged as warnings but do not block vault
 * processing (graceful degradation).
 *
 * @param directory - The directory to scan for .icloud stubs
 * @param options - Configuration options
 * @returns MaterializationReport with results
 */
export async function materialize_icloud_stubs(
  directory: string,
  options: MaterializeOptions = {},
): Promise<MaterializationReport> {
  const {
    timeout_ms = 30_000,
    poll_interval_ms = 1_000,
    brctl_command = "brctl",
    exec_fn,
  } = options;

  const report: MaterializationReport = {
    total_stubs_found: 0,
    successfully_materialized: 0,
    failed: [],
  };

  // Find all .icloud stubs
  const stubs = await find_icloud_stubs(directory);
  report.total_stubs_found = stubs.length;

  if (stubs.length === 0) {
    return report;
  }

  for (const stubPath of stubs) {
    const materializedPath = get_materialized_path(stubPath);

    try {
      // Invoke brctl download to trigger iCloud materialization
      const execFn = exec_fn ?? ((cmd: string, args: string[]) => execFileAsync(cmd, args));
      await execFn(brctl_command, ["download", stubPath]);

      // Wait for file to materialize
      const materialized = await wait_for_materialization(
        materializedPath,
        timeout_ms,
        poll_interval_ms,
      );

      if (materialized) {
        report.successfully_materialized++;
      } else {
        const result: MaterializationResult = {
          file: stubPath,
          success: false,
          error: `Timeout after ${timeout_ms}ms waiting for materialization`,
        };
        report.failed.push(result);
        process.stderr.write(
          `[iCloudSync] Warning: ${result.error} for ${stubPath}\n`,
        );
      }
    } catch (err) {
      const result: MaterializationResult = {
        file: stubPath,
        success: false,
        error: String(err),
      };
      report.failed.push(result);
      process.stderr.write(
        `[iCloudSync] Warning: Failed to materialize ${stubPath}: ${err}\n`,
      );
    }
  }

  return report;
}
