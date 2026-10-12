/**
 * Owns bounded HTTP parsing and response serialization for ingress. These helpers never apply
 * business policy: they convert hostile wire data into bounded primitives or safe responses.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { SeptError } from "../durable/index.js";
import { RequestError } from "./errors.js";

const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
  "CONNECT",
  "TRACE",
] as const;

/** Parse a model selection body with no extension or credential fields. */
export function selectionBody(value: unknown): { provider: string; model: string } {
  if (!isRecord(value)) {
    throw new SeptError("selection request must be an object");
  }
  const provider = value.provider;
  const model = value.model;
  const keys = Object.keys(value).sort();
  if (
    keys.join() !== "model,provider" ||
    typeof provider !== "string" ||
    typeof model !== "string"
  ) {
    throw new SeptError("selection request requires only provider and model identifiers");
  }
  return { provider, model };
}

/** Reject query extensions outside the exact endpoint contract. */
export function noQueryExcept(url: URL, allowed: readonly string[]): void {
  if ([...url.searchParams.keys()].some((key) => !allowed.includes(key))) {
    throw new RequestError(400, "request query has unexpected fields");
  }
}

/** Read one bounded non-negative integer query parameter. */
export function queryInteger(
  parameters: URLSearchParams,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const values = parameters.getAll(name);
  if (values.length === 0) {
    return fallback;
  }
  const value = values[0];
  const syntaxValid = values.length === 1 && value !== undefined && /^\d+$/.test(value);
  if (!syntaxValid) {
    throw new RequestError(
      400,
      `${name} must be one integer between ${String(minimum)} and ${String(maximum)}`,
    );
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new RequestError(
      400,
      `${name} must be one integer between ${String(minimum)} and ${String(maximum)}`,
    );
  }
  return result;
}

/** Consume an endpoint that forbids a body, including chunked non-empty requests. */
export async function emptyBody(request: IncomingMessage): Promise<void> {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined && declaredLength !== "0") {
    throw new RequestError(400, "request body must be empty");
  }
  for await (const chunk of request) {
    const input: unknown = chunk;
    if (wireChunk(input).length > 0) {
      throw new RequestError(400, "request body must be empty");
    }
  }
}

/** Buffer and parse a JSON body only within the endpoint-specific byte limit. */
export async function jsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new RequestError(415, "content-type must be application/json");
  }
  rejectOversizedDeclaration(request, maxBytes);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const input: unknown = chunk;
    const buffer = wireChunk(input);
    size += buffer.length;
    if (size > maxBytes) {
      throw bodyTooLarge(maxBytes);
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function rejectOversizedDeclaration(request: IncomingMessage, maxBytes: number): void {
  const declaredLength = request.headers["content-length"];
  if (declaredLength === undefined) {
    return;
  }
  if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes) {
    throw bodyTooLarge(maxBytes);
  }
}

function bodyTooLarge(maxBytes: number): RequestError {
  return new RequestError(413, `request body exceeds ${String(Math.floor(maxBytes / 1024))} KiB`);
}

/** Write one no-store JSON response with an exact byte length. */
export function jsonResponse(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(payload);
}

/** Write one no-store plain-text response with an exact byte length. */
export function textResponse(response: ServerResponse, status: number, value: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(value),
    "Cache-Control": "no-store",
  });
  response.end(value);
}

/** Extract a pathname for telemetry without allowing malformed URLs to escape routing. */
export function safePathname(value: string | undefined): string {
  try {
    return new URL(value ?? "/", "http://worker.local").pathname;
  } catch {
    return "/invalid";
  }
}

/** Collapse hostile or extension methods into a bounded telemetry label. */
export function normalizeHttpMethod(value: string | undefined): string {
  const method = value?.toUpperCase();
  if (method === undefined) {
    return "OTHER";
  }
  return HTTP_METHODS.some((candidate) => candidate === method) ? method : "OTHER";
}

/** Map concrete paths to bounded route labels without leaking run identifiers. */
export function routeTemplate(method: string, pathname: string): string {
  if (method === "GET" && pathname === "/health") {
    return "/health";
  }
  if (method === "POST" && ["/v1/tasks", "/v1/drain", "/v1/webhooks"].includes(pathname)) {
    return pathname;
  }
  if (isModelRoute(method, pathname)) {
    return pathname;
  }
  const match =
    /^\/v1\/tasks\/[A-Za-z0-9_-]+(?:\/(events|log|messages|conversation|stream|cancel))?$/.exec(
      pathname,
    );
  if (match === null) {
    return "unmatched";
  }
  return `/v1/tasks/{runId}${match[1] === undefined ? "" : `/${match[1]}`}`;
}

function isModelRoute(method: string, pathname: string): boolean {
  if (method === "GET") {
    return [
      "/v1/model-access/providers",
      "/v1/model-access/models",
      "/v1/model-access/selection",
    ].includes(pathname);
  }
  return method === "PUT" && pathname === "/v1/model-access/selection";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wireChunk(value: unknown): Uint8Array {
  if (typeof value === "string" || value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new RequestError(400, "request body contains an unsupported chunk");
}
