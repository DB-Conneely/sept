#!/usr/bin/env node
/**
 * Installed SEPT CLI entry point. It owns process arguments, package metadata, top-level telemetry,
 * and exit presentation while delegating every command to public mechanism boundaries.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeCommand, resolveAgentDirectory } from "./cli/commands.js";
import { CliError } from "./cli/errors.js";
import { parseCliInvocation } from "./cli/options.js";
import { classifyError, createTelemetry, NOOP_TELEMETRY } from "./observability/index.js";

interface PackageMetadata {
  piVersion: string;
  septVersion: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageMetadata(): PackageMetadata {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (!isRecord(parsed)) {
    throw new CliError("SEPT package metadata is invalid");
  }
  const version = parsed.version;
  const dependencies = parsed.dependencies;
  const piVersion = isRecord(dependencies)
    ? dependencies["@earendil-works/pi-coding-agent"]
    : undefined;
  if (typeof version !== "string" || typeof piVersion !== "string") {
    throw new CliError("SEPT package metadata is invalid");
  }
  return { piVersion, septVersion: version };
}

let telemetry = NOOP_TELEMETRY;

async function main(): Promise<void> {
  const invocation = parseCliInvocation(process.argv);
  if (invocation === undefined) {
    process.stderr.write("Usage: sept worker|run|doctor|health|models|auth [action] [options]\n");
    process.exitCode = 2;
    return;
  }
  const metadata = packageMetadata();
  if (invocation.command === "worker" || invocation.command === "run") {
    telemetry = createTelemetry({
      serviceVersion: metadata.septVersion,
      command: invocation.command,
    });
  }
  process.title = `SEPT ${invocation.command}`;
  await executeCommand({
    ...invocation,
    ...metadata,
    agentDir: resolveAgentDirectory(invocation.options),
    telemetry,
  });
}

await main().catch(async (error: unknown) => {
  telemetry.log(
    "process.failed",
    { "sept.outcome": "failure", "error.type": classifyError(error) },
    "error",
  );
  await telemetry.shutdown();
  process.stderr.write(`sept: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
