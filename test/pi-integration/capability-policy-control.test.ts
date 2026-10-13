/** Focused composition contracts supplement installed operator/worker kernel acceptance. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CapabilityPolicyStore, SeptError } from "../../src/durable/index.js";
import {
  capabilityBinding,
  defaultCapabilities,
  DockerExecutionBackend,
} from "../../src/execution/index.js";
import { HandsFiles } from "../../src/execution/hands-files.js";
import {
  dockerArguments,
  runDocker,
  validateDockerConfiguration,
  revokeDockerBinding,
  reconcileDockerBinding,
} from "../../src/execution/docker-control.js";
import {
  runPermissions,
  initializeCapabilities,
  assertCapabilityAdmission,
  capabilityHostFactory,
} from "../../src/cli/permissions.js";
import { fixtureDirectories, fixtureStore } from "./support.js";

void test("local operator show and installed admission keep missing policy dormant", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-policy-control-"));
  const store = initializeCapabilities({}, root);
  assert.equal(store.read(), undefined);
  writeFileSync(join(root, "prior-runtime.json"), "{}");
  assert.equal(initializeCapabilities({}, root).read(), undefined);
  assert.throws(() => {
    assertCapabilityAdmission(store);
  }, SeptError);
  const result = await runPermissions(
    { command: "permissions", action: "show", options: {} },
    root,
    root,
  );
  assert.deepEqual(result, {
    version: 1,
    revision: 0,
    denied: true,
    reason: "operator configuration required",
  });
});
void test("supplied root replacement changes capability binding before effects", () => {
  const root = mkdtempSync(join(tmpdir(), "sept-policy-binding-"));
  const workspace = join(root, "workspace");
  const resources = join(root, "resources");
  mkdirSync(workspace);
  mkdirSync(resources);
  const configuration = {
    profile: "docker-linux-v1" as const,
    containerId: "a".repeat(64),
    generation: "generation",
    workspace,
    resources,
    shell: false,
    readOnlyMounts: [],
  };
  const first = capabilityBinding(configuration);
  renameSync(workspace, `${workspace}-preserved`);
  mkdirSync(workspace);
  assert.notEqual(capabilityBinding(configuration).fingerprint, first.fingerprint);
  assert.throws(
    () => capabilityBinding({ ...configuration, workspace: join(root, "missing") }),
    /binding is unavailable/,
  );
  const store = new CapabilityPolicyStore(join(root, "runs"));
  store.initialize(defaultCapabilities(), first);
  assert.equal(JSON.stringify(store.read()?.binding), JSON.stringify(first));
  assertCapabilityAdmission(store);
  store.revoke(1);
  assert.throws(() => {
    assertCapabilityAdmission(store);
  }, SeptError);
});
void test("native host factory and anchored file owner refuse absent authority without ambient effects", async () => {
  const directories = fixtureDirectories("sept-policy-factory-");
  const store = fixtureStore(directories, "fixture", "no effect");
  await assert.rejects(
    DockerExecutionBackend.create(
      {
        profile: "docker-linux-v1",
        containerId: "a".repeat(64),
        generation: "generation",
        workspace: directories.workspace,
        resources: directories.workspace,
        shell: false,
        readOnlyMounts: [],
      },
      store,
      [directories.agentDir, join(directories.root, "runs")],
      new CapabilityPolicyStore(join(directories.root, "runs")),
    ),
    SeptError,
  );
  await assert.rejects(
    capabilityHostFactory(join(directories.root, "runs"), undefined)(
      store.manifest(),
      store,
      directories.agentDir,
      undefined,
    ),
    SeptError,
  );
  assert.throws(
    () => new HandsFiles([{ root: join(directories.root, "missing"), read: true, write: true }]),
    SeptError,
  );
});
void test("Docker control remains bounded and generation-specific with a credential-free hands command", async () => {
  const configuration = {
    profile: "docker-linux-v1" as const,
    containerId: "a".repeat(64),
    generation: "generation",
    workspace: "/missing",
    resources: "/missing",
    shell: false,
    readOnlyMounts: [],
  };
  const arguments_ = dockerArguments(configuration, "/workspace");
  assert.ok(arguments_.includes("-i"));
  assert.ok(arguments_.includes("PI_OFFLINE=1"));
  assert.ok(arguments_.includes("--disable-sigusr1"));
  assert.equal(
    arguments_.some((entry) => entry.includes("TOKEN")),
    false,
  );
  assert.match(
    await runDocker(["version", "--format", "{{.Client.Version}}"], "", 1024),
    /^\d+\.\d+\.\d+/,
  );
  await assert.rejects(validateDockerConfiguration(configuration, ["/missing"]), SeptError);
  await assert.rejects(revokeDockerBinding(configuration), SeptError);
  await assert.rejects(reconcileDockerBinding(configuration, configuration), SeptError);
});
