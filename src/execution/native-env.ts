/** The minimum native ExecutionEnv shares the supplied backend; unsupported methods refuse explicitly. */

import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { posix } from "node:path";
import {
  err,
  ok,
  FileError,
  ExecutionError,
  type ExecutionEnv,
  type Result,
} from "@earendil-works/pi-durable/env";
import { HandsBackendUnavailableError } from "./contracts.js";
import type { ExecutionBackend } from "./contracts.js";
import { handsRecord } from "./protocol.js";

function unsupportedFile(..._arguments: unknown[]): Promise<Result<never, FileError>> {
  return Promise.resolve(
    err(
      new FileError(
        "not_supported",
        "This hands profile does not support this native filesystem operation",
      ),
    ),
  );
}

/** Native extensions use this port and receive no ambient Node filesystem or shell authority. */
export class BackendExecutionEnv implements ExecutionEnv {
  public readonly id: string;
  public readonly cwd: string;
  private effectOrdinal = 0;
  public constructor(
    private readonly backend: ExecutionBackend,
    private readonly onFailure: (error: unknown) => void = () => undefined,
    private readonly nativeIdentity?: string,
  ) {
    this.id = `${backend.id}:${backend.generation}`;
    this.cwd = backend.cwd;
  }

  /** Path arithmetic uses only the hands namespace and grants no filesystem access. */
  public absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    return Promise.resolve(ok(posix.resolve(this.cwd, path)));
  }

  /** Joining paths is pure namespace arithmetic, never host realpath discovery. */
  public joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
    return Promise.resolve(ok(posix.join(...parts)));
  }

  /** Read text through the same effect owner used by Pi's read tool. */
  public async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    try {
      const result = handsRecord(
        await this.backend.invoke(
          { kind: "file", method: "readTextFile", path, ...this.identity("readTextFile", [path]) },
          context,
        ),
      );
      if (result.ok === true && typeof result.value === "string") {
        return ok(result.value);
      }
      return err(new FileError("permission_denied", "Hands read was refused"));
    } catch (error: unknown) {
      this.report(error, context);
      return err(
        new FileError(
          "unknown",
          "Hands read failed",
          path,
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  /** Write text through the supplied backend; binary/handle methods remain unsupported. */
  public async writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    if (typeof content !== "string") {
      return unsupportedFile();
    }
    try {
      const result = handsRecord(
        await this.backend.invoke(
          {
            kind: "file",
            method: "writeFile",
            path,
            content,
            ...this.identity("writeFile", [path, content]),
          },
          context,
        ),
      );
      return result.ok === true
        ? ok(undefined)
        : err(new FileError("permission_denied", "Hands write was refused"));
    } catch (error: unknown) {
      this.report(error, context);
      return err(
        new FileError(
          "unknown",
          "Hands write failed",
          path,
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  private identity(method: string, arguments_: string[]): { callId?: string } {
    if (this.nativeIdentity === undefined) {
      return {};
    }
    const digest = createHash("sha256").update(JSON.stringify(arguments_)).digest("hex");
    return {
      callId: createHash("sha256")
        .update(JSON.stringify([this.nativeIdentity, method, this.effectOrdinal++, digest]))
        .digest("hex"),
    };
  }

  private report(error: unknown, context: Context): void {
    if (error instanceof HandsBackendUnavailableError && !context.abortSignal?.aborted) {
      this.onFailure(error);
    }
  }

  /** Native shell execution is unsupported; explicitly granted Pi Bash uses its existing complete body. */
  public exec(..._arguments: unknown[]): Promise<Result<never, ExecutionError>> {
    return Promise.resolve(
      err(
        new ExecutionError(
          "shell_unavailable",
          "Native shell operation is unsupported by this hands profile",
        ),
      ),
    );
  }

  public readonly openTextLineReader = unsupportedFile;
  public readonly readTextLines = unsupportedFile;
  public readonly readBinaryFile = unsupportedFile;
  public readonly openBinaryReader = unsupportedFile;
  public readonly appendFile = unsupportedFile;
  public readonly truncateFile = unsupportedFile;
  public readonly flushFile = unsupportedFile;
  public readonly renameFile = unsupportedFile;
  public readonly fileInfo = unsupportedFile;
  public readonly listDir = unsupportedFile;
  public readonly openDirReader = unsupportedFile;
  public readonly watch = unsupportedFile;
  public readonly canonicalPath = unsupportedFile;
  public readonly exists = unsupportedFile;
  public readonly createDir = unsupportedFile;
  public readonly remove = unsupportedFile;
  public readonly createTempDir = unsupportedFile;
  public readonly createTempFile = unsupportedFile;

  /** Join the owned backend handles; unsupported methods never acquired local resources. */
  public cleanup(_context: Context): Promise<void> {
    return this.backend.close();
  }
}
