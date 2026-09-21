/**
 * Composes the internal logger, metric, trace, resource, and exporter owners for one telemetry
 * facade. Only telemetry depends on this SDK-facing layer; disabled setup constructs no exporters,
 * and every configured queue, batch, interval, and timeout remains inside hard process bounds.
 */

import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import type { SpanExporter } from "@opentelemetry/sdk-trace-node";
import type { DestinationStream } from "pino";
import {
  exporterSelected,
  telemetryIdentity,
  telemetryResource,
  type TelemetryIdentity,
} from "./configuration.js";
import type { TelemetrySignal } from "./contract.js";
import { wrapMetricExporter } from "./exporters.js";
import { JsonLogger } from "./logger.js";
import { RuntimeMetrics } from "./metrics.js";
import { boundedInteger } from "./safe-fields.js";
import { Tracing } from "./tracing.js";

/**
 * Dependencies and process configuration used to construct one observability facade.
 * Exporters and destinations are injected for ownership/testing only; credentials remain in the
 * OpenTelemetry environment and must never be projected into signals or returned components.
 */
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

/**
 * Signal owners created for one telemetry facade.
 * The facade is responsible for bounded flush/shutdown; absent metric owners mean metrics export
 * was disabled rather than partially initialized.
 */
export interface TelemetryComponents {
  identity: TelemetryIdentity;
  logger: JsonLogger;
  meterProvider: MeterProvider | undefined;
  metrics: RuntimeMetrics | undefined;
  traces: Tracing;
}

type ExportCodeReport = (signal: TelemetrySignal, resultCode: number) => void;

function sdkDisabled(options: TelemetryOptions, environment: NodeJS.ProcessEnv): boolean {
  return options.sdkDisabled === true || environment.OTEL_SDK_DISABLED?.toLowerCase() === "true";
}

function selectedTraceExporter(
  options: TelemetryOptions,
  environment: NodeJS.ProcessEnv,
): SpanExporter | undefined {
  if (options.traceExporter !== undefined) {
    return options.traceExporter;
  }
  return exporterSelected("traces", environment) ? new OTLPTraceExporter() : undefined;
}

function selectedMetricExporter(
  options: TelemetryOptions,
  environment: NodeJS.ProcessEnv,
): PushMetricExporter | undefined {
  if (options.metricExporter !== undefined) {
    return options.metricExporter;
  }
  return exporterSelected("metrics", environment) ? new OTLPMetricExporter() : undefined;
}

function createMetrics(
  serviceVersion: string,
  environment: NodeJS.ProcessEnv,
  resource: ReturnType<typeof telemetryResource>,
  exporter: PushMetricExporter | undefined,
  report: ExportCodeReport,
): Pick<TelemetryComponents, "meterProvider" | "metrics"> {
  if (exporter === undefined) {
    return { meterProvider: undefined, metrics: undefined };
  }
  const exportIntervalMillis = boundedInteger(
    environment.OTEL_METRIC_EXPORT_INTERVAL,
    60_000,
    1_000,
    3_600_000,
  );
  const exportTimeoutMillis = Math.min(
    exportIntervalMillis,
    boundedInteger(environment.OTEL_METRIC_EXPORT_TIMEOUT, 5_000, 100, 30_000),
  );
  const reader = new PeriodicExportingMetricReader({
    exporter: wrapMetricExporter(exporter, (signal, result) => {
      report(signal, result.code);
    }),
    exportIntervalMillis,
    exportTimeoutMillis,
    cardinalityLimits: { default: 64 },
    maxExportBatchSize: 128,
  });
  const meterProvider = new MeterProvider({ resource, readers: [reader] });
  return {
    meterProvider,
    metrics: new RuntimeMetrics(meterProvider, serviceVersion),
  };
}

function disabledTracing(serviceVersion: string, environment: NodeJS.ProcessEnv): Tracing {
  return new Tracing({
    serviceVersion,
    environment,
    resource: undefined,
    exporter: undefined,
    registerGlobal: false,
    disabled: true,
    report: () => undefined,
  });
}

/**
 * Create all signal owners for one telemetry facade.
 * Global SDK disablement is checked before resource or exporter construction, guaranteeing that
 * injected and environment-selected exporters remain untouched on the disabled path.
 */
export function initializeTelemetry(
  options: TelemetryOptions,
  report: ExportCodeReport,
): TelemetryComponents {
  const environment = options.env ?? process.env;
  const identity = telemetryIdentity(options.serviceVersion, options.command, environment);
  const logger = new JsonLogger(
    identity,
    environment,
    options.logDestination,
    options.logsEnabled !== false,
  );
  if (sdkDisabled(options, environment)) {
    return {
      identity,
      logger,
      meterProvider: undefined,
      metrics: undefined,
      traces: disabledTracing(options.serviceVersion, environment),
    };
  }
  const resource = telemetryResource(identity);
  const metricComponents = createMetrics(
    options.serviceVersion,
    environment,
    resource,
    selectedMetricExporter(options, environment),
    report,
  );
  const traces = new Tracing({
    serviceVersion: options.serviceVersion,
    environment,
    resource,
    exporter: selectedTraceExporter(options, environment),
    registerGlobal: options.registerGlobal !== false,
    disabled: false,
    report,
  });
  return { identity, logger, traces, ...metricComponents };
}

/**
 * Derive a logging-only fallback after signal initialization fails.
 * Injected exporters and global registration are deliberately removed so retry cannot repeat a
 * failing or secret-bearing exporter setup; only explicitly supplied safe logger ownership remains.
 */
export function disabledTelemetryOptions(options: TelemetryOptions): TelemetryOptions {
  return {
    serviceVersion: options.serviceVersion,
    env: { ...(options.env ?? process.env), OTEL_SDK_DISABLED: "true" },
    registerGlobal: false,
    sdkDisabled: true,
    ...(options.command === undefined ? {} : { command: options.command }),
    ...(options.logDestination === undefined ? {} : { logDestination: options.logDestination }),
    ...(options.logsEnabled === undefined ? {} : { logsEnabled: options.logsEnabled }),
  };
}
