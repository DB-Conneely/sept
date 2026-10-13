/** Defines the trusted supplied hands port. Native Pi still owns tool scheduling and replay. */

import { SeptError, type CapabilityGrant } from "../durable/index.js";
import type { Context } from "@earendil-works/chord";
import type { ModelImageResizeOptions, ToolResultMessage } from "@earendil-works/pi-ai";

/** Existing Pi tools whose bodies execute in the supplied hands namespace. */
export type CodingToolName = "read" | "write" | "edit" | "bash" | "grep" | "find" | "ls";

/** Bounded resource text returned by Pi's loader inside hands; paths are hands-visible aliases. */
export interface HandsResources {
  system: string;
  append: string;
  instructions: string;
  skills: string;
}

/** One effect or resource request. Principal, cwd and generation are supplied by trusted composition. */
export type HandsRequest =
  | { kind: "resources"; workspaceRead?: boolean }
  | {
      kind: "tool";
      name: CodingToolName;
      callId: string;
      arguments: Record<string, unknown>;
      resize?: ModelImageResizeOptions;
      grants?: CapabilityGrant[];
    }
  | {
      kind: "file";
      method: "readTextFile" | "writeFile";
      path: string;
      content?: string;
      grants?: CapabilityGrant[];
    };

/** A separately enforced namespace owned by a consumer, never a local Node fallback. */
export interface ExecutionBackend {
  readonly id: string;
  readonly generation: string;
  readonly cwd: string;
  readonly shell: boolean;
  /** Effective registrations are a snapshot; actual effects still check live policy. */
  readonly tools?: readonly CodingToolName[] | undefined;
  /** Private brain-owned text/image projection, mounted read-only in hands. */
  readonly resourceProjectionDirectory: string;
  /** Private durable receipt proves ownership before derived resources may be refreshed. */
  readonly resourceProjectionReceipt: string;
  invoke(request: HandsRequest, context: Context): Promise<unknown>;
  close(): Promise<void>;
}

/** Content parity from Pi's existing coding tools; native Harness applies its final output bounds. */
export interface HandsToolResult {
  content: ToolResultMessage["content"];
  isError?: boolean;
}

/** Trusted operator configuration for the one supported Linux reference profile. */
export interface DockerHandsConfiguration {
  profile: "docker-linux-v1";
  containerId: string;
  generation: string;
  workspace: string;
  resources: string;
  shell: boolean;
  readOnlyMounts: { source: string; destination: string }[];
  /** Persistent RW selected mounts are supported only without arbitrary execution. */
  readWriteMounts?: { source: string; destination: string }[];
}

/** Lost transport/identity authority seals native work; unsafe effects remain explicitly uncertain. */
export class HandsBackendUnavailableError extends SeptError {}
