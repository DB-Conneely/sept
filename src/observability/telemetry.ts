import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type { SpanExporter } from "@opentelemetry/sdk-trace-node";
import type { DestinationStream } from "pino";
import { exporterSelected, telemetryIdentity, telemetryResource, type TelemetryIdentity } from "./configuration.js";
import type { LogLevel, Observability, ObservedRunState, SafeTelemetryFields, TelemetrySignal, WorkerState } from "./contract.js";
import { settleWithin, wrapMetricExporter } from "./exporters.js";
import { JsonLogger } from "./logger.js";
import { RuntimeMetrics } from "./metrics.js";
import { boundedInteger, errorType } from "./safe-fields.js";
import { Tracing } from "./tracing.js";

export interface TelemetryOptions {
  serviceVersion: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  traceExporter?: SpanExporter;
  metricExporter?: PushMetricExporter;
  logDestination?: DestinationStream;
  registerGlobal?: boolean;
  logsEnabled?: boolean;
  sdkDisabled?: boolean;
}

class Telemetry implements Observability {
  private readonly logger: JsonLogger;
  private readonly meterProvider?: MeterProvider;
  private readonly metrics?: RuntimeMetrics;
  private readonly traces: Tracing;
  private lastExportFailureLog = 0;
  readonly identity: TelemetryIdentity;

  constructor(options: TelemetryOptions) {
    const env = options.env ?? process.env;
    const sdkDisabled = options.sdkDisabled === true || env.OTEL_SDK_DISABLED?.toLowerCase() === "true";
    this.identity = telemetryIdentity(options.serviceVersion, options.command, env);
    this.logger = new JsonLogger(this.identity, env, options.logDestination, options.logsEnabled !== false);

    let exportReporter: (signal: TelemetrySignal, resultCode: number) => void = () => undefined;
    if (sdkDisabled) {
      this.traces = new Tracing(options.serviceVersion, env, undefined, undefined, false, true, exportReporter);
      return;
    }

    const traceExporter = options.traceExporter ?? (exporterSelected("traces", env) ? new OTLPTraceExporter() : undefined);
    const metricExporter = options.metricExporter ?? (exporterSelected("metrics", env) ? new OTLPMetricExporter() : undefined);
    const resource = telemetryResource(this.identity);

    if (metricExporter) {
      const exportIntervalMillis = boundedInteger(env.OTEL_METRIC_EXPORT_INTERVAL, 60_000, 1_000, 3_600_000);
      const exportTimeoutMillis = Math.min(exportIntervalMillis, boundedInteger(env.OTEL_METRIC_EXPORT_TIMEOUT, 5_000, 100, 30_000));
      const reader = new PeriodicExportingMetricReader({
        exporter: wrapMetricExporter(metricExporter, (signal, result) => exportReporter(signal, result.code)),
        exportIntervalMillis,
        exportTimeoutMillis,
        cardinalityLimits: { default: 64 },
        maxExportBatchSize: 128,
      });
      this.meterProvider = new MeterProvider({ resource, readers: [reader] });
      this.metrics = new RuntimeMetrics(this.meterProvider, options.serviceVersion);
    }

    this.traces = new Tracing(options.serviceVersion, env, resource, traceExporter, options.registerGlobal !== false, false, (signal, resultCode) => exportReporter(signal, resultCode));
    exportReporter = (signal, resultCode) => this.recordExport(signal, resultCode === 0 ? "success" : "failure");
  }

  log(lifecycle: string, fields: SafeTelemetryFields = {}, level: LogLevel = "info"): void { this.logger.write(lifecycle, fields, level); }

  span<T>(name: string, fields: SafeTelemetryFields, operation: () => Promise<T>): Promise<T> { return this.traces.span(name, fields, operation); }
  spanSync<T>(name: string, fields: SafeTelemetryFields, operation: () => T): T { return this.traces.spanSync(name, fields, operation); }
  incomingSpan<T>(name: string, headers: Record<string, string | string[] | undefined>, fields: SafeTelemetryFields, operation: () => Promise<T>): Promise<T> {
    return this.traces.incomingSpan(name, headers, fields, operation);
  }
  event(name: string, fields: SafeTelemetryFields = {}): void { this.traces.event(name, fields); }
  setSpanFields(fields: SafeTelemetryFields): void { this.traces.setFields(fields); }
  markSpanError(type = "Error"): void { this.traces.markError(type); }

