/**
 * Owns runtime coordination of native Pi session opening, restart adoption, and replacement. Pi owns
 * session creation; durable state owns epoch authority. Every successful replacement is persisted
 * only after `newSession()` returns, while a durable handover always precedes this module's calls.
 */

import { join } from "node:path";
import type { DurableHandover, Manifest, RunSnapshot, RunStore } from "../durable/index.js";
import type { Observability } from "../observability/index.js";
import { findSuccessorSession, type SessionHost } from "../pi-integration/index.js";
import type { HostFactory } from "./controller.js";
import { enforceEpochLimit, updateRuntimeSnapshot } from "./runtime-state.js";

/** Result of opening/reconciling one native session against durable runtime state. */
export interface OpenedRuntimeSession {
  host: SessionHost;
  successorHandover: DurableHandover | undefined;
  runnable: boolean;
}

/** Coordinates native session identity with durable epoch and predecessor evidence. */
export class RuntimeSessionLifecycle {
  public constructor(
    private readonly store: RunStore,
    private readonly agentDir: string,
    private readonly hostFactory: HostFactory,
    private readonly telemetry: Observability,
    private readonly cancellationRequested: () => boolean,
  ) {}

  /** Open and reconcile the session selected by current durable state. */
  public async open(manifest: Manifest): Promise<OpenedRuntimeSession> {
    const snapshot = this.store.snapshot();
    const recovering = snapshot.phase === "handover_durable" || snapshot.phase === "replacing";
    const successorHandover = recovering ? this.store.latestHandover() : undefined;
    const existing = this.existingSession(snapshot, recovering);
    const host = await this.telemetry.span(
      "sept.pi.session.open",
      {
        "sept.run.id": this.store.runId,
        "sept.epoch": snapshot.epoch,
        "sept.adoption": existing === undefined ? "new" : "existing",
      },
      () => this.hostFactory(manifest, this.store, this.agentDir, existing, this.telemetry),
    );
    if (this.cancellationRequested()) {
      await host.abort();
      return { host, successorHandover, runnable: false };
    }
    const runnable = await this.reconcile(host, manifest, snapshot, recovering);
    return { host, successorHandover, runnable };
  }

  private existingSession(snapshot: RunSnapshot, recovering: boolean): string | undefined {
    if (!recovering || snapshot.predecessorSessionFile === undefined) {
      return snapshot.activeSessionFile;
    }
    return (
      findSuccessorSession(
        join(this.store.runDir, "pi-sessions"),
        snapshot.predecessorSessionFile,
      ) ?? snapshot.predecessorSessionFile
    );
  }

  private async reconcile(
    host: SessionHost,
    manifest: Manifest,
    snapshot: RunSnapshot,
    recovering: boolean,
  ): Promise<boolean> {
    if (recovering && host.sessionId === snapshot.predecessorSessionId) {
      return this.replace(host, manifest, snapshot);
    }
    if (recovering) {
      this.adoptSuccessor(host, snapshot);
      return true;
    }
    this.recordOpened(host, snapshot);
    return true;
  }

  /** Replace one predecessor through native Pi and durably publish the successor identity. */
  public async replace(
    host: SessionHost,
    manifest: Manifest,
    snapshot: RunSnapshot,
  ): Promise<boolean> {
    enforceEpochLimit(manifest, snapshot);
    updateRuntimeSnapshot(this.store, { phase: "replacing" });
    const replacement = await this.telemetry.span(
      "sept.pi.session.rotate",
      { "sept.run.id": this.store.runId, "sept.epoch": snapshot.epoch },
      () => host.newSession(),
    );
    if (this.cancellationRequested()) {
      return false;
    }
    updateRuntimeSnapshot(this.store, {
      phase: "running",
      epoch: snapshot.epoch + 1,
      activeSessionId: replacement.successorId,
      activeSessionFile: replacement.successorFile,
    });
    this.store.event("successor_session_started", replacement);
    this.telemetry.sessionOpened("replaced");
    this.telemetry.event("sept.pi.session.replaced", { "sept.epoch": snapshot.epoch + 1 });
    this.logSession("pi.session.replaced", snapshot.epoch + 1);
    return true;
  }

  private adoptSuccessor(host: SessionHost, snapshot: RunSnapshot): void {
    updateRuntimeSnapshot(this.store, {
      phase: "running",
      epoch: snapshot.epoch + 1,
      activeSessionId: host.sessionId,
      activeSessionFile: host.sessionFile,
    });
    this.store.event("successor_session_adopted", {
      predecessorSessionId: snapshot.predecessorSessionId,
      successorSessionId: host.sessionId,
      successorSessionFile: host.sessionFile,
    });
    this.telemetry.sessionOpened("successor_adopted");
    this.logSession("pi.session.successor_adopted", snapshot.epoch + 1);
  }

  private recordOpened(host: SessionHost, snapshot: RunSnapshot): void {
    updateRuntimeSnapshot(this.store, {
      phase: "running",
      activeSessionId: host.sessionId,
      activeSessionFile: host.sessionFile,
    });
    const started = snapshot.activeSessionId === undefined;
    this.store.event(started ? "pi_session_started" : "pi_session_resumed", {
      epoch: snapshot.epoch,
      sessionId: host.sessionId,
      sessionFile: host.sessionFile,
    });
    this.telemetry.sessionOpened(started ? "started" : "resumed");
    this.logSession(started ? "pi.session.started" : "pi.session.resumed", snapshot.epoch);
  }

  private logSession(name: string, epoch: number): void {
    this.telemetry.log(name, {
      "sept.run.id": this.store.runId,
      "sept.epoch": epoch,
      "sept.outcome": "success",
    });
  }
}
