/** Checks the supplied port and bounded profile contract; installed Docker proof supplies isolation facts. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SeptError, RunStore } from "../../src/durable/index.js";
import {
  HandsBackendUnavailableError,
  BackendExecutionEnv,
  loadHandsConfiguration,
  validateDockerProfile,
  parseHandsToolResult,
  parseHandsResources,
  type ExecutionBackend,
  type HandsRequest,
} from "../../src/execution/index.js";
import {
  HANDS_REQUEST_BYTES,
  handsRecord,
  parseHandsRequest,
} from "../../src/execution/protocol.js";
import { executeHandsRequest } from "../../src/execution/hands-entry.js";
import { createDurableCodingTools } from "../../src/pi-integration/durable-tools.js";
import { publicTaskProjection, publicRunEvent } from "../../src/ingress/index.js";
import { FixtureExecutionBackend } from "./backend-support.js";
import { profileFixture } from "./capability-profile-support.js";
import { fixtureDirectories, fixtureStore } from "./support.js";

void test("hands protocol keeps Pi text/image parity and refuses malformed or oversized content", () => {
  assert.deepEqual(parseHandsRequest({ kind: "resources" }), { kind: "resources" });
  assert.equal(
    parseHandsRequest({ kind: "tool", name: "grep", callId: "call", arguments: { pattern: "x" } })
      .kind,
    "tool",
  );
  assert.throws(() => parseHandsRequest({ kind: "file", method: "exec" }), SeptError);
  assert.throws(() => handsRecord([]), SeptError);
  assert.ok(new HandsBackendUnavailableError("bounded loss") instanceof SeptError);
});

void test("hands result content preserves native text/image semantics", () => {
  const result = {
    content: [
      { type: "text", text: "native footer" },
      { type: "image", data: "encoded", mimeType: "image/png" },
    ],
  };
  assert.deepEqual(parseHandsToolResult(result), result);
  assert.throws(
    () =>
      parseHandsToolResult({
        content: [{ type: "image", data: "x", mimeType: "application/json" }],
      }),
    SeptError,
  );
});

void test("hands resource codec checks the exact capacity boundary", () => {
  assert.equal(
    parseHandsResources({
      system: "x".repeat(HANDS_REQUEST_BYTES),
      append: "",
      instructions: "",
      skills: "",
    }).system.length,
    HANDS_REQUEST_BYTES,
  );
  assert.throws(
    () =>
      parseHandsResources({
        system: "x".repeat(HANDS_REQUEST_BYTES + 1),
        append: "",
        instructions: "",
        skills: "",
      }),
    SeptError,
  );
});

const INVALID_HOST_PROFILES = [
  { NetworkMode: "host" },
  { IpcMode: "host" },
  { UsernsMode: "host" },
  { CapAdd: ["SYS_ADMIN"] },
  { SecurityOpt: ["no-new-privileges", "seccomp=unconfined"] },
  { Tmpfs: { "/tmp": "rw,size=9999999999" } },
  { Devices: [{ PathOnHost: "/dev/x" }] },
];

void test("RO source provenance accepts 4096 entries and refuses the next before dispatch", () => {
  const { configuration, inspected, brain } = profileFixture();
  for (let index = 0; index < 4096; index += 1) {
    writeFileSync(join(configuration.resources, `file-${String(index)}`), "bounded");
  }
  assert.equal(
    validateDockerProfile(configuration, inspected, configuration.workspace, [brain]),
    "/workspace",
  );
  writeFileSync(join(configuration.resources, "overflow"), "PRESERVE");
  assert.throws(
    () => validateDockerProfile(configuration, inspected, configuration.workspace, [brain]),
    /discovery exceeds its bound/,
  );
  assert.equal(readFileSync(join(configuration.resources, "overflow"), "utf8"), "PRESERVE");
});

void test("live profile qualification retains mount identity without rediscovering mutable resource descendants", () => {
  const { configuration, inspected, brain } = profileFixture();
  validateDockerProfile(configuration, inspected, configuration.workspace, [brain]);
  for (let index = 0; index < 4097; index += 1) {
    writeFileSync(join(configuration.resources, `epoch-${String(index)}`), "bounded");
  }
  assert.equal(
    validateDockerProfile(configuration, inspected, configuration.workspace, [brain], {
      qualification: "live",
    }),
    "/workspace",
  );
  assert.throws(
    () => validateDockerProfile(configuration, inspected, configuration.workspace, [brain]),
    /discovery exceeds its bound/,
  );
  assert.throws(
    () =>
      validateDockerProfile(
        configuration,
        { ...inspected, Mounts: [] },
        configuration.workspace,
        [brain],
        {
          qualification: "live",
        },
      ),
    SeptError,
  );
});

void test("profile validates exact kernel namespace/mount provenance and rejects weaker configurations", () => {
  const { configuration, inspected, brain } = profileFixture();
  assert.equal(
    validateDockerProfile(configuration, inspected, configuration.workspace, [brain]),
    "/workspace",
  );
  for (const mutation of INVALID_HOST_PROFILES) {
    assert.throws(
      () =>
        validateDockerProfile(
          configuration,
          { ...inspected, HostConfig: { ...handsRecord(inspected.HostConfig), ...mutation } },
          configuration.workspace,
          [brain],
        ),
      SeptError,
    );
  }
  assert.throws(
    () =>
      validateDockerProfile(configuration, inspected, configuration.workspace, [
        configuration.workspace,
      ]),
    /private brain/,
  );
  assert.throws(
    () =>
      validateDockerProfile(configuration, { ...inspected, Mounts: [] }, configuration.workspace, [
        brain,
      ]),
    /unexpected mounts/,
  );
  const path = join(brain, "hands.json");
  writeFileSync(path, JSON.stringify(configuration));
  assert.deepEqual(loadHandsConfiguration(path), configuration);
  assert.throws(() => loadHandsConfiguration(undefined), /configuration is required/);
});

void test("native environment routes required reads/writes and typed-refuses all unsupported operations", async () => {
  const requests: HandsRequest[] = [];
  const backend: ExecutionBackend = {
    id: "bound",
    generation: "generation",
    cwd: "/workspace",
    shell: false,
    resourceProjectionDirectory: "/private-projection",
    resourceProjectionReceipt: "/private-receipt",
    invoke(request) {
      requests.push(request);
      return Promise.resolve(
        request.kind === "file" && request.method === "readTextFile"
          ? { ok: true, value: "hands text" }
          : { ok: true },
      );
    },
    close() {
      return Promise.resolve();
    },
  };
  const env = new BackendExecutionEnv(backend);
  assert.deepEqual(await env.readTextFile("a", BACKGROUND_CONTEXT), {
    ok: true,
    value: "hands text",
  });
  assert.equal((await env.writeFile("a", "text", BACKGROUND_CONTEXT)).ok, true);
  assert.equal(requests.length, 2);
  await env.cleanup(BACKGROUND_CONTEXT);
  assert.equal(
    createDurableCodingTools(backend).tools?.some((tool) => tool.name === "bash"),
    false,
  );
});

void test("unsupported native methods refuse without reaching the supplied effect owner", async () => {
  const requests: HandsRequest[] = [];
  const backend: ExecutionBackend = {
    id: "bound",
    generation: "generation",
    cwd: "/workspace",
    shell: false,
    resourceProjectionDirectory: "/private-projection",
    resourceProjectionReceipt: "/private-receipt",
    invoke(request) {
      requests.push(request);
      return Promise.resolve(
        request.kind === "file" && request.method === "readTextFile"
          ? { ok: true, value: "hands text" }
          : { ok: true },
      );
    },
    close() {
      return Promise.resolve();
    },
  };
  const env = new BackendExecutionEnv(backend);
  assert.equal((await env.readBinaryFile("a", BACKGROUND_CONTEXT)).ok, false);
  assert.equal((await env.exec("env", undefined, BACKGROUND_CONTEXT)).ok, false);
  assert.equal(requests.length, 0);
  assert.deepEqual(await env.absolutePath("a", BACKGROUND_CONTEXT), {
    ok: true,
    value: "/workspace/a",
  });
  assert.deepEqual(await env.joinPath(["/workspace", "a"], BACKGROUND_CONTEXT), {
    ok: true,
    value: "/workspace/a",
  });
});

await test("hands entry uses handsReadOptions, executeHandsFile and the existing Pi write body", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sept-hands-body-"));
  const written = await executeHandsRequest(
    {
      kind: "tool",
      name: "write",
      callId: "body",
      arguments: { path: "artifact.txt", content: "native body" },
      grants: [{ root: directory, read: true, write: true }],
    },
    directory,
    () => Promise.resolve(),
  );
  assert.match(JSON.stringify(parseHandsToolResult(written)), /Successfully wrote/);
  assert.equal(readFileSync(join(directory, "artifact.txt"), "utf8"), "native body");
  assert.deepEqual(
    await executeHandsRequest(
      {
        kind: "file",
        method: "readTextFile",
        path: "artifact.txt",
        grants: [{ root: directory, read: true, write: true }],
      },
      directory,
      () => Promise.resolve(),
    ),
    { ok: true, value: "native body" },
  );
});

void test("public task/event projection hides private host roots without changing recovery state", () => {
  const directories = fixtureDirectories("sept-hands-public-");
  const store: RunStore = fixtureStore(directories, "fixture", "private paths");
  const backend = new FixtureExecutionBackend(directories.workspace);
  store.update({ activeSessionFile: join(store.runDir, "pi-sessions/1.durable.json") });
  const projection = publicTaskProjection(store);
  assert.equal(projection.manifest.workspace, "/workspace");
  assert.doesNotMatch(JSON.stringify(projection), new RegExp(directories.root));
  assert.equal(store.manifest().workspace, directories.workspace);
  const event = store.event("pi_session_started", {
    sessionFile: join(store.runDir, "pi-sessions/1.durable.json"),
  });
  assert.doesNotMatch(JSON.stringify(publicRunEvent(event)), new RegExp(directories.root));
  assert.equal(backend.cwd, directories.workspace);
});
