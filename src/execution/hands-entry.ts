/** Credential-free resident hands entry. It invokes existing Pi bodies, never an agent loop. */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { validateToolArguments, type Tool, type TSchema, type Static } from "@earendil-works/pi-ai";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
} from "@earendil-works/pi-coding-agent";
import { copyJson } from "@earendil-works/chord";
import { SeptError } from "../durable/index.js";
import type {
  HandsRequest,
  HandsToolResult,
  HandsEffectCheck,
  HandsCommandExecutor,
} from "./contracts.js";
import { executeCustomHand } from "./custom-hand.js";
import { HandsFiles, handsReadOptions, executeHandsFile } from "./hands-files.js";
import {
  createHandsBodies,
  requireHandsFiles,
  validateHandsFind,
  type HandsBodies,
} from "./hands-discovery.js";
import { prepareHandsResourceEpoch, closeHandsResourceEpoch } from "./hands-resources.js";
import { runHandsResident } from "./hands-resident.js";

interface CodingBody<T extends TSchema> extends Tool<T> {
  prepareArguments?: (args: unknown) => Static<T>;
  execute(id: string, args: Static<T>, signal?: AbortSignal): Promise<HandsToolResult>;
}

async function callBody<T extends TSchema>(
  selected: CodingBody<T>,
  request: Extract<HandsRequest, { kind: "tool" }>,
  signal?: AbortSignal,
  preflight?: () => Promise<void>,
): Promise<HandsToolResult> {
  const prepared = copyJson(
    selected.prepareArguments?.(structuredClone(request.arguments)) ?? request.arguments,
  );
  if (typeof prepared !== "object" || prepared === null || Array.isArray(prepared)) {
    throw new SeptError("Hands arguments must be a JSON object");
  }
  const checked: unknown = validateToolArguments(selected, {
    type: "toolCall",
    id: request.callId,
    name: request.name,
    arguments: prepared,
  });
  // CAST: Pi validated against this exact body's schema; SDK declarations return an untyped value.
  const arguments_ = checked as Static<T>;
  try {
    await preflight?.();
    return await selected.execute(request.callId, arguments_, signal);
  } catch (error: unknown) {
    // Ordinary Pi tool failures are results, not a lost backend/channel; content stays hands-owned.
    const message = error instanceof Error ? error.message.slice(0, 2048) : "Hands tool failed";
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

async function tool(
  request: Extract<HandsRequest, { kind: "tool" }>,
  cwd: string,
  files: HandsFiles,
  signal: AbortSignal | undefined,
  bodies: HandsBodies,
  command: HandsCommandExecutor | undefined,
): Promise<HandsToolResult> {
  switch (request.name) {
    case "read":
    case "write":
    case "edit":
      return fileTool(request, cwd, files, signal);
    case "bash":
      return bashTool(request, cwd, signal, command);
    case "grep":
      return callBody(bodies.grep, request, signal);
    case "find":
      return callBody(bodies.find, request, signal, () => validateHandsFind(request, cwd, files));
    case "ls":
      return callBody(bodies.ls, request, signal);
  }
}
async function bashTool(
  request: Extract<HandsRequest, { kind: "tool" }>,
  cwd: string,
  signal: AbortSignal | undefined,
  command: HandsCommandExecutor | undefined,
): Promise<HandsToolResult> {
  if (command === undefined) {
    throw new SeptError("Hands command owner is unavailable");
  }
  const body = createBashTool(cwd, {
    exposeSessionEnvironment: false,
    operations: {
      exec: async (bytes, directory, options) => {
        const exit = await command(
          { program: "bash", command: bytes, input: "", cwd: directory },
          (chunk) => {
            options.onData(chunk);
          },
          options.signal,
        );
        if (exit.termination !== "exit") {
          // The installed native body owns these exact timeout/abort formatting conventions.
          throw new SeptError(commandTermination(exit.termination, options.timeout));
        }
        return { exitCode: exit.code };
      },
    },
  });
  return callBody(body, request, signal);
}
function commandTermination(
  termination: "timeout" | "aborted" | "overflow",
  timeout: number | undefined,
): string {
  if (termination === "timeout") {
    return `timeout:${String(timeout)}`;
  }
  return termination === "aborted" ? "aborted" : "Hands command output exceeded its bound";
}

async function fileTool(
  request: Extract<HandsRequest, { kind: "tool" }>,
  cwd: string,
  files: HandsFiles,
  signal: AbortSignal | undefined,
): Promise<HandsToolResult> {
  switch (request.name) {
    case "read":
      return callBody(createReadTool(cwd, handsReadOptions(request, files)), request, signal);
    case "write":
      return callBody(createWriteTool(cwd, files.writeOptions()), request, signal);
    case "edit":
      return callBody(createEditTool(cwd, files.editOptions()), request, signal);
    default:
      throw new SeptError("Hands file body is unsupported");
  }
}
/** Dispatch the bounded operation in the already-enforced Linux namespace. */
export async function executeHandsRequest(
  request: HandsRequest,
  cwd: string,
  authorize: HandsEffectCheck,
  signal?: AbortSignal,
  retained?: HandsBodies,
  command?: HandsCommandExecutor,
): Promise<unknown> {
  if (request.grants === undefined) {
    throw new SeptError("Hands operation has no parent-bound file grants");
  }
  const bodies = retained ?? createHandsBodies(cwd);
  const files = new HandsFiles(
    request.grants,
    authorize,
    bodies.epoch === undefined
      ? []
      : [{ alias: bodies.epoch.alias, descriptor: bodies.epoch.descriptor }],
  );
  bodies.files = files;
  bodies.command = command;
  try {
    return await dispatchBody(request, cwd, authorize, signal, bodies, command);
  } finally {
    bodies.files = undefined;
    bodies.command = undefined;
    files.close();
    if (retained === undefined) {
      closeHandsResourceEpoch(bodies.epoch);
    }
  }
}

async function dispatchBody(
  request: HandsRequest,
  cwd: string,
  authorize: HandsEffectCheck,
  signal: AbortSignal | undefined,
  bodies: HandsBodies,
  command: HandsCommandExecutor | undefined,
): Promise<unknown> {
  const files = requireHandsFiles(bodies);
  if (request.kind === "resources") {
    // The serial refresh boundary retires the old private view before allocating its bounded successor.
    closeHandsResourceEpoch(bodies.epoch);
    bodies.epoch = undefined;
    const epoch = await prepareHandsResourceEpoch(
      cwd,
      files,
      authorize,
      request.workspaceRead === true,
    );
    bodies.epoch = epoch;
    return epoch.resources;
  }
  if (request.kind === "custom") {
    return executeCustomHand(request, files, cwd, command, signal);
  }
  if (request.kind === "tool") {
    return tool(request, cwd, files, signal, bodies, command);
  }
  return executeHandsFile(request, cwd, files);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await runHandsResident().catch(() => {
    process.stderr.write("Hands operation refused\n");
    process.exitCode = 1;
  });
}
