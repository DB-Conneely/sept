/**
 * Provides deterministic native Pi provider streams and isolated durable stores for integration
 * tests. Tests retain lifecycle ownership of hosts/runtimes; this support module uses only local
 * sentinel authentication, bounds each stream, and centralizes the one SDK protocol fixture cast.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RunStore, type Manifest } from "../../src/durable/index.js";

/** Typed fixture failure used where a test protocol operation is impossible. */
export class PiFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiFixtureError";
  }
}

/** Minimal event shape emitted by deterministic provider stream fixtures. */
export interface FixtureEvent {
  type: string;
  [key: string]: unknown;
}

/** Isolated filesystem roots owned by one Pi integration scenario. */
export interface PiFixtureDirectories {
  root: string;
  workspace: string;
  agentDir: string;
}

/** Native provider callback shape inferred from the installed Pi runtime. */
export type FixtureStreamHandler = ModelRuntime["streamSimple"];

/** Finalized assistant fixture shape sufficient for native Pi stream execution. */
export interface FixtureAssistant {
  role: "assistant";
  content: unknown[];
  api: string;
  provider: string;
  model: string;
  usage: ReturnType<typeof usage>;
  stopReason: "toolUse" | "stop";
  timestamp: number;
}

/** Finite provider stream whose result resolves to the pushed terminal message. */
export class ProviderStream implements AsyncIterable<FixtureEvent> {
  private readonly events: FixtureEvent[] = [];
  private resolveResult: (value: unknown) => void = () => {
    throw new PiFixtureError("provider result resolver was not initialized");
  };
  private readonly resultPromise: Promise<unknown>;

  constructor() {
    this.resultPromise = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
  }

  push(event: FixtureEvent): void {
    this.events.push(event);
    if (event.type === "done") {
      this.resolveResult(event.message);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<FixtureEvent> {
    let index = 0;
    return {
      next: () => {
        const event = this.events[index];
        index += 1;
        return Promise.resolve(
          event === undefined ? { done: true, value: undefined } : { done: false, value: event },
        );
      },
    };
  }

  result(): Promise<unknown> {
    return this.resultPromise;
  }
}

/** Provider stream that remains active until Pi aborts its request signal. */
export class AbortProviderStream implements AsyncIterable<FixtureEvent> {
  private readonly finalMessage = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: "test-api",
    provider: "sept-abort",
    model: "fixture",
    usage: usage(0, 0),
    stopReason: "aborted",
    timestamp: Date.now(),
  };
  private readonly aborted: Promise<void>;

  constructor(signal: AbortSignal | undefined, started: () => void) {
    this.aborted = new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
      } else {
        signal?.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
      }
    });
    started();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<FixtureEvent> {
    yield { type: "start", partial: this.finalMessage };
    await this.aborted;
  }

  async result(): Promise<unknown> {
    await this.aborted;
    return this.finalMessage;
  }
}

/** Create complete nonnegative provider usage, including the required cost projection. */
export function usage(
  input: number,
  output = 1,
): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
} {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Build one finalized native assistant fixture with provider-reported usage. */
export function assistant(
  content: unknown[],
  input: number,
  stopReason: "toolUse" | "stop",
): FixtureAssistant {
  return {
    role: "assistant",
    content,
    api: "test-api",
    provider: "sept-test",
    model: "fixture",
    usage: usage(input),
    stopReason,
    timestamp: Date.now(),
  };
}

/** Wrap one finalized assistant message in the native provider stream fixture protocol. */
export function streamOf(message: FixtureAssistant): ReturnType<FixtureStreamHandler> {
  const stream = new ProviderStream();
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: message.stopReason, message });
  return fixtureStream(stream);
}

/** Adapt a structurally complete deterministic fixture to Pi's opaque event-stream implementation. */
export function fixtureStream(
  stream: ProviderStream | AbortProviderStream,
): ReturnType<FixtureStreamHandler> {
  // Both fixtures omit emitter-only methods that provider callbacks never read.
  const protocolValue: unknown = stream;
  // CAST: Async iteration and result implement Pi's complete consumed stream contract.
  return protocolValue as ReturnType<FixtureStreamHandler>;
}

/** Flatten native prompt context text for assertions without interpreting tool payloads. */
export function contextText(context: Parameters<FixtureStreamHandler>[1]): string {
  return [
    context.systemPrompt ?? "",
    ...context.messages.map((message) => {
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
      if (message.role !== "system") {
        return content;
      }
      return [
        content,
        ...Object.values(message.sections ?? {}).filter((section) => section !== null),
      ].join("\n");
    }),
  ].join("\n");
}

/** Create isolated workspace and Pi agent directories for one scenario. */
export function fixtureDirectories(prefix: string): PiFixtureDirectories {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  mkdirSync(workspace);
  mkdirSync(agentDir);
  return { root, workspace, agentDir };
}

/** Construct an installed Pi model runtime with filesystem credentials isolated to the fixture. */
export async function fixtureModelRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
}

/** Register one local-sentinel provider using the installed Pi provider composition path. */
export function registerFixtureProvider(
  runtime: ModelRuntime,
  provider: string,
  streamSimple: FixtureStreamHandler,
): void {
  runtime.registerProvider(provider, {
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "local",
    api: "test-api",
    models: [
      {
        id: "fixture",
        name: "fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 100,
      },
    ],
    streamSimple,
  });
}

/** Create one durable run bound to the fixture provider and workspace. */
export function fixtureStore(
  directories: PiFixtureDirectories,
  provider: string,
  task: string,
  suffix = "runs",
): RunStore {
  const manifest: Manifest = {
    formatVersion: 3,
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    task,
    role: "",
    workspace: directories.workspace,
    provider,
    model: "fixture",
    thinking: "off",
    maxInvocations: 100,
    maxEpochs: 10,
    timeoutSeconds: 3600,
    piVersion: "1.1.0",
  };
  return RunStore.create(join(directories.root, suffix), manifest);
}
