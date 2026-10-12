/**
 * Defines the narrow runtime-facing contracts of the Pi integration boundary. Runtime owns policy
 * and durable lifecycle transitions; implementations here own native Pi sessions, while optional
 * dependency injection is limited to model and tool wiring used by production composition/tests.
 */

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Extension } from "@earendil-works/pi-durable";
import type { OperatorMessage } from "../durable/index.js";

/** Observable result of one native Pi invocation, including finalized context evidence. */
export interface SessionRunResult {
  text: string;
  preRotationText?: string;
  steered: boolean;
  contextTokens: number | null;
  contextWindow: number;
}

/** Optional native Pi construction dependencies; callers retain ownership of injected runtimes. */
export interface PiSessionHostDependencies {
  modelRuntime?: ModelRuntime;
  extensions?: readonly Extension[];
}

/** Runtime-owned handle to exactly one current native Pi session. */
export interface SessionHost {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  run(prompt: string, operatorMessages?: readonly OperatorMessage[]): Promise<SessionRunResult>;
  newSession(): Promise<{
    predecessorId: string;
    predecessorFile?: string;
    successorId: string;
    successorFile?: string;
  }>;
  abort(): Promise<void>;
  close(): Promise<void>;
}
