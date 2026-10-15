import { parseHandsRequest } from "./hands-request.js";
export { parseHandsRequest } from "./hands-request.js";
export { parseEngineJson } from "./contracts.js";
import type { IncomingMessage } from "node:http";
/** Validates the bounded hands transport once at each side; hostile results never become authority. */

import { handsRecord, EngineControlError } from "./contracts.js";
export { handsRecord } from "./contracts.js";
export type { HandsFrame, HandsCorrelation } from "./contracts.js";
import { SeptError } from "../durable/index.js";
import type {
  HandsResources,
  HandsToolResult,
  HandsFrame,
  HandsCorrelation,
  HandsCommandStart,
} from "./contracts.js";

/** Transport bounds cover resized image attachments without unbounded buffering. */
export const HANDS_REQUEST_BYTES = 512 * 1024;
/** Pi content and one bounded image travel in a single response. */
export const HANDS_RESPONSE_BYTES = 4 * 1024 * 1024;

function text(value: unknown, maximum = HANDS_REQUEST_BYTES): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > maximum) {
    throw new SeptError("Hands protocol text is invalid or oversized");
  }
  return value;
}

/** Validate real Pi text/image content, discarding renderer-only details from the transport. */
export function parseHandsToolResult(value: unknown): HandsToolResult {
  const input = handsRecord(value);
  if (!Array.isArray(input.content) || input.content.length > 16) {
    throw new SeptError("Hands content is invalid");
  }
  const content = input.content.map((raw: unknown) => {
    const part = handsRecord(raw);
    if (part.type === "text") {
      return { type: "text" as const, text: text(part.text, HANDS_RESPONSE_BYTES) };
    }
    if (
      part.type === "image" &&
      typeof part.mimeType === "string" &&
      /^image\/(png|jpeg|gif|webp|bmp)$/.test(part.mimeType)
    ) {
      return {
        type: "image" as const,
        data: text(part.data, HANDS_RESPONSE_BYTES),
        mimeType: part.mimeType,
      };
    }
    throw new SeptError("Hands content type is unsupported");
  });
  if (input.isError !== undefined && typeof input.isError !== "boolean") {
    throw new SeptError("Hands error flag is invalid");
  }
  return { content, ...(input.isError === undefined ? {} : { isError: input.isError }) };
}

/** Validate resources before they enter native prompt sections. */
export function parseHandsResources(value: unknown): HandsResources {
  const input = handsRecord(value);
  return {
    system: text(input.system),
    append: text(input.append),
    instructions: text(input.instructions),
    skills: text(input.skills),
  };
}

