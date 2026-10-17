#!/usr/bin/env node
/**
 * Installed SEPT CLI entry point. It owns process arguments, package metadata, top-level telemetry,
 * and exit presentation while delegating every command to public mechanism boundaries.
 */

import { executeCommand, resolveAgentDirectory } from "./cli/commands.js";
import { parseCliInvocation } from "./cli/options.js";
import { classifyError, createTelemetry, NOOP_TELEMETRY } from "./observability/index.js";
import { packageMetadata } from "./package-metadata.js";

let telemetry = NOOP_TELEMETRY;

async function main(): Promise<void> {
  const invocation = parseCliInvocation(process.argv);
  if (invocation === undefined) {
    process.stderr.write(
      "Usage: sept worker|run|doctor|health|models|auth|permissions|hands [action] [options]\n",
    );
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
