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

export type RunStatus = "active" | "waiting" | "complete" | "blocked" | "failed";
export type TerminalCause = "agent_blocked" | "invocation_limit" | "epoch_limit" | "timeout" | "controller_failure";

export interface TaskRequest {
  task: string;
  role?: string;
  workspace?: string;
  provider?: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  thresholdPercent?: number;
  handoverReserveTokens?: number;
  maxInvocations?: number;
  maxEpochs?: number;
  timeoutSeconds?: number;
}

export interface Manifest {
  formatVersion: 2;
  runId: string;
  createdAt: string;
  task: string;
  role: string;
  workspace: string;
  provider: string;
  model: string;
  thinking: NonNullable<TaskRequest["thinking"]>;
  thresholdPercent: number;
  handoverReserveTokens: number;
  maxInvocations: number;
  maxEpochs: number;
  timeoutSeconds: number;
  piVersion: string;
}

export interface RunSnapshot {
  status: RunStatus;
  phase: "ready" | "running" | "waiting" | "handover_durable" | "replacing" | "terminal";
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
  thresholdPercent: 75,
  handoverReserveTokens: 50_000,
  maxInvocations: 100,
  maxEpochs: 20,
  timeoutSeconds: 86_400,
};
