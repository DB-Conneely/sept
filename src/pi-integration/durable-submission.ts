/** Reattaches one fsynced native request, including settled work, and tracks exact delivered input. */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  type Conversation,
  type EntryId,
  type Harness,
  type Submission,
} from "@earendil-works/pi-durable";
import { SeptError, type OperatorMessage, type RunStore } from "../durable/index.js";
import {
  completeDurableAdmission,
  readInvocationAdmission,
  writeDurableAdmission,
  type DurableAdmission,
} from "./durable-admission.js";
import { operatorBlock } from "./prompts.js";
import { sessionMessageText } from "./message-text.js";

/** Native answer and exact queue identities owned by this invocation, never a later queue reread. */
export interface DurableSubmissionResult {
  answer: EntryId;
  requestId: string;
  deliveredMessageIds: readonly string[];
}

/** One invocation identity; native storage remains the sole task/submission authority. */
export class DurableSubmission {
  private admission: DurableAdmission | undefined;
  private conversation: Conversation | undefined;

  public constructor(private readonly store: RunStore) {}

  /** Load identity before native scheduling; a ready wake starts a new invocation. */
  public bind(conversation: Conversation): void {
    this.conversation = conversation;
    const admission = readInvocationAdmission(this.store);
    const recovering = this.store.snapshot().phase !== "ready";
    this.admission =
      recovering && admission?.conversationId === conversation.id && !admission.checkpointed
        ? admission
        : undefined;
  }

  /** Keep recovered work within its original SEPT invocation budget and public message identity. */
  public get recoveryInvocation(): number | undefined {
    return this.admission === undefined
      ? undefined
      : Number(this.admission.requestId.slice("sept-invocation-".length));
  }

  /** Fsync completion only after the matching SEPT transition has completed durably. */
  public acknowledge(requestId: string): void {
    completeDurableAdmission(this.store, requestId);
    this.admission = undefined;
  }

  private requireConversation(): Conversation {
    if (this.conversation === undefined) {
      throw new SeptError("Pi Durable submission owner is not bound");
    }
    return this.conversation;
  }

  private async input(
    harness: Harness,
    prompt: string,
    messages: readonly OperatorMessage[],
  ): Promise<Submission> {
    const conversation = this.requireConversation();
    if (this.admission !== undefined) {
      const admitted = await conversation.commit(
        (tx) => tx.submissionByRequest(conversation.id, this.admission?.requestId ?? ""),
        BACKGROUND_CONTEXT,
      );
      if (admitted !== undefined) {
        if (admitted.type !== "input" || admitted.status === "unanswered") {
          throw new SeptError("Pi Durable submission did not finish successfully");
        }
        const submission = await harness.submission(admitted.id, BACKGROUND_CONTEXT);
        if (submission === undefined) {
          throw new SeptError("Pi Durable lost an admitted submission");
        }
        return submission;
      }
      // Admission may have fsynced immediately before a crash prevented native submission.
      return conversation.submit(
        { type: "input", content: this.admission.prompt, requestId: this.admission.requestId },
        BACKGROUND_CONTEXT,
      );
    }
    const requestId = `sept-invocation-${String(this.store.snapshot().invocations)}`;
    writeDurableAdmission(this.store, conversation.id, requestId, messages, prompt);
    return conversation.submit({ type: "input", content: prompt, requestId }, BACKGROUND_CONTEXT);
  }

  /** Wait for actual native settlement, preserving unsafe-tool uncertainty rather than replaying effects. */
  public async wait(submission: Submission): Promise<EntryId> {
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    if (settled.type !== "input" || settled.status !== "done") {
      throw new SeptError("Pi Durable submission did not finish successfully");
    }
    return settled.answer;
  }

  /** Project the exact settled answer, never the newest unrelated entry in a conversation page. */
  public async text(answer: EntryId): Promise<string> {
    const entry = await this.requireConversation().commit(
      (tx) => tx.entry(AssistantEntry, answer),
      BACKGROUND_CONTEXT,
    );
    const message = entry?.model?.find((value) => value.role === "assistant");
    if (message === undefined) {
      throw new SeptError("Pi Durable ended without a finalized assistant response");
    }
    return sessionMessageText(message);
  }

  /** Reattach completed or live work, then deliver only the controller's exact recovery capture. */
  public async run(
    harness: Harness,
    prompt: string,
    messages: readonly OperatorMessage[],
  ): Promise<DurableSubmissionResult> {
    const submission = await this.input(harness, prompt, messages);
    const requestId =
      this.admission?.requestId ?? `sept-invocation-${String(this.store.snapshot().invocations)}`;
    const forwarded: Submission[] = [];
    if (this.admission !== undefined) {
      for (const message of messages) {
        if (!this.admission.operatorMessageIds.includes(message.id)) {
          forwarded.push(
            await this.requireConversation().submit(
              {
                type: "input",
                content: operatorBlock([message]),
                requestId: `sept-operator-${message.id}`,
                whenBusy: "steer",
              },
              BACKGROUND_CONTEXT,
            ),
          );
        }
      }
    }
    let answer = await this.wait(submission);
    for (const message of forwarded) {
      answer = await this.wait(message);
    }
    return { answer, requestId, deliveredMessageIds: messages.map((message) => message.id) };
  }
}
