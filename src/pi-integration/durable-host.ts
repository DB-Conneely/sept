/** Owns native conversation lifetime while SEPT's controller owns run, limit and handover authority. */

import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { watchEvents, type AgentEvent, type AgentEventStream } from "@earendil-works/pi-durable";
import { SeptError, type Manifest, type OperatorMessage, type RunStore } from "../durable/index.js";
import { NOOP_TELEMETRY, type Observability } from "../observability/index.js";
import type {
  PiSessionHostDependencies,
  SessionHost,
  SessionRunResult,
  SessionResponseValidator,
} from "./contracts.js";
import {
  createDurableConversation,
  openDurableRuntime,
  type OpenedDurableRuntime,
} from "./durable-runtime.js";
import { writeDurableLocator } from "./durable-session-files.js";

/** The sole production Pi host, backed by native Durable tasks and SQLite conversations. */
export class PiSessionHost implements SessionHost {
  private events: AgentEventStream | undefined;
  private closed = false;

  private constructor(
    private readonly manifest: Manifest,
    private readonly store: RunStore,
    private readonly native: OpenedDurableRuntime,
  ) {}

  /** Open/resume authenticated native state with repository execution trust disabled. */
  public static async create(
    manifest: Manifest,
    store: RunStore,
    agentDir: string,
    existingSessionFile?: string,
    telemetry: Observability = NOOP_TELEMETRY,
    dependencies: PiSessionHostDependencies = {},
  ): Promise<PiSessionHost> {
    const native = await openDurableRuntime(
      manifest,
      store,
      agentDir,
      existingSessionFile,
      telemetry,
      dependencies,
    );
    const host = new PiSessionHost(manifest, store, native);
    try {
      await host.bindEvents();
      return host;
    } catch (error: unknown) {
      await native.harness.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  /** Numeric native conversation identity projected to SEPT's existing string boundary only here. */
  public get sessionId(): string {
    return String(this.native.conversation.id);
  }

  /** Versioned native locator; this is never a coding-agent JSONL transcript. */
  public get sessionFile(): string {
    return this.native.sessionFile;
  }

  /** Recovered work keeps its original invocation budget and public output identity. */
  public get recoveryInvocation(): number | undefined {
    return this.native.invocation.recoveryInvocation;
  }

  /** Settle native admission only after the installed controller fsyncs its complete transition. */
  public acknowledge(result: SessionRunResult): void {
    this.native.invocation.acknowledge(result);
  }

  private async bindEvents(): Promise<void> {
    this.events = await watchEvents(
      this.native.harness,
      this.native.conversation.id,
      BACKGROUND_CONTEXT,
    );
    this.events.start((events) => {
      for (const event of events) {
        this.record(event);
      }
      return Promise.resolve();
    });
  }

  private record(event: AgentEvent): void {
    if (
      event.type === "message_update" ||
      event.type === "tool_execution_update" ||
      event.type === "snapshot"
    ) {
      return;
    }
    if (event.type === "compaction_start") {
      this.native.invocation.report(
        new SeptError("Pi attempted compaction during SEPT context cycling"),
      );
      this.store.event("pi_compaction_violation", { sessionId: this.sessionId });
    }
    // Only bounded lifecycle classifications enter operational evidence, never native payloads.
    try {
      this.store.log({ type: event.type, sessionId: this.sessionId });
    } catch (error: unknown) {
      this.native.invocation.report(error);
    }
  }

  /** Invoke/recover a native submission through the installed controller's sole engine. */
  public run(
    prompt: string,
    operatorMessages: readonly OperatorMessage[] = [],
    validate?: SessionResponseValidator,
  ): Promise<SessionRunResult> {
    return this.native.invocation.run(this.native.harness, prompt, operatorMessages, validate);
  }

  /** Commit a fresh native conversation after SEPT fsyncs the predecessor handover. */
  public async newSession(): Promise<{
    predecessorId: string;
    predecessorFile: string;
    successorId: string;
    successorFile: string;
  }> {
    const predecessorId = this.sessionId;
    const predecessorFile = this.sessionFile;
    await this.native.refreshResources();
    await this.events?.stop();
    const conversation = await createDurableConversation(this.native.harness, this.manifest);
    const successorFile = writeDurableLocator(
      join(this.store.runDir, "pi-sessions"),
      conversation.id,
      predecessorFile,
    );
    this.native.conversation = conversation;
    this.native.sessionFile = successorFile;
    this.native.invocation.bind(conversation);
    await this.bindEvents();
    return { predecessorId, predecessorFile, successorId: String(conversation.id), successorFile };
  }

  /** Durably abort and join native model/tool work before SEPT publishes cancellation settlement. */
  public abort(): Promise<void> {
    return this.native.conversation.abort(BACKGROUND_CONTEXT, { background: true });
  }

  /** Idempotently close event and Harness ownership, even if an independent observer fails. */
  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.events?.stop();
    } finally {
      await this.native.harness.close(BACKGROUND_CONTEXT);
    }
  }
}
