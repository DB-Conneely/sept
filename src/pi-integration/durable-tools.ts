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
  HandsBackendUnavailableError,
  type CodingToolName,
  type ExecutionBackend,
  parseHandsToolResult,
} from "../execution/index.js";
import type { Context } from "@earendil-works/chord";
import { SeptError } from "../durable/index.js";
import type {
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
          // CAST: Native schemas are JSON objects and the guard above excludes null/arrays.
          arguments: args as Record<string, unknown>,
          ...(resizeOptions === undefined ? {} : { resize: resizeOptions }),
        },
        context,
      ),
    );
  } catch (error: unknown) {
    if (error instanceof HandsBackendUnavailableError && !context.abortSignal?.aborted) {
      onFailure(error);
    }
    throw error;
  }
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
      executeCodingBody(tool.name, args, api.callId, backend, context, resizeOptions, onFailure),
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
    ],
  });
}
