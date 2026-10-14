/** Operator registration and exact native effect identities supplement installed child/kernel proof. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  CapabilityPolicyStore,
  CapabilityRequestStore,
  capabilityArguments,
  SeptError,
} from "../../src/durable/index.js";
import { BackendExecutionEnv, type HandsRequest } from "../../src/execution/index.js";
import {
  parseCustomHand,
  handsProjectionReceipt,
} from "../../src/execution/profile-configuration.js";
import { admitApprovedCapabilityRequest } from "../../src/execution/capability-admission.js";
import { executeCustomHand } from "../../src/execution/custom-hand.js";
import {
  permissionToolGate,
  bindNativeToolEnvironment,
} from "../../src/pi-integration/durable-tools.js";
import {
  createCustomHandTools,
  customPermissionGate,
} from "../../src/pi-integration/custom-tool.js";
import { CliError } from "../../src/cli/errors.js";
import {
  permissionDecision,
  resumePermissionRun,
  assertLocalRunSlot,
} from "../../src/cli/permission-decisions.js";
import { assertCapabilityExpansion } from "../../src/cli/permissions.js";
import { DockerEngineControl } from "../../src/execution/docker-engine.js";
import { recordNamespaceLifetime } from "../../src/execution/profile-configuration.js";
import { recordHandsBinding } from "../../src/execution/docker-control.js";
import { wakeRunForOperator } from "../../src/runtime/index.js";
import { reconcilePermissionWait } from "../../src/runtime/worker-recovery.js";
import { checkpointPermissionWait } from "../../src/pi-integration/durable-admission.js";
import { FixtureExecutionBackend, recordFixtureKernel } from "./backend-support.js";
import { fixtureDirectories, fixtureStore } from "./support.js";
void test("single operator custom registration cannot select RW/brain paths or omit explicit replay", () => {
  const mounts = [{ source: "/private/operator-code", destination: "/selected/hand" }];
  const valid = { path: "/selected/hand/hand.mjs", sha256: "a".repeat(64), replay: "safe" };
  assert.equal(parseCustomHand(valid, mounts, true).path, valid.path);
  assert.match(handsProjectionReceipt("/resources", "/private"), /receipt.json$/);
  assert.throws(() => parseCustomHand(valid, mounts, false), SeptError);
  assert.throws(
    () => parseCustomHand({ ...valid, path: "/selected/hand/../brain" }, mounts, true),
    SeptError,
  );
  assert.throws(() => parseCustomHand({ ...valid, replay: "automatic" }, mounts, true), SeptError);
  assert.throws(() => parseCustomHand({ ...valid, policy: "full" }, mounts, true), SeptError);
});
void test("native environment identities retain task/call plus exact effect content across replay", async () => {
  const directories = fixtureDirectories("sept-native-effect-id-");
  const backend = new FixtureExecutionBackend(directories.workspace);
  const requests: HandsRequest[] = [];
  backend.invoke = (request) => {
    requests.push(request);
    return Promise.resolve({ ok: true, value: "bounded" });
  };
  const env = new BackendExecutionEnv(backend, () => undefined, "native-2-13-call");
  await env.readTextFile("first", BACKGROUND_CONTEXT);
  await env.readTextFile("first", BACKGROUND_CONTEXT);
  await new BackendExecutionEnv(backend, () => undefined, "native-2-13-call").readTextFile(
    "first",
    BACKGROUND_CONTEXT,
  );
  assert.equal(requests[0]?.kind, "file");
  assert.notDeepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[0], requests[2]);
  assert.equal(
    await permissionToolGate(backend, {
      type: "toolCall",
      id: "x",
      name: "trusted",
      arguments: {},
    }),
    undefined,
  );
  assert.equal(
    bindNativeToolEnvironment({ name: "trusted" }, backend, () => undefined).name,
    "trusted",
  );
});
function authorityFixture() {
  const directories = fixtureDirectories("sept-custom-bound-");
  const store = fixtureStore(directories, "fixture", "bounded");
  const root = join(directories.root, "policy");
  mkdirSync(root);
  const configuration = {
    profile: "docker-linux-warm-v1" as const,
    dataDomain: "private" as const,
    workspaceLimits: { bytes: 134217728, inodes: 32768 },
    engineSocket: "/run/docker.sock",
    containerId: "a".repeat(64),
    generation: "source",
    workspace: directories.workspace,
    resources: directories.workspace,
    shell: false,
    readOnlyMounts: [],
  };
  const policyStore = new CapabilityPolicyStore(root);
  const policy = {
    version: 1 as const,
    revision: 1,
    denied: false,
    binding: {
      containerId: configuration.containerId,
      generation: configuration.generation,
      fingerprint: "b".repeat(64),
    },
    mode: "scoped" as const,
    workspace: { read: true, write: true },
    selected: [],
    execute: false,
    network: false,
  };
  policyStore.initialize(policy, policy.binding);
  return { directories, store, root, configuration, policyStore, policy };
}
void test("operator inspection is inert and approved effect composition refuses unsupported commands", async () => {
  const { directories, root, configuration, policyStore, policy } = authorityFixture();
  assert.throws(
    () =>
      admitApprovedCapabilityRequest(
        policy,
        { kind: "tool", name: "bash", callId: "x", arguments: { command: "true" } },
        "/workspace",
        configuration,
      ),
    SeptError,
  );

  assert.deepEqual(
    await permissionDecision(
      { command: "permissions", action: "requests", options: {} },
      root,
      directories.agentDir,
      policyStore,
      policy,
    ),
    [],
  );
  await assert.rejects(
    assertCapabilityExpansion(
      policy,
      { ...policy, execute: true },
      true,
      root,
      policy.binding,
      configuration,
    ),
    SeptError,
  );
});
void test("custom effect composition refuses an absent registered program", async () => {
  await assert.rejects(
    executeCustomHand(
      { kind: "custom", callId: "x", arguments: { text: "bounded" } },
      undefined,
      "/workspace",
      undefined,
    ),
    SeptError,
  );
});
void test("durable binding and shared explicit wake retain counters and closed input", async () => {
  const { store, configuration } = authorityFixture();
  assert.throws(() => {
    assertLocalRunSlot(join(store.runDir, ".."));
  }, SeptError);
  assertLocalRunSlot(join(store.runDir, ".."), store.runId);
  const engine = await DockerEngineControl.open(configuration.engineSocket);
  try {
    recordFixtureKernel(configuration, join(store.runDir, "..", "capability-policy.json"));
    // Supporting metadata fixture has no live namespace; installed tests capture real kernel facts.
    recordNamespaceLifetime(
      configuration,
      engine,
      join(store.runDir, "..", "capability-policy.json"),
      { pidNamespace: "pid:[42]", initStart: "123" },
    );
    await recordHandsBinding(store, configuration, "/workspace", engine);
    await assert.rejects(
      recordHandsBinding(store, configuration, "/workspace", engine),
      /fresh namespace/,
    );
  } finally {
    await engine.close();
  }
  await reconcilePermissionWait(store);
  checkpointPermissionWait(store);
  store.update({
    status: "waiting",
    phase: "waiting",
    permissionRequestId: "a".repeat(64),
    invocations: 3,
    activeMilliseconds: 17,
  });
  const message = store.enqueueMessage("Exact accepted retry text");
  wakeRunForOperator(store, message.id);
  assert.equal(store.snapshot().permissionRequestId, undefined);
  assert.equal(store.snapshot().invocations, 3);
  assert.equal(store.snapshot().activeMilliseconds, 17);
  assert.equal(store.snapshot().status, "active");
});

void test("direct resume cannot reset models, limits or create input for an invalid identity", async () => {
  await assert.rejects(
    () =>
      resumePermissionRun(
        { command: "run", options: { resume: "../escape", message: "retry" } },
        "/tmp",
        "/tmp/agent",
      ),
    CliError,
  );
  await assert.rejects(
    () =>
      resumePermissionRun(
        { command: "run", options: { resume: "run", message: "retry", timeout: "999" } },
        "/tmp",
        "/tmp/agent",
      ),
    CliError,
  );
});

void test("custom native registration requires original task identity", async () => {
  const { directories } = authorityFixture();
  const emptyBackend = new FixtureExecutionBackend(directories.workspace);
  assert.deepEqual(
    createCustomHandTools(emptyBackend, () => undefined),
    [],
  );
  await assert.rejects(
    customPermissionGate(
      emptyBackend,
      { type: "toolCall", id: "x", name: "custom_hand", arguments: { text: "bounded" } },
      undefined,
      BACKGROUND_CONTEXT,
    ),
    /native task identity/,
  );
});

void test("custom schema includes explicit optional network intent while keeping the bounded registered body", () => {
  const directories = fixtureDirectories("sept-custom-network-schema-");
  const backend = Object.assign(new FixtureExecutionBackend(directories.workspace), {
    customHand: {
      path: "/selected/hand/hand.mjs",
      sha256: "a".repeat(64),
      replay: "unsafe" as const,
    },
  });
  assert.match(
    JSON.stringify(createCustomHandTools(backend, () => undefined)[0]?.parameters),
    /Explicit network intent/,
  );
});

void test("pending permission restart refuses an old Engine receipt without changing denial or native state", async () => {
  const { store, configuration, policy } = authorityFixture();
  const requests = new CapabilityRequestStore(dirname(store.runDir));
  const pending = requests.create({
    runId: store.runId,
    invocation: 1,
    callId: "denied-native-task",
    operation: "write",
    arguments: capabilityArguments({ path: "inert.txt", content: "ORIGINAL_DENIED_CONTENT" }),
    revision: policy.revision,
    binding: policy.binding,
  });
  store.update({ invocations: 1, permissionRequestId: pending.id, status: "active" });
  const bindingPath = join(store.runDir, "hands-binding.json");
  writeFileSync(
    bindingPath,
    JSON.stringify({
      profile: configuration.profile,
      containerId: configuration.containerId,
      generation: configuration.generation,
      cwd: "/workspace",
      runId: store.runId,
    }),
  );
  const preserved = [store.snapshotPath, requests.path, bindingPath].map((path) =>
    readFileSync(path),
  );
  await assert.rejects(reconcilePermissionWait(store), /receipt is absent or incompatible/);
  assert.deepEqual(
    [store.snapshotPath, requests.path, bindingPath].map((path) => readFileSync(path)),
    preserved,
  );
  assert.equal(requests.read()[0]?.decision, undefined);
  assert.equal(store.snapshot().status, "active");
});
