/** Owns fixed guarded process-lifetime capture and pinned namespace shutdown; operations remain cold. */
import type { Socket } from "node:net";
import type { DockerEngineControl } from "./docker-engine.js";
import { SeptError } from "../durable/index.js";
import {
  EngineControlError,
  type DockerHandsConfiguration,
  type EngineExec,
  type NamespaceLifetime,
} from "./contracts.js";
import { handsRecord, HANDS_RESPONSE_BYTES } from "./protocol.js";
// env -i excludes a forged marker; only the immutable constructor acknowledges kernel protection.
const GUARD_PRELOAD =
  "data:text/javascript," +
  encodeURIComponent(
    "if (process.env.SEPT_HANDS_PROCESS_GUARD !== '2' || !['denied', 'granted'].includes(process.env.SEPT_HANDS_NETWORK_GUARD)) process.exit(126);",
  );
const GUARDED_ENV = [
  "/usr/bin/env",
  "-i",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "HOME=/home/sept-hands",
  "PI_CODING_AGENT_DIR=/home/sept-hands/.pi/agent",
  "TMPDIR=/tmp",
  "PI_OFFLINE=1",
  "LD_PRELOAD=/app/hands-guard.so",
];
const GUARDED_NODE = ["node", "--disable-sigusr1", "--import", GUARD_PRELOAD];

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

/** Fixed image Node/guard/environment only; trusted composition supplies the executable arguments. */
export function guardedCommand(
  arguments_: string[],
  rights: { network: boolean } = { network: false },
): string[] {
  return [
    ...GUARDED_ENV,
    `SEPT_HANDS_NETWORK=${rights.network ? "1" : "0"}`,
    ...GUARDED_NODE,
    ...arguments_,
  ];
}
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
/** Join the fixed stop handshake and final authority check before its attachment settles. */
export function pinnedConfirmation(
  socket: Socket,
  execution: EngineExec,
  fail: (error: Error) => void,
): { observe: (chunk: Buffer) => void; join: () => Promise<void> } {
  let prefix = Buffer.alloc(0);
  let confirming = Promise.resolve();
  const observe = (chunk: Buffer): void => {
    if (execution.confirm === undefined) {
      return;
    }
    if (prefix.length + chunk.length > 7) {
      fail(EngineControlError.at("stop-handshake", Date.now()));
      return;
    }
    prefix = Buffer.concat([prefix, chunk]);
    if (!Buffer.from("pinned\n").subarray(0, prefix.length).equals(prefix)) {
      fail(EngineControlError.at("stop-handshake", Date.now(), {}));
      return;
    }
    if (prefix.length === 7) {
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

/** Own and join the cold process attachment, including its pinned confirmation, before settlement. */
export function consumeHandsProcessStream(
  socket: Socket,
  head: Buffer,
  execution: EngineExec,
  fail: (error: Error) => void,
  settle: (output?: string) => void,
  signal: AbortSignal,
): void {
  const confirmation = pinnedConfirmation(socket, execution, fail);
  const decoder = new EngineStreamDecoder(
    execution.maximum ?? HANDS_RESPONSE_BYTES,
    confirmation.observe,
  );
  let output: string | undefined;
  const abort = processAbort(signal, fail);
  const consume = (chunk: Buffer): void => {
    readProcessChunk(decoder, chunk, fail);
  };
  socket.allowHalfOpen = true;
  socket.on("data", consume);
  socket.once("error", () => {
    fail(new SeptError("Hands Engine exec stream failed"));
  });
  socket.once("end", () => {
    output = finishProcessStream(decoder, fail);
    socket.destroy();
  });
  socket.once("close", () => {
    signal.removeEventListener("abort", abort);
    void confirmation.join().then(() => {
      settle(output);
    });
  });
  consume(head);
  if (execution.confirm === undefined) {
    socket.end(execution.input ?? "");
  }
}

function finishProcessStream(
  decoder: EngineStreamDecoder,
  fail: (error: Error) => void,
): string | undefined {
  try {
    return decoder.finish();
  } catch (error: unknown) {
    fail(error instanceof Error ? error : new SeptError("Hands Engine exec failed"));
    return undefined;
  }
}

/** Docker's eight-byte stream headers are data framing only, never command/authority messages. */
export class EngineStreamDecoder {
  private header = Buffer.alloc(0);
  private remaining = 0;
  private stream = 0;
  private frames = 0;
  private bytes = 0;
  private readonly output: Buffer[] = [];
  public constructor(
    private readonly maximum: number,
    private readonly observe?: (chunk: Buffer) => void,
  ) {}
  /** Bound all stdout/stderr bytes before retaining stdout; stderr is drained without accumulation. */
  public write(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.remaining === 0) {
        const copied = Math.min(8 - this.header.length, chunk.length - offset);
        this.header = Buffer.concat([this.header, chunk.subarray(offset, offset + copied)]);
        offset += copied;
        if (this.header.length !== 8) {
          continue;
        }
        this.openFrame();
      } else {
        const copied = Math.min(this.remaining, chunk.length - offset);
        if (this.stream === 1) {
          const output = Buffer.from(chunk.subarray(offset, offset + copied));
          this.output.push(output);
          this.observe?.(output);
        }
        offset += copied;
        this.remaining -= copied;
      }
    }
  }
  private openFrame(): void {
    this.stream = this.header[0] ?? -1;
    this.remaining = this.header.readUInt32BE(4);
    this.frames += 1;
    this.bytes += this.remaining;
    const reserved = this.header.subarray(1, 4).some((byte) => byte !== 0);
    this.header = Buffer.alloc(0);
    if (reserved || (this.stream !== 1 && this.stream !== 2) || this.frames > 65536) {
      throw new SeptError("Hands Engine stream framing is malformed");
    }
    if (this.bytes > this.maximum) {
      throw new EngineControlError({
        stage: "exec-stream",
        elapsedMs: 0,
        code: null,
        signal: null,
        status: null,
        timeout: false,
        overflow: true,
        requestJoined: false,
        attachmentClosed: false,
        connectionsReleased: false,
      });
    }
  }
  /** EOF must coincide with a complete frame; a lost reply is never successful settlement. */
  public finish(): string {
    if (this.header.length !== 0 || this.remaining !== 0) {
      throw new SeptError("Hands Engine stream ended inside a frame");
    }
    return Buffer.concat(this.output).toString("utf8");
  }
}

function readProcessChunk(
  decoder: EngineStreamDecoder,
  chunk: Buffer,
  fail: (error: Error) => void,
): void {
  try {
    decoder.write(chunk);
  } catch (error: unknown) {
    fail(error instanceof Error ? error : new SeptError("Hands Engine exec failed"));
  }
}

function processAbort(signal: AbortSignal, fail: (error: Error) => void): () => void {
  const abort = (): void => {
    fail(EngineControlError.at("closed-owner", Date.now()));
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  return abort;
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
