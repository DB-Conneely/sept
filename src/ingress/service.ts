/**
 * Owns the authenticated HTTP listener and worker lifecycle composition. Endpoint policy is
 * delegated to RequestRouter; this class controls bind-before-adoption startup, readiness,
 * shutdown ordering, and request telemetry.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SeptError } from "../durable/index.js";
import { ModelAccessService } from "../model-access/index.js";
import type { Observability } from "../observability/index.js";
import { classifyError, NOOP_TELEMETRY } from "../observability/index.js";
import { assertCompatibleStateRoot } from "../pi-integration/index.js";
import { type HostFactory, WorkerRuntime, type WorkerRuntimeOptions } from "../runtime/index.js";
import { ConversationStreams } from "./conversation-stream.js";
import { jsonResponse, normalizeHttpMethod, routeTemplate, safePathname } from "./http.js";
import { RequestRouter } from "./request-router.js";
import { canonicalWorkspaceRoot } from "./validation.js";
import { WebhookRouter } from "./webhook-router.js";

/** Explicit listener, runtime, model-access, and observability dependencies for one worker Pod. */
export interface ServiceOptions {
  stateRoot: string;
  agentDir: string;
  token: string;
  host?: string;
  port?: number;
  hostFactory?: HostFactory;
  piVersion: string;
  workspaceRoot?: string;
  telemetry?: Observability;
  /** Installed composition checks operator policy without exposing its writer over TCP. */
  capabilityAdmission?: () => void;
  modelAccessService?: ModelAccessService;
}

/** Authenticated HTTP composition around the transport-independent single-slot runtime. */
export class SeptService {
  private readonly server;
  private readonly observability: Observability;
  private readonly worker: WorkerRuntime;
  private readonly streams = new ConversationStreams();
  private readonly workspaceRoot: string;
  private modelAccess: ModelAccessService | undefined;
  private router: RequestRouter | undefined;
  private listening = false;
  private ready = false;
  private stopPromise: Promise<void> | undefined;

  public constructor(private readonly options: ServiceOptions) {
    if (!options.token) {
      throw new SeptError(
        "SEPT_TOKEN is required; refusing to start without bearer authentication",
      );
    }
    this.observability = options.telemetry ?? NOOP_TELEMETRY;
    this.workspaceRoot = canonicalWorkspaceRoot(options.workspaceRoot ?? process.cwd());
    this.modelAccess = options.modelAccessService;
    this.worker = new WorkerRuntime(workerOptions(options, this.workspaceRoot, this.observability));
    this.server = createServer((request, response) => {
      void this.route(request, response);
    });
  }

  /** Trusted bound listener fact is available before restart adoption; task/model input cannot choose it. */
  public boundEndpoint(): { address: string; port: number } | undefined {
    const endpoint = this.server.address();
    if (endpoint === null || typeof endpoint === "string") {
      return undefined;
    }
    return { address: endpoint.address, port: endpoint.port };
  }

  /** Bind before adopting durable work, then expose readiness only after all facades exist. */
  public async start(): Promise<{ host: string; port: number }> {
    assertCompatibleStateRoot(this.options.stateRoot, this.observability);
    return this.observability.span("sept.worker.start", {}, async () => {
      const host = this.options.host ?? "127.0.0.1";
      const port = this.options.port ?? 8090;
      await this.listen(host, port);
      try {
        await this.initializeRouter();
        const adoption = this.worker.initialize();
        this.ready = true;
        const address = this.server.address();
        this.recordStarted(adoption);
        return { host, port: typeof address === "object" && address ? address.port : port };
      } catch (error) {
        try {
          await this.closeServer();
        } finally {
          await this.worker.stop();
        }
        throw error;
      }
    });
  }

  /** Stop admission, disconnect streams, close the listener, then settle runtime ownership. */
  public async stop(): Promise<void> {
    this.worker.beginStop();
    this.ready = false;
    this.stopPromise ??= this.observability.span("sept.worker.stop", {}, async () => {
      let closeError: unknown;
      this.streams.closeAll();
      try {
        await this.closeServer();
      } catch (error) {
        closeError = error;
      }
      await this.worker.stop();
      if (closeError !== undefined) {
        throw new SeptError("HTTP listener failed to close", { cause: closeError });
      }
      this.observability.setWorkerState("stopped");
      this.observability.log("worker.stopped", {
        "sept.worker.state": "stopped",
        "sept.outcome": "success",
      });
    });
    return this.stopPromise;
  }

