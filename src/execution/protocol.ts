import { request, type Agent, type ClientRequest, type IncomingMessage } from "node:http";
/** Validates the bounded hands transport once at each side; hostile results never become authority. */

import type { ModelImageResizeOptions } from "@earendil-works/pi-ai";
import { EngineControlError } from "./contracts.js";
import { SeptError } from "../durable/index.js";
import type {
  CodingToolName,
  HandsRequest,
  HandsResources,
  HandsToolResult,
  CustomHand,
} from "./contracts.js";

/** Transport bounds cover resized image attachments without unbounded buffering. */
export const HANDS_REQUEST_BYTES = 512 * 1024;
/** Pi content and one bounded image travel in a single response. */
export const HANDS_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Narrow an external JSON object without accepting arrays or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow an external JSON object without accepting arrays or null. */
export function handsRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SeptError("Hands protocol requires an object");
  }
  return value;
}

function text(value: unknown, maximum = HANDS_REQUEST_BYTES): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > maximum) {
    throw new SeptError("Hands protocol text is invalid or oversized");
  }
  return value;
}

function toolName(value: unknown): CodingToolName {
  switch (value) {
    case "read":
    case "write":
    case "edit":
    case "bash":
    case "grep":
    case "find":
    case "ls":
      return value;
    default:
      throw new SeptError("Hands tool is unsupported");
  }
}

function resize(value: unknown): ModelImageResizeOptions {
  const input = handsRecord(value);
  const result: ModelImageResizeOptions = {};
  for (const key of ["maxWidth", "maxHeight", "maxBytes", "jpegQuality"] as const) {
    const setting = input[key];
    if (setting === undefined) {
      continue;
    }
    if (typeof setting !== "number" || !Number.isFinite(setting) || setting <= 0) {
      throw new SeptError("Hands image resize setting is invalid");
    }
    result[key] = setting;
  }
  return result;
}

function grants(value: unknown) {
  if (!Array.isArray(value) || value.length > 11) {
    throw new SeptError("Hands grants exceed their bound");
  }
  return value.map((raw: unknown) => {
    const entry = handsRecord(raw);
    if (
      typeof entry.root !== "string" ||
      !/^\/(workspace|resources|tmp|selected\/[A-Za-z0-9_-]+)$/.test(entry.root) ||
      typeof entry.read !== "boolean" ||
      typeof entry.write !== "boolean"
    ) {
      throw new SeptError("Hands grant is malformed");
    }
    return { root: entry.root, read: entry.read, write: entry.write };
  });
}

function fileRequest(input: Record<string, unknown>): HandsRequest {
  if (input.method !== "readTextFile" && input.method !== "writeFile") {
    throw new SeptError("Hands file operation is unsupported");
  }
  return {
    kind: "file",
    method: input.method,
    ...(input.callId === undefined ? {} : { callId: text(input.callId, 256) }),
    path: text(input.path, 4096),
    ...(input.content === undefined ? {} : { content: text(input.content) }),
    ...(input.grants === undefined ? {} : { grants: grants(input.grants) }),
  };
}

