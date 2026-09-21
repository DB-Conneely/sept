/** Ordered array fields required in every context-rotation handover. */
export const HANDOVER_FIELDS = [
  "completed",
  "in_flight",
  "not_started",
  "decisions",
  "rejected_approaches",
  "verification",
  "uncertainties",
  "references",
  "lessons",
] as const;

/** Durable lifecycle states for one admitted run. */
export type RunStatus =
  | "active"
  | "waiting"
  | "cancelling"
  | "cancelled"
  | "complete"
  | "blocked"
  | "failed";

/** Machine-readable authority for a terminal or cancellation transition. */
export type TerminalCause =
  | "agent_blocked"
  | "invocation_limit"
  | "epoch_limit"
  | "timeout"
  | "controller_failure"
  | "operator_cancelled";

/** Durable admission readiness owned by the worker state root. */
export type WorkerReadiness = "accepting" | "draining" | "drained";

/** Validated task admission values before immutable manifest resolution. */
export interface TaskRequest {
  task: string;
  role?: string;
  workspace?: string;
  provider?: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  maxInvocations?: number;
  maxEpochs?: number;
  timeoutSeconds?: number;
}

/** Immutable, credential-free execution authority persisted for one run. */
export interface Manifest {
  formatVersion: 3;
  runId: string;
  createdAt: string;
  task: string;
  role: string;
  workspace: string;
  provider: string;
  model: string;
  thinking: NonNullable<TaskRequest["thinking"]>;
  maxInvocations: number;
  maxEpochs: number;
  timeoutSeconds: number;
  piVersion: string;
}

/** Recoverable lifecycle phases owned by the run controller. */
export type RunPhase =
  | "ready"
  | "running"
  | "waiting"
  | "handover_durable"
  | "replacing"
  | "cancelling"
  | "terminal";

/** Latest durable lifecycle snapshot used for restart adoption. */
export interface RunSnapshot {
  status: RunStatus;
  phase: RunPhase;
  epoch: number;
  invocations: number;
  activeMilliseconds: number;
  activeSessionId?: string;
  activeSessionFile?: string;
  predecessorSessionId?: string;
  predecessorSessionFile?: string;
  handoverEpoch?: number;
  startedAt: string;
  updatedAt: string;
  reason?: string;
  terminalCause?: TerminalCause;
}

/** Exact accepted operator input and its stable durable identity. */
export interface OperatorMessage {
  id: string;
  createdAt: string;
  text: string;
}

/** Agent-authored lifecycle decision validated before durable use. */
export interface WorkControl {
  status: "continue" | "waiting" | "complete" | "blocked";
  summary: string;
  verification: string[];
  next_action: string;
}

/** Public assistant message paired with its private lifecycle decision. */
export interface WorkResponse {
  control: WorkControl;
  message?: string;
}

/** Bounded client-facing event retained in a run conversation. */
export type ConversationEvent =
  | {
      formatVersion: 1;
      cursor: number;
      id: string;
      type: "message";
      role: "user" | "assistant";
      text: string;
      at: string;
    }
  | {
      formatVersion: 1;
      cursor: number;
      id: string;
      type: "state";
      state: "active" | "waiting";
      at: string;
    }
  | {
      formatVersion: 1;
      cursor: number;
      id: string;
      type: "terminal";
      status: "cancelled" | "complete" | "blocked" | "failed";
      at: string;
    };

/** State-root lifecycle record that gates all task and message admission. */
export interface WorkerLifecycleState {
  formatVersion: 1;
  readiness: WorkerReadiness;
  updatedAt: string;
  drainAcceptedAt?: string;
  drainedAt?: string;
}

/** Validated context-transfer content required before session replacement. */
export type Handover = {
  handover_summary: string;
  entry_state_and_done: string;
  next_action: string;
} & Record<(typeof HANDOVER_FIELDS)[number], string[]>;

/** Fsynced handover evidence binding a predecessor to one run epoch. */
export interface DurableHandover {
  formatVersion: 1;
  runId: string;
  epoch: number;
  predecessorSessionId: string;
  predecessorSessionFile?: string;
  operatorMessages: OperatorMessage[];
  handover: Handover;
  writtenAt: string;
}

/** Internal append-only run evidence with extensible bounded fact fields. */
export interface RunEvent extends Record<string, unknown> {
  seq: number;
  type: string;
  at: string;
}

/** Conservative task defaults applied only when admission omits a value. */
export const DEFAULTS = {
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  thinking: "high" as const,
  maxInvocations: 100,
  maxEpochs: 20,
  timeoutSeconds: 86_400,
};
