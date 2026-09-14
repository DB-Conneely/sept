import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { RunStore } from "../../src/durable/index.js";
import { SeptService, validateRequest } from "../../src/ingress/index.js";
import { createTelemetry, NOOP_TELEMETRY } from "../../src/observability/index.js";
import type { SessionHost, SessionRunResult } from "../../src/pi-integration/index.js";
import { CycleController } from "../../src/runtime/index.js";

const auth = { Authorization: "Bearer observability-test-token" };
const waiting: SessionRunResult = {
  text: JSON.stringify({ status: "waiting", summary: "coherent wait", verification: ["checkpointed"], next_action: "wait for input" }),
  steered: false,
  contextTokens: 25,
  contextWindow: 100,
};
const complete: SessionRunResult = {
  text: JSON.stringify({ status: "complete", summary: "done", verification: ["verified"], next_action: "" }),
  steered: false,
  contextTokens: 40,
  contextWindow: 100,
};

class ResultHost implements SessionHost {
  readonly sessionId = "sensitive-session-id";
  readonly sessionFile = "/secret/pi/session-file.jsonl";
  constructor(private readonly result: SessionRunResult) {}
  async run(): Promise<SessionRunResult> { return this.result; }
  async newSession(): Promise<{ predecessorId: string; predecessorFile?: string; successorId: string; successorFile?: string }> { throw new Error("not expected"); }
  async close(): Promise<void> {}
}

