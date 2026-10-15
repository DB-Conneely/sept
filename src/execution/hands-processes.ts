import { guardedCommand } from "./hands-guarded-command.js";
import { EngineStreamDecoder } from "./engine-stream.js";
/** Owns guarded resident/helper attachments, exact namespace lifetime capture and pinned shutdown. */
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import type { DockerEngineControl } from "./docker-engine.js";
import { SeptError } from "../durable/index.js";
import {
  EngineControlError,
  type DockerHandsConfiguration,
  type EngineExec,
  type NamespaceLifetime,
} from "./contracts.js";
import { handsRecord, HANDS_RESPONSE_BYTES } from "./protocol.js";
// Only fixed guarded control code reads lifetime facts or signals the namespace init.
const NAMESPACE_FACTS = `const fs = require('node:fs');
function lifetime() {
  const stat = fs.readFileSync('/proc/1/stat', 'utf8');
  if (stat.length > 16384) process.exit(126);
  return { pidNamespace: fs.readlinkSync('/proc/self/ns/pid'), initStart: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
}`;
const NAMESPACE_CAPTURE = NAMESPACE_FACTS + `process.stdout.write(JSON.stringify(lifetime()));`;
const NAMESPACE_STOP =
  NAMESPACE_FACTS +
  `
if (JSON.stringify(lifetime()) !== JSON.stringify({ pidNamespace: process.argv[1], initStart: process.argv[2] })) process.exit(126);
let input = '';
process.stdin.on('data', chunk => {
  input += chunk.toString();
  if (input.length > 5 || !'stop\\n'.startsWith(input)) process.exit(126);
  if (input === 'stop\\n') process.kill(1, 'SIGTERM');
});
process.stdin.on('end', () => { if (input !== 'stop\\n') process.exit(126); });
process.stdout.write('pinned\\n');`;

/** Capture kernel lifetime, then recheck the daemon generation before any receipt/admission. */
export async function captureNamespaceLifetime(
  configuration: DockerHandsConfiguration,
  engine: DockerEngineControl,
): Promise<NamespaceLifetime> {
  const raw = await engine.exec(configuration.containerId, {
    user: "0:0",
    privileged: true,
    command: guardedCommand(["--eval", NAMESPACE_CAPTURE]),
    maximum: 1024,
  });
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SeptError("Hands kernel lifetime capture is malformed");
  }
  const lifetime = parseNamespaceLifetime(value);
  await assertRunningGeneration(configuration, engine);
  return lifetime;
}
async function assertRunningGeneration(
  binding: { containerId: string; generation: string },
  engine: DockerEngineControl,
): Promise<void> {
  const state = handsRecord(handsRecord(await engine.inspect(binding.containerId)).State);
  if (state.Running !== true || state.StartedAt !== binding.generation) {
    throw new SeptError("Hands namespace generation changed before its control action");
  }
}
/** Stop only a pinned captured namespace; a replacement never receives its stop acknowledgment. */
export async function stopCapturedNamespace(
  binding: { containerId: string; generation: string },
  lifetime: NamespaceLifetime,
  engine: DockerEngineControl,
): Promise<void> {
  await engine.exec(binding.containerId, {
    user: "0:0",
    privileged: true,
    command: guardedCommand(["--eval", NAMESPACE_STOP, lifetime.pidNamespace, lifetime.initStart]),
    maximum: 128,
    confirm: () => assertRunningGeneration(binding, engine),
  });
}
function pinnedConfirmation(
  socket: Socket,
  execution: EngineExec,
  fail: (error: Error) => void,
): { observe: (chunk: Buffer) => void; join: () => Promise<void> } {
  let prefix = "";
  let confirming = Promise.resolve();
  const observe = (chunk: Buffer): void => {
    if (execution.confirm === undefined) {
      return;
    }
    prefix += chunk.toString("utf8");
    if (prefix.length > 7 || !"pinned\n".startsWith(prefix)) {
      fail(EngineControlError.at("stop-handshake", Date.now()));
      return;
    }
    if (prefix === "pinned\n") {
      confirming = execution
        .confirm()
        .then(() => {
          if (socket.destroyed) {
            throw new SeptError("Pinned stop attachment was lost");
          }
          socket.end("stop\n");
        })
        .catch((error: unknown) => {
          fail(error instanceof Error ? error : new SeptError("Pinned stop confirmation failed"));
        });
    }
  };
  return { observe, join: (): Promise<void> => confirming };
}
/** Strict private kernel facts; no task field may select a namespace/init lifetime. */
export function parseNamespaceLifetime(value: unknown): NamespaceLifetime {
  const input = handsRecord(value);
  if (
    Object.keys(input).length !== 2 ||
    typeof input.pidNamespace !== "string" ||
    !/^pid:\[\d{1,20}\]$/.test(input.pidNamespace) ||
    typeof input.initStart !== "string" ||
    !/^\d{1,20}$/.test(input.initStart)
  ) {
    throw new SeptError("Hands kernel lifetime facts are malformed");
  }
  return { pidNamespace: input.pidNamespace, initStart: input.initStart };
}

/** Kernel immutable seals prevent outside writers substituting service channels after provenance preflight. */
export async function validateSealedInputs(
  configuration: DockerHandsConfiguration,
  engine: DockerEngineControl,
): Promise<void> {
  if (configuration.dataDomain !== "private") {
    return;
  }
  for (const mount of configuration.readOnlyMounts) {
    const result = await engine.exec(configuration.containerId, {
      command: ["/app/hands-guard-check", "--sealed", mount.destination],
      maximum: 128,
    });
    if (result !== "sealed\n") {
      throw new SeptError("Selected input lacks enforced kernel immutable provenance");
    }
  }
}

