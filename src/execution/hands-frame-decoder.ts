/** Length-framed RPC byte ownership; complete native work is bounded only by its enclosing run/command budget. */
import { SeptError } from "../durable/index.js";
import { EngineControlError, type HandsFrame } from "./contracts.js";
import { parseHandsFrame } from "./protocol.js";
/** Prefix/partial-frame owner. Capacity is checked before allocation; incomplete frames cannot wait forever. */
export class HandsFrameDecoder {
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private body: Buffer | undefined;
  private bodyBytes = 0;
  private frames = 0;
  private timer: NodeJS.Timeout | undefined;
  private started = Date.now();
  public constructor(
    private readonly maximum: number,
    private readonly accept: (frame: HandsFrame) => void,
    private readonly fail: (error: Error) => void,
  ) {}
  /** Feed exact stream bytes; several frames or any byte split are supported without trailing data. */
  public write(chunk: Buffer): void {
    try {
      this.consume(chunk);
    } catch (error: unknown) {
      clearTimeout(this.timer);
      this.timer = undefined;
      throw error;
    }
  }
  private consume(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.timer === undefined) {
        this.started = Date.now();
        this.timer = setTimeout(() => {
          this.fail(EngineControlError.at("rpc-partial-frame", this.started, { timeout: true }));
        }, 10_000);
      }
      if (this.body === undefined) {
        const copied = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + copied);
        this.headerBytes += copied;
        offset += copied;
        if (this.headerBytes === 4) {
          this.openBody();
        }
      } else {
        const copied = Math.min(this.body.length - this.bodyBytes, chunk.length - offset);
        chunk.copy(this.body, this.bodyBytes, offset, offset + copied);
        this.bodyBytes += copied;
        offset += copied;
        if (this.bodyBytes === this.body.length) {
          this.complete();
        }
      }
    }
  }
  private openBody(): void {
    const size = this.header.readUInt32BE();
    if (size === 0 || size > this.maximum + 4096) {
      throw EngineControlError.at("rpc-frame-size", this.started, { overflow: true });
    }
    // The announced frame count is refused before its body can be allocated or parsed.
    this.frames += 1;
    if (this.frames > 256) {
      throw EngineControlError.at("rpc-frame-count", this.started, { overflow: true });
    }
    this.body = Buffer.allocUnsafe(size);
  }
  private complete(): void {
    const body = this.body;
    this.body = undefined;
    this.bodyBytes = 0;
    this.headerBytes = 0;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (body === undefined) {
      throw new SeptError("Hands frame body is absent");
    }
    let value: unknown;
    try {
      value = JSON.parse(body.toString("utf8"));
    } catch {
      throw EngineControlError.at("rpc-protocol", this.started);
    }
    const frame = parseHandsFrame(value);
    if (Buffer.byteLength(JSON.stringify(frame.payload)) > this.maximum) {
      throw EngineControlError.at("rpc-payload-size", this.started, { overflow: true });
    }
    this.accept(frame);
  }
  /** Serial caller resets only between complete operations; Docker owns the separate announced-byte budget. */
  public beginOperation(): void {
    if (this.headerBytes !== 0 || this.body !== undefined) {
      throw new SeptError("Hands RPC budget reset inside a frame");
    }
    this.frames = 0;
  }
  /** EOF must be on a boundary; dispose always releases the partial-frame deadline. */
  public finish(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.headerBytes !== 0 || this.body !== undefined) {
      throw EngineControlError.at("rpc-truncated", this.started);
    }
  }
}
