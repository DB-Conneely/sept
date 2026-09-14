import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_CONVERSATION_EVENTS, RunStore, validateWorkResponse } from "../../src/durable/index.js";
import { SeptService, validateRequest } from "../../src/ingress/index.js";
import type { SessionHost, SessionRunResult } from "../../src/pi-integration/index.js";

const auth = { Authorization: "Bearer part1-token" };
const response = (status: "complete" | "waiting", message: string): SessionRunResult => ({
  text: JSON.stringify({
    message,
    control: {
      status,
      summary: status === "complete" ? "done" : "waiting for follow-up",
      verification: ["durable"],
      next_action: status === "waiting" ? "Wait for operator input." : "",
    },
  }),
  steered: false,
  contextTokens: 10,
  contextWindow: 100,
});

class GateHost implements SessionHost {
  readonly sessionId = "part1-gate";
  readonly sessionFile = "/tmp/part1-gate.jsonl";
  prompts: string[] = [];
  aborted = 0;
  private finish!: (value: SessionRunResult) => void;
  private readonly result = new Promise<SessionRunResult>((resolve) => { this.finish = resolve; });
  async run(prompt: string): Promise<SessionRunResult> { this.prompts.push(prompt); return this.result; }
  complete(value = response("complete", "The accepted work is complete.")): void { this.finish(value); }
  async newSession(): Promise<never> { throw new Error("unexpected replacement"); }
  async abort(): Promise<void> { this.aborted++; this.complete(); }
  async close(): Promise<void> {}
}

class ReplacementGateHost implements SessionHost {
  sessionId = "replacement-predecessor";
  sessionFile: string | undefined = "/tmp/replacement-predecessor.jsonl";
  aborts = 0;
  private markReplacement!: () => void;
  readonly replacementStarted = new Promise<void>((resolve) => { this.markReplacement = resolve; });
  private releaseReplacement!: () => void;
  private readonly replacementGate = new Promise<void>((resolve) => { this.releaseReplacement = resolve; });
  async run(): Promise<SessionRunResult> {
    return {
      text: JSON.stringify({
        handover_summary: "rotate", entry_state_and_done: "finish", completed: [], in_flight: [], not_started: ["finish"], decisions: [], rejected_approaches: [], verification: [], uncertainties: [], references: [], lessons: [], next_action: "finish",
      }),
      steered: true, contextTokens: 90, contextWindow: 100,
    };
  }
  async newSession() {
    this.markReplacement();
    await this.replacementGate;
    const predecessorId = this.sessionId;
    const predecessorFile = this.sessionFile;
    this.sessionId = "replacement-successor";
    this.sessionFile = "/tmp/replacement-successor.jsonl";
    return { predecessorId, predecessorFile, successorId: this.sessionId, successorFile: this.sessionFile };
  }
  release(): void { this.releaseReplacement(); }
  async abort(): Promise<void> { this.aborts++; }
  async close(): Promise<void> {}
}

class ResultHost implements SessionHost {
  readonly sessionId = "part1-result";
  readonly sessionFile = "/tmp/part1-result.jsonl";
  prompts: string[] = [];
  constructor(private readonly values: SessionRunResult[]) {}
  async run(prompt: string): Promise<SessionRunResult> {
    this.prompts.push(prompt);
    const value = this.values.shift();
    if (!value) throw new Error("unexpected invocation");
    return value;
  }
  async newSession(): Promise<never> { throw new Error("unexpected replacement"); }
  async abort(): Promise<void> {}
  async close(): Promise<void> {}
}

function environment() {
  const root = mkdtempSync(join(tmpdir(), "sept-part1-"));
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "runs");
  mkdirSync(workspace);
  return { root, workspace, stateRoot };
}

