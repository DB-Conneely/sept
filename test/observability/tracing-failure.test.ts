/**
 * Probes tracing's exactly-once boundary with an SDK adapter that fails around callback entry. The
 * fixtures own no production provider or global registration; tests prove instrumentation cannot
 * skip, duplicate, or replace asynchronous and synchronous business-operation outcomes.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { trace, type Span, type SpanOptions } from "@opentelemetry/api";
import { Tracing } from "../../src/observability/tracing.js";
import { ObservabilityFixtureError } from "./support.js";

interface ActiveTracerFixture {
  startActiveSpan<Result>(
    name: string,
    options: SpanOptions,
    operation: (span: Span) => Result,
  ): Result;
}

function fixtureTracing(tracer: ActiveTracerFixture): Tracing {
  return new Tracing({
    serviceVersion: "test",
    environment: {},
    resource: undefined,
    exporter: undefined,
    registerGlobal: false,
    disabled: false,
    report: () => undefined,
    tracer,
  });
}

void test("SDK failure before callback entry runs asynchronous work once without a span", async () => {
  const tracing = fixtureTracing({
    startActiveSpan<Result>(
      _name: string,
      _options: SpanOptions,
      _operation: (span: Span) => Result,
    ): Result {
      throw new ObservabilityFixtureError("SDK failed before callback");
    },
  });
  let calls = 0;
  const result = await tracing.span("before", {}, () => {
    calls += 1;
    return Promise.resolve("operation-result");
  });
  assert.equal(result, "operation-result");
  assert.equal(calls, 1);
});

void test("SDK failure after callback entry preserves one asynchronous execution", async () => {
  const tracing = fixtureTracing({
    startActiveSpan<Result>(
      _name: string,
      _options: SpanOptions,
      operation: (span: Span) => Result,
    ): Result {
      operation(trace.getTracer("sept-test-fixture").startSpan("fixture"));
      throw new ObservabilityFixtureError("SDK failed after callback");
    },
  });
  let calls = 0;
  const result = await tracing.span("after", {}, () => {
    calls += 1;
    return Promise.resolve("operation-result");
  });
  assert.equal(result, "operation-result");
  assert.equal(calls, 1);
});

void test("SDK failure after callback preserves a synchronous operation failure", () => {
  const tracing = fixtureTracing({
    startActiveSpan<Result>(
      _name: string,
      _options: SpanOptions,
      operation: (span: Span) => Result,
    ): Result {
      operation(trace.getTracer("sept-test-fixture").startSpan("fixture"));
      throw new ObservabilityFixtureError("SDK failure must not replace the operation failure");
    },
  });
  let returnCalls = 0;
  const returned = tracing.spanSync("sync-return", {}, () => {
    returnCalls += 1;
    return "operation-result";
  });
  assert.equal(returned, "operation-result");
  assert.equal(returnCalls, 1);

  const original = new ObservabilityFixtureError("original operation failure");
  assert.throws(
    () =>
      tracing.spanSync("sync", {}, () => {
        throw original;
      }),
    (error: unknown) => error === original,
  );
});