  private async listen(host: string, port: number): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error): void => {
        reject(error);
      };
      this.server.once("error", onError);
      this.server.listen(port, host, () => {
        this.server.off("error", onError);
        resolvePromise();
      });
    });
    this.listening = true;
  }

  private async initializeRouter(): Promise<void> {
    this.modelAccess ??= await ModelAccessService.create(this.options.agentDir);
    const webhooks = new WebhookRouter(
      this.options.stateRoot,
      this.options.piVersion,
      this.workspaceRoot,
      this.worker,
      this.observability,
      this.modelAccess,
    );
    this.router = new RequestRouter({
      piVersion: this.options.piVersion,
      workspaceRoot: this.workspaceRoot,
      worker: this.worker,
      modelAccess: this.modelAccess,
      webhooks,
      streams: this.streams,
    });
  }

  private recordStarted(adoption: ReturnType<WorkerRuntime["initialize"]>): void {
    this.worker.syncObservability();
    const status = this.worker.status();
    this.observability.workerStarted(adoption);
    this.observability.setSpanFields({
      "sept.adoption": adoption,
      "sept.worker.state": status.worker,
      "sept.outcome": "success",
    });
    this.observability.log("worker.started", {
      "sept.adoption": adoption,
      "sept.worker.state": status.worker,
      "sept.run.id": status.activeRunId ?? undefined,
    });
  }

  private async closeServer(): Promise<void> {
    if (!this.listening) {
      return;
    }
    await new Promise<void>((resolvePromise, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolvePromise();
        }
      });
    });
    this.listening = false;
  }

  private authorized(request: IncomingMessage): boolean {
    const value = request.headers.authorization;
    if (typeof value !== "string") {
      return false;
    }
    const supplied = Buffer.from(value);
    const expected = Buffer.from(`Bearer ${this.options.token}`);
    // Equal-length timing-safe comparison keeps bearer validity from becoming an oracle.
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = Date.now();
    const method = normalizeHttpMethod(request.method);
    const route = routeTemplate(method, safePathname(request.url));
    await this.observability.incomingSpan(
      "sept.http.request",
      request.headers,
      { "http.request.method": method, "http.route": route },
      async () => {
        await this.routeObserved(request, response, method, route, started);
      },
    );
  }

  private async routeObserved(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    route: string,
    started: number,
  ): Promise<void> {
    try {
      await this.routeAuthenticated(request, response);
    } catch (error) {
      if (!response.headersSent) {
        jsonResponse(response, 500, { error: "internal error" });
      }
      this.recordHandlerFailure(response, method, route, error);
    } finally {
      this.recordRequest(response, method, route, Date.now() - started);
    }
  }

  private async routeAuthenticated(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    // Authentication precedes readiness and parsing so unauthorized callers learn no Pod state.
    if (!this.authorized(request)) {
      jsonResponse(response, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      return;
    }
    if (!this.ready || this.router === undefined) {
      jsonResponse(response, 503, { error: "worker is not ready" });
      return;
    }
    await this.router.handle(request, response);
  }

  private recordHandlerFailure(
    response: ServerResponse,
    method: string,
    route: string,
    error: unknown,
  ): void {
    this.observability.log(
      "http.handler.failure",
      {
        "http.request.method": method,
        "http.route": route,
        "http.response.status_code": response.statusCode,
        "error.type": classifyError(error),
      },
      "error",
    );
  }

  private recordRequest(
    response: ServerResponse,
    method: string,
    route: string,
    duration: number,
  ): void {
    const outcome = response.statusCode < 400 ? "success" : "failure";
    this.observability.setSpanFields({
      "http.response.status_code": response.statusCode,
      "sept.outcome": outcome,
      duration_ms: duration,
    });
    if (response.statusCode >= 500) {
      this.observability.markSpanError("HttpServerError");
    }
    this.observability.http(method, route, response.statusCode, duration);
    if (route !== "/health") {
      const level = responseLogLevel(response.statusCode);
      this.observability.log(
        "http.request",
        {
          "http.request.method": method,
          "http.route": route,
          "http.response.status_code": response.statusCode,
          "sept.outcome": outcome,
          duration_ms: duration,
        },
        level,
      );
    }
  }
}

function responseLogLevel(status: number): "error" | "warn" | "info" {
  if (status >= 500) {
    return "error";
  }
  return status >= 400 ? "warn" : "info";
}

function workerOptions(
  options: ServiceOptions,
  workspaceRoot: string,
  observability: Observability,
): WorkerRuntimeOptions {
  return {
    stateRoot: options.stateRoot,
    agentDir: options.agentDir,
    workspaceRoot,
    observability,
    ...(options.capabilityAdmission === undefined
      ? {}
      : { capabilityAdmission: options.capabilityAdmission }),
    ...(options.hostFactory === undefined ? {} : { hostFactory: options.hostFactory }),
  };
}
