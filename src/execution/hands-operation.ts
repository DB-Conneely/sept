/** Stateless parent-bound operation adaptation; backend retains policy/lifecycle and Pi retains scheduling. */
import type { Context } from "@earendil-works/chord";
import { SeptError } from "../durable/index.js";
import { HandsBackendUnavailableError, EngineControlError } from "./contracts.js";
import type { HandsLossFacts } from "./contracts.js";
import type { HandsRequest } from "./contracts.js";
import { assertHandsEffect } from "./hands-effects.js";
import { assertHandsCommand } from "./hands-command-authority.js";
import type { HandsProcessOwner } from "./hands-process-owner.js";
import { HandsOperationError, type WarmHandsChannel } from "./warm-channel.js";

/** Refresh parent authority before each effect/registered Engine start; no grants or lifetime state live here. */
export async function invokeHandsOperation(
  channel: WarmHandsChannel,
  processes: HandsProcessOwner | undefined,
  request: HandsRequest,
  cwd: string,
  authorize: () => Promise<HandsRequest>,
): Promise<unknown> {
  let result: unknown;
  try {
    result = await channel.invoke(
      request,
      async (frame) => {
        assertHandsEffect(await authorize(), cwd, frame.payload);
      },
      async (command, output, signal) => {
        const options = assertHandsCommand(request, command, cwd);
        if (processes === undefined) {
          throw new SeptError("Hands process owner is absent");
        }
        return processes.execute(
          command,
          {
            ...options,
            signal,
            authorize: async () => {
              await authorize();
            },
          },
          output,
        );
      },
    );
  } finally {
    // Every serial operation owns Engine siblings/helpers as well as command descendants before settlement.
    await processes?.join();
  }
  return result;
}

/** Idle close verifies every nonresident process before EOF; uncertain join falls back to exact namespace stop. */
export async function joinHandsBeforeClose(
  processes: HandsProcessOwner | undefined,
  stopping: Promise<void> | undefined,
  stop: () => Promise<void>,
): Promise<void> {
  await stopping;
  if (stopping !== undefined) {
    return;
  }
  try {
    await processes?.join();
  } catch (error: unknown) {
    await stop();
    throw new HandsBackendUnavailableError("Hands idle process join was refused", { cause: error });
  }
}

/** A lost client cannot establish no effect; exact-generation stop must join before truthful uncertainty settles. */
export async function stopLostHandsExecution(
  stop: () => Promise<void>,
  error: unknown,
  facts?: Omit<HandsLossFacts, "namespaceStopped" | "engine">,
): Promise<never> {
  try {
    await stop();
  } catch (stopError: unknown) {
    throw new HandsBackendUnavailableError(
      "Hands shutdown is unverified; consumer reconciliation is required",
      {
        cause: stopError,
        ...(facts === undefined ? {} : { facts: lossFacts(facts, error, false) }),
      },
    );
  }
  throw new HandsBackendUnavailableError(
    "Hands backend lost execution authority; interrupted effects may be uncertain",
    { cause: error, ...(facts === undefined ? {} : { facts: lossFacts(facts, error, true) }) },
  );
}

function lossFacts(
  facts: Omit<HandsLossFacts, "namespaceStopped" | "engine">,
  error: unknown,
  namespaceStopped: boolean,
): HandsLossFacts {
  return {
    ...facts,
    namespaceStopped,
    ...(error instanceof EngineControlError ? { engine: error.facts } : {}),
  };
}

/** One admitted parent retains typed stage/budget facts while the backend owns queued cancellation and exact stop. */
export async function invokeAdmittedHands(
  context: Context,
  request: HandsRequest,
  owner: {
    dispatch: (stage: (stage: "effect" | "result") => void) => Promise<unknown>;
    stop: () => Promise<void>;
    loss: () => Error | undefined;
  },
): Promise<unknown> {
  const started = performance.now();
  let stage: "dispatch" | "effect" | "result" = "dispatch";
  let effectsUncertain = false;
  try {
    return await owner.dispatch((next) => {
      stage = next;
      effectsUncertain = true;
    });
  } catch (error: unknown) {
    if (error instanceof HandsOperationError) {
      throw error;
    }
    return stopLostHandsExecution(owner.stop, owner.loss() ?? error, {
      stage,
      operation: request.kind,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)),
      cancelled: context.abortSignal?.aborted === true,
      authorityLost: true,
      effectsUncertain,
    });
  }
}
