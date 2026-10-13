/** Validates the bounded hands transport once at each side; hostile results never become authority. */

import type { ModelImageResizeOptions } from "@earendil-works/pi-ai";
import { SeptError } from "../durable/index.js";
import type { CodingToolName, HandsRequest, HandsResources, HandsToolResult } from "./contracts.js";

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

/** Decode only the operations installed tools and the minimum native environment require. */
export function parseHandsRequest(value: unknown): HandsRequest {
  const input = handsRecord(value);
  if (input.kind === "resources") {
    return { kind: "resources" };
  }
  if (input.kind === "tool") {
    return {
      kind: "tool",
      name: toolName(input.name),
      callId: text(input.callId, 256),
      arguments: handsRecord(input.arguments),
      ...(input.resize === undefined ? {} : { resize: resize(input.resize) }),
    };
  }
  if (input.kind === "file" && (input.method === "readTextFile" || input.method === "writeFile")) {
    return {
      kind: "file",
      method: input.method,
      path: text(input.path, 4096),
      ...(input.content === undefined ? {} : { content: text(input.content) }),
    };
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
