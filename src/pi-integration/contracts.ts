import type * as NativePi from "@earendil-works/pi-durable";
import type { DurableInvocation } from "./durable-invocation.js";
/**
 * Defines the narrow runtime-facing contracts of the Pi integration boundary. Runtime owns policy
 * and durable lifecycle transitions; implementations here own native Pi sessions, while optional
 * dependency injection is limited to model and tool wiring used by production composition/tests.
 */

import type { ExecutionBackend } from "../execution/index.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Extension } from "@earendil-works/pi-durable";
import type { Handover, OperatorMessage, WorkResponse } from "../durable/index.js";

/** Runtime-owned domain validation performed before native continuation/tool dispatch. */
export type ValidatedSessionResponse =
  | { kind: "control"; response: WorkResponse }
  | { kind: "handover"; handover: Handover };

/** Parses one finalized domain response at its runtime boundary; failures must seal native work. */
export type SessionResponseValidator = (
  text: string,
  kind: "control" | "handover",
) => ValidatedSessionResponse;

/** Observable result of one native Pi invocation, including finalized context evidence. */
export interface SessionRunResult {
  text: string;
  preRotationText?: string;
  steered: boolean;
  contextTokens: number | null;
  contextWindow: number;
  /** Exact native input identity and delivered queue IDs; only these may enter a checkpoint. */
  requestId?: string;
  deliveredMessageIds?: readonly string[];
  validatedResponse?: ValidatedSessionResponse;
  preRotationResponse?: WorkResponse;
  /** Stable native publication IDs survive checkpoint crashes and distinguish recovered follow-ups. */
  responseId?: string;
  preRotationResponseId?: string;
}

/** Optional native Pi construction dependencies; callers retain ownership of injected runtimes. */
export interface PiSessionHostDependencies {
  modelRuntime?: ModelRuntime;
  executionBackend?: ExecutionBackend;
  extensions?: readonly Extension[];
}

/** Runtime-owned handle to exactly one current native Pi session. */
export interface SessionHost {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  /** Original invocation number of uncheckpointed native work, read before runtime admission. */
  readonly recoveryInvocation?: number | undefined;
  run(
    prompt: string,
    operatorMessages?: readonly OperatorMessage[],
    validate?: SessionResponseValidator,
  ): Promise<SessionRunResult>;
  /** Fsync admission settlement after the controller completes the matching domain transition. */
  acknowledge?(result: SessionRunResult): void;
  newSession(): Promise<{
    predecessorId: string;
    predecessorFile?: string;
    successorId: string;
    successorFile?: string;
  }>;
  /** Permission waiting checkpoints only the sealed invocation, never later input. */
  checkpointPermissionWait?(): void;
  abort(): Promise<void>;
  close(): Promise<void>;
}

/** Native owners travel together so partial host construction can close every acquired resource. */
export interface OpenedDurableRuntime {
  harness: NativePi.Harness;
  backend: ExecutionBackend;
  conversation: NativePi.Conversation;
  invocation: DurableInvocation;
  sessionFile: string;
  refreshResources: () => Promise<void>;
}
