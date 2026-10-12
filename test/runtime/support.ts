/**
 * Provides deterministic runtime fixtures shared by lifecycle and conversation tests. Tests own
 * temporary state and injected hosts; production runtime retains all lease, cancellation, and
 * session authority. Host gates expose only explicit synchronization points needed to prove races.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore, SeptError } from "../../src/durable/index.js";
import { SeptService, validateRequest } from "../../src/ingress/index.js";
import type { SessionHost, SessionRunResult } from "../../src/pi-integration/index.js";
import type { HostFactory } from "../../src/runtime/index.js";
import { testModelAccess } from "../support/model-access.js";

export { complete, handover, waiting } from "./fixture-data.js";

/** Typed fixture failure for impossible scripted-host calls. */
export class RuntimeFixtureError extends SeptError {}

/** Authorization headers used by authenticated runtime HTTP tests. */
export const auth = { Authorization: "Bearer part1-token" };

/** Build one native-session-shaped response with a conversation message. */
export function sessionResponse(status: "complete" | "waiting", message: string): SessionRunResult {
  return {
    text: JSON.stringify({
      message,
      control: {
        status,
        summary: status === "complete" ? "done" : "waiting for follow-up",
        verification: ["durable"],
        next_action: status === "waiting" ? "Wait for operator input." : "",
      },
    }),
    steered: false,
    contextTokens: 10,
    contextWindow: 100,
  };
}

/** Scripted host that records prompts and performs deterministic native-session replacement. */
export class FakeHost implements SessionHost {
  public sessionId = "pi-predecessor";
  public sessionFile: string | undefined = "/pi/predecessor.jsonl";
  public readonly prompts: string[] = [];
  public replacements = 0;

  public constructor(private readonly results: SessionRunResult[]) {}

  public run(prompt: string): Promise<SessionRunResult> {
    this.prompts.push(prompt);
    const result = this.results.shift();
    if (result === undefined) {
      throw new RuntimeFixtureError("unexpected invocation");
    }
    return Promise.resolve(result);
  }

  public newSession(): ReturnType<SessionHost["newSession"]> {
    const predecessorId = this.sessionId;
    const predecessorFile = this.sessionFile;
    this.replacements += 1;
    this.sessionId = `pi-successor-${String(this.replacements)}`;
    this.sessionFile = `/pi/successor-${String(this.replacements)}.jsonl`;
    return Promise.resolve({
      predecessorId,
      ...(predecessorFile === undefined ? {} : { predecessorFile }),
      successorId: this.sessionId,
      successorFile: this.sessionFile,
    });
  }

