/** Finite shared workspace and immutable generation capacity regressions. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
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
import { namespaceLifetimePath } from "../../src/execution/profile-configuration.js";
import { profileFixture } from "./capability-profile-support.js";
import { handsRecord } from "../../src/execution/protocol.js";

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
  const host = handsRecord(inspected.HostConfig);
  return {
    ...inspected,
    HostConfig: {
      ...host,
      Memory: 2147483648,
      PidsLimit: 256,
      NanoCpus: 2500000000,
      Tmpfs: {
        ...handsRecord(host.Tmpfs),
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
  assert.throws(() => {
    verifyKernelBinding(
      privateConfiguration,
      { ...supplied, Image: `sha256:${"e".repeat(64)}` },
      policyPath,
    );
  }, /receipt changed/);
}

void test("finite consumer caps refuse absent/unlimited/fractional values and workspace mismatch", () => {
  const { configuration, inspected, brain } = profileFixture();
  const host = handsRecord(inspected.HostConfig);
  for (const field of ["Memory", "PidsLimit", "NanoCpus"]) {
    for (const value of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () =>
          validateDockerProfile(
            configuration,
            { ...inspected, HostConfig: { ...host, [field]: value } },
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

void test("opening and live qualification refuse every mount covering an image alias", () => {
  const { configuration, inspected, brain } = profileFixture();
  const selected: DockerHandsConfiguration = {
    ...configuration,
    dataDomain: "private",
    workspaceLimits: { bytes: 134217728, inodes: 32768 },
    imageSelected: [{ alias: "baked" }],
  };
  const supplied = privateInspection(configuration, inspected);
  for (const qualification of ["opening", "live"] as const) {
    assert.equal(
      validateDockerProfile(selected, supplied, configuration.workspace, [brain], {
        qualification,
      }),
      "/workspace",
    );
    assertImageMountRefusal(selected, supplied, brain, qualification);
    assert.throws(
      () =>
        validateDockerProfile(
          selected,
          { ...supplied, State: { Running: true, StartedAt: "replaced" } },
          configuration.workspace,
          [brain],
          { qualification },
        ),
      /identity or generation/,
    );
  }
});

function assertImageMountRefusal(
  selected: DockerHandsConfiguration,
  supplied: ReturnType<typeof privateInspection>,
  brain: string,
  qualification: "opening" | "live",
): void {
  for (const destination of ["/", "/selected", "/selected/baked", "/selected/baked/child"]) {
    assert.throws(
      () =>
        validateDockerProfile(
          selected,
          {
            ...supplied,
            Mounts: [
              ...supplied.Mounts,
              {
                Source: selected.resources,
                Destination: destination,
                Type: "bind",
                RW: false,
              },
            ],
          },
          selected.workspace,
          [brain],
          { qualification },
        ),
      /overlaps an image selected root/,
    );
  }
}

void test("old isolation receipts refuse verification and replacement while preserving history bytes", () => {
  const { configuration, inspected, brain } = profileFixture();
  const policyPath = join(brain, "capability-policy.json");
  const kernel = kernelProfile(configuration, inspected);
  recordKernelProfile(configuration, policyPath, kernel);
  const path = join(namespaceLifetimePath(policyPath, configuration), "..", "kernel.json");
  const previous = { version: 1, ...kernel, isolationRevision: undefined };
  writeFileSync(path, JSON.stringify(previous));
  const original = readFileSync(path);
  assert.throws(() => {
    verifyKernelBinding(configuration, inspected, policyPath);
  }, /receipt changed/);
  assert.throws(() => {
    recordKernelProfile(configuration, policyPath, kernel);
  }, /receipt changed/);
  assert.throws(() => {
    verifyKernelBinding({ ...configuration, generation: "fresh" }, inspected, policyPath);
  }, SeptError);
  assert.deepEqual(readFileSync(path), original);
});
