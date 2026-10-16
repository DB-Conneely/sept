/** Owns fetch, cancellation races and bounded response settlement; it never retries durable writes. */
import type { ClientConfiguration } from "./request-codecs.js";
import { TaskClientError } from "./errors.js";

interface Cancellation {
  signal: AbortSignal;
  failure(): TaskClientError | undefined;
  close(): void;
}

function cancellation(timeoutMs: number, signal: AbortSignal | undefined): Cancellation {
  const controller = new AbortController();
  let cause: "aborted" | "timeout" | undefined;
  const cancel = (kind: "aborted" | "timeout"): void => {
    // Record the first owned cause before abort can synchronously notify the fetch/reader.
    if (cause === undefined) {
      cause = kind;
      controller.abort();
    }
  };
  const onAbort = (): void => {
    cancel("aborted");
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    cancel("aborted");
  }
  const timer = setTimeout(() => {
    cancel("timeout");
  }, timeoutMs);
  return {
    signal: controller.signal,
    failure: () => (cause === undefined ? undefined : new TaskClientError(cause)),
    close: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function appendChunk(chunks: Uint8Array[], size: number, value: unknown): number {
  if (!(value instanceof Uint8Array)) {
    throw new TaskClientError("protocol");
  }
  const total = size + value.byteLength;
  // Bound actual streamed bytes, including decompression, before buffering or JSON parsing.
  if (total > 5 * 1024 * 1024) {
    throw new TaskClientError("protocol");
  }
  chunks.push(value);
  return total;
}

async function responseBytes(response: Response): Promise<Buffer> {
  if (response.body === null) {
    throw new TaskClientError("protocol");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let finished = false;
  try {
    while (!finished) {
      const chunk = await reader.read();
      finished = chunk.done;
      if (!finished) {
        size = appendChunk(chunks, size, chunk.value);
      }
    }
    return Buffer.concat(chunks, size);
  } finally {
    try {
      if (!finished) {
        await reader.cancel().catch(() => undefined);
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function parseResponse(bytes: Buffer): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new TaskClientError("protocol");
  }
}

function httpFailure(
  response: Response,
  bytes: Buffer,
  resource: "task" | "conversation",
): TaskClientError {
  let retainedFrom: number | undefined;
  try {
    const value = parseResponse(bytes);
    if (
      resource === "conversation" &&
      response.status === 410 &&
      typeof value === "object" &&
      value !== null &&
      "retainedFrom" in value
    ) {
      const earliest = value.retainedFrom;
      if (typeof earliest === "number" && Number.isSafeInteger(earliest) && earliest > 0) {
        retainedFrom = earliest;
      }
    }
  } catch {
    // A hostile HTTP error body cannot replace the status classification or leak its text.
  }
  return new TaskClientError("http", response.status, retainedFrom);
}

/** Execute one bounded exchange; timers, abort listeners and response readers settle on every path. */
export async function requestJson(
  configuration: ClientConfiguration,
  path: string,
  method: "GET" | "POST",
  body: string | undefined,
  signal: AbortSignal | undefined,
  resource: "task" | "conversation" = "task",
): Promise<{ body: unknown; status: number }> {
  const owned = cancellation(configuration.timeoutMs, signal);
  try {
    const response = await fetch(`${configuration.origin}${path}`, {
      method,
      headers: {
        Authorization: configuration.authorization,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
      signal: owned.signal,
      redirect: "error",
    });
    const bytes = await responseBytes(response);
    if (!response.ok) {
      throw httpFailure(response, bytes, resource);
    }
    return { status: response.status, body: parseResponse(bytes) };
  } catch (error) {
    const failure = owned.failure();
    if (failure !== undefined) {
      throw failure;
    }
    if (error instanceof TaskClientError) {
      throw error;
    }
    throw new TaskClientError("transport");
  } finally {
    owned.close();
  }
}