class RotatingHost implements SessionHost {
  sessionId = "rotation-predecessor";
  sessionFile: string | undefined = "/secret/pi/rotation-predecessor.jsonl";
  private readonly results: SessionRunResult[] = [{
    text: JSON.stringify({
      handover_summary: "rotate", entry_state_and_done: "finish", completed: [], in_flight: [], not_started: ["finish"], decisions: [], rejected_approaches: [], verification: [], uncertainties: [], references: [], lessons: [], next_action: "finish",
    }),
    steered: true, contextTokens: 90, contextWindow: 100,
  }, complete];
  async run(): Promise<SessionRunResult> {
    const result = this.results.shift();
    if (!result) throw new Error("unexpected invocation");
    return result;
  }
  async newSession() {
    const predecessorId = this.sessionId;
    const predecessorFile = this.sessionFile;
    this.sessionId = "rotation-successor";
    this.sessionFile = "/secret/pi/rotation-successor.jsonl";
    return { predecessorId, predecessorFile, successorId: this.sessionId, successorFile: this.sessionFile };
  }
  async close(): Promise<void> {}
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function customMethod(url: URL, token: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(url, { method: "PROPFIND", headers: { Authorization: `Bearer ${token}` } }, (response) => {
      response.resume();
      response.once("end", () => resolvePromise(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

test("wired lifecycle exports correlated safe spans, metrics, and JSON logs", async () => {
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
    logDestination: { write(value: string) { logOutput += value; } },
  });
  const hosts = [new ResultHost(waiting), new ResultHost(complete)];
  const service = new SeptService({
    stateRoot: join(root, "runs"), agentDir: "/secret/pi", workspaceRoot: root, token: "observability-test-token", host: "127.0.0.1", port: 0, piVersion: "0.85.1", telemetry,
    hostFactory: async () => {
      const host = hosts.shift();
      if (!host) throw new Error("unexpected host creation");
      return host;
    },
  });
  const address = await service.start();
  const base = `http://${address.host}:${address.port}`;
  let runId = "";
  try {
    const taskMarker = "TOP-SECRET-TASK-PAYLOAD";
    const task = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", traceparent: "00-11111111111111111111111111111111-2222222222222222-01", tracestate: "vendor=value" },
      body: JSON.stringify({ task: taskMarker, workspace }),
    });
    assert.equal(task.status, 202);
    runId = (await task.json() as { runId: string }).runId;
    await waitFor(async () => {
      const response = await fetch(`${base}/health`, { headers: auth });
      return (await response.json() as { worker: string }).worker === "waiting";
    });

    const messageMarker = "TOP-SECRET-OPERATOR-MESSAGE";
    const event = { version: 1, eventId: "telemetry-event", source: "test-edge", kind: "operator_message", runId, message: messageMarker };
    const wake = await fetch(`${base}/v1/webhooks`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(event) });
    assert.equal(wake.status, 202);
    await waitFor(async () => {
      const response = await fetch(`${base}/health`, { headers: auth });
      return (await response.json() as { worker: string }).worker === "idle";
    });
    const duplicate = await fetch(`${base}/v1/webhooks`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(event) });
    assert.equal(duplicate.status, 200);
    const collision = await fetch(`${base}/v1/webhooks`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ ...event, message: "TOP-SECRET-COLLISION" }) });
    assert.equal(collision.status, 409);
    const rejected = await fetch(`${base}/v1/webhooks`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ ...event, eventId: "unknown", runId: "unknown", message: "TOP-SECRET-REJECTED" }) });
    assert.equal(rejected.status, 404);
    assert.equal(await customMethod(new URL(`${base}/arbitrary`), "observability-test-token"), 404);

    const logPath = join(root, "runs", runId, "agent.log");
    chmodSync(logPath, 0o000);
    try {
      const failed = await fetch(`${base}/v1/tasks/${runId}/log`, { headers: auth });
      assert.equal(failed.status, 500);
    } finally { chmodSync(logPath, 0o600); }
  } finally {
    await service.stop();
  }

  const rotationStore = RunStore.create(join(root, "rotation-runs"), validateRequest({ task: "rotation payload is local", workspace }, "0.85.1"));
  const rotationHost = new RotatingHost();
  await new CycleController(rotationStore, "/secret/pi", async () => rotationHost, telemetry).run();

  await telemetry.forceFlush();
  await telemetry.forceFlush();
  const spans = traceExporter.getFinishedSpans();
  const names = new Set(spans.map((span) => span.name));
  for (const name of ["sept.worker.start", "sept.http.request", "sept.task.create", "sept.controller.run", "sept.controller.lease", "sept.pi.session.open", "sept.pi.invoke", "sept.pi.session.rotate", "sept.pi.session.close", "sept.operator.enqueue", "sept.webhook.route", "sept.worker.stop"]) {
    assert.ok(names.has(name), `missing span ${name}`);
  }
  const workerStart = spans.find((span) => span.name === "sept.worker.start")!;
  assert.equal(workerStart.attributes["sept.adoption"], "none");
  assert.equal(workerStart.attributes["sept.worker.state"], "idle");
  const taskSpan = spans.find((span) => span.name === "sept.task.create")!;
  const taskRequest = spans.find((span) => span.name === "sept.http.request" && span.attributes["http.route"] === "/v1/tasks")!;
  assert.equal(taskSpan.parentSpanContext?.spanId, taskRequest.spanContext().spanId);
  assert.equal(taskRequest.parentSpanContext?.spanId, "2222222222222222");
  assert.equal(taskRequest.parentSpanContext?.traceState?.get("vendor"), "value");
  assert.equal(taskRequest.resource.attributes["process.command_args"], undefined);
  const failedRequest = spans.find((span) => span.name === "sept.http.request" && span.attributes["http.route"] === "/v1/tasks/{runId}/log")!;
  assert.equal(failedRequest.attributes["http.response.status_code"], 500);
  assert.equal(failedRequest.attributes["error.type"], "HttpServerError");
  assert.equal(failedRequest.status.code, SpanStatusCode.ERROR);
  const controller = spans.find((span) => span.name === "sept.controller.run")!;
  const invocation = spans.find((span) => span.name === "sept.pi.invoke")!;
  assert.equal(invocation.parentSpanContext?.spanId, controller.spanContext().spanId);
  assert.ok(invocation.events.some((event) => event.name === "sept.context.sampled"));
  const rotationController = spans.find((span) => span.name === "sept.controller.run" && span.events.some((event) => event.name === "sept.handover.durable"));
  assert.ok(rotationController, "handover must be an event on the controller trace");

  const metrics = metricExporter.getMetrics().flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
  const metricNames = new Set(metrics.map((metric) => metric.descriptor.name));
  for (const name of ["sept.worker.starts", "sept.worker.uptime", "sept.worker.state", "sept.run.state", "sept.run.epoch", "sept.run.epochs", "sept.run.invocation", "sept.run.outcomes", "sept.pi.session.opens", "sept.pi.invocations", "sept.pi.invocation.duration", "sept.pi.context.pressure", "sept.operator.queue.depth", "sept.webhook.requests", "sept.http.server.requests", "sept.process.memory", "sept.process.cpu", "sept.nodejs.event_loop.utilization", "sept.telemetry.exports"]) {
    assert.ok(metricNames.has(name), `missing metric ${name}`);
  }
  const metricJson = JSON.stringify(metrics);
  assert.doesNotMatch(metricJson, new RegExp(runId));
  assert.doesNotMatch(metricJson, /sensitive-session-id|session-file|TOP-SECRET|PROPFIND/);
  assert.match(metricJson, /OTHER/);
  const webhookMetric = metrics.find((metric) => metric.descriptor.name === "sept.webhook.requests");
  const webhookAttributes = JSON.stringify(webhookMetric);
  assert.match(webhookAttributes, /accepted/);
  assert.match(webhookAttributes, /duplicate/);
  assert.match(webhookAttributes, /collision/);
  assert.match(webhookAttributes, /rejected/);

  const records = logOutput.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(records.some((record) => record.lifecycle === "worker.started"));
  assert.ok(records.some((record) => record.lifecycle === "pi.invocation.finished" && typeof record.trace_id === "string" && typeof record.span_id === "string"));
  assert.ok(records.every((record) => record["service.name"] === "sept-test" && record["service.instance.id"] === `worker-a:${process.pid}`));
  assert.doesNotMatch(logOutput, /observability-test-token|TOP-SECRET|sensitive-session-id|session-file\.jsonl|\/secret\/pi/);
  await telemetry.shutdown();
});

