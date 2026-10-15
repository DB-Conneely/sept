/** Validates actual consumer-started Linux containment, not command spelling or promises. */

import { realpathSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { atomicWrite, SeptError } from "../durable/index.js";
import type { DockerHandsConfiguration, HandsKernelProfile } from "./contracts.js";
import {
  configuredText,
  namespaceLifetimePath,
  readBoundedHandsRecord,
} from "./profile-configuration.js";
export { loadHandsConfiguration } from "./profile-configuration.js";
import { validateNetworkProfile } from "./network-profile.js";
import { handsRecord } from "./protocol.js";
import { beneath, assertSourceTree } from "./profile-sources.js";

function assertPrivateMounts(
  configuration: DockerHandsConfiguration,
  brainRoots: readonly string[],
): void {
  const sources = [
    configuration.workspace,
    configuration.resources,
    ...configuration.readOnlyMounts.map((mount) => mount.source),
    ...(configuration.readWriteMounts ?? []).map((mount) => mount.source),
  ];
  for (const source of sources) {
    if (brainRoots.some((root) => beneath(source, root) || beneath(root, source))) {
      throw new SeptError("Hands mount overlaps private brain resources");
    }
  }
}

function emptyList(value: unknown): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

function expectValue(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new SeptError("Hands kernel profile differs from the supported isolation contract");
  }
}

function assertPrivileges(host: Record<string, unknown>): void {
  const caps = host.CapDrop;
  const security = host.SecurityOpt;
  if (!Array.isArray(caps) || caps.length !== 1 || caps[0] !== "ALL" || !emptyList(host.CapAdd)) {
    throw new SeptError("Hands capabilities are unsupported");
  }
  if (!Array.isArray(security) || security.length !== 1 || security[0] !== "no-new-privileges") {
    throw new SeptError("Hands security options are unsupported");
  }
  for (const field of ["Devices", "DeviceRequests", "DeviceCgroupRules", "VolumesFrom"]) {
    if (!emptyList(host[field])) {
      throw new SeptError("Hands device or shared volume exposure is unsupported");
    }
  }
}

function boundedResource(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new SeptError("Hands resource limit is unsupported");
  }
  return value;
}

function assertIsolation(
  host: Record<string, unknown>,
  configuration: DockerHandsConfiguration,
): void {
  expectValue(host.Init, true);
  expectValue(host.Privileged, false);
  expectValue(host.PidMode, "");
  expectValue(host.IpcMode, "private");
  expectValue(host.UTSMode, "");
  expectValue(host.UsernsMode, "");
  expectValue(host.ReadonlyRootfs, true);
  assertPrivileges(host);
  const memory = boundedResource(host.Memory);
  boundedResource(host.PidsLimit);
  boundedResource(host.NanoCpus);
  const scratch = handsRecord(host.Tmpfs);
  expectValue(Object.keys(scratch).length, configuration.dataDomain === "private" ? 2 : 1);
  if (configuration.dataDomain === "private") {
    const limits = configuration.workspaceLimits;
    if (limits === undefined || limits.bytes + 16777216 >= memory) {
      throw new SeptError("Private workspace and scratch leave no process memory headroom");
    }
    expectValue(
      scratch["/workspace"],
      `rw,nosuid,nodev,noexec,size=${String(limits.bytes)},nr_inodes=${String(limits.inodes)},mode=2770,uid=10002,gid=10002`,
    );
  }
  expectValue(scratch["/tmp"], "rw,nosuid,nodev,noexec,size=16777216,mode=1777");
}

function assertNoAmbientEnvironment(value: unknown): void {
  if (!Array.isArray(value) || value.length > 16) {
    throw new SeptError("Hands environment is unsupported");
  }
  const safe: Record<string, string> = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/home/sept",
    NODE_ENV: "production",
    PI_CODING_AGENT_DIR: "/pi-agent",
    SEPT_STATE_DIR: "/state/runs",
    SEPT_WORKSPACE_ROOT: "/workspace",
    TMPDIR: "/tmp",
  };
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new SeptError("Hands environment is malformed");
    }
    const separator = entry.indexOf("=");
    const key = entry.slice(0, separator);
    const setting = entry.slice(separator + 1);
    if (key === "NODE_VERSION" || key === "YARN_VERSION") {
      if (!/^\d+\.\d+\.\d+$/.test(setting)) {
        throw new SeptError("Hands runtime version is malformed");
      }
    } else {
      expectValue(setting, safe[key]);
    }
  }
}

function assertMounts(
  configuration: DockerHandsConfiguration,
  value: unknown,
  qualification: "opening" | "live",
): void {
  if (!Array.isArray(value)) {
    throw new SeptError("Hands mounts are unavailable");
  }
  assertImageMounts(configuration, value);
  const expected = [
    ...(configuration.dataDomain === "private"
      ? []
      : [{ source: configuration.workspace, destination: "/workspace", writable: true }]),
    { source: configuration.resources, destination: "/resources", writable: false },
    ...configuration.readOnlyMounts.map((mount) => ({ ...mount, writable: false })),
    ...(configuration.readWriteMounts ?? []).map((mount) => ({ ...mount, writable: true })),
  ];
  if (value.length !== expected.length) {
    throw new SeptError("Hands backend has unexpected mounts");
  }
  for (const raw of value) {
    const mount = handsRecord(raw);
    const matching = expected.find((candidate) => candidate.destination === mount.Destination);
    if (
      matching === undefined ||
      mount.Type !== "bind" ||
      realpathSync(configuredText(mount.Source)) !== matching.source ||
      mount.RW !== matching.writable
    ) {
      throw new SeptError("Hands mount provenance or kernel access differs from configuration");
    }
    // Opening qualifies data provenance once; live effects retain bounded mount/root identity and anchored owners.
    assertMountSource(matching, qualification);
  }
}

