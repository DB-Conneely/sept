/**
 * Owns deterministic host, service, HTTP, and hostile-response helpers shared by observability
 * tests. Production mechanisms remain dependencies rather than being reimplemented here; helpers
 * enforce bounded waits, exact fixture ownership, permission restoration, and unknown narrowing.
 */

import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type { MetricData } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { SeptService } from "../../src/ingress/index.js";
import type { Observability } from "../../src/observability/index.js";
import type { SessionHost, SessionRunResult } from "../../src/pi-integration/index.js";
import { testModelAccess } from "../support/model-access.js";
import { nativeFixtureFactory } from "../support/native-identity.js";

/**
 * Authentication header for the isolated observability worker fixture.
 * The unmistakable canary must remain absent from every captured signal assertion.
 */
export const OBSERVABILITY_AUTH = { Authorization: "Bearer observability-test-token" };

/**
 * Deterministic Pi waiting result used to exercise runtime wait/wake telemetry.
 * It carries no production credential and is owned only by test hosts in this module.
 */
export const WAITING_RESULT: SessionRunResult = {
  text: JSON.stringify({
    status: "waiting",
    summary: "coherent wait",
    verification: ["checkpointed"],
    next_action: "wait for input",
  }),
  steered: false,
  contextTokens: 25,
  contextWindow: 100,
};

/**
 * Deterministic Pi completion result returned after the fixture worker wakes.
 * Its bounded conversation content is local test evidence and must not appear in telemetry.
 */
export const COMPLETE_RESULT: SessionRunResult = {
  text: JSON.stringify({
    status: "complete",
    summary: "done",
    verification: ["verified"],
    next_action: "",
  }),
  steered: false,
  contextTokens: 40,
  contextWindow: 100,
};

/**
 * Typed failure for impossible observability fixture operations.
 * Tests can classify the failure without relying on generic errors or production error semantics.
 */
export class ObservabilityFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservabilityFixtureError";
  }
}

/**
 * Pi `SessionHost` fixture that returns one injected invocation result.
 * The fixture owns no process or SDK resource; unexpected replacement rejects with a typed failure.
 */
export class ResultHost implements SessionHost {
  readonly sessionId = "sensitive-session-id";
  readonly sessionFile: string | undefined;

  constructor(private readonly result: SessionRunResult) {}

  run(): Promise<SessionRunResult> {
    return Promise.resolve(this.result);
  }

  newSession(): Promise<{
    predecessorId: string;
    predecessorFile?: string;
    successorId: string;
    successorFile?: string;
  }> {
    return Promise.reject(new ObservabilityFixtureError("session replacement was not expected"));
  }