  setWorkerState(state: WorkerState): void { this.metrics?.setWorkerState(state); }
  setRunState(state: ObservedRunState, epoch = 0, invocation = 0, queueDepth = 0): void { this.metrics?.setRunState(state, epoch, invocation, queueDepth); }
  setQueueDepth(depth: number): void { this.metrics?.setQueueDepth(depth); }
  workerStarted(adoption: "none" | "active" | "waiting" | "wake_recovered", mode: "worker" | "run" = "worker"): void { this.metrics?.workerStarted(adoption, mode); }
  runOutcome(outcome: "complete" | "blocked" | "failed"): void { this.metrics?.runOutcome(outcome); }
  sessionOpened(outcome: "started" | "resumed" | "replaced" | "successor_adopted"): void { this.metrics?.sessionOpened(outcome); }
  invocationFinished(durationMs: number, outcome: "success" | "failure" | "timeout", steered = false): void { this.metrics?.invocationFinished(durationMs, outcome, steered); }
  contextSample(tokens: number | null, contextWindow: number, epoch: number, invocation: number): void {
    const valid = tokens !== null && tokens > 0 && contextWindow > 0;
    const pressure = this.metrics?.setContextPressure(tokens, contextWindow) ?? (valid ? Math.min(1, tokens! / contextWindow) : undefined);
    const fields: SafeTelemetryFields = valid
      ? { "sept.context.tokens": tokens!, "sept.context.window": contextWindow, "sept.context.pressure": pressure, "sept.epoch": epoch, "sept.invocation": invocation }
      : { "sept.outcome": "deferred", "sept.epoch": epoch, "sept.invocation": invocation };
    this.event(valid ? "sept.context.sampled" : "sept.context.deferred", fields);
    this.log(valid ? "context.sampled" : "context.deferred", fields);
  }
  webhook(outcome: "accepted" | "duplicate" | "collision" | "rejected", kind: "task" | "operator_message" | "unknown"): void { this.metrics?.webhook(outcome, kind); }
  http(method: string, route: string, status: number, durationMs: number): void { this.metrics?.http(method, route, status, durationMs); }

  private recordExport(signal: TelemetrySignal, outcome: "success" | "failure"): void {
    this.metrics?.export(outcome, signal);
    if (outcome === "failure" && Date.now() - this.lastExportFailureLog >= 60_000) {
      this.lastExportFailureLog = Date.now();
      this.log("telemetry.export", { "telemetry.signal": signal, "sept.outcome": outcome }, "warn");
    }
  }

  async forceFlush(timeoutMs = 5_000): Promise<void> {
    const pending = Promise.all([this.traces.forceFlush(timeoutMs), this.meterProvider?.forceFlush({ timeoutMillis: timeoutMs })]);
    await settleWithin(pending, timeoutMs);
  }

  async shutdown(timeoutMs = 2_000): Promise<void> {
    this.setWorkerState("stopped");
    this.log("telemetry.shutdown", { "sept.outcome": "started" });
    const pending = Promise.all([this.traces.shutdown(), this.meterProvider?.shutdown()]);
    await settleWithin(pending, timeoutMs);
    this.logger.flush();
  }
}


export const NOOP_TELEMETRY: Observability = new Telemetry({ serviceVersion: "0", logsEnabled: false, registerGlobal: false, sdkDisabled: true });

export function createTelemetry(options: TelemetryOptions): Observability {
  try { return new Telemetry(options); }
  catch (error) {
    try {
      const telemetry = new Telemetry({ ...options, env: { ...(options.env ?? process.env), OTEL_SDK_DISABLED: "true" }, traceExporter: undefined, metricExporter: undefined, sdkDisabled: true });
      telemetry.log("telemetry.initialization", { "sept.outcome": "failure", "error.type": errorType(error) }, "warn");
      return telemetry;
    } catch { return NOOP_TELEMETRY; }
  }
}

export function classifyError(error: unknown): string { return errorType(error); }
