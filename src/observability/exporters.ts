/**
 * Adapts third-party OpenTelemetry exporters to SEPT's fail-open observability contract. The SDK
 * setup layer owns these wrappers; they preserve exporter receiver semantics, bound waiting, and
 * prevent synchronous exporter/reporting failures from becoming worker lifecycle failures.
 */

import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type {
  AggregationOption,
  InstrumentType,
  PushMetricExporter,
  ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import type { TelemetrySignal } from "./contract.js";

type ExportReport = (signal: TelemetrySignal, result: ExportResult) => void;
type MetricAggregationSelector = (instrumentType: InstrumentType) => AggregationOption;
type MetricTemporalitySelector = PushMetricExporter["selectAggregationTemporality"];

/**
 * Settle advisory exporter work within a hard deadline.
 * Rejection and timeout are intentionally absorbed because durable run evidence, not collector
 * delivery, controls success; the timer is unreferenced and always cleared after settlement.
 */
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
  } catch {
    // Telemetry export is never lifecycle authority and cannot fail SEPT work.
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function reportSafely(report: ExportReport, signal: TelemetrySignal, result: ExportResult): void {
  try {
    report(signal, result);
  } catch {
    // A health reporter is part of telemetry and remains outside runtime authority.
  }
}

function failedExport(): ExportResult {
  return { code: ExportResultCode.FAILED };
}

function traceExport(
  exporter: SpanExporter,
  report: ExportReport,
  spans: ReadableSpan[],
  callback: (result: ExportResult) => void,
): void {
  try {
    exporter.export(spans, (result) => {
      reportSafely(report, "traces", result);
      callback(result);
    });
  } catch {
    const result = failedExport();
    reportSafely(report, "traces", result);
    callback(result);
  }
}

/**
 * Wrap a trace exporter so synchronous `export` failures become failed export callbacks.
 * The adapter preserves the exporter's `this` binding for optional flush ownership and reports
 * only a bounded signal/result classification, never exporter exception content.
 */
export function wrapTraceExporter(exporter: SpanExporter, report: ExportReport): SpanExporter {
  // Binding preserves optional exporter receiver semantics without an unsafe assertion.
  const forceFlush = exporter.forceFlush?.bind(exporter);
  return {
    export: (spans, callback): void => {
      traceExport(exporter, report, spans, callback);
    },
    ...(forceFlush === undefined ? {} : { forceFlush }),
    shutdown: () => exporter.shutdown(),
  };
}

function metricExport(
  exporter: PushMetricExporter,
  report: ExportReport,
  metrics: ResourceMetrics,
  callback: (result: ExportResult) => void,
): void {
  try {
    exporter.export(metrics, (result) => {
      reportSafely(report, "metrics", result);
      callback(result);
    });
  } catch {
    const result = failedExport();
    reportSafely(report, "metrics", result);
    callback(result);
  }
}

/**
 * Wrap a metric exporter so synchronous `export` failures become failed export callbacks.
 * Optional aggregation policies retain their exporter receiver, while reports expose no resource
 * metrics or exception details and cannot throw back into the SDK.
 */
export function wrapMetricExporter(
  exporter: PushMetricExporter,
  report: ExportReport,
): PushMetricExporter {
  // Binding is required because third-party exporters may use receiver-owned policy state.
  const selectAggregation: MetricAggregationSelector | undefined =
    exporter.selectAggregation?.bind(exporter);
  const selectAggregationTemporality: MetricTemporalitySelector =
    exporter.selectAggregationTemporality?.bind(exporter);
  return {
    export: (metrics, callback): void => {
      metricExport(exporter, report, metrics, callback);
    },
    forceFlush: () => exporter.forceFlush(),
    shutdown: () => exporter.shutdown(),
    ...(selectAggregation === undefined ? {} : { selectAggregation }),
    ...(selectAggregationTemporality === undefined ? {} : { selectAggregationTemporality }),
  };
}
