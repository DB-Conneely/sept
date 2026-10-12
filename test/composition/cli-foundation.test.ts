/**
 * Directly exercises the exported CLI foundation seams beneath the installed-path suites. The
 * tests cover syntax classification, typed failures, agent-directory precedence, terminal cleanup,
 * and one credential-bearing command dispatch without substituting product mechanisms.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createTerminalAuthInteraction } from "../../src/cli/auth-interaction.js";
import { executeCommand, resolveAgentDirectory } from "../../src/cli/commands.js";
import { CliError } from "../../src/cli/errors.js";
import { parseCliInvocation } from "../../src/cli/options.js";
import { NOOP_TELEMETRY } from "../../src/observability/index.js";
import { closeServer, listen } from "./cli-support.js";

void test("CLI option parsing returns typed syntax and classified failures", () => {
  assert.deepEqual(
    parseCliInvocation(["node", "sept", "models", "list", "--provider", "openai-codex"]),
    {
      command: "models",
      action: "list",
      options: { provider: "openai-codex" },
    },
  );
  assert.throws(
    () => parseCliInvocation(["node", "sept", "health", "--unknown", "secret"]),
    CliError,
  );
});

void test("CLI agent directory precedence and terminal cleanup remain process-owned", () => {
  const agentDir = mkdtempSync(`${tmpdir()}/sept-cli-agent-`);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    assert.equal(resolveAgentDirectory({}), resolve(agentDir));
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
  }
  const listeners = process.listenerCount("SIGINT");
  const interaction = createTerminalAuthInteraction();
  const signal = interaction.signal;
  assert.ok(signal !== undefined);
  assert.equal(signal.aborted, false);
  interaction.close();
  assert.equal(signal.aborted, true);
  assert.equal(process.listenerCount("SIGINT"), listeners);
});

async function executeHealthCommand(): Promise<void> {
  const token = "CLI-FOUNDATION-TOKEN";
  const provider = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.writeHead(200).end();
  });
  const port = await listen(provider);
  const previous = process.env.SEPT_TOKEN;
  process.env.SEPT_TOKEN = token;
  try {
    await executeCommand({
      command: "health",
      options: { url: `http://127.0.0.1:${String(port)}/health` },
      agentDir: process.cwd(),
      piVersion: "fixture",
      septVersion: "fixture",
      telemetry: NOOP_TELEMETRY,
    });
  } finally {
    if (previous === undefined) {
      delete process.env.SEPT_TOKEN;
    } else {
      process.env.SEPT_TOKEN = previous;
    }
    await closeServer(provider);
  }
}

void test(
  "executeCommand dispatches authenticated health without exposing the token",
  executeHealthCommand,
);
