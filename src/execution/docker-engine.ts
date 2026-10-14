/** Fixed bounded local Docker Engine operations; provisioning and endpoint selection stay consumer-owned. */
import { Agent, type ClientRequest } from "node:http";
import type { Socket } from "node:net";
import { SeptError } from "../durable/index.js";
import { EngineControlError, type EngineExec } from "./contracts.js";
import {
  handsRecord,
  collectResponse,
  controlRequest,
  settleResponse,
  settleAttachment,
  joinEngineConnections,
  engineBody,
} from "./protocol.js";
import { consumeHandsProcessStream } from "./hands-processes.js";
import {
  engineSocketIdentity,
  engineText,
  apiMinor,
  immutableId,
} from "./profile-configuration.js";

/** One negotiated daemon and explicit socket owner, with no Docker CLI or environment fallback. */
export class DockerEngineControl {
  public readonly socketIdentity: string;
  public readonly daemonId: string;
  public readonly operatingSystem: string;
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly abort = new AbortController();
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  private constructor(
    private readonly socketPath: string,
    private readonly version: string,
    information: Record<string, unknown>,
  ) {
    this.socketIdentity = engineSocketIdentity(socketPath);
    this.daemonId = engineText(information.ID);
    this.operatingSystem = engineText(information.OperatingSystem);
  }
  /** Negotiate only the supported local Linux API interval; wrong/malformed daemons refuse opening. */
  public static async open(socketPath: string): Promise<DockerEngineControl> {
    const identity = engineSocketIdentity(socketPath);
    const version = handsRecord(await exchange(socketPath, undefined, "GET", "/version"));
    const selected = Math.min(52, apiMinor(version.ApiVersion));
    if (version.Os !== "linux" || selected < Math.max(44, apiMinor(version.MinAPIVersion))) {
      throw new SeptError("Hands Engine API or operating system is unsupported");
    }
    const api = `v1.${String(selected)}`;
    const information = handsRecord(await exchange(socketPath, undefined, "GET", `/${api}/info`));
    const engine = new DockerEngineControl(socketPath, api, information);
    if (engine.socketIdentity !== identity) {
      await engine.close();
      throw new SeptError("Hands Engine socket changed during negotiation");
    }
    return engine;
  }
  private assertSocket(): void {
    if (this.closed) {
      throw EngineControlError.at("closed-owner", Date.now(), {
        requestJoined: false,
        connectionsReleased: true,
      });
    }
    if (engineSocketIdentity(this.socketPath) !== this.socketIdentity) {
      throw new SeptError("Hands Engine socket identity changed");
    }
  }
  private async json(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    this.assertSocket();
    if (this.pending.size >= 8) {
      throw new SeptError("Hands Engine concurrent control bound exceeded");
    }
    return this.own(
      exchange(
        this.socketPath,
        this.agent,
        method,
        `/${this.version}${path}`,
        body,
        this.abort.signal,
      ),
    );
  }
  private async qualify(): Promise<void> {
    const information = handsRecord(await this.json("GET", "/info"));
    if (information.ID !== this.daemonId || information.OperatingSystem !== this.operatingSystem) {
      throw new SeptError("Hands Engine daemon identity changed");
    }
  }
  /** Bounded live namespace facts are never inferred from the selected Docker context. */
  public async inspect(containerId: string): Promise<unknown> {
    await this.qualify();
    return this.json("GET", `/containers/${immutableId(containerId)}/json`);
  }
  /** Non-TTY full duplex preserves stdin EOF, stdout/stderr separation and actual exit code. */
  public async exec(containerId: string, execution: EngineExec): Promise<string> {
    await this.qualify();
    const created = handsRecord(
      await this.json("POST", `/containers/${immutableId(containerId)}/exec`, {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Cmd: execution.command,
        Env: [],
        WorkingDir: execution.cwd ?? "",
        User: execution.user ?? "",
        Privileged: execution.privileged ?? false,
      }),
    );
    const execId = immutableId(engineText(created.Id));
    const started = Date.now();
    this.assertSocket();
    const output = await this.own(
      attachment(
        this.socketPath,
        `/${this.version}/exec/${execId}/start`,
        execution,
        this.abort.signal,
      ),
    );
    const inspected = handsRecord(await this.json("GET", `/exec/${execId}/json`));
    if (
      inspected.ContainerID !== containerId ||
      inspected.Running !== false ||
      inspected.ExitCode !== 0
    ) {
      throw EngineControlError.at("exec-exit", started, {
        code: typeof inspected.ExitCode === "number" ? inspected.ExitCode : null,
        attachmentClosed: true,
        requestJoined: true,
      });
    }
    return output;
  }
  /** Release every retained control connection on failed initialization, operator completion or close. */
  public async close(): Promise<void> {
    this.closed = true;
    const socketsJoined = joinEngineConnections(this.agent);
    this.abort.abort();
    this.agent.destroy();
    await Promise.allSettled([...this.pending, socketsJoined]);
  }
  private own<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }
}
function exchange(
  socketPath: string,
  agent: Agent | undefined,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const input = engineBody(body);
    const control = controlRequest(socketPath, path, method, input, "http", agent, signal);
    const started = Date.now();
    let failure: EngineControlError | undefined;
    let output: Buffer | undefined;
    const fail = (timeout = false, overflow = false, status: number | null = null): void => {
      failure ??= EngineControlError.at("http", started, { status, timeout, overflow });
      control.destroy();
    };
    const timer = setTimeout(() => {
      fail(true);
    }, 30_000);
    registerResponse(control, fail, (result) => {
      output = result;
    });
    control.once("close", () => {
      clearTimeout(timer);
      settleResponse(
        output,
        failure?.joined({
          attachmentClosed: false,
          connectionsReleased: agent === undefined || signal?.aborted === true,
        }),
        resolve,
        reject,
      );
    });
    control.end(input);
  });
}
function attachment(
  socketPath: string,
  path: string,
  execution: EngineExec,
  signal: AbortSignal,
): Promise<string> {
  if (Buffer.byteLength(execution.input ?? "") > 512 * 1024) {
    throw new SeptError("Hands Engine stdin exceeds its bound");
  }
  const body = JSON.stringify({ Detach: false, Tty: false });
  return new Promise((resolve, reject) => {
    const control = controlRequest(socketPath, path, "POST", body, "exec", undefined, signal);
    beginAttachment(control, execution, signal, resolve, reject);
    control.end(body);
  });
}
function registerAttachment(
  control: ClientRequest,
  execution: EngineExec,
  fail: (error: Error) => void,
  settle: (output?: string) => void,
  signal: AbortSignal,
  connected: (socket: Socket) => void,
): void {
  const started = Date.now();
  control.once("upgrade", (response, socket, head) => {
    connected(socket);
    if (response.statusCode !== 101) {
      fail(EngineControlError.at("exec-upgrade", started, { status: response.statusCode ?? null }));
    }
    consumeHandsProcessStream(socket, head, execution, fail, settle, signal);
  });
  control.once("response", (response) => {
    response.destroy();
    fail(EngineControlError.at("exec-upgrade", started, { status: response.statusCode ?? null }));
  });
  control.once("error", () => {
    fail(EngineControlError.at(signal.aborted ? "closed-owner" : "exec-connect", started));
  });
}

