/**
 * Focuses the ingress building-block contracts that complement installed SeptService tests. Pure
 * parsing and classification helpers are asserted directly; composed classes are exercised by the
 * neighboring installed HTTP suites.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationStreams } from "../../src/ingress/conversation-stream.js";
import { RequestError, WebhookCollisionError } from "../../src/ingress/errors.js";
import { respondWithError } from "../../src/ingress/http-errors.js";
import {
  emptyBody,
  jsonResponse,
  noQueryExcept,
  normalizeHttpMethod,
  queryInteger,
  routeTemplate,
  safePathname,
  selectionBody,
  textResponse,
} from "../../src/ingress/http.js";
import { RequestRouter } from "../../src/ingress/request-router.js";
import {
  canonicalWorkspaceRoot,
  resolveTaskManifest,
  validateMessageBody,
  validateOperatorMessage,
} from "../../src/ingress/validation.js";
import { WebhookRouter } from "../../src/ingress/webhook-router.js";

void test("HTTP parsers enforce exact bounded primitive contracts", () => {
  assert.deepEqual(selectionBody({ provider: "ready", model: "alpha" }), {
    provider: "ready",
    model: "alpha",
  });
  assert.throws(() => selectionBody({ provider: "ready", model: "alpha", token: "secret" }));
  const url = new URL("http://worker.local/path?after=4");
  noQueryExcept(url, ["after"]);
  assert.equal(queryInteger(url.searchParams, "after", 0, 0, 10), 4);
  assert.throws(() => queryInteger(new URLSearchParams("after=11"), "after", 0, 0, 10));
  assert.equal(normalizeHttpMethod("post"), "POST");
  assert.equal(normalizeHttpMethod("BREW"), "OTHER");
  assert.equal(safePathname("/v1/tasks/example/events"), "/v1/tasks/example/events");
  assert.equal(routeTemplate("GET", "/v1/tasks/example/events"), "/v1/tasks/{runId}/events");
});

void test("message and workspace validation preserve authority invariants", () => {
  const root = mkdtempSync(join(tmpdir(), "sept-ingress-unit-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  assert.equal(canonicalWorkspaceRoot(root), realpathSync(root));
  assert.equal(validateOperatorMessage("  exact\n"), "  exact\n");
  assert.equal(validateMessageBody({ message: "\texact " }), "\texact ");
  assert.throws(() => validateMessageBody({ message: "valid", extra: true }));
});

void test("classified errors and composed ingress owners remain explicit", () => {
  const request = new RequestError(429, "capacity");
  assert.equal(request.status, 429);
  assert.equal(new WebhookCollisionError().status, 409);
  assert.equal(typeof ConversationStreams, "function");
  assert.equal(typeof RequestRouter, "function");
  assert.equal(typeof WebhookRouter, "function");
  assert.equal(typeof resolveTaskManifest, "function");
  assert.equal(typeof emptyBody, "function");
  assert.equal(typeof jsonResponse, "function");
  assert.equal(typeof textResponse, "function");
  assert.equal(typeof respondWithError, "function");
});
