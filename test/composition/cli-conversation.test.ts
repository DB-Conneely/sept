/**
 * Exercises installed conversation continuity across Pi rotation, interruption, restart, drain,
 * and completion. Fixture servers supply model bytes; production owns every durable transition.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createTaskClient, TaskClientError } from "../../src/client/index.js";
import { waitFor } from "../runtime/support.js";
import {
  closeServer,
  installedWorker,
  type InstalledWorker,
  killInstalled,
  listen,
  openAiReply,
  prepareDirectories,
  record,
  responseRecord,
  stopInstalled,
  waitForTask,
  writeProvider,
} from "./cli-support.js";

const PROGRESS = JSON.stringify({
  message: "Progress remains visible across rotation.",
  control: {
    status: "continue",
    summary: "rotate",
    verification: ["provider usage"],
    next_action: "Continue after rotation.",
  },
});
const HANDOVER = JSON.stringify({
  handover_summary: "rotated",
  entry_state_and_done: "finish the installed conversation",
  completed: ["progress published"],
  in_flight: [],
  not_started: ["follow-up"],
  decisions: [],
  rejected_approaches: [],
  verification: ["provider usage"],
  uncertainties: [],
  references: [],
  lessons: [],
  next_action: "Wait safely for operator input.",
});
const WAITING = JSON.stringify({
  message: "Waiting safely for your follow-up.",
  control: {
    status: "waiting",
    summary: "waiting",
    verification: ["checkpointed"],
    next_action: "Wait for input.",
  },
});
const COMPLETE = JSON.stringify({
  message: "The installed conversation is complete.",
  control: {
    status: "complete",
    summary: "done",
    verification: ["installed path"],
    next_action: "",
  },
});

function providerReply(call: number, response: ServerResponse, interrupt: () => void): void {
  switch (call) {
    case 1:
      openAiReply(response, PROGRESS, 110_000);
      return;
    case 2:
      openAiReply(response, HANDOVER);
      return;
    case 3:
      openAiReply(response, WAITING);
      return;
    case 4:
      interrupt();
      return;
    default:
      openAiReply(response, COMPLETE);
  }
}

interface ConversationFixture {
  agent: string;
  calls(): number;
  interrupted: Promise<void>;
  provider: Server;
  root: string;
  start(): InstalledWorker;
  state: string;
  token: string;
  workers: InstalledWorker[];
  workspace: string;
}

async function conversationFixture(): Promise<ConversationFixture> {
  const root = mkdtempSync(join(tmpdir(), "sept-cli-part1-conversation-"));
  const { agent, state, workspace } = prepareDirectories(root);
  let providerCalls = 0;
  let markInterrupted = (): void => undefined;
  const interrupted = new Promise<void>((resolvePromise) => {
    markInterrupted = resolvePromise;
  });
  const provider = createServer((request, response) => {
    request.resume();
    providerCalls += 1;
    providerReply(providerCalls, response, markInterrupted);
  });
  const port = await listen(provider);
  writeProvider(agent, port, "local-part1", { apiKey: "local", maxTokens: 200 });
  const token = "installed-part1-conversation-token";
  const workers: InstalledWorker[] = [];
  return {
    agent,
    interrupted,
    provider,
    root,
    state,
    token,
    workers,
    workspace,
    calls: () => providerCalls,
    start: () => {
      const worker = installedWorker(state, agent, root, token);
      workers.push(worker);
      return worker;
    },
  };
}

function conversationText(value: unknown): string | undefined {
  const event = record(value, "conversation event");
  return typeof event.text === "string" ? event.text : undefined;
}

async function firstWorkerPhase(
  fixture: ConversationFixture,
): Promise<{ nextCursor: number; runId: string; taskText: string }> {
  const worker = fixture.start();
  const base = await worker.address;
  const taskText = "  installed initial message\nexact  ";
  const client = createTaskClient({ baseUrl: base, token: fixture.token });
  const input = {
    source: "installed-conversation",
    eventId: "initial-task",
    task: {
      task: taskText,
      workspace: fixture.workspace,
      provider: "local-part1",
      model: "fixture",
      thinking: "off" as const,
    },
  };
  const receipt = await client.createTask(input);
  const runId = receipt.runId;
  await waitForTask(base, runId, fixture.token, "waiting");
  assert.equal((await client.getTask(runId)).state.status, "waiting");
  assert.deepEqual(await client.createTask(input), { ...receipt, duplicate: true });
  await assert.rejects(
    client.createTask({ ...input, task: { ...input.task, task: "identity collision" } }),
    (error: unknown) =>
      error instanceof TaskClientError && error.kind === "http" && error.status === 409,
  );
  const page = await client.getConversation(runId, { limit: 250 });
  const [initial, progress, waiting] = page.events;
  assert.equal(conversationText(initial), taskText);
  assert.equal(conversationText(progress), "Progress remains visible across rotation.");
  assert.equal(conversationText(waiting), "Waiting safely for your follow-up.");
  const durableEvents = readFileSync(join(fixture.state, runId, "events.jsonl"), "utf8");
  assert.match(durableEvents, /"rotation_steer_queued"/);
  assert.match(durableEvents, /"successor_session_started"/);
  await stopInstalled(worker.child);
  return { nextCursor: page.nextCursor, runId, taskText };
}

async function interruptedPhase(
  fixture: ConversationFixture,
  runId: string,
  nextCursor: number,
): Promise<string> {
  const worker = fixture.start();
  const base = await worker.address;
  const interruptedStream = fetch(`${base}/v1/tasks/${runId}/stream?after=${String(nextCursor)}`, {
    headers: { Authorization: `Bearer ${fixture.token}` },
  })
    .then((response) => response.text())
    .catch(() => "");
  const followUp = "  exact installed follow-up\t  ";
  const client = createTaskClient({ baseUrl: base, token: fixture.token });
  const message = {
    source: "installed-conversation",
    eventId: "later-evidence",
    runId,
    message: followUp,
  };
  const accepted = await client.sendMessage(message);
  assert.equal(accepted.duplicate, false);
  assert.deepEqual(await client.sendMessage(message), { ...accepted, duplicate: true });
  await fixture.interrupted;
  const drain = await fetch(`${base}/v1/drain`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
  assert.equal((await responseRecord(drain)).readiness, "draining");
  await killInstalled(worker.child);
  await interruptedStream;
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, 5_200);
  });
  return followUp;
}

async function completedPhase(
  fixture: ConversationFixture,
  runId: string,
  nextCursor: number,
  followUp: string,
): Promise<void> {
  const worker = fixture.start();
  const base = await worker.address;
  const resumed = await fetch(`${base}/v1/tasks/${runId}/stream?after=${String(nextCursor)}`, {
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
  assert.match(await resumed.text(), /event: terminal/);
  await waitForTask(base, runId, fixture.token, "complete");
  await assertDrainedWorker(base, fixture.token);
  const client = createTaskClient({ baseUrl: base, token: fixture.token });
  const page = await client.getConversation(runId, { after: nextCursor, limit: 250 });
  assert.equal(
    page.events.filter((event) => event.type === "message").find((event) => event.role === "user")
      ?.text,
    followUp,
  );
  assert.equal(
    page.events
      .filter((event) => event.type === "message")
      .find((event) => event.role === "assistant")?.text,
    "The installed conversation is complete.",
  );
  assert.equal(page.terminal?.status, "complete");
  assert.equal((await client.getTask(runId)).state.status, "complete");
  assert.deepEqual(await client.cancel(runId), { runId, status: "complete", cancelled: false });
  await stopInstalled(worker.child);
}

function verifyDrainedDirectRun(fixture: ConversationFixture): void {
  const direct = spawnSync(
    resolve("sept"),
    [
      "run",
      "--task",
      "must remain drained",
      "--workspace",
      fixture.workspace,
      "--state-dir",
      fixture.state,
      "--agent-dir",
      fixture.agent,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, OTEL_SDK_DISABLED: "true", SEPT_LOG_LEVEL: "silent" },
      encoding: "utf8",
    },
  );
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /drained and not accepting/);
}

async function cleanup(fixture: ConversationFixture): Promise<void> {
  for (const worker of fixture.workers) {
    await stopInstalled(worker.child);
  }
  await closeServer(fixture.provider);
}

async function conversationScenario(): Promise<void> {
  const fixture = await conversationFixture();
  try {
    const first = await firstWorkerPhase(fixture);
    const followUp = await interruptedPhase(fixture, first.runId, first.nextCursor);
    await completedPhase(fixture, first.runId, first.nextCursor, followUp);
    assert.equal(fixture.calls(), 5);
    assert.doesNotMatch(
      fixture.workers.map((worker) => worker.stderr()).join(""),
      new RegExp(fixture.token),
    );
    verifyDrainedDirectRun(fixture);
  } finally {
    await cleanup(fixture);
  }
}

void test(
  "installed worker preserves conversation through Pi rotation and restart while drain is active",
  conversationScenario,
);

async function assertDrainedWorker(base: string, token: string): Promise<void> {
  // Durable completion precedes controller/attachment closure; drain must observe the joined slot.
  await waitFor(async () => {
    const response = await fetch(`${base}/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return (await responseRecord(response)).readiness === "drained";
  });
  const health = await fetch(`${base}/health`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal((await responseRecord(health)).readiness, "drained");
}
