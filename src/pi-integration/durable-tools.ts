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

function durableTool<T extends TSchema>(
  tool: PiCodingTool<T>,
  replay: "safe" | "unsafe",
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
    execute: (args, api, context) => tool.execute(api.callId, args, context.abortSignal),
  });
}

/** Native registrations; interrupted mutating tools are never silently replayed after a crash. */
export function createDurableCodingTools(
  workspace: string,
  resizeOptions?: ModelImageResizeOptions,
): Extension {
  return defineExtension({
    name: "sept-tools",
    tools: [
      durableTool(
        createReadTool(workspace, resizeOptions === undefined ? {} : { resizeOptions }),
        "safe",
      ),
      durableTool(createWriteTool(workspace), "unsafe"),
      durableTool(createEditTool(workspace), "unsafe"),
      durableTool(createBashTool(workspace), "unsafe"),
      durableTool(createGrepTool(workspace), "safe"),
      durableTool(createFindTool(workspace), "safe"),
      durableTool(createLsTool(workspace), "safe"),
    ],
  });
}
