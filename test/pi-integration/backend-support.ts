export { engineFrame } from "./warm-support.js";
import type { HandsFrame } from "../../src/execution/protocol.js";
import { attachWarmFixture, engineFrame, fixtureOutput } from "./warm-support.js";
/** Explicit local test double for native lifecycle regressions; it establishes no confinement claim. */

import { AssertionError } from "node:assert";
import { mkdtempSync, chmodSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import type { Duplex } from "node:stream";
import { dirname, join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { DockerHandsConfiguration } from "../../src/execution/index.js";
import { FixtureExecutionBackend } from "./fixture-execution-backend.js";
export { FixtureExecutionBackend } from "./fixture-execution-backend.js";
import { recordKernelProfile } from "../../src/execution/profile.js";
import { PiSessionHost } from "../../src/pi-integration/index.js";
import type { HostFactory } from "../../src/runtime/index.js";

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
/** Bounded supporting daemon facts; never evidence of installed kernel containment. */
export interface EngineFixture {
  daemon: string;
  generation: string;
  running: boolean;
  exitCode: number;
  input: string;
  command: unknown;
  stops: number;
  blocked: boolean;
  onAttachment?: (() => void) | undefined;
  residentAttachment?: ((socket: Duplex) => boolean) | undefined;
  beforePin?: (() => void) | undefined;
  output: string;
  /** Exact stream fragments for UTF-8/aggregate boundary regressions on the existing command attachment. */
  commandChunks?: Buffer[];
  resident: boolean;
  execStarts: number;
  warmReply?: ((frame: HandsFrame) => HandsFrame) | undefined;
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
    resident: false,
    execStarts: 0,
  };
}
function ownFixtureSockets(server: ReturnType<typeof createServer>, sockets: Set<Duplex>): void {
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("error", () => {
      socket.destroy();
    });
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
}
function fixtureAttachment(socket: Duplex, facts: EngineFixture): void {
  socket.allowHalfOpen = true;
  socket.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
  if (facts.resident) {
    if (facts.residentAttachment?.(socket) !== false) {
      attachWarmFixture(socket, facts);
    }
    return;
  }
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
    const output = fixtureCommandOutput(facts);
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
      fixtureInspection(response, facts);
      return;
    case `/v1.52/containers/${ID}/exec`:
      captureCommand(request, response, facts);
      return;
    case `/v1.52/exec/${EXEC}/json`:
      response.end(
        JSON.stringify({
          ContainerID: ID,
          Running: facts.resident && facts.running,
          Pid: 42,
          ExitCode: facts.exitCode,
        }),
      );
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
    facts.execStarts += 1;
    facts.resident = JSON.stringify(command).includes("hands-entry.js");
    facts.input = "";
    const encoded = JSON.stringify(command);
    facts.output = fixtureOutput(encoded);
    response.writeHead(201).end(JSON.stringify({ Id: EXEC }));
  });
}

/** Supporting metadata fixture only; installed admission captures the real image/cgroup/tmpfs facts. */
export function recordFixtureKernel(
  configuration: DockerHandsConfiguration,
  policyPath: string,
): void {
  recordKernelProfile(configuration, policyPath, {
    isolationRevision: "uid-dac-fixed-helper-v1",
    image: `sha256:${"f".repeat(64)}`,
    memory: 1073741824,
    pids: 128,
    nanoCpus: 2000000000,
    dataDomain: configuration.dataDomain,
    workspaceLimits: configuration.workspaceLimits,
  });
}

function fixtureInspection(response: ServerResponse, facts: EngineFixture): void {
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
}

function fixtureCommandOutput(facts: EngineFixture): Buffer {
  const fragments = JSON.stringify(facts.command).includes("/hands-command")
    ? facts.commandChunks
    : undefined;
  return Buffer.concat(
    fragments ?? [engineFrame(2, "HOSTILE_STDERR_CANARY"), engineFrame(1, facts.output)],
  );
}
