/** Stateless non-TTY Docker stream codec; no retained operation or authority exists here. */
import { SeptError } from "../durable/index.js";
import { EngineControlError } from "./contracts.js";
/** Docker's eight-byte stream headers are data framing only, never command/authority messages. */
export class EngineStreamDecoder {
  private header = Buffer.alloc(0);
  private remaining = 0;
  private stream = 0;
  private frames = 0;
  private bytes = 0;
  public constructor(
    private readonly maximum: number,
    private readonly observe?: (chunk: Buffer, stream: number) => void,
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
        if (this.stream === 1 || this.stream === 2) {
          const output = Buffer.from(chunk.subarray(offset, offset + copied));
          this.observe?.(output, this.stream);
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
      throw EngineControlError.at("exec-stream", Date.now(), { overflow: true });
    }
  }
  /** A serial parent refreshes output/frame budgets only between complete Docker frames. */
  public resetBudget(): void {
    if (this.header.length !== 0 || this.remaining !== 0) {
      throw new SeptError("Hands Engine budget reset inside a frame");
    }
    this.frames = 0;
    this.bytes = 0;
  }
  /** Incomplete Docker framing owns the same bounded partial-frame deadline as RPC. */
  public partial(): boolean {
    return this.header.length !== 0 || this.remaining !== 0;
  }
  /** EOF must coincide with a complete frame; a lost reply is never successful settlement. */
  public finish(): void {
    if (this.header.length !== 0 || this.remaining !== 0) {
      throw new SeptError("Hands Engine stream ended inside a frame");
    }
  }
}
