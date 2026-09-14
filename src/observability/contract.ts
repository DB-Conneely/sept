export type WorkerState = "starting" | "idle" | "busy" | "waiting" | "stopped";
export type ObservedRunState = "active" | "waiting" | "cancelling" | "cancelled" | "complete" | "blocked" | "failed" | "none";
export type TelemetrySignal = "traces" | "metrics";
export type SafeValue = string | number | boolean | undefined;
export type SafeTelemetryFields = Record<string, SafeValue>;
export type LogLevel = "info" | "warn" | "error";

/** The only observability surface used by SEPT business mechanisms. */
export interface Observability {
  log(lifecycle: string, fields?: SafeTelemetryFields, level?: LogLevel): void;
  span<T>(name: string, fields: SafeTelemetryFields, operation: () => Promise<T>): Promise<T>;
  spanSync<T>(name: string, fields: SafeTelemetryFields, operation: () => T): T;
  incomingSpan<T>(name: string, headers: Record<string, string | string[] | undefined>, fields: SafeTelemetryFields, operation: () => Promise<T>): Promise<T>;
  event(name: string, fields?: SafeTelemetryFields): void;
  setSpanFields(fields: SafeTelemetryFields): void;
  markSpanError(type?: string): void;
  setWorkerState(state: WorkerState): void;
  setRunState(state: ObservedRunState, epoch?: number, invocation?: number, queueDepth?: number): void;
  setQueueDepth(depth: number): void;
  workerStarted(adoption: "none" | "active" | "waiting" | "wake_recovered", mode?: "worker" | "run"): void;
  runOutcome(outcome: "cancelled" | "complete" | "blocked" | "failed"): void;
  sessionOpened(outcome: "started" | "resumed" | "replaced" | "successor_adopted"): void;
  invocationFinished(durationMs: number, outcome: "success" | "failure" | "timeout", steered?: boolean): void;
  contextSample(tokens: number | null, contextWindow: number, epoch: number, invocation: number): void;
  webhook(outcome: "accepted" | "duplicate" | "collision" | "rejected", kind: "task" | "operator_message" | "unknown"): void;
  http(method: string, route: string, status: number, durationMs: number): void;
  forceFlush(timeoutMs?: number): Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;
}