async function start(root: string, stateRoot: string, hostFactory?: () => Promise<SessionHost>) {
  const service = new SeptService({ stateRoot, agentDir: "/pi", workspaceRoot: root, token: "part1-token", host: "127.0.0.1", port: 0, piVersion: "0.85.1", hostFactory });
  const address = await service.start();
  return { service, base: `http://${address.host}:${address.port}` };
}

async function postJson(url: string, value: unknown) {
  return fetch(url, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(value) });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 4_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function health(base: string) {
  const result = await fetch(`${base}/health`, { headers: auth });
  assert.equal(result.status, 200);
  return result.json() as Promise<{ worker: string; readiness: string; acceptingWork: boolean; activeRunId: string | null }>;
}

test("authenticated drain is durable, idempotent, rejects admission, and settles preaccepted input before restart", async () => {
  const { root, workspace, stateRoot } = environment();
  const host = new GateHost();
  const first = await start(root, stateRoot, async () => host);
  let runId = "";
  try {
    const task = await postJson(`${first.base}/v1/tasks`, { task: "drain this active task", workspace });
    runId = (await task.json() as { runId: string }).runId;
    await waitFor(() => host.prompts.length === 1);
    const queued = await postJson(`${first.base}/v1/tasks/${runId}/messages`, { message: "queued before drain" });
    assert.equal(queued.status, 202);

    assert.equal((await fetch(`${first.base}/v1/drain`, { method: "POST" })).status, 401);
    const drain = await fetch(`${first.base}/v1/drain`, { method: "POST", headers: auth });
    assert.equal(drain.status, 202);
    assert.equal((await drain.json() as { readiness: string }).readiness, "draining");
    const repeat = await fetch(`${first.base}/v1/drain`, { method: "POST", headers: auth });
    assert.equal((await repeat.json() as { readiness: string }).readiness, "draining");
    assert.equal(JSON.parse(readFileSync(join(stateRoot, "worker-state.json"), "utf8")).readiness, "draining");

    assert.equal((await postJson(`${first.base}/v1/tasks`, { task: "must be rejected", workspace })).status, 409);
    assert.equal((await postJson(`${first.base}/v1/tasks/${runId}/messages`, { message: "too late" })).status, 409);
    assert.equal((await postJson(`${first.base}/v1/webhooks`, { version: 1, eventId: "late", source: "test", kind: "operator_message", runId, message: "also too late" })).status, 409);

    host.complete();
    await waitFor(async () => (await health(first.base)).readiness === "drained");
    assert.equal(host.prompts.length, 2, "input accepted before drain must be delivered");
    assert.match(host.prompts[1], /queued before drain/);
    assert.equal(new RunStore(join(stateRoot, runId)).snapshot().status, "complete");
  } finally { host.complete(); await first.service.stop(); }

  const restarted = await start(root, stateRoot);
  try {
    const state = await health(restarted.base);
    assert.equal(state.readiness, "drained");
    assert.equal(state.acceptingWork, false);
    assert.equal((await postJson(`${restarted.base}/v1/tasks`, { task: "restart must not clear drain", workspace })).status, 409);
  } finally { await restarted.service.stop(); }
});

test("drain of a waiting run reaches drained without waking or releasing its resident slot", async () => {
  const { root, workspace, stateRoot } = environment();
  const store = RunStore.create(stateRoot, validateRequest({ task: "already waiting", workspace }, "0.85.1"));
  store.update({ status: "waiting", phase: "waiting", reason: "coherent wait" });
  const started = await start(root, stateRoot);
  try {
    const drain = await fetch(`${started.base}/v1/drain`, { method: "POST", headers: auth });
    assert.equal(drain.status, 202);
    const state = await drain.json() as { readiness: string; worker: string; activeRunId: string };
    assert.equal(state.readiness, "drained");
    assert.equal(state.worker, "waiting");
    assert.equal(state.activeRunId, store.runId);
    assert.equal(store.snapshot().status, "waiting");
    const cancel = await fetch(`${started.base}/v1/tasks/${store.runId}/cancel`, { method: "POST", headers: auth });
    assert.equal(cancel.status, 200);
    assert.equal(store.snapshot().status, "cancelled");
    assert.equal((await health(started.base)).readiness, "drained");
  } finally { await started.service.stop(); }
});

