import type {
  HandsCommandStart,
  HandsCommandExit,
  HandsCommandHandler,
} from "./hands-command-contracts.js";
export type {
  HandsCommandStart,
  HandsCommandExit,
  HandsCommandHandler,
  HandsCommandExecutor,
  HandsCommandInput,
  HandsCommandStream,
} from "./hands-command-contracts.js";
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

/** One operator-registered program, read from a selected kernel-RO root and hash-bound before execution. */
export interface CustomHand {
  path: string;
  sha256: string;
  replay: "safe" | "unsafe";
}
/** One effect or resource request. Principal, cwd and generation are supplied by trusted composition. */
export type HandsRequest =
  | { kind: "resources"; workspaceRead?: boolean; grants?: CapabilityGrant[] }
  | {
      kind: "custom";
      callId: string;
      /** Trusted native task identity makes original denied calls inert across later invocations. */
      taskKey?: string;
      arguments: { text: string; network?: boolean };
      hand?: CustomHand;
      grants?: CapabilityGrant[];
    }
  | {
      kind: "tool";
      name: CodingToolName;
      callId: string;
      /** Trusted native task identity makes original denied calls inert across later invocations. */
      taskKey?: string;
      arguments: Record<string, unknown>;
      resize?: ModelImageResizeOptions;
      grants?: CapabilityGrant[];
    }
  | {
      kind: "file";
      method: "readTextFile" | "writeFile";
      path: string;
      /** Native tool/task identity supplied by trusted composition, never request arguments. */
      callId?: string;
      content?: string;
      grants?: CapabilityGrant[];
    };

/** A separately enforced namespace owned by a consumer, never a local Node fallback. */
export interface ExecutionBackend {
  readonly id: string;
  readonly generation: string;
  readonly cwd: string;
  readonly shell: boolean;
  /** Operator registration only; models cannot supply executable paths or replay declarations. */
  readonly customHand?: CustomHand | undefined;
  /** Effective registrations are a snapshot; actual effects still check live policy. */
  readonly tools?: readonly CodingToolName[] | undefined;
  /** Private brain-owned text/image projection, mounted read-only in hands. */
  readonly resourceProjectionDirectory: string;
  /** Private durable receipt proves ownership before derived resources may be refreshed. */
  readonly resourceProjectionReceipt: string;
  /** Pre-intent tool denial returns a bounded reason; effects still recheck live authority. */
  beforeTool?(request: Extract<HandsRequest, { kind: "tool" | "custom" }>): string | undefined;
  /** Pending requests seal before another model dispatch rather than parking a provider loop. */
  pendingPermission?(): string | undefined;
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
  /** Optional single custom hand, never repository/native brain extension code. */
  customHand?: CustomHand;
  /** Persistent RW selected mounts are supported only without arbitrary execution. */
  readWriteMounts?: { source: string; destination: string }[];
}

export { HandsBackendUnavailableError, type HandsLossFacts } from "./hands-loss.js";

export { EngineControlError, type EngineFailureFacts } from "./engine-failure.js";

/** Trusted command composition only; model data cannot select Engine operations or confirmation. */
export interface EngineExec {
  command: string[];
  input?: string;
  cwd?: string;
  user?: string;
  privileged?: boolean;
  maximum?: number;
  /** Trusted owner rechecks live admission after registration and immediately before Engine start. */
  beforeStart?: () => Promise<void>;
  /** Actual commands retain stream tags; fixed resident/control diagnostics remain bounded and drained. */
  commandOutput?: boolean;
  /** Fixed stop helper must pin its namespace before the final brain-owned generation check. */
  confirm?: () => Promise<void>;
}
/** Kernel lifetime facts are private generation metadata, never task-selected authority. */
export interface NamespaceLifetime {
  pidNamespace: string;
  initStart: string;
}

/** Exact consumer-selected kernel facts; changing any fact invalidates generation authority. */
export interface HandsKernelProfile {
  image: string;
  memory: number;
  pids: number;
  nanoCpus: number;
  dataDomain: DockerHandsConfiguration["dataDomain"];
  workspaceLimits: DockerHandsConfiguration["workspaceLimits"];
}

