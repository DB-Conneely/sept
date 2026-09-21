/**
 * Implements the provider-neutral observability facade used by SEPT runtime mechanisms. It owns
 * signal lifecycle through setup and delegates to focused log/metric/trace adapters; all signal
 * work is bounded and advisory, while wrapped business operations retain exactly-once authority.
 */

import type { MeterProvider } from "@opentelemetry/sdk-metrics";
import type { TelemetryIdentity } from "./configuration.js";
import type {
  InvocationOutcome,
  LogLevel,
  Observability,
  ObservedRunState,
  RunOutcome,
  SafeTelemetryFields,
  SessionOpenOutcome,
  TelemetrySignal,
  WebhookKind,
  WebhookOutcome,
  WorkerAdoption,
  WorkerMode,
  WorkerState,
} from "./contract.js";
import { settleWithin } from "./exporters.js";
import type { JsonLogger } from "./logger.js";
import type { RuntimeMetrics } from "./metrics.js";
import { errorType } from "./safe-fields.js";
import { disabledTelemetryOptions, initializeTelemetry, type TelemetryOptions } from "./setup.js";
import type { Tracing } from "./tracing.js";

type ExportCodeReport = (signal: TelemetrySignal, resultCode: number) => void;

type AdvisoryOperation = () => Promise<void> | undefined;

function runAdvisoryOperation(operation: AdvisoryOperation): Promise<void> {
  try {
    return operation() ?? Promise.resolve();
  } catch {
    // Some SDK/exporter implementations throw before returning a promise; shutdown stays fail-open.
    return Promise.resolve();
  }
}

/**
 * Construction options for the public observability facade.
 * The setup module owns their interpretation; callers do not acquire SDK lifecycle ownership.
 */
export type { TelemetryOptions } from "./setup.js";

class Telemetry implements Observability {
  readonly identity: TelemetryIdentity;
  private readonly logger: JsonLogger;
  private readonly meterProvider: MeterProvider | undefined;
  private readonly metrics: RuntimeMetrics | undefined;
  private readonly traces: Tracing;
  private lastExportFailureLog = 0;

  constructor(options: TelemetryOptions) {
    // Exporters can be third-party code; ignore any report emitted before owners are assigned.
    let activeReport: ExportCodeReport = () => undefined;
    const components = initializeTelemetry(options, (signal, resultCode) => {
      activeReport(signal, resultCode);
    });
    this.identity = components.identity;
    this.logger = components.logger;
    this.meterProvider = components.meterProvider;
    this.metrics = components.metrics;
    this.traces = components.traces;
    activeReport = (signal, resultCode) => {
      this.recordExport(signal, resultCode === 0 ? "success" : "failure");
    };
  }

  log(lifecycle: string, fields: SafeTelemetryFields = {}, level: LogLevel = "info"): void {
    this.logger.write(lifecycle, fields, level);
  }

  span<Result>(
    name: string,
    fields: SafeTelemetryFields,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return this.traces.span(name, fields, operation);
  }

  spanSync<Result>(name: string, fields: SafeTelemetryFields, operation: () => Result): Result {
    return this.traces.spanSync(name, fields, operation);
  }

  incomingSpan<Result>(
    name: string,
    headers: Record<string, string | string[] | undefined>,
    fields: SafeTelemetryFields,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return this.traces.incomingSpan(name, headers, fields, operation);
  }

  event(name: string, fields: SafeTelemetryFields = {}): void {
    this.traces.event(name, fields);
  }

  setSpanFields(fields: SafeTelemetryFields): void {
    this.traces.setFields(fields);
  }

  markSpanError(type = "Error"): void {
    this.traces.markError(type);
  }

  setWorkerState(state: WorkerState): void {
    this.metrics?.setWorkerState(state);
  }

  setRunState(state: ObservedRunState, epoch = 0, invocation = 0, queueDepth = 0): void {
    this.metrics?.setRunState(state, epoch, invocation, queueDepth);
  }

  setQueueDepth(depth: number): void {
    this.metrics?.setQueueDepth(depth);
  }

  workerStarted(adoption: WorkerAdoption, mode: WorkerMode = "worker"): void {
    this.metrics?.workerStarted(adoption, mode);
  }

  runOutcome(outcome: RunOutcome): void {
    this.metrics?.runOutcome(outcome);
  }

