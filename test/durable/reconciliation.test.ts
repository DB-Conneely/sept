/** Reconciliation stays bounded across consumed history and preserves each terminal occurrence. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_CONVERSATION_EVENTS, RunStore, atomicWrite } from "../../src/durable/index.js";
import { validateRequest } from "../../src/ingress/index.js";

function fixture(): RunStore {
  const root = mkdtempSync(join(tmpdir(), "sept-reconciliation-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  return RunStore.create(
    join(root, "runs"),
    validateRequest({ task: "reconciliation", workspace }, "1.1.0"),
  );
}

await test("consumed historical batches stay expired while an unmarked projection is repaired once", () => {
  const store = fixture();
  const createdAt = new Date().toISOString();
  for (let index = 0; index < MAX_CONVERSATION_EVENTS + 65; index += 1) {
    const message = {
      id: `historic-${String(index)}`,
      createdAt,
      text: `expired-text-${String(index)}`,
    };
    store.event("work_checkpoint", { operatorMessages: [message], messageIds: [message.id] });
    store.event("operator_conversation_recorded", { messageId: message.id });
  }
  const retained = Array.from({ length: MAX_CONVERSATION_EVENTS }, (_, index) => ({
    formatVersion: 1,
    cursor: index + 100,
    id: `retained-${String(index)}`,
    type: "state",
    state: "active",
    at: createdAt,
  }));
  atomicWrite(store.conversationPath, retained.map((event) => JSON.stringify(event)).join("\n"));
  const message = { id: "missing-projection", createdAt, text: "repair exact text" };
  store.event("work_checkpoint", { operatorMessages: [message], messageIds: [message.id] });
  store.reconcileOperatorConversation();
  const first = store.conversation(100 + MAX_CONVERSATION_EVENTS - 2).events;
  assert.equal(first.filter((event) => event.id === "operator-missing-projection").length, 1);
  assert.doesNotMatch(JSON.stringify(first), /expired-text/);
  store.reconcileOperatorConversation();
  assert.deepEqual(store.conversation(100 + MAX_CONVERSATION_EVENTS - 2).events, first);
  store.enqueueMessage("expired-text-0", "historic-0");
  assert.deepEqual(store.conversation(100 + MAX_CONVERSATION_EVENTS - 2).events, first);
});

await test("blocked reopen blocked records one stable terminal event per invocation and repairs restart", () => {
  const store = fixture();
  store.update({ status: "blocked", phase: "terminal", invocations: 1 });
  store.ensureTerminalConversation();
  store.ensureTerminalConversation();
  const first = store.conversation().events.find((event) => event.type === "terminal");
  assert.ok(first !== undefined);
  store.update({ status: "active", phase: "ready" });
  store.event("run_reopened", { messageId: "reopen" });
  store.conversationState("reopen", "active");
  store.update({ status: "blocked", phase: "terminal", invocations: 2 });
  store.ensureTerminalConversation();
  new RunStore(store.runDir).ensureTerminalConversation();
  const terminals = store.conversation().events.filter((event) => event.type === "terminal");
  assert.equal(terminals.length, 2);
  assert.notEqual(terminals[0]?.id, terminals[1]?.id);
  assert.equal(
    store.conversation(first.cursor).events.filter((event) => event.type === "terminal").length,
    1,
  );
});
