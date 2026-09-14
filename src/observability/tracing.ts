import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Span,
  type TextMapGetter,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type { Resource } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider, type SpanExporter } from "@opentelemetry/sdk-trace-node";
import type { SafeTelemetryFields, TelemetrySignal } from "./contract.js";
import { wrapTraceExporter } from "./exporters.js";
import { boundedInteger, boundedString, errorType, safeAttributes } from "./safe-fields.js";

const TRACE_HEADER_GETTER: TextMapGetter<Record<string, string | string[] | undefined>> = {
  keys: (carrier) => ["traceparent", "tracestate"].filter((key) => carrier[key] !== undefined),
  get: (carrier, key) => {
    const normalized = key.toLowerCase();
    return normalized === "traceparent" || normalized === "tracestate" ? carrier[normalized] : undefined;
  },
};

export class Tracing {
  private readonly provider?: NodeTracerProvider;
  private readonly tracer;

  constructor(
    serviceVersion: string,
    env: NodeJS.ProcessEnv,
    resource: Resource | undefined,
    exporter: SpanExporter | undefined,
    registerGlobal: boolean,
    private readonly disabled: boolean,
    report: (signal: TelemetrySignal, resultCode: number) => void,
  ) {
    if (disabled || !exporter || !resource) {
      this.tracer = trace.getTracer(disabled ? "sept-disabled" : "sept", serviceVersion);
      return;
    }
    const maxQueueSize = boundedInteger(env.OTEL_BSP_MAX_QUEUE_SIZE, 512, 64, 4096);
    const processor = new BatchSpanProcessor(wrapTraceExporter(exporter, (signal, result) => report(signal, result.code)), {
      maxQueueSize,
      maxExportBatchSize: Math.min(maxQueueSize, boundedInteger(env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE, 128, 1, 512)),
      scheduledDelayMillis: boundedInteger(env.OTEL_BSP_SCHEDULE_DELAY, 2_000, 100, 60_000),
      exportTimeoutMillis: boundedInteger(env.OTEL_BSP_EXPORT_TIMEOUT, 5_000, 100, 30_000),
    });
    this.provider = new NodeTracerProvider({
      resource,
      spanProcessors: [processor],
      spanLimits: { attributeCountLimit: 24, attributeValueLengthLimit: 128, eventCountLimit: 32, attributePerEventCountLimit: 16, linkCountLimit: 0 },
    });
    if (registerGlobal) this.provider.register({ propagator: new W3CTraceContextPropagator() });
    this.tracer = this.provider.getTracer("sept", serviceVersion);
  }

  async span<T>(name: string, fields: SafeTelemetryFields, operation: () => Promise<T>, kind: SpanKind = SpanKind.INTERNAL): Promise<T> {
    if (this.disabled) return operation();
    let entered = false;
    try {
      return await this.tracer.startActiveSpan(name, { kind, attributes: safeAttributes(fields) }, async (span) => {
        entered = true;
        try { return await operation(); }
        catch (error) { markError(span, error); throw error; }
        finally { try { span.end(); } catch {} }
      });
    } catch (error) {
      if (!entered) return operation();
      throw error;
    }
  }

  spanSync<T>(name: string, fields: SafeTelemetryFields, operation: () => T, kind: SpanKind = SpanKind.INTERNAL): T {
    if (this.disabled) return operation();
    let entered = false;
    try {
      return this.tracer.startActiveSpan(name, { kind, attributes: safeAttributes(fields) }, (span) => {
        entered = true;
        try { return operation(); }
        catch (error) { markError(span, error); throw error; }
        finally { try { span.end(); } catch {} }
      });
    } catch (error) {
      if (!entered) return operation();
      throw error;
    }
  }

  async incomingSpan<T>(name: string, headers: Record<string, string | string[] | undefined>, fields: SafeTelemetryFields, operation: () => Promise<T>): Promise<T> {
    if (this.disabled) return operation();
    let parent = ROOT_CONTEXT;
    try { parent = propagation.extract(ROOT_CONTEXT, { traceparent: headers.traceparent, tracestate: headers.tracestate }, TRACE_HEADER_GETTER); } catch {}
    let entered = false;
    try { return await context.with(parent, () => { entered = true; return this.span(name, fields, operation, SpanKind.SERVER); }); }
    catch (error) {
      if (!entered) return operation();
      throw error;
    }
  }

  event(name: string, fields: SafeTelemetryFields): void { try { if (!this.disabled) trace.getSpan(context.active())?.addEvent(name, safeAttributes(fields)); } catch {} }
  setFields(fields: SafeTelemetryFields): void { try { if (!this.disabled) trace.getSpan(context.active())?.setAttributes(safeAttributes(fields)); } catch {} }
  markError(type: string): void {
    try {
      if (this.disabled) return;
      const span = trace.getSpan(context.active());
      span?.setStatus({ code: SpanStatusCode.ERROR });
      span?.setAttribute("error.type", boundedString(type, "Error", 64));
    } catch {}
  }
  forceFlush(timeoutMs: number): Promise<void> | undefined { return this.provider?.forceFlush({ timeoutMillis: timeoutMs }); }
  shutdown(): Promise<void> | undefined { return this.provider?.shutdown(); }
}

function markError(span: Span, error: unknown): void {
  try { span.setStatus({ code: SpanStatusCode.ERROR }); span.setAttribute("error.type", errorType(error)); } catch {}
}
