/**
 * Owns OpenTelemetry provider registration, bounded span processing, and W3C parent extraction.
 * The facade depends on this SDK adapter, never business mechanisms; instrumentation failures are
 * contained and each wrapped operation must run exactly once with its original outcome preserved.
 */

import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Context,
  type Span,
  type SpanOptions,
  type TextMapGetter,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type { Resource } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-node";
import type { SafeTelemetryFields, TelemetrySignal } from "./contract.js";
import { wrapTraceExporter } from "./exporters.js";
import { boundedInteger, boundedString, errorType, safeAttributes } from "./safe-fields.js";

type TraceHeaderCarrier = Record<string, string | string[] | undefined>;
type TraceExportReport = (signal: TelemetrySignal, resultCode: number) => void;

interface ActiveTracer {
  startActiveSpan<Result>(
    name: string,
    options: SpanOptions,
    operation: (span: Span) => Result,
  ): Result;
}

interface TracingOptions {
  serviceVersion: string;
  environment: NodeJS.ProcessEnv;
  resource: Resource | undefined;
  exporter: SpanExporter | undefined;
  registerGlobal: boolean;
  disabled: boolean;
  report: TraceExportReport;
  tracer?: ActiveTracer;
}

type SyncOutcome<Result> =
  | { kind: "not_started" }
  | { kind: "returned"; value: Result }
  | { kind: "threw"; error: unknown };

const TRACE_HEADER_GETTER: TextMapGetter<TraceHeaderCarrier> = {
  keys: (carrier) => ["traceparent", "tracestate"].filter((key) => carrier[key] !== undefined),
  get: (carrier, key) => {
    const normalized = key.toLowerCase();
    if (normalized !== "traceparent" && normalized !== "tracestate") {
      return undefined;
    }
    return carrier[normalized];
  },
};

function batchProcessor(options: TracingOptions, exporter: SpanExporter): BatchSpanProcessor {
  // Hard caps isolate collector backpressure from the single resident worker slot.
  const maxQueueSize = boundedInteger(options.environment.OTEL_BSP_MAX_QUEUE_SIZE, 512, 64, 4_096);
  return new BatchSpanProcessor(
    wrapTraceExporter(exporter, (signal, result) => {
      options.report(signal, result.code);
    }),
    {
      maxQueueSize,
      maxExportBatchSize: Math.min(
        maxQueueSize,
        boundedInteger(options.environment.OTEL_BSP_MAX_EXPORT_BATCH_SIZE, 128, 1, 512),
      ),
      scheduledDelayMillis: boundedInteger(
        options.environment.OTEL_BSP_SCHEDULE_DELAY,
        2_000,
        100,
        60_000,
      ),
      exportTimeoutMillis: boundedInteger(
        options.environment.OTEL_BSP_EXPORT_TIMEOUT,
        5_000,
        100,
        30_000,
      ),
    },
  );
}

function configuredProvider(options: TracingOptions): NodeTracerProvider | undefined {
  const exporter = options.exporter;
  const resource = options.resource;
  if (options.disabled || exporter === undefined || resource === undefined) {
    return undefined;
  }
  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [batchProcessor(options, exporter)],
    spanLimits: {
      attributeCountLimit: 24,
      attributeValueLengthLimit: 128,
      eventCountLimit: 32,
      attributePerEventCountLimit: 16,
      linkCountLimit: 0,
    },
  });
  if (options.registerGlobal) {
    provider.register({ propagator: new W3CTraceContextPropagator() });
  }
  return provider;
}

function markError(span: Span, error: unknown): void {
  try {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute("error.type", errorType(error));
  } catch {
    // Span mutation is advisory and cannot replace the operation's original failure.
  }
}

function endSpan(span: Span): void {
  try {
    span.end();
  } catch {
    // Exporter or SDK failure cannot alter the operation result.
  }
}

async function executeAsync<Result>(span: Span, operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    markError(span, error);
    throw error;
  } finally {
    endSpan(span);
  }
}

function executeSync<Result>(
  span: Span,
  operation: () => Result,
  record: (outcome: SyncOutcome<Result>) => void,
): Result {
  try {
    const value = operation();
    record({ kind: "returned", value });
    return value;
  } catch (error) {
    record({ kind: "threw", error });
    markError(span, error);
    throw error;
  } finally {
    endSpan(span);
  }
}

function preserveSyncOutcome<Result>(
  outcome: SyncOutcome<Result>,
  operation: () => Result,
): Result {
  switch (outcome.kind) {
    case "returned":
      return outcome.value;
    case "threw":
      throw outcome.error;
    case "not_started":
      return operation();
  }
}

function extractedParent(headers: TraceHeaderCarrier): Context {
  try {
    // Only W3C trace context is accepted; authorization, baggage, and payload headers stay out.
    return propagation.extract(
      ROOT_CONTEXT,
      { traceparent: headers.traceparent, tracestate: headers.tracestate },
      TRACE_HEADER_GETTER,
    );
  } catch {
    return ROOT_CONTEXT;
  }
}

