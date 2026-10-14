/** Finite shared workspace and immutable generation capacity regressions. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeptError } from "../../src/durable/index.js";
import {
  parseHandsDataDomain,
  type DockerHandsConfiguration,
} from "../../src/execution/contracts.js";
import {
  validateDockerProfile,
  kernelProfile,
  recordKernelProfile,
  verifyKernelBinding,
} from "../../src/execution/profile.js";
const SAFE_HOST_CONFIG = {
  Init: true,
  Privileged: false,
  PidMode: "",
  IpcMode: "private",
  UTSMode: "",
  UsernsMode: "",
  NetworkMode: "none",
  ReadonlyRootfs: true,
  CapDrop: ["ALL"],
  SecurityOpt: ["no-new-privileges"],
  Memory: 256 * 1024 * 1024,
  PidsLimit: 64,
  NanoCpus: 500_000_000,
  Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=16777216,mode=1777" },
};

function profileFixture(): {
  configuration: DockerHandsConfiguration;
  inspected: Record<string, unknown>;
  brain: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sept-hands-profile-")));
  for (const name of ["workspace", "resources", "brain"]) {
    mkdirSync(join(root, name));
  }
  const configuration: DockerHandsConfiguration = {
    profile: "docker-linux-v1",
    dataDomain: "mutable-file-bind",
    engineSocket: "/run/docker.sock",
    containerId: "a".repeat(64),
    generation: "generation-1",
    workspace: join(root, "workspace"),
    resources: join(root, "resources"),
    shell: false,
    readOnlyMounts: [],
  };
  const inspected = {
    Id: configuration.containerId,
    Image: `sha256:${"f".repeat(64)}`,
    State: { Running: true, StartedAt: configuration.generation },
    Config: { User: "10002:10002", Env: [], Entrypoint: null, Cmd: ["sleep", "infinity"] },
    HostConfig: SAFE_HOST_CONFIG,
    Mounts: [
      { Source: configuration.workspace, Destination: "/workspace", Type: "bind", RW: true },
      { Source: configuration.resources, Destination: "/resources", Type: "bind", RW: false },
    ],
  };
  return { configuration, inspected, brain: join(root, "brain") };
}

void test("private workspace tmpfs is selected by data domain independently of shell and binds real caps", () => {
  const { configuration, inspected, brain } = profileFixture();
  const privateConfiguration: DockerHandsConfiguration = {
    ...configuration,
    dataDomain: "private",
    workspaceLimits: { bytes: 134217728, inodes: 32768 },
  };
  const supplied = privateInspection(configuration, inspected);
  for (const shell of [false, true]) {
    assert.equal(
      validateDockerProfile({ ...privateConfiguration, shell }, supplied, configuration.workspace, [
        brain,
      ]),
      "/workspace",
    );
  }
  checkKernelReceipt(privateConfiguration, supplied, brain);
});
function privateInspection(
  configuration: DockerHandsConfiguration,
  inspected: Record<string, unknown>,
) {
  return {
    ...inspected,
    HostConfig: {
      ...SAFE_HOST_CONFIG,
      Memory: 2147483648,
      PidsLimit: 256,
      NanoCpus: 2500000000,
      Tmpfs: {
        ...SAFE_HOST_CONFIG.Tmpfs,
        "/workspace":
          "rw,nosuid,nodev,noexec,size=134217728,nr_inodes=32768,mode=2770,uid=10002,gid=10002",
      },
    },
    Mounts: [
      { Source: configuration.resources, Destination: "/resources", Type: "bind", RW: false },
    ],
  };
}
function checkKernelReceipt(
  privateConfiguration: DockerHandsConfiguration,
  supplied: ReturnType<typeof privateInspection>,
  brain: string,
): void {
  const policyPath = join(brain, "capability-policy.json");
  const kernel = kernelProfile(privateConfiguration, supplied);
  recordKernelProfile(privateConfiguration, policyPath, kernel);
  verifyKernelBinding(privateConfiguration, supplied, policyPath);
  assert.throws(() => {
    verifyKernelBinding(
      privateConfiguration,
      { ...supplied, HostConfig: { ...supplied.HostConfig, Memory: 4294967296 } },
      policyPath,
    );
  }, /receipt changed/);
  assert.throws(() => {
    recordKernelProfile(privateConfiguration, policyPath, { ...kernel, pids: 512 });
  }, /receipt changed/);
  assert.throws(
    () => kernelProfile(privateConfiguration, { ...supplied, Image: "tag" }),
    SeptError,
  );
}

void test("finite consumer caps refuse absent/unlimited/fractional values and workspace mismatch", () => {
  const { configuration, inspected, brain } = profileFixture();
  for (const field of ["Memory", "PidsLimit", "NanoCpus"]) {
    for (const value of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () =>
          validateDockerProfile(
            configuration,
            { ...inspected, HostConfig: { ...SAFE_HOST_CONFIG, [field]: value } },
            configuration.workspace,
            [brain],
          ),
        /resource limit/,
      );
    }
  }
  assert.throws(
    () =>
      validateDockerProfile(
        {
          ...configuration,
          dataDomain: "private",
          workspaceLimits: { bytes: 134217728, inodes: 32768 },
        },
        inspected,
        configuration.workspace,
        [brain],
      ),
    SeptError,
  );
});

void test("parseHandsDataDomain refuses missing/unbounded domains and writable private binds", () => {
  assert.deepEqual(parseHandsDataDomain({ dataDomain: "mutable-file-bind", shell: false }), {
    dataDomain: "mutable-file-bind",
  });
  assert.deepEqual(
    parseHandsDataDomain({ dataDomain: "private", workspaceLimits: { bytes: 4096, inodes: 1 } }),
    { dataDomain: "private", workspaceLimits: { bytes: 4096, inodes: 1 } },
  );
  for (const input of [
    {},
    { dataDomain: "private", workspaceLimits: { bytes: 4097, inodes: 1 } },
    { dataDomain: "private", workspaceLimits: { bytes: 4096, inodes: 0 } },
    { dataDomain: "mutable-file-bind", shell: true },
    { dataDomain: "private", workspaceLimits: { bytes: 4096, inodes: 1 }, readWriteMounts: [{}] },
  ]) {
    assert.throws(() => parseHandsDataDomain(input), SeptError);
  }
});
