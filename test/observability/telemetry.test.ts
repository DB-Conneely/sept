/**
 * Exercises the production observability facade through the composed HTTP worker and runtime
 * controller. The suite owns only deterministic Pi fixtures and verifies cross-signal lifecycle
 * coverage, W3C correlation, durable-rotation events, finite labels, and secret-free output.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  type MetricData,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { RunStore } from "../../src/durable/index.js";
import { validateRequest } from "../../src/ingress/index.js";
import { createTelemetry } from "../../src/observability/index.js";
import { CycleController } from "../../src/runtime/index.js";
import {
  OBSERVABILITY_AUTH,
  RotatingHost,
  customMethod,
  exerciseFailedLogRead,
  isUnknownRecord,
  requiredMetric,
  requiredSpan,
  requiredString,
  startObservedService,
  waitFor,
} from "./support.js";

const TRACE_NAMES = [
  "sept.worker.start",
  "sept.http.request",
  "sept.task.create",
  "sept.controller.run",
  "sept.controller.lease",
  "sept.pi.session.open",
  "sept.pi.invoke",
  "sept.pi.session.rotate",
  "sept.pi.session.close",
  "sept.operator.enqueue",
  "sept.webhook.route",
  "sept.worker.stop",
];

const METRIC_NAMES = [
  "sept.worker.starts",
  "sept.worker.uptime",
  "sept.worker.state",
  "sept.run.state",
  "sept.run.epoch",
  "sept.run.epochs",
  "sept.run.invocation",
  "sept.run.outcomes",
  "sept.pi.session.opens",
  "sept.pi.invocations",
  "sept.pi.invocation.duration",
  "sept.pi.context.pressure",
  "sept.operator.queue.depth",
  "sept.webhook.requests",
  "sept.http.server.requests",
  "sept.process.memory",
  "sept.process.cpu",
  "sept.nodejs.event_loop.utilization",
  "sept.telemetry.exports",
];

function jsonBody(init: object): RequestInit {
  return {
    method: "POST",
    headers: { ...OBSERVABILITY_AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(init),
  };
}

async function waitForWorker(baseUrl: string, expected: string): Promise<void> {
  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/health`, { headers: OBSERVABILITY_AUTH });
    return requiredString(await response.json(), "worker") === expected;
  });
}

async function submitTask(baseUrl: string, workspace: string): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/tasks`, {
    ...jsonBody({ task: "TOP-SECRET-TASK-PAYLOAD", workspace }),
    headers: {
      ...OBSERVABILITY_AUTH,
      "Content-Type": "application/json",
      traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
      tracestate: "vendor=value",
    },
  });
  assert.equal(response.status, 202);
  return requiredString(await response.json(), "runId");
}

async function exerciseWebhooks(baseUrl: string, runId: string): Promise<void> {
  const event = {
    version: 1,
    eventId: "telemetry-event",
    source: "test-edge",
    kind: "operator_message",
    runId,
    message: "TOP-SECRET-OPERATOR-MESSAGE",
  };
  const wake = await fetch(`${baseUrl}/v1/webhooks`, jsonBody(event));
  assert.equal(wake.status, 202);
  await waitForWorker(baseUrl, "idle");
  const duplicate = await fetch(`${baseUrl}/v1/webhooks`, jsonBody(event));
  assert.equal(duplicate.status, 200);
  const collision = await fetch(
    `${baseUrl}/v1/webhooks`,
    jsonBody({ ...event, message: "TOP-SECRET-COLLISION" }),
  );
  assert.equal(collision.status, 409);
  const rejected = await fetch(
    `${baseUrl}/v1/webhooks`,
    jsonBody({ ...event, eventId: "unknown", runId: "unknown", message: "TOP-SECRET-REJECTED" }),
  );
  assert.equal(rejected.status, 404);
}

async function exerciseWorker(
  root: string,
  workspace: string,
  telemetry: ReturnType<typeof createTelemetry>,
): Promise<string> {
  const { service, baseUrl } = await startObservedService(root, telemetry);
  try {
    const runId = await submitTask(baseUrl, workspace);
    await waitForWorker(baseUrl, "waiting");
    await exerciseWebhooks(baseUrl, runId);
    assert.equal(
      await customMethod(new URL(`${baseUrl}/arbitrary`), "observability-test-token"),
      404,
    );
    await exerciseFailedLogRead(baseUrl, root, runId);
    return runId;
  } finally {
    await service.stop();
  }
}

async function exerciseRotation(
  root: string,
  workspace: string,
  telemetry: ReturnType<typeof createTelemetry>,
): Promise<void> {
  const store = RunStore.create(
    join(root, "rotation-runs"),
    validateRequest({ task: "rotation payload is local", workspace }, "0.85.1"),
  );
  const host = new RotatingHost();
  const controller = new CycleController(
    store,
    "/secret/pi",
    () => Promise.resolve(host),
    telemetry,
  );
  await controller.run();
}

function assertRequiredTraceNames(spans: ReadableSpan[]): void {
  const names = new Set(spans.map((span) => span.name));
  for (const name of TRACE_NAMES) {
    assert.ok(names.has(name), `missing span ${name}`);
  }
}

function assertTraceParentage(spans: ReadableSpan[]): void {
  const taskSpan = requiredSpan(spans, (span) => span.name === "sept.task.create", "task span");
  const requestSpan = requiredSpan(
    spans,
    (span) => span.name === "sept.http.request" && span.attributes["http.route"] === "/v1/tasks",
    "task request span",
  );
  assert.equal(taskSpan.parentSpanContext?.spanId, requestSpan.spanContext().spanId);
  const requestParent = requestSpan.parentSpanContext;
  assert.ok(requestParent, "task request must retain the extracted parent");
  assert.equal(requestParent.spanId, "2222222222222222");
  assert.equal(requestParent.traceState?.get("vendor"), "value");
  assert.equal(requestSpan.resource.attributes["process.command_args"], undefined);
  const controller = requiredSpan(
    spans,
    (span) => span.name === "sept.controller.run",
    "controller span",
  );
  const invocation = requiredSpan(
    spans,
    (span) => span.name === "sept.pi.invoke",
    "invocation span",
  );
  assert.equal(invocation.parentSpanContext?.spanId, controller.spanContext().spanId);
  assert.ok(invocation.events.some((event) => event.name === "sept.context.sampled"));
}

function assertFailureAndHandoverTraces(spans: ReadableSpan[]): void {
  const failedRequest = requiredSpan(
    spans,
    (span) =>
      span.name === "sept.http.request" &&
      span.attributes["http.route"] === "/v1/tasks/{runId}/log",
    "failed log request span",
  );
  assert.equal(failedRequest.attributes["http.response.status_code"], 500);
  assert.equal(failedRequest.attributes["error.type"], "HttpServerError");
  assert.equal(failedRequest.status.code, SpanStatusCode.ERROR);
  requiredSpan(
    spans,
    (span) =>
      span.name === "sept.controller.run" &&
      span.events.some((event) => event.name === "sept.handover.durable"),
    "controller handover event",
  );
}

function assertMetrics(metrics: MetricData[], runId: string): void {
  const names = new Set(metrics.map((metric) => metric.descriptor.name));
  for (const name of METRIC_NAMES) {
    assert.ok(names.has(name), `missing metric ${name}`);
  }
  const serialized = JSON.stringify(metrics);
  assert.doesNotMatch(serialized, new RegExp(runId));
  assert.doesNotMatch(serialized, /sensitive-session-id|session-file|TOP-SECRET|PROPFIND/);
  assert.match(serialized, /OTHER/);
  const webhook = JSON.stringify(requiredMetric(metrics, "sept.webhook.requests"));
  for (const outcome of ["accepted", "duplicate", "collision", "rejected"]) {
    assert.match(webhook, new RegExp(outcome));
  }
}

function parseLogRecords(output: string): Record<string, unknown>[] {
  return output
    .trim()
    .split("\n")
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      assert.ok(isUnknownRecord(parsed));
      return parsed;
    });
}

function assertSafeLogs(output: string): void {
  const records = parseLogRecords(output);
  assert.ok(records.some((record) => record.lifecycle === "worker.started"));
  assert.ok(
    records.some(
      (record) =>
        record.lifecycle === "pi.invocation.finished" &&
        typeof record.trace_id === "string" &&
        typeof record.span_id === "string",
    ),
  );
  const instanceId = `worker-a:${String(process.pid)}`;
  assert.ok(
    records.every(
      (record) =>
        record["service.name"] === "sept-test" && record["service.instance.id"] === instanceId,
    ),
  );
  assert.doesNotMatch(
    output,
    /observability-test-token|TOP-SECRET|sensitive-session-id|session-file\.jsonl|\/secret\/pi/,
  );
}

void test("wired lifecycle exports correlated safe spans, metrics, and JSON logs", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-telemetry-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const traceExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  let logOutput = "";
  const telemetry = createTelemetry({
    serviceVersion: "test-version",
    command: "worker",
    env: { OTEL_SERVICE_NAME: "sept-test", SEPT_WORKER_ID: "worker-a", SEPT_LOG_LEVEL: "info" },
    traceExporter,
    metricExporter,
    logDestination: {
      write(value: string): void {
        logOutput += value;
      },
    },
  });
  const runId = await exerciseWorker(root, workspace, telemetry);
  await exerciseRotation(root, workspace, telemetry);
  await telemetry.forceFlush();
  await telemetry.forceFlush();
  const spans = traceExporter.getFinishedSpans();
  assertRequiredTraceNames(spans);
  assertTraceParentage(spans);
  assertFailureAndHandoverTraces(spans);
  const metrics = metricExporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
  assertMetrics(metrics, runId);
  assertSafeLogs(logOutput);
  await telemetry.shutdown();
});
