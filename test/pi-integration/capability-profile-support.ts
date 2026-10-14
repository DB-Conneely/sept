/** Shared supporting metadata fixture; actual profile proof uses the installed worker and Linux Engine. */
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DockerHandsConfiguration } from "../../src/execution/index.js";
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

/** Generated bounded Engine profile facts; these establish no kernel containment claim. */
export function profileFixture(): {
  configuration: DockerHandsConfiguration;
  inspected: Record<string, unknown>;
  brain: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sept-hands-profile-")));
  for (const name of ["workspace", "resources", "brain"]) {
    mkdirSync(join(root, name));
  }
  const configuration: DockerHandsConfiguration = {
    profile: "docker-linux-warm-v1",
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
