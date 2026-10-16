/** Focused response contracts and hostile envelopes around the reused durable codecs. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  taskAdmission,
  messageAdmission,
  taskProjection,
  conversationPage,
  cancelResult,
} from "../../src/client/response-codecs.js";
import { SeptError } from "../../src/durable/index.js";
import { TaskClientError } from "../../src/client/index.js";
import { clientFailure, conversationEvent, projection } from "./support.js";

void test("TaskClientError is a typed bounded SeptError with stable classification", () => {
  const failure = new TaskClientError("http", 410, 9);
  assert.ok(failure instanceof SeptError);
  assert.equal(failure.name, "TaskClientError");
  assert.equal(failure.status, 410);
  assert.equal(failure.retainedFrom, 9);
  assert.ok(clientFailure("http", 410, 9)(failure));
});

void test("taskAdmission and messageAdmission enforce exact status, kind, identity and original receipts", () => {
  const receipt = { kind: "task", runId: "run-1", status: "active", duplicate: false };
  assert.deepEqual(taskAdmission(receipt, 202), receipt);
  assert.equal(taskAdmission({ ...receipt, duplicate: true }, 200).status, "active");
  const invalid = [
    null,
    [],
    { ...receipt, extra: true },
    { ...receipt, status: "complete" },
    { ...receipt, runId: "../private" },
    { ...receipt, duplicate: "false" },
  ];
  for (const body of invalid) {
    assert.throws(() => taskAdmission(body, 202), clientFailure("protocol"));
  }
  assert.throws(() => taskAdmission(receipt, 200), clientFailure("protocol"));
  assert.throws(
    () => taskAdmission({ ...receipt, duplicate: true }, 202),
    clientFailure("protocol"),
  );
});

void test("messageAdmission retains replay identity and rejects foreign runs", () => {
  const message = {
    kind: "operator_message",
    runId: "run-1",
    messageId: "message-1",
    duplicate: false,
  };
  assert.deepEqual(messageAdmission(message, 202, "run-1"), message);
  assert.equal(
    messageAdmission({ ...message, duplicate: true }, 200, "run-1").messageId,
    "message-1",
  );
  assert.throws(() => messageAdmission(message, 202, "run-2"), clientFailure("protocol"));
  assert.throws(
    () => messageAdmission({ ...message, messageId: "x/y" }, 202, "run-1"),
    clientFailure("protocol"),
  );
  assert.throws(
    () => messageAdmission({ ...message, kind: "task" }, 202, "run-1"),
    clientFailure("protocol"),
  );
});

void test("taskProjection reuses validateManifest and validateSnapshot for public projected paths", () => {
  const body = projection();
  const decoded = taskProjection(body, 200, "run-1");
  assert.equal(decoded.manifest.workspace, "/workspace/child");
  assert.equal(decoded.state.activeSessionFile, "<pi-session>/session.jsonl");
  assert.deepEqual(decoded, body);
  assert.throws(() => taskProjection(body, 202, "run-1"), clientFailure("protocol"));
  assert.throws(() => taskProjection(body, 200, "run-2"), clientFailure("protocol"));
  assert.throws(
    () =>
      taskProjection(
        { ...decoded, manifest: { ...decoded.manifest, workspace: "relative" } },
        200,
        "run-1",
      ),
    clientFailure("protocol"),
  );
  assert.throws(
    () =>
      taskProjection({ ...decoded, state: { ...decoded.state, phase: "terminal" } }, 200, "run-1"),
    clientFailure("protocol"),
  );
  assert.throws(
    () =>
      taskProjection(
        { ...decoded, state: { ...decoded.state, extra: "hostile-secret" } },
        200,
        "run-1",
      ),
    clientFailure("protocol"),
  );
});

void test("conversationPage enforces count, safe cursors, order, next position and current terminal envelope", () => {
  const body = {
    events: [conversationEvent(3), conversationEvent(4)],
    retainedFrom: 3,
    nextCursor: 4,
    terminal: null,
  };
  assert.equal(conversationPage(body, 200, 2, 2).events.length, 2);
  const terminal = { ...body, events: [], nextCursor: 4, terminal: { status: "complete" } };
  assert.deepEqual(conversationPage(terminal, 200, 4, 1), terminal);
  const invalid = [
    { ...body, events: [conversationEvent(4), conversationEvent(3)] },
    { ...body, events: [conversationEvent(3), conversationEvent(3)] },
    { ...body, nextCursor: 5 },
    { ...body, retainedFrom: 0 },
    { ...body, retainedFrom: 4 },
    { ...body, terminal: { status: "waiting" } },
    { ...body, terminal: { status: "complete", extra: true } },
    { ...body, events: [{ ...conversationEvent(), text: "" }] },
    { ...body, nextCursor: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const value of invalid) {
    assert.throws(() => conversationPage(value, 200, 2, 2), clientFailure("protocol"));
  }
  assert.throws(() => conversationPage(body, 202, 2, 2), clientFailure("protocol"));
  assert.throws(() => conversationPage(body, 200, 2, 1), clientFailure("protocol"));
});

void test("conversationPage accepts historical terminal markers after current state reopened", () => {
  const body = { events: [], retainedFrom: 3, nextCursor: 3, terminal: null };
  const oldTerminal = {
    ...body,
    events: [
      {
        formatVersion: 1,
        cursor: 3,
        id: "old",
        at: "2026-10-16T00:00:00.000Z",
        type: "terminal",
        status: "blocked",
      },
    ],
    nextCursor: 3,
  };
  assert.equal(conversationPage(oldTerminal, 200, 2, 1).terminal, null);
});

void test("cancelResult distinguishes accepted cancelling from settled cancellation and terminal no-op", () => {
  for (const status of [
    "cancelling",
    "cancelled",
    "complete",
    "blocked",
    "failed",
    "active",
    "waiting",
  ]) {
    const cancelled = status === "cancelling" || status === "cancelled";
    const code = status === "cancelling" ? 202 : 200;
    const body = { runId: "run-1", status, cancelled };
    assert.deepEqual(cancelResult(body, code, "run-1"), body);
    assert.throws(() => cancelResult(body, code, "run-2"), clientFailure("protocol"));
    assert.throws(
      () => cancelResult({ ...body, cancelled: !cancelled }, code, "run-1"),
      clientFailure("protocol"),
    );
  }
  assert.throws(
    () => cancelResult({ runId: "run-1", status: "unknown", cancelled: false }, 200, "run-1"),
    clientFailure("protocol"),
  );
  assert.throws(
    () => cancelResult({ runId: "run-1", status: "cancelling", cancelled: true }, 200, "run-1"),
    clientFailure("protocol"),
  );
});