/** One exact non-TTY exec socket; commands retain bounded tagged bytes, control stderr is drained. */
export class HandsAttachment {
  public readonly stdout = new PassThrough({ highWaterMark: 65536 });
  public readonly output = new PassThrough({ objectMode: true, highWaterMark: 1 });
  public readonly joined: Promise<void>;
  private readonly decoder: EngineStreamDecoder;
  private failure: Error | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly started = Date.now();
  private partialStarted = this.started;
  public constructor(
    public readonly execId: string,
    public readonly containerId: string,
    private readonly socket: Socket,
    head: Buffer,
    requestJoined: Promise<void>,
    signal: AbortSignal,
    execution: EngineExec,
  ) {
    const confirmation = pinnedConfirmation(socket, execution, (error) => {
      this.fail(error);
    });
    this.decoder = this.outputDecoder(execution, confirmation.observe);
    socket.allowHalfOpen = true;
    const abort = (): void => {
      this.fail(EngineControlError.at("closed-owner", Date.now()));
    };
    signal.addEventListener("abort", abort, { once: true });
    this.joined = new Promise<void>((resolve) => socket.once("close", resolve)).then(async () => {
      clearTimeout(this.timer);
      signal.removeEventListener("abort", abort);
      this.stdout.end();
      this.output.end();
      await requestJoined;
      await confirmation.join();
    });
    this.observeSocket();
    this.consume(head);
    if (signal.aborted) {
      abort();
    }
  }
  private outputDecoder(
    execution: EngineExec,
    confirm: (chunk: Buffer) => void,
  ): EngineStreamDecoder {
    this.stdout.on("drain", () => this.socket.resume());
    this.output.on("drain", () => this.socket.resume());
    return new EngineStreamDecoder(HANDS_RESPONSE_BYTES + 65536, (chunk, stream) => {
      if (execution.commandOutput === true) {
        if (!this.output.write({ data: chunk, stream: stream === 1 ? "stdout" : "stderr" })) {
          this.socket.pause();
        }
      } else if (stream === 1) {
        confirm(chunk);
        if (!this.stdout.write(chunk)) {
          this.socket.pause();
        }
      }
    });
  }
  private observeSocket(): void {
    this.socket.on("data", (chunk: Buffer) => {
      this.consume(chunk);
    });
    this.socket.once("error", () => {
      this.fail(EngineControlError.at("exec-stream", this.started));
    });
    this.socket.once("end", () => {
      try {
        this.decoder.finish();
      } catch (error: unknown) {
        this.fail(error);
      }
      this.socket.destroy();
    });
  }
  private consume(chunk: Buffer): void {
    try {
      this.decoder.write(chunk);
      if (this.decoder.partial()) {
        if (this.timer === undefined) {
          this.partialStarted = Date.now();
          this.timer = setTimeout(() => {
            this.fail(
              EngineControlError.at("exec-partial-frame", this.partialStarted, { timeout: true }),
            );
          }, 10_000);
        }
      } else {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
    } catch (error: unknown) {
      this.fail(error);
    }
  }
  private fail(error: unknown): void {
    this.failure ??= error instanceof Error ? error : new SeptError("Hands attachment failed");
    this.socket.destroy();
  }
  /** Reset only after prior operation settlement; transport metadata is never authority. */
  public resetBudget(): void {
    this.decoder.resetBudget();
  }
  /** Await kernel-stream backpressure before sending another bounded control frame. */
  public write(input: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setTimeout(() => {
        this.fail(EngineControlError.at("exec-write", started, { timeout: true }));
      }, 10_000);
      this.socket.write(input, (error) => {
        clearTimeout(timer);
        if (error !== null && error !== undefined) {
          reject(this.failure ?? EngineControlError.at("exec-write", started));
        } else {
          resolve();
        }
      });
    });
  }
  /** Finite trusted helpers half-close stdin; the resident stays attached until its owner closes it. */
  public end(input: string): Promise<void> {
    return new Promise((resolve) => this.socket.end(input, resolve));
  }
  /** Closed helper output is successful only after its parser and socket owner joined without loss. */
  public assertJoined(): void {
    if (this.failure !== undefined) {
      throw this.failure instanceof EngineControlError
        ? this.failure.joined({ attachmentClosed: true, connectionsReleased: true })
        : this.failure;
    }
  }
  /** EOF is an idle shutdown request; a bounded deadline cannot be mistaken for acknowledged closure. */
  public async close(): Promise<void> {
    if (!this.socket.writableEnded && !this.socket.destroyed) {
      this.socket.end();
    }
    const started = Date.now();
    const timer = setTimeout(() => {
      this.fail(EngineControlError.at("exec-shutdown", started, { timeout: true }));
    }, 5000);
    try {
      await this.joined;
      if (this.failure !== undefined) {
        throw this.failure;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  /** Failure/loss releases the exact owned socket, never another namespace process. */
  public async abort(error?: Error): Promise<void> {
    if (error !== undefined) {
      this.fail(error);
    }
    this.socket.destroy();
    await this.joined;
  }
}

export { guardedCommand } from "./hands-guarded-command.js";