test("cancel persists intent before native-host abort and late completion cannot overwrite cancellation", async () => {
  const { root, workspace, stateRoot } = environment();
  let store: RunStore | undefined;
  const host = new GateHost();
  const originalAbort = host.abort.bind(host);
  host.abort = async () => {
    assert.equal(store!.snapshot().status, "cancelling");
    assert.equal(store!.events(0, 1000).at(-1)?.type, "run_cancellation_requested");
    await originalAbort();
  };
  const started = await start(root, stateRoot, async () => host);
  try {
    const task = await postJson(`${started.base}/v1/tasks`, { task: "cancel active work", workspace });
    const runId = (await task.json() as { runId: string }).runId;
    store = new RunStore(join(stateRoot, runId));
    await waitFor(() => host.prompts.length === 1);
    const cancel = await fetch(`${started.base}/v1/tasks/${runId}/cancel`, { method: "POST", headers: auth });
    assert.ok(cancel.status === 200 || cancel.status === 202);
    await waitFor(() => store!.snapshot().status === "cancelled");
    assert.equal(host.aborted, 1);
    assert.equal(store.snapshot().terminalCause, "operator_cancelled");
    assert.equal(store.events(0, 1000).filter((event) => event.type === "run_completed").length, 0);
    assert.equal(store.conversation(0, 250).events.at(-1)?.type, "terminal");
    assert.equal((await fetch(`${started.base}/v1/tasks/${runId}/cancel`, { method: "POST", headers: auth })).status, 200);
    assert.equal(host.aborted, 1, "repeated cancellation must be idempotent");
    assert.equal((await postJson(`${started.base}/v1/tasks/${runId}/messages`, { message: "late message" })).status, 409);
  } finally { host.complete(); await started.service.stop(); }
});

test("cancellation before invocation and during fresh-session replacement cannot start or publish late work", async () => {
  const before = environment();
  const host = new GateHost();
  let releaseFactory!: () => void;
  const factoryGate = new Promise<void>((resolve) => { releaseFactory = resolve; });
  const first = await start(before.root, before.stateRoot, async () => { await factoryGate; return host; });
  try {
    const task = await postJson(`${first.base}/v1/tasks`, { task: "cancel before invocation", workspace: before.workspace });
    const runId = (await task.json() as { runId: string }).runId;
    const cancel = await fetch(`${first.base}/v1/tasks/${runId}/cancel`, { method: "POST", headers: auth });
    assert.equal(cancel.status, 202);
    releaseFactory();
    const store = new RunStore(join(before.stateRoot, runId));
    await waitFor(() => store.snapshot().status === "cancelled");
    assert.equal(host.prompts.length, 0);
    assert.equal(host.aborted, 1);
  } finally { releaseFactory(); host.complete(); await first.service.stop(); }

  const during = environment();
  const replacement = new ReplacementGateHost();
  const second = await start(during.root, during.stateRoot, async () => replacement);
  try {
    const task = await postJson(`${second.base}/v1/tasks`, { task: "cancel during replacement", workspace: during.workspace });
    const runId = (await task.json() as { runId: string }).runId;
    await replacement.replacementStarted;
    const cancel = await fetch(`${second.base}/v1/tasks/${runId}/cancel`, { method: "POST", headers: auth });
    assert.equal(cancel.status, 202);
    replacement.release();
    const store = new RunStore(join(during.stateRoot, runId));
    await waitFor(() => store.snapshot().status === "cancelled");
    assert.equal(store.events(0, 1000).filter((event) => event.type === "successor_session_started").length, 0);
    assert.equal(store.events(0, 1000).filter((event) => event.type === "handover_written").length, 1);
  } finally { replacement.release(); await second.service.stop(); }
});

