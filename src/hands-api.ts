/** Package operator contracts omit native backend/tool declarations while reusing the exact helpers. */
import {
  loadHandsConfiguration as readConfiguration,
  networkFirewall as createFirewall,
} from "./execution/index.js";

/** One operator-registered program, read from a selected kernel-RO root and hash-bound before execution. */
export interface CustomHand {
  path: string;
  sha256: string;
  replay: "safe" | "unsafe";
}
/** Trusted operator configuration for the one supported Linux reference profile. */
export interface DockerHandsConfiguration {
  profile: "docker-linux-warm-v1";
  /** Explicit OS-protected local Engine endpoint; ambient Docker contexts never select authority. */
  engineSocket: string;
  containerId: string;
  generation: string;
  workspace: string;
  /** Private data is one consumer-seeded tmpfs; mutable binds admit individual anchored file effects only. */
  dataDomain: "private" | "mutable-file-bind";
  /** Required for private data; exact kernel byte/inode limits are bound to the namespace generation. */
  workspaceLimits?: { bytes: number; inodes: number };
  resources: string;
  shell: boolean;
  /** Complete reachable brain/control/metadata inventory; exact kernel exclusions are checked per effect. */
  network?: {
    networkId: string;
    protectedAddresses: string[];
    dnsServers: string[];
    /** Complete protected service ports are required when DNS shares an excluded address. */
    protectedEndpoints?: { address: string; port: number }[];
  };
  readOnlyMounts: { source: string; destination: string }[];
  /** Read-only roots baked into the exact admitted image; no host source or runtime seeding. */
  imageSelected?: { alias: string }[];
  /** Optional single custom hand, never repository/native brain extension code. */
  customHand?: CustomHand;
  /** Persistent RW selected mounts are supported only without arbitrary execution. */
  readWriteMounts?: { source: string; destination: string }[];
}

/** Read bounded trusted local configuration; no Engine namespace or permission is provisioned. */
export const loadHandsConfiguration: (path: string | undefined) => DockerHandsConfiguration =
  readConfiguration;

/** Generate one exact filter family; the trusted consumer retains installation authority. */
export const networkFirewall: (
  configuration: DockerHandsConfiguration,
  inspected: Record<string, unknown>,
  family: "ipv4" | "ipv6",
) => string = createFirewall;
