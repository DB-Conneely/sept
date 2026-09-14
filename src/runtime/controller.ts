import { join } from "node:path";
import { RunStore, SeptError, parseJsonObject, validateHandover, validateWork, type Manifest, type WorkControl } from "../durable/index.js";
import type { Observability } from "../observability/index.js";
import { classifyError, NOOP_TELEMETRY } from "../observability/index.js";
import { continuationPrompt, findSuccessorSession, initialPrompt, PiSessionHost, successorPrompt, type SessionHost } from "../pi-integration/index.js";

export type HostFactory = (manifest: Manifest, store: RunStore, agentDir: string, existingSessionFile?: string, telemetry?: Observability) => Promise<SessionHost>;

export class CycleController {
  constructor(
    private readonly store: RunStore,
    private readonly agentDir: string,
    private readonly hostFactory: HostFactory = PiSessionHost.create,
    private readonly telemetry: Observability = NOOP_TELEMETRY,
    private readonly shouldStop: () => boolean = () => false,
  ) {}

  async run(): Promise<void> {
    return this.telemetry.span("sept.controller.run", { "sept.run.id": this.store.runId }, async () => this.control());
  }

  private async control(): Promise<void> {
    const release = await this.telemetry.span("sept.controller.lease", { "sept.run.id": this.store.runId, "sept.outcome": "acquire" }, async () => this.store.acquireLease());
    let host: SessionHost | undefined;
    try {
      this.telemetry.log("controller.lease.acquired", { "sept.run.id": this.store.runId });
      const manifest = this.store.manifest();
      let snapshot = this.store.snapshot();
      if (snapshot.status !== "active") return;
      this.telemetry.setRunState(snapshot.status, snapshot.epoch, snapshot.invocations, this.store.pendingMessages().length);
      this.telemetry.log("controller.started", { "sept.run.id": this.store.runId, "sept.run.state": snapshot.status, "sept.run.phase": snapshot.phase, "sept.epoch": snapshot.epoch, "sept.invocation": snapshot.invocations });

      let existing = snapshot.activeSessionFile;
      let successorHandover = undefined;
      if ((snapshot.phase === "handover_durable" || snapshot.phase === "replacing") && snapshot.predecessorSessionFile) {
        successorHandover = this.store.latestHandover();
        existing = findSuccessorSession(join(this.store.runDir, "pi-sessions"), snapshot.predecessorSessionFile) ?? snapshot.predecessorSessionFile;
      }
      host = await this.telemetry.span("sept.pi.session.open", {
        "sept.run.id": this.store.runId,
        "sept.epoch": snapshot.epoch,
        "sept.adoption": existing ? "existing" : "new",
      }, async () => this.hostFactory(manifest, this.store, this.agentDir, existing, this.telemetry));

      if ((snapshot.phase === "handover_durable" || snapshot.phase === "replacing") && host.sessionId === snapshot.predecessorSessionId) {
        this.enforceEpochCap(manifest, snapshot);
        this.store.update({ phase: "replacing" });
        const replacement = await this.telemetry.span("sept.pi.session.rotate", { "sept.run.id": this.store.runId, "sept.epoch": snapshot.epoch }, async () => host!.newSession());
        this.store.update({ phase: "running", epoch: snapshot.epoch + 1, activeSessionId: replacement.successorId, activeSessionFile: replacement.successorFile });
        this.store.event("successor_session_started", replacement);
        this.telemetry.sessionOpened("replaced");
        this.telemetry.event("sept.pi.session.replaced", { "sept.epoch": snapshot.epoch + 1 });
        this.telemetry.log("pi.session.replaced", { "sept.run.id": this.store.runId, "sept.epoch": snapshot.epoch + 1, "sept.outcome": "success" });
      } else if (snapshot.phase === "handover_durable" || snapshot.phase === "replacing") {
        this.store.update({ phase: "running", epoch: snapshot.epoch + 1, activeSessionId: host.sessionId, activeSessionFile: host.sessionFile });
        this.store.event("successor_session_adopted", { predecessorSessionId: snapshot.predecessorSessionId, successorSessionId: host.sessionId, successorSessionFile: host.sessionFile });
        this.telemetry.sessionOpened("successor_adopted");
        this.telemetry.log("pi.session.successor_adopted", { "sept.run.id": this.store.runId, "sept.epoch": snapshot.epoch + 1, "sept.outcome": "success" });
      } else {
        this.store.update({ phase: "running", activeSessionId: host.sessionId, activeSessionFile: host.sessionFile });
        if (!snapshot.activeSessionId) {
          this.store.event("pi_session_started", { epoch: snapshot.epoch, sessionId: host.sessionId, sessionFile: host.sessionFile });
          this.telemetry.sessionOpened("started");
          this.telemetry.log("pi.session.started", { "sept.run.id": this.store.runId, "sept.epoch": snapshot.epoch, "sept.outcome": "success" });
        } else {
          this.store.event("pi_session_resumed", { epoch: snapshot.epoch, sessionId: host.sessionId, sessionFile: host.sessionFile });
          this.telemetry.sessionOpened("resumed");
          this.telemetry.log("pi.session.resumed", { "sept.run.id": this.store.runId, "sept.epoch": snapshot.epoch, "sept.outcome": "success" });
        }
      }

      let control: WorkControl | undefined;
      let first = true;
      while (this.store.snapshot().status === "active") {
        if (this.shouldStop()) return;
        snapshot = this.store.snapshot();
        this.enforceLimits(manifest, snapshot);
        const messages = this.store.pendingMessages();
        this.telemetry.setRunState(snapshot.status, snapshot.epoch, snapshot.invocations, messages.length);
        this.store.deliveryAttempt(messages, host.sessionId);
        if (messages.length) this.telemetry.event("sept.operator.delivery", { "sept.queue.depth": messages.length, "sept.epoch": snapshot.epoch, "sept.invocation": snapshot.invocations + 1 });
        let prompt: string;
        if (successorHandover) {
          prompt = successorPrompt(manifest, successorHandover, messages);
          successorHandover = undefined;
        } else if (control) {
          prompt = continuationPrompt(control, messages);
        } else {
          prompt = initialPrompt(manifest, first && snapshot.invocations > 0 ? this.store.recoveryContext() : undefined);
          if (messages.length) prompt += `\n\n${JSON.stringify({ operatorMessages: messages }, null, 2)}`;
        }
        first = false;
        const invocation = snapshot.invocations + 1;
        this.store.update({ invocations: invocation, activeSessionId: host.sessionId, activeSessionFile: host.sessionFile });
        this.store.event("pi_invocation_started", { invocation, epoch: snapshot.epoch, sessionId: host.sessionId, messageIds: messages.map((message) => message.id) });
        this.telemetry.setRunState("active", snapshot.epoch, invocation, messages.length);
        this.telemetry.log("pi.invocation.started", { "sept.run.id": this.store.runId, "sept.epoch": snapshot.epoch, "sept.invocation": invocation, "sept.queue.depth": messages.length });
        const invocationStarted = Date.now();
        let result;
        try {
          result = await this.telemetry.span("sept.pi.invoke", {
            "sept.run.id": this.store.runId,
            "sept.epoch": snapshot.epoch,
            "sept.invocation": invocation,
            "sept.queue.depth": messages.length,
          }, async () => {
            const invocationResult = await this.runWithDeadline(host!, prompt, manifest);
            this.telemetry.contextSample(invocationResult.contextTokens, invocationResult.contextWindow, snapshot.epoch, invocation);
            this.telemetry.setSpanFields({ "sept.rotation": invocationResult.steered, "sept.outcome": "success" });
            return invocationResult;
          });
          const duration = Date.now() - invocationStarted;
          this.telemetry.invocationFinished(duration, "success", result.steered);
          this.telemetry.log("pi.invocation.finished", { "sept.run.id": this.store.runId, "sept.epoch": snapshot.epoch, "sept.invocation": invocation, "sept.outcome": "success", "sept.rotation": result.steered, "sept.queue.depth": messages.length, duration_ms: duration });
        } catch (error) {
          const duration = Date.now() - invocationStarted;
          const timeout = error instanceof LimitError && error.cause === "timeout";
          this.telemetry.invocationFinished(duration, timeout ? "timeout" : "failure");
          this.telemetry.log("pi.invocation.finished", { "sept.run.id": this.store.runId, "sept.epoch": snapshot.epoch, "sept.invocation": invocation, "sept.outcome": timeout ? "timeout" : "failure", "error.type": classifyError(error), duration_ms: duration }, "error");
          throw error;
        }
        this.store.log({ type: "assistant_terminal", sessionId: host.sessionId, steered: result.steered, textBytes: Math.min(Buffer.byteLength(result.text), 64_001) });
        if (result.steered) {
          this.telemetry.event("sept.rotation.requested", { "sept.epoch": snapshot.epoch, "sept.invocation": invocation });
          this.telemetry.log("pi.rotation.requested", { "sept.run.id": this.store.runId, "sept.epoch": snapshot.epoch, "sept.invocation": invocation });
          const handover = validateHandover(parseJsonObject(result.text));
          const predecessorId = host.sessionId;
          const predecessorFile = host.sessionFile;
          const durable = this.store.persistHandover(snapshot.epoch, predecessorId, predecessorFile, handover, messages);
          this.telemetry.setQueueDepth(this.store.pendingMessages().length);
          this.telemetry.event("sept.handover.durable", { "sept.epoch": snapshot.epoch, "sept.queue.depth": messages.length });
          this.telemetry.log("handover.durable", { "sept.run.id": this.store.runId, "sept.epoch": snapshot.epoch, "sept.invocation": invocation, "sept.queue.depth": messages.length });
          this.enforceEpochCap(manifest, this.store.snapshot());
          if (this.shouldStop()) return;
          this.store.update({ phase: "replacing" });
          const replacement = await this.telemetry.span("sept.pi.session.rotate", { "sept.run.id": this.store.runId, "sept.epoch": snapshot.epoch }, async () => host!.newSession());
          this.store.update({ phase: "running", epoch: snapshot.epoch + 1, activeSessionId: replacement.successorId, activeSessionFile: replacement.successorFile });
          this.store.event("successor_session_started", replacement);
          this.telemetry.sessionOpened("replaced");
          this.telemetry.log("pi.session.replaced", { "sept.run.id": this.store.runId, "sept.epoch": snapshot.epoch + 1, "sept.outcome": "success" });
          successorHandover = durable;
          control = undefined;
          continue;
        }
        control = validateWork(parseJsonObject(result.text));
        this.store.checkpoint(control, messages, host.sessionId);
        this.telemetry.setQueueDepth(this.store.pendingMessages().length);
        this.telemetry.event("sept.checkpoint.durable", { "sept.outcome": control.status, "sept.epoch": snapshot.epoch, "sept.invocation": invocation, "sept.queue.depth": messages.length });
        this.telemetry.log("checkpoint.durable", { "sept.run.id": this.store.runId, "sept.run.state": control.status, "sept.epoch": snapshot.epoch, "sept.invocation": invocation, "sept.queue.depth": messages.length });
        if (control.status === "complete" || control.status === "blocked" || control.status === "waiting") {
          const lateMessages = this.store.pendingMessages();
          this.telemetry.setQueueDepth(lateMessages.length);
          if (lateMessages.length) {
            const attemptedStatus = control.status;
            this.store.event(attemptedStatus === "waiting" ? "waiting_status_deferred" : "terminal_status_deferred", { attemptedStatus, messageIds: lateMessages.map((message) => message.id) });
            this.telemetry.event("sept.transition.deferred", { "sept.outcome": attemptedStatus, "sept.queue.depth": lateMessages.length });
            this.telemetry.log("run.transition.deferred", { "sept.run.id": this.store.runId, "sept.run.state": attemptedStatus, "sept.queue.depth": lateMessages.length });
            control = {
              status: "continue",
              summary: `${attemptedStatus} status was deferred because operator input arrived during the invocation.`,
              verification: control.verification,
              next_action: "Apply the newly accepted operator messages before deciding the next lifecycle state.",
            };
            if (this.shouldStop()) return;
            continue;
          }
        }
        if (control.status === "complete") {
          this.store.update({ status: "complete", phase: "terminal", reason: control.summary, terminalCause: undefined });
          this.store.event("run_completed", { summary: control.summary, verification: control.verification });
          this.telemetry.runOutcome("complete");
          this.telemetry.setRunState("complete", snapshot.epoch, invocation, 0);
          this.telemetry.log("run.completed", { "sept.run.id": this.store.runId, "sept.run.state": "complete", "sept.epoch": snapshot.epoch, "sept.invocation": invocation, "sept.outcome": "complete" });
        } else if (control.status === "blocked") {
          this.store.update({ status: "blocked", phase: "terminal", reason: control.summary, terminalCause: "agent_blocked" });
          this.store.event("run_blocked", { summary: control.summary, nextAction: control.next_action });
          this.telemetry.runOutcome("blocked");
          this.telemetry.setRunState("blocked", snapshot.epoch, invocation, 0);
          this.telemetry.log("run.blocked", { "sept.run.id": this.store.runId, "sept.run.state": "blocked", "sept.epoch": snapshot.epoch, "sept.invocation": invocation, "sept.outcome": "blocked" });
        } else if (control.status === "waiting") {
          this.store.update({ status: "waiting", phase: "waiting", reason: control.summary, terminalCause: undefined });
          this.store.event("run_waiting", { summary: control.summary, nextAction: control.next_action, sessionId: host.sessionId, sessionFile: host.sessionFile });
          this.telemetry.setRunState("waiting", snapshot.epoch, invocation, 0);
          this.telemetry.log("run.waiting", { "sept.run.id": this.store.runId, "sept.run.state": "waiting", "sept.epoch": snapshot.epoch, "sept.invocation": invocation, "sept.outcome": "waiting" });
        } else if (this.shouldStop()) {
          return;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.store.snapshot();
      const recoverableHandover = !(error instanceof LimitError) && (current.phase === "handover_durable" || current.phase === "replacing");
      if (current.status === "active" && !recoverableHandover) {
        const outcome = error instanceof LimitError ? "blocked" : "failed";
        const terminalCause = error instanceof LimitError ? error.cause : "controller_failure";
        this.store.update({ status: outcome, phase: "terminal", reason: message, terminalCause });
        this.store.event(outcome === "blocked" ? "run_blocked" : "run_failed", { reason: message });
        this.telemetry.runOutcome(outcome);
        const snapshot = this.store.snapshot();
        this.telemetry.setRunState(outcome, snapshot.epoch, snapshot.invocations, this.store.pendingMessages().length);
        this.telemetry.log(outcome === "blocked" ? "run.blocked" : "run.failed", { "sept.run.id": this.store.runId, "sept.run.state": outcome, "sept.epoch": snapshot.epoch, "sept.invocation": snapshot.invocations, "sept.outcome": outcome, "error.type": classifyError(error) }, outcome === "failed" ? "error" : "warn");
      }
      throw error;
    } finally {
      if (host) {
        await this.telemetry.span("sept.pi.session.close", { "sept.run.id": this.store.runId }, async () => host!.close())
          .then(() => this.telemetry.log("pi.session.closed", { "sept.run.id": this.store.runId, "sept.outcome": "success" }))
          .catch((error) => this.telemetry.log("pi.session.closed", { "sept.run.id": this.store.runId, "sept.outcome": "failure", "error.type": classifyError(error) }, "warn"));
      }
      this.telemetry.spanSync("sept.controller.lease", { "sept.run.id": this.store.runId, "sept.outcome": "release" }, release);
      this.telemetry.log("controller.lease.released", { "sept.run.id": this.store.runId });
      this.telemetry.log("controller.stopped", { "sept.run.id": this.store.runId, "sept.run.state": this.store.snapshot().status });
    }
  }

  private enforceEpochCap(manifest: Manifest, snapshot: ReturnType<RunStore["snapshot"]>): void {
    if (snapshot.epoch >= manifest.maxEpochs) throw new LimitError("epoch_limit", `Maximum Pi session epochs reached (${manifest.maxEpochs})`);
  }

  private enforceLimits(manifest: Manifest, snapshot: ReturnType<RunStore["snapshot"]>): void {
    if (snapshot.invocations >= manifest.maxInvocations) throw new LimitError("invocation_limit", `Maximum Pi invocations reached (${manifest.maxInvocations})`);
    if ((snapshot.activeMilliseconds ?? 0) >= manifest.timeoutSeconds * 1000) throw new LimitError("timeout", `Active execution timeout reached (${manifest.timeoutSeconds}s)`);
  }

  private async runWithDeadline(host: SessionHost, prompt: string, manifest: Manifest) {
    const remaining = Math.max(1, manifest.timeoutSeconds * 1000 - (this.store.snapshot().activeMilliseconds ?? 0));
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        host.run(prompt, manifest.thresholdPercent, manifest.handoverReserveTokens),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new LimitError("timeout", `Active execution timeout reached (${manifest.timeoutSeconds}s)`)), remaining); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      const snapshot = this.store.snapshot();
      this.store.update({ activeMilliseconds: (snapshot.activeMilliseconds ?? 0) + Math.max(0, Date.now() - started) });
    }
  }
}

class LimitError extends SeptError {
  constructor(readonly cause: "invocation_limit" | "epoch_limit" | "timeout", message: string) { super(message); }
}
