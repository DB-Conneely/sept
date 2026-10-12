/** Reads native request/submission evidence for rotation replay; intent alone never proves delivery. */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  type Conversation,
  type ConversationId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { SeptError, type RunStore } from "../durable/index.js";
import { readDurableAdmission } from "./durable-admission.js";
import type { DurableSubmissionResult } from "./durable-submission.js";
import { sessionMessageText } from "./message-text.js";
import { ROTATION_STEER } from "./prompts.js";

/** Restore the predecessor's ordinary progress from the existing bounded native history page. */
export async function recoveredPreRotationText(
  conversation: Conversation,
): Promise<string | undefined> {
  const entries = await conversation.entries({}, 250, undefined, BACKGROUND_CONTEXT);
  const marker = entries.items.findIndex((entry) =>
    entry.model?.some(
      (message) => message.role === "user" && sessionMessageText(message) === ROTATION_STEER,
    ),
  );
  if (marker < 0) {
    return undefined;
  }
  const predecessor = entries.items.slice(marker + 1).find((entry) => AssistantEntry.is(entry));
  return (
    sessionMessageText(predecessor?.model?.find((message) => message.role === "assistant")) ||
    undefined
  );
}

/** Recover the original exact capture before a rollover wait can enable native scheduling. */
export async function recoveredRotationMessages(
  store: RunStore,
  conversation: Conversation,
): Promise<Pick<DurableSubmissionResult, "requestId" | "deliveredMessageIds">> {
  const requestId = `sept-invocation-${String(store.snapshot().invocations)}`;
  const original = await conversation.commit(
    (tx) => tx.submissionByRequest(conversation.id, requestId),
    BACKGROUND_CONTEXT,
  );
  if (original?.type !== "input") {
    throw new SeptError("Pi Durable rotation is missing its original native input");
  }
  const deliveredMessageIds = readDurableAdmission(store, conversation.id, original.requestId);
  return { requestId, deliveredMessageIds };
}

function checkpointRecord(checkpoint: unknown): Record<string, unknown> {
  if (typeof checkpoint !== "object" || checkpoint === null || Array.isArray(checkpoint)) {
    throw new SeptError("Pi Durable generation request checkpoint is missing");
  }
  // CAST: Native checkpoints are JSON objects; null and arrays were rejected above.
  return checkpoint as Record<string, unknown>;
}

function requestCutoff(value: unknown): number {
  const checkpoint = checkpointRecord(value);
  if (checkpoint.phase !== "request" && checkpoint.phase !== "poll") {
    throw new SeptError("Pi Durable generation is outside its request boundary");
  }
  if (
    typeof checkpoint.cutoff !== "number" ||
    !Number.isSafeInteger(checkpoint.cutoff) ||
    checkpoint.cutoff < 1
  ) {
    throw new SeptError("Pi Durable generation request cutoff is invalid");
  }
  return checkpoint.cutoff;
}

async function includesRotation(
  tx: Tx,
  conversationId: ConversationId,
  cutoff: number,
): Promise<boolean> {
  for (const requestId of [
    `sept-rollover-${String(conversationId)}`,
    `sept-rollover-recovery-${String(conversationId)}`,
  ]) {
    const submission = await tx.submissionByRequest(conversationId, requestId);
    if (
      submission?.type !== "input" ||
      submission.entry === undefined ||
      submission.entry > cutoff
    ) {
      continue;
    }
    const visible = await tx.scanEntries(
      { conversationId, minEntryId: submission.entry, maxEntryId: submission.entry },
      1,
    );
    if (visible.items.length === 1) {
      return true;
    }
  }
  return false;
}

/** Classify this exact request, including deferred polls/replay, against native placement/cutoff. */
export function isRotationResponse(conversation: Conversation, taskId: TaskId): Promise<boolean> {
  return conversation.commit(async (tx) => {
    const task = await tx.task(taskId);
    if (task?.kind !== "pi.generation" || task.state.status !== "running") {
      throw new SeptError("Pi Durable rotation response has no running generation owner");
    }
    const cutoff = requestCutoff(task.state.checkpoint);
    return includesRotation(tx, conversation.id, cutoff);
  }, BACKGROUND_CONTEXT);
}
