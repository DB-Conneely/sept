/** Consumer-owned Docker fixtures for actual installed CLI proofs; production never provisions hands. */

import {
  loadHandsConfiguration,
  type DockerHandsConfiguration,
} from "../../src/execution/index.js";
import { networkFirewall } from "../../src/execution/network-profile.js";
import { handsRecord } from "../../src/execution/protocol.js";
import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/** A generated reference namespace belongs exclusively to its fixture owner. */
export interface SuppliedHands {
  path: string;
  containerId: string;
  workspace: string;
  exportWorkspace(): void;
  close(): void;
}

function docker(arguments_: string[], input?: Buffer): string {
  const result = spawnSync("docker", arguments_, {
    input,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  assertFixtureExit(result, `Docker fixture control failed: ${arguments_[0] ?? "unknown"}`);
  return result.stdout.trim();
}

function assertFixtureExit(
  result: { status: number | null; signal: NodeJS.Signals | null },
  message = "Fixture process failed",
): void {
  const actual = { code: result.status, signal: result.signal };
  assert.deepEqual(actual, { code: 0, signal: null }, message);
}

function accessibleDirectory(path: string): void {
  chmodSync(path, 0o2770);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      accessibleDirectory(join(path, entry.name));
    } else if (entry.isFile()) {
      chmodSync(join(path, entry.name), 0o660);
    }
  }
}

const CONTAINMENT_ARGUMENTS = [
  "run",
  "--detach",
  "--init",
  "--no-healthcheck",
  "--user",
  "10002:10002",
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  "128",
  "--memory",
  "1g",
  "--cpus",
  "2",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,noexec,size=16777216,mode=1777",
];

function containerArguments(
  resources: string,
  network: DockerHandsConfiguration["network"],
): string[] {
  const arguments_ = [
    ...CONTAINMENT_ARGUMENTS,
    "--network",
    network?.networkId ?? "none",
    ...(network?.dnsServers.flatMap((server) => ["--dns", server]) ?? []),
    "--mount",
    `type=bind,src=${resources},dst=/resources,readonly`,
  ];
  arguments_.push(
    "--tmpfs",
    "/workspace:rw,nosuid,nodev,noexec,size=134217728,nr_inodes=32768,mode=2770,uid=10002,gid=10002",
  );
  arguments_.push(process.env.SEPT_HANDS_TEST_IMAGE ?? "sept:c1-confinement", "sleep", "infinity");
  return arguments_;
}

/** Start one generated fixture namespace and explicitly seed/export the bounded command workspace. */
export function supplyHands(
  workspacePath: string,
  shell = false,
  network?: DockerHandsConfiguration["network"],
): SuppliedHands {
  const workspace = realpathSync(workspacePath);
  const root = dirname(workspace);
  const resources = join(root, `hands-resources-${randomUUID()}`);
  mkdirSync(resources, { mode: 0o755 });
  accessibleDirectory(workspace);
  const containerId = docker(containerArguments(resources, network));
  let generation: string | undefined;
  try {
    generation = docker(["inspect", "--format", "{{.State.StartedAt}}", containerId]);
    seedWorkspace(containerId, workspace);
    const path = join(root, "hands-configuration.json");
    const configuration = {
      profile: "docker-linux-v1",
      engineSocket: new URL(
        docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]),
      ).pathname,
      containerId,
      generation,
      workspace,
      dataDomain: "private",
      workspaceLimits: { bytes: 134217728, inodes: 32768 },
      resources,
      shell,
      ...(network === undefined ? {} : { network }),
      readOnlyMounts: [],
    };
    writeFileSync(path, JSON.stringify(configuration), { mode: 0o600 });
    supplyNetwork(path);
    return handsFixture(path, containerId, generation, workspace);
  } catch (error: unknown) {
    const result = finalizeHands(containerId, generation);
    result.failures.unshift(error);
    throw new AggregateError(result.failures, "Hands fixture initialization failed");
  }
}

const EXTRACTION_OPTIONS = ["--no-same-owner", "--same-permissions", "-xf", "-"];

