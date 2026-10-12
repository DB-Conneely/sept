/**
 * Owns exact operator-message enqueue telemetry and blocked/waiting wake transitions. WorkerRuntime
 * supplies a live admission callback and retains slot launch authority; durable RunStore operations
 * remain the only source of queue identity, idempotency, and conversation evidence.
 */

import { type RunSnapshot, type RunStore } from "../durable/index.js";
import type { Observability } from "../observability/index.js";
import { updateRuntimeSnapshot } from "./runtime-state.js";

/** Applies one admitted message enqueue and requests a controller launch only after durable wake. */
export class WorkerMessages {
  public constructor(
    private readonly observability: Observability,
    private readonly admission: (store: RunStore, existing: boolean) => RunSnapshot,
    private readonly launch: (store: RunStore) => void,
  ) {}

  /** Repair accepted but unconsumed input through projection and wake before acknowledging it. */
  public send(
    store: RunStore,
    text: string,
    fixedId: string | undefined,
  ): ReturnType<RunStore["enqueueMessage"]> {
    const existing = fixedId === undefined ? undefined : store.operatorMessage(fixedId);
    const pending =
      existing !== undefined &&
      store.pendingMessages().some((message) => message.id === existing.id);
    const consumed = existing !== undefined && !pending;
    const snapshot = this.admission(store, consumed);
    const message = store.enqueueMessage(text, fixedId);
    const queueDepth = store.pendingMessages().length;
    this.recordQueued(store, snapshot.status, queueDepth, existing !== undefined);
    if (!consumed && (snapshot.status === "blocked" || snapshot.status === "waiting")) {
      this.wake(store, snapshot, message.id, queueDepth);
    } else if (!consumed && snapshot.status === "active") {
      // A crash may have published the wake state before launch; the worker retains live slot checks.
      this.launch(store);
    }
    return message;
  }

  private recordQueued(
    store: RunStore,
    status: RunSnapshot["status"],
    queueDepth: number,
    duplicate: boolean,
  ): void {
    this.observability.setQueueDepth(queueDepth);
    this.observability.event("sept.operator.queued", {
      "sept.queue.depth": queueDepth,
      "sept.outcome": duplicate ? "duplicate" : "accepted",
    });
    this.observability.log("operator_message.queued", {
      "sept.run.id": store.runId,
      "sept.run.state": status,
      "sept.queue.depth": queueDepth,
      "sept.outcome": duplicate ? "duplicate" : "accepted",
    });
  }

  private wake(
    store: RunStore,
    snapshot: RunSnapshot,
    messageId: string,
    queueDepth: number,
  ): void {
    updateRuntimeSnapshot(store, {
      status: "active",
      phase: "ready",
      reason: undefined,
      terminalCause: undefined,
    });
    const waking = snapshot.status === "waiting";
    store.event(waking ? "run_woken" : "run_reopened", { messageId });
    store.conversationState(`${waking ? "wake" : "reopen"}-${messageId}`, "active");
    this.observability.setRunState("active", snapshot.epoch, snapshot.invocations, queueDepth);
    this.observability.event(waking ? "sept.run.woken" : "sept.run.reopened", {
      "sept.queue.depth": queueDepth,
    });
    this.observability.log(waking ? "run.woken" : "run.reopened", {
      "sept.run.id": store.runId,
      "sept.run.state": "active",
      "sept.queue.depth": queueDepth,
    });
    this.launch(store);
  }
}
