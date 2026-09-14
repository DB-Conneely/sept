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

export type RunStatus = "active" | "waiting" | "cancelling" | "cancelled" | "complete" | "blocked" | "failed";
export type TerminalCause = "agent_blocked" | "invocation_limit" | "epoch_limit" | "timeout" | "controller_failure" | "operator_cancelled";
export type WorkerReadiness = "accepting" | "draining" | "drained";

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

export interface RunSnapshot {
  status: RunStatus;
  phase: "ready" | "running" | "waiting" | "handover_durable" | "replacing" | "cancelling" | "terminal";
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

export interface OperatorMessage {
  id: string;
  createdAt: string;
  text: string;
}

export interface WorkControl {
  status: "continue" | "waiting" | "complete" | "blocked";
  summary: string;
  verification: string[];
  next_action: string;
}

export interface WorkResponse {
  control: WorkControl;
  message?: string;
}

export type ConversationEvent =
  | { formatVersion: 1; cursor: number; id: string; type: "message"; role: "user" | "assistant"; text: string; at: string }
  | { formatVersion: 1; cursor: number; id: string; type: "state"; state: "active" | "waiting"; at: string }
  | { formatVersion: 1; cursor: number; id: string; type: "terminal"; status: "cancelled" | "complete" | "blocked" | "failed"; at: string };

export interface WorkerLifecycleState {
  formatVersion: 1;
  readiness: WorkerReadiness;
  updatedAt: string;
  drainAcceptedAt?: string;
  drainedAt?: string;
}

export type Handover = {
  handover_summary: string;
  entry_state_and_done: string;
  next_action: string;
} & Record<(typeof HANDOVER_FIELDS)[number], string[]>;

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

export interface RunEvent extends Record<string, unknown> {
  seq: number;
  type: string;
  at: string;
}

export const DEFAULTS = {
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  thinking: "high" as const,
  maxInvocations: 100,
  maxEpochs: 20,
  timeoutSeconds: 86_400,
};
