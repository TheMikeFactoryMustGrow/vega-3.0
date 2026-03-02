/**
 * VEGA 3.0 Environment Health Check (US-001)
 *
 * Verifies: Docker, IronClaw, PostgreSQL, xAI API, pmset (sleep settings).
 * Outputs PASS/FAIL summary for each check.
 */

import { execSync } from "node:child_process";

interface CheckResult {
  name: string;
  status: "PASS" | "FAIL" | "WARN";
  detail: string;
}

function run(cmd: string, timeoutMs = 10_000): string {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(err.stderr?.trim() || err.message || "command failed");
  }
}

function tryRun(cmd: string, timeoutMs = 10_000): string | null {
  try {
    return run(cmd, timeoutMs);
  } catch {
    return null;
  }
}

// ── Docker ──────────────────────────────────────────────────────────────────

function checkDocker(): CheckResult {
  const version = tryRun("docker --version");
  if (!version) {
    return { name: "Docker", status: "FAIL", detail: "Docker not found or not running" };
  }
  return { name: "Docker version", status: "PASS", detail: version };
}

function checkDockerContainers(): CheckResult {
  const output = tryRun("docker ps -a --format '{{.Names}}\t{{.Status}}'");
  if (output === null) {
    return { name: "Docker containers", status: "FAIL", detail: "Cannot query Docker containers" };
  }
  if (output === "") {
    return { name: "Docker containers", status: "PASS", detail: "No orphaned or stopped containers" };
  }

  const lines = output.split("\n").filter(Boolean);
  const stopped = lines.filter((l) => !l.includes("Up "));
  if (stopped.length > 0) {
    return {
      name: "Docker containers",
      status: "WARN",
      detail: `${stopped.length} stopped/orphaned container(s): ${stopped.map((l) => l.split("\t")[0]).join(", ")}`,
    };
  }
  return {
    name: "Docker containers",
    status: "PASS",
    detail: `${lines.length} running container(s), none stopped/orphaned`,
  };
}

// ── IronClaw ────────────────────────────────────────────────────────────────

function checkIronClaw(): CheckResult {
  const version = tryRun("ironclaw --version");
  if (!version) {
    return { name: "IronClaw", status: "FAIL", detail: "ironclaw not found in PATH" };
  }

  const status = tryRun("ironclaw status");
  if (!status) {
    return { name: "IronClaw", status: "FAIL", detail: `${version} found but 'ironclaw status' failed` };
  }

  const dbMatch = status.match(/Database:\s+(.+)/);
  const dbStatus = dbMatch?.[1] ?? "unknown";
  const isDbConnected = dbStatus.includes("connected");

  return {
    name: "IronClaw",
    status: isDbConnected ? "PASS" : "WARN",
    detail: `${version} | DB: ${dbStatus}`,
  };
}

// ── PostgreSQL ──────────────────────────────────────────────────────────────

function checkPostgres(): CheckResult {
  const ready = tryRun("pg_isready");
  if (!ready) {
    return { name: "PostgreSQL", status: "FAIL", detail: "pg_isready not available or PostgreSQL not running" };
  }
  if (ready.includes("accepting connections")) {
    const version = tryRun("psql --version") ?? "version unknown";
    return { name: "PostgreSQL", status: "PASS", detail: `${version} — ${ready}` };
  }
  return { name: "PostgreSQL", status: "FAIL", detail: ready };
}

// ── xAI API ─────────────────────────────────────────────────────────────────

