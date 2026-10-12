/**
 * Owns bounded, exact, idempotent operator input below RunStore. Conversation projection is a
 * subordinate view; queue records remain pending until matching fsynced checkpoint or handover
 * evidence proves delivery, preventing loss across crashes and session rollover.
 */

import { randomUUID } from "node:crypto";
import type { OperatorMessage, RunEvent } from "./contracts.js";
import { ConversationStore } from "./conversation-store.js";
import { validateOperatorMessage, validateRunEvent } from "./evidence-codecs.js";
import { QueueCapacityError, SeptError } from "./errors.js";
import { appendSynced, atomicWrite, now, scanJsonLines } from "./filesystem.js";
import { MAX_PENDING_MESSAGE_BYTES, MAX_PENDING_MESSAGES } from "./limits.js";

interface QueuePaths {
  messages: string;
  events: string;
}

type RecordRunEvent = (type: string, fields?: Record<string, unknown>) => RunEvent;

function validMessageText(text: string): boolean {
  const unsafe = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
  return Boolean(text.trim()) && text.length <= 32_768 && !unsafe;
}

function embeddedMessages(value: unknown): OperatorMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((message) => validateOperatorMessage(message));
}

function eventEvidenceContains(event: RunEvent, expected: OperatorMessage[]): boolean {
  if (!Array.isArray(event.messageIds)) {
    return false;
  }
  const ids = event.messageIds.filter((id): id is string => typeof id === "string");
  const evidence = embeddedMessages(event.operatorMessages);
  return expected.every(
    (message) =>
      ids.includes(message.id) &&
      evidence.some(
        (recorded) =>
          recorded.id === message.id &&
          recorded.createdAt === message.createdAt &&
          recorded.text === message.text,
      ),
  );
}

function pendingBytes(messages: readonly OperatorMessage[]): number {
  return messages.reduce((total, message) => total + Buffer.byteLength(message.text), 0);
}

/** Owns bounded durable admission, proof, and consumption of operator input. */
class OperatorQueue {
  public constructor(
    private readonly paths: QueuePaths,
    private readonly conversation: ConversationStore,
    private readonly recordRunEvent: RecordRunEvent,
  ) {}

  /** Find accepted input by stable ID, including compacted event evidence. */
  public message(id: string): OperatorMessage | undefined {
    let found: OperatorMessage | undefined;
    scanJsonLines(this.paths.messages, (value) => {
      const message = validateOperatorMessage(value);
      if (message.id === id) {
        found = message;
        return false;
      }
      return undefined;
    });
    if (found !== undefined) {
      return found;
    }
    return this.messageFromEvents(id);
  }

  /** Durably accept exact operator text after deterministic capacity checks. */
  public enqueue(text: string, fixedId?: string): OperatorMessage {
    if (!validMessageText(text)) {
      throw new SeptError(
        "Operator message must contain 1-32768 characters without unsafe control characters",
      );
    }
    if (fixedId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(fixedId)) {
      throw new SeptError("Operator message ID is invalid");
    }
    const existing = fixedId === undefined ? undefined : this.message(fixedId);
    if (existing !== undefined) {
      return this.reconcileDuplicate(existing, text);
    }
    this.assertCapacity(text);
    const message = validateOperatorMessage({
      id: fixedId ?? `${String(Date.now())}-${randomUUID()}`,
      createdAt: now(),
      text,
    });
    appendSynced(this.paths.messages, message);
    this.recordRunEvent("operator_message_queued", { messageId: message.id });
    this.conversation.recordOperator(message);
    return message;
  }

  /** Recover the bounded queue after subtracting every durable consumption marker. */
  public pending(): OperatorMessage[] {
    const byId = new Map<string, OperatorMessage>();
    scanJsonLines(this.paths.messages, (value) => {
      const message = validateOperatorMessage(value);
      byId.set(message.id, message);
      return undefined;
    });
    scanJsonLines(this.paths.events, (value) => {
      const event = validateRunEvent(value);
      if (event.type === "operator_messages_consumed" && Array.isArray(event.messageIds)) {
        for (const id of event.messageIds) {
          if (typeof id === "string") {
            byId.delete(id);
          }
        }
      }
      return undefined;
    });
    const pending = [...byId.values()];
    this.assertDurableCapacity(pending);
    return pending;
  }

  /** Record exact at-least-once delivery evidence before invoking Pi. */
  public deliveryAttempt(messages: OperatorMessage[], sessionId: string): void {
    if (messages.length > 0) {
      this.recordRunEvent("operator_delivery_attempt", { sessionId, messages });
    }
  }

  /** Consume input only after matching fsynced checkpoint or handover evidence exists. */
  public consume(
    messages: OperatorMessage[],
    proofType: "work_checkpoint" | "handover_written",
  ): void {
    if (messages.length === 0) {
      return;
    }
    const proof = this.findProof(messages, proofType);
    if (proof === undefined) {
      throw new SeptError(`Cannot acknowledge operator input before durable ${proofType} proof`);
    }
    this.recordRunEvent("operator_messages_consumed", {
      messageIds: messages.map((message) => message.id),
      proofSeq: proof.seq,
    });
    // Consumption evidence must be durable before old queue records are compacted away.
    const remaining = this.pending();
    atomicWrite(
      this.paths.messages,
      remaining.map((message) => JSON.stringify(message)).join("\n"),
    );
  }

  private messageFromEvents(id: string): OperatorMessage | undefined {
    let found: OperatorMessage | undefined;
    scanJsonLines(this.paths.events, (value) => {
      const event = validateRunEvent(value);
      found = embeddedMessages(event.operatorMessages).find((message) => message.id === id);
      return found === undefined ? undefined : false;
    });
    return found;
  }

  private reconcileDuplicate(existing: OperatorMessage, text: string): OperatorMessage {
    if (existing.text !== text) {
      throw new SeptError("Operator message ID collision");
    }
    this.conversation.recordOperator(existing);
    return existing;
  }

  private assertCapacity(text: string): void {
    const pending = this.pending();
    const exceedsCount = pending.length >= MAX_PENDING_MESSAGES;
    const exceedsBytes =
      pendingBytes(pending) + Buffer.byteLength(text) > MAX_PENDING_MESSAGE_BYTES;
    if (exceedsCount || exceedsBytes) {
      throw new QueueCapacityError("Operator message queue capacity exceeded");
    }
  }

  private assertDurableCapacity(messages: OperatorMessage[]): void {
    if (
      messages.length > MAX_PENDING_MESSAGES ||
      pendingBytes(messages) > MAX_PENDING_MESSAGE_BYTES
    ) {
      throw new QueueCapacityError(
        "Durable operator message queue exceeds configured capacity; operator resolution is required",
      );
    }
  }

  private findProof(
    messages: OperatorMessage[],
    proofType: "work_checkpoint" | "handover_written",
  ): RunEvent | undefined {
    let proof: RunEvent | undefined;
    scanJsonLines(this.paths.events, (value) => {
      const event = validateRunEvent(value);
      if (event.type === proofType && eventEvidenceContains(event, messages)) {
        proof = event;
      }
      return undefined;
    });
    return proof;
  }
}

export { OperatorQueue };