function assertImageMounts(configuration: DockerHandsConfiguration, mounts: unknown[]): void {
  // Image snapshots cannot acquire a substituted ancestor, root, or descendant mount at any effect.
  for (const raw of mounts) {
    const destination = configuredText(handsRecord(raw).Destination);
    for (const { alias } of configuration.imageSelected ?? []) {
      const root = `/selected/${alias}`;
      if (beneath(destination, root) || beneath(root, destination)) {
        throw new SeptError("Hands mount overlaps an image selected root");
      }
    }
  }
}

function assertMountSource(
  mount: {
    destination: string;
    writable: boolean;
    source: string;
  },
  qualification: "opening" | "live",
): void {
  if (qualification === "opening" && mount.destination !== "/workspace" && !mount.writable) {
    assertSourceTree(mount.source);
  }
}

function workspaceAlias(workspace: string, root: string): string {
  const canonical = realpathSync(workspace);
  if (!beneath(canonical, root)) {
    throw new SeptError("Workspace is outside the supplied hands namespace");
  }
  const child = relative(root, canonical).split(sep).join("/");
  return child.length === 0 ? "/workspace" : `/workspace/${child}`;
}

/** Verify kernel profile and translate an admitted host workspace into the hands namespace. */
export function validateDockerProfile(
  configuration: DockerHandsConfiguration,
  value: unknown,
  workspace: string,
  brainRoots: readonly string[],
  options: { qualification: "opening" | "live" } = { qualification: "opening" },
): string {
  try {
    const inspected = handsRecord(value);
    assertSelectedDomain(configuration);
    const state = handsRecord(inspected.State);
    const config = handsRecord(inspected.Config);
    if (
      inspected.Id !== configuration.containerId ||
      state.Running !== true ||
      state.StartedAt !== configuration.generation ||
      config.User !== "10002:10002"
    ) {
      throw new SeptError("Hands backend identity or generation is unavailable");
    }
    assertIsolation(handsRecord(inspected.HostConfig), configuration);
    validateNetworkProfile(configuration, inspected);
    assertPrivateMounts(
      configuration,
      brainRoots.map((root) => realpathSync(root)),
    );
    assertNoAmbientEnvironment(config.Env);
    if (!emptyList(config.Entrypoint)) {
      throw new SeptError("Hands entrypoint differs from the supplied idle profile");
    }
    expectValue(JSON.stringify(config.Cmd), JSON.stringify(["sleep", "infinity"]));
    assertMounts(configuration, inspected.Mounts, options.qualification);
    return workspaceAlias(workspace, configuration.workspace);
  } catch (error: unknown) {
    if (error instanceof SeptError) {
      throw error;
    }
    throw new SeptError("Hands namespace provenance is unavailable", { cause: error });
  }
}

function assertSelectedDomain(configuration: DockerHandsConfiguration): void {
  if (configuration.dataDomain !== "private" && (configuration.imageSelected?.length ?? 0) > 0) {
    throw new SeptError("Image selected roots require the private data domain");
  }
  if (configuration.dataDomain === "private" && (configuration.readWriteMounts?.length ?? 0) > 0) {
    throw new SeptError("Private workspace cannot expose writable host binds");
  }
}

/** Kernel caps are supplied through Docker, never fixture maxima or new resource configuration knobs. */
export function kernelProfile(
  configuration: DockerHandsConfiguration,
  value: unknown,
): HandsKernelProfile {
  const inspected = handsRecord(value);
  const host = handsRecord(inspected.HostConfig);
  const image = configuredText(inspected.Image);
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) {
    throw new SeptError("Hands image identity is unavailable");
  }
  return {
    isolationRevision: "uid-dac-fixed-helper-v1",
    image,
    memory: boundedResource(host.Memory),
    pids: boundedResource(host.PidsLimit),
    nanoCpus: boundedResource(host.NanoCpus),
    dataDomain: configuration.dataDomain,
    workspaceLimits: configuration.workspaceLimits,
  };
}
function kernelReceiptPath(configuration: DockerHandsConfiguration, policyPath: string): string {
  return join(namespaceLifetimePath(policyPath, configuration), "..", "kernel.json");
}
/** A generation's admitted image/caps/data receipt is immutable; replacement requires fresh authority. */
export function recordKernelProfile(
  configuration: DockerHandsConfiguration,
  policyPath: string,
  kernel: HandsKernelProfile,
): void {
  const path = kernelReceiptPath(configuration, policyPath);
  const receipt = { version: 1, ...kernel };
  if (existsSync(path)) {
    assertKernelReceipt(path, receipt);
    return;
  }
  atomicWrite(path, receipt);
}
function assertKernelReceipt(path: string, expected: Record<string, unknown>): void {
  if (JSON.stringify(readBoundedHandsRecord(path)) !== JSON.stringify(expected)) {
    throw new SeptError("Hands image, kernel caps or data-domain receipt changed");
  }
}
/** Live Engine caps must equal opening kernel facts; same-generation Docker update cannot widen authority. */
export function verifyKernelBinding(
  configuration: DockerHandsConfiguration,
  value: unknown,
  policyPath: string,
): void {
  assertKernelReceipt(kernelReceiptPath(configuration, policyPath), {
    version: 1,
    ...kernelProfile(configuration, value),
  });
}
