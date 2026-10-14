/** The one operator-registered tool pins its program in native task memos before execution intent. */
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { Type, type ToolCall } from "@earendil-works/pi-ai";
import {
  defineTool,
  type HookApi,
  type ToolRegistration,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { CapabilityRequestWaitingError, SeptError } from "../durable/index.js";
import {
  HandsBackendUnavailableError,
  parseHandsToolResult,
  type ExecutionBackend,
} from "../execution/index.js";
type RegisteredHand = NonNullable<ExecutionBackend["customHand"]>;

const PROGRAM_MEMO = "sept.custom.operator-program";
function programIdentity(hand: RegisteredHand): string {
  return createHash("sha256").update(JSON.stringify(hand)).digest("hex");
}
function taskIdentity(api: Pick<HookApi, "taskId" | "conversationId">): string {
  return createHash("sha256")
    .update(JSON.stringify([api.conversationId, api.taskId]))
    .digest("hex");
}

/** Native pre-intent memo is private task evidence; model text never chooses program authority. */
export async function customPermissionGate(
  backend: ExecutionBackend,
  call: ToolCall,
  api: HookApi | undefined,
  context: Context | undefined,
): Promise<{ block: string } | undefined> {
  const hand = backend.customHand;
  if (hand === undefined || api === undefined || context === undefined) {
    throw new HandsBackendUnavailableError("Custom hand requires native task identity");
  }
  const identity = programIdentity(hand);
  const original = await api.memo(PROGRAM_MEMO, identity, context);
  if (original !== identity) {
    throw new HandsBackendUnavailableError("Custom hand original program identity changed");
  }
  const text = call.arguments.text;
  if (typeof text !== "string") {
    throw new SeptError("Custom hand text must be bounded");
  }
  const block = backend.beforeTool?.({
    kind: "custom",
    callId: call.id,
    taskKey: taskIdentity(api),
    arguments: {
      text,
      ...networkIntentArguments(call.arguments.network),
    },
  });
  return block === undefined ? undefined : { block };
}

/** Register only the fixed bounded custom body, with its operator replay declaration and private pin. */
export function createCustomHandTools(
  backend: ExecutionBackend,
  onFailure: (error: unknown) => void,
): ToolRegistration[] {
  const hand = backend.customHand;
  if (hand === undefined) {
    return [];
  }
  return [
    defineTool({
      name: "custom_hand",
      description: "Run the single operator-registered hand with bounded text input",
      parameters: Type.Object(
        {
          network: Type.Optional(
            Type.Boolean({ description: "Explicit network intent; default false" }),
          ),
          text: Type.String({ maxLength: 256 }),
        },
        { additionalProperties: false },
      ),
      replay: hand.replay,
      outputLimits: { maxBytes: 4096, maxLines: 64 },
      execute: (args, api, context) => executeCustom(backend, hand, onFailure, args, api, context),
    }),
  ];
}

async function executeCustom(
  backend: ExecutionBackend,
  hand: RegisteredHand,
  onFailure: (error: unknown) => void,
  args: { text: string; network?: boolean },
  api: ToolExecutionApi,
  context: Context,
) {
  try {
    if ((await api.memo<string>(PROGRAM_MEMO, context)) !== programIdentity(hand)) {
      throw new HandsBackendUnavailableError(
        "Custom hand original program identity is absent or changed",
      );
    }
    return parseHandsToolResult(
      await backend.invoke(
        {
          kind: "custom",
          callId: api.callId,
          taskKey: taskIdentity(api),
          arguments: args,
        },
        context,
      ),
    );
  } catch (error: unknown) {
    return customFailure(error, context, onFailure);
  }
}
function customFailure(error: unknown, context: Context, onFailure: (error: unknown) => void) {
  if (error instanceof CapabilityRequestWaitingError) {
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
  if (!context.abortSignal?.aborted) {
    onFailure(error);
  }
  throw error;
}

function networkIntentArguments(value: unknown): { network?: boolean } {
  if (value !== undefined && typeof value !== "boolean") {
    throw new SeptError("Custom hand network intent must be boolean");
  }
  return value === undefined ? {} : { network: value };
}
