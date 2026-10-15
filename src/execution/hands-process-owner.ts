/** Serial operation owns every process except the exact verified init, idle and resident lifetimes. */
import { StringDecoder } from "node:string_decoder";
import { SeptError } from "../durable/index.js";
import type { DockerEngineControl } from "./docker-engine.js";
import type { HandsAttachment } from "./hands-processes.js";
import { captureNamespaceLifetime } from "./hands-processes.js";
export { parseProcessIdentity } from "./protocol.js";
import { commandExecutable, CLEAN_COMMAND_ENV } from "./hands-command-authority.js";
import { handsRecord, parseProcessIdentity } from "./protocol.js";
import type {
  DockerHandsConfiguration,
  HandsCommandExit,
  HandsCommandStart,
  HandsCommandStream,
  NamespaceLifetime,
} from "./contracts.js";

interface ProcessIdentity {
  pid: number;
  start: string;
}
interface CommandOptions {
  network: boolean;
  timeout?: number;
  authorize: () => Promise<void>;
  signal: AbortSignal;
}
interface CommandState {
  attachment: HandsAttachment | undefined;
  termination: HandsCommandExit["termination"];
  stop: AbortController;
  bytes: number;
  stdoutBytes: number;
  attachmentClosed: boolean;
  joined?: Promise<void>;
  collecting?: Promise<void>;
}

