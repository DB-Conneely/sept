/** Parent-bound process bytes are checked again before fixed Engine identity/environment composition. */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { SeptError } from "../durable/index.js";
import type { HandsCommandStart, HandsRequest } from "./contracts.js";
import { privateHandsPath } from "./hands-paths.js";

type ScriptCommand = Extract<HandsCommandStart, { command: string }>;
type SearchCommand = Extract<HandsCommandStart, { argv: string[] }>;
type ToolRequest = Extract<HandsRequest, { kind: "tool" }>;

/** A command frame cannot choose a UID, program path, environment, network grant or budget. */
export function assertHandsCommand(
  request: HandsRequest,
  command: HandsCommandStart,
  cwd: string,
): { network: boolean; timeout?: number } {
  if (command.commandId !== 1 || command.cwd !== cwd) {
    throw new SeptError("Hands command parent or cwd was refused");
  }
  if (request.kind === "tool") {
    return assertToolCommand(request, command, cwd);
  }
  if (request.kind === "custom" && command.program === "custom" && request.hand !== undefined) {
    return assertCustomCommand(request, command, request.hand.sha256);
  }
  throw new SeptError("Hands command has no admitted process parent");
}
function assertToolCommand(
  request: ToolRequest,
  command: HandsCommandStart,
  cwd: string,
): { network: boolean; timeout?: number } {
  if (request.name === "bash" && command.program === "bash") {
    return assertBashCommand(request, command);
  }
  if (command.program === "rg" || command.program === "fd") {
    assertSearchCommand(request, command, cwd);
    return { network: false };
  }
  throw new SeptError("Hands command has no admitted process parent");
}
function assertBashCommand(
  request: Extract<HandsRequest, { kind: "tool" }>,
  command: ScriptCommand,
): { network: boolean; timeout?: number } {
  if (command.command !== request.arguments.command || command.input !== "") {
    throw new SeptError("Hands Bash bytes differ from the admitted parent");
  }
  return { network: request.arguments.network === true, ...bashTimeout(request.arguments.timeout) };
}
function assertCustomCommand(
  request: Extract<HandsRequest, { kind: "custom" }>,
  command: ScriptCommand,
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
function assertSearchCommand(request: ToolRequest, command: SearchCommand, cwd: string): void {
  const root = searchRoot(request, cwd);
  let variants: string[][];
  if (request.name === "grep" && command.program === "rg") {
    variants = [grepArgv(request.arguments, root)];
  } else if (request.name === "find" && command.program === "fd") {
    variants = [findArgv(request.arguments, root, false), findArgv(request.arguments, root, true)];
  } else {
    throw new SeptError("Hands helper differs from its admitted native parent");
  }
  if (!variants.some((argv) => sameArgv(argv, command.argv))) {
    throw new SeptError("Hands helper argv differs from its admitted parent");
  }
}
function searchRoot(request: ToolRequest, cwd: string): string {
  const path = request.arguments.path ?? ".";
  if (typeof path !== "string") {
    throw new SeptError("Hands helper root is malformed");
  }
  const root = posix.resolve(cwd, path || ".");
  const grant = request.grants?.find(
    (candidate) => root === candidate.root || root.startsWith(`${candidate.root}/`),
  );
  if (Buffer.byteLength(root) > 4096 || privateHandsPath(root) || grant?.read !== true) {
    throw new SeptError("Hands helper root lacks current read authority");
  }
  return root;
}
function grepArgv(args: Record<string, unknown>, root: string): string[] {
  const argv = ["--json", "--line-number", "--color=never", "--hidden"];
  if (args.ignoreCase === true) {
    argv.push("--ignore-case");
  }
  if (args.literal === true) {
    argv.push("--fixed-strings");
  }
  if (typeof args.glob === "string" && args.glob.length > 0) {
    argv.push("--glob", args.glob);
  }
  return [...argv, "--", searchPattern(args.pattern), root];
}
function findArgv(args: Record<string, unknown>, root: string, outsideGit: boolean): string[] {
  const argv = ["--glob", "--color=never", "--hidden"];
  if (outsideGit) {
    argv.push("--no-require-git");
  }
  const limit = args.limit ?? 1000;
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new SeptError("Hands find limit is malformed");
  }
  argv.push("--max-results", String(limit));
  let pattern = searchPattern(args.pattern);
  if (pattern.includes("/")) {
    argv.push("--full-path");
    if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
      pattern = `**/${pattern}`;
    }
  }
  return [...argv, "--", pattern, root];
}
function searchPattern(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new SeptError("Hands helper pattern is malformed");
  }
  return value;
}
function sameArgv(expected: string[], actual: string[]): boolean {
  return (
    expected.length === actual.length && expected.every((argument, i) => argument === actual[i])
  );
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

/** Minimal execution environment shared by fixed privileged control and untrusted command dispatch. */
export const CLEAN_COMMAND_ENV = [
  "/usr/bin/env",
  "-i",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "HOME=/tmp",
  "TMPDIR=/tmp",
];

/** Fixed parent-owned executable/environment composition; resident helper requests carry argv only. */
export function commandExecutable(command: HandsCommandStart, network: boolean): string[] {
  return [
    ...CLEAN_COMMAND_ENV,
    `SEPT_HANDS_NETWORK=${network ? "1" : "0"}`,
    "/usr/local/libexec/sept/hands-command",
    command.program,
    ...("argv" in command ? command.argv : [command.command]),
  ];
}
