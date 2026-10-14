/** Explicit local test double for native lifecycle regressions; it establishes no confinement claim. */

import { AssertionError } from "node:assert";
import { mkdirSync, mkdtempSync, chmodSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import type { Duplex } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
  createBashTool,
  DefaultResourceLoader,
  SettingsManager,
  formatSkillsForPrompt,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type {
  ExecutionBackend,
  HandsRequest,
  DockerHandsConfiguration,
} from "../../src/execution/index.js";
import { recordKernelProfile } from "../../src/execution/profile.js";
import { PiSessionHost } from "../../src/pi-integration/index.js";
import type { HostFactory } from "../../src/runtime/index.js";
import { executeHandsRequest } from "../../src/execution/hands-entry.js";

/** Deliberately injected fixture port, isolated to generated test directories. Installed security proof uses Docker. */
export class FixtureExecutionBackend implements ExecutionBackend {
  public readonly id = "generated-fixture";
  public readonly generation = randomUUID();
  public readonly shell = true;
  public readonly resourceProjectionDirectory: string;
  public readonly resourceProjectionReceipt: string;
  public constructor(
    public readonly cwd: string,
    root = dirname(cwd),
  ) {
    this.resourceProjectionDirectory = join(root, "resources");
    this.resourceProjectionReceipt = join(root, "projection-receipt.json");
    mkdirSync(this.resourceProjectionDirectory, { recursive: true });
  }

  public async invoke(request: HandsRequest, context: Context): Promise<unknown> {
    if (request.kind === "tool" && request.name === "bash") {
      assertFixtureCommand(request.arguments.command);
      return createBashTool(this.cwd).execute(
        request.callId,
        { command: request.arguments.command },
        context.abortSignal,
      );
    }
    if (request.kind !== "resources") {
      return executeHandsRequest(request, this.cwd);
    }
    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.resourceProjectionDirectory,
      settingsManager: SettingsManager.create(this.cwd, this.resourceProjectionDirectory, {
        projectTrusted: false,
      }),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: [
        join(this.resourceProjectionDirectory, "skills"),
        resolve(this.cwd, ".pi/skills"),
      ],
    });
    await loader.reload();
    return {
      system: loader.getSystemPrompt() ?? "",
      append: loader.getAppendSystemPrompt().join("\n\n"),
      instructions: loader
        .getAgentsFiles()
        .agentsFiles.map((file) => file.content)
        .join("\n\n"),
      skills: formatSkillsForPrompt(loader.getSkills().skills, "read"),
    };
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

function assertFixtureCommand(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new AssertionError({ message: "Fixture command must be text" });
  }
}

const fixtureRoots = new WeakMap<ModelRuntime, string>();

/** Register the generated root explicitly without inspecting credential storage or values. */
export function registerFixtureBackend(models: ModelRuntime, agentDir: string): void {
  fixtureRoots.set(models, dirname(agentDir));
}

/** Build an explicitly injected port, never a production ambient fallback. */
export function fixtureBackend(models: ModelRuntime): FixtureExecutionBackend {
  const root = fixtureRoots.get(models);
  if (root === undefined) {
    throw new AssertionError({ message: "Fixture backend root is missing" });
  }
  return new FixtureExecutionBackend(join(root, "workspace"));
}

/** The same explicit local port is reused only by native lifecycle supporting fixtures. */
export function fixtureHostFactory(models: ModelRuntime): HostFactory {
  return (manifest, store, agent, existing, telemetry) =>
    PiSessionHost.create(manifest, store, agent, existing, telemetry, {
      modelRuntime: models,
      executionBackend: fixtureBackend(models),
    });
}