function beginAttachment(
  control: ClientRequest,
  execution: EngineExec,
  signal: AbortSignal,
  resolve: (value: string) => void,
  reject: (error: unknown) => void,
): void {
  const requestJoined = new Promise<void>((join) => control.once("close", join));
  let socket: Socket | undefined;
  let failure: Error | undefined;
  const fail = (error: Error): void => {
    failure ??= error;
    control.destroy();
    socket?.destroy();
  };
  const timer = attachmentTimeout(fail);
  const settle = (output?: string): void => {
    clearTimeout(timer);
    settleAttachment(output, failure, resolve, reject);
  };
  registerAttachment(
    control,
    execution,
    fail,
    (output) => {
      settleJoined(requestJoined, settle, output);
    },
    signal,
    (connected) => {
      socket = connected;
    },
  );
  control.once("close", () => {
    if (socket === undefined) {
      settleJoined(requestJoined, settle);
    }
  });
}

function registerResponse(
  control: ClientRequest,
  fail: (timeout?: boolean, overflow?: boolean, status?: number | null) => void,
  complete: (result: Buffer) => void,
): void {
  control.once("response", (response) => {
    collectResponse(response, fail, complete);
  });
  control.once("error", () => {
    fail();
  });
}

function attachmentTimeout(fail: (error: Error) => void): NodeJS.Timeout {
  const started = Date.now();
  return setTimeout(() => {
    fail(EngineControlError.at("exec-stream", started, { timeout: true }));
  }, 30_000);
}

function settleJoined(
  joined: Promise<void>,
  settle: (output?: string) => void,
  output?: string,
): void {
  void joined.then(() => {
    settle(output);
  });
}
