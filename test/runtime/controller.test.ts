import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunStore } from "../../src/durable/index.js";
import { SeptService, validateRequest } from "../../src/ingress/index.js";
import type { SessionHost, SessionRunResult } from "../../src/pi-integration/index.js";
import { CycleController } from "../../src/runtime/index.js";
import { testModelAccess } from "../support/model-access.js";

const handover = {
  handover_summary: "first session exhausted",
  entry_state_and_done: "finish the fixture",
  completed: ["atomic batch"],
  in_flight: [],
  not_started: ["finish"],
  decisions: [],
  rejected_approaches: [],
  verification: ["batch passed"],
  uncertainties: [],
  references: ["fixture"],
  lessons: [],
  next_action: "finish",
};
const complete = { status: "complete", summary: "done", verification: ["ok"], next_action: "" };
const waiting = {
  status: "waiting",
  summary: "dormant until input arrives",
  verification: ["current work checkpointed"],
  next_action: "Resume when a new message arrives.",
};

class FakeHost implements SessionHost {
  sessionId = "pi-predecessor";
  sessionFile: string | undefined = "/pi/predecessor.jsonl";
  prompts: string[] = [];
  replacements = 0;
  constructor(private readonly results: SessionRunResult[]) {}
  async run(prompt: string): Promise<SessionRunResult> {
    this.prompts.push(prompt);
    const result = this.results.shift();
    if (!result) throw new Error("unexpected invocation");
    return result;
  }
  async newSession() {
    const predecessorId = this.sessionId;
    const predecessorFile = this.sessionFile;
    this.sessionId = `pi-successor-${++this.replacements}`;
    this.sessionFile = `/pi/successor-${this.replacements}.jsonl`;
    return {
      predecessorId,
      predecessorFile,
      successorId: this.sessionId,
      successorFile: this.sessionFile,
    };
  }
  async abort(): Promise<void> {}
  async close(): Promise<void> {}
}