const ID = "a".repeat(64);
const EXEC = "b".repeat(64);
interface EngineFixture {
  daemon: string;
  generation: string;
  running: boolean;
  exitCode: number;
  input: string;
  command: unknown;
  stops: number;
  blocked: boolean;
  onAttachment?: (() => void) | undefined;
  beforePin?: (() => void) | undefined;
  output: string;
}
/** Generated Unix metadata/framing fixture only; it proves no installed kernel confinement. */
export async function suppliedEngine(): Promise<{
  root: string;
  path: string;
  facts: EngineFixture;
  close: () => Promise<void>;
}> {
  const root = mkdtempSync(join(tmpdir(), "sept-engine-"));
  const path = join(root, "engine.sock");
  const facts = engineFixtureFacts();
  const sockets = new Set<Duplex>();
  const server = createServer((request, response) => {
    engineResponse(request, response, facts);
  });
  ownFixtureSockets(server, sockets);
  server.on("upgrade", (_request, socket) => {
    fixtureAttachment(socket, facts);
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  chmodSync(path, 0o600);
  return {
    root,
    path,
    facts,
    close: (): Promise<void> =>
      new Promise((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => {
          resolve();
        });
      }),
  };
}
function engineFixtureFacts(): EngineFixture {
  return {
    daemon: "fixture-daemon",
    generation: "original",
    running: true,
    exitCode: 0,
    input: "",
    command: undefined,
    stops: 0,
    blocked: false,
    output: "bounded result",
  };
}
function ownFixtureSockets(server: ReturnType<typeof createServer>, sockets: Set<Duplex>): void {
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
}
function fixtureAttachment(socket: Duplex, facts: EngineFixture): void {
  socket.once("error", () => {
    socket.destroy();
  });
  socket.allowHalfOpen = true;
  socket.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
  if (facts.blocked) {
    socket.once("end", () => {
      facts.onAttachment?.();
    });
    socket.resume();
    return;
  }
  if (facts.output === "pinned\n") {
    facts.beforePin?.();
    socket.write(engineFrame(1, facts.output));
  }
  socket.on("data", (chunk: Buffer) => {
    facts.input += chunk.toString();
  });
  socket.once("end", () => {
    if (facts.output === "pinned\n") {
      if (facts.input === "stop\n") {
        facts.running = false;
        facts.stops += 1;
      }
      socket.end();
      return;
    }
    const output = Buffer.concat([
      engineFrame(2, "HOSTILE_STDERR_CANARY"),
      engineFrame(1, facts.output),
    ]);
    socket.write(output.subarray(0, 3));
    socket.end(output.subarray(3));
  });
}
function engineResponse(
  request: IncomingMessage,
  response: ServerResponse,
  facts: EngineFixture,
): void {
  response.setHeader("Content-Type", "application/json");
  switch (request.url) {
    case "/version":
      response.end(JSON.stringify({ Os: "linux", ApiVersion: "1.52", MinAPIVersion: "1.44" }));
      return;
    case "/v1.52/info":
      response.end(JSON.stringify({ ID: facts.daemon, OperatingSystem: "Linux fixture" }));
      return;
    case `/v1.52/containers/${ID}/json`:
      response.end(
        JSON.stringify({
          Id: ID,
          State: {
            Running: facts.running,
            StartedAt: facts.generation,
            Pid: facts.running ? 42 : 0,
          },
        }),
      );
      return;
    case `/v1.52/containers/${ID}/exec`:
      captureCommand(request, response, facts);
      return;
    case `/v1.52/exec/${EXEC}/json`:
      response.end(JSON.stringify({ ContainerID: ID, Running: false, ExitCode: facts.exitCode }));
      return;
    default:
      response.writeHead(404).end(JSON.stringify({ message: "HOSTILE_PEER_CANARY" }));
  }
}
function captureCommand(
  request: IncomingMessage,
  response: ServerResponse,
  facts: EngineFixture,
): void {
  let input = "";
  request.on("data", (chunk: Buffer) => {
    input += chunk.toString();
  });
  request.once("end", () => {
    const command: unknown = JSON.parse(input);
    facts.command = command;
    facts.input = "";
    const encoded = JSON.stringify(command);
    facts.output = fixtureOutput(encoded);
    response.writeHead(201).end(JSON.stringify({ Id: EXEC }));
  });
}

/** Exact Docker stream framing for supporting decoder capacity fixtures. */
export function engineFrame(stream: number, content: string): Buffer {
  const body = Buffer.from(content);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function fixtureOutput(command: string): string {
  if (command.includes("process.kill(1")) {
    return "pinned\n";
  }
  if (command.includes("function lifetime()")) {
    return JSON.stringify({ pidNamespace: "pid:[42]", initStart: "123" });
  }
  return "bounded result";
}

/** Supporting metadata fixture only; installed admission captures the real image/cgroup/tmpfs facts. */
export function recordFixtureKernel(
  configuration: DockerHandsConfiguration,
  policyPath: string,
): void {
  recordKernelProfile(configuration, policyPath, {
    image: `sha256:${"f".repeat(64)}`,
    memory: 1073741824,
    pids: 128,
    nanoCpus: 2000000000,
    dataDomain: configuration.dataDomain,
    workspaceLimits: configuration.workspaceLimits,
  });
}