/** Fixed image-owned privileged census/join is the sole cross-UID signal authority. */
export class HandsProcessOwner {
  private constructor(
    private readonly configuration: DockerHandsConfiguration,
    private readonly engine: DockerEngineControl,
    private readonly lifetime: NamespaceLifetime,
    private readonly resident: ProcessIdentity,
    private readonly idle: ProcessIdentity,
  ) {}
  /** Capture only the verified image init/sleep and authenticated resident; unknown siblings refuse startup. */
  public static async open(
    configuration: DockerHandsConfiguration,
    engine: DockerEngineControl,
    resident: ProcessIdentity,
  ): Promise<HandsProcessOwner> {
    const lifetime = await captureNamespaceLifetime(configuration, engine);
    const raw = await engine.exec(configuration.containerId, {
      command: processControl("--capture", lifetime, resident),
      user: "0:0",
      privileged: true,
      maximum: 1024,
    });
    const input = handsRecord(JSON.parse(raw));
    const idle = parseProcessIdentity(input.idle);
    if (Object.keys(input).length !== 1 || idle.pid === resident.pid) {
      throw new SeptError("Hands lifetime capture was refused");
    }
    return new HandsProcessOwner(configuration, engine, lifetime, resident, idle);
  }
  /** Register before Engine start; parent supplies exact fixed bytes/cwd/network/budget and rechecks after registration. */
  public async execute(
    command: HandsCommandStart,
    options: CommandOptions,
    output: (text: string, stream: HandsCommandStream) => Promise<void>,
  ): Promise<HandsCommandExit> {
    const state: CommandState = {
      attachment: undefined,
      termination: "exit",
      stop: new AbortController(),
      bytes: 0,
      stdoutBytes: 0,
      attachmentClosed: false,
    };
    const abort = (): void => {
      this.interrupt(state, "aborted");
    };
    options.signal.addEventListener("abort", abort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      state.attachment = await this.startCommand(command, state, options);
      void state.attachment.joined.then(() => {
        state.attachmentClosed = true;
      });
      if (options.timeout !== undefined) {
        timer = setTimeout(() => {
          this.interrupt(state, "timeout");
        }, options.timeout);
      }
      return await this.runCommand(command, state, output);
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      await this.finalizeCommand(state);
    }
  }
  private async finalizeCommand(state: CommandState): Promise<void> {
    // Cleanup failure propagates to the backend's exact-generation stop; it is never an ordinary successful exit.
    try {
      await (state.joined ?? this.join());
    } finally {
      try {
        await state.attachment?.abort();
      } finally {
        await state.collecting;
      }
    }
  }
  private async startCommand(
    command: HandsCommandStart,
    state: CommandState,
    options: CommandOptions,
  ): Promise<HandsAttachment> {
    return this.engine.attach(this.configuration.containerId, {
      command: commandExecutable(command, options.network),
      cwd: command.cwd,
      user: "10003:10002",
      commandOutput: true,
      beforeStart: async () => {
        await options.authorize();
        if (options.signal.aborted || state.stop.signal.aborted) {
          throw new SeptError("Hands command was cancelled before Engine start");
        }
      },
    });
  }
  private interrupt(state: CommandState, termination: HandsCommandExit["termination"]): void {
    // Native limit cancellation cannot hide a later fatal cause while output drains; retain the first fatal cause.
    if (state.termination === "exit" || state.termination === "aborted") {
      state.termination = termination;
    }
    state.stop.abort();
  }
  private async runCommand(
    command: HandsCommandStart,
    state: CommandState,
    output: (text: string, stream: HandsCommandStream) => Promise<void>,
  ): Promise<HandsCommandExit> {
    const attachment = state.attachment;
    if (attachment === undefined) {
      throw new SeptError("Hands command attachment is absent");
    }
    const collecting = this.streamCommand(command, state, attachment, output);
    state.collecting = collecting;
    // Stream failure wakes the polling owner; retain its rejection until all mandatory cleanup has joined.
    void collecting.catch(() => {
      this.interrupt(state, "overflow");
    });
    await attachment.end("input" in command ? command.input : "");
    await this.waitCommand(attachment, state);
    // Root exit is insufficient: Engine siblings/setsid descendants can still hold pipes and sockets.
    state.joined = this.join();
    await state.joined;
    await attachment.close();
    await collecting;
    attachment.assertJoined();
    return {
      code: await this.terminalExit(attachment),
      signal: null,
      termination: state.termination,
    };
  }
  private async waitCommand(attachment: HandsAttachment, state: CommandState): Promise<void> {
    while (!state.stop.signal.aborted) {
      const inspected = await this.engine.inspectExec(attachment.execId);
      if (inspected.ContainerID !== this.configuration.containerId) {
        throw new SeptError("Hands command exec identity changed");
      }
      if (inspected.Running === false) {
        return;
      }
      if (state.attachmentClosed) {
        attachment.assertJoined();
        throw new SeptError("Hands command stream closed before its exec joined");
      }
      if (inspected.Running !== true) {
        throw new SeptError("Hands command exec state is uncertain");
      }
      await commandPause(state.stop.signal);
    }
  }
  private async terminalExit(attachment: HandsAttachment): Promise<number> {
    // The bounded exact Engine read happens after pidfd join, including timeout/abort/overflow; no stale null exit is reported.
    const inspected = await this.engine.inspectExec(attachment.execId);
    if (
      inspected.ContainerID !== this.configuration.containerId ||
      inspected.Running !== false ||
      typeof inspected.ExitCode !== "number" ||
      !Number.isSafeInteger(inspected.ExitCode) ||
      inspected.ExitCode < 0
    ) {
      throw new SeptError("Hands joined command terminal facts are uncertain");
    }
    return inspected.ExitCode;
  }
  private async streamCommand(
    command: HandsCommandStart,
    state: CommandState,
    attachment: HandsAttachment,
    output: (text: string, stream: HandsCommandStream) => Promise<void>,
  ): Promise<void> {
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const emit = (text: string, stream: HandsCommandStream): Promise<void> =>
      output(text, command.program === "bash" ? "stdout" : stream);
    const chunks: AsyncIterable<unknown> = attachment.output;
    for await (const raw of chunks) {
      const chunk = handsRecord(raw);
      if (
        !Buffer.isBuffer(chunk.data) ||
        (chunk.stream !== "stdout" && chunk.stream !== "stderr")
      ) {
        throw new SeptError("Hands command output is not bytes");
      }
      if (!this.admitOutput(command, state, chunk.data, chunk.stream)) {
        this.interrupt(state, "overflow");
        continue;
      }
      for (let offset = 0; offset < chunk.data.length; offset += 65536) {
        const text = decoders[chunk.stream].write(chunk.data.subarray(offset, offset + 65536));
        await emit(text, chunk.stream);
      }
    }
    for (const stream of ["stdout", "stderr"] as const) {
      const trailing = decoders[stream].end();
      if (trailing.length > 0) {
        await emit(trailing, stream);
      }
    }
  }
  private admitOutput(
    command: HandsCommandStart,
    state: CommandState,
    bytes: Buffer,
    stream: HandsCommandStream,
  ): boolean {
    state.bytes += bytes.length;
    state.stdoutBytes += stream === "stdout" ? bytes.length : 0;
    return (
      state.bytes <= 4 * 1024 * 1024 && (command.program !== "custom" || state.stdoutBytes <= 4096)
    );
  }
  /** Exempt only pinned PID+start lifetimes and this completed fixed helper; no PID ancestry/group assumptions. */
  public async join(): Promise<void> {
    const raw = await this.engine.exec(this.configuration.containerId, {
      command: processControl("--join", this.lifetime, this.resident, this.idle),
      user: "0:0",
      privileged: true,
      maximum: 1024,
      beforeStart: () => this.assertGeneration(),
    });
    const result = handsRecord(JSON.parse(raw));
    if (
      result.joined !== true ||
      result.remaining !== 0 ||
      typeof result.signaled !== "number" ||
      !Number.isSafeInteger(result.signaled) ||
      result.signaled < 0 ||
      Object.keys(result).length !== 3
    ) {
      throw new SeptError("Hands process join is unverified");
    }
    await this.assertGeneration();
  }
  private async assertGeneration(): Promise<void> {
    const state = handsRecord(
      handsRecord(await this.engine.inspect(this.configuration.containerId)).State,
    );
    if (state.Running !== true || state.StartedAt !== this.configuration.generation) {
      throw new SeptError("Hands process namespace generation changed");
    }
  }
}
function processControl(
  mode: "--capture" | "--join",
  lifetime: NamespaceLifetime,
  resident: ProcessIdentity,
  idle?: ProcessIdentity,
): string[] {
  return [
    ...CLEAN_COMMAND_ENV,
    "LD_PRELOAD=/app/hands-guard.so",
    "SEPT_HANDS_NETWORK=0",
    "/app/hands-process-control",
    mode,
    lifetime.pidNamespace,
    lifetime.initStart,
    String(resident.pid),
    resident.start,
    ...(idle === undefined ? [] : [String(idle.pid), idle.start]),
  ];
}
function commandPause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 25);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) {
      finish();
    }
  });
}
