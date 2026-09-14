import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_PENDING_MESSAGES, RunStore, listRuns } from "../../src/durable/index.js";
import { SeptService, validateRequest } from "../../src/ingress/index.js";
import { validateWebhookEvent, webhookHashes, WebhookReceipts } from "../../src/ingress/webhook.js";
import type { SessionHost, SessionRunResult } from "../../src/pi-integration/index.js";
import type { HostFactory } from "../../src/runtime/index.js";

const auth = { Authorization: "Bearer test-token" };
const complete: SessionRunResult = {
  text: JSON.stringify({ status: "complete", summary: "done", verification: ["ok"], next_action: "" }),
  steered: false,
  contextTokens: 1,
  contextWindow: 100,
};
const waiting: SessionRunResult = {
  text: JSON.stringify({ status: "waiting", summary: "idle until an event arrives", verification: ["checkpointed"], next_action: "Resume on new input." }),
  steered: false,
  contextTokens: 1,
  contextWindow: 100,
};

class CompletingHost implements SessionHost {
  sessionId = "webhook-test-session";
  sessionFile: string | undefined = "/tmp/webhook-test-session.jsonl";
  prompts: string[] = [];
  async run(prompt: string): Promise<SessionRunResult> { this.prompts.push(prompt); return complete; }
  async newSession(): Promise<{ predecessorId: string; predecessorFile?: string; successorId: string; successorFile?: string }> { throw new Error("unexpected session replacement"); }
  async abort(): Promise<void> {}
  async close(): Promise<void> {}
}

class BlockingHost extends CompletingHost {
  private finish!: (result: SessionRunResult) => void;
  private readonly result = new Promise<SessionRunResult>((resolve) => { this.finish = resolve; });
  override async run(prompt: string): Promise<SessionRunResult> { this.prompts.push(prompt); return this.result; }
  complete(): void { this.finish(complete); }
}

class WaitingHost extends CompletingHost {
  override async run(prompt: string): Promise<SessionRunResult> { this.prompts.push(prompt); return waiting; }
}

class SettlingWaitingHost extends WaitingHost {
  private markCloseStarted!: () => void;
  private releaseClose!: () => void;
  readonly closeStarted = new Promise<void>((resolve) => { this.markCloseStarted = resolve; });
  private readonly closeGate = new Promise<void>((resolve) => { this.releaseClose = resolve; });
  override async close(): Promise<void> { this.markCloseStarted(); await this.closeGate; }
  release(): void { this.releaseClose(); }
}

function environment() {
  const root = mkdtempSync(join(tmpdir(), "sept-webhook-"));
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "runs");
  mkdirSync(workspace);
  return { root, workspace, stateRoot };
}

async function start(stateRoot: string, hostFactory?: HostFactory) {
  const service = new SeptService({ stateRoot, agentDir: "/pi", workspaceRoot: join(stateRoot, ".."), token: "test-token", host: "127.0.0.1", port: 0, piVersion: "0.85.1", hostFactory });
  const address = await service.start();
  return { service, base: `http://${address.host}:${address.port}` };
}

