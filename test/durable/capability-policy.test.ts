/** Real atomic policy files exercise version, bounds, independent rights and persistent denial. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CapabilityPolicyStore,
  CapabilityPolicyDeniedError,
  parseCapabilityConfiguration,
  SeptError,
} from "../../src/durable/index.js";
import {
  defaultCapabilities,
  capabilityGrants,
  capabilityTools,
  admitCapabilityRequest,
  validateCapabilities,
} from "../../src/execution/index.js";
import { configuredText } from "../../src/execution/profile-configuration.js";
import {
  capabilitiesAvailable,
  workerStatus,
  settleWorkerDrain,
  assertCapabilityMessageAdmission,
} from "../../src/runtime/worker-policy.js";

const binding = {
  containerId: "a".repeat(64),
  generation: "generation",
  fingerprint: "b".repeat(64),
};
void test("CapabilityPolicyStore fsyncs monotonic activation and denial and refuses stale revisions/malformed present state", () => {
  const store = new CapabilityPolicyStore(mkdtempSync(join(tmpdir(), "sept-policy-")));
  assert.equal(store.read(), undefined);
  store.initialize(defaultCapabilities(), binding);
  assert.equal(store.read()?.revision, 1);
  assert.equal(store.activate(defaultCapabilities(), binding, 1).revision, 2);
  assert.throws(() => store.activate(defaultCapabilities(), binding, 1), SeptError);
  assert.equal(store.revoke(2).denied, true);
  assert.equal(new CapabilityPolicyStore(join(store.path, "..")).read()?.revision, 3);
  writeFileSync(store.path, "{broken");
  assert.throws(() => store.read(), /malformed/);
});
void test("operator configuration accepts eight grants and refuses the ninth, duplicates and unknown authority fields", () => {
  const selected = Array.from({ length: 8 }, (_, index) => ({
    root: `/selected/${String(index)}`,
    read: true,
    write: false,
  }));
  assert.equal(
    parseCapabilityConfiguration({ ...defaultCapabilities(), selected }).selected.length,
    8,
  );
  assert.throws(
    () =>
      parseCapabilityConfiguration({
        ...defaultCapabilities(),
        selected: [...selected, { root: "/selected/overflow", read: true, write: false }],
      }),
    SeptError,
  );
  assert.throws(
    () =>
      parseCapabilityConfiguration({
        ...defaultCapabilities(),
        selected: [selected[0], selected[0]],
      }),
    SeptError,
  );
  assert.throws(
    () => parseCapabilityConfiguration({ ...defaultCapabilities(), operator: true }),
    SeptError,
  );
  assert.throws(() => configuredText("\0bad"), SeptError);
});
void test("independent rights omit tools and every direct/replayed effect checks its required rights", () => {
  const writeOnly = { ...defaultCapabilities(), workspace: { read: false, write: true } };
  assert.deepEqual(capabilityTools(writeOnly), ["write"]);
  const policy = { ...writeOnly, version: 1 as const, revision: 1, denied: false, binding };
  assert.equal(
    admitCapabilityRequest(
      policy,
      { kind: "file", method: "writeFile", path: "new", content: "allowed" },
      "/workspace",
    ).kind,
    "file",
  );
  assert.throws(
    () =>
      admitCapabilityRequest(
        policy,
        { kind: "file", method: "readTextFile", path: "new" },
        "/workspace",
      ),
    SeptError,
  );
  assert.throws(
    () =>
      admitCapabilityRequest(
        policy,
        { kind: "tool", name: "edit", callId: "edit", arguments: { path: "new" } },
        "/workspace",
      ),
    SeptError,
  );
  assert.throws(
    () => admitCapabilityRequest({ ...policy, denied: true }, { kind: "resources" }, "/workspace"),
    SeptError,
  );
  assert.equal(
    capabilityGrants(writeOnly).find((grant) => grant.root === "/workspace")?.read,
    false,
  );
});
const uniformReadConfiguration = {
  profile: "docker-linux-warm-v1" as const,
  dataDomain: "private" as const,
  workspaceLimits: { bytes: 134217728, inodes: 32768 },
  engineSocket: "/run/docker.sock",
  ...binding,
  workspace: "/private",
  resources: "/projection",
  shell: false,
  readOnlyMounts: [{ source: "/selected-private", destination: "/selected/reference" }],
};

void test("uniform read permits native searches; missing mounted read refuses search/project resources and network", () => {
  const policy = {
    ...defaultCapabilities(),
    version: 1 as const,
    revision: 1,
    denied: false,
    binding,
  };
  assert.deepEqual(capabilityTools(policy, uniformReadConfiguration), ["read", "write", "edit"]);
  assertUntraversableResources(policy, uniformReadConfiguration);
  assert.throws(
    () =>
      admitCapabilityRequest(
        policy,
        { kind: "tool", name: "grep", callId: "grep", arguments: { pattern: "secret", path: "." } },
        "/workspace",
        uniformReadConfiguration,
      ),
    SeptError,
  );
  assert.throws(
    () => validateCapabilities({ ...policy, network: true }, uniformReadConfiguration),
    /enforced network namespace/,
  );
  assert.throws(
    () => validateCapabilities({ ...policy, execute: true }, uniformReadConfiguration),
    /bounded RW workspace/,
  );
});

void test("worker readiness keeps denied policy dormant and preserves occupancy", () => {
  assert.equal(
    capabilitiesAvailable(() => {
      throw new CapabilityPolicyDeniedError("denied");
    }),
    false,
  );
  assert.equal(workerStatus(false, undefined), "idle");
  assert.throws(() => {
    assertCapabilityMessageAdmission(() => {
      throw new CapabilityPolicyDeniedError("denied");
    }, false);
  }, CapabilityPolicyDeniedError);
  assertCapabilityMessageAdmission(() => {
    throw new CapabilityPolicyDeniedError("denied");
  }, true);
  assert.throws(
    () =>
      capabilitiesAvailable(() => {
        throw new SeptError("unexpected lifecycle failure");
      }),
    SeptError,
  );
  assert.equal(typeof settleWorkerDrain, "function");
});

void test("exhausted revision refuses revoke before changing a valid authority record", () => {
  const store = new CapabilityPolicyStore(mkdtempSync(join(tmpdir(), "sept-policy-exhausted-")));
  const last = {
    ...defaultCapabilities(),
    version: 1,
    revision: Number.MAX_SAFE_INTEGER - 1,
    denied: false,
    binding,
  };
  writeFileSync(store.path, JSON.stringify(last));
  assert.throws(() => store.revoke(last.revision), SeptError);
  assert.equal(store.read()?.revision, last.revision);
  assert.equal(store.read()?.denied, false);
});

void test("durable network grant survives restart and explicit revoke", () => {
  const root = mkdtempSync(join(tmpdir(), "sept-network-policy-"));
  const store = new CapabilityPolicyStore(root);
  store.initialize({ ...defaultCapabilities(), network: true }, binding);
  assert.equal(new CapabilityPolicyStore(root).read()?.network, true);
  assert.equal(store.revoke(1).denied, true);
});

void test("mutable bind compatibility admits individual files while commands/discovery/resource traversal refuse", () => {
  const configuration = { ...uniformReadConfiguration, dataDomain: "mutable-file-bind" as const };
  const policy = {
    ...defaultCapabilities(),
    version: 1 as const,
    revision: 1,
    denied: false,
    binding,
    selected: [{ root: "/selected/reference", read: true, write: false }],
  };
  assert.deepEqual(capabilityTools(policy, configuration), ["read", "write", "edit"]);
  assertMutableRequestTools(policy, configuration);
  assertUntraversableResources(policy, configuration);
  assert.equal(
    admitCapabilityRequest(
      policy,
      { kind: "file", method: "readTextFile", path: "one" },
      "/workspace",
      configuration,
    ).kind,
    "file",
  );
  assert.throws(
    () => validateCapabilities({ ...policy, execute: true }, { ...configuration, shell: true }),
    SeptError,
  );
  assert.throws(
    () =>
      admitCapabilityRequest(
        policy,
        { kind: "tool", name: "ls", callId: "scan", arguments: {} },
        "/workspace",
        configuration,
      ),
    SeptError,
  );
});

function assertMutableRequestTools(
  policy: Parameters<typeof capabilityTools>[0],
  configuration: Parameters<typeof validateCapabilities>[1],
): void {
  assert.deepEqual(capabilityTools({ ...policy, mode: "request_approval" }, configuration), [
    "read",
    "write",
    "edit",
  ]);
}

function assertUntraversableResources(
  policy: Parameters<typeof admitCapabilityRequest>[0],
  configuration: Parameters<typeof validateCapabilities>[1],
): void {
  assert.deepEqual(
    admitCapabilityRequest(policy, { kind: "resources" }, "/workspace", configuration),
    {
      kind: "resources",
      workspaceRead: false,
      grants: [
        { root: "/workspace", read: true, write: true },
        ...policy.selected,
        { root: "/resources", read: true, write: false },
        { root: "/tmp", read: true, write: true },
      ],
    },
  );
}
