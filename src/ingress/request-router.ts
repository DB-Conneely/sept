/**
 * Maps authenticated HTTP requests onto model-access and single-slot runtime operations. This
 * module owns endpoint semantics only; wire parsing stays in http.ts and lifecycle/listener
 * ownership stays in service.ts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { ModelAccessService } from "../model-access/index.js";
import { WorkerRuntime } from "../runtime/index.js";
import { ConversationStreams } from "./conversation-stream.js";
import { RequestError } from "./errors.js";
import { respondWithError } from "./http-errors.js";
import {
  emptyBody,
  jsonBody,
  jsonResponse,
  noQueryExcept,
  queryInteger,
  selectionBody,
  textResponse,
} from "./http.js";
import { resolveTaskManifest, validateMessageBody } from "./validation.js";
import { WebhookRouter } from "./webhook-router.js";

interface RequestRouterOptions {
  piVersion: string;
  workspaceRoot: string;
  worker: WorkerRuntime;
  modelAccess: ModelAccessService;
  webhooks: WebhookRouter;
  streams: ConversationStreams;
}

/** Executes authenticated endpoint contracts against explicitly owned mechanism facades. */
export class RequestRouter {
  public constructor(private readonly options: RequestRouterOptions) {}

  /** Route one request and convert all expected failures into bounded public responses. */
  public async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://worker.local");
      if (await this.routeRoot(request, response, url)) {
        return;
      }
      if (await this.routeModelAccess(request, response, url)) {
        return;
      }
      if (await this.routeAdmissions(request, response, url)) {
        return;
      }
      if (await this.routeRun(request, response, url)) {
        return;
      }
      jsonResponse(response, 404, { error: "not found" });
    } catch (error) {
      respondWithError(response, error);
    }
  }

  private async routeRoot(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (request.method === "GET" && url.pathname === "/health") {
      const status = this.options.worker.status();
      jsonResponse(response, 200, {
        status: "ok",
        worker: status.worker,
        readiness: status.readiness,
        acceptingWork: status.acceptingWork,
        activeRunId: status.activeRunId,
        runtime: "pi-sdk",
      });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/v1/drain") {
      await emptyBody(request);
      jsonResponse(response, 202, this.options.worker.drain());
      return true;
    }
    return false;
  }

  private async routeModelAccess(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (!url.pathname.startsWith("/v1/model-access/")) {
      return false;
    }
    if (request.method === "GET" && url.pathname === "/v1/model-access/providers") {
      noQueryExcept(url, []);
      const catalogue = await this.options.modelAccess.catalogue(
        undefined,
        AbortSignal.timeout(15_000),
      );
      jsonResponse(response, 200, {
        providers: catalogue.providers,
        ...(catalogue.error === undefined ? {} : { error: catalogue.error }),
      });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/v1/model-access/models") {
      await this.listModels(response, url);
      return true;
    }
    if (url.pathname === "/v1/model-access/selection") {
      return this.routeSelection(request, response, url);
    }
    return false;
  }

  private async listModels(response: ServerResponse, url: URL): Promise<void> {
    noQueryExcept(url, ["provider"]);
    const providers = url.searchParams.getAll("provider");
    const provider = providers[0];
    if (providers.length > 1 || (providers.length === 1 && !provider)) {
      throw new RequestError(400, "provider must be one non-empty identifier");
    }
    const catalogue = await this.options.modelAccess.catalogue(
      provider,
      AbortSignal.timeout(15_000),
    );
    jsonResponse(response, 200, {
      models: catalogue.models,
      ...(catalogue.error === undefined ? {} : { error: catalogue.error }),
    });
  }

  private async routeSelection(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    noQueryExcept(url, []);
    if (request.method === "GET") {
      const resolved = this.options.modelAccess.resolveSelection();
      const selected = await this.options.modelAccess.preflightSelection(
        resolved.provider,
        resolved.model,
        resolved.source,
        AbortSignal.timeout(15_000),
      );
      jsonResponse(response, 200, selected);
      return true;
    }
    if (request.method === "PUT") {
      const selection = selectionBody(await jsonBody(request, 8 * 1024));
      const selected = await this.options.modelAccess.setPodDefault(
        selection.provider,
        selection.model,
        AbortSignal.timeout(15_000),
      );
      jsonResponse(response, 200, selected);
      return true;
    }
    return false;
  }

  private async routeAdmissions(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (request.method === "POST" && url.pathname === "/v1/tasks") {
      this.options.worker.assertTaskAvailable();
      const input = await jsonBody(request, 256 * 1024);
      const manifest = await resolveTaskManifest(
        input,
        this.options.piVersion,
        this.options.modelAccess,
        this.options.workspaceRoot,
      );
      jsonResponse(response, 202, this.options.worker.createTask(manifest));
      return true;
    }
    if (request.method === "POST" && url.pathname === "/v1/webhooks") {
      const input = await jsonBody(request, 256 * 1024);
      const result = await this.options.webhooks.receive(input);
      jsonResponse(response, result.status, result.body);
      return true;
    }
    return false;
  }

  private async routeRun(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const match =
      /^\/v1\/tasks\/([A-Za-z0-9_-]+)(?:\/(events|log|messages|conversation|stream|cancel))?$/.exec(
        url.pathname,
      );
    if (match === null) {
      return false;
    }
    const runId = match[1];
    if (runId === undefined) {
      return false;
    }
    const store = this.options.worker.findRun(runId);
    const resource = match[2];
    if (request.method === "GET") {
      if (!this.getRunResource(request, response, url, store, resource)) {
        jsonResponse(response, 405, { error: "method not allowed" });
      }
      return true;
    }
    if (request.method === "POST") {
      if (!(await this.postRunResource(request, response, store, resource))) {
        jsonResponse(response, 405, { error: "method not allowed" });
      }
      return true;
    }
    jsonResponse(response, 405, { error: "method not allowed" });
    return true;
  }

  private getRunResource(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    store: ReturnType<WorkerRuntime["findRun"]>,
    resource: string | undefined,
  ): boolean {
    if (resource === undefined) {
      jsonResponse(response, 200, { manifest: store.manifest(), state: store.snapshot() });
      return true;
    }
    if (resource === "events") {
      const after = queryInteger(url.searchParams, "after", 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = queryInteger(url.searchParams, "limit", 250, 1, 1000);
      const events = store.events(after, limit);
      jsonResponse(response, 200, { events, nextCursor: events.at(-1)?.seq ?? after });
      return true;
    }
    if (resource === "log") {
      textResponse(response, 200, store.logTail());
      return true;
    }
    if (resource === "conversation") {
      const after = queryInteger(url.searchParams, "after", 0, 0, Number.MAX_SAFE_INTEGER);
      this.getConversation(response, url, store, after);
      return true;
    }
    if (resource === "stream") {
      const after = queryInteger(url.searchParams, "after", 0, 0, Number.MAX_SAFE_INTEGER);
      this.options.streams.start(request, response, store, after);
      return true;
    }
    return false;
  }

  private getConversation(
    response: ServerResponse,
    url: URL,
    store: ReturnType<WorkerRuntime["findRun"]>,
    after: number,
  ): void {
    const limit = queryInteger(url.searchParams, "limit", 100, 1, 250);
    const page = store.conversation(after, limit);
    const status = store.snapshot().status;
    const terminal = isTerminal(status) ? { status } : null;
    jsonResponse(response, 200, { ...page, terminal });
  }

  private async postRunResource(
    request: IncomingMessage,
    response: ServerResponse,
    store: ReturnType<WorkerRuntime["findRun"]>,
    resource: string | undefined,
  ): Promise<boolean> {
    if (resource === "cancel") {
      await emptyBody(request);
      const result = await this.options.worker.cancel(store);
      jsonResponse(response, result.status === "cancelling" ? 202 : 200, result);
      return true;
    }
    if (resource === "messages") {
      const input = await jsonBody(request, 256 * 1024);
      const message = this.options.worker.sendMessage(store, validateMessageBody(input));
      jsonResponse(response, 202, { messageId: message.id });
      return true;
    }
    return false;
  }
}

function isTerminal(status: string): status is "cancelled" | "complete" | "blocked" | "failed" {
  return (
    status === "cancelled" || status === "complete" || status === "blocked" || status === "failed"
  );
}
