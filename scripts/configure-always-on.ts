/**
 * VEGA 3.0 Always-On Configuration (US-002)
 *
 * Configures the host for continuous operation:
 * 1. pmset: sleep 0, disksleep 0 on AC power
 * 2. Docker Desktop: autoStart on login
 * 3. Documents the --restart unless-stopped convention for all containers
 *
 * Requires: sudo for pmset changes.
 * Usage: sudo npx tsx scripts/configure-always-on.ts
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

interface StepResult {
  name: string;
  status: "OK" | "SKIPPED" | "FAILED";
  detail: string;
}

function run(cmd: string, timeoutMs = 10_000): string {
  return execSync(cmd, {
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function tryRun(cmd: string, timeoutMs = 10_000): string | null {
  try {
    return run(cmd, timeoutMs);
  } catch {
    return null;
  }
}

// ── Step 1: pmset ──────────────────────────────────────────────────────────

function configurePmset(): StepResult {
  // Read current settings
  const output = tryRun("pmset -g custom");
  if (!output) {
    return { name: "pmset", status: "FAILED", detail: "Cannot read pmset settings" };
  }

  const acSection = output.split("AC Power:")[1] ?? output;
  const sleepMatch = acSection.match(/\bsleep\s+(\d+)/);
  const diskSleepMatch = acSection.match(/\bdisksleep\s+(\d+)/);
  const sleepVal = sleepMatch ? parseInt(sleepMatch[1], 10) : -1;
  const diskSleepVal = diskSleepMatch ? parseInt(diskSleepMatch[1], 10) : -1;

  if (sleepVal === 0 && diskSleepVal === 0) {
    return { name: "pmset", status: "SKIPPED", detail: "Already configured: sleep=0, disksleep=0 on AC" };
  }

  // Apply settings (requires sudo)
  try {
    run("pmset -c sleep 0");
    run("pmset -c disksleep 0");
  } catch (e: unknown) {
    const err = e as { message?: string };
    return {
      name: "pmset",
      status: "FAILED",
      detail: `Failed to set pmset. Run with sudo? Error: ${err.message ?? "unknown"}`,
    };
  }

  // Verify
  const verify = tryRun("pmset -g custom");
  const verifyAc = verify?.split("AC Power:")?.[1] ?? verify ?? "";
  const newSleep = verifyAc.match(/\bsleep\s+(\d+)/)?.[1];
  const newDiskSleep = verifyAc.match(/\bdisksleep\s+(\d+)/)?.[1];

  if (newSleep === "0" && newDiskSleep === "0") {
    return { name: "pmset", status: "OK", detail: "Set sleep=0, disksleep=0 on AC power" };
  }

  return {
    name: "pmset",
    status: "FAILED",
    detail: `Verification failed: sleep=${newSleep ?? "?"}, disksleep=${newDiskSleep ?? "?"}`,
  };
}

// ── Step 2: Docker auto-start ──────────────────────────────────────────────

function configureDockerAutoStart(): StepResult {
  const settingsPath = `${process.env["HOME"]}/Library/Group Containers/group.com.docker/settings.json`;

  let settings: Record<string, unknown>;
  try {
    const raw = readFileSync(settingsPath, "utf-8");
    settings = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { name: "Docker autoStart", status: "FAILED", detail: `Cannot read ${settingsPath}` };
  }

  if (settings["autoStart"] === true) {
    return { name: "Docker autoStart", status: "SKIPPED", detail: "Already enabled" };
  }

  settings["autoStart"] = true;

  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } catch (e: unknown) {
    const err = e as { message?: string };
    return {
      name: "Docker autoStart",
      status: "FAILED",
      detail: `Cannot write settings: ${err.message ?? "unknown"}`,
    };
  }

  // Verify
  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const verify = JSON.parse(raw) as Record<string, unknown>;
    if (verify["autoStart"] === true) {
      return {
        name: "Docker autoStart",
        status: "OK",
        detail: "Docker Desktop will now start on login",
      };
    }
  } catch {
    // Fall through to failed
  }

  return { name: "Docker autoStart", status: "FAILED", detail: "Verification failed after write" };
}

// ── Step 3: Document restart policy convention ─────────────────────────────

function documentRestartPolicy(): StepResult {
  return {
    name: "Restart policy convention",
    status: "OK",
    detail: "All Docker containers must use --restart unless-stopped (enforced in subsequent stories)",
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   VEGA 3.0 Always-On Configuration (US-002)      ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const steps: StepResult[] = [
    configurePmset(),
    configureDockerAutoStart(),
    documentRestartPolicy(),
  ];

  const maxName = Math.max(...steps.map((s) => s.name.length));

  for (const step of steps) {
    const icon = step.status === "OK" ? "✓" : step.status === "SKIPPED" ? "→" : "✗";
    console.log(`  ${icon} [${step.status.padEnd(7)}] ${step.name.padEnd(maxName)}  ${step.detail}`);
  }

  const failed = steps.filter((s) => s.status === "FAILED").length;

  console.log("\n" + "─".repeat(54));
  if (failed > 0) {
    console.log(`  ${failed} step(s) failed. Fix issues above and re-run.`);
    process.exit(1);
  } else {
    console.log("  All steps completed successfully.");
    console.log("\n  Reminder: All Docker containers must use:");
    console.log("    --restart unless-stopped");
    console.log("  This is enforced by convention in all subsequent stories.");
  }
}

main();