class GracefulStopHost implements SessionHost {
  sessionId = "graceful-session";
  sessionFile: string | undefined = "/pi/graceful.jsonl";
  prompts: string[] = [];
  closed = false;
  private finish!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.finish = resolve;
  });
  async run(prompt: string): Promise<SessionRunResult> {
    this.prompts.push(prompt);
    await this.gate;
    return {
      text: JSON.stringify({
        status: "continue",
        summary: "safe checkpoint",
        verification: [],
        next_action: "resume after restart",
      }),
      steered: false,
      contextTokens: 1,
      contextWindow: 100,
    };
  }
  async newSession(): Promise<{
    predecessorId: string;
    predecessorFile?: string;
    successorId: string;
    successorFile?: string;
  }> {
    throw new Error("unexpected replacement");
  }
  async abort(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
  release(): void {
    this.finish();
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sept-test-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const store = RunStore.create(
    join(root, "runs"),
    validateRequest({ task: "finish", role: "tester", workspace }, "0.85.1"),
  );
  return { root, workspace, store };
}

test("cycles only after durable handover and injects it into a distinct successor", async () => {
  const { store } = fixture();
  const message = store.enqueueMessage("preserve this exact direction");
  const host = new FakeHost([
    { text: JSON.stringify(handover), steered: true, contextTokens: 90, contextWindow: 100 },
    { text: JSON.stringify(complete), steered: false, contextTokens: 10, contextWindow: 100 },
  ]);
  await new CycleController(store, "/pi", async () => host).run();
  assert.equal(store.snapshot().status, "complete");
  assert.equal(store.snapshot().epoch, 2);
  assert.equal(host.replacements, 1);
  assert.match(host.prompts[1], /Full durable predecessor handover/);
  assert.match(host.prompts[1], /pi-predecessor/);
  assert.equal(store.pendingMessages().length, 0);
  const events = store.events(0, 1000);
  assert.ok(
    events.findIndex((event) => event.type === "handover_written") <
      events.findIndex((event) => event.type === "successor_session_started"),
  );
  const written = events.find((event) => event.type === "handover_written");
  assert.deepEqual(written?.messageIds, [message.id]);
  assert.equal(events.filter((event) => event.type === "successor_session_started").length, 1);
});

test("restart resumes the durable Pi session and carries recovery context", async () => {
  const { store } = fixture();
  store.update({
    phase: "running",
    invocations: 1,
    activeSessionId: "pi-existing",
    activeSessionFile: "/pi/existing.jsonl",
  });
  let opened: string | undefined;
  const host = new FakeHost([
    { text: JSON.stringify(complete), steered: false, contextTokens: 20, contextWindow: 100 },
  ]);
  host.sessionId = "pi-existing";
  host.sessionFile = "/pi/existing.jsonl";
  await new CycleController(store, "/pi", async (_manifest, _store, _dir, existing) => {
    opened = existing;
    return host;
  }).run();
  assert.equal(opened, "/pi/existing.jsonl");
  assert.match(host.prompts[0], /controller restarted/i);
  assert.equal(
    store.events(0, 1000).filter((event) => event.type === "pi_session_resumed").length,
    1,
  );
});

test("restart after durable handover creates exactly one successor and preserves later operator input", async () => {
  const { store } = fixture();
  store.update({
    phase: "running",
    activeSessionId: "pi-predecessor",
    activeSessionFile: "/pi/predecessor.jsonl",
  });
  store.persistHandover(1, "pi-predecessor", "/pi/predecessor.jsonl", handover, []);
  const message = store.enqueueMessage("arrived after the handover commit");
  const host = new FakeHost([
    { text: JSON.stringify(complete), steered: false, contextTokens: 10, contextWindow: 100 },
  ]);
  await new CycleController(store, "/pi", async () => host).run();
  assert.equal(host.replacements, 1);
  assert.match(host.prompts[0], /arrived after the handover commit/);
  assert.equal(store.pendingMessages().length, 0);
  assert.equal(
    store.events(0, 1000).filter((event) => event.type === "successor_session_started").length,
    1,
  );
  const consumed = store
    .events(0, 1000)
    .find((event) => event.type === "operator_messages_consumed");
  assert.deepEqual(consumed?.messageIds, [message.id]);
});

test("handover phase commits before message consumption and restart replaces exactly once after a consumption fault", async () => {
  const { store } = fixture();
  store.update({
    phase: "running",
    activeSessionId: "pi-predecessor",
    activeSessionFile: "/pi/predecessor.jsonl",
  });
  const message = store.enqueueMessage("must remain at least once after the fault");
  const consume = store.consumeMessages.bind(store);
  store.consumeMessages = (() => {
    throw new Error("injected consumption failure");
  }) as typeof store.consumeMessages;
  assert.throws(
    () => store.persistHandover(1, "pi-predecessor", "/pi/predecessor.jsonl", handover, [message]),
    /injected consumption failure/,
  );
  assert.equal(store.snapshot().phase, "handover_durable");
  assert.deepEqual(
    store.pendingMessages().map((item) => item.id),
    [message.id],
  );
  store.consumeMessages = consume;

  const host = new FakeHost([
    { text: JSON.stringify(complete), steered: false, contextTokens: 10, contextWindow: 100 },
  ]);
  await new CycleController(store, "/pi", async () => host).run();
  assert.equal(host.replacements, 1);
  assert.match(host.prompts[0], /must remain at least once after the fault/);
  assert.equal(store.pendingMessages().length, 0);
  assert.equal(store.snapshot().status, "complete");
});

test("restart adopts an already materialized successor without creating a duplicate", async () => {
  const { store } = fixture();
  const sessionDir = join(store.runDir, "pi-sessions");
  mkdirSync(sessionDir);
  const predecessorFile = join(sessionDir, "predecessor.jsonl");
  const successorFile = join(sessionDir, "successor.jsonl");
  writeFileSync(
    successorFile,
    `${JSON.stringify({ type: "session", version: 3, id: "pi-existing-successor", timestamp: new Date().toISOString(), cwd: store.manifest().workspace, parentSession: predecessorFile })}\n`,
  );
  store.update({
    phase: "running",
    activeSessionId: "pi-predecessor",
    activeSessionFile: predecessorFile,
  });
  store.persistHandover(1, "pi-predecessor", predecessorFile, handover, []);
  const host = new FakeHost([
    { text: JSON.stringify(complete), steered: false, contextTokens: 10, contextWindow: 100 },
  ]);
  host.sessionId = "pi-existing-successor";
  host.sessionFile = successorFile;
  let opened: string | undefined;
  await new CycleController(store, "/pi", async (_manifest, _store, _dir, existing) => {
    opened = existing;
    return host;
  }).run();
  assert.equal(opened, successorFile);
  assert.equal(host.replacements, 0);
  assert.equal(
    store.events(0, 1000).filter((event) => event.type === "successor_session_adopted").length,
    1,
  );
});

test("operator input accepted during a completing invocation is delivered before terminal completion", async () => {
  const { store } = fixture();
  const host = new FakeHost([
    { text: JSON.stringify(complete), steered: false, contextTokens: 10, contextWindow: 100 },
    { text: JSON.stringify(complete), steered: false, contextTokens: 11, contextWindow: 100 },
  ]);
  const run = host.run.bind(host);
  let lateMessage: ReturnType<RunStore["enqueueMessage"]> | undefined;
  host.run = async (prompt: string) => {
    if (!lateMessage) lateMessage = store.enqueueMessage("accepted just before complete returned");
    return run(prompt);
  };

  await new CycleController(store, "/pi", async () => host).run();

  assert.equal(store.snapshot().status, "complete");
  assert.equal(host.prompts.length, 2);
  assert.equal(host.replacements, 0);
  assert.doesNotMatch(host.prompts[0], /accepted just before complete returned/);
  assert.match(host.prompts[1], /accepted just before complete returned/);
  assert.equal(store.pendingMessages().length, 0);
  const events = store.events(0, 1000);
  assert.equal(events.filter((event) => event.type === "terminal_status_deferred").length, 1);
  const invocations = events.filter((event) => event.type === "pi_invocation_started");
  assert.deepEqual(invocations[0].messageIds, []);
  assert.deepEqual(invocations[1].messageIds, [lateMessage!.id]);
  assert.equal(events.filter((event) => event.type === "run_completed").length, 1);
});

test("waiting durably checkpoints and releases Pi without another invocation", async () => {
  const { store } = fixture();
  const host = new FakeHost([
    { text: JSON.stringify(waiting), steered: false, contextTokens: 10, contextWindow: 100 },
  ]);

  await new CycleController(store, "/pi", async () => host).run();

  assert.equal(store.snapshot().status, "waiting");
  assert.equal(store.snapshot().phase, "waiting");
  assert.equal(store.snapshot().activeSessionId, "pi-predecessor");
  assert.equal(store.snapshot().activeSessionFile, "/pi/predecessor.jsonl");
  assert.equal(host.prompts.length, 1);
  assert.equal(existsSync(store.leasePath), false);
  const events = store.events(0, 1000);
  assert.ok(
    events.findIndex((event) => event.type === "work_checkpoint") <
      events.findIndex((event) => event.type === "run_waiting"),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(host.prompts.length, 1);
});

test("operator input arriving during a waiting decision prevents the lost wakeup", async () => {
  const { store } = fixture();
  const host = new FakeHost([
    { text: JSON.stringify(waiting), steered: false, contextTokens: 10, contextWindow: 100 },
    { text: JSON.stringify(complete), steered: false, contextTokens: 11, contextWindow: 100 },
  ]);
  const run = host.run.bind(host);
  host.run = async (prompt: string) => {
    const result = await run(prompt);
    if (host.prompts.length === 1) store.enqueueMessage("wake at the waiting seam");
    return result;
  };

  await new CycleController(store, "/pi", async () => host).run();

  assert.equal(store.snapshot().status, "complete");
  assert.equal(host.prompts.length, 2);
  assert.match(host.prompts[1], /wake at the waiting seam/);
  assert.equal(store.pendingMessages().length, 0);
  assert.equal(
    store.events(0, 1000).filter((event) => event.type === "waiting_status_deferred").length,
    1,
  );
  assert.equal(store.events(0, 1000).filter((event) => event.type === "run_waiting").length, 0);
});

test("dormant wall-clock age does not exhaust active execution time", async () => {
  const { store } = fixture();
  store.update({
    phase: "ready",
    activeSessionId: "pi-existing",
    activeSessionFile: "/pi/existing.jsonl",
    startedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    activeMilliseconds: 0,
  });
  const host = new FakeHost([
    { text: JSON.stringify(complete), steered: false, contextTokens: 10, contextWindow: 100 },
  ]);
  host.sessionId = "pi-existing";
  host.sessionFile = "/pi/existing.jsonl";

  await new CycleController(store, "/pi", async () => host).run();

  assert.equal(store.snapshot().status, "complete");
  assert.equal(host.prompts.length, 1);
});

test("oversized assistant control is rejected without persisting unreadable state", async () => {
  const { store } = fixture();
  const host = new FakeHost([
    {
      text: JSON.stringify({
        status: "complete",
        summary: "x".repeat(65_537),
        verification: [],
        next_action: "",
      }),
      steered: false,
      contextTokens: 10,
      contextWindow: 100,
    },
  ]);

  await assert.rejects(
    new CycleController(store, "/pi", async () => host).run(),
    /summary must be a string/,
  );

  const snapshot = store.snapshot();
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.phase, "terminal");
  assert.equal(snapshot.terminalCause, "controller_failure");
  assert.equal(store.events(0, 1000).filter((event) => event.type === "work_checkpoint").length, 0);
});

test("invocation cap is strict", async () => {
  const { store } = fixture();
  const manifest = store.manifest();
  const capped = { ...manifest, maxInvocations: 1 };
  const { runId: _runId, createdAt: _createdAt, ...withoutGenerated } = capped;
  const second = RunStore.create(join(store.runDir, "..", "capped"), withoutGenerated);
  const host = new FakeHost([
    {
      text: JSON.stringify({ ...complete, status: "continue", next_action: "again" }),
      steered: false,
      contextTokens: 1,
      contextWindow: 100,
    },
  ]);
  await assert.rejects(
    new CycleController(second, "/pi", async () => host).run(),
    /Maximum Pi invocations/,
  );
  assert.equal(host.prompts.length, 1);
  assert.equal(second.snapshot().status, "blocked");
  assert.equal(second.snapshot().terminalCause, "invocation_limit");
});

test("epoch cap blocks after durable handover without creating a successor", async () => {
  const { store } = fixture();
  const manifest = store.manifest();
  const {
    runId: _runId,
    createdAt: _createdAt,
    ...withoutGenerated
  } = { ...manifest, maxEpochs: 1 };
  const capped = RunStore.create(join(store.runDir, "..", "epoch-capped"), withoutGenerated);
  const host = new FakeHost([
    { text: JSON.stringify(handover), steered: true, contextTokens: 90, contextWindow: 100 },
  ]);
  await assert.rejects(
    new CycleController(capped, "/pi", async () => host).run(),
    /Maximum Pi session epochs/,
  );
  assert.equal(host.replacements, 0);
  assert.equal(capped.snapshot().status, "blocked");
  assert.equal(capped.snapshot().terminalCause, "epoch_limit");
  assert.equal(
    capped.events(0, 1000).filter((event) => event.type === "handover_written").length,
    1,
  );
});

test("worker fails closed and reports authenticated idle health", async () => {
  const { root } = fixture();
  const service = new SeptService({
    stateRoot: join(root, "empty-runs"),
    agentDir: "/pi",
    token: "secret",
    port: 0,
    piVersion: "0.85.1",
    modelAccessService: await testModelAccess(),
  });
  const address = await service.start();
  try {
    const base = `http://${address.host}:${address.port}`;
    assert.equal((await fetch(`${base}/health`)).status, 401);
    const response = await fetch(`${base}/health`, { headers: { Authorization: "Bearer secret" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      worker: "idle",
      readiness: "accepting",
      acceptingWork: true,
      activeRunId: null,
      runtime: "pi-sdk",
    });
  } finally {
    await service.stop();
  }
});

test("worker ignores legacy manifest-only run directories without changing them", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-legacy-state-"));
  const stateRoot = join(root, "runs");
  const legacyDir = join(stateRoot, "legacy-run");
  mkdirSync(legacyDir, { recursive: true });
  const legacyManifest = `${JSON.stringify({ run_id: "legacy-run", task: "historical" })}\n`;
  const legacyEvents = `${JSON.stringify({ type: "legacy_event" })}\n`;
  writeFileSync(join(legacyDir, "manifest.json"), legacyManifest);
  writeFileSync(join(legacyDir, "events.jsonl"), legacyEvents);

  const service = new SeptService({
    stateRoot,
    agentDir: "/pi",
    token: "secret",
    port: 0,
    piVersion: "0.85.1",
    modelAccessService: await testModelAccess(),
  });
  const address = await service.start();
  try {
    const response = await fetch(`http://${address.host}:${address.port}/health`, {
      headers: { Authorization: "Bearer secret" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      worker: "idle",
      readiness: "accepting",
      acceptingWork: true,
      activeRunId: null,
      runtime: "pi-sdk",
    });
    assert.equal(readFileSync(join(legacyDir, "manifest.json"), "utf8"), legacyManifest);
    assert.equal(readFileSync(join(legacyDir, "events.jsonl"), "utf8"), legacyEvents);
  } finally {
    await service.stop();
  }
});

test("worker keeps its single slot busy while waiting to adopt a recent lease", async () => {
  const { root, store } = fixture();
  writeFileSync(
    store.leasePath,
    `${JSON.stringify({ ownerId: "previous", pid: 999_999, hostname: hostname(), processStartedAt: 1, heartbeatAt: new Date().toISOString() })}\n`,
  );
  const almostStale = new Date(Date.now() - 4_500);
  utimesSync(store.leasePath, almostStale, almostStale);
  const host = new FakeHost([
    { text: JSON.stringify(complete), steered: false, contextTokens: 10, contextWindow: 100 },
  ]);
  const service = new SeptService({
    stateRoot: join(root, "runs"),
    agentDir: "/pi",
    workspaceRoot: root,
    token: "secret",
    port: 0,
    piVersion: "0.85.1",
    hostFactory: async () => host,
    modelAccessService: await testModelAccess(),
  });
  const address = await service.start();
  try {
    const base = `http://${address.host}:${address.port}`;
    const health = await fetch(`${base}/health`, { headers: { Authorization: "Bearer secret" } });
    assert.equal(((await health.json()) as { worker: string }).worker, "busy");
    const create = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ task: "must be rejected while adoption is pending" }),
    });
    assert.equal(create.status, 409);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(store.snapshot().status, "complete");
  } finally {
    await service.stop();
  }
});

