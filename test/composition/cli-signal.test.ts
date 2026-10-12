/**
 * Exercises installed worker signal and cancellation races against real provider requests. The
 * fixture owns sockets/processes; durable lifecycle and Pi cancellation remain production-owned.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  closeServer,
  CompositionFixtureError,
  installedWorker,
  listen,
  openAiReply,
  parseRecord,
  prepareDirectories,
  record,
  responseRecord,
  stopInstalled,
  stringField,
  waitForExit,
  waitForTask,
  writeProvider,
} from "./cli-support.js";

interface GracefulFixture {
  agent: string;
  child: ReturnType<typeof installedWorker>;
  pending(): ServerResponse;
  provider: Server;
  requested: Promise<void>;
  state: string;
  token: string;
  workspace: string;
}

async function gracefulFixture(): Promise<GracefulFixture> {
  const root = mkdtempSync(join(tmpdir(), "sept-cli-graceful-"));
  const { agent, state, workspace } = prepareDirectories(root);
  let pendingResponse: ServerResponse | undefined;
  let markRequested = (): void => undefined;
  const requested = new Promise<void>((resolvePromise) => {
    markRequested = resolvePromise;
  });
  const provider = createServer((request, response) => {
    request.resume();
    pendingResponse = response;
    markRequested();
  });
  const port = await listen(provider);
  writeProvider(agent, port, "local-test", { apiKey: "local", maxTokens: 200 });
  const token = "graceful-cli-token";
  const child = installedWorker(state, agent, root, token);
  return {
    agent,
    child,
    provider,
    requested,
    state,
    token,
    workspace,
    pending: () => {
      if (pendingResponse === undefined) {
        throw new CompositionFixtureError("provider response was not requested");
      }
      return pendingResponse;
    },
  };
}

async function startThenSignal(
  fixture: GracefulFixture,
): Promise<{ exited: ReturnType<typeof waitForExit> }> {
  const base = await fixture.child.address;
  const response = await fetch(`${base}/v1/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      task: "checkpoint on signal",
      workspace: fixture.workspace,
      provider: "local-test",
      model: "fixture",
      thinking: "off",
      maxInvocations: 2,
    }),
  });
  assert.equal(response.status, 202);
  await fixture.requested;
  const exited = waitForExit(fixture.child.child);
  fixture.child.child.kill("SIGTERM");
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, 75);
  });
  assert.equal(fixture.child.child.exitCode, null);
  assert.equal(existsSync(join(fixture.state, "worker.lease")), true);
  return { exited };
}

async function settleGracefully(fixture: GracefulFixture): Promise<void> {
  const { exited } = await startThenSignal(fixture);
  const control = JSON.stringify({
    status: "continue",
    summary: "signal-safe checkpoint",
    verification: ["provider replied"],
    next_action: "resume after restart",
  });
  openAiReply(fixture.pending(), control);
  assert.deepEqual(await exited, { code: 0, signal: null });
  const runName = readdirSync(fixture.state).find((name) => !name.startsWith("."));
  assert.ok(runName !== undefined);
  const runDir = join(fixture.state, runName);
  const snapshot = parseRecord(readFileSync(join(runDir, "state.json"), "utf8"), "run state");
  assert.equal(snapshot.status, "active");
  assert.match(readFileSync(join(runDir, "events.jsonl"), "utf8"), /"work_checkpoint"/);
  assert.equal(existsSync(join(fixture.state, "worker.lease")), false);
  assert.equal(existsSync(join(runDir, "controller.lease")), false);
  assert.doesNotMatch(fixture.child.stderr(), /signal-safe checkpoint/);
}

async function gracefulSignalScenario(): Promise<void> {
  const fixture = await gracefulFixture();
  try {
    await settleGracefully(fixture);
  } finally {
    await stopInstalled(fixture.child.child);
    await closeServer(fixture.provider);
  }
}

void test(
  "public worker SIGTERM waits for an active production PiSessionHost checkpoint",
  gracefulSignalScenario,
);

interface CancellationFixture {
  aborted(): boolean;
  child: ReturnType<typeof installedWorker>;
  provider: Server;
  requested: Promise<void>;
  state: string;
  token: string;
  workspace: string;
}

async function cancellationFixture(): Promise<CancellationFixture> {
  const root = mkdtempSync(join(tmpdir(), "sept-cli-part1-cancel-"));
  const { agent, state, workspace } = prepareDirectories(root);
  let markRequested = (): void => undefined;
  const requested = new Promise<void>((resolvePromise) => {
    markRequested = resolvePromise;
  });
  let providerResponseAborted = false;
  const provider = createServer((request, response) => {
    response.once("close", () => {
      providerResponseAborted ||= !response.writableEnded;
    });
    request.once("end", markRequested);
    request.resume();
  });
  const port = await listen(provider);
  writeProvider(agent, port, "local-cancel", { apiKey: "local", maxTokens: 200 });
  const token = "installed-part1-cancel-token";
  return {
    child: installedWorker(state, agent, root, token),
    provider,
    requested,
    state,
    token,
    workspace,
    aborted: () => providerResponseAborted,
  };
}

async function requestCancellation(fixture: CancellationFixture): Promise<string> {
  const base = await fixture.child.address;
  const task = await fetch(`${base}/v1/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      task: "cancel the installed model request",
      workspace: fixture.workspace,
      provider: "local-cancel",
      model: "fixture",
      thinking: "off",
    }),
  });
  const runId = stringField(await responseRecord(task, "task admission"), "runId");
  await fixture.requested;
  const cancel = await fetch(`${base}/v1/tasks/${runId}/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
  assert.ok(cancel.status === 200 || cancel.status === 202);
  await waitForTask(base, runId, fixture.token, "cancelled");
  return runId;
}

async function verifyCancellation(fixture: CancellationFixture, runId: string): Promise<void> {
  const events = readFileSync(join(fixture.state, runId, "events.jsonl"), "utf8");
  assert.ok(events.indexOf("run_cancellation_requested") < events.indexOf("run_cancelled"));
  assert.doesNotMatch(events, /run_completed/);
  const base = await fixture.child.address;
  const response = await fetch(`${base}/v1/tasks/${runId}/conversation`, {
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
  const terminal = record((await responseRecord(response)).terminal, "terminal state");
  assert.equal(terminal.status, "cancelled");
  const deadline = Date.now() + 4_000;
  while (!fixture.aborted() && Date.now() < deadline) {
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 10);
    });
  }
  assert.equal(fixture.aborted(), true);
  assert.doesNotMatch(fixture.child.stderr(), new RegExp(fixture.token));
}

async function cancellationScenario(): Promise<void> {
  const fixture = await cancellationFixture();
  try {
    await verifyCancellation(fixture, await requestCancellation(fixture));
  } finally {
    await stopInstalled(fixture.child.child);
    await closeServer(fixture.provider);
  }
}

void test(
  "installed worker cancellation aborts active production Pi model work after durable intent",
  cancellationScenario,
);