test("SDK-disabled telemetry and the shared no-op never touch configured exporters", async () => {
  let traceExports = 0;
  let metricExports = 0;
  const traceExporter = {
    export(): void { traceExports++; },
    async shutdown(): Promise<void> {},
  };
  const metricExporter = {
    export(): void { metricExports++; },
    async shutdown(): Promise<void> {},
    async forceFlush(): Promise<void> {},
  };
  const disabled = createTelemetry({
    serviceVersion: "test-version", sdkDisabled: true, logsEnabled: false, traceExporter, metricExporter,
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid:4318", OTEL_TRACES_EXPORTER: "otlp", OTEL_METRICS_EXPORTER: "otlp" },
  });
  let operations = 0;
  await disabled.span("disabled", {}, async () => { operations++; });
  await NOOP_TELEMETRY.span("noop", {}, async () => { operations++; });
  await disabled.forceFlush(50);
  assert.equal(operations, 2);
  assert.equal(traceExports, 0);
  assert.equal(metricExports, 0);
  await disabled.shutdown(50);
});

test("deferred provider usage leaves context pressure absent until a valid sample", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const telemetry = createTelemetry({ serviceVersion: "test-version", env: {}, logsEnabled: false, metricExporter: exporter, registerGlobal: false });
  telemetry.contextSample(null, 100, 1, 1);
  await telemetry.forceFlush();
  let metrics = exporter.getMetrics().flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
  assert.equal(metrics.some((metric) => metric.descriptor.name === "sept.pi.context.pressure"), false);
  telemetry.contextSample(25, 100, 1, 2);
  await telemetry.forceFlush();
  metrics = exporter.getMetrics().flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
  assert.equal(metrics.some((metric) => metric.descriptor.name === "sept.pi.context.pressure"), true);
  await telemetry.shutdown();
});

test("exporter exceptions are contained and logged without exporter details", async () => {
  let logs = "";
  const marker = "SECRET-EXPORTER-DETAIL";
  const traceExporter = {
    export(): void { throw new Error(marker); },
    async shutdown(): Promise<void> {},
    async forceFlush(): Promise<void> {},
  };
  const telemetry = createTelemetry({
    serviceVersion: "test-version",
    command: "worker",
    env: { SEPT_WORKER_ID: "failure-test" },
    traceExporter,
    registerGlobal: false,
    logDestination: { write(value: string) { logs += value; } },
  });
  await telemetry.span("sept.worker.start", {}, async () => undefined);
  const started = Date.now();
  await telemetry.forceFlush(250);
  assert.ok(Date.now() - started < 1_000);
  assert.match(logs, /telemetry\.export/);
  assert.doesNotMatch(logs, new RegExp(marker));
  await telemetry.shutdown(250);
});