test("graceful service stop rejects admission and waits for one durable controller boundary before releasing ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-graceful-stop-"));
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "runs");
  mkdirSync(workspace);
  const host = new GracefulStopHost();
  const service = new SeptService({
    stateRoot,
    agentDir: "/pi",
    workspaceRoot: root,
    token: "secret",
    host: "127.0.0.1",
    port: 0,
    piVersion: "0.85.1",
    hostFactory: async () => host,
    modelAccessService: await testModelAccess(),
  });
  const address = await service.start();
  const task = await fetch(`http://${address.host}:${address.port}/v1/tasks`, {
    method: "POST",
    headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
    body: JSON.stringify({ task: "checkpoint before stop", workspace }),
  });
  assert.equal(task.status, 202);
  const runId = ((await task.json()) as { runId: string }).runId;
  while (!host.prompts.length) await new Promise((resolve) => setTimeout(resolve, 5));
  let stopped = false;
  const stopping = service.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(stopped, false);
  assert.equal(existsSync(join(stateRoot, "worker.lease")), true);
  host.release();
  await stopping;
  const store = new RunStore(join(stateRoot, runId));
  assert.equal(host.closed, true);
  assert.equal(store.snapshot().status, "active");
  assert.equal(store.events(0, 1000).filter((event) => event.type === "work_checkpoint").length, 1);
  assert.equal(existsSync(store.leasePath), false);
  assert.equal(existsSync(join(stateRoot, "worker.lease")), false);
});

