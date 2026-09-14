import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_PENDING_MESSAGES, QueueCapacityError, RunStore, acquireStateRootLease, listRuns, validateHandover, validateWork } from "../../src/durable/index.js";
import { validateRequest } from "../../src/ingress/index.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sept-store-"));
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "runs");
  mkdirSync(workspace);
  const store = RunStore.create(stateRoot, validateRequest({ task: "durable fixture", workspace }, "0.85.1"));
  return { root, workspace, stateRoot, store };
}

test("format-version-2 state is fully validated and partial v2 runs fail closed", () => {
  for (const mutation of [
    (store: RunStore) => writeFileSync(store.snapshotPath, `${JSON.stringify({ ...store.snapshot(), status: "unknown" })}\n`),
    (store: RunStore) => writeFileSync(store.manifestPath, `${JSON.stringify({ formatVersion: 2, runId: store.runId })}\n`),
    (store: RunStore) => writeFileSync(store.snapshotPath, "{not-json\n"),
  ]) {
    const { stateRoot, store } = fixture();
    mutation(store);
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

test("legacy, reserved, hidden, and unrelated directories remain intentionally ignored", () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "sept-ignored-state-"));
  for (const name of ["legacy", ".creating-interrupted", "webhook-receipts", "unrelated"]) mkdirSync(join(stateRoot, name));
  writeFileSync(join(stateRoot, "legacy", "manifest.json"), `${JSON.stringify({ run_id: "legacy", task: "old" })}\n`);
  writeFileSync(join(stateRoot, ".creating-interrupted", "state.json"), "{}\n");
  writeFileSync(join(stateRoot, "webhook-receipts", "state.json"), "{}\n");
  writeFileSync(join(stateRoot, "unrelated", "notes.txt"), "not SEPT state\n");
  assert.deepEqual(listRuns(stateRoot), []);
});

test("operator queue is bounded, preserves exact text, and compacts only after exact durable proof", () => {
  const { store } = fixture();
  const exact = "  leading and trailing \t\n";
  const first = store.enqueueMessage(exact, "fixed-message");
  assert.equal(first.text, exact);
  for (let index = 1; index < MAX_PENDING_MESSAGES; index++) store.enqueueMessage(`message-${index}`);
  assert.equal(store.pendingMessages().length, MAX_PENDING_MESSAGES);
  assert.throws(() => store.enqueueMessage("over capacity"), QueueCapacityError);

  const pending = store.pendingMessages();
  store.checkpoint({ status: "continue", summary: "durable", verification: [], next_action: "continue" }, pending, "session");
  assert.deepEqual(store.pendingMessages(), []);
  assert.equal(store.operatorMessage("fixed-message")?.text, exact, "compaction must retain exact idempotency evidence in events");
  assert.ok(readFileSync(store.messagesPath, "utf8").length <= 1);
  assert.equal(store.enqueueMessage("after compaction").text, "after compaction");
});

test("event retrieval remains response-bounded over a large durable history", () => {
  const { store } = fixture();
  for (let index = 0; index < 2_000; index++) store.event("history", { index });
  const page = store.events(1_000, 17);
  assert.equal(page.length, 17);
  assert.ok(page.every((event) => event.seq > 1_000));
});

test("run and state-root leases use one stable process identity", () => {
  const { stateRoot, store } = fixture();
  const releaseRoot = acquireStateRootLease(stateRoot);
  const releaseRun = store.acquireLease();
  try {
    const rootLease = JSON.parse(readFileSync(join(stateRoot, "worker.lease"), "utf8")) as { processStartedAt: number };
    const runLease = JSON.parse(readFileSync(store.leasePath, "utf8")) as { processStartedAt: number };
    assert.equal(rootLease.processStartedAt, runLease.processStartedAt);
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

test("assistant work and handover controls are bounded before durable use", () => {
  assert.throws(() => validateWork({ status: "complete", summary: "x".repeat(65_537), verification: [], next_action: "" }), /summary must be a string/);
  const handover = {
    handover_summary: "bounded",
    entry_state_and_done: "bounded",
    completed: Array.from({ length: 65 }, () => "item"),
    in_flight: [], not_started: [], decisions: [], rejected_approaches: [], verification: [], uncertainties: [], references: [], lessons: [],
    next_action: "continue",
  };
  assert.throws(() => validateHandover(handover), /completed must be an array of at most 64/);
});