/** Validate explicit consumer data-domain and finite bounds once at the trusted configuration boundary. */
export function parseHandsDataDomain(
  input: Record<string, unknown>,
): Pick<DockerHandsConfiguration, "dataDomain" | "workspaceLimits"> {
  if (input.dataDomain === "mutable-file-bind") {
    if (input.shell || input.workspaceLimits !== undefined) {
      throw new SeptError("Mutable file binds support individual file effects without commands");
    }
    return { dataDomain: input.dataDomain };
  }
  if (input.dataDomain !== "private") {
    throw new SeptError("An explicit supported hands data domain is required");
  }
  if (Array.isArray(input.readWriteMounts) && input.readWriteMounts.length > 0) {
    throw new SeptError("Private workspace cannot expose writable host binds");
  }
  return {
    dataDomain: input.dataDomain,
    workspaceLimits: parseWorkspaceLimits(input.workspaceLimits),
  };
}
function parseWorkspaceLimits(value: unknown): { bytes: number; inodes: number } {
  if (typeof value !== "object" || value === null || !("bytes" in value) || !("inodes" in value)) {
    throw new SeptError("Private workspace requires finite bytes/inodes");
  }
  const { bytes, inodes } = value;
  if (
    !finiteWorkspaceLimit(bytes) ||
    bytes % 4096 !== 0 ||
    !finiteWorkspaceLimit(inodes) ||
    Object.keys(value).length !== 2
  ) {
    throw new SeptError("Private workspace requires finite page-aligned bytes/inodes");
  }
  return { bytes, inodes };
}

function finiteWorkspaceLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Every control message belongs to one attachment and one serial parent operation; authentication grants nothing. */
export interface HandsCorrelation {
  version: 1;
  generation: string;
  configuration: string;
  session: string;
  sequence: number;
}
/** Closed resident protocol; command bytes remain data and cannot select Engine authority. */
export type HandsFrame = HandsCorrelation &
  (
    | {
        kind: "hello";
        payload: { challenge: string; pid: number; start: string; guard: 2; network: "denied" };
      }
    | { kind: "operation"; payload: HandsRequest }
    | { kind: "result"; payload: unknown }
    | { kind: "error"; payload: { stage: "operation" | "authority" | "protocol" | "shutdown" } }
    | {
        kind: "effect-check";
        payload: {
          effect: number;
          right: "operation" | "read" | "write" | "resources";
          path: string;
        };
      }
    | { kind: "ack"; payload: { effect: number; allowed: boolean } }
    | { kind: "command-start"; payload: HandsCommandStart }
    | {
        kind: "command-data";
        payload: { commandId: number; stream: "stdout" | "stderr"; text: string };
      }
    | {
        kind: "command-exit";
        payload: HandsCommandExit & { commandId: number };
      }
    | { kind: "cancel"; payload: { commandId?: number } }
  );

/** Correlation binds a validated message to its attachment and serial parent; it never confers a grant. */
export function assertHandsCorrelation(
  frame: HandsFrame,
  expected: HandsCorrelation,
  sequence: number,
): void {
  if (
    frame.generation !== expected.generation ||
    frame.configuration !== expected.configuration ||
    frame.session !== expected.session ||
    frame.sequence !== sequence
  ) {
    throw new SeptError("Hands frame correlation was refused");
  }
}

/** Narrow an external JSON object without accepting arrays or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow an external JSON object without accepting arrays or null. */
export function handsRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SeptError("Hands protocol requires an object");
  }
  return value;
}

/** Cancellation is checked afresh after each await and cannot be overridden by an earlier grant. */
export function assertHandsActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new SeptError("Hands operation was cancelled");
  }
}

/** Parse one bounded Engine JSON response; hostile text never enters the error envelope. */
export function parseEngineJson(output: Buffer): unknown {
  try {
    const value: unknown = output.length === 0 ? null : JSON.parse(output.toString("utf8"));
    return value;
  } catch {
    throw new SeptError("Hands Engine response is malformed");
  }
}

/** One serial parent owns its effect acknowledgments and bounded response budget until settlement. */
export interface HandsPendingOperation {
  sequence: number;
  authorize: (frame: Extract<HandsFrame, { kind: "effect-check" }>) => Promise<void>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  bytes: number;
  effect: number;
  stage: "operation" | "authorizing" | "executing";
  command?: { id: number; abort: AbortController; joined: Promise<void> };
  startCommand?: HandsCommandHandler;
}

/** A serial parent's live authority check; work-visible paths can never create an independent grant. */
export type HandsEffectCheck = (
  right: "operation" | "read" | "write" | "resources",
  path: string,
) => Promise<void>;

/** A challenge proves the exact guarded attachment; peer startup metadata grants no effect rights. */
export function authenticateHandsHello(
  frame: HandsFrame,
  expected: HandsCorrelation,
  challenge: string,
): Extract<HandsFrame, { kind: "hello" }> {
  assertHandsCorrelation(frame, expected, 0);
  if (frame.kind !== "hello" || frame.payload.challenge !== challenge || frame.payload.pid <= 1) {
    throw new SeptError("Hands authentication handshake was refused");
  }
  return frame;
}
