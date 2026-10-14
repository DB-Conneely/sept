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
import { CapabilityRequestAuthority } from "../../src/execution/capability-requests.js";
import { openingPolicy } from "../../src/execution/capability-admission.js";
import { HandsFiles } from "../../src/execution/hands-files.js";
import {
  handsExecution,
  qualifyKernelProfile,
  validateDockerConfiguration,
  revokeDockerBinding,
  reconcileDockerBinding,
} from "../../src/execution/docker-control.js";
import {
  runPermissions,
  initializeCapabilities,
  assertCapabilityAdmission,
  capabilityHostFactory,
  assertCapabilityExpansion,
} from "../../src/cli/permissions.js";
import { validateSealedInputs } from "../../src/execution/hands-processes.js";
import { suppliedEngine } from "./backend-support.js";
import { fixtureDirectories, fixtureStore } from "./support.js";

void test("local operator show and installed admission keep missing policy dormant", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-policy-control-"));
  const store = await initializeCapabilities({}, root);
  assert.equal(store.read(), undefined);
  writeFileSync(join(root, "prior-runtime.json"), "{}");
  assert.equal((await initializeCapabilities({}, root)).read(), undefined);
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
    dataDomain: "private" as const,
    workspaceLimits: { bytes: 134217728, inodes: 32768 },
    engineSocket: "/run/docker.sock",
    containerId: "a".repeat(64),
    generation: "generation",
    workspace,
    resources,
    shell: false,
    readOnlyMounts: [],
  };
  const first = capabilityBinding(configuration);
  assertBindingDomain(configuration, first.fingerprint);
  renameSync(workspace, `${workspace}-preserved`);
  mkdirSync(workspace);
  assert.notEqual(capabilityBinding(configuration).fingerprint, first.fingerprint);
  assert.throws(
    () => capabilityBinding({ ...configuration, workspace: join(root, "missing") }),
    /binding is unavailable/,
  );
  const store = new CapabilityPolicyStore(join(root, "runs"));
  assert.throws(() => openingPolicy(configuration, store), SeptError);
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
        dataDomain: "private",
        workspaceLimits: { bytes: 134217728, inodes: 32768 },
        engineSocket: "/run/docker.sock",
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
    dataDomain: "private" as const,
    workspaceLimits: { bytes: 134217728, inodes: 32768 },
    engineSocket: "/run/docker.sock",
    containerId: "a".repeat(64),
    generation: "generation",
    workspace: "/missing",
    resources: "/missing",
    shell: false,
    readOnlyMounts: [],
  };
  const arguments_ = handsExecution("/workspace", "", { network: false }).command;
  assert.ok(arguments_.includes("PI_OFFLINE=1"));
  assert.ok(arguments_.includes("--disable-sigusr1"));
  assert.equal(
    arguments_.some((entry) => entry.includes("TOKEN")),
    false,
  );
  await assert.rejects(validateDockerConfiguration(configuration, ["/missing"]), SeptError);
  await assert.rejects(revokeDockerBinding(configuration, configuration), SeptError);
  await assert.rejects(reconcileDockerBinding(configuration, configuration), SeptError);
});

void test("network expansion requires a fresh generation even when file and execute rights are unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-network-expansion-"));
  const binding = { containerId: "a".repeat(64), generation: "same", fingerprint: "b".repeat(64) };
  const policy = {
    ...defaultCapabilities(),
    version: 1 as const,
    revision: 1,
    denied: false,
    binding,
  };
  await assert.rejects(
    assertCapabilityExpansion(policy, { ...policy, network: true }, false, root, binding, {
      profile: "docker-linux-v1",
      dataDomain: "private",
      workspaceLimits: { bytes: 134217728, inodes: 32768 },
      engineSocket: "/run/docker.sock",
      ...binding,
      workspace: root,
      resources: root,
      shell: false,
      readOnlyMounts: [],
    }),
    /fresh validated backend generation/,
  );
});

void test("a durable network grant cannot open an ungrantable supplied namespace", async () => {
  const directories = fixtureDirectories("sept-network-stored-rights-");
  const store = fixtureStore(directories, "fixture", "deny unsupported stored rights");
  const configuration = {
    profile: "docker-linux-v1" as const,
    dataDomain: "private" as const,
    workspaceLimits: { bytes: 134217728, inodes: 32768 },
    engineSocket: "/run/docker.sock",
    containerId: "a".repeat(64),
    generation: "fresh",
    workspace: directories.workspace,
    resources: directories.workspace,
    shell: false,
    readOnlyMounts: [],
  };
  const policyStore = new CapabilityPolicyStore(join(directories.root, "policy"));
  policyStore.initialize(
    { ...defaultCapabilities(), network: true },
    capabilityBinding(configuration),
  );
  await assert.rejects(
    DockerExecutionBackend.create(
      configuration,
      store,
      [directories.agentDir, join(directories.root, "runs")],
      policyStore,
    ),
    /supplied enforced network namespace/,
  );
});

void test("CapabilityRequestAuthority pre-intent default does not create a pending request for an allowed write", () => {
  const directories = fixtureDirectories("sept-request-authority-");
  const store = fixtureStore(directories, "fixture", "bounded request authority");
  const configuration = {
    profile: "docker-linux-v1" as const,
    dataDomain: "private" as const,
    workspaceLimits: { bytes: 134217728, inodes: 32768 },
    engineSocket: "/run/docker.sock",
    containerId: "a".repeat(64),
    generation: "fresh",
    workspace: directories.workspace,
    resources: directories.workspace,
    shell: false,
    readOnlyMounts: [],
  };
  const policyStore = new CapabilityPolicyStore(join(directories.root, "policy"));
  policyStore.initialize(defaultCapabilities(), capabilityBinding(configuration));
  const policy = openingPolicy(configuration, policyStore);
  const authority = new CapabilityRequestAuthority(
    configuration,
    "/workspace",
    store,
    policyStore,
    policy,
    () => policy,
  );
  assert.equal(
    authority.beforeTool({
      kind: "tool",
      name: "write",
      callId: "allowed",
      taskKey: "c".repeat(64),
      arguments: { path: "allowed.txt", content: "bounded" },
    }),
    undefined,
  );
  assert.equal(authority.pendingPermission(), undefined);
});

void test("kernel qualification fails closed and mutable individual files need no sealed discovery", async () => {
  const fixture = await suppliedEngine();
  const engine = await import("../../src/execution/docker-engine.js").then(
    ({ DockerEngineControl }) => DockerEngineControl.open(fixture.path),
  );
  const configuration = {
    profile: "docker-linux-v1" as const,
    dataDomain: "mutable-file-bind" as const,
    engineSocket: fixture.path,
    containerId: "a".repeat(64),
    generation: "original",
    workspace: fixture.root,
    resources: fixture.root,
    shell: false,
    readOnlyMounts: [],
  };
  try {
    await validateSealedInputs(configuration, engine);
    await assert.rejects(qualifyKernelProfile(configuration, {}, engine), SeptError);
  } finally {
    await engine.close();
    await fixture.close();
  }
});

function assertBindingDomain(
  configuration: Parameters<typeof capabilityBinding>[0],
  fingerprint: string,
): void {
  assert.notEqual(
    capabilityBinding({ ...configuration, workspaceLimits: { bytes: 268435456, inodes: 32768 } })
      .fingerprint,
    fingerprint,
  );
  assert.notEqual(
    capabilityBinding({ ...configuration, dataDomain: "mutable-file-bind" }).fingerprint,
    fingerprint,
  );
}
