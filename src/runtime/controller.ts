/**
 * Owns one durable run controller: lease acquisition, native-session lifetime, cancellation cleanup,
 * and failure classification. Session identity and invocation transitions are delegated downward;
 * the controller guarantees host cleanup and lease release on every exit path.
 */

import { ExecutionTimeoutError, RunStore, type Manifest } from "../durable/index.js";
import type { Observability } from "../observability/index.js";
import { classifyError, NOOP_TELEMETRY } from "../observability/index.js";
import { PiSessionHost, type SessionHost } from "../pi-integration/index.js";
import { RuntimeInvocationLoop } from "./invocation-loop.js";
import {
  reconcileActiveDeadline,
  RuntimeLimitError,
  updateRuntimeSnapshot,
} from "./runtime-state.js";
import { RuntimeSessionLifecycle } from "./session-lifecycle.js";
import { RuntimeTransitions } from "./transitions.js";

/** Factory boundary for opening or resuming exactly one native Pi session. */
export type HostFactory = (
  manifest: Manifest,
  store: RunStore,
  agentDir: string,
  existingSessionFile?: string,
  telemetry?: Observability,
) => Promise<SessionHost>;

function defaultHostFactory(
  manifest: Manifest,
  store: RunStore,
  agentDir: string,
  existingSessionFile?: string,
  telemetry?: Observability,
): Promise<SessionHost> {
  return PiSessionHost.create(manifest, store, agentDir, existingSessionFile, telemetry);
}

function failureCause(
  error: unknown,
): "timeout" | "invocation_limit" | "epoch_limit" | "controller_failure" {
  if (error instanceof ExecutionTimeoutError) {
    return "timeout";
  }
  return error instanceof RuntimeLimitError ? error.cause : "controller_failure";
}

/** Coordinates one active durable run while preserving single-session and lease authority. */
export class CycleController {
  private host: SessionHost | undefined;
  private abortRequested = false;

  private readonly hostFactory: HostFactory;

  public constructor(
    private readonly store: RunStore,
    private readonly agentDir: string,
    hostFactory?: HostFactory,
    private readonly telemetry: Observability = NOOP_TELEMETRY,
    private readonly shouldStop: () => boolean = () => false,
  ) {
    this.hostFactory = hostFactory ?? defaultHostFactory;
  }

  /** Acquire run authority and execute until a durable safe boundary or terminal outcome. */
  public async run(): Promise<void> {
    return this.telemetry.span("sept.controller.run", { "sept.run.id": this.store.runId }, () =>
      this.control(),
    );
  }

  /** Mark cancellation locally before forwarding native abort to any currently owned host. */
  public async abort(): Promise<void> {
    this.abortRequested = true;
    await this.host?.abort();
  }

  private cancellationRequested(): boolean {
    const status = this.store.snapshot().status;
    return this.abortRequested || status === "cancelling" || status === "cancelled";
  }

  private async control(): Promise<void> {
    const release = await this.telemetry.span(
      "sept.controller.lease",
      { "sept.run.id": this.store.runId, "sept.outcome": "acquire" },
      () => Promise.resolve(this.store.acquireLease()),
    );
    try {
      await this.execute();
    } catch (error: unknown) {
      this.recordFailure(error);
      throw error;
    } finally {
      await this.finalize(release);
    }
  }

  private async execute(): Promise<void> {
    this.telemetry.log("controller.lease.acquired", { "sept.run.id": this.store.runId });
    const manifest = this.store.manifest();
    const snapshot = this.store.snapshot();
    if (snapshot.status !== "active") {
      return;
    }
    reconcileActiveDeadline(this.store);
    this.recordStarted(snapshot);
    const sessions = new RuntimeSessionLifecycle(
      this.store,
      this.agentDir,
      this.hostFactory,
      this.telemetry,
      () => this.cancellationRequested(),
    );
    const opened = await sessions.open(manifest);
    this.host = opened.host;
    if (!opened.runnable) {
      return;
    }
    const transitions = new RuntimeTransitions(
      this.store,
      manifest,
      this.telemetry,
      sessions,
      this.shouldStop,
    );
    const loop = new RuntimeInvocationLoop(
      this.store,
      manifest,
      this.telemetry,
      transitions,
      this.shouldStop,
      () => this.cancellationRequested(),
    );
    await loop.run(opened.host, opened.successorHandover);
  }

