/**
 * Verifies observability's internal safety boundaries independently of worker orchestration. The
 * suite owns hostile-value and failing-exporter fixtures and proves bounded projection, disabled
 * construction, receiver preservation, deadline containment, and credential/payload exclusion.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ExportResultCode } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, type SpanExporter } from "@opentelemetry/sdk-trace-node";
import {
  exporterSelected,
  telemetryIdentity,
  telemetryResource,
} from "../../src/observability/configuration.js";
import {
  settleWithin,
  wrapMetricExporter,
  wrapTraceExporter,
} from "../../src/observability/exporters.js";
import {
  createTelemetry,
  NOOP_TELEMETRY,
  type Observability,
} from "../../src/observability/index.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { RuntimeMetrics } from "../../src/observability/metrics.js";
import {
  boundedInteger,
  boundedString,
  errorType,
  logFields,
  safeAttributes,
} from "../../src/observability/safe-fields.js";
import { disabledTelemetryOptions, initializeTelemetry } from "../../src/observability/setup.js";
import { classifyError } from "../../src/observability/telemetry.js";
import { Tracing } from "../../src/observability/tracing.js";
import { ObservabilityFixtureError } from "./support.js";

void test("safe fields and process configuration retain only bounded operational identity", async () => {
  assert.equal(boundedString(" worker ", "fallback", 16), "worker");
  assert.equal(boundedString("unsafe\nvalue", "fallback", 16), "fallback");
  assert.equal(boundedInteger("128", 64, 1, 512), 128);
  assert.equal(boundedInteger("1.5", 64, 1, 512), 64);
  const attributes = safeAttributes({
    "sept.outcome": "success",
    "sept.run.id": "bounded-run",
    payload: "TOP-SECRET-PAYLOAD",
    duration_ms: Number.POSITIVE_INFINITY,
  });
  assert.deepEqual(attributes, { "sept.outcome": "success", "sept.run.id": "bounded-run" });
  assert.deepEqual(
    safeAttributes({
      "sept.outcome": "unsafe\nlabel",
      "sept.run.id": "x".repeat(129),
    }),
    { "sept.outcome": "unknown", "sept.run.id": "unknown" },
  );
  assert.deepEqual(logFields({ "sept.outcome": "success" }), { sept_outcome: "success" });
  const classified = new ObservabilityFixtureError("TOP-SECRET-ERROR");
  assert.equal(errorType(classified), "ObservabilityFixtureError");
  assert.equal(classifyError(classified), "ObservabilityFixtureError");

  const environment = {
    OTEL_SERVICE_NAME: "sept-test",
    SEPT_WORKER_ID: "worker-safe",
    OTEL_RESOURCE_ATTRIBUTES:
      "service.namespace=tests,container.name=worker,unsafe.payload=TOP-SECRET-RESOURCE",
  };
  const identity = telemetryIdentity("1.0.0", "worker", environment);
  const resource = telemetryResource(identity);
  assert.equal(identity.instanceId, `worker-safe:${String(process.pid)}`);
  assert.equal(resource.attributes["service.name"], "sept-test");
  assert.equal(resource.attributes["unsafe.payload"], undefined);
  assert.equal(exporterSelected("traces", { OTEL_TRACES_EXPORTER: "otlp" }), true);
  assert.equal(exporterSelected("metrics", { OTEL_SDK_DISABLED: "true" }), false);
  await settleWithin(Promise.reject(classified), 25);
});

void test("disabled setup constructs no exporters and retains only safe logger ownership", async () => {
  const options = disabledTelemetryOptions({
    serviceVersion: "test",
    logsEnabled: false,
    traceExporter: new InMemorySpanExporter(),
    metricExporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
  });
  const components = initializeTelemetry(options, () => undefined);
  assert.ok(components.logger instanceof JsonLogger);
  assert.ok(components.traces instanceof Tracing);
  assert.equal(components.metrics, undefined);
  assert.equal(components.meterProvider, undefined);
  await components.traces.shutdown();

  const meterProvider = new MeterProvider();
  const metrics = new RuntimeMetrics(meterProvider, "test");
  metrics.setWorkerState("idle");
  metrics.setRunState("active", 1, 2, 3);
  metrics.setQueueDepth(4);
  metrics.workerStarted("none", "worker");
  metrics.runOutcome("complete");
  metrics.sessionOpened("started");
  metrics.invocationFinished(10, "success", false);
  metrics.setContextPressure(25, 100);
  metrics.webhook("accepted", "task");
  metrics.http("GET", "/health", 200, 5);
  metrics.export("success", "metrics");
  await meterProvider.shutdown();
});

async function verifyTraceWrapper(): Promise<void> {
  let receiverPreserved = false;
  const exporter: SpanExporter = {
    export(_spans, callback): void {
      callback({ code: ExportResultCode.SUCCESS });
    },
    forceFlush(): Promise<void> {
      receiverPreserved = this === exporter;
      return Promise.resolve();
    },
    shutdown: () => Promise.resolve(),
  };
  const results: number[] = [];
  const wrapped = wrapTraceExporter(exporter, (_signal, result) => {
    results.push(result.code);
  });
  wrapped.export([], (result) => {
    results.push(result.code);
  });
  await wrapped.forceFlush?.();
  assert.equal(receiverPreserved, true);
  assert.deepEqual(results, [ExportResultCode.SUCCESS, ExportResultCode.SUCCESS]);
}

async function verifyMetricWrapper(): Promise<void> {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const wrapped = wrapMetricExporter(exporter, () => undefined);
  const resourceMetrics: ResourceMetrics = {
    resource: resourceFromAttributes({}),
    scopeMetrics: [],
  };
  const resultCode = await new Promise<number>((resolve) => {
    wrapped.export(resourceMetrics, (result) => {
      resolve(result.code);
    });
  });
  assert.equal(resultCode, ExportResultCode.SUCCESS);
  await wrapped.shutdown();
}

async function verifyFailedTraceWrapper(): Promise<void> {
  const exporter: SpanExporter = {
    export(): void {
      throw new ObservabilityFixtureError("TOP-SECRET-EXPORT");
    },
    shutdown: () => Promise.resolve(),
  };
  const resultCode = await new Promise<number>((resolve) => {
    wrapTraceExporter(exporter, () => undefined).export([], (result) => {
      resolve(result.code);
    });
  });
  assert.equal(resultCode, ExportResultCode.FAILED);
}

void test("export wrappers preserve receivers and contain synchronous exporter failures", async () => {
  await verifyTraceWrapper();
  await verifyMetricWrapper();
  await verifyFailedTraceWrapper();
});

async function exerciseDisabledSpans(telemetry: Observability): Promise<number> {
  let operations = 0;
  await telemetry.span("disabled", {}, () => {
    operations += 1;
    return Promise.resolve();
  });
  await NOOP_TELEMETRY.span("noop", {}, () => {
    operations += 1;
    return Promise.resolve();
  });
  return operations;
}

void test("SDK-disabled telemetry and the shared no-op never touch configured exporters", async () => {
  let traceExports = 0;
  let metricExports = 0;
  const traceExporter = {
    export(): void {
      traceExports += 1;
    },
    shutdown: () => Promise.resolve(),
  };
  const metricExporter = {
    export(): void {
      metricExports += 1;
    },
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  };
  const disabled = createTelemetry({
    serviceVersion: "test-version",
    sdkDisabled: true,
    logsEnabled: false,
    traceExporter,
    metricExporter,
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid:4318",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
    },
  });
  const operations = await exerciseDisabledSpans(disabled);
  await disabled.forceFlush(50);
  assert.equal(operations, 2);
  assert.equal(traceExports, 0);
  assert.equal(metricExports, 0);
  await disabled.shutdown(50);
});

void test("deferred provider usage leaves context pressure absent until a valid sample", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const telemetry = createTelemetry({
    serviceVersion: "test-version",
    env: {},
    logsEnabled: false,
    metricExporter: exporter,
    registerGlobal: false,
  });
  telemetry.contextSample(null, 100, 1, 1);
  await telemetry.forceFlush();
  let metrics = exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
  assert.equal(
    metrics.some((metric) => metric.descriptor.name === "sept.pi.context.pressure"),
    false,
  );
  telemetry.contextSample(25, 100, 1, 2);
  await telemetry.forceFlush();
  metrics = exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
  assert.equal(
    metrics.some((metric) => metric.descriptor.name === "sept.pi.context.pressure"),
    true,
  );
  await telemetry.shutdown();
});

void test("exporter exceptions are contained and logged without exporter details", async () => {
  let logs = "";
  const marker = "SECRET-EXPORTER-DETAIL";
  const traceExporter = {
    export(): void {
      throw new ObservabilityFixtureError(marker);
    },
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  };
  const telemetry = createTelemetry({
    serviceVersion: "test-version",
    command: "worker",
    env: { SEPT_WORKER_ID: "failure-test" },
    traceExporter,
    registerGlobal: false,
    logDestination: {
      write(value: string): void {
        logs += value;
      },
    },
  });
  await telemetry.span("sept.worker.start", {}, () => Promise.resolve());
  const started = Date.now();
  await telemetry.forceFlush(250);
  assert.ok(Date.now() - started < 1_000);
  assert.match(logs, /telemetry\.export/);
  assert.doesNotMatch(logs, new RegExp(marker));
  await telemetry.shutdown(250);
});
