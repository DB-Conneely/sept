/**
 * Shared ingress fixtures for webhook, message, waiting, and lifecycle tests. Fixtures expose only
 * deterministic hosts and authenticated HTTP helpers; production routing remains fully installed.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeptError } from "../../src/durable/index.js";
import { SeptService } from "../../src/ingress/index.js";
import type { SessionHost, SessionRunResult } from "../../src/pi-integration/index.js";
import type { HostFactory } from "../../src/runtime/index.js";
import { testModelAccess } from "../support/model-access.js";

/** Authentication header used by the isolated worker listener. */
export const AUTH = { Authorization: "Bearer test-token" };

/** Successful terminal Pi result used by deterministic host fixtures. */
export const COMPLETE: SessionRunResult = {
  text: JSON.stringify({
    status: "complete",
    summary: "done",
    verification: ["ok"],
    next_action: "",
  }),
  steered: false,
  contextTokens: 1,
  contextWindow: 100,
};

/** Waiting Pi result used to exercise dormant-session ownership. */
export const WAITING: SessionRunResult = {
  text: JSON.stringify({
    status: "waiting",
    summary: "idle until an event arrives",
    verification: ["checkpointed"],
    next_action: "Resume on new input.",
  }),
  steered: false,
  contextTokens: 1,
  contextWindow: 100,
};

/** Deterministic session host that records prompts and completes immediately. */
export class CompletingHost implements SessionHost {
  public sessionId = "webhook-test-session";
  public sessionFile: string | undefined = "/tmp/webhook-test-session.jsonl";
  public prompts: string[] = [];

  public run(prompt: string): Promise<SessionRunResult> {
    this.prompts.push(prompt);
    return Promise.resolve(COMPLETE);
  }

  public newSession(): Promise<never> {
    return Promise.reject(new SeptError("unexpected session replacement"));
  }

  public abort(): Promise<void> {
    return Promise.resolve();
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Session host whose first invocation remains active until the test releases it. */
export class BlockingHost extends CompletingHost {
  private finish: ((result: SessionRunResult) => void) | undefined;
  private readonly result = new Promise<SessionRunResult>((resolve) => {
    this.finish = resolve;
  });

  public override run(prompt: string): Promise<SessionRunResult> {
    this.prompts.push(prompt);
    return this.result;
  }

  /** Release the blocked invocation exactly as a successful Pi completion. */
  public complete(): void {
    this.finish?.(COMPLETE);
  }
}

/** Session host that deliberately settles a run into waiting state. */
export class WaitingHost extends CompletingHost {
  public override run(prompt: string): Promise<SessionRunResult> {
    this.prompts.push(prompt);
    return Promise.resolve(WAITING);
  }
}

/** Waiting host whose close gate exposes the controller-settlement race. */
export class SettlingWaitingHost extends WaitingHost {
  private markCloseStarted: (() => void) | undefined;
  private releaseClose: (() => void) | undefined;
  public readonly closeStarted = new Promise<void>((resolve) => {
    this.markCloseStarted = resolve;
  });
  private readonly closeGate = new Promise<void>((resolve) => {
    this.releaseClose = resolve;
  });

  public override close(): Promise<void> {
    this.markCloseStarted?.();
    return this.closeGate;
  }

  /** Release the close gate after the test has observed exclusive controller ownership. */
  public release(): void {
    this.releaseClose?.();
  }
}

/** Create isolated workspace and state roots for one ingress test. */
export function environment(): { root: string; workspace: string; stateRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "sept-webhook-"));
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "runs");
  mkdirSync(workspace);
  return { root, workspace, stateRoot };
}

/** Start the installed service composition with deterministic model access. */
export async function start(
  stateRoot: string,
  hostFactory?: HostFactory,
): Promise<{ service: SeptService; base: string }> {
  const service = new SeptService({
    stateRoot,
    agentDir: "/pi",
    workspaceRoot: join(stateRoot, ".."),
    token: "test-token",
    host: "127.0.0.1",
    port: 0,
    piVersion: "0.85.1",
    modelAccessService: await testModelAccess(),
    ...(hostFactory === undefined ? {} : { hostFactory }),
  });
  const address = await service.start();
  return { service, base: `http://${address.host}:${String(address.port)}` };
}

/** Post one authenticated webhook event. */
export function post(
  base: string,
  value: unknown,
  headers: Record<string, string> = AUTH,
): Promise<Response> {
  return fetch(`${base}/v1/webhooks`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

/** Post one authenticated direct operator message. */
export function postDirectMessage(base: string, runId: string, message: string): Promise<Response> {
  return fetch(`${base}/v1/tasks/${runId}/messages`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

/** Poll one synchronous predicate until it becomes true or the fixture deadline expires. */
export async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new SeptError("condition was not reached");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Wait for the authenticated worker projection to reach the requested resident state. */
export async function waitForWorker(base: string, expected: "idle" | "waiting"): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() <= deadline) {
    const response = await fetch(`${base}/health`, { headers: AUTH });
    const body: unknown = await response.json();
    if (isRecord(body) && body.worker === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new SeptError(`worker did not become ${expected}`);
}

/** Wait for the worker to release its active slot. */
export function waitForIdle(base: string): Promise<void> {
  return waitForWorker(base, "idle");
}

/** Runtime assertion helper for JSON response objects. */
export async function jsonRecord(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  assert.ok(isRecord(value));
  return value;
}

/** Return one array element only after proving it exists. */
export function requiredAt<Value>(values: readonly Value[], index: number): Value {
  const value = values[index];
  assert.ok(value !== undefined);
  return value;
}

/** Read one required string field from a runtime-validated JSON object. */
export function stringField(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  assert.ok(typeof field === "string");
  return field;
}

/** Validate every member of an unknown JSON array as an object. */
export function recordArray(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  const records: Record<string, unknown>[] = [];
  for (const entry of value) {
    const candidate: unknown = entry;
    assert.ok(isRecord(candidate));
    records.push(candidate);
  }
  return records;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
