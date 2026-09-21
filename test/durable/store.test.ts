import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_CONVERSATION_EVENTS,
  MAX_PENDING_MESSAGES,
  ConversationCursorExpiredError,
  QueueCapacityError,
  RunStore,
  SeptError,
  WorkerLifecycleStore,
  acquireStateRootLease,
  atomicCreate,
  atomicWrite,
  listRuns,
  parseJsonObject,
  validateHandover,
  validateWork,
} from "../../src/durable/index.js";
import { validateRequest } from "../../src/ingress/index.js";

interface StoreFixture {
  root: string;
  workspace: string;
  stateRoot: string;
  store: RunStore;
}

function fixture(): StoreFixture {
  const root = mkdtempSync(join(tmpdir(), "sept-store-"));
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "runs");
  mkdirSync(workspace);
  const store = RunStore.create(
    stateRoot,
    validateRequest({ task: "durable fixture", workspace }, "0.85.1"),
  );
  return { root, workspace, stateRoot, store };
}

function processStartedAt(path: string): number {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null && "processStartedAt" in parsed);
  assert.ok(typeof parsed.processStartedAt === "number");
  return parsed.processStartedAt;
}

await test("atomic durable files create once and replace completely", () => {
  const root = mkdtempSync(join(tmpdir(), "sept-atomic-"));
  const path = join(root, "nested", "state.json");
  assert.equal(atomicCreate(path, { revision: 1 }), true);
  assert.equal(atomicCreate(path, { revision: 2 }), false);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { revision: 1 });
  atomicWrite(path, { revision: 3 });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { revision: 3 });
});

await test("worker lifecycle persistence makes drain monotonic and restart-readable", () => {
  const root = mkdtempSync(join(tmpdir(), "sept-lifecycle-"));
  const lifecycle = new WorkerLifecycleStore(root);
  assert.equal(lifecycle.read().readiness, "accepting");
  assert.equal(lifecycle.beginDrain().readiness, "draining");
  assert.equal(new WorkerLifecycleStore(root).read().readiness, "draining");
  assert.equal(lifecycle.finishDrain().readiness, "drained");
  assert.equal(lifecycle.beginDrain().readiness, "drained");
});

await test("assistant JSON parsing and cursor expiry expose classified errors", () => {
  assert.deepEqual(parseJsonObject('prefix\n```json\n{"status":"complete"}\n```'), {
    status: "complete",
  });
  assert.throws(() => parseJsonObject("not JSON"), SeptError);
  const expired = new ConversationCursorExpiredError(3);
  assert.ok(expired instanceof SeptError);
  assert.equal(expired.retainedFrom, 3);
  assert.match(expired.message, /earliest retained cursor is 3/);
});

await test("format-version-2 state is fully validated and partial v2 runs fail closed", () => {
  const mutations = [
    (store: RunStore): void => {
      writeFileSync(
        store.snapshotPath,
        `${JSON.stringify({ ...store.snapshot(), status: "unknown" })}\n`,
      );
    },
    (store: RunStore): void => {
      writeFileSync(
        store.manifestPath,
        `${JSON.stringify({ formatVersion: 2, runId: store.runId })}\n`,
      );
    },
    (store: RunStore): void => {
      writeFileSync(store.snapshotPath, "{not-json\n");
    },
  ];
  for (const mutate of mutations) {
    const { stateRoot, store } = fixture();
    mutate(store);
    assert.throws(() => listRuns(stateRoot), /Invalid durable/);
  }

  const missingState = fixture();
  unlinkSync(missingState.store.snapshotPath);
  assert.throws(() => listRuns(missingState.stateRoot), /missing state/);

  const partialRoot = mkdtempSync(join(tmpdir(), "sept-partial-v2-"));
  const partial = join(partialRoot, "partial");
  mkdirSync(partial, { recursive: true });
  writeFileSync(join(partial, "state.json"), "{}\n");
  assert.throws(() => listRuns(partialRoot), /missing manifest/);
});

