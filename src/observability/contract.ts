/**
 * Defines the dependency-inversion boundary from SEPT business mechanisms into observability.
 * This module owns only bounded, provider-neutral signal vocabulary; it imports no SDK or business
 * implementation, and every operation is advisory rather than durable lifecycle evidence.
 */

/**
 * Bounded worker lifecycle labels accepted by metrics.
 * The runtime owns transitions; observability may retain only the latest reported label.
 */
export type WorkerState = "starting" | "idle" | "busy" | "waiting" | "stopped";

/**
 * Bounded resident-run labels accepted by metrics.
 * The durable run state remains authoritative when a sample is missing or dropped.
 */
export type ObservedRunState =
  | "active"
  | "waiting"
  | "cancelling"
  | "cancelled"
  | "complete"
  | "blocked"
  | "failed"
  | "none";

/**
 * Restart-adoption classifications accepted by worker-start metrics.
 * These labels describe an already-decided durable recovery outcome; telemetry cannot select it.
 */
export type WorkerAdoption = "none" | "active" | "waiting" | "wake_recovered";

/** Distinguishes the two installed process entry modes without retaining command arguments. */
export type WorkerMode = "worker" | "run";

/**
 * Terminal run classifications accepted by metrics.
 * They summarize a durable settlement and never replace the stored terminal state.
 */
export type RunOutcome = "cancelled" | "complete" | "blocked" | "failed";

/**
 * Pi session-open classifications accepted by metrics.
 * Pi integration owns session identity and replacement; no identity crosses this boundary.
 */
export type SessionOpenOutcome = "started" | "resumed" | "replaced" | "successor_adopted";

/**
 * Pi invocation classifications accepted by metrics.
 * Failure details stay at their typed owner and are reduced to this finite outcome set.
 */
export type InvocationOutcome = "success" | "failure" | "timeout";

/**
 * Provider-neutral webhook routing classifications accepted by metrics.
 * Event IDs, source payloads, and acknowledgement authority are deliberately excluded.
 */
export type WebhookOutcome = "accepted" | "duplicate" | "collision" | "rejected";

/**
 * Provider-neutral webhook kinds accepted by metrics.
 * Unknown input is collapsed to a fixed label to prevent hostile metric cardinality.
 */
export type WebhookKind = "task" | "operator_message" | "unknown";

/** Identifies the bounded SDK signal families whose exporter health may be reported. */
export type TelemetrySignal = "traces" | "metrics";

/**
 * Scalar values permitted at the business-to-observability boundary.
 * Objects, arrays, and binary values are excluded so payloads cannot be forwarded accidentally.
 */
export type SafeValue = string | number | boolean | undefined;

/**
 * Candidate operational fields supplied by callers.
 * The observability owner still enforces its key allowlist, finite-number checks, and string bounds.
 */
export type SafeTelemetryFields = Record<string, SafeValue>;

/** Finite JSON-log severity exposed to business mechanisms; arbitrary Pino levels stay internal. */
export type LogLevel = "info" | "warn" | "error";

/**
 * The only observability surface available to SEPT business mechanisms.
 * Implementations must sanitize and bound fields, execute wrapped work exactly once, preserve its
 * result or original failure, and contain all logger, SDK, and exporter failures.
 */
export interface Observability {
  /** Emit one bounded lifecycle record; sink failure is ignored. */
  log(lifecycle: string, fields?: SafeTelemetryFields, level?: LogLevel): void;
  /** Execute asynchronous work exactly once under an optional span and preserve its outcome. */
  span<Result>(
    name: string,
    fields: SafeTelemetryFields,
    operation: () => Promise<Result>,
  ): Promise<Result>;
  /** Execute synchronous work exactly once under an optional span and preserve its outcome. */
  spanSync<Result>(name: string, fields: SafeTelemetryFields, operation: () => Result): Result;
  /**
   * Execute request work exactly once under an optional server span.
   * Only W3C trace context may be extracted from the supplied hostile header carrier.
   */
  incomingSpan<Result>(
    name: string,
    headers: Record<string, string | string[] | undefined>,
    fields: SafeTelemetryFields,
    operation: () => Promise<Result>,
  ): Promise<Result>;
  /** Add a bounded event to the active span, if one exists. */
  event(name: string, fields?: SafeTelemetryFields): void;
  /** Add bounded fields to the active span without creating one. */
  setSpanFields(fields: SafeTelemetryFields): void;
  /** Mark the active span failed using only a bounded error classification. */
  markSpanError(type?: string): void;
  /** Observe the latest runtime-owned worker state. */
  setWorkerState(state: WorkerState): void;
  /** Observe one coherent snapshot of runtime-owned run state and bounded counters. */
  setRunState(
    state: ObservedRunState,
    epoch?: number,
    invocation?: number,
    queueDepth?: number,
  ): void;
  /** Observe the latest pending operator-message count without retaining message content. */
  setQueueDepth(depth: number): void;
  /** Count a completed worker startup using its already-decided recovery classification. */
  workerStarted(adoption: WorkerAdoption, mode?: WorkerMode): void;
  /** Count a runtime-owned durable terminal outcome without changing run state. */
  runOutcome(outcome: RunOutcome): void;
  /** Count a Pi-owned session opening or replacement without retaining session identity. */
  sessionOpened(outcome: SessionOpenOutcome): void;
  /** Count one settled Pi invocation and its non-negative duration. */
  invocationFinished(durationMs: number, outcome: InvocationOutcome, steered?: boolean): void;
  /**
   * Observe finalized provider-reported active-context usage.
   * Missing or invalid usage clears the gauge rather than introducing a local estimate or zero.
   */
  contextSample(
    tokens: number | null,
    contextWindow: number,
    epoch: number,
    invocation: number,
  ): void;
  /** Count a completed webhook routing decision using finite labels only. */
  webhook(outcome: WebhookOutcome, kind: WebhookKind): void;
  /** Count one completed request using a pre-normalized method and route template. */
  http(method: string, route: string, status: number, durationMs: number): void;
  /** Best-effort flush owned exporters within a hard deadline; never reject for sink failure. */
  forceFlush(timeoutMs?: number): Promise<void>;
  /** Best-effort stop owned signal resources within a hard deadline and flush process logs. */
  shutdown(timeoutMs?: number): Promise<void>;
}