  private recordStarted(snapshot: ReturnType<RunStore["snapshot"]>): void {
    this.telemetry.setRunState(
      snapshot.status,
      snapshot.epoch,
      snapshot.invocations,
      this.store.pendingMessages().length,
    );
    this.telemetry.log("controller.started", {
      "sept.run.id": this.store.runId,
      "sept.run.state": snapshot.status,
      "sept.run.phase": snapshot.phase,
      "sept.epoch": snapshot.epoch,
      "sept.invocation": snapshot.invocations,
    });
  }

  private recordFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const current = this.store.snapshot();
    const terminalCause = failureCause(error);
    const limit = terminalCause !== "controller_failure";
    const recoverableHandover =
      !limit && (current.phase === "handover_durable" || current.phase === "replacing");
    if (current.status !== "active" || recoverableHandover) {
      return;
    }
    const outcome = limit ? "blocked" : "failed";
    updateRuntimeSnapshot(this.store, {
      status: outcome,
      phase: "terminal",
      reason: message,
      terminalCause,
    });
    this.store.event(outcome === "blocked" ? "run_blocked" : "run_failed", {
      reason: message,
    });
    this.store.ensureTerminalConversation();
    this.recordFailureTelemetry(error, outcome);
  }

  private recordFailureTelemetry(error: unknown, outcome: "blocked" | "failed"): void {
    this.telemetry.runOutcome(outcome);
    const snapshot = this.store.snapshot();
    this.telemetry.setRunState(
      outcome,
      snapshot.epoch,
      snapshot.invocations,
      this.store.pendingMessages().length,
    );
    this.telemetry.log(
      outcome === "blocked" ? "run.blocked" : "run.failed",
      {
        "sept.run.id": this.store.runId,
        "sept.run.state": outcome,
        "sept.epoch": snapshot.epoch,
        "sept.invocation": snapshot.invocations,
        "sept.outcome": outcome,
        "error.type": classifyError(error),
      },
      outcome === "failed" ? "error" : "warn",
    );
  }

  private async closeHost(): Promise<void> {
    const host = this.host;
    if (host === undefined) {
      return;
    }
    try {
      await this.telemetry.span("sept.pi.session.close", { "sept.run.id": this.store.runId }, () =>
        host.close(),
      );
      this.telemetry.log("pi.session.closed", {
        "sept.run.id": this.store.runId,
        "sept.outcome": "success",
      });
    } catch (error: unknown) {
      this.telemetry.log(
        "pi.session.closed",
        {
          "sept.run.id": this.store.runId,
          "sept.outcome": "failure",
          "error.type": classifyError(error),
        },
        "warn",
      );
    }
  }

  private finishCancellation(): void {
    if (this.store.snapshot().status !== "cancelling") {
      return;
    }
    const cancelled = this.store.finishCancellation();
    this.telemetry.runOutcome("cancelled");
    this.telemetry.setRunState(
      "cancelled",
      cancelled.epoch,
      cancelled.invocations,
      this.store.pendingMessages().length,
    );
    this.telemetry.log("run.cancelled", {
      "sept.run.id": this.store.runId,
      "sept.run.state": "cancelled",
      "sept.outcome": "cancelled",
    });
  }

  private releaseLease(release: () => void): void {
    this.telemetry.spanSync(
      "sept.controller.lease",
      { "sept.run.id": this.store.runId, "sept.outcome": "release" },
      release,
    );
    this.telemetry.log("controller.lease.released", { "sept.run.id": this.store.runId });
    this.telemetry.log("controller.stopped", {
      "sept.run.id": this.store.runId,
      "sept.run.state": this.store.snapshot().status,
    });
  }

  private async finalize(release: () => void): Promise<void> {
    try {
      await this.closeHost();
    } finally {
      this.host = undefined;
      try {
        this.finishCancellation();
      } finally {
        this.releaseLease(release);
      }
    }
  }
}