test("restart completes an interrupted cancellation without opening Pi", async () => {
  const { root, workspace, stateRoot } = environment();
  const store = RunStore.create(stateRoot, validateRequest({ task: "cancel before restart", workspace }, "0.85.1"));
  store.requestCancellation();
  let opened = 0;
  const started = await start(root, stateRoot, async () => { opened++; return new ResultHost([]); });
  try {
    assert.equal(store.snapshot().status, "cancelled");
    assert.equal(opened, 0);
    const transcript = await fetch(`${started.base}/v1/tasks/${store.runId}/conversation`, { headers: auth });
    assert.equal((await transcript.json() as { terminal: { status: string } }).terminal.status, "cancelled");
  } finally { await started.service.stop(); }
});

test("conversation replay and SSE reconnect preserve exact text across wait, restart, wake, and completion", async () => {
  const { root, workspace, stateRoot } = environment();
  const waitingHost = new ResultHost([response("waiting", "I am waiting for your follow-up.")]);
  const first = await start(root, stateRoot, async () => waitingHost);
  let runId = "";
  let cursor = 0;
  try {
    const taskText = "  exact initial text\nwith a second line  ";
    const task = await postJson(`${first.base}/v1/tasks`, { task: taskText, workspace });
    runId = (await task.json() as { runId: string }).runId;
    await waitFor(async () => (await health(first.base)).worker === "waiting");
    assert.equal((await fetch(`${first.base}/v1/tasks/${runId}/conversation`)).status, 401);
    const replay = await fetch(`${first.base}/v1/tasks/${runId}/conversation?limit=250`, { headers: auth });
    const page = await replay.json() as { events: Array<{ cursor: number; type: string; role?: string; text?: string; state?: string }>; nextCursor: number; terminal: null };
    assert.equal(page.events[0].text, taskText);
    assert.deepEqual(page.events.map((event) => event.type), ["message", "message", "state"]);
    assert.equal(page.events[1].text, "I am waiting for your follow-up.");
    assert.equal(page.terminal, null);
    cursor = page.nextCursor;

    const controller = new AbortController();
    const streaming = fetch(`${first.base}/v1/tasks/${runId}/stream?after=${cursor}`, { headers: auth, signal: controller.signal }).then((result) => result.text());
    await new Promise((resolve) => setTimeout(resolve, 25));
    await first.service.stop();
    const disconnected = await streaming;
    assert.match(disconnected, /event: disconnect/);
    assert.match(disconnected, /server_shutdown/);
  } finally {
    await first.service.stop();
  }

  const completionHost = new ResultHost([response("complete", "The follow-up is complete.")]);
  const restarted = await start(root, stateRoot, async () => completionHost);
  try {
    assert.equal((await health(restarted.base)).worker, "waiting");
    const live = fetch(`${restarted.base}/v1/tasks/${runId}/stream?after=${cursor}`, { headers: auth }).then((result) => result.text());
    await new Promise((resolve) => setTimeout(resolve, 25));
    const exactFollowUp = "  preserve this follow-up\t\nexactly  ";
    const accepted = await postJson(`${restarted.base}/v1/tasks/${runId}/messages`, { message: exactFollowUp });
    assert.equal(accepted.status, 202);
    const streamText = await live;
    assert.match(streamText, /event: message/);
    assert.match(streamText, /event: terminal/);
    const replay = await fetch(`${restarted.base}/v1/tasks/${runId}/conversation?after=${cursor}&limit=250`, { headers: auth });
    const page = await replay.json() as { events: Array<{ type: string; role?: string; text?: string }>; terminal: { status: string } };
    assert.equal(page.events.find((event) => event.role === "user")?.text, exactFollowUp);
    assert.equal(page.events.find((event) => event.role === "assistant")?.text, "The follow-up is complete.");
    assert.equal(page.terminal.status, "complete");
    const lateCancel = await fetch(`${restarted.base}/v1/tasks/${runId}/cancel`, { method: "POST", headers: auth });
    assert.deepEqual(await lateCancel.json(), { runId, status: "complete", cancelled: false });
    assert.doesNotMatch(readFileSync(join(stateRoot, runId, "agent.log"), "utf8"), /follow-up is complete|preserve this follow-up/);
  } finally { await restarted.service.stop(); }
});