test("only one service can own a state root and ownership is released on stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-root-owner-"));
  const stateRoot = join(root, "runs");
  const first = new SeptService({
    stateRoot,
    agentDir: "/pi",
    workspaceRoot: root,
    token: "secret",
    host: "127.0.0.1",
    port: 0,
    piVersion: "0.85.1",
    modelAccessService: await testModelAccess(),
  });
  await first.start();
  const second = new SeptService({
    stateRoot,
    agentDir: "/pi",
    workspaceRoot: root,
    token: "secret",
    host: "127.0.0.1",
    port: 0,
    piVersion: "0.85.1",
    modelAccessService: await testModelAccess(),
  });
  await assert.rejects(second.start(), /state root is already owned|ownership lease/);
  await first.stop();
  const successor = new SeptService({
    stateRoot,
    agentDir: "/pi",
    workspaceRoot: root,
    token: "secret",
    host: "127.0.0.1",
    port: 0,
    piVersion: "0.85.1",
    modelAccessService: await testModelAccess(),
  });
  await successor.start();
  await successor.stop();
});

test("bounded log endpoint storage truncates old records", () => {
  const { store } = fixture();
  for (let i = 0; i < 40; i++) store.log({ text: "x".repeat(200), i }, 2048);
  assert.ok(readFileSync(store.logPath).byteLength <= 2048);
});
