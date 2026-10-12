/**
 * Owns bounded server-sent conversation streams. Each stream has one cleanup owner and fixed
 * polling, heartbeat, lifetime, and backpressure limits; shutdown can synchronously revoke every
 * live stream without changing durable run state.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ConversationCursorExpiredError,
  MAX_CONVERSATION_STREAMS,
  type ConversationEvent,
} from "../durable/index.js";
import { WorkerConflictError, type WorkerRuntime } from "../runtime/index.js";

type RunStore = ReturnType<WorkerRuntime["findRun"]>;
type TerminalStatus = "cancelled" | "complete" | "blocked" | "failed";
type DisconnectReason =
  | "backpressure"
  | "cursor_expired"
  | "stream_limit"
  | "server_shutdown"
  | "terminal";
type Disconnect = (reason: DisconnectReason) => void;

/** Tracks live stream ownership for request admission and service shutdown. */
export class ConversationStreams {
  private readonly active = new Set<Disconnect>();

  /** Start one bounded stream, rejecting before headers when Pod capacity is exhausted. */
  public start(
    request: IncomingMessage,
    response: ServerResponse,
    store: RunStore,
    after: number,
  ): void {
    if (this.active.size >= MAX_CONVERSATION_STREAMS) {
      throw new WorkerConflictError("conversation stream capacity exceeded");
    }
    // Probe the cursor before committing HTTP headers so an expired cursor remains a 410 response.
    store.conversation(after, 1);
    const stream = new ConversationStream(request, response, store, after, (disconnect) => {
      this.active.add(disconnect);
      return () => {
        this.active.delete(disconnect);
      };
    });
    stream.start();
  }

  /** Disconnect all streams before the HTTP listener and runtime are stopped. */
  public closeAll(): void {
    for (const disconnect of [...this.active]) {
      disconnect("server_shutdown");
    }
  }
}

class ConversationStream {
  private cursor: number;
  private closed = false;
  private polling?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private lifetime?: NodeJS.Timeout;
  private removeOwnership?: () => void;

  public constructor(
    private readonly request: IncomingMessage,
    private readonly response: ServerResponse,
    private readonly store: RunStore,
    after: number,
    private readonly acquireOwnership: (disconnect: Disconnect) => () => void,
  ) {
    this.cursor = after;
  }

  public start(): void {
    this.response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    this.response.write("retry: 1000\n\n");
    this.removeOwnership = this.acquireOwnership(this.disconnect);
    this.response.once("close", this.cleanup);
    this.request.once("error", this.cleanup);
    this.pump();
    if (this.closed) {
      return;
    }
    this.polling = setInterval(this.pump, 100);
    this.heartbeat = setInterval(this.sendHeartbeat, 15_000);
    this.lifetime = setTimeout(() => {
      this.disconnect("stream_limit");
    }, 5 * 60_000);
    this.polling.unref();
    this.heartbeat.unref();
    this.lifetime.unref();
  }

  private readonly pump = (): void => {
    if (this.closed) {
      return;
    }
    let events: ConversationEvent[];
    try {
      events = this.store.conversation(this.cursor, 100).events;
    } catch (error) {
      if (error instanceof ConversationCursorExpiredError) {
        this.disconnect("cursor_expired", false);
        return;
      }
      this.cleanup();
      this.response.destroy();
      return;
    }
    if (!events.every((event) => this.send(event))) {
      this.disconnect("backpressure");
      return;
    }
    this.finishTerminalStream();
  };

  private send(event: ConversationEvent): boolean {
    const accepted = this.response.write(
      `id: ${String(event.cursor)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    );
    this.cursor = event.cursor;
    return accepted;
  }

  private finishTerminalStream(): void {
    const status = terminalStatus(this.store.snapshot().status);
    if (status === undefined) {
      return;
    }
    const caughtUp = this.store.conversation(this.cursor, 1).events.length === 0;
    if (caughtUp) {
      this.disconnect("terminal", false, status);
    }
  }

  private readonly sendHeartbeat = (): void => {
    if (!this.closed && !this.response.write(`: heartbeat ${String(this.cursor)}\n\n`)) {
      this.disconnect("backpressure");
    }
  };

  private readonly disconnect = (
    reason: DisconnectReason,
    retry = reason !== "cursor_expired" && reason !== "terminal",
    terminal?: TerminalStatus,
  ): void => {
    if (this.closed) {
      return;
    }
    const body = {
      reason,
      retry,
      nextCursor: this.cursor,
      ...(terminal === undefined ? {} : { terminal: { status: terminal } }),
    };
    this.response.write(`event: disconnect\ndata: ${JSON.stringify(body)}\n\n`);
    this.cleanup();
    this.response.end();
  };

  private readonly cleanup = (): void => {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.polling !== undefined) {
      clearInterval(this.polling);
    }
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
    }
    if (this.lifetime !== undefined) {
      clearTimeout(this.lifetime);
    }
    if (this.removeOwnership !== undefined) {
      this.removeOwnership();
    }
  };
}

function terminalStatus(status: string): TerminalStatus | undefined {
  if (
    status === "cancelled" ||
    status === "complete" ||
    status === "blocked" ||
    status === "failed"
  ) {
    return status;
  }
  return undefined;
}
