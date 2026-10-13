import { createHash } from "node:crypto";
import { createCustomHandTools, customPermissionGate } from "./custom-tool.js";
/** Reuses Pi's bounded coding tools inside native Durable tasks, preserving image and edit behavior. */

import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import {
  BackendExecutionEnv,
  HandsBackendUnavailableError,
  type CodingToolName,
  type ExecutionBackend,
  parseHandsToolResult,
} from "../execution/index.js";
import type { Context } from "@earendil-works/chord";
import { CapabilityRequestWaitingError, SeptError } from "../durable/index.js";
import type {
  ToolCall,
  ModelImageResizeOptions,
  Static,
  TSchema,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolRegistration,
  type HookApi,
} from "@earendil-works/pi-durable";

interface PiCodingTool<T extends TSchema> {
  name: string;
  description: string;
  parameters: T;
  prepareArguments?: (args: unknown) => Static<T>;
  executionMode?: "parallel" | "sequential";
  execute(
    id: string,
    args: Static<T>,
    signal?: AbortSignal,
  ): Promise<{
    content: ToolResultMessage["content"];
    isError?: boolean;
  }>;
}

async function executeCodingBody(
  name: string,
  args: unknown,
  callId: string,
  taskKey: string,
  backend: ExecutionBackend,
  context: Context,
  resizeOptions: ModelImageResizeOptions | undefined,
  onFailure: (error: unknown) => void,
) {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new SeptError("Native tool arguments must be an object");
  }
  // CAST: The fixed seven Pi factories supply these names; native Pi has validated the argument schema.
  const codingName = name as CodingToolName;
  try {
    return parseHandsToolResult(
      await backend.invoke(
        {
          kind: "tool",
          name: codingName,
          callId,
          taskKey,
          // CAST: Native schemas are JSON objects and the guard above excludes null/arrays.
          arguments: args as Record<string, unknown>,
          ...(resizeOptions === undefined ? {} : { resize: resizeOptions }),
        },
        context,
      ),
    );
  } catch (error: unknown) {
    return codingFailure(error, context, onFailure);
  }
}

function codingFailure(error: unknown, context: Context, onFailure: (error: unknown) => void) {
  if (error instanceof CapabilityRequestWaitingError) {
    // Admission denied before effects; settle the original safe-replay task before sealing generation.
    return {
      content: [
        {
          type: "text" as const,
          text: "Exact permission requested; original operation denied before effects.",
        },
      ],
      isError: true,
    };
  }
  if (error instanceof HandsBackendUnavailableError && !context.abortSignal?.aborted) {
    onFailure(error);
  }
  throw error;
}

function durableTool<T extends TSchema>(
  tool: PiCodingTool<T>,
  replay: "safe" | "unsafe",
  backend: ExecutionBackend,
  resizeOptions?: ModelImageResizeOptions,
  onFailure: (error: unknown) => void = () => undefined,
): ToolRegistration<T> {
  const prepareArguments = tool.prepareArguments;
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    replay,
    // Pi already bounds content; leave bounded space for its pagination and truncation footer.
    outputLimits: {
      maxBytes: DEFAULT_MAX_BYTES + 4096,
      maxLines: DEFAULT_MAX_LINES + 16,
      retain: tool.name === "bash" ? "tail" : "head",
    },
    ...(prepareArguments === undefined
      ? {}
      : { prepareArguments: (args: unknown) => prepareArguments(structuredClone(args)) }),
    ...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
    execute: (args, api, context) =>
      executeCodingBody(
        tool.name,
        args,
        api.callId,
        nativeCallIdentity(api),
        backend,
        context,
        resizeOptions,
        onFailure,
      ),
  });
}

/** Native registrations; interrupted mutating tools are never silently replayed after a crash. */
export function createDurableCodingTools(
  backend: ExecutionBackend,
  resizeOptions?: ModelImageResizeOptions,
  onFailure: (error: unknown) => void = () => undefined,
): Extension {
  const workspace = backend.cwd;
  return defineExtension({
    name: "sept-tools",
    tools: [
      ...createCustomHandTools(backend, onFailure),
      durableTool(
        createReadTool(workspace, resizeOptions === undefined ? {} : { resizeOptions }),
        "safe",
        backend,
        resizeOptions,
        onFailure,
      ),
      durableTool(createWriteTool(workspace), "unsafe", backend, undefined, onFailure),
      durableTool(createEditTool(workspace), "unsafe", backend, undefined, onFailure),
      ...(backend.shell
        ? [durableTool(createBashTool(workspace), "unsafe", backend, undefined, onFailure)]
        : []),
      durableTool(createGrepTool(workspace), "safe", backend, undefined, onFailure),
      durableTool(createFindTool(workspace), "safe", backend, undefined, onFailure),
      durableTool(createLsTool(workspace), "safe", backend, undefined, onFailure),
    ].filter(
      (tool) =>
        backend.tools === undefined ||
        backend.tools.some((name) => name === tool.name) ||
        tool.name === "custom_hand",
    ),
  });
}

/** Native pre-intent gate delegates authority to the same effect owner used by replay. */
export async function permissionToolGate(
  backend: ExecutionBackend | undefined,
  call: ToolCall,
  api?: HookApi,
  context?: Context,
  onFailure?: (error: unknown) => void,
): Promise<{ block: string } | undefined> {
  try {
    return await evaluatePermissionToolGate(backend, call, api, context);
  } catch (error: unknown) {
    onFailure?.(error);
    throw error;
  }
}
async function evaluatePermissionToolGate(
  backend: ExecutionBackend | undefined,
  call: ToolCall,
  api?: HookApi,
  context?: Context,
): Promise<{ block: string } | undefined> {
  if (call.name === "custom_hand" && backend?.customHand !== undefined) {
    return customPermissionGate(backend, call, api, context);
  }
  const names = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;
  const name = names.find((candidate) => candidate === call.name);
  if (name === undefined) {
    return undefined;
  }
  const block = backend?.beforeTool?.({
    kind: "tool",
    name,
    callId: call.id,
    ...(api === undefined ? {} : { taskKey: nativeCallIdentity(api) }),
    arguments: call.arguments,
  });
  return block === undefined ? undefined : { block };
}
/** Trusted tools keep the native ABI and receive exact task-bound environment effect identities. */
export function bindNativeToolEnvironment(
  extension: Extension,
  backend: ExecutionBackend,
  onFailure: (error: unknown) => void,
): Extension {
  return {
    ...extension,
    ...(extension.tools === undefined
      ? {}
      : {
          tools: extension.tools.map((tool) => ({
            ...tool,
            execute: (args, api, context) =>
              tool.execute(
                args,
                {
                  ...api,
                  env: new BackendExecutionEnv(
                    backend,
                    onFailure,
                    `native-${String(api.conversationId)}-${String(api.taskId)}-${api.callId}`,
                  ),
                },
                context,
              ),
          })),
        }),
  };
}

function nativeCallIdentity(api: Pick<HookApi, "taskId" | "conversationId">): string {
  return createHash("sha256")
    .update(JSON.stringify([api.conversationId, api.taskId]))
    .digest("hex");
}