  public abort(): Promise<void> {
    return Promise.resolve();
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Host gate used to prove graceful stop waits for a durable invocation boundary. */
export class GracefulStopHost implements SessionHost {
  public readonly sessionId = "graceful-session";
  public readonly sessionFile: string | undefined = "/pi/graceful.jsonl";
  public readonly prompts: string[] = [];
  public closed = false;
  private finish: (() => void) | undefined;
  private readonly gate = new Promise<void>((resolve) => {
    this.finish = resolve;
  });

  public async run(prompt: string): Promise<SessionRunResult> {
    this.prompts.push(prompt);
    await this.gate;
    return {
      text: JSON.stringify({
        status: "continue",
        summary: "safe checkpoint",
        verification: [],
        next_action: "resume after restart",
      }),
      steered: false,
      contextTokens: 1,
      contextWindow: 100,
    };
  }

  public newSession(): ReturnType<SessionHost["newSession"]> {
    throw new RuntimeFixtureError("unexpected replacement");
  }

  public abort(): Promise<void> {
    return Promise.resolve();
  }

  public close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  public release(): void {
    this.finish?.();
  }
}

/** Host gate whose single invocation can be completed by a cancellation or test owner. */
export class GateHost implements SessionHost {
  public readonly sessionId = "part1-gate";
  public readonly sessionFile = "/tmp/part1-gate.jsonl";
  public readonly prompts: string[] = [];
  public aborted = 0;
  private finish: ((value: SessionRunResult) => void) | undefined;
  private readonly result = new Promise<SessionRunResult>((resolve) => {
    this.finish = resolve;
  });

  public run(prompt: string): Promise<SessionRunResult> {
    this.prompts.push(prompt);
    return this.result;
  }

  public complete(value = sessionResponse("complete", "The accepted work is complete.")): void {
    this.finish?.(value);
  }

  public newSession(): ReturnType<SessionHost["newSession"]> {
    throw new RuntimeFixtureError("unexpected replacement");
  }

  public abort(): Promise<void> {
    this.aborted += 1;
    this.complete();
    return Promise.resolve();
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Host gate used to expose cancellation while native session replacement is in flight. */
export class ReplacementGateHost implements SessionHost {
  public sessionId = "replacement-predecessor";
  public sessionFile: string | undefined = "/tmp/replacement-predecessor.jsonl";
  public aborts = 0;
  private markReplacement: (() => void) | undefined;
  public readonly replacementStarted = new Promise<void>((resolve) => {
    this.markReplacement = resolve;
  });
  private releaseReplacement: (() => void) | undefined;
  private readonly replacementGate = new Promise<void>((resolve) => {
    this.releaseReplacement = resolve;
  });

  public run(): Promise<SessionRunResult> {
    return Promise.resolve({
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
    });
  }

  public async newSession(): ReturnType<SessionHost["newSession"]> {
    this.markReplacement?.();
    await this.replacementGate;
    const predecessorId = this.sessionId;
    const predecessorFile = this.sessionFile;
    this.sessionId = "replacement-successor";
    this.sessionFile = "/tmp/replacement-successor.jsonl";
    return {
      predecessorId,
      ...(predecessorFile === undefined ? {} : { predecessorFile }),
      successorId: this.sessionId,
      successorFile: this.sessionFile,
    };
  }

  public release(): void {
    this.releaseReplacement?.();
  }

  public abort(): Promise<void> {
    this.aborts += 1;
    return Promise.resolve();
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Scripted host for deterministic waiting and completion responses. */
export class ResultHost implements SessionHost {
  public readonly sessionId = "part1-result";
  public readonly sessionFile = "/tmp/part1-result.jsonl";
  public readonly prompts: string[] = [];

  public constructor(private readonly values: SessionRunResult[]) {}

  public run(prompt: string): Promise<SessionRunResult> {
    this.prompts.push(prompt);
    const value = this.values.shift();
    if (value === undefined) {
      throw new RuntimeFixtureError("unexpected invocation");
    }
    return Promise.resolve(value);
  }

  public newSession(): ReturnType<SessionHost["newSession"]> {
    throw new RuntimeFixtureError("unexpected replacement");
  }

  public abort(): Promise<void> {
    return Promise.resolve();
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Create one isolated controller store and canonical workspace. */
export function controllerFixture(): { root: string; workspace: string; store: RunStore } {
  const root = mkdtempSync(join(tmpdir(), "sept-test-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const store = RunStore.create(
    join(root, "runs"),
    validateRequest({ task: "finish", role: "tester", workspace }, "0.85.1"),
  );
  return { root, workspace, store };
}

/** Create one isolated service state root and canonical workspace. */
export function serviceEnvironment(): { root: string; workspace: string; stateRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "sept-part1-"));
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "runs");
  mkdirSync(workspace);
  return { root, workspace, stateRoot };
}

/** Start an authenticated service with an optional injected native host. */
export async function startService(
  root: string,
  stateRoot: string,
  hostFactory?: HostFactory,
): Promise<{ service: SeptService; base: string }> {
  const service = new SeptService({
    stateRoot,
    agentDir: "/pi",
    workspaceRoot: root,
    token: "part1-token",
    host: "127.0.0.1",
    port: 0,
    piVersion: "0.85.1",
    ...(hostFactory === undefined ? {} : { hostFactory }),
    modelAccessService: await testModelAccess(),
  });
  const address = await service.start();
  return { service, base: `http://${address.host}:${String(address.port)}` };
}

/** Decode the locally produced worker-readiness fixture for an immediate state assertion. */
export function parseWorkerReadiness(text: string): { readiness: string } {
  const value: unknown = JSON.parse(text);
  // CAST: the production worker-state codec wrote this local fixture before the test reads it.
  return value as { readiness: string };
}

/** Decode JSON from a fixture response whose expected contract is asserted by its caller. */
export async function responseJson<T>(
  response: Response & { readonly __fixtureType?: T },
): Promise<T> {
  const value: unknown = await response.json();
  // CAST: each caller supplies the endpoint contract being tested and immediately asserts its fields.
  return value as T;
}

/** POST a bounded JSON fixture through the authenticated service boundary. */
export function postJson(url: string, value: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

/** Poll a deterministic condition until it succeeds or the bounded test deadline expires. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeout = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new RuntimeFixtureError("condition was not reached");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Fetch and validate the successful worker-health fixture projection. */
export async function health(base: string): Promise<{
  worker: string;
  readiness: string;
  acceptingWork: boolean;
  activeRunId: string | null;
}> {
  const result = await fetch(`${base}/health`, { headers: auth });
  assert.equal(result.status, 200);
  return responseJson<{
    worker: string;
    readiness: string;
    acceptingWork: boolean;
    activeRunId: string | null;
  }>(result);
}
