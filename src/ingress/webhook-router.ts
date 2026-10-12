/**
 * Translates validated, provider-neutral webhooks into single-slot runtime operations. Receipt
 * claims remain outside runtime state, while the runtime remains the sole authority for task and
 * message admission.
 */

import type { Manifest } from "../durable/index.js";
import { listRuns, SeptError } from "../durable/index.js";
import { ModelAccessService } from "../model-access/index.js";
import type { Observability } from "../observability/index.js";
import { classifyError } from "../observability/index.js";
import { WorkerRuntime } from "../runtime/index.js";
import { WebhookCollisionError } from "./errors.js";
import { resolveTaskManifest } from "./validation.js";
import {
  validateWebhookEvent,
  webhookHashes,
  WebhookReceipts,
  type WebhookEvent,
  type WebhookResult,
} from "./webhook.js";

interface RouterResponse {
  status: 200 | 202;
  body: WebhookResult & { duplicate: boolean };
}

/** Routes the provider-neutral ingress contract onto the single worker slot. */
export class WebhookRouter {
  private readonly receipts: WebhookReceipts;

  public constructor(
    private readonly stateRoot: string,
    private readonly piVersion: string,
    private readonly workspaceRoot: string,
    private readonly worker: WorkerRuntime,
    private readonly observability: Observability,
    private readonly modelAccess: ModelAccessService,
  ) {
    this.receipts = new WebhookReceipts(stateRoot);
  }

  /** Validate, deduplicate, and apply one webhook without retaining its payload. */
  public async receive(input: unknown): Promise<RouterResponse> {
    return this.observability.span("sept.webhook.route", {}, async () => {
      let kind: WebhookEvent["kind"] | "unknown" = "unknown";
      try {
        const event = validateWebhookEvent(input);
        kind = event.kind;
        this.observability.setSpanFields({ "sept.webhook.kind": kind });
        return await this.routeEvent(event);
      } catch (error) {
        this.recordRejection(error, kind);
        throw error;
      }
    });
  }

  private async routeEvent(event: WebhookEvent): Promise<RouterResponse> {
    const { keyHash, eventHash } = webhookHashes(event);
    let receipt = this.receipts.read(keyHash);
    let duplicate = receipt !== undefined;
    this.assertMatchingReceipt(receipt, eventHash, event.kind);
    if (receipt?.state === "complete") {
      return this.duplicate(receipt.result, event.kind);
    }

    const manifest = await this.prepareAdmission(event, keyHash, receipt === undefined);
    const claim = this.receipts.claim(keyHash, eventHash, event.kind);
    receipt = claim.receipt;
    duplicate ||= !claim.created;
    this.assertMatchingReceipt(receipt, eventHash, event.kind);
    if (receipt.state === "complete") {
      return this.duplicate(receipt.result, event.kind);
    }

    const result = this.apply(event, keyHash, manifest);
    this.receipts.complete(receipt, result);
    return this.accepted(result, event.kind, duplicate);
  }

  private async prepareAdmission(
    event: WebhookEvent,
    keyHash: string,
    requiresPreflight: boolean,
  ): Promise<Omit<Manifest, "runId" | "createdAt"> | undefined> {
    const existingTask =
      event.kind === "task"
        ? listRuns(this.stateRoot).some((store) => store.runId === webhookRunId(keyHash))
        : false;
    if (requiresPreflight) {
      this.preflight(event, keyHash);
    }
    if (event.kind !== "task" || existingTask) {
      return undefined;
    }
    return resolveTaskManifest(event.task, this.piVersion, this.modelAccess, this.workspaceRoot);
  }

  private assertMatchingReceipt(
    receipt: ReturnType<WebhookReceipts["read"]>,
    eventHash: string,
    kind: WebhookEvent["kind"],
  ): void {
    if (receipt !== undefined && (receipt.eventHash !== eventHash || receipt.kind !== kind)) {
      throw new WebhookCollisionError();
    }
  }

  private duplicate(result: WebhookResult, kind: WebhookEvent["kind"]): RouterResponse {
    this.recordOutcome("duplicate", kind);
    return { status: 200, body: { ...result, duplicate: true } };
  }

  private accepted(
    result: WebhookResult,
    kind: WebhookEvent["kind"],
    duplicate: boolean,
  ): RouterResponse {
    const outcome = duplicate ? "duplicate" : "accepted";
    this.recordOutcome(outcome, kind, result.runId, duplicate);
    return { status: duplicate ? 200 : 202, body: { ...result, duplicate } };
  }

  private recordOutcome(
    outcome: "accepted" | "duplicate",
    kind: WebhookEvent["kind"],
    runId?: string,
    duplicate = true,
  ): void {
    this.observability.webhook(outcome, kind);
    this.observability.setSpanFields({
      "sept.outcome": outcome,
      "sept.webhook.duplicate": duplicate,
      ...(runId === undefined ? {} : { "sept.run.id": runId }),
    });
    this.observability.log("webhook.routed", {
      "sept.webhook.kind": kind,
      "sept.webhook.duplicate": duplicate,
      "sept.outcome": outcome,
      ...(runId === undefined ? {} : { "sept.run.id": runId }),
    });
  }

  private recordRejection(error: unknown, kind: WebhookEvent["kind"] | "unknown"): void {
    const outcome = error instanceof WebhookCollisionError ? "collision" : "rejected";
    this.observability.webhook(outcome, kind);
    this.observability.setSpanFields({ "sept.webhook.kind": kind, "sept.outcome": outcome });
    this.observability.log(
      "webhook.rejected",
      {
        "sept.webhook.kind": kind,
        "sept.outcome": outcome,
        "error.type": classifyError(error),
      },
      "warn",
    );
  }

  private preflight(event: WebhookEvent, keyHash: string): void {
    if (event.kind === "task") {
      this.worker.assertTaskAvailable();
      const runId = webhookRunId(keyHash);
      if (listRuns(this.stateRoot).some((store) => store.runId === runId)) {
        throw new WebhookCollisionError();
      }
      return;
    }
    this.worker.assertMessageAvailable(this.worker.findRun(event.runId), false);
  }

  private apply(
    event: WebhookEvent,
    keyHash: string,
    manifest: Omit<Manifest, "runId" | "createdAt"> | undefined,
  ): WebhookResult {
    if (event.kind === "task") {
      return this.applyTask(keyHash, manifest);
    }
    const store = this.worker.findRun(event.runId);
    const message = this.worker.sendMessage(store, event.message, webhookMessageId(keyHash));
    return { kind: "operator_message", runId: store.runId, messageId: message.id };
  }

  private applyTask(
    keyHash: string,
    manifest: Omit<Manifest, "runId" | "createdAt"> | undefined,
  ): WebhookResult {
    const runId = webhookRunId(keyHash);
    const existing = listRuns(this.stateRoot).find((store) => store.runId === runId);
    if (existing !== undefined) {
      return this.worker.adoptWebhookTask(existing);
    }
    if (manifest === undefined) {
      throw new SeptError("Validated webhook task manifest is missing");
    }
    return { kind: "task", ...this.worker.createTask(manifest, runId) };
  }
}

function webhookRunId(keyHash: string): string {
  return `webhook-${keyHash.slice(0, 40)}`;
}

function webhookMessageId(keyHash: string): string {
  return `webhook-${keyHash.slice(0, 40)}`;
}