  abort(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Pi `SessionHost` fixture for one deterministic predecessor-to-successor rotation.
 * It owns a bounded result queue and exposes canary session paths solely to prove signal exclusion.
 */
export class RotatingHost implements SessionHost {
  sessionId = "rotation-predecessor";
  sessionFile: string | undefined = "/secret/pi/rotation-predecessor.jsonl";
  private readonly results: SessionRunResult[] = [
    {
      text: JSON.stringify({
        handover_summary: "rotate",
        entry_state_and_done: "finish",
        completed: [],
        in_flight: [],
        not_started: ["finish"],
        decisions: [],
        rejected_approaches: [],
        verification: [],
        uncertainties: [],
        references: [],
        lessons: [],
        next_action: "finish",
      }),
      steered: true,
      contextTokens: 90,
      contextWindow: 100,
    },
    COMPLETE_RESULT,
  ];

  run(): Promise<SessionRunResult> {
    const result = this.results.shift();
    if (result === undefined) {
      return Promise.reject(new ObservabilityFixtureError("unexpected rotation invocation"));
    }
    return Promise.resolve(result);
  }

  newSession(): Promise<{
    predecessorId: string;
    predecessorFile?: string;
    successorId: string;
    successorFile?: string;
  }> {
    const predecessorId = this.sessionId;
    const predecessorFile = this.sessionFile;
    this.sessionId = "rotation-successor";
    const successorFile = "/secret/pi/rotation-successor.jsonl";
    this.sessionFile = successorFile;
    return Promise.resolve({
      predecessorId,
      ...(predecessorFile === undefined ? {} : { predecessorFile }),
      successorId: this.sessionId,
      successorFile,
    });
  }

  abort(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Poll an asynchronous observable condition within a three-second hard deadline.
 * Timeout fails the test explicitly, preventing a broken wait/wake path from hanging the suite.
 */
export async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "condition was not reached");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

/**
 * Send a nonstandard HTTP method through Node's raw client.
 * The caller owns the fixture token; the helper returns only status so neither credential nor body
 * can be mistaken for asserted telemetry evidence, and transport failures reject the promise.
 */
export function customMethod(url: URL, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: "PROPFIND", headers: { Authorization: `Bearer ${token}` } },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode ?? 0);
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

/**
 * Start the production-composed worker with deterministic Pi host results and model access.
 * The caller owns shutdown and the temporary root; exhausted host creation rejects with a typed
 * fixture failure so extra session creation cannot pass unnoticed.
 */
export async function startObservedService(
  root: string,
  telemetry: Observability,
): Promise<{ service: SeptService; baseUrl: string }> {
  const hosts: SessionHost[] = [new ResultHost(WAITING_RESULT), new ResultHost(COMPLETE_RESULT)];
  const service = new SeptService({
    stateRoot: join(root, "runs"),
    agentDir: "/secret/pi",
    workspaceRoot: root,
    token: "observability-test-token",
    host: "127.0.0.1",
    port: 0,
    piVersion: "0.85.1",
    telemetry,
    hostFactory: nativeFixtureFactory(() => {
      const host = hosts.shift();
      if (host === undefined) {
        return Promise.reject(new ObservabilityFixtureError("unexpected host creation"));
      }
      return Promise.resolve(host);
    }),
    modelAccessService: await testModelAccess(),
  });
  const address = await service.start();
  return { service, baseUrl: `http://${address.host}:${String(address.port)}` };
}

/**
 * Narrow an unknown JSON value to a non-array property record.
 * Property values deliberately remain unknown until a field-specific assertion validates them.
 */
export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a required string property from hostile JSON response data.
 * Assertion failure terminates the fixture rather than allowing an unchecked cast downstream.
 */
export function requiredString(value: unknown, property: string): string {
  assert.ok(isUnknownRecord(value), "response must be an object");
  const propertyValue = value[property];
  assert.ok(typeof propertyValue === "string");
  return propertyValue;
}

/**
 * Return a finished span matching an observable-contract predicate.
 * Absence fails with caller-supplied context, avoiding non-null assertions in lifecycle checks.
 */
export function requiredSpan(
  spans: ReadableSpan[],
  predicate: (span: ReadableSpan) => boolean,
  description: string,
): ReadableSpan {
  const span = spans.find(predicate);
  assert.ok(span, description);
  return span;
}

/**
 * Return an exported metric by stable instrument name.
 * Missing instruments fail explicitly rather than weakening coverage through optional access.
 */
export function requiredMetric(metrics: MetricData[], name: string): MetricData {
  const metric = metrics.find((candidate) => candidate.descriptor.name === name);
  assert.ok(metric, `missing metric ${name}`);
  return metric;
}

/**
 * Exercise a failed bounded log retrieval against a temporarily unreadable durable file.
 * Permission restoration is unconditional so fixture cleanup and later tests remain reliable; only
 * the HTTP status, never the sensitive path or file content, is exposed to assertions.
 */
export async function exerciseFailedLogRead(
  baseUrl: string,
  root: string,
  runId: string,
): Promise<void> {
  const logPath = join(root, "runs", runId, "agent.log");
  chmodSync(logPath, 0o000);
  try {
    const response = await fetch(`${baseUrl}/v1/tasks/${runId}/log`, {
      headers: OBSERVABILITY_AUTH,
    });
    assert.equal(response.status, 500);
  } finally {
    chmodSync(logPath, 0o600);
  }
}
