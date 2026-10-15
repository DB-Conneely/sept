/** Adapts the existing joined command seam to the small child contract consumed by native Pi search. */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { SeptError } from "../durable/index.js";
import type { HandsCommandExecutor, HandsCommandExit, HandsCommandStream } from "./contracts.js";

/** The sole native option accepted by the pinned image bodies; no environment or executable authority. */
export interface HandsNativeSpawnOptions {
  stdio: ["ignore", "pipe", "pipe"];
}
/** Structural optional Pi extension; stock host tool options remain assignable without patched declarations. */
export interface HandsNativeSpawnOption {
  spawn?: (path: string, argv: string[], options: HandsNativeSpawnOptions) => HandsNativeChild;
}

/** Streams and events only: execution, cancellation and exact descendant join stay with the existing owner. */
export class HandsNativeChild extends EventEmitter {
  public readonly stdout = new PassThrough({ highWaterMark: 65536 });
  public readonly stderr = new PassThrough({ highWaterMark: 65536 });
  public killed = false;
  private readonly stop = new AbortController();
  private closed = false;
  private bytes = 0;
  public constructor(
    command: HandsCommandExecutor,
    program: "rg" | "fd",
    argv: string[],
    cwd: string,
  ) {
    super();
    // Native bodies attach their readers/listeners synchronously after spawn returns.
    queueMicrotask(() => {
      void this.run(command, program, argv, cwd);
    });
  }
  /** Native limit/abort requests use the already registered parent cancellation; no PID is exposed. */
  public kill(): boolean {
    if (this.closed || this.killed) {
      return false;
    }
    this.killed = true;
    this.stop.abort();
    return true;
  }
  private async run(
    command: HandsCommandExecutor,
    program: "rg" | "fd",
    argv: string[],
    cwd: string,
  ): Promise<void> {
    let exit: HandsCommandExit | undefined;
    let failure: Error | undefined;
    try {
      exit = await command(
        { program, argv, cwd },
        (chunk, stream) => {
          this.output(chunk, stream);
        },
        this.stop.signal,
      );
      this.assertExit(exit);
    } catch (error: unknown) {
      failure =
        error instanceof Error
          ? error
          : new SeptError("Hands native helper failed", { cause: error });
    } finally {
      this.closed = true;
      await this.drain();
    }
    if (failure !== undefined) {
      this.emit("error", failure);
    }
    this.emit("close", exit?.code ?? null, exit?.signal ?? null);
  }
  private assertExit(exit: HandsCommandExit): void {
    if (exit.termination === "exit" || (exit.termination === "aborted" && this.killed)) {
      return;
    }
    throw new SeptError("Hands native helper did not complete normally");
  }
  private output(chunk: Buffer, stream: HandsCommandStream): void {
    this.bytes += chunk.length;
    // The owner also bounds transport bytes; this independently bounds readable buffering before Pi parsing.
    if (this.bytes > 4 * 1024 * 1024) {
      this.stop.abort();
      throw new SeptError("Hands native helper output exceeded its bound");
    }
    this[stream].write(chunk);
  }
  private async drain(): Promise<void> {
    this.stdout.end();
    this.stderr.end();
    // A native limit can close readline before the final chunk; drain both streams before close.
    this.stdout.resume();
    this.stderr.resume();
    await Promise.all([
      finished(this.stdout, { cleanup: true }),
      finished(this.stderr, { cleanup: true }),
    ]);
  }
}

/** Refuse unknown image paths/options before asking the existing owner to start a fixed helper. */
export function spawnHandsNativeChild(
  command: HandsCommandExecutor | undefined,
  cwd: string,
  path: string,
  argv: string[],
  options: HandsNativeSpawnOptions,
): HandsNativeChild {
  const program = nativeProgram(path);
  if (command === undefined || Object.keys(options).length !== 1 || !fixedStdio(options.stdio)) {
    throw new SeptError("Hands native helper binding or options were refused");
  }
  return new HandsNativeChild(command, program, argv, cwd);
}
function nativeProgram(path: string): "rg" | "fd" {
  for (const program of ["rg", "fd"] as const) {
    if (
      path === `/usr/local/libexec/sept/${program}` ||
      path === `/home/sept-hands/.pi/agent/bin/${program}`
    ) {
      return program;
    }
  }
  throw new SeptError("Hands native helper executable was refused");
}
function fixedStdio(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value[0] === "ignore" &&
    value[1] === "pipe" &&
    value[2] === "pipe"
  );
}
