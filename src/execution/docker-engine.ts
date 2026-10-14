import { collectHandsAttachment, engineExchange, openEngineAttachment } from "./engine-http.js";
/** Fixed bounded local Docker Engine operations; provisioning and endpoint selection stay consumer-owned. */
import { Agent } from "node:http";
import { SeptError } from "../durable/index.js";
import { EngineControlError, type EngineExec, type DockerHandsConfiguration } from "./contracts.js";
import { handsRecord } from "./protocol.js";
import { HandsAttachment } from "./hands-processes.js";
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
  private readonly attachments = new Set<HandsAttachment>();
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
    const version = handsRecord(await engineExchange(socketPath, undefined, "GET", "/version"));
    const selected = Math.min(52, apiMinor(version.ApiVersion));
    if (version.Os !== "linux" || selected < Math.max(44, apiMinor(version.MinAPIVersion))) {
      throw new SeptError("Hands Engine API or operating system is unsupported");
    }
    const api = `v1.${String(selected)}`;
    const information = handsRecord(
      await engineExchange(socketPath, undefined, "GET", `/${api}/info`),
    );
    const engine = new DockerEngineControl(socketPath, api, information);
    if (engine.socketIdentity !== identity) {
      await engine.close();
      throw new SeptError("Hands Engine socket changed during negotiation");
    }
    return engine;
  }
  private assertSocket(): void {
    if (this.closed) {
      throw EngineControlError.at("closed-owner", Date.now(), { connectionsReleased: true });
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
      engineExchange(
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
  /** Exact trusted exec creation retains a full-duplex attachment without a generic operation deadline. */
  public attach(containerId: string, execution: EngineExec): Promise<HandsAttachment> {
    // Register before any Engine request can start, so close cannot miss setup ownership.
    return this.own(Promise.resolve().then(() => this.startAttachment(containerId, execution)));
  }
  private async startAttachment(
    containerId: string,
    execution: EngineExec,
  ): Promise<HandsAttachment> {
    await this.qualify();
    if (this.attachments.size >= 8) {
      throw new SeptError("Hands Engine attachment bound exceeded");
    }
    const execId = await this.createExec(containerId, execution);
    await execution.beforeStart?.();
    this.assertSocket();
    const attachment = await this.own(
      openEngineAttachment({
        socketPath: this.socketPath,
        path: `/${this.version}/exec/${execId}/start`,
        execId,
        containerId,
        execution,
        signal: this.abort.signal,
      }),
    );
    if (this.closed) {
      await attachment.abort();
      throw EngineControlError.at("closed-owner", Date.now(), {
        requestJoined: true,
        attachmentClosed: true,
        connectionsReleased: true,
      });
    }
    this.attachments.add(attachment);
    void attachment.joined.then(() => this.attachments.delete(attachment));
    return attachment;
  }
  private async createExec(containerId: string, execution: EngineExec): Promise<string> {
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
    return immutableId(engineText(created.Id));
  }
  /** Exact daemon exec facts let the serial owner join detached descendants without waiting on inherited pipes. */
  public async inspectExec(execId: string): Promise<Record<string, unknown>> {
    return handsRecord(await this.json("GET", `/exec/${immutableId(execId)}/json`));
  }
  /** Daemon-created exec and current namespace generation bind the guarded startup receipt. */
  public async verifyAttachment(
    attachment: HandsAttachment,
    configuration: DockerHandsConfiguration,
  ): Promise<void> {
    const inspected = handsRecord(await this.json("GET", `/exec/${attachment.execId}/json`));
    const state = handsRecord(handsRecord(await this.inspect(configuration.containerId)).State);
    if (
      inspected.ContainerID !== configuration.containerId ||
      inspected.Running !== true ||
      typeof inspected.Pid !== "number" ||
      inspected.Pid <= 0 ||
      state.Running !== true ||
      state.StartedAt !== configuration.generation
    ) {
      throw new SeptError("Hands resident exec or generation identity was refused");
    }
  }
  /** Fixed finite control helpers still use EOF/exit; native bodies exclusively use the resident attachment. */
  public async exec(containerId: string, execution: EngineExec): Promise<string> {
    const input = execution.input ?? "";
    if (Buffer.byteLength(input) > 512 * 1024) {
      throw new SeptError("Hands Engine stdin exceeds its bound");
    }
    const attachment = await this.attach(containerId, execution);
    const started = Date.now();
    const timer = setTimeout(() => {
      void attachment.abort(EngineControlError.at("exec-stream", started, { timeout: true }));
    }, 30_000);
    try {
      const output = await collectHandsAttachment(attachment, execution);
      const inspected = handsRecord(await this.json("GET", `/exec/${attachment.execId}/json`));
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
    } finally {
      clearTimeout(timer);
      await attachment.abort();
    }
  }
  /** Release every retained control connection on failed initialization, operator completion or close. */
  public async close(): Promise<void> {
    this.closed = true;
    const connections = [
      ...Object.values(this.agent.sockets),
      ...Object.values(this.agent.freeSockets),
    ]
      .flat()
      .map((socket) =>
        socket === undefined || socket.closed
          ? Promise.resolve()
          : new Promise<void>((resolve) => socket.once("close", resolve)),
      );
    this.abort.abort();
    this.agent.destroy();
    await Promise.allSettled([
      ...this.pending,
      ...connections,
      ...[...this.attachments].map((attachment) => attachment.abort()),
    ]);
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