async function post(base: string, value: unknown, headers: Record<string, string> = auth) {
  return fetch(`${base}/v1/webhooks`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

async function postDirectMessage(base: string, runId: string, message: string) {
  return fetch(`${base}/v1/tasks/${runId}/messages`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForWorker(base: string, expected: "idle" | "waiting"): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (true) {
    const response = await fetch(`${base}/health`, { headers: auth });
    if ((await response.json() as { worker: string }).worker === expected) return;
    if (Date.now() > deadline) throw new Error(`worker did not become ${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForIdle(base: string): Promise<void> {
  await waitForWorker(base, "idle");
}

test("webhook authenticates before parsing or creating durable state", async () => {
  const { stateRoot } = environment();
  const { service, base } = await start(stateRoot);
  try {
    const response = await fetch(`${base}/v1/webhooks`, { method: "POST", body: "not-json" });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.equal(existsSync(join(stateRoot, "webhook-receipts")), false);
  } finally { await service.stop(); }
});

test("webhook enforces content type, exact schema, and body and string limits", async () => {
  const { stateRoot } = environment();
  const { service, base } = await start(stateRoot);
  try {
    const wrongType = await fetch(`${base}/v1/webhooks`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(wrongType.status, 415);

    const unknownField = await post(base, { version: 1, eventId: "one", source: "http", kind: "task", task: { task: "safe" }, extra: true });
    assert.equal(unknownField.status, 400);
    const unknownTaskField = await post(base, { version: 1, eventId: "nested", source: "http", kind: "task", task: { task: "safe", providerPayload: {} } });
    assert.equal(unknownTaskField.status, 400);

    const oversized = await post(base, { version: 1, eventId: "two", source: "http", kind: "operator_message", runId: "missing", message: "x".repeat(32_769) });
    assert.equal(oversized.status, 400);
    const unsafeControl = await post(base, { version: 1, eventId: "control", source: "http", kind: "operator_message", runId: "missing", message: "before\u0000after" });
    assert.equal(unsafeControl.status, 400);

    const oversizedBody = await fetch(`${base}/v1/webhooks`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(256 * 1024) }),
    });
    assert.equal(oversizedBody.status, 413);
    assert.equal(existsSync(join(stateRoot, "webhook-receipts")), false);
  } finally { await service.stop(); }
});

test("task webhooks route once, reject collisions, and preserve the single slot", async () => {
  const { workspace, stateRoot } = environment();
  const host = new BlockingHost();
  const { service, base } = await start(stateRoot, async () => host);
  const event = { version: 1, eventId: "task-event-1", source: "monitoring", kind: "task", task: { task: "task payload marker", role: "maintainer", workspace } };
  try {
    const first = await post(base, event);
    assert.equal(first.status, 202);
    const firstBody = await first.json() as { duplicate: boolean; kind: string; runId: string; status: string };
    assert.deepEqual({ duplicate: firstBody.duplicate, kind: firstBody.kind, status: firstBody.status }, { duplicate: false, kind: "task", status: "active" });

    const duplicate = await post(base, event);
    assert.equal(duplicate.status, 200);
    const duplicateBody = await duplicate.json() as typeof firstBody;
    assert.equal(duplicateBody.duplicate, true);
    assert.equal(duplicateBody.runId, firstBody.runId);

    const collision = await post(base, { ...event, task: { ...event.task, task: "different task" } });
    assert.equal(collision.status, 409);
    assert.deepEqual(await collision.json(), { error: "webhook event key collision" });

    const busy = await post(base, { ...event, eventId: "task-event-2" });
    assert.equal(busy.status, 409);
    assert.deepEqual(await busy.json(), { error: "single worker slot is busy" });

    const stores = listRuns(stateRoot);
    assert.equal(stores.length, 1);
    assert.equal(stores[0].runId, firstBody.runId);
    assert.equal(stores[0].manifest().task, "task payload marker");
    const receiptRoot = join(stateRoot, "webhook-receipts");
    const receiptFiles = readdirSync(receiptRoot);
    assert.equal(receiptFiles.length, 1);
    assert.equal(statSync(receiptRoot).mode & 0o777, 0o700);
    const receiptPath = join(receiptRoot, receiptFiles[0]);
    assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(receiptPath, "utf8"), /task payload marker/);

    host.complete();
    await waitFor(() => stores[0].snapshot().status === "complete");
    renameSync(workspace, `${workspace}-moved`);
    const lateDuplicate = await post(base, event);
    assert.equal(lateDuplicate.status, 200);
    assert.equal((await lateDuplicate.json() as { duplicate: boolean }).duplicate, true);
  } finally {
    host.complete();
    await service.stop();
  }
});

test("direct and webhook messages cannot activate a blocked run while another run owns the slot", async () => {
  const { workspace, stateRoot } = environment();
  const blocked = RunStore.create(stateRoot, validateRequest({ task: "blocked target", workspace }, "0.85.1"));
  blocked.update({ status: "blocked", phase: "terminal", reason: "operator direction required" });
  const active = RunStore.create(stateRoot, validateRequest({ task: "slot owner", workspace }, "0.85.1"));
  const host = new BlockingHost();
  const { service, base } = await start(stateRoot, async () => host);
  try {
    await waitFor(() => host.prompts.length === 1);
    const direct = await postDirectMessage(base, blocked.runId, "direct message must wait");
    assert.equal(direct.status, 409);
    assert.deepEqual(await direct.json(), { error: "single worker slot is busy; retry the message when idle" });

    const webhook = await post(base, { version: 1, eventId: "busy-blocked-target", source: "slack-edge", kind: "operator_message", runId: blocked.runId, message: "webhook message must wait" });
    assert.equal(webhook.status, 409);
    assert.deepEqual(await webhook.json(), { error: "single worker slot is busy; retry the message when idle" });

    assert.equal(blocked.snapshot().status, "blocked");
    assert.equal(blocked.pendingMessages().length, 0);
    assert.equal(blocked.events(0, 1000).filter((item) => item.type === "operator_message_queued").length, 0);
    assert.equal(listRuns(stateRoot).filter((store) => store.snapshot().status === "active").length, 1);
    assert.equal(listRuns(stateRoot).find((store) => store.snapshot().status === "active")?.runId, active.runId);
    assert.equal(existsSync(join(stateRoot, "webhook-receipts")), false);

    host.complete();
    await waitFor(() => active.snapshot().status === "complete");
    await waitForIdle(base);
    const retry = await post(base, { version: 1, eventId: "busy-blocked-target", source: "slack-edge", kind: "operator_message", runId: blocked.runId, message: "webhook message must wait" });
    assert.equal(retry.status, 202);
    await waitFor(() => blocked.snapshot().status === "complete");
  } finally {
    host.complete();
    await service.stop();
  }
});

test("same-run controller settlement cannot reopen a blocked run before the slot clears", async () => {
  const { workspace, stateRoot } = environment();
  const store = RunStore.create(stateRoot, validateRequest({ task: "settling owner", workspace }, "0.85.1"));
  const host = new BlockingHost();
  const { service, base } = await start(stateRoot, async () => host);
  try {
    await waitFor(() => host.prompts.length === 1);
    store.update({ status: "blocked", phase: "terminal", reason: "controller is settling" });
    const direct = await postDirectMessage(base, store.runId, "must retry after settlement");
    assert.equal(direct.status, 409);
    assert.equal(store.snapshot().status, "blocked");
    assert.equal(store.pendingMessages().length, 0);
    assert.equal(store.events(0, 1000).filter((item) => item.type === "operator_message_queued").length, 0);

    const webhook = await post(base, { version: 1, eventId: "same-run-settlement", source: "telegram-edge", kind: "operator_message", runId: store.runId, message: "also wait for settlement" });
    assert.equal(webhook.status, 409);
    assert.equal(existsSync(join(stateRoot, "webhook-receipts")), false);

    host.complete();
    await waitFor(() => store.snapshot().status === "complete");
  } finally {
    host.complete();
    await service.stop();
  }
});

test("normal multiline operator messages retain tabs and line breaks", async () => {
  const { workspace, stateRoot } = environment();
  const store = RunStore.create(stateRoot, validateRequest({ task: "await multiline direction", workspace }, "0.85.1"));
  store.update({ status: "blocked", phase: "terminal", reason: "operator direction required" });
  const host = new CompletingHost();
  const { service, base } = await start(stateRoot, async () => host);
  const message = "first line\n\tindented second line\r\nthird line";
  try {
    const response = await post(base, { version: 1, eventId: "multiline-message", source: "telegram-edge", kind: "operator_message", runId: store.runId, message });
    assert.equal(response.status, 202);
    await waitFor(() => store.snapshot().status === "complete");
    assert.match(host.prompts[0], /first line\\n\\tindented second line\\r\\nthird line/);
    assert.equal(store.events(0, 1000).filter((item) => item.type === "operator_message_queued").length, 1);
  } finally { await service.stop(); }
});

test("hidden temporary run directories cannot be adopted", () => {
  const { workspace, stateRoot } = environment();
  const temporary = join(stateRoot, ".creating-interrupted");
  mkdirSync(temporary, { recursive: true });
  const manifest = { ...validateRequest({ task: "must not run", workspace }, "0.85.1"), runId: "hidden-run", createdAt: new Date().toISOString() };
  const snapshot = { status: "active", phase: "ready", epoch: 1, invocations: 0, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  writeFileSync(join(temporary, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  writeFileSync(join(temporary, "state.json"), `${JSON.stringify(snapshot)}\n`);
  assert.deepEqual(listRuns(stateRoot), []);
});

test("a pending durable receipt resumes routing after an interrupted task delivery", async () => {
  const { workspace, stateRoot } = environment();
  const event = { version: 1, eventId: "interrupted-task", source: "http-edge", kind: "task", task: { task: "resume safely", workspace } };
  const validated = validateWebhookEvent(event);
  const hashes = webhookHashes(validated);
  assert.equal(new WebhookReceipts(stateRoot).claim(hashes.keyHash, hashes.eventHash, validated.kind).created, true);

  const host = new BlockingHost();
  const { service, base } = await start(stateRoot, async () => host);
  try {
    const retry = await post(base, event);
    assert.equal(retry.status, 200);
    const result = await retry.json() as { duplicate: boolean; runId: string };
    assert.equal(result.duplicate, true);
    assert.equal(listRuns(stateRoot).length, 1);
    assert.equal(listRuns(stateRoot)[0].runId, result.runId);
    host.complete();
    await waitFor(() => listRuns(stateRoot)[0].snapshot().status === "complete");
  } finally {
    host.complete();
    await service.stop();
  }
});

test("operator-message webhook durably wakes a blocked run and survives duplicate retries and restart", async () => {
  const { workspace, stateRoot } = environment();
  const store = RunStore.create(stateRoot, validateRequest({ task: "await direction", workspace }, "0.85.1"));
  store.update({ status: "blocked", phase: "terminal", reason: "operator direction required" });
  const host = new CompletingHost();
  const event = { version: 1, eventId: "message-event-1", source: "slack-edge", kind: "operator_message", runId: store.runId, message: "operator payload marker" };
  const firstServer = await start(stateRoot, async () => host);
  let firstBody: { duplicate: boolean; kind: string; runId: string; messageId: string };
  try {
    const first = await post(firstServer.base, event);
    assert.equal(first.status, 202);
    firstBody = await first.json() as typeof firstBody;
    assert.equal(firstBody.duplicate, false);
    await waitFor(() => store.snapshot().status === "complete");
    assert.match(host.prompts[0], /operator payload marker/);
    assert.equal(store.pendingMessages().length, 0);

    const duplicate = await post(firstServer.base, event);
    assert.equal(duplicate.status, 200);
    const duplicateBody = await duplicate.json() as typeof firstBody;
    assert.equal(duplicateBody.duplicate, true);
    assert.equal(duplicateBody.messageId, firstBody.messageId);
    assert.equal(store.events(0, 1000).filter((item) => item.type === "operator_message_queued").length, 1);

    const collision = await post(firstServer.base, { ...event, message: "changed message" });
    assert.equal(collision.status, 409);
    assert.doesNotMatch(JSON.stringify(await collision.json()), /changed message/);
    const receipt = readFileSync(join(stateRoot, "webhook-receipts", readdirSync(join(stateRoot, "webhook-receipts"))[0]), "utf8");
    assert.doesNotMatch(receipt, /operator payload marker/);
  } finally { await firstServer.service.stop(); }

  let hostCreations = 0;
  const secondServer = await start(stateRoot, async () => { hostCreations++; return new CompletingHost(); });
  try {
    const retry = await post(secondServer.base, event);
    assert.equal(retry.status, 200);
    const retryBody = await retry.json() as typeof firstBody;
    assert.equal(retryBody.duplicate, true);
    assert.equal(retryBody.messageId, firstBody!.messageId);
    assert.equal(hostCreations, 0);
  } finally { await secondServer.service.stop(); }
});

test("authenticated waiting run stays dormant and a webhook wakes the same Pi session exactly once", async () => {
  const { workspace, stateRoot } = environment();
  const firstHost = new WaitingHost();
  const secondHost = new CompletingHost();
  const hosts = [firstHost, secondHost];
  const opened: Array<string | undefined> = [];
  let creations = 0;
  const { service, base } = await start(stateRoot, async (_manifest, _store, _agentDir, existing) => {
    opened.push(existing);
    const host = hosts[creations++];
    if (!host) throw new Error("duplicate controller");
    return host;
  });
  try {
    const task = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ task: "wait for authenticated observations", workspace }),
    });
    assert.equal(task.status, 202);
    const { runId } = await task.json() as { runId: string };
    const store = listRuns(stateRoot).find((candidate) => candidate.runId === runId)!;
    await waitForWorker(base, "waiting");
    assert.equal(store.snapshot().status, "waiting");
    assert.equal(firstHost.prompts.length, 1);
    assert.equal(creations, 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(firstHost.prompts.length, 1, "waiting must not invoke Pi again");

    const event = { version: 1, eventId: "waiting-wake-1", source: "monitoring-edge", kind: "operator_message", runId, message: "bounded observation payload" };
    const wake = await post(base, event);
    assert.equal(wake.status, 202);
    const wakeBody = await wake.json() as { messageId: string; duplicate: boolean };
    assert.equal(wakeBody.duplicate, false);
    const duplicate = await post(base, event);
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { kind: "operator_message", runId, messageId: wakeBody.messageId, duplicate: true });

    await waitFor(() => store.snapshot().status === "complete");
    assert.equal(creations, 2);
    assert.deepEqual(opened, [undefined, "/tmp/webhook-test-session.jsonl"]);
    assert.match(secondHost.prompts[0], /bounded observation payload/);
    assert.equal(store.pendingMessages().length, 0);
    assert.equal(store.events(0, 1000).filter((event) => event.type === "operator_message_queued").length, 1);
    assert.equal(store.events(0, 1000).filter((event) => event.type === "pi_session_resumed").length, 1);
  } finally { await service.stop(); }
});

test("worker restart keeps a waiting run dormant with its slot and session identity", async () => {
  const { workspace, stateRoot } = environment();
  const store = RunStore.create(stateRoot, validateRequest({ task: "remain asleep", workspace }, "0.85.1"));
  store.update({ status: "waiting", phase: "waiting", activeSessionId: "pi-dormant", activeSessionFile: "/tmp/pi-dormant.jsonl", reason: "waiting for input" });
  let creations = 0;
  const { service, base } = await start(stateRoot, async () => { creations++; return new CompletingHost(); });
  try {
    await waitForWorker(base, "waiting");
    const health = await fetch(`${base}/health`, { headers: auth });
    assert.deepEqual(await health.json(), { status: "ok", worker: "waiting", readiness: "accepting", acceptingWork: true, activeRunId: store.runId, runtime: "pi-sdk" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(creations, 0);
    const newTask = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ task: "must not displace waiting run", workspace }),
    });
    assert.equal(newTask.status, 409);
  } finally { await service.stop(); }
});

test("restart recovers a durably queued waiting wake and adopts the existing session", async () => {
  const { workspace, stateRoot } = environment();
  const store = RunStore.create(stateRoot, validateRequest({ task: "recover wake", workspace }, "0.85.1"));
  store.update({ status: "waiting", phase: "waiting", activeSessionId: "webhook-test-session", activeSessionFile: "/tmp/webhook-test-session.jsonl", reason: "waiting" });
  const message = store.enqueueMessage("accepted before the wake transition committed");
  const host = new CompletingHost();
  let opened: string | undefined;
  const { service } = await start(stateRoot, async (_manifest, _store, _agentDir, existing) => { opened = existing; return host; });
  try {
    await waitFor(() => store.snapshot().status === "complete");
    assert.equal(opened, "/tmp/webhook-test-session.jsonl");
    assert.match(host.prompts[0], /accepted before the wake transition committed/);
    assert.equal(store.pendingMessages().length, 0);
    assert.deepEqual(store.events(0, 1000).find((event) => event.type === "run_wake_recovered")?.messageIds, [message.id]);
  } finally { await service.stop(); }
});

test("message accepted while waiting controller settles launches no overlapping controller", async () => {
  const { workspace, stateRoot } = environment();
  const firstHost = new SettlingWaitingHost();
  const secondHost = new CompletingHost();
  let creations = 0;
  let reopenedExisting: string | undefined;
  const { service, base } = await start(stateRoot, async (_manifest, _store, _agentDir, existing) => {
    creations++;
    if (creations === 1) return firstHost;
    if (creations === 2) { reopenedExisting = existing; return secondHost; }
    throw new Error("overlapping or duplicate controller");
  });
  try {
    const task = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ task: "exercise waiting transition race", workspace }),
    });
    const { runId } = await task.json() as { runId: string };
    const store = listRuns(stateRoot).find((candidate) => candidate.runId === runId)!;
    await firstHost.closeStarted;
    assert.equal(store.snapshot().status, "waiting");

    const wake = await postDirectMessage(base, runId, "arrived while old runtime was closing");
    assert.equal(wake.status, 202);
    assert.equal(store.snapshot().status, "active");
    assert.equal(creations, 1, "the settling controller must retain exclusive ownership");
    firstHost.release();

    await waitFor(() => store.snapshot().status === "complete");
    assert.equal(creations, 2);
    assert.equal(reopenedExisting, "/tmp/webhook-test-session.jsonl");
    assert.match(secondHost.prompts[0], /arrived while old runtime was closing/);
    assert.equal(store.pendingMessages().length, 0);
  } finally {
    firstHost.release();
    await service.stop();
  }
});

test("webhook routing failures are safe and do not reserve event IDs", async () => {
  const { stateRoot } = environment();
  const { service, base } = await start(stateRoot);
  try {
    const marker = "sensitive failure payload marker";
    const response = await post(base, { version: 1, eventId: "unknown-run-event", source: "whatsapp-edge", kind: "operator_message", runId: "unknown", message: marker });
    assert.equal(response.status, 404);
    const body = JSON.stringify(await response.json());
    assert.doesNotMatch(body, /sensitive failure payload marker/);
    assert.equal(existsSync(join(stateRoot, "webhook-receipts")), false);
  } finally { await service.stop(); }
});

test("the final invocation rejects racing input before durable acceptance", async () => {
  const { workspace, stateRoot } = environment();
  const host = new BlockingHost();
  const { service, base } = await start(stateRoot, async () => host);
  try {
    const task = await fetch(`${base}/v1/tasks`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ task: "one invocation only", workspace, maxInvocations: 1, maxEpochs: 2 }),
    });
    const { runId } = await task.json() as { runId: string };
    await waitFor(() => host.prompts.length === 1);
    const message = await postDirectMessage(base, runId, "must not be stranded");
    assert.equal(message.status, 409);
    assert.match(JSON.stringify(await message.json()), /exhausted/);
    const store = listRuns(stateRoot)[0];
    assert.equal(store.pendingMessages().length, 0);
    host.complete();
    await waitFor(() => store.snapshot().status === "complete");
    assert.equal(host.prompts.length, 1);
  } finally { host.complete(); await service.stop(); }
});

test("the final session epoch rejects racing input that could be stranded by rotation", async () => {
  const { workspace, stateRoot } = environment();
  const host = new BlockingHost();
  const { service, base } = await start(stateRoot, async () => host);
  try {
    const task = await fetch(`${base}/v1/tasks`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ task: "one epoch only", workspace, maxInvocations: 2, maxEpochs: 1 }),
    });
    const { runId } = await task.json() as { runId: string };
    await waitFor(() => host.prompts.length === 1);
    const message = await postDirectMessage(base, runId, "must not be stranded by rotation");
    assert.equal(message.status, 409);
    assert.match(JSON.stringify(await message.json()), /epoch limit/);
    assert.equal(listRuns(stateRoot)[0].pendingMessages().length, 0);
    host.complete();
  } finally { host.complete(); await service.stop(); }
});

test("typed terminal causes distinguish hard limits from similarly worded agent blocks", async () => {
  const { workspace, stateRoot } = environment();
  const hard = RunStore.create(stateRoot, validateRequest({ task: "hard limit", workspace }, "0.85.1"));
  hard.update({ status: "blocked", phase: "terminal", reason: "operator can help", terminalCause: "timeout" });
  const resolvable = RunStore.create(stateRoot, validateRequest({ task: "resolvable", workspace }, "0.85.1"));
  resolvable.update({ status: "blocked", phase: "terminal", reason: "remote dependency timeout reached; credentials needed", terminalCause: "agent_blocked" });
  const host = new CompletingHost();
  const { service, base } = await start(stateRoot, async () => host);
  try {
    const hardResponse = await postDirectMessage(base, hard.runId, "cannot exceed the cap");
    assert.equal(hardResponse.status, 409);
    assert.equal(hard.pendingMessages().length, 0);
    const accepted = await postDirectMessage(base, resolvable.runId, "dependency is now available");
    assert.equal(accepted.status, 202);
    await waitFor(() => resolvable.snapshot().status === "complete");
    assert.match(host.prompts[0], /dependency is now available/);
  } finally { await service.stop(); }
});

test("assistant terminal payload is excluded from the public lifecycle log", async () => {
  const { workspace, stateRoot } = environment();
  const marker = "ASSISTANT-CONTROL-SUMMARY-MUST-NOT-BE-LOGGED";
  const host = new CompletingHost();
  host.run = async (prompt: string) => {
    host.prompts.push(prompt);
    return { ...complete, text: JSON.stringify({ status: "complete", summary: marker, verification: [], next_action: "" }) };
  };
  const { service, base } = await start(stateRoot, async () => host);
  try {
    const task = await fetch(`${base}/v1/tasks`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ task: "log safely", workspace }),
    });
    const { runId } = await task.json() as { runId: string };
    await waitFor(() => listRuns(stateRoot)[0].snapshot().status === "complete");
    const log = await fetch(`${base}/v1/tasks/${runId}/log`, { headers: auth });
    assert.equal(log.status, 200);
    const text = await log.text();
    assert.doesNotMatch(text, new RegExp(marker));
    assert.match(text, /"textBytes":/);
  } finally { await service.stop(); }
});

test("bind failure performs no adoption or controller work and leaves no root lease", async () => {
  const { root, workspace, stateRoot } = environment();
  const store = RunStore.create(stateRoot, validateRequest({ task: "must not adopt", workspace }, "0.85.1"));
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const address = blocker.address();
  assert.ok(address && typeof address === "object");
  let creations = 0;
  const service = new SeptService({ stateRoot, agentDir: "/pi", workspaceRoot: root, token: "test-token", host: "127.0.0.1", port: address.port, piVersion: "0.85.1", hostFactory: async () => { creations++; return new CompletingHost(); } });
  try {
    await assert.rejects(service.start(), (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE");
    assert.equal(creations, 0);
    assert.equal(store.snapshot().invocations, 0);
    assert.equal(existsSync(join(stateRoot, "worker.lease")), false);
    assert.equal(existsSync(store.leasePath), false);
  } finally { await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve())); }
});

test("direct and webhook validation preserve exact edge whitespace and reject schema/control mismatches", async () => {
  const { root, workspace, stateRoot } = environment();
  const outside = mkdtempSync(join(tmpdir(), "sept-workspace-escape-"));
  const link = join(workspace, "escape");
  symlinkSync(outside, link);
  const directStore = RunStore.create(stateRoot, validateRequest({ task: "direct exact", workspace }, "0.85.1"));
  directStore.update({ status: "blocked", phase: "terminal", reason: "input" });
  const webhookStore = RunStore.create(stateRoot, validateRequest({ task: "webhook exact", workspace }, "0.85.1"));
  webhookStore.update({ status: "blocked", phase: "terminal", reason: "input" });
  const hosts = [new CompletingHost(), new CompletingHost()];
  const { service, base } = await start(stateRoot, async () => hosts.shift()!);
  const exactDirect = "  direct edge\t\n";
  const exactWebhook = "\n\twebhook edge  ";
  try {
    const unknownTask = await fetch(`${base}/v1/tasks`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ task: "x", workspace, typo: true }) });
    assert.equal(unknownTask.status, 400);
    const fileTask = await fetch(`${base}/v1/tasks`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ task: "x", workspace: join(workspace, "missing") }) });
    assert.equal(fileTask.status, 400);
    const escaped = await fetch(`${base}/v1/tasks`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ task: "x", workspace: link }) });
    assert.equal(escaped.status, 400);
    const unsafeTask = await fetch(`${base}/v1/tasks`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ task: "bad\u0000task", workspace }) });
    assert.equal(unsafeTask.status, 400);
    const unknownMessage = await fetch(`${base}/v1/tasks/${directStore.runId}/messages`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ message: "valid", extra: true }) });
    assert.equal(unknownMessage.status, 400);
    const unsafeMessage = await postDirectMessage(base, directStore.runId, "bad\u0000message");
    assert.equal(unsafeMessage.status, 400);

    const direct = await postDirectMessage(base, directStore.runId, exactDirect);
    assert.equal(direct.status, 202);
    const directId = (await direct.json() as { messageId: string }).messageId;
    await waitFor(() => directStore.snapshot().status === "complete");
    assert.equal(directStore.operatorMessage(directId)?.text, exactDirect);

    const webhook = await post(base, { version: 1, eventId: "exact-edge", source: "edge", kind: "operator_message", runId: webhookStore.runId, message: exactWebhook });
    assert.equal(webhook.status, 202);
    const webhookId = (await webhook.json() as { messageId: string }).messageId;
    await waitFor(() => webhookStore.snapshot().status === "complete");
    assert.equal(webhookStore.operatorMessage(webhookId)?.text, exactWebhook);
  } finally { await service.stop(); }
});

test("server workspace confinement rejects files, outside paths, and symlink escapes", async () => {
  const { root, workspace, stateRoot } = environment();
  const assignedRoot = join(root, "assigned");
  const assigned = join(assignedRoot, "repo");
  const outside = join(root, "outside");
  mkdirSync(assigned, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(assignedRoot, "file"), "not a directory");
  symlinkSync(outside, join(assignedRoot, "escape"));
  const service = new SeptService({ stateRoot, agentDir: "/pi", workspaceRoot: assignedRoot, token: "test-token", host: "127.0.0.1", port: 0, piVersion: "0.85.1", hostFactory: async () => new BlockingHost() });
  const address = await service.start();
  const base = `http://${address.host}:${address.port}`;
  try {
    for (const candidate of [workspace, outside, join(assignedRoot, "file"), join(assignedRoot, "escape")]) {
      const response = await fetch(`${base}/v1/tasks`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ task: "reject path", workspace: candidate }) });
      assert.equal(response.status, 400, candidate);
    }
  } finally { await service.stop(); }
});

test("restart adoption rejects a durable workspace symlink escape before creating a host", async () => {
  const { root, stateRoot } = environment();
  const assignedRoot = join(root, "assigned");
  const assigned = join(assignedRoot, "repo");
  const outside = join(root, "outside-adoption");
  const escape = join(assignedRoot, "escape-adoption");
  mkdirSync(assigned, { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, escape);
  const store = RunStore.create(stateRoot, validateRequest({ task: "resident escape", workspace: assigned }, "0.85.1"));
  const manifest = JSON.parse(readFileSync(store.manifestPath, "utf8")) as Record<string, unknown>;
  writeFileSync(store.manifestPath, `${JSON.stringify({ ...manifest, workspace: escape })}\n`);
  let creations = 0;
  const service = new SeptService({ stateRoot, agentDir: "/pi", workspaceRoot: assignedRoot, token: "test-token", host: "127.0.0.1", port: 0, piVersion: "0.85.1", hostFactory: async () => { creations++; return new CompletingHost(); } });

  await assert.rejects(service.start(), /outside the configured workspace root/);
  assert.equal(creations, 0);
  assert.equal(store.snapshot().invocations, 0);
  assert.equal(existsSync(join(stateRoot, "worker.lease")), false);
});

test("queue saturation returns retryable capacity without mutating lifecycle state", async () => {
  const { workspace, stateRoot } = environment();
  const store = RunStore.create(stateRoot, validateRequest({ task: "bounded queue", workspace }, "0.85.1"));
  store.update({ status: "blocked", phase: "terminal", reason: "input needed", terminalCause: "agent_blocked" });
  for (let index = 0; index < MAX_PENDING_MESSAGES; index++) store.enqueueMessage(`queued-${index}`);
  const { service, base } = await start(stateRoot);
  try {
    const response = await postDirectMessage(base, store.runId, "one too many");
    assert.equal(response.status, 429);
    assert.equal(store.snapshot().status, "blocked");
    assert.equal(store.pendingMessages().length, MAX_PENDING_MESSAGES);
  } finally { await service.stop(); }
});