function exportCommandWorkspace(containerId: string, workspace: string): void {
  const arguments_ = ["exec", containerId, "tar", "-C", "/workspace", "-cf", "-", "."];
  const archive = spawnSync("docker", arguments_, {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  assertFixtureExit(archive);
  const extracted = spawnSync("tar", ["-C", workspace, ...EXTRACTION_OPTIONS], {
    input: archive.stdout,
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  assertFixtureExit(extracted);
}

function handsFixture(
  path: string,
  containerId: string,
  generation: string,
  workspace: string,
): SuppliedHands {
  let closed = false;
  const exportWorkspace = (): void => {
    assert.equal(docker(["inspect", "--format", "{{.State.StartedAt}}", containerId]), generation);
    if (docker(["inspect", "--format", "{{.State.Running}}", containerId]) === "true") {
      exportCommandWorkspace(containerId, workspace);
    }
  };
  return {
    path,
    containerId,
    workspace,
    exportWorkspace,
    close: () => {
      if (closed) {
        return;
      }
      const result = finalizeHands(containerId, generation, exportWorkspace);
      closed = result.stopped;
      if (result.failures.length > 0) {
        throw new AggregateError(result.failures, "Hands fixture finalization failed");
      }
    },
  };
}

function finalizeHands(
  containerId: string,
  generation: string | undefined,
  exportWorkspace?: () => void,
) {
  // Export is useful evidence, but its failure must never retain namespace authority.
  const failures: unknown[] = [];
  let stopped = false;
  try {
    exportWorkspace?.();
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    // A consumer restart must not let an old fixture stop the replacement generation.
    assert.equal(docker(["inspect", "--format", "{{.State.StartedAt}}", containerId]), generation);
    if (docker(["inspect", "--format", "{{.State.Running}}", containerId]) === "true") {
      docker(["kill", containerId]);
    }
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    assert.equal(docker(["inspect", "--format", "{{.State.StartedAt}}", containerId]), generation);
    const state = docker(["inspect", "--format", "{{.State.Running}}:{{.State.Pid}}", containerId]);
    assert.equal(state, "false:0");
    stopped = true;
  } catch (error: unknown) {
    failures.push(error);
  }
  return { failures, stopped };
}

const childHands = new WeakMap<ChildProcess, SuppliedHands>();

/** Associate fixture ownership with the child without changing production's installed path. */
export function ownHands(child: ChildProcess, hands: SuppliedHands | undefined): void {
  if (hands !== undefined) {
    childHands.set(child, hands);
  }
}

/** Consumer closes its supplied namespace only after the installed child has joined. */
export function closeChildHands(child: ChildProcess): void {
  childHands.get(child)?.close();
  childHands.delete(child);
}

/** Read-only health/history fixtures can deliberately run with no supplied backend. */
export function workerHands(
  agent: string,
  environment: NodeJS.ProcessEnv,
): SuppliedHands | undefined {
  const workspace = join(dirname(agent), "workspace");
  return existsSync(workspace) && environment.SEPT_HANDS_CONFIGURATION === undefined
    ? supplyHands(workspace, environment.SEPT_HANDS_FIXTURE_SHELL === "true")
    : undefined;
}

/** Explicit fixture operator adoption uses installed commands, including legacy/missing-policy restart. */
export function activateHandsPolicy(hands: SuppliedHands, state: string, agent: string): void {
  const common = ["--state-dir", state, "--agent-dir", agent];
  const show = spawnSync(resolve("sept"), ["permissions", "show", ...common], {
    encoding: "utf8",
    env: { ...process.env, OTEL_SDK_DISABLED: "true" },
  });
  assert.equal(show.status, 0, show.stderr);
  const value: unknown = JSON.parse(show.stdout);
  assert.ok(
    typeof value === "object" &&
      value !== null &&
      "revision" in value &&
      typeof value.revision === "number",
  );
  const set = spawnSync(
    resolve("sept"),
    [
      "permissions",
      "set",
      ...common,
      "--hands",
      hands.path,
      "--mode",
      "full_access",
      "--revision",
      String(value.revision),
    ],
    { encoding: "utf8", env: { ...process.env, OTEL_SDK_DISABLED: "true" } },
  );
  assert.equal(set.status, 0, set.stderr);
}

function supplyNetwork(path: string): void {
  const configuration = loadHandsConfiguration(path);
  if (configuration.network === undefined) {
    return;
  }
  const inspected = handsRecord(
    JSON.parse(docker(["inspect", "--format", "{{json .}}", configuration.containerId])),
  );
  for (const family of ["ipv4", "ipv6"] as const) {
    docker(
      [
        "exec",
        "--privileged",
        "--user",
        "0:0",
        "-i",
        configuration.containerId,
        family === "ipv4" ? "/usr/sbin/iptables-restore" : "/usr/sbin/ip6tables-restore",
      ],
      Buffer.from(networkFirewall(configuration, inspected, family)),
    );
  }
}

function seedWorkspace(containerId: string, workspace: string): void {
  const archive = spawnSync("tar", ["-C", workspace, "-cf", "-", "."], {
    maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, COPYFILE_DISABLE: "1" },
  });
  assertFixtureExit(archive);
  docker(
    ["exec", "-i", containerId, "tar", "-C", "/workspace", ...EXTRACTION_OPTIONS],
    archive.stdout,
  );
}
