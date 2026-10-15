/** Supporting current-parent file authority regressions; installed resident effects are proved separately. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { beneath, assertSourceTree } from "../../src/execution/profile-sources.js";
import { SeptError } from "../../src/durable/index.js";
import { HandsFiles } from "../../src/execution/hands-files.js";
import {
  readHandsDirectory,
  privateHandsPath,
  HandsPathMissingError,
  handsPathMissing,
} from "../../src/execution/hands-paths.js";
import { assertHandsEffect } from "../../src/execution/hands-effects.js";
import {
  createHandsBodies,
  requireHandsFiles,
  validateHandsFind,
} from "../../src/execution/hands-discovery.js";
import { executeHandsRequest } from "../../src/execution/hands-entry.js";
import { runHandsResident } from "../../src/execution/hands-resident.js";
import type { HandsEffectCheck, HandsRequest, HandsFrame } from "../../src/execution/contracts.js";
const allow: HandsEffectCheck = () => Promise.resolve();
await test("runHandsResident refuses an unguarded caller before taking stream ownership", async () => {
  await assert.rejects(runHandsResident(), SeptError);
});

await test("HandsFiles waits for live effect authority before truncation and denies swapped aliases", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-hands-effects-"));
  const path = join(root, "artifact");
  writeFileSync(path, "ORIGINAL");
  const files = new HandsFiles([{ root, read: true, write: true }], (right) => {
    assert.equal(right, "write");
    assert.equal(readFileSync(path, "utf8"), "ORIGINAL");
    renameSync(path, join(root, "preserved"));
    symlinkSync(join(root, "preserved"), path);
    return Promise.resolve();
  });
  try {
    await assert.rejects(files.write(path, "MUST-NOT-TRUNCATE"));
    assert.equal(readFileSync(join(root, "preserved"), "utf8"), "ORIGINAL");
  } finally {
    files.close();
  }
});

await test("executeHandsRequest has no undefined-grant effect fallback and refreshes body callbacks", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-hands-bodies-"));
  const bodies = createHandsBodies(root);
  assert.throws(() => requireHandsFiles(bodies));
  const request = {
    kind: "file",
    method: "writeFile",
    path: "artifact",
    content: "shared",
  } as const;
  await assert.rejects(executeHandsRequest(request, root, allow), /parent-bound/);
  assert.equal(existsSync(join(root, "artifact")), false);
  const grants = [{ root, read: true, write: true }];
  await executeHandsRequest({ ...request, grants }, root, allow, undefined, bodies);
  assert.equal(statSync(join(root, "artifact")).mode & 0o007, 0);
  await assert.rejects(
    executeHandsRequest(
      { ...request, content: "late", grants },
      root,
      () => Promise.reject(new SeptError("revoked")),
      undefined,
      bodies,
    ),
  );
  assert.equal(readFileSync(join(root, "artifact"), "utf8"), "shared");
  assert.equal(bodies.files, undefined);
  assert.equal(bodies.command, undefined);
});
await test("executeHandsRequest custom output stays stdout-only and retires active command binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-custom-streams-"));
  const path = join(root, "hand.mjs");
  const code = "process.stdout.write('body-owned')";
  writeFileSync(path, code);
  const bodies = createHandsBodies(root);
  try {
    const result = await executeHandsRequest(
      {
        kind: "custom",
        callId: "custom",
        arguments: { text: "input" },
        hand: { path, sha256: createHash("sha256").update(code).digest("hex"), replay: "safe" },
        grants: [{ root, read: true, write: false }],
      },
      root,
      allow,
      undefined,
      bodies,
      (command, output) => {
        assert.equal(bodies.command !== undefined, true);
        assert.equal("input" in command ? command.input : undefined, "input");
        output(Buffer.from("RESULT"), "stdout");
        output(Buffer.from("DIAGNOSTIC_CANARY"), "stderr");
        return Promise.resolve({ code: 0, signal: null, termination: "exit" });
      },
    );
    assert.deepEqual(result, { content: [{ type: "text", text: "RESULT" }] });
    assert.equal(bodies.command, undefined);
    assert.equal(bodies.files, undefined);
  } finally {
    rmSync(root, { recursive: true });
  }
});

void test("assertHandsEffect consumes only parent-bound paths and independent rights", () => {
  const request: Extract<HandsRequest, { kind: "tool" }> = {
    kind: "tool",
    name: "edit",
    callId: "edit",
    arguments: { path: "a" },
    grants: [{ root: "/workspace", read: true, write: true }],
  };
  assertHandsEffect(request, "/workspace", { effect: 1, right: "write", path: "/workspace/a" });
  expectDeniedEffect(request, { effect: 2, right: "write", path: "/workspace/b" });
  expectDeniedEffect(
    { ...request, name: "read" },
    { effect: 3, right: "write", path: "/workspace/a" },
  );
  assertHandsEffect({ kind: "resources" }, "/workspace", {
    effect: 1,
    right: "resources",
    path: "",
  });
  expectDeniedEffect(
    { kind: "resources" },
    { effect: 2, right: "resources", path: "/proc/self/fd/0" },
  );
});

await test("physical private captures refuse same-UID effects and disappear from public scratch listing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sept-hands-epoch-"));
  const path = join(directory, "captured");
  writeFileSync(path, "PRIVATE-CAPTURE-CANARY");
  const files = new HandsFiles([{ root: tmpdir(), read: true, write: true }], allow);
  try {
    assert.equal(privateHandsPath(path), true);
    await assert.rejects(files.read(path));
    await assert.rejects(files.write(path, "MUTATED"));
    await assert.rejects(files.stat(path));
    assert.equal(
      (await files.entries(tmpdir(), 16384)).includes(directory.slice(tmpdir().length + 1)),
      false,
    );
    assert.equal(readFileSync(path, "utf8"), "PRIVATE-CAPTURE-CANARY");
    await assert.rejects(files.read(join(tmpdir(), "missing-parent/child")), HandsPathMissingError);
  } finally {
    files.close();
    rmSync(directory, { recursive: true });
  }
});

function expectDeniedEffect(
  request: HandsRequest,
  effect: Extract<HandsFrame, { kind: "effect-check" }>["payload"],
): void {
  assert.throws(() => {
    assertHandsEffect(request, "/workspace", effect);
  });
}
void test("readHandsDirectory preserves the caller descriptor and enforces its entry bound", () => {
  const directory = mkdtempSync(join(tmpdir(), "sept-listing-bound-"));
  writeFileSync(join(directory, "one"), "1");
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    assert.deepEqual(readHandsDirectory(descriptor, 1), ["one"]);
    writeFileSync(join(directory, "two"), "2");
    assert.throws(() => readHandsDirectory(descriptor, 1));
  } finally {
    closeSync(descriptor);
  }
});

void test("assertSourceTree and beneath preserve RO preflight while refusing escaped aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "sept-profile-sources-"));
  writeFileSync(join(root, "data"), "data");
  assert.equal(beneath(join(root, "data"), root), true);
  assert.equal(beneath(join(root, "..", "other"), root), false);
  assertSourceTree(root);
  symlinkSync("/proc", join(root, "escape"));
  assert.throws(() => {
    assertSourceTree(root);
  });
});

await test("validateHandsFind refuses hostile ancestor .git aliases before native existence lookup", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-find-ancestors-"));
  const files = new HandsFiles([{ root, read: true, write: false }], allow);
  const request: Extract<HandsRequest, { kind: "tool" }> = {
    kind: "tool",
    name: "find",
    callId: "find",
    arguments: { path: "." },
    grants: [{ root, read: true, write: false }],
  };
  try {
    await validateHandsFind(request, root, files);
    symlinkSync("/proc/self/fd/0", join(root, ".git"));
    await assert.rejects(validateHandsFind(request, root, files));
    assert.equal(handsPathMissing(new HandsPathMissingError("absent")), true);
    assert.equal(handsPathMissing(new SeptError("denied")), false);
  } finally {
    files.close();
  }
});
