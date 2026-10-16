/** Validates client-owned transport authority and bounded request framing without duplicating admission. */
import type { ConversationOptions, TaskClientOptions } from "./contracts.js";
import { TaskClientError } from "./errors.js";

/** Validated immutable HTTP authority used only by the client transport. */
export interface ClientConfiguration {
  origin: string;
  authorization: string;
  timeoutMs: number;
}

function workerOrigin(baseUrl: unknown): string {
  const valid =
    typeof baseUrl === "string" &&
    baseUrl.length <= 8192 &&
    /^https?:\/\/[^/?#\s]+\/?$/i.test(baseUrl);
  if (!valid) {
    throw new TaskClientError("configuration");
  }
  const url = new URL(baseUrl);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new TaskClientError("configuration");
  }
  return url.origin;
}

/** Reject unsafe origin/header inputs before Node fetch can observe credentials. */
export function clientConfiguration(options: TaskClientOptions): ClientConfiguration {
  try {
    const { baseUrl, token, timeoutMs = 30_000 } = options;
    if (typeof token !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(token)) {
      throw new TaskClientError("configuration");
    }
    return {
      origin: workerOrigin(baseUrl),
      authorization: `Bearer ${token}`,
      timeoutMs: requestInteger(timeoutMs, 1, 2_147_483_647),
    };
  } catch {
    // URL and header parser diagnostics can contain hostile input; never expose their causes.
    throw new TaskClientError("configuration");
  }
}

/** Enforce timer/cursor/page numeric bounds without coercion. */
export function requestInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TaskClientError("configuration");
  }
  return value;
}

/** Path segments are closed identifiers, never caller-controlled URL syntax. */
export function runIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TaskClientError("configuration");
  }
  return value;
}

/** Validate caller cancellation before registering ownership or starting a request. */
export function requestSignal(options: unknown): AbortSignal | undefined {
  if (options === undefined) {
    return undefined;
  }
  if (typeof options !== "object" || options === null) {
    throw new TaskClientError("configuration");
  }
  const signal = "signal" in options ? options.signal : undefined;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TaskClientError("configuration");
  }
  return signal;
}

function pageOption(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) {
    return fallback;
  }
  return requestInteger(value, minimum, maximum);
}

/** Validate a bounded page before it becomes a URL query. */
export function conversationQuery(options: ConversationOptions | undefined): {
  after: number;
  limit: number;
} {
  requestSignal(options);
  return {
    after: pageOption(options?.after, 0, 0, Number.MAX_SAFE_INTEGER),
    limit: pageOption(options?.limit, 100, 1, 250),
  };
}

/** Preserve caller identities and count encoded UTF-8 bytes before transmitting any body. */
export function encodeEnvelope(
  input: { source: string; eventId: string },
  envelope: object,
): string {
  try {
    const validSource =
      typeof input.source === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.source);
    const eventId = input.eventId;
    const validEventId =
      typeof eventId === "string" &&
      eventId.length > 0 &&
      eventId.length <= 256 &&
      eventId === eventId.trim() &&
      !/[\u0000-\u001f\u007f]/.test(eventId);
    if (!validSource || !validEventId) {
      throw new TaskClientError("configuration");
    }
    const body = JSON.stringify(envelope);
    if (Buffer.byteLength(body) > 256 * 1024) {
      throw new TaskClientError("configuration");
    }
    return body;
  } catch {
    throw new TaskClientError("configuration");
  }
}