test("restart reconciles a durable operator queue crash before conversation projection", async () => {
  const { root, workspace, stateRoot } = environment();
  const store = RunStore.create(stateRoot, validateRequest({ task: "recover queued conversation", workspace }, "0.85.1"));
  const exact = "  accepted before the projection crash\nexactly  ";
  const message = { id: "crash-seam-message", createdAt: new Date().toISOString(), text: exact };
  appendFileSync(store.messagesPath, `${JSON.stringify(message)}\n`);
  store.event("operator_message_queued", { messageId: message.id });
  const host = new GateHost();
  const started = await start(root, stateRoot, async () => host);
  try {
    await waitFor(() => host.prompts.length === 1);
    const userMessages = store.conversation(0, 250).events.filter((event): event is Extract<typeof event, { type: "message" }> => event.type === "message" && event.role === "user");
    assert.equal(userMessages.find((event) => event.id === `operator-${message.id}`)?.text, exact);
    assert.equal(store.events(0, 1000).filter((event) => event.type === "operator_conversation_recorded" && event.messageId === message.id).length, 1);
    assert.match(host.prompts[0], /accepted before the projection crash/);
  } finally { host.complete(); await started.service.stop(); }

  const restarted = await start(root, stateRoot);
  try {
    assert.equal(store.conversation(0, 250).events.filter((event) => event.id === `operator-${message.id}`).length, 1);
    assert.equal(store.events(0, 1000).filter((event) => event.type === "operator_conversation_recorded" && event.messageId === message.id).length, 1);
  } finally { await restarted.service.stop(); }
});

test("conversation cursors are strict and terminal metadata remains authoritative after the terminal cursor", async () => {
  const { root, workspace, stateRoot } = environment();
  const host = new ResultHost([response("complete", "Terminal replay is complete.")]);
  const started = await start(root, stateRoot, async () => host);
  try {
    const task = await postJson(`${started.base}/v1/tasks`, { task: "strict terminal replay", workspace });
    const runId = (await task.json() as { runId: string }).runId;
    await waitFor(() => new RunStore(join(stateRoot, runId)).snapshot().status === "complete");
    const full = await fetch(`${started.base}/v1/tasks/${runId}/conversation?limit=250`, { headers: auth });
    const fullPage = await full.json() as { nextCursor: number };
    const afterTerminal = await fetch(`${started.base}/v1/tasks/${runId}/conversation?after=${fullPage.nextCursor}&limit=1`, { headers: auth });
    const terminalPage = await afterTerminal.json() as { events: unknown[]; terminal: { status: string } };
    assert.deepEqual(terminalPage.events, []);
    assert.equal(terminalPage.terminal.status, "complete");
    const terminalStream = await fetch(`${started.base}/v1/tasks/${runId}/stream?after=${fullPage.nextCursor}`, { headers: auth });
    const terminalText = await terminalStream.text();
    assert.match(terminalText, /"reason":"terminal"/);
    assert.match(terminalText, /"terminal":\{"status":"complete"\}/);

    for (const query of ["after=-1", "after=1junk", "after=1.5", "after=", "after=0&after=0", "limit=0", "limit=251", "limit=2x", `after=${fullPage.nextCursor + 1}`]) {
      assert.equal((await fetch(`${started.base}/v1/tasks/${runId}/conversation?${query}`, { headers: auth })).status, 400, query);
    }
    assert.equal((await fetch(`${started.base}/v1/tasks/${runId}/stream?after=1junk`, { headers: auth })).status, 400);
  } finally { await started.service.stop(); }
});