  sessionOpened(outcome: SessionOpenOutcome): void {
    this.metrics?.sessionOpened(outcome);
  }

  invocationFinished(durationMs: number, outcome: InvocationOutcome, steered = false): void {
    this.metrics?.invocationFinished(durationMs, outcome, steered);
  }

  contextSample(
    tokens: number | null,
    contextWindow: number,
    epoch: number,
    invocation: number,
  ): void {
    const valid = tokens !== null && tokens > 0 && contextWindow > 0;
    if (!valid) {
      this.publishDeferredContext(epoch, invocation);
      return;
    }
    const pressure =
      this.metrics?.setContextPressure(tokens, contextWindow) ??
      Math.min(1, tokens / contextWindow);
    const fields: SafeTelemetryFields = {
      "sept.context.tokens": tokens,
      "sept.context.window": contextWindow,
      "sept.context.pressure": pressure,
      "sept.epoch": epoch,
      "sept.invocation": invocation,
    };
    this.event("sept.context.sampled", fields);
    this.log("context.sampled", fields);
  }

  webhook(outcome: WebhookOutcome, kind: WebhookKind): void {
    this.metrics?.webhook(outcome, kind);
  }

  http(method: string, route: string, status: number, durationMs: number): void {
    this.metrics?.http(method, route, status, durationMs);
  }

  async forceFlush(timeoutMs = 5_000): Promise<void> {
    // Start owners independently so one synchronous SDK failure cannot skip the other flush.
    const pending = Promise.all([
      runAdvisoryOperation(() => this.traces.forceFlush(timeoutMs)),
      runAdvisoryOperation(() => this.meterProvider?.forceFlush({ timeoutMillis: timeoutMs })),
    ]);
    await settleWithin(pending, timeoutMs);
  }

  async shutdown(timeoutMs = 2_000): Promise<void> {
    this.setWorkerState("stopped");
    this.log("telemetry.shutdown", { "sept.outcome": "started" });
    // Signal owners shut down independently; neither may prevent final process-log flushing.
    const pending = Promise.all([
      runAdvisoryOperation(() => this.traces.shutdown()),
      runAdvisoryOperation(() => this.meterProvider?.shutdown()),
    ]);
    await settleWithin(pending, timeoutMs);
    this.logger.flush();
  }

  private publishDeferredContext(epoch: number, invocation: number): void {
    this.metrics?.setContextPressure(null, 0);
    const fields: SafeTelemetryFields = {
      "sept.outcome": "deferred",
      "sept.epoch": epoch,
      "sept.invocation": invocation,
    };
    this.event("sept.context.deferred", fields);
    this.log("context.deferred", fields);
  }

  private recordExport(signal: TelemetrySignal, outcome: "success" | "failure"): void {
    this.metrics?.export(outcome, signal);
    const failureLogDue = Date.now() - this.lastExportFailureLog >= 60_000;
    if (outcome !== "failure" || !failureLogDue) {
      return;
    }
    this.lastExportFailureLog = Date.now();
    this.log("telemetry.export", { "telemetry.signal": signal, "sept.outcome": outcome }, "warn");
  }
}

/**
 * Shared disabled facade for dependency defaults.
 * It owns no SDK provider, exporter, logger destination, or global registration and therefore has
 * no signal side effects while still preserving exactly-once wrapped-operation semantics.
 */
export const NOOP_TELEMETRY: Observability = new Telemetry({
  serviceVersion: "0",
  logsEnabled: false,
  registerGlobal: false,
  sdkDisabled: true,
});

/**
 * Construct the observability facade without making initialization a worker startup dependency.
 * Full setup falls back once to logging-only with injected exporters removed, then to the shared
 * no-op; failures are reduced to bounded type classification and this function never throws.
 */
export function createTelemetry(options: TelemetryOptions): Observability {
  try {
    return new Telemetry(options);
  } catch (error) {
    try {
      const telemetry = new Telemetry(disabledTelemetryOptions(options));
      telemetry.log(
        "telemetry.initialization",
        { "sept.outcome": "failure", "error.type": errorType(error) },
        "warn",
      );
      return telemetry;
    } catch {
      return NOOP_TELEMETRY;
    }
  }
}

/**
 * Convert an unknown failure to the bounded classification used by telemetry callers.
 * This public boundary never returns exception messages, stacks, causes, or hostile thrown data.
 */
export function classifyError(error: unknown): string {
  return errorType(error);
}
