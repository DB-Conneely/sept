/**
 * Shared installed-CLI fixtures own subprocess capture, bounded polling, provider replies, and
 * cleanup. Tests retain scenario authority while this module prevents duplicated process races.
 */

import assert from "node:assert/strict";
import { workerHands, ownHands, closeChildHands, activateHandsPolicy } from "./hands-support.js";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";

type InstalledChild = ChildProcessByStdio<null, Readable, Readable>;

/** Classified assertion failure raised only by composition fixture infrastructure. */
export class CompositionFixtureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CompositionFixtureError";
  }
}

/** Captured installed worker process and its asynchronously discovered listener address. */
export interface InstalledWorker {
  child: InstalledChild;
  address: Promise<string>;
  stdout(): string;
  stderr(): string;
}

/** Narrow a parsed fixture value to an object before tests inspect named fields. */
export function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CompositionFixtureError(`${name} must be an object`);
  }
  return value;
}

/** Parse controlled JSON fixture output once and require an object projection. */
export function parseRecord(text: string, name = "JSON fixture"): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  return record(value, name);
}

/** Read one HTTP JSON body and require the expected object projection. */
export async function responseRecord(
  response: Response,
  name = "response",
): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  return record(value, name);
}

/** Require a named string field from an already narrowed fixture object. */
export function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new CompositionFixtureError(`${key} must be a string`);
  }
  return field;
}

/** Require a named numeric field from an already narrowed fixture object. */
export function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number") {
    throw new CompositionFixtureError(`${key} must be a number`);
  }
  return field;
}

/** Require a named array field from an already narrowed fixture object. */
export function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  const field = value[key];
  if (!Array.isArray(field)) {
    throw new CompositionFixtureError(`${key} must be an array`);
  }
  return field;
}

/** Poll captured output until a bounded regular expression match is observed. */
export function waitForOutput(
  read: () => string,
  pattern: RegExp,
  timeoutMs = 15_000,
): Promise<RegExpMatchArray> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const poll = (): void => {
      const match = pattern.exec(read());
      if (match !== null) {
        resolvePromise(match);
      } else if (Date.now() - started >= timeoutMs) {
        reject(new CompositionFixtureError(`output not observed: ${String(pattern)}`));
      } else {
        setTimeout(poll, 10).unref();
      }
    };
    poll();
  });
}

function requiredCapture(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) {
    throw new CompositionFixtureError(`missing regular expression capture ${String(index)}`);
  }
  return value;
}

/** Start the installed worker with isolated state, agent, workspace, and credential inputs. */
export function installedWorker(
  state: string,
  agent: string,
  workspaceRoot: string,
  token: string,
  environment: NodeJS.ProcessEnv = {},
): InstalledWorker {
  const hands = workerHands(agent, environment);
  if (hands !== undefined) {
    activateHandsPolicy(hands, state, agent);
  }
  const child = spawn(resolve("sept"), workerArguments(state, agent, workspaceRoot), {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SEPT_TOKEN: token,
      OTEL_SDK_DISABLED: "true",
      SEPT_LOG_LEVEL: "silent",
      ...environment,
      ...(hands === undefined ? {} : { SEPT_HANDS_CONFIGURATION: hands.path }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  ownHands(child, hands);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (value: string) => {
    stdout += value;
  });
  child.stderr.setEncoding("utf8").on("data", (value: string) => {
    stderr += value;
  });
  const address = waitForOutput(() => stdout, /http:\/\/127\.0\.0\.1:(\d+)/).then(
    (match) => `http://127.0.0.1:${requiredCapture(match, 1)}`,
  );
  return { child, address, stdout: () => stdout, stderr: () => stderr };
}

function workerArguments(state: string, agent: string, workspaceRoot: string): string[] {
  return [
    "worker",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--state-dir",
    state,
    "--agent-dir",
    agent,
    "--workspace-root",
    workspaceRoot,
  ];
}

async function stopProcess(child: InstalledChild, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = waitForExit(child);
  child.kill(signal);
  await exited;
}

/** Await one installed child exit without interpreting its exit authority. */
export function waitForExit(
  child: InstalledChild,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, reject) => {
    const failed = (error: Error): void => {
      child.removeListener("exit", exited);
      reject(error);
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null): void => {
      child.removeListener("error", failed);
      resolvePromise({ code, signal });
    };
    child.once("error", failed);
    child.once("exit", exited);
  });
}

/** Join a worker through SIGTERM; scenarios retain explicit graceful/interrupted exit assertions. */
export async function stopInstalled(child: InstalledChild): Promise<void> {
  const failures: unknown[] = [];
  try {
    await stopProcess(child, "SIGTERM");
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    closeChildHands(child);
  } catch (error: unknown) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Installed worker finalization failed");
  }
}

/** Interrupt an installed worker to exercise restart adoption. */
export async function killInstalled(child: InstalledChild): Promise<void> {
  await stopProcess(child, "SIGKILL");
  closeChildHands(child);
}

/** Poll the authenticated task projection until its durable state reaches the expected status. */
export async function waitForTask(
  base: string,
  runId: string,
  token: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const result = await fetch(`${base}/v1/tasks/${runId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body: unknown = await result.json();
    if (taskStatus(body) === expected) {
      return;
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 20);
    });
  }
  throw new CompositionFixtureError(`run did not reach ${expected}`);
}

function taskStatus(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const state = value.state;
  if (!isRecord(state)) {
    return undefined;
  }
  return typeof state.status === "string" ? state.status : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Emit one complete OpenAI-compatible fixture response with provider usage. */
export function openAiReply(response: ServerResponse, text: string, promptTokens = 10): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(
    `data: ${JSON.stringify({ id: "chatcmpl-part1", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ id: "chatcmpl-part1", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 } })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

/** Create isolated agent and workspace directories below a scenario root. */
export function prepareDirectories(root: string): {
  agent: string;
  state: string;
  workspace: string;
} {
  const agent = join(root, "agent");
  const state = join(root, "runs");
  const workspace = join(root, "workspace");
  mkdirSync(agent);
  mkdirSync(workspace);
  return { agent, state, workspace };
}

/** Return the bound TCP port after a fixture server has begun listening. */
export async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return address.port;
}

/** Close a fixture provider only after pending connections have settled. */
export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolvePromise();
      } else {
        reject(error);
      }
    });
  });
}

/** Persist one Pi custom-provider definition without exporting its local test credential. */
export function writeProvider(
  agent: string,
  port: number,
  provider: string,
  options: { apiKey?: string; maxTokens?: number; models?: string[] } = {},
): void {
  const models = (options.models ?? ["fixture"]).map((id) => ({
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: options.maxTokens ?? 8192,
  }));
  const definition = {
    providers: {
      [provider]: {
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        api: "openai-completions",
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        models,
      },
    },
  };
  writeFileSync(join(agent, "models.json"), `${JSON.stringify(definition)}\n`);
}
