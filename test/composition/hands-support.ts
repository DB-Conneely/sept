/** Consumer-owned Docker fixtures for actual installed CLI proofs; production never provisions hands. */

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
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** A generated reference namespace belongs exclusively to its fixture owner. */
export interface SuppliedHands {
  path: string;
  containerId: string;
  workspace: string;
  shell: boolean;
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
  assert.equal(result.status, 0, `Docker fixture control failed: ${arguments_[0] ?? "unknown"}`);
  return result.stdout.trim();
}

function accessibleDirectory(path: string): void {
  chmodSync(path, 0o777);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      accessibleDirectory(join(path, entry.name));
    } else if (entry.isFile()) {
      chmodSync(join(path, entry.name), 0o666);
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
  "--network",
  "none",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  "64",
  "--memory",
  "512m",
  "--cpus",
  "1",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,noexec,size=16777216,mode=1777",
];

function containerArguments(workspace: string, resources: string, shell: boolean): string[] {
  const arguments_ = [
    ...CONTAINMENT_ARGUMENTS,
    "--mount",
    `type=bind,src=${resources},dst=/resources,readonly`,
  ];
  if (shell) {
    arguments_.push(
      "--tmpfs",
      "/workspace:rw,nosuid,nodev,noexec,size=67108864,nr_inodes=4096,mode=0700,uid=10002,gid=10002",
    );
  } else {
    arguments_.push("--mount", `type=bind,src=${workspace},dst=/workspace`);
  }
  arguments_.push(process.env.SEPT_HANDS_TEST_IMAGE ?? "sept:c1-confinement", "sleep", "infinity");
  return arguments_;
}

/** Start one generated fixture namespace and explicitly seed/export the bounded command workspace. */
export function supplyHands(workspacePath: string, shell = false): SuppliedHands {
  const workspace = realpathSync(workspacePath);
  const root = dirname(workspace);
  const resources = join(root, `hands-resources-${randomUUID()}`);
  mkdirSync(resources, { mode: 0o755 });
  accessibleDirectory(workspace);
  const containerId = docker(containerArguments(workspace, resources, shell));
  try {
    if (shell) {
      const archive = spawnSync("tar", ["-C", workspace, "-cf", "-", "."], {
        maxBuffer: 8 * 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, COPYFILE_DISABLE: "1" },
      });
      assert.equal(archive.status, 0);
      docker(
        ["exec", "-i", containerId, "tar", "-C", "/workspace", "--no-same-owner", "-xf", "-"],
        archive.stdout,
      );
    }
    const generation = docker(["inspect", "--format", "{{.State.StartedAt}}", containerId]);
    const path = join(root, "hands-configuration.json");
    writeFileSync(
      path,
      JSON.stringify({
        profile: "docker-linux-v1",
        containerId,
        generation,
        workspace,
        resources,
        shell,
        readOnlyMounts: [],
      }),
      { mode: 0o600 },
    );
    return handsFixture(path, containerId, workspace, shell);
  } catch (error: unknown) {
    docker(["kill", containerId]);
    throw error;
  }
}

function exportCommandWorkspace(containerId: string, workspace: string): void {
  const archive = spawnSync(
    "docker",
    ["exec", containerId, "tar", "-C", "/workspace", "-cf", "-", "."],
    {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    },
  );
  assert.equal(archive.status, 0);
  const extracted = spawnSync("tar", ["-C", workspace, "--no-same-owner", "-xf", "-"], {
    input: archive.stdout,
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  assert.equal(extracted.status, 0);
}

function handsFixture(
  path: string,
  containerId: string,
  workspace: string,
  shell: boolean,
): SuppliedHands {
  let closed = false;
  const exportWorkspace = (): void => {
    if (shell && docker(["inspect", "--format", "{{.State.Running}}", containerId]) === "true") {
      exportCommandWorkspace(containerId, workspace);
    }
  };
  return {
    path,
    containerId,
    workspace,
    shell,
    exportWorkspace,
    close: () => {
      if (closed) {
        return;
      }
      exportWorkspace();
      if (docker(["inspect", "--format", "{{.State.Running}}", containerId]) === "true") {
        docker(["kill", containerId]);
      }
      assert.equal(
        docker(["inspect", "--format", "{{.State.Running}}:{{.State.Pid}}", containerId]),
        "false:0",
      );
      closed = true;
    },
  };
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
