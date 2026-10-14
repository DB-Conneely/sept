/** Stateless closed operation codec; a decoded request carries no authority of its own. */
import type { ModelImageResizeOptions } from "@earendil-works/pi-ai";
import { SeptError } from "../durable/index.js";
import type { CodingToolName, HandsRequest } from "./contracts.js";
import { handsRecord, HANDS_REQUEST_BYTES } from "./protocol.js";
import { parseCustomRequest } from "./custom-hand.js";
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
  closedRequest(input);
  if (input.kind === "resources") {
    return resourceRequest(input);
  }
  if (input.kind === "custom") {
    return parseCustomRequest(input, input.grants === undefined ? undefined : grants(input.grants));
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

function closedRequest(input: Record<string, unknown>): void {
  const fields = {
    resources: ["kind", "workspaceRead", "grants"],
    custom: ["kind", "callId", "taskKey", "arguments", "hand", "grants"],
    tool: ["kind", "name", "callId", "taskKey", "arguments", "resize", "grants"],
    file: ["kind", "method", "path", "callId", "content", "grants"],
  };
  if (
    input.kind !== "resources" &&
    input.kind !== "custom" &&
    input.kind !== "tool" &&
    input.kind !== "file"
  ) {
    throw new SeptError("Hands operation is unsupported");
  }
  const keys = fields[input.kind];
  if (Object.keys(input).some((key) => !keys.includes(key))) {
    throw new SeptError("Hands operation fields are malformed");
  }
}

/** Capture immutable bounded effect bytes before FIFO/authority awaits; caller mutation cannot change admitted intent. */
export function captureHandsRequest(request: HandsRequest): HandsRequest {
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > HANDS_REQUEST_BYTES) {
    throw new SeptError("Hands request exceeds its bound");
  }
  const snapshot: unknown = JSON.parse(input);
  return parseHandsRequest(snapshot);
}

function resourceRequest(input: Record<string, unknown>): HandsRequest {
  return {
    kind: "resources",
    ...(input.workspaceRead === undefined ? {} : { workspaceRead: input.workspaceRead === true }),
    ...(input.grants === undefined ? {} : { grants: grants(input.grants) }),
  };
}
