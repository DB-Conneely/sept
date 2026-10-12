/**
 * Owns the bounded client-facing conversation projection beneath RunStore. Internal event/queue
 * evidence remains authoritative; this store preserves exact accepted text, strict cursors,
 * idempotent crash recovery, and terminal state without exposing operational payloads.
 */

import { existsSync } from "node:fs";
import type { ConversationEvent, OperatorMessage, RunSnapshot } from "./contracts.js";
import {
  validateConversationEvent,
  validateOperatorMessage,
  validateRunEvent,
} from "./evidence-codecs.js";
import { ConversationCursorExpiredError, SeptError } from "./errors.js";
import { appendSynced, atomicWrite, now, scanJsonLines } from "./filesystem.js";
import {
  MAX_CONVERSATION_BYTES,
  MAX_CONVERSATION_EVENTS,
  MAX_JSONL_RECORD_BYTES,
} from "./limits.js";

interface ConversationPage {
  events: ConversationEvent[];
  nextCursor: number;
  retainedFrom: number;
}

type ConversationEventInput =
  | { formatVersion: 1; id: string; type: "message"; role: "user" | "assistant"; text: string }
  | { formatVersion: 1; id: string; type: "state"; state: "active" | "waiting" }
  | {
      formatVersion: 1;
      id: string;
      type: "terminal";
      status: "cancelled" | "complete" | "blocked" | "failed";
    };

type RecordRunEvent = (type: string, fields?: Record<string, unknown>) => void;
type TerminalConversationStatus = "cancelled" | "complete" | "blocked" | "failed";

function eventBytes(event: ConversationEvent): number {
  return Buffer.byteLength(JSON.stringify(event)) + 1;
}

function loadConversation(path: string): ConversationEvent[] {
  const retained: ConversationEvent[] = [];
  let retainedBytes = 0;
  scanJsonLines(path, (value) => {
    const event = validateConversationEvent(value);
    const previous = retained.at(-1);
    if (previous !== undefined && event.cursor <= previous.cursor) {
      throw new SeptError("Durable conversation cursors are not strictly ordered");
    }
    retained.push(event);
    retainedBytes += eventBytes(event);
    const exceedsRecoverableCount = retained.length > MAX_CONVERSATION_EVENTS + 1;
    const exceedsRecoverableBytes = retainedBytes > MAX_CONVERSATION_BYTES + MAX_JSONL_RECORD_BYTES;
    if (exceedsRecoverableCount || exceedsRecoverableBytes) {
      throw new SeptError("Durable conversation exceeds recoverable retention bounds");
    }
    return undefined;
  });
  return retained;
}

function sameEvent(left: ConversationEvent, right: ConversationEventInput): boolean {
  const { cursor: _cursor, at: _at, ...comparable } = left;
  return JSON.stringify(comparable) === JSON.stringify(right);
}

function retainedPage(
  retained: ConversationEvent[],
  after: number,
  limit: number,
): ConversationPage {
  const retainedFrom = retained[0]?.cursor ?? 1;
  const latestCursor = retained.at(-1)?.cursor ?? 0;
  if (after < retainedFrom - 1) {
    throw new ConversationCursorExpiredError(retainedFrom);
  }
  if (after > latestCursor) {
    throw new SeptError("conversation cursor is beyond latest cursor");
  }
  const boundedLimit = Math.min(Math.max(limit, 1), 250);
  const events = retained.filter((event) => event.cursor > after).slice(0, boundedLimit);
  return { events, nextCursor: events.at(-1)?.cursor ?? after, retainedFrom };
}

function compactedEvents(retained: ConversationEvent[]): ConversationEvent[] {
  let kept = retained.slice(-MAX_CONVERSATION_EVENTS);
  let bytes = kept.reduce((total, event) => total + eventBytes(event), 0);
  while (kept.length > 1 && bytes > MAX_CONVERSATION_BYTES) {
    const discarded = kept[0];
    if (discarded === undefined) {
      break;
    }
    bytes -= eventBytes(discarded);
    kept = kept.slice(1);
  }
  return kept;
}

function normalizeConversation(path: string, retained: ConversationEvent[]): ConversationEvent[] {
  const kept = compactedEvents(retained);
  if (kept.length !== retained.length) {
    atomicWrite(path, kept.map((item) => JSON.stringify(item)).join("\n"));
  }
  return kept;
}

function terminalStatus(snapshot: RunSnapshot): TerminalConversationStatus | undefined {
  if (
    snapshot.status === "cancelled" ||
    snapshot.status === "complete" ||
    snapshot.status === "blocked" ||
    snapshot.status === "failed"
  ) {
    return snapshot.status;
  }
  return undefined;
}

