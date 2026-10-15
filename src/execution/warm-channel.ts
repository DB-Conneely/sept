import { warmHandsHandshake } from "./warm-handshake.js";
import { type HandsPendingOperation } from "./contracts.js";
import type { HandsCommandHandler } from "./contracts.js";
import { assertHandsCorrelation } from "./contracts.js";
import { guardedCommand } from "./hands-processes.js";
/** One authenticated attachment, bounded serial RPC and operation-local authority; no grant is cached here. */
import { randomBytes, createHash } from "node:crypto";
import { SeptError } from "../durable/index.js";
import type { DockerHandsConfiguration, HandsRequest } from "./contracts.js";
import { EngineControlError } from "./contracts.js";
import { capabilityBinding } from "./capability-admission.js";
import type { DockerEngineControl } from "./docker-engine.js";
import { type HandsAttachment } from "./hands-processes.js";
import {
  encodeHandsFrame,
  HandsFrameDecoder,
  HANDS_RESPONSE_BYTES,
  type HandsCorrelation,
  type HandsFrame,
} from "./protocol.js";

/** Ordinary resident refusal is distinct from broken framing/authority and does not authorize a retry. */
export class HandsOperationError extends SeptError {}
/** Trusted Engine/lease owner opens exactly one immutable guarded executor; operation authority is refreshed each call. */
export class WarmHandsChannel {
  public readonly correlation: HandsCorrelation;
  public readonly identity: { pid: number; start: string };
  private sequence = 0;
  private pending: HandsPendingOperation | undefined;
  private failure: Error | undefined;
  private closing: Promise<void> | undefined;
  private decoder: HandsFrameDecoder | undefined;
  private readonly started = Date.now();
  private constructor(
    private readonly attachment: HandsAttachment,
    correlation: HandsCorrelation,
    hello: Extract<HandsFrame, { kind: "hello" }>,
    private readonly lost?: (error: Error) => void,
  ) {
    this.correlation = correlation;
    this.identity = { pid: hello.payload.pid, start: hello.payload.start };
  }
  /** Socket/daemon/exec provenance is qualified by the Engine; challenge and exact generation bind its guard receipt. */
  public static async open(
    configuration: DockerHandsConfiguration,
    engine: DockerEngineControl,
    cwd: string,
    lost?: (error: Error) => void,
  ): Promise<WarmHandsChannel> {
    const correlation: HandsCorrelation = {
      version: 1,
      generation: configuration.generation,
      configuration: createHash("sha256")
        .update(JSON.stringify(capabilityBinding(configuration)))
        .digest("hex"),
      session: randomBytes(32).toString("hex"),
      sequence: 0,
    };
    const challenge = randomBytes(32).toString("hex");
    const bootstrap = JSON.stringify({ ...correlation, challenge });
    const attachment = await engine.attach(configuration.containerId, {
      cwd,
      user: "10002:10002",
      command: guardedCommand(["/app/dist/src/execution/hands-entry.js", bootstrap]),
    });
    try {
      const hello = await warmHandsHandshake(attachment, correlation, challenge);
      await engine.verifyAttachment(attachment, configuration);
      const channel = new WarmHandsChannel(attachment, correlation, hello, lost);
      channel.listen();
      return channel;
    } catch (error: unknown) {
      await attachment.abort();
      throw error;
    }
  }
  /** Backend FIFO owns admission; only one operation can become externally active on this channel. */
  public async invoke(
    request: HandsRequest,
    authorize: HandsPendingOperation["authorize"],
    startCommand?: HandsCommandHandler,
  ): Promise<unknown> {
    if (this.failure !== undefined || this.closing !== undefined || this.pending !== undefined) {
      throw this.failure ?? new SeptError("Hands channel is unavailable or busy");
    }
    this.attachment.resetBudget();
    if (this.decoder === undefined) {
      throw new SeptError("Hands frame owner is absent");
    }
    this.decoder.beginOperation();
    this.sequence += 1;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending = {
        sequence: this.sequence,
        authorize,
        resolve,
        reject,
        bytes: 0,
        effect: 0,
        stage: "operation",
        ...(startCommand === undefined ? {} : { startCommand }),
      };
    });
    try {
      await this.attachment.write(
        encodeHandsFrame({
          ...this.correlation,
          sequence: this.sequence,
          kind: "operation",
          payload: request,
        }),
      );
    } catch (error: unknown) {
      this.fail(error);
    }
    return result;
  }
  private listen(): void {
    const decoder = new HandsFrameDecoder(
      HANDS_RESPONSE_BYTES,
      (frame) => {
        this.receive(frame);
      },
      (error) => {
        this.fail(error);
      },
    );
    this.decoder = decoder;
    this.attachment.stdout.on("data", (chunk: Buffer) => {
      try {
        decoder.write(chunk);
      } catch (error: unknown) {
        this.fail(error);
      }
    });
    this.attachment.stdout.resume();
    void this.attachment.joined.then(() => {
      try {
        // Physical join retains the attachment owner's original stream/timing facts before RPC EOF fallback.
        this.attachment.assertJoined();
        decoder.finish();
      } catch (error: unknown) {
        this.fail(error);
      }
      if (this.closing === undefined) {
        this.fail(
          EngineControlError.at("rpc-lost", this.started, {
            requestJoined: true,
            attachmentClosed: true,
            connectionsReleased: true,
          }),
        );
      }
    });
  }
  private receive(frame: HandsFrame): void {
    assertHandsCorrelation(frame, this.correlation, this.sequence);
    const pending = this.pending;
    if (pending === undefined) {
      throw new SeptError("Hands unsolicited frame was refused");
    }
    pending.bytes += Buffer.byteLength(JSON.stringify(frame.payload));
    if (pending.bytes > HANDS_RESPONSE_BYTES + 65536) {
      throw new SeptError("Hands operation frame budget exceeded");
    }
    if (frame.kind === "effect-check") {
      this.authorize(frame, pending);
      return;
    }
    if (frame.kind === "command-start") {
      this.startCommand(frame, pending);
      return;
    }
    if (this.cancelCommand(frame, pending)) {
      return;
    }
    if (frame.kind !== "result" && frame.kind !== "error") {
      throw new SeptError("Hands unexpected control frame was refused");
    }
    if (pending.stage !== "executing") {
      throw new SeptError("Hands reply preceded effect authorization");
    }
    void this.settle(frame, pending).catch((error: unknown) => {
      this.fail(error);
    });
  }
  private cancelCommand(frame: HandsFrame, pending: HandsPendingOperation): boolean {
    if (
      frame.kind !== "cancel" ||
      pending.command === undefined ||
      frame.payload.commandId !== pending.command.id
    ) {
      return false;
    }
    pending.command.abort.abort();
    return true;
  }
  private async settle(
    frame: Extract<HandsFrame, { kind: "result" | "error" }>,
    pending: HandsPendingOperation,
  ): Promise<void> {
    await pending.command?.joined;
    if (this.pending !== pending || this.failure !== undefined) {
      throw new SeptError("Hands command result parent was lost");
    }
    this.pending = undefined;
    if (frame.kind === "error") {
      if (frame.payload.stage !== "operation") {
        pending.reject(EngineControlError.at("rpc-protocol", this.started));
        this.fail(EngineControlError.at("rpc-protocol", this.started));
        return;
      }
      pending.reject(new HandsOperationError(`Hands operation refused at ${frame.payload.stage}`));
    } else {
      pending.resolve(frame.payload);
    }
  }
  private startCommand(
    frame: Extract<HandsFrame, { kind: "command-start" }>,
    pending: HandsPendingOperation,
  ): void {
    const start = pending.startCommand;
    if (
      pending.stage !== "executing" ||
      pending.command !== undefined ||
      start === undefined ||
      frame.payload.commandId !== 1
    ) {
      throw new SeptError("Hands command start order was refused");
    }
    const abort = new AbortController();
    // Ownership exists before the parent callback can create an Engine exec, including its setup gap.
    const joined = Promise.resolve().then(async () => {
      const exit = await start(
        frame.payload,
        async (text, stream) => {
          if (this.pending !== pending || this.failure !== undefined) {
            throw new SeptError("Hands command output parent was lost");
          }
          await this.attachment.write(
            encodeHandsFrame({
              ...frame,
              kind: "command-data",
              payload: { commandId: 1, stream, text },
            }),
          );
        },
        abort.signal,
      );
      await this.attachment.write(
        encodeHandsFrame({ ...frame, kind: "command-exit", payload: { commandId: 1, ...exit } }),
      );
    });
    pending.command = { id: 1, abort, joined };
    void joined.catch((error: unknown) => {
      this.fail(error);
    });
  }
  private authorize(
    frame: Extract<HandsFrame, { kind: "effect-check" }>,
    pending: HandsPendingOperation,
  ): void {
    if (pending.stage === "authorizing" || frame.payload.effect !== pending.effect + 1) {
      throw new SeptError("Hands effect sequence was refused");
    }
    pending.effect = frame.payload.effect;
    pending.stage = "authorizing";
    void pending
      .authorize(frame)
      .then(async () => {
        if (this.pending !== pending || this.failure !== undefined) {
          throw new SeptError("Hands effect parent was lost");
        }
        pending.stage = "executing";
        await this.attachment.write(
          encodeHandsFrame({
            ...this.correlation,
            sequence: pending.sequence,
            kind: "ack",
            payload: { effect: pending.effect, allowed: true },
          }),
        );
      })
      .catch((error: unknown) => {
        this.fail(error);
      });
  }
  private fail(error: unknown): void {
    if (this.failure !== undefined) {
      return;
    }
    this.failure = error instanceof Error ? error : new SeptError("Hands RPC failed");
    // The backend seals admission synchronously, including idle loss before a later native call.
    this.lost?.(this.failure);
    this.pending?.command?.abort.abort();
    this.pending?.reject(this.failure);
    this.pending = undefined;
    void this.attachment.abort();
  }
  /** Release only this interrupted transport; the backend separately verifies exact namespace shutdown. */
  public release(): Promise<void> {
    this.closing ??= this.attachment.abort();
    return this.closing;
  }
  /** Idle EOF joins the resident without stopping consumer infrastructure; uncertain work is stopped by the backend. */
  public close(): Promise<void> {
    this.closing ??= this.attachment.close();
    return this.closing;
  }
}
