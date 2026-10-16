/** Warm adoption refuses incompatible configuration before durable/native mutation; old records remain readable. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CapabilityPolicyStore,
  CapabilityRequestStore,
  capabilityArguments,
} from "../../src/durable/index.js";
import {
  capabilityBinding,
  defaultCapabilities,
  loadHandsConfiguration,
} from "../../src/execution/index.js";
import { DockerEngineControl } from "../../src/execution/docker-engine.js";
import { assertHandsRunProfile, recordHandsBinding } from "../../src/execution/docker-control.js";
import { runPermissions } from "../../src/cli/permissions.js";
import { assertCapabilityAdmission } from "../../src/worker/index.js";
import { permissionDecision, resumePermissionRun } from "../../src/cli/permission-decisions.js";
import { reconcilePermissionWait } from "../../src/runtime/worker-recovery.js";
import { suppliedEngine } from "./backend-support.js";
import { fixtureDirectories, fixtureStore } from "./support.js";

void test("warm installed admission refuses cold config and stale binding without changing policy", async () => {
  const fixture = await suppliedEngine();
  const configuration = warmConfiguration(fixture);
  const path = join(fixture.root, "hands.json");
  const store = new CapabilityPolicyStore(join(fixture.root, "runs"));
  try {
    store.initialize(defaultCapabilities(), capabilityBinding(configuration));
    writeFileSync(path, JSON.stringify(configuration));
    assert.deepEqual(loadHandsConfiguration(path), configuration);
    assertCapabilityAdmission(store, path);
    const original = readFileSync(store.path);
    writeFileSync(path, JSON.stringify({ ...configuration, profile: "docker-linux-v1" }));
    assert.throws(() => {
      assertCapabilityAdmission(store, path);
    }, /profile configuration is unavailable or incompatible/);
    await assert.rejects(
      runPermissions(
        { command: "permissions", action: "revoke", options: { hands: path, revision: "1" } },
        join(fixture.root, "runs"),
        fixture.root,
      ),
      /profile is unsupported/,
    );
    assert.deepEqual(readFileSync(store.path), original);
    writeFileSync(path, JSON.stringify({ ...configuration, generation: "replacement" }));
    assert.throws(() => {
      assertCapabilityAdmission(store, path);
    }, /operator activation/);
    assert.deepEqual(readFileSync(store.path), original);
  } finally {
    await fixture.close();
  }
});

function warmConfiguration(fixture: Awaited<ReturnType<typeof suppliedEngine>>) {
  const workspace = join(fixture.root, "workspace");
  const resources = join(fixture.root, "resources");
  mkdirSync(workspace);
  mkdirSync(resources);
  const configuration = {
    profile: "docker-linux-warm-v1" as const,
    dataDomain: "private" as const,
    workspaceLimits: { bytes: 134217728, inodes: 32768 },
    engineSocket: fixture.path,
    containerId: "a".repeat(64),
    generation: "original",
    workspace,
    resources,
    shell: false,
    readOnlyMounts: [],
  };
  const path = join(fixture.root, "hands.json");
  writeFileSync(path, JSON.stringify(configuration));
  return loadHandsConfiguration(path);
}

void test("cold run binding remains readable and is never reconciled or replaced by warm adoption", async () => {
  const fixture = await suppliedEngine();
  const configuration = warmConfiguration(fixture);
  const directories = fixtureDirectories("sept-warm-binding-");
  const store = fixtureStore(directories, "fixture", "retain cold history");
  const path = join(store.runDir, "hands-binding.json");
  const original = JSON.stringify({
    profile: "docker-linux-v1",
    containerId: configuration.containerId,
    generation: configuration.generation,
  });
  writeFileSync(path, original);
  const engine = await DockerEngineControl.open(fixture.path);
  try {
    assert.throws(() => {
      assertHandsRunProfile(store);
    }, /profile/);
    await assert.rejects(recordHandsBinding(store, configuration, "/workspace", engine), /profile/);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(fixture.facts.stops, 0);
    assert.equal(fixture.facts.execStarts, 0);
  } finally {
    await engine.close();
    await fixture.close();
  }
});

void test("cold pending recovery, operator decisions and explicit retry preserve original native/request bytes", async () => {
  const fixture = await suppliedEngine();
  try {
    const { store, root, agentDir, path, policy, current, request, paths } =
      coldPendingFixture(fixture);
    const before = paths.map((file) => readFileSync(file));
    await assertColdPendingBoundaries(store, root, agentDir, path, policy, current, request);
    assert.deepEqual(
      paths.map((file) => readFileSync(file)),
      before,
    );
    assert.deepEqual(store.pendingMessages(), []);
    assert.equal(fixture.facts.stops, 0);
    assert.equal(fixture.facts.execStarts, 0);
  } finally {
    await fixture.close();
  }
});

async function assertColdPendingBoundaries(
  store: ReturnType<typeof fixtureStore>,
  root: string,
  agentDir: string,
  hands: string,
  policy: CapabilityPolicyStore,
  current: NonNullable<ReturnType<CapabilityPolicyStore["read"]>>,
  request: ReturnType<CapabilityRequestStore["create"]>,
): Promise<void> {
  await assert.rejects(reconcilePermissionWait(store), /profile/);
  await assert.rejects(
    resumePermissionRun(
      { command: "run", options: { resume: store.runId, message: "new retry", hands } },
      root,
      agentDir,
    ),
    /profile/,
  );
  for (const action of ["approve", "deny"]) {
    await assert.rejects(
      permissionDecision(
        {
          command: "permissions",
          action,
          options: {
            request: request.id,
            digest: request.digest,
            revision: String(current.revision),
            hands,
          },
        },
        root,
        agentDir,
        policy,
        current,
      ),
      /profile/,
    );
  }
}

function coldPendingFixture(fixture: Awaited<ReturnType<typeof suppliedEngine>>) {
  const configuration = warmConfiguration(fixture);
  const directories = fixtureDirectories("sept-warm-pending-");
  const store = fixtureStore(directories, "fixture", "retain denied task");
  const root = join(store.runDir, "..");
  const policy = new CapabilityPolicyStore(root);
  policy.initialize(defaultCapabilities(), capabilityBinding(configuration));
  const current = policy.read();
  assert.ok(current);
  const requests = new CapabilityRequestStore(root);
  const request = requests.create({
    runId: store.runId,
    invocation: 1,
    callId: "original-denied",
    operation: "write",
    arguments: capabilityArguments({ path: "artifact.txt", content: "inert" }),
    revision: current.revision,
    binding: current.binding,
  });
  store.update({ status: "waiting", phase: "waiting", permissionRequestId: request.id });
  writeFileSync(join(store.runDir, "hands-binding.json"), '{"profile":"docker-linux-v1"}');
  writeFileSync(join(store.runDir, "pi-durable-admission.json"), "NATIVE-BYTES-PRESERVED");
  const path = join(fixture.root, "hands.json");
  writeFileSync(path, JSON.stringify(configuration));
  const paths = [
    policy.path,
    requests.path,
    store.snapshotPath,
    join(store.runDir, "pi-durable-admission.json"),
  ];
  return { store, root, agentDir: directories.agentDir, path, policy, current, request, paths };
}
