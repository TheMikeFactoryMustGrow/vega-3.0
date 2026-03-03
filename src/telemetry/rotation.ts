import { readdir, stat, unlink, rename } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import path from "node:path";

/**
 * Telemetry Rotation Job
 *
 * Runs daily at 00:05 UTC:
 * - Move JSONL files >30 days old from events/ to archive/ (gzipped)
 * - Delete archive files >90 days old
 *
 * Active window: 30 days in ~/vega-telemetry/events/
 * Archive: 90 days in ~/vega-telemetry/archive/
 */

const ACTIVE_RETENTION_DAYS = 30;
const ARCHIVE_RETENTION_DAYS = 90;

/** Parse a date from a JSONL event filename like "2026-01-15.jsonl" */
function parseDateFromFilename(filename: string): Date | null {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/);
  if (!match) return null;
  const date = new Date(match[1] + "T00:00:00Z");
  return isNaN(date.getTime()) ? null : date;
}

/** Calculate the age in days of a file based on its date component */
function ageDays(fileDate: Date, now: Date): number {
  const diffMs = now.getTime() - fileDate.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

export interface RotationResult {
  archived: string[];
  deleted: string[];
  errors: Array<{ file: string; error: string }>;
}

/**
 * Gzip a file from source to destination.
 * Writes to a temp file first, then renames for atomicity.
 */
async function gzipFile(srcPath: string, destPath: string): Promise<void> {
  const tmpPath = destPath + ".tmp";
  const readStream = createReadStream(srcPath);
  const gzipStream = createGzip();
  const writeStream = createWriteStream(tmpPath);

  await pipeline(readStream, gzipStream, writeStream);
  await rename(tmpPath, destPath);
}

/**
 * Run the rotation job.
 *
 * @param eventsDir - Path to the events directory
 * @param archiveDir - Path to the archive directory
 * @param now - Current date (injectable for testing)
 */
export async function runRotation(
  eventsDir: string,
  archiveDir: string,
  now: Date = new Date()
): Promise<RotationResult> {
  const result: RotationResult = { archived: [], deleted: [], errors: [] };

  // Phase 1: Archive events >30 days old
  try {
    const eventFiles = await readdir(eventsDir);
    for (const file of eventFiles) {
      if (!file.endsWith(".jsonl")) continue;
      const fileDate = parseDateFromFilename(file);
      if (!fileDate) continue;

      if (ageDays(fileDate, now) > ACTIVE_RETENTION_DAYS) {
        const srcPath = path.join(eventsDir, file);
        const destPath = path.join(archiveDir, `${file}.gz`);
        try {
          await gzipFile(srcPath, destPath);
          await unlink(srcPath);
          result.archived.push(file);
        } catch (err) {
          result.errors.push({ file, error: String(err) });
        }
      }
    }
  } catch (err) {
    result.errors.push({ file: eventsDir, error: `Failed to read events dir: ${err}` });
  }

  // Phase 2: Delete archive files >90 days old
  try {
    const archiveFiles = await readdir(archiveDir);
    for (const file of archiveFiles) {
      if (!file.endsWith(".jsonl.gz")) continue;
      const fileDate = parseDateFromFilename(file.replace(/\.gz$/, ""));
      if (!fileDate) continue;

      if (ageDays(fileDate, now) > ARCHIVE_RETENTION_DAYS) {
        const filePath = path.join(archiveDir, file);
        try {
          await unlink(filePath);
          result.deleted.push(file);
        } catch (err) {
          result.errors.push({ file, error: String(err) });
        }
      }
    }
  } catch (err) {
    result.errors.push({ file: archiveDir, error: `Failed to read archive dir: ${err}` });
  }

  return result;
}
