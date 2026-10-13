/** Validates actual consumer-started Linux containment, not command spelling or promises. */

import { realpathSync, lstatSync, opendirSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { SeptError } from "../durable/index.js";
import type { DockerHandsConfiguration } from "./contracts.js";
import { configuredText } from "./profile-configuration.js";
export { loadHandsConfiguration } from "./profile-configuration.js";
import { handsRecord } from "./protocol.js";

function beneath(path: string, root: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

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

function boundedResource(value: unknown, maximum: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new SeptError("Hands resource limit is unsupported");
  }
}

function assertIsolation(host: Record<string, unknown>, shell: boolean): void {
  expectValue(host.Init, true);
  expectValue(host.Privileged, false);
  expectValue(host.PidMode, "");
  expectValue(host.IpcMode, "private");
  expectValue(host.UTSMode, "");
  expectValue(host.UsernsMode, "");
  expectValue(host.NetworkMode, "none");
  expectValue(host.ReadonlyRootfs, true);
  assertPrivileges(host);
  boundedResource(host.Memory, 512 * 1024 * 1024);
  boundedResource(host.PidsLimit, 64);
  boundedResource(host.NanoCpus, 1_000_000_000);
  const scratch = handsRecord(host.Tmpfs);
  expectValue(Object.keys(scratch).length, shell ? 2 : 1);
  if (shell) {
    expectValue(
      scratch["/workspace"],
      "rw,nosuid,nodev,noexec,size=67108864,nr_inodes=4096,mode=0700,uid=10002,gid=10002",
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

function inspectSourceDirectory(
  directory: string,
  root: string,
  pending: string[],
  remaining: number,
): number {
  const stream = opendirSync(directory);
  let count = 0;
  try {
    for (let entry = stream.readSync(); entry !== null; entry = stream.readSync()) {
      count += 1;
      if (count > remaining) {
        throw new SeptError("Hands mount provenance discovery exceeds its bound");
      }
      inspectSourceEntry(join(directory, entry.name), root, pending);
    }
    return count;
  } finally {
    stream.closeSync();
  }
}

function assertSourceTree(root: string): void {
  const pending = [root];
  const seen = new Set<string>();
  let count = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) {
      break;
    }
    const canonical = realpathSync(directory);
    if (!beneath(canonical, root)) {
      throw new SeptError("Hands mount symlink escapes its declared source");
    }
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    count += inspectSourceDirectory(directory, root, pending, 4096 - count);
  }
}

function inspectSourceEntry(path: string, root: string, pending: string[]): void {
  const real = realpathSync(path);
  if (!beneath(real, root)) {
    throw new SeptError("Hands mount alias escapes its declared source");
  }
  const stat = lstatSync(real);
  if (stat.isDirectory()) {
    pending.push(real);
  } else if (!stat.isFile() || stat.nlink !== 1) {
    throw new SeptError("Hands mount contains a service channel, special file or hardlink alias");
  }
}

function assertMounts(configuration: DockerHandsConfiguration, value: unknown): void {
  if (!Array.isArray(value)) {
    throw new SeptError("Hands mounts are unavailable");
  }
  const expected = [
    ...(configuration.shell
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
    // The scan is bounded provenance preflight; kernel namespaces/mounts enforce effects, not realpath/open claims.
    assertSourceTree(matching.source);
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
): string {
  try {
    const inspected = handsRecord(value);
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
    assertIsolation(handsRecord(inspected.HostConfig), configuration.shell);
    assertPrivateMounts(
      configuration,
      brainRoots.map((root) => realpathSync(root)),
    );
    assertNoAmbientEnvironment(config.Env);
    if (!emptyList(config.Entrypoint)) {
      throw new SeptError("Hands entrypoint differs from the supplied idle profile");
    }
    expectValue(JSON.stringify(config.Cmd), JSON.stringify(["sleep", "infinity"]));
    assertMounts(configuration, inspected.Mounts);
    return workspaceAlias(workspace, configuration.workspace);
  } catch (error: unknown) {
    if (error instanceof SeptError) {
      throw error;
    }
    throw new SeptError("Hands namespace provenance is unavailable", { cause: error });
  }
}