function ordinal(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SeptError("Hands frame ordinal is malformed");
  }
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new SeptError("Hands frame identity is malformed");
  }
  return value;
}
function exact(input: Record<string, unknown>, keys: readonly string[]): void {
  if (
    Object.keys(input).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in input))
  ) {
    throw new SeptError("Hands frame fields are malformed");
  }
}
/** Decode once after bounded framing; unknown kinds, extra fields and foreign identities fail closed. */
export function parseHandsFrame(value: unknown): HandsFrame {
  const input = handsRecord(value);
  exact(input, [
    "version",
    "generation",
    "configuration",
    "session",
    "sequence",
    "kind",
    "payload",
  ]);
  if (input.version !== 1) {
    throw new SeptError("Hands frame version is unsupported");
  }
  const correlation: HandsCorrelation = {
    version: 1,
    generation: text(input.generation, 256),
    configuration: digest(input.configuration),
    session: digest(input.session),
    sequence: ordinal(input.sequence),
  };
  if (input.kind === "operation") {
    if (Buffer.byteLength(JSON.stringify(input.payload)) > HANDS_REQUEST_BYTES) {
      throw new SeptError("Hands request exceeds its bound");
    }
    return { ...correlation, kind: input.kind, payload: parseHandsRequest(input.payload) };
  }
  if (input.kind === "result") {
    return { ...correlation, kind: input.kind, payload: input.payload };
  }
  if (input.kind === "command-start") {
    return { ...correlation, kind: input.kind, payload: parseCommand(input.payload) };
  }
  return parseControlFrame(correlation, input.kind, handsRecord(input.payload));
}
function commandText(value: unknown, maximum = HANDS_REQUEST_BYTES): string {
  const checked = text(value, maximum);
  if (checked.includes("\0")) {
    throw new SeptError("Hands command contains a NUL");
  }
  return checked;
}
function parseCommand(value: unknown): HandsCommandStart {
  const input = handsRecord(value);
  if (input.commandId !== 1 || Buffer.byteLength(JSON.stringify(input)) > HANDS_REQUEST_BYTES) {
    throw new SeptError("Hands command identity or size was refused");
  }
  const cwd = commandText(input.cwd, 4096);
  if (input.program === "rg" || input.program === "fd") {
    exact(input, ["commandId", "program", "argv", "cwd"]);
    if (!Array.isArray(input.argv) || input.argv.length > 120) {
      throw new SeptError("Hands helper argv exceeds its bound");
    }
    return {
      commandId: 1,
      program: input.program,
      argv: input.argv.map((argument: unknown) => commandText(argument)),
      cwd,
    };
  }
  exact(input, ["commandId", "program", "command", "input", "cwd"]);
  if (input.program !== "bash" && input.program !== "custom") {
    throw new SeptError("Hands command program was refused");
  }
  return {
    commandId: 1,
    program: input.program,
    command: commandText(input.command),
    input: commandText(input.input, 1024),
    cwd,
  };
}
function oneOf(...choices: readonly unknown[]): (value: unknown) => unknown {
  return (value) => {
    if (!choices.includes(value)) {
      throw new SeptError("Hands control classification is malformed");
    }
    return value;
  };
}
function nullable(check: (value: unknown) => unknown): (value: unknown) => unknown {
  return (value) => (value === null ? null : check(value));
}
const CONTROL_PAYLOADS = {
  hello: {
    challenge: digest,
    pid: ordinal,
    start: (value: unknown) => {
      if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) {
        throw new SeptError("Hands process lifetime is malformed");
      }
      return value;
    },
    guard: oneOf(2),
    network: oneOf("denied"),
  },
  error: { stage: oneOf("operation", "authority", "protocol", "shutdown") },
  "effect-check": {
    effect: ordinal,
    right: oneOf("operation", "read", "write", "resources"),
    path: (value: unknown) => text(value, 4096),
  },
  ack: { effect: ordinal, allowed: oneOf(true, false) },
  "command-data": {
    commandId: ordinal,
    stream: oneOf("stdout", "stderr"),
    text: (value: unknown) => text(value, HANDS_RESPONSE_BYTES),
  },
  "command-exit": {
    commandId: ordinal,
    code: nullable(ordinal),
    signal: nullable((value) => text(value, 32)),
    termination: oneOf("exit", "timeout", "aborted", "overflow"),
  },
  cancel: { commandId: (value: unknown) => (value === undefined ? undefined : ordinal(value)) },
};
function parseControlFrame(
  c: HandsCorrelation,
  kind: unknown,
  payload: Record<string, unknown>,
): HandsFrame {
  if (typeof kind !== "string" || !Object.hasOwn(CONTROL_PAYLOADS, kind)) {
    throw new SeptError("Hands frame kind is unsupported");
  }
  // CAST: own-key membership above narrows to the closed immutable control schema.
  const selected = kind as keyof typeof CONTROL_PAYLOADS;
  const shape = CONTROL_PAYLOADS[selected];
  if (Object.keys(payload).some((key) => !Object.hasOwn(shape, key))) {
    throw new SeptError("Hands frame payload fields are malformed");
  }
  for (const [key, check] of Object.entries(shape)) {
    check(payload[key]);
  }
  // CAST: correlation is validated and every allowed/required payload field passed its exact kind codec.
  return { ...c, kind: selected, payload } as HandsFrame;
}
/** Length prefix bounds allocation before JSON parsing; envelope overhead is separate from payload capacity. */
export function encodeHandsFrame(frame: HandsFrame): Buffer {
  const payload = JSON.stringify(frame.payload);
  const maximum =
    frame.kind === "result" || frame.kind === "command-data"
      ? HANDS_RESPONSE_BYTES
      : HANDS_REQUEST_BYTES;
  if (Buffer.byteLength(payload) > maximum) {
    throw new SeptError("Hands frame payload exceeds its bound");
  }
  const body = Buffer.from(JSON.stringify(frame));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/** HTTP metadata has a separate finite budget; hostile diagnostics are drained without exposure. */
export async function collectEngineMetadata(
  response: IncomingMessage,
  started = Date.now(),
): Promise<Buffer> {
  const accepted = [200, 201, 204].includes(response.statusCode ?? 0);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    if (!Buffer.isBuffer(chunk)) {
      throw new SeptError("Hands Engine metadata is not a byte stream");
    }
    bytes += chunk.length;
    if (bytes > 256 * 1024) {
      throw EngineControlError.at("http", started, {
        overflow: true,
        status: response.statusCode ?? null,
      });
    }
    if (accepted) {
      chunks.push(chunk);
    }
  }
  if (!accepted) {
    throw EngineControlError.at("http", started, { status: response.statusCode ?? null });
  }
  return Buffer.concat(chunks);
}

export { HandsFrameDecoder } from "./hands-frame-decoder.js";

/** Strict bounded lifetime codec; caller-selected PID groups and permanent command exemptions are absent. */
export function parseProcessIdentity(value: unknown): { pid: number; start: string } {
  const input = handsRecord(value);
  if (
    Object.keys(input).length !== 2 ||
    typeof input.pid !== "number" ||
    !Number.isSafeInteger(input.pid) ||
    input.pid <= 1 ||
    input.pid > 2147483647 ||
    typeof input.start !== "string" ||
    !/^\d{1,20}$/.test(input.start)
  ) {
    throw new SeptError("Hands process lifetime is malformed");
  }
  return { pid: input.pid, start: input.start };
}