await test("legacy, reserved, hidden, and unrelated directories remain intentionally ignored", () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "sept-ignored-state-"));
  for (const name of ["legacy", ".creating-interrupted", "webhook-receipts", "unrelated"]) {
    mkdirSync(join(stateRoot, name));
  }
  writeFileSync(
    join(stateRoot, "legacy", "manifest.json"),
    `${JSON.stringify({ run_id: "legacy", task: "old" })}\n`,
  );
  writeFileSync(join(stateRoot, ".creating-interrupted", "state.json"), "{}\n");
  writeFileSync(join(stateRoot, "webhook-receipts", "state.json"), "{}\n");
  writeFileSync(join(stateRoot, "unrelated", "notes.txt"), "not SEPT state\n");
  assert.deepEqual(listRuns(stateRoot), []);
});

await test("operator queue is bounded, preserves exact text, and compacts after proof", () => {
  const { store } = fixture();
  const exact = "  leading and trailing \t\n";
  const first = store.enqueueMessage(exact, "fixed-message");
  assert.equal(first.text, exact);
  for (let index = 1; index < MAX_PENDING_MESSAGES; index += 1) {
    store.enqueueMessage(`message-${String(index)}`);
  }
  assert.equal(store.pendingMessages().length, MAX_PENDING_MESSAGES);
  assert.throws(() => store.enqueueMessage("over capacity"), QueueCapacityError);

  const pending = store.pendingMessages();
  store.checkpoint(
    { status: "continue", summary: "durable", verification: [], next_action: "continue" },
    pending,
    "session",
  );
  assert.deepEqual(store.pendingMessages(), []);
  assert.equal(
    store.operatorMessage("fixed-message")?.text,
    exact,
    "compaction must retain exact idempotency evidence in events",
  );
  assert.ok(readFileSync(store.messagesPath, "utf8").length <= 1);
  assert.equal(store.enqueueMessage("after compaction").text, "after compaction");
});

await test("conversation recovers and compacts one interrupted retention append", () => {
  const { store } = fixture();
  const at = new Date().toISOString();
  const overflow = Array.from({ length: MAX_CONVERSATION_EVENTS }, (_, index) =>
    JSON.stringify({
      formatVersion: 1,
      cursor: index + 2,
      id: `recovery-${String(index)}`,
      type: "state",
      state: "active",
      at,
    }),
  ).join("\n");
  appendFileSync(store.conversationPath, `${overflow}\n`);
  const page = store.conversation(1, 250);
  assert.equal(page.retainedFrom, 2);
  assert.equal(page.events[0]?.cursor, 2);
  const retainedLines = readFileSync(store.conversationPath, "utf8").trim().split("\n");
  assert.equal(retainedLines.length, MAX_CONVERSATION_EVENTS);
});

await test("event retrieval remains response-bounded over a large durable history", () => {
  const { store } = fixture();
  for (let index = 0; index < 2_000; index += 1) {
    store.event("history", { index });
  }
  const page = store.events(1_000, 17);
  assert.equal(page.length, 17);
  assert.ok(page.every((event) => event.seq > 1_000));
});

await test("run and state-root leases use one stable process identity", () => {
  const { stateRoot, store } = fixture();
  const releaseRoot = acquireStateRootLease(stateRoot);
  const releaseRun = store.acquireLease();
  try {
    const rootProcessStartedAt = processStartedAt(join(stateRoot, "worker.lease"));
    const runProcessStartedAt = processStartedAt(store.leasePath);
    assert.equal(rootProcessStartedAt, runProcessStartedAt);
    const stale = new Date(Date.now() - 6_000);
    utimesSync(join(stateRoot, "worker.lease"), stale, stale);
    utimesSync(store.leasePath, stale, stale);
    assert.throws(() => acquireStateRootLease(stateRoot), /already owned by this process/);
    assert.throws(() => store.acquireLease(), /already controlled by this process/);
  } finally {
    releaseRun();
    releaseRoot();
  }
});

await test("assistant work and handover controls are bounded before durable use", () => {
  assert.throws(
    () =>
      validateWork({
        status: "complete",
        summary: "x".repeat(65_537),
        verification: [],
        next_action: "",
      }),
    /summary must be a string/,
  );
  const handover = {
    handover_summary: "bounded",
    entry_state_and_done: "bounded",
    completed: Array.from({ length: 65 }, () => "item"),
    in_flight: [],
    not_started: [],
    decisions: [],
    rejected_approaches: [],
    verification: [],
    uncertainties: [],
    references: [],
    lessons: [],
    next_action: "continue",
  };
  assert.throws(() => validateHandover(handover), /completed must be an array of at most 64/);
});
