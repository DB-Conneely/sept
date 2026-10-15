/** Resident-only native process seam; raw command output never writes the RPC descriptor. */
import { SeptError } from "../durable/index.js";
import type {
  HandsCommandExecutor,
  HandsCommandExit,
  HandsCommandStream,
  HandsFrame,
} from "./contracts.js";

/** One parent permits one Bash, custom or fixed search process and awaits its verified joined exit. */
export class ResidentHandsCommand {
  private pending:
    | {
        onData: (data: Buffer, stream: HandsCommandStream) => void;
        resolve: (exit: HandsCommandExit) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  private used = false;
  public constructor(
    private readonly parent: Extract<HandsFrame, { kind: "operation" }>,
    private readonly respond: (frame: HandsFrame) => void,
  ) {}
  /** Pi owns formatting, accumulation and spill; only the exact actual process crosses this seam. */
  public readonly execute: HandsCommandExecutor = async (command, onData, signal) => {
    if (this.used || signal?.aborted) {
      throw new SeptError("Hands command parent is unavailable");
    }
    this.used = true;
    const result = new Promise<HandsCommandExit>((resolve, reject) => {
      this.pending = { onData, resolve, reject };
    });
    const abort = (): void => {
      this.respond({ ...this.parent, kind: "cancel", payload: { commandId: 1 } });
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      this.respond({
        ...this.parent,
        kind: "command-start",
        payload: { ...command, commandId: 1 },
      });
      return await result;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.pending = undefined;
    }
  };
  /** Accept only active parent output/exit; no command-controlled bytes are interpreted as a frame. */
  public receive(frame: Extract<HandsFrame, { kind: "command-data" | "command-exit" }>): void {
    const pending = this.pending;
    if (pending === undefined || frame.payload.commandId !== 1) {
      throw new SeptError("Hands command correlation was refused");
    }
    if (frame.kind === "command-data") {
      pending.onData(Buffer.from(frame.payload.text), frame.payload.stream);
    } else {
      pending.resolve(frame.payload);
    }
  }
  /** Lost stdin cannot leave a resident waiting for an exit that its parent can no longer deliver. */
  public close(): void {
    this.pending?.reject(new SeptError("Hands command control was lost"));
  }
}
