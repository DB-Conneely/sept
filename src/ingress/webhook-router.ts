import type { Manifest } from "../durable/index.js";
import { listRuns, SeptError } from "../durable/index.js";
import { ModelAccessService } from "../model-access/index.js";
import type { Observability } from "../observability/index.js";
import { classifyError } from "../observability/index.js";
import { WorkerRuntime } from "../runtime/index.js";
import { RequestError } from "./errors.js";
import { resolveTaskManifest } from "./validation.js";
import {
  validateWebhookEvent,
  webhookHashes,
  WebhookReceipts,
  type WebhookEvent,
  type WebhookResult,
} from "./webhook.js";

/** Routes the provider-neutral ingress contract onto the single worker slot. */
export class WebhookRouter {
  private readonly receipts: WebhookReceipts;

  constructor(
    private readonly stateRoot: string,
    private readonly piVersion: string,
    private readonly workspaceRoot: string,
    private readonly worker: WorkerRuntime,
    private readonly observability: Observability,
    private readonly modelAccess: ModelAccessService,
  ) {
    this.receipts = new WebhookReceipts(stateRoot);
  }

  async receive(
    input: unknown,
  ): Promise<{ status: 200 | 202; body: WebhookResult & { duplicate: boolean } }> {
    return this.observability.span("sept.webhook.route", {}, async () => {
      let kind: WebhookEvent["kind"] | "unknown" = "unknown";
      try {
        const event = validateWebhookEvent(input);
        kind = event.kind;
        this.observability.setSpanFields({ "sept.webhook.kind": kind });
        const { keyHash, eventHash } = webhookHashes(event);
        let receipt = this.receipts.read(keyHash);
        let duplicate = receipt !== undefined;
        if (receipt && (receipt.eventHash !== eventHash || receipt.kind !== event.kind))
          throw new RequestError(409, "webhook event key collision");
        if (receipt?.state === "complete") return this.duplicate(receipt.result!, kind);

        const existingTask =
          event.kind === "task"
            ? listRuns(this.stateRoot).find((store) => store.runId === webhookRunId(keyHash))
            : undefined;
        if (!receipt) this.preflight(event, keyHash);
        const manifest =
          event.kind === "task" && !existingTask
            ? await resolveTaskManifest(
                event.task,
                this.piVersion,
                this.modelAccess,
                this.workspaceRoot,
              )
            : undefined;
        const claim = this.receipts.claim(keyHash, eventHash, event.kind);
        receipt = claim.receipt;
        duplicate ||= !claim.created;
        if (receipt.eventHash !== eventHash || receipt.kind !== event.kind)
          throw new RequestError(409, "webhook event key collision");
        if (receipt.state === "complete") return this.duplicate(receipt.result!, kind);

        const result = this.apply(event, keyHash, manifest);
        this.receipts.complete(receipt, result);
        const outcome = duplicate ? "duplicate" : "accepted";
        this.observability.webhook(outcome, kind);
        this.observability.setSpanFields({
          "sept.outcome": outcome,
          "sept.webhook.duplicate": duplicate,
          "sept.run.id": result.runId,
        });
        this.observability.log("webhook.routed", {
          "sept.webhook.kind": kind,
          "sept.webhook.duplicate": duplicate,
          "sept.run.id": result.runId,
          "sept.outcome": outcome,
        });
        return { status: duplicate ? 200 : 202, body: { ...result, duplicate } };
      } catch (error) {
        const collision =
          error instanceof RequestError &&
          error.status === 409 &&
          error.message === "webhook event key collision";
        const outcome = collision ? "collision" : "rejected";
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
        throw error;
      }
    });
  }

  private duplicate(
    result: WebhookResult,
    kind: WebhookEvent["kind"],
  ): { status: 200; body: WebhookResult & { duplicate: true } } {
    this.observability.webhook("duplicate", kind);
    this.observability.setSpanFields({
      "sept.outcome": "duplicate",
      "sept.webhook.duplicate": true,
    });
    this.observability.log("webhook.routed", {
      "sept.webhook.kind": kind,
      "sept.webhook.duplicate": true,
      "sept.outcome": "duplicate",
    });
    return { status: 200, body: { ...result, duplicate: true } };
  }

  private preflight(event: WebhookEvent, keyHash: string): void {
    if (event.kind === "task") {
      this.worker.assertTaskAvailable();
      const runId = webhookRunId(keyHash);
      if (listRuns(this.stateRoot).some((store) => store.runId === runId))
        throw new RequestError(409, "webhook task run already exists without a receipt");
      return;
    }
    this.worker.assertMessageAvailable(this.worker.findRun(event.runId), false);
  }

  private apply(
    event: WebhookEvent,
    keyHash: string,
    manifest?: Omit<Manifest, "runId" | "createdAt">,
  ): WebhookResult {
    if (event.kind === "task") {
      const runId = webhookRunId(keyHash);
      const existing = listRuns(this.stateRoot).find((store) => store.runId === runId);
      if (existing) return this.worker.adoptWebhookTask(existing);
      if (!manifest) throw new SeptError("Validated webhook task manifest is missing");
      return { kind: "task", ...this.worker.createTask(manifest, runId) };
    }
    const store = this.worker.findRun(event.runId);
    const message = this.worker.sendMessage(store, event.message, webhookMessageId(keyHash));
    return { kind: "operator_message", runId: store.runId, messageId: message.id };
  }
}

function webhookRunId(keyHash: string): string {
  return `webhook-${keyHash.slice(0, 40)}`;
}
function webhookMessageId(keyHash: string): string {
  return `webhook-${keyHash.slice(0, 40)}`;
}