function hasTerminalMarker(eventsPath: string, status: string): boolean {
  let recorded = false;
  scanJsonLines(eventsPath, (value) => {
    const event = validateRunEvent(value);
    if (event.type === "conversation_terminal_recorded" && event.status === status) {
      recorded = true;
      return false;
    }
    return undefined;
  });
  return recorded;
}

/** Owns bounded, client-facing conversation persistence for one run. */
class ConversationStore {
  public constructor(
    private readonly conversationPath: string,
    private readonly eventsPath: string,
    private readonly recordRunEvent: RecordRunEvent,
  ) {}

  /** Read a stable bounded page and enforce retention cursor semantics. */
  public page(after = 0, limit = 100): ConversationPage {
    const retained = normalizeConversation(
      this.conversationPath,
      loadConversation(this.conversationPath),
    );
    return retainedPage(retained, after, limit);
  }

  /** Persist one exact user or validated assistant message idempotently. */
  public message(id: string, role: "user" | "assistant", text: string): ConversationEvent {
    return this.append({ formatVersion: 1, id, type: "message", role, text });
  }

  /** Persist one resumable active/waiting lifecycle event idempotently. */
  public state(id: string, state: "active" | "waiting"): ConversationEvent {
    return this.append({ formatVersion: 1, id, type: "state", state });
  }

  /** Ensure the immutable task is the first user-visible run message. */
  public ensureInitial(id: string, task: string): void {
    if (!existsSync(this.conversationPath)) {
      this.message(id, "user", task);
    }
  }

  /** Reconcile accepted operator evidence across the queue-to-conversation crash seam. */
  public reconcileOperators(messagesPath: string): void {
    const messages = this.recoverOperatorMessages(messagesPath);
    const recorded = this.recordedOperatorIds();
    for (const message of messages.values()) {
      if (!recorded.has(message.id)) {
        this.recordOperator(message);
        recorded.add(message.id);
      }
    }
  }

  /** Ensure one terminal conversation event exists for an authoritative terminal snapshot. */
  public ensureTerminal(snapshot: RunSnapshot): void {
    const status = terminalStatus(snapshot);
    if (status === undefined || hasTerminalMarker(this.eventsPath, status)) {
      return;
    }
    this.append({ formatVersion: 1, id: `terminal-${status}`, type: "terminal", status });
    this.recordRunEvent("conversation_terminal_recorded", { status });
  }

  /** Record exact accepted operator input and its durable projection marker. */
  public recordOperator(message: OperatorMessage): void {
    this.message(`operator-${message.id}`, "user", message.text);
    if (!this.recordedOperatorIds().has(message.id)) {
      this.recordRunEvent("operator_conversation_recorded", { messageId: message.id });
    }
  }

  private append(input: ConversationEventInput): ConversationEvent {
    const retained = normalizeConversation(
      this.conversationPath,
      loadConversation(this.conversationPath),
    );
    const existing = retained.find((event) => event.id === input.id);
    if (existing !== undefined) {
      if (!sameEvent(existing, input)) {
        throw new SeptError("Conversation event ID collision");
      }
      return existing;
    }
    const event = validateConversationEvent({
      ...input,
      cursor: (retained.at(-1)?.cursor ?? 0) + 1,
      at: now(),
    });
    appendSynced(this.conversationPath, event);
    normalizeConversation(this.conversationPath, [...retained, event]);
    return event;
  }

  private recoverOperatorMessages(messagesPath: string): Map<string, OperatorMessage> {
    const messages = new Map<string, OperatorMessage>();
    scanJsonLines(messagesPath, (value) => {
      const message = validateOperatorMessage(value);
      messages.set(message.id, message);
      return undefined;
    });
    scanJsonLines(this.eventsPath, (value) => {
      const event = validateRunEvent(value);
      this.addEmbeddedMessages(messages, event.operatorMessages);
      return undefined;
    });
    return messages;
  }

  private addEmbeddedMessages(messages: Map<string, OperatorMessage>, embedded: unknown): void {
    if (!Array.isArray(embedded)) {
      return;
    }
    for (const value of embedded) {
      const message = validateOperatorMessage(value);
      if (!messages.has(message.id)) {
        messages.set(message.id, message);
      }
    }
  }

  private recordedOperatorIds(): Set<string> {
    const recorded = new Set<string>();
    scanJsonLines(this.eventsPath, (value) => {
      const event = validateRunEvent(value);
      if (event.type === "operator_conversation_recorded" && typeof event.messageId === "string") {
        recorded.add(event.messageId);
      }
      return undefined;
    });
    return recorded;
  }
}

export { ConversationStore };
