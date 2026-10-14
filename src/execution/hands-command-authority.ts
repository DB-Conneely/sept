/** Parent-bound process bytes are checked again before fixed Engine identity/environment composition. */
import { createHash } from "node:crypto";
import { SeptError } from "../durable/index.js";
import type { HandsCommandStart, HandsRequest } from "./contracts.js";

/** A command frame cannot choose a UID, program path, environment, network grant or budget. */
export function assertHandsCommand(
  request: HandsRequest,
  command: HandsCommandStart,
  cwd: string,
): { network: boolean; timeout?: number } {
  if (command.commandId !== 1 || command.cwd !== cwd) {
    throw new SeptError("Hands command parent or cwd was refused");
  }
  if (request.kind === "tool" && request.name === "bash" && command.program === "bash") {
    return assertBashCommand(request, command);
  }
  if (request.kind === "custom" && command.program === "custom" && request.hand !== undefined) {
    return assertCustomCommand(request, command, request.hand.sha256);
  }
  throw new SeptError("Hands command has no admitted process parent");
}
function assertBashCommand(
  request: Extract<HandsRequest, { kind: "tool" }>,
  command: HandsCommandStart,
): { network: boolean; timeout?: number } {
  if (command.command !== request.arguments.command || command.input !== "") {
    throw new SeptError("Hands Bash bytes differ from the admitted parent");
  }
  return { network: request.arguments.network === true, ...bashTimeout(request.arguments.timeout) };
}
function assertCustomCommand(
  request: Extract<HandsRequest, { kind: "custom" }>,
  command: HandsCommandStart,
  pin: string,
): { network: boolean; timeout: number } {
  if (
    Buffer.byteLength(command.command) > 65536 ||
    command.input !== request.arguments.text ||
    createHash("sha256").update(command.command).digest("hex") !== pin
  ) {
    throw new SeptError("Hands custom bytes differ from the admitted pin/input");
  }
  return { network: request.arguments.network === true, timeout: 5000 };
}
function bashTimeout(value: unknown): { timeout?: number } {
  if (value === undefined) {
    return {};
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value * 1000 > 2147483647
  ) {
    throw new SeptError("Hands Bash timeout is unsupported");
  }
  return { timeout: value * 1000 };
}