function checkXaiApi(): CheckResult {
  // Check if API key is available via environment
  const apiKey = process.env["XAI_API_KEY"];
  if (!apiKey) {
    // Fall back: check if IronClaw can reach the API (it stores keys in keychain)
    const ironclawStatus = tryRun("ironclaw status");
    const hasLlm = ironclawStatus?.includes("openai_compatible") || ironclawStatus?.includes("x.ai");

    // Try ironclaw doctor to verify connectivity
    const doctor = tryRun("ironclaw doctor");
    const doctorPassed = doctor?.includes("[pass]") && !doctor?.includes("[fail]");

    if (doctorPassed) {
      // Get the configured model
      const config = tryRun("ironclaw config list");
      const modelMatch = config?.match(/selected_model\s+(.+)/);
      const model = modelMatch?.[1]?.trim() ?? "unknown";
      const baseUrlMatch = config?.match(/openai_compatible_base_url\s+(.+)/);
      const baseUrl = baseUrlMatch?.[1]?.trim() ?? "unknown";

      return {
        name: "xAI API",
        status: hasLlm ? "PASS" : "WARN",
        detail: `IronClaw configured: model=${model}, base_url=${baseUrl}. XAI_API_KEY not in shell env (stored in IronClaw keychain).`,
      };
    }

    return {
      name: "xAI API",
      status: "WARN",
      detail: "XAI_API_KEY not set in environment. IronClaw may have it in keychain but could not verify LLM call.",
    };
  }

  // If we have the key, test the API directly
  const curlCmd = `curl -s -w "\\n%{http_code}" -X POST https://api.x.ai/v1/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer ${apiKey}" -d '{"model":"grok-4.20","messages":[{"role":"user","content":"Say hello"}],"max_tokens":5}'`;
  const result = tryRun(curlCmd, 15_000);
  if (!result) {
    return { name: "xAI API", status: "FAIL", detail: "API call timed out or failed" };
  }

  const lines = result.split("\n");
  const httpCode = lines[lines.length - 1];
  if (httpCode === "200") {
    return { name: "xAI API", status: "PASS", detail: "Grok-4.20 responded successfully (HTTP 200)" };
  }
  return { name: "xAI API", status: "FAIL", detail: `API returned HTTP ${httpCode}` };
}

// ── pmset (sleep settings) ──────────────────────────────────────────────────

function checkPmset(): CheckResult {
  const output = tryRun("pmset -g custom");
  if (!output) {
    return { name: "pmset", status: "FAIL", detail: "Cannot read pmset settings" };
  }

  const warnings: string[] = [];

  // Parse AC Power section (primary concern for always-on server)
  const acSection = output.split("AC Power:")[1] ?? output;
  const sleepMatch = acSection.match(/\bsleep\s+(\d+)/);
  const diskSleepMatch = acSection.match(/\bdisksleep\s+(\d+)/);

  const sleepVal = sleepMatch ? parseInt(sleepMatch[1], 10) : null;
  const diskSleepVal = diskSleepMatch ? parseInt(diskSleepMatch[1], 10) : null;

  if (sleepVal !== 0) {
    warnings.push(`sleep=${sleepVal ?? "unknown"} (should be 0)`);
  }
  if (diskSleepVal !== 0) {
    warnings.push(`disksleep=${diskSleepVal ?? "unknown"} (should be 0)`);
  }

  if (warnings.length > 0) {
    return {
      name: "pmset (sleep)",
      status: "WARN",
      detail: `Sleep not disabled on AC: ${warnings.join(", ")}. Run: sudo pmset -c sleep 0 disksleep 0`,
    };
  }
  return { name: "pmset (sleep)", status: "PASS", detail: "sleep=0, disksleep=0 on AC Power" };
}

// ── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║      VEGA 3.0 Environment Health Check          ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const checks: CheckResult[] = [
    checkDocker(),
    checkDockerContainers(),
    checkIronClaw(),
    checkPostgres(),
    checkXaiApi(),
    checkPmset(),
  ];

  const maxName = Math.max(...checks.map((c) => c.name.length));

  for (const check of checks) {
    const icon = check.status === "PASS" ? "✓" : check.status === "WARN" ? "⚠" : "✗";
    const label = check.status === "PASS" ? "PASS" : check.status === "WARN" ? "WARN" : "FAIL";
    console.log(`  ${icon} [${label}] ${check.name.padEnd(maxName)}  ${check.detail}`);
  }

  const passed = checks.filter((c) => c.status === "PASS").length;
  const warned = checks.filter((c) => c.status === "WARN").length;
  const failed = checks.filter((c) => c.status === "FAIL").length;

  console.log("\n" + "─".repeat(54));
  console.log(`  Summary: ${passed} passed, ${warned} warnings, ${failed} failed`);

  if (failed > 0) {
    console.log("  Result: ENVIRONMENT NOT READY — fix failures above");
    process.exit(1);
  } else if (warned > 0) {
    console.log("  Result: ENVIRONMENT READY (with warnings)");
  } else {
    console.log("  Result: ENVIRONMENT HEALTHY");
  }
}

main();
