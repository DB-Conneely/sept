import type { ExportResult } from "@opentelemetry/core";
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import type { TelemetrySignal } from "./contract.js";

export async function settleWithin(pending: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
  } catch {} finally {
    if (timer) clearTimeout(timer);
  }
}

export function wrapTraceExporter(exporter: SpanExporter, report: (signal: TelemetrySignal, result: ExportResult) => void): SpanExporter {
  return {
    export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
      try {
        exporter.export(spans, (result) => { try { report("traces", result); } catch {} callback(result); });
      } catch {
        const result = { code: 1 } as ExportResult;
        try { report("traces", result); } catch {}
        callback(result);
      }
    },
    forceFlush: exporter.forceFlush ? () => exporter.forceFlush!() : undefined,
    shutdown: () => exporter.shutdown(),
  };
}

export function wrapMetricExporter(exporter: PushMetricExporter, report: (signal: TelemetrySignal, result: ExportResult) => void): PushMetricExporter {
  return {
    export(metrics, callback): void {
      try {
        exporter.export(metrics, (result) => { try { report("metrics", result); } catch {} callback(result); });
      } catch {
        const result = { code: 1 } as ExportResult;
        try { report("metrics", result); } catch {}
        callback(result);
      }
    },
    forceFlush: () => exporter.forceFlush(),
    shutdown: () => exporter.shutdown(),
    selectAggregation: exporter.selectAggregation?.bind(exporter),
    selectAggregationTemporality: exporter.selectAggregationTemporality?.bind(exporter),
  };
}