/** Decode only the operations installed tools and the minimum native environment require. */
export function parseHandsRequest(value: unknown): HandsRequest {
  const input = handsRecord(value);
  if (input.kind === "resources") {
    return {
      kind: "resources",
      ...(input.workspaceRead === undefined ? {} : { workspaceRead: input.workspaceRead === true }),
    };
  }
  if (input.kind === "custom") {
    return customRequest(input);
  }
  if (input.kind === "tool") {
    return {
      kind: "tool",
      name: toolName(input.name),
      callId: text(input.callId, 256),
      ...(input.taskKey === undefined ? {} : { taskKey: text(input.taskKey, 64) }),
      arguments: handsRecord(input.arguments),
      ...(input.resize === undefined ? {} : { resize: resize(input.resize) }),
      ...(input.grants === undefined ? {} : { grants: grants(input.grants) }),
    };
  }
  if (input.kind === "file") {
    return fileRequest(input);
  }
  throw new SeptError("Hands operation is unsupported");
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

function customRegistration(value: unknown): CustomHand {
  const input = handsRecord(value);
  if (
    typeof input.path !== "string" ||
    !/^\/selected\/[A-Za-z0-9_-]+\/[^\x00-\x1f]+$/.test(input.path) ||
    typeof input.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    (input.replay !== "safe" && input.replay !== "unsafe")
  ) {
    throw new SeptError("Custom hand registration is malformed");
  }
  return { path: input.path, sha256: input.sha256, replay: input.replay };
}

function customRequest(input: Record<string, unknown>): HandsRequest {
  const args = handsRecord(input.arguments);
  if (
    Object.keys(args).some((key) => key !== "text" && key !== "network") ||
    (args.network !== undefined && typeof args.network !== "boolean")
  ) {
    throw new SeptError("Custom hand arguments are malformed");
  }
  return {
    kind: "custom",
    callId: text(input.callId, 256),
    ...(input.taskKey === undefined ? {} : { taskKey: text(input.taskKey, 64) }),
    arguments: {
      text: text(args.text, 1024),
      ...(args.network === undefined ? {} : { network: args.network }),
    },
    ...(input.hand === undefined ? {} : { hand: customRegistration(input.hand) }),
    ...(input.grants === undefined ? {} : { grants: grants(input.grants) }),
  };
}

/** Parse one bounded Engine JSON response; hostile text never enters the error envelope. */
export function parseEngineJson(output: Buffer): unknown {
  try {
    const value: unknown = output.length === 0 ? null : JSON.parse(output.toString("utf8"));
    return value;
  } catch {
    throw new SeptError("Hands Engine response is malformed");
  }
}

/** Bound HTTP metadata before decoding; only safe status facts reach the control owner. */
export function collectResponse(
  response: IncomingMessage,
  fail: (timeout?: boolean, overflow?: boolean, status?: number | null) => void,
  complete: (output: Buffer) => void,
): void {
  if (![200, 201, 204].includes(response.statusCode ?? 0)) {
    fail(false, false, response.statusCode ?? null);
    return;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  response.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 256 * 1024) {
      fail(false, true);
    } else {
      chunks.push(chunk);
    }
  });
  response.once("error", () => {
    fail();
  });
  response.once("end", () => {
    complete(Buffer.concat(chunks));
  });
}

/** Fixed bounded Node HTTP exchange; the caller supplies authenticated Unix authority and cancellation. */
export function controlRequest(
  socketPath: string,
  path: string,
  method: "GET" | "POST",
  input: string,
  kind: "http" | "exec",
  agent?: Agent,
  signal?: AbortSignal,
): ClientRequest {
  const headers: Record<string, string | number> = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(input),
  };
  if (kind === "exec") {
    headers.Connection = "Upgrade";
    headers.Upgrade = "tcp";
  }
  return request({
    socketPath,
    path,
    method,
    agent: agent ?? false,
    maxHeaderSize: 8192,
    headers,
    signal,
  });
}

/** Join metadata decoding only after the owning request has closed. */
export function settleResponse(
  output: Buffer | undefined,
  failure: EngineControlError | undefined,
  resolve: (value: unknown) => void,
  reject: (error: unknown) => void,
): void {
  if (failure !== undefined || output === undefined) {
    reject(failure ?? new SeptError("Hands Engine response was lost"));
    return;
  }
  try {
    resolve(parseEngineJson(output));
  } catch (error: unknown) {
    reject(error);
  }
}

/** Observe all Agent socket closure before its owner releases control authority. */
export async function joinEngineConnections(agent: Agent): Promise<void> {
  await Promise.all(
    [...Object.values(agent.sockets), ...Object.values(agent.freeSockets)].flat().map((socket) => {
      if (socket === undefined || socket.closed) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => socket.once("close", resolve));
    }),
  );
}
/** Settle only joined upgraded control; peer diagnostics never enter its bounded failure facts. */
export function settleAttachment(
  output: string | undefined,
  failure: Error | undefined,
  resolve: (output: string) => void,
  reject: (error: unknown) => void,
): void {
  if (failure !== undefined || output === undefined) {
    reject(
      failure instanceof EngineControlError
        ? failure.joined({ attachmentClosed: true, connectionsReleased: true })
        : (failure ??
            EngineControlError.at("exec-lost", Date.now(), {
              requestJoined: true,
              attachmentClosed: true,
              connectionsReleased: true,
            })),
    );
  } else {
    resolve(output);
  }
}

/** Metadata and exec-create bodies are bounded before the Node request is made externally active. */
export function engineBody(body: unknown): string {
  const input = body === undefined ? "" : JSON.stringify(body);
  if (Buffer.byteLength(input) > 512 * 1024) {
    throw new SeptError("Hands Engine request exceeds its bound");
  }
  return input;
}
