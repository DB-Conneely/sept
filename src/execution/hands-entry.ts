/** Credential-free one-request hands entry. It invokes existing Pi bodies, never an agent loop. */

import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { validateToolArguments, type Tool, type TSchema, type Static } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  SettingsManager,
  formatSkillsForPrompt,
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@earendil-works/pi-coding-agent";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { copyJson } from "@earendil-works/chord";
import { SeptError } from "../durable/index.js";
import type { HandsRequest, HandsResources, HandsToolResult } from "./contracts.js";
import { executeCustomHand } from "./custom-hand.js";
import { HandsFiles } from "./hands-files.js";
import { HANDS_REQUEST_BYTES, HANDS_RESPONSE_BYTES, parseHandsRequest } from "./protocol.js";

async function resources(cwd: string): Promise<HandsResources> {
  const agentDir = "/resources";
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    // Workspace skills are data in hands; they never become brain extension code.
    additionalSkillPaths: [resolve(cwd, ".pi/skills")],
  });
  await loader.reload();
  const loaded = loader.getSkills();
  if (loaded.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
    throw new SeptError("Hands resources could not be loaded");
  }
  return {
    system: loader.getSystemPrompt() ?? "You are SEPT, a durable coding worker.",
    append: loader.getAppendSystemPrompt().join("\n\n"),
    instructions: loader
      .getAgentsFiles()
      .agentsFiles.map((file) => file.content)
      .join("\n\n"),
    skills: formatSkillsForPrompt(loaded.skills, "read"),
  };
}

interface CodingBody<T extends TSchema> extends Tool<T> {
  prepareArguments?: (args: unknown) => Static<T>;
  execute(id: string, args: Static<T>): Promise<HandsToolResult>;
}

async function callBody<T extends TSchema>(
  selected: CodingBody<T>,
  request: Extract<HandsRequest, { kind: "tool" }>,
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
    return await selected.execute(request.callId, arguments_);
  } catch (error: unknown) {
    // Ordinary Pi tool failures are results, not a lost backend/channel; content stays hands-owned.
    const message = error instanceof Error ? error.message.slice(0, 2048) : "Hands tool failed";
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

async function idleProcess(): Promise<{ id: number; start: string }> {
  const children = (await readFile("/proc/1/task/1/children", "utf8")).trim().split(/\s+/);
  if (children.length !== 1 || !/^\d+$/.test(children[0] ?? "")) {
    throw new SeptError("Hands idle process ownership is ambiguous");
  }
  const id = Number(children[0]);
  const command = await readFile(`/proc/${String(id)}/cmdline`, "utf8");
  if (command !== "sleep\0infinity\0") {
    throw new SeptError("Hands idle process differs from the supplied profile");
  }
  const stat = await readFile(`/proc/${String(id)}/stat`, "utf8");
  const start = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
  if (start === undefined || !/^\d+$/.test(start)) {
    throw new SeptError("Hands idle process identity is unavailable");
  }
  return { id, start };
}

function killOwnedProcess(id: number): void {
  try {
    process.kill(id, "SIGKILL");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw new SeptError("Hands descendant join failed", { cause: error });
    }
  }
}

async function joinCommandDescendants(main: { id: number; start: string }): Promise<void> {
  // FIFO permits one entry. Kernel namespace membership survives setsid/daemonization;
  // init reaps killed orphans, so completion proves only trusted idle processes remain.
  for (let round = 0; round < 32; round += 1) {
    const entries = await readdir("/proc");
    const owned = entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number)
      .filter((id) => id !== 1 && id !== main.id && id !== process.pid);
    if (owned.length === 0) {
      const current = await idleProcess();
      if (current.id !== main.id || current.start !== main.start) {
        throw new SeptError("Hands idle identity changed during command execution");
      }
      return;
    }
    for (const id of owned) {
      killOwnedProcess(id);
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 10);
    });
  }
  throw new SeptError("Hands descendant join exceeded its bound");
}

function readOptions(
  request: Extract<HandsRequest, { kind: "tool" }>,
  files: HandsFiles | undefined,
) {
  return {
    ...files?.readOptions(),
    ...(request.resize === undefined ? {} : { resizeOptions: request.resize }),
  };
}
async function nativeFile(
  request: Extract<HandsRequest, { kind: "file" }>,
  cwd: string,
  files: HandsFiles | undefined,
): Promise<unknown> {
  if (files === undefined) {
    const env = new NodeExecutionEnv({ cwd, shellEnv: {} });
    return request.method === "readTextFile"
      ? env.readTextFile(request.path, BACKGROUND_CONTEXT)
      : env.writeFile(request.path, requiredContent(request), BACKGROUND_CONTEXT);
  }
  const path = resolve(cwd, request.path);
  if (request.method === "readTextFile") {
    return { ok: true, value: (await files.read(path)).toString("utf8") };
  }
  await files.write(path, requiredContent(request));
  return { ok: true };
}
function requiredContent(request: Extract<HandsRequest, { kind: "file" }>): string {
  if (request.content === undefined) {
    throw new SeptError("Hands write requires text");
  }
  return request.content;
}

async function tool(
  request: Extract<HandsRequest, { kind: "tool" }>,
  cwd: string,
  files?: HandsFiles,
): Promise<HandsToolResult> {
  switch (request.name) {
    case "read":
      return callBody(createReadTool(cwd, readOptions(request, files)), request);
    case "write":
      return callBody(createWriteTool(cwd, files?.writeOptions()), request);
    case "edit":
      return callBody(createEditTool(cwd, files?.editOptions()), request);
    case "bash": {
      const main = await idleProcess();
      const result = await callBody(createBashTool(cwd), request);
      await joinCommandDescendants(main);
      return result;
    }
    case "grep":
      return callBody(createGrepTool(cwd), request);
    case "find":
      return callBody(createFindTool(cwd), request);
    case "ls":
      return callBody(createLsTool(cwd), request);
  }
}

/** Dispatch the bounded operation in the already-enforced Linux namespace. */
export async function executeHandsRequest(request: HandsRequest, cwd: string): Promise<unknown> {
  if (request.kind === "resources") {
    return resources(request.workspaceRead === false ? "/tmp" : cwd);
  }
  const files = request.grants === undefined ? undefined : new HandsFiles(request.grants);
  try {
    if (request.kind === "custom") {
      const main = await idleProcess();
      try {
        return await executeCustomHand(request, files);
      } finally {
        await joinCommandDescendants(main);
      }
    }
    if (request.kind === "tool") {
      return await tool(request, cwd, files);
    }
    return await nativeFile(request, cwd, files);
  } finally {
    files?.close();
  }
}

async function entry(): Promise<void> {
  // Reject silent loader failure before request consumption. Children inherit no loader/marker authority.
  if (process.env.SEPT_HANDS_PROCESS_GUARD !== "1") {
    throw new SeptError("Hands process control guard is unavailable");
  }
  delete process.env.SEPT_HANDS_PROCESS_GUARD;
  delete process.env.LD_PRELOAD;
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > HANDS_REQUEST_BYTES) {
      throw new SeptError("Hands request exceeds its bound");
    }
  }
  const value: unknown = JSON.parse(input);
  const result = await executeHandsRequest(parseHandsRequest(value), process.cwd());
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output) > HANDS_RESPONSE_BYTES) {
    throw new SeptError("Hands response exceeds its bound");
  }
  process.stdout.write(output);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await entry().catch(() => {
    process.stderr.write("Hands operation refused\n");
    process.exitCode = 1;
  });
}