test("SSE fails closed on expired replay, backpressure, and stream-capacity exhaustion", async () => {
  const expiredEnvironment = environment();
  const expiredStore = RunStore.create(expiredEnvironment.stateRoot, validateRequest({ task: "expire replay", workspace: expiredEnvironment.workspace }, "0.85.1"));
  expiredStore.update({ status: "waiting", phase: "waiting", reason: "hold" });
  for (let index = 0; index < MAX_CONVERSATION_EVENTS + 2; index++) expiredStore.conversationMessage(`expired-${index}`, "assistant", `event ${index}`);
  const expired = await start(expiredEnvironment.root, expiredEnvironment.stateRoot);
  try {
    assert.equal((await fetch(`${expired.base}/v1/tasks/${expiredStore.runId}/conversation?after=0`, { headers: auth })).status, 410);
    assert.equal((await fetch(`${expired.base}/v1/tasks/${expiredStore.runId}/stream?after=0`, { headers: auth })).status, 410);
  } finally { await expired.service.stop(); }

  const pressureEnvironment = environment();
  const pressureStore = RunStore.create(pressureEnvironment.stateRoot, validateRequest({ task: "backpressure replay", workspace: pressureEnvironment.workspace }, "0.85.1"));
  pressureStore.update({ status: "waiting", phase: "waiting", reason: "hold" });
  for (let index = 0; index < 120; index++) pressureStore.conversationMessage(`pressure-${index}`, "assistant", `${index}:${"x".repeat(20_000)}`);
  const pressure = await start(pressureEnvironment.root, pressureEnvironment.stateRoot);
  try {
    const streamed = await fetch(`${pressure.base}/v1/tasks/${pressureStore.runId}/stream?after=0`, { headers: auth });
    assert.match(await streamed.text(), /"reason":"backpressure"/);
  } finally { await pressure.service.stop(); }

  const capacityEnvironment = environment();
  const capacityStore = RunStore.create(capacityEnvironment.stateRoot, validateRequest({ task: "stream capacity", workspace: capacityEnvironment.workspace }, "0.85.1"));
  capacityStore.update({ status: "waiting", phase: "waiting", reason: "hold" });
  const capacity = await start(capacityEnvironment.root, capacityEnvironment.stateRoot);
  const streams: Response[] = [];
  try {
    for (let index = 0; index < 32; index++) {
      const stream = await fetch(`${capacity.base}/v1/tasks/${capacityStore.runId}/stream?after=0`, { headers: auth });
      assert.equal(stream.status, 200);
      streams.push(stream);
    }
    assert.equal((await fetch(`${capacity.base}/v1/tasks/${capacityStore.runId}/stream?after=0`, { headers: auth })).status, 409);
  } finally {
    await Promise.all(streams.map(async (stream) => stream.body?.cancel()));
    await capacity.service.stop();
  }
});

test("conversation retention expires old cursors and assistant filtering fails closed", () => {
  const { workspace, stateRoot } = environment();
  const store = RunStore.create(stateRoot, validateRequest({ task: "retention", workspace }, "0.85.1"));
  for (let index = 0; index < MAX_CONVERSATION_EVENTS + 2; index++) store.conversationMessage(`assistant-retention-${index}`, "assistant", `safe update ${index}`);
  const current = store.conversation(MAX_CONVERSATION_EVENTS, 250);
  assert.ok(current.events.length > 0);
  assert.throws(() => store.conversation(0, 10), /cursor expired/);
  assert.ok(readFileSync(store.conversationPath).byteLength <= 4 * 1024 * 1024);
  assert.throws(() => validateWorkResponse({ message: "Authorization: Bearer exposed-secret", control: { status: "complete", summary: "done", verification: [], next_action: "" } }), /safe conversation filter/);
  assert.equal(existsSync(store.conversationPath), true);
});