/**
 * Owns bounded OpenTelemetry span creation and W3C request-context propagation.
 * It may own a private provider or use the global no-export tracer, but never owns the wrapped
 * operation: SDK/context failures are advisory and cannot duplicate or replace operation results.
 */
export class Tracing {
  private readonly disabled: boolean;
  private readonly provider: NodeTracerProvider | undefined;
  private readonly tracer: ActiveTracer;

  constructor(options: TracingOptions) {
    this.disabled = options.disabled;
    this.provider = configuredProvider(options);
    const tracerName = options.disabled ? "sept-disabled" : "sept";
    // Explicit injection isolates the SDK callback adapter while provider lifecycle stays local.
    this.tracer =
      options.tracer ??
      this.provider?.getTracer("sept", options.serviceVersion) ??
      trace.getTracer(tracerName, options.serviceVersion);
  }

  /**
   * Run one asynchronous operation in an optional active span.
   * If SDK entry fails, the operation runs uninstrumented; if failure occurs after entry, the
   * captured operation promise preserves its single execution and original resolution/rejection.
   */
  async span<Result>(
    name: string,
    fields: SafeTelemetryFields,
    operation: () => Promise<Result>,
    kind: SpanKind = SpanKind.INTERNAL,
  ): Promise<Result> {
    if (this.disabled) {
      return operation();
    }
    let execution: Promise<Result> | undefined;
    try {
      const instrumented = this.tracer.startActiveSpan(
        name,
        { kind, attributes: safeAttributes(fields) },
        (span) => {
          execution = executeAsync(span, operation);
          return execution;
        },
      );
      return await instrumented;
    } catch {
      // A captured promise proves callback entry, so retrying here would duplicate business work.
      return execution ?? operation();
    }
  }

  /**
   * Run one synchronous operation in an optional active span.
   * A recorded callback outcome wins over any later SDK throw, preserving the operation's exact
   * return value or original thrown value without a second execution.
   */
  spanSync<Result>(
    name: string,
    fields: SafeTelemetryFields,
    operation: () => Result,
    kind: SpanKind = SpanKind.INTERNAL,
  ): Result {
    if (this.disabled) {
      return operation();
    }
    let outcome: SyncOutcome<Result> = { kind: "not_started" };
    try {
      this.tracer.startActiveSpan(name, { kind, attributes: safeAttributes(fields) }, (span) =>
        executeSync(span, operation, (completed) => {
          outcome = completed;
        }),
      );
    } catch {
      // Outcome settlement below distinguishes SDK entry failure from operation failure.
    }
    return preserveSyncOutcome(outcome, operation);
  }

  /**
   * Run one HTTP operation under a validated W3C parent and optional server span.
   * Malformed context falls back to root, only trace headers are projected, and a captured
   * operation promise prevents context-manager failure from duplicating request handling.
   */
  async incomingSpan<Result>(
    name: string,
    headers: TraceHeaderCarrier,
    fields: SafeTelemetryFields,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    if (this.disabled) {
      return operation();
    }
    let execution: Promise<Result> | undefined;
    try {
      const instrumented = context.with(extractedParent(headers), () => {
        execution = this.span(name, fields, operation, SpanKind.SERVER);
        return execution;
      });
      return await instrumented;
    } catch {
      // Context failure before callback entry is the only case where work has not started.
      return execution ?? operation();
    }
  }

  /** Add one bounded event to the active span when present. */
  event(name: string, fields: SafeTelemetryFields): void {
    try {
      if (!this.disabled) {
        trace.getSpan(context.active())?.addEvent(name, safeAttributes(fields));
      }
    } catch {
      // Span events are advisory and may be dropped independently of run evidence.
    }
  }

  /** Add allowlisted bounded fields to the active span when present. */
  setFields(fields: SafeTelemetryFields): void {
    try {
      if (!this.disabled) {
        trace.getSpan(context.active())?.setAttributes(safeAttributes(fields));
      }
    } catch {
      // Attribute mutation is advisory and cannot affect worker behavior.
    }
  }

  /** Mark the active span failed using a bounded classification, never exception text. */
  markError(type: string): void {
    try {
      if (this.disabled) {
        return;
      }
      const span = trace.getSpan(context.active());
      span?.setStatus({ code: SpanStatusCode.ERROR });
      span?.setAttribute("error.type", boundedString(type, "Error", 64));
    } catch {
      // Span status is non-authoritative and may be dropped.
    }
  }

  /**
   * Request a provider flush bounded by the caller's deadline.
   * The facade contains synchronous throws, rejection, and timeout; absence means no owned provider.
   */
  forceFlush(timeoutMs: number): Promise<void> | undefined {
    return this.provider?.forceFlush({ timeoutMillis: timeoutMs });
  }

  /**
   * Shut down the provider only when this instance created one.
   * The facade owns failure containment and ensures this advisory cleanup cannot block worker exit.
   */
  shutdown(): Promise<void> | undefined {
    return this.provider?.shutdown();
  }
}
