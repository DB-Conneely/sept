/** Admission snapshot regression; installed proof separately verifies the default backend caller. */
import assert from "node:assert/strict";
import test from "node:test";
import { captureHandsRequest } from "../../src/execution/hands-request.js";
import type { HandsRequest } from "../../src/execution/contracts.js";
await test("captureHandsRequest preserves nested admitted intent while a queued caller mutates its inputs", async () => {
  const arguments_ = { path: "artifact.txt", content: "admitted", nested: { marker: "admitted" } };
  const grants = [{ root: "/workspace", read: true, write: true }];
  const request: HandsRequest = {
    kind: "tool",
    name: "write",
    callId: "captured",
    arguments: arguments_,
    grants,
  };
  const captured = captureHandsRequest(request);
  let dispatch: (() => void) | undefined;
  const preceding = new Promise<void>((resolve) => {
    dispatch = resolve;
  });
  const queued = preceding.then(() => captured);
  arguments_.content = "changed after admission";
  arguments_.nested.marker = "changed after admission";
  const grant = grants[0];
  assert.ok(grant);
  grant.write = false;
  assert.ok(dispatch);
  dispatch();
  const delivered = await queued;
  assert.deepEqual(delivered, {
    kind: "tool",
    name: "write",
    callId: "captured",
    arguments: { path: "artifact.txt", content: "admitted", nested: { marker: "admitted" } },
    grants: [{ root: "/workspace", read: true, write: true }],
  });
});
