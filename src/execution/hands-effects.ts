/** Narrow effect validation supplements the existing live policy owner without creating grants or decisions. */
import { posix } from "node:path";
import { SeptError } from "../durable/index.js";
import type { HandsFrame, HandsRequest } from "./contracts.js";

/** A callback can consume only its admitted parent's path/right; resource capture carries no request-selected root. */
export function assertHandsEffect(
  request: HandsRequest,
  cwd: string,
  effect: Extract<HandsFrame, { kind: "effect-check" }>["payload"],
): void {
  if (effect.right === "operation" && effect.path === "") {
    return;
  }
  if (request.kind === "resources") {
    if (effect.right === "resources" && effect.path === "") {
      return;
    }
    throw new SeptError("Hands resource effect exceeds its parent");
  }
  if (request.kind === "custom") {
    assertCustomCapture(request, effect);
    return;
  }
  if (effect.right === "resources" || effect.right === "operation") {
    throw new SeptError("Hands effect exceeds its parent operation");
  }
  const path = posix.resolve(cwd, effect.path);
  assertEffectGrant(request, path, effect.right);
  assertParentEffectPath(request, cwd, path, effect.right);
}
function assertCustomCapture(
  request: Extract<HandsRequest, { kind: "custom" }>,
  effect: Extract<HandsFrame, { kind: "effect-check" }>["payload"],
): void {
  if (effect.right !== "read" || effect.path !== request.hand?.path) {
    throw new SeptError("Hands custom capture differs from its admitted pin");
  }
  assertEffectGrant(request, effect.path, "read");
}

function assertEffectGrant(request: HandsRequest, path: string, right: "read" | "write"): void {
  const selected = request.grants?.find(
    (grant) => path === grant.root || path.startsWith(`${grant.root}/`),
  );
  if (!selected?.[right]) {
    throw new SeptError("Hands effect right was denied");
  }
}

function assertParentEffectPath(
  request: Extract<HandsRequest, { kind: "file" | "tool" }>,
  cwd: string,
  path: string,
  right: "read" | "write",
): void {
  const input = request.kind === "file" ? request.path : (request.arguments.path ?? ".");
  if (typeof input !== "string") {
    throw new SeptError("Hands parent path is malformed");
  }
  const parent = posix.resolve(cwd, input);
  const discovery = request.kind === "tool" && ["grep", "find", "ls"].includes(request.name);
  assertParentEffectRight(request, right);
  if (path !== parent && !(discovery && right === "read" && path.startsWith(`${parent}/`))) {
    throw new SeptError("Hands effect differs from its parent path");
  }
}

function assertParentEffectRight(
  request: Extract<HandsRequest, { kind: "file" | "tool" }>,
  right: "read" | "write",
): void {
  const writing =
    request.kind === "file"
      ? request.method === "writeFile"
      : ["write", "edit"].includes(request.name);
  const reading =
    request.kind === "file" ? request.method === "readTextFile" : request.name !== "write";
  if ((right === "write" && !writing) || (right === "read" && !reading)) {
    throw new SeptError("Hands effect differs from its parent right");
  }
}
