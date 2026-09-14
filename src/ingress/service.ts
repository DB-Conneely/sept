import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { QueueCapacityError, SeptError, type TaskRequest } from "../durable/index.js";
import type { Observability } from "../observability/index.js";
import { classifyError, NOOP_TELEMETRY } from "../observability/index.js";
import { type HostFactory, RunNotFoundError, WorkerConflictError, WorkerRuntime } from "../runtime/index.js";
import { RequestError } from "./errors.js";
import { canonicalWorkspaceRoot, validateMessageBody, validateRequest } from "./validation.js";
import { WebhookRouter } from "./webhook-router.js";

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
}

/** Authenticated HTTP composition around the transport-independent single-slot runtime. */
export class SeptService {
  private readonly server;
  private readonly observability: Observability;
  private readonly worker: WorkerRuntime;
  private readonly webhooks: WebhookRouter;
  private readonly workspaceRoot: string;
  private listening = false;
  private ready = false;
  private stopPromise?: Promise<void>;

  constructor(private readonly options: ServiceOptions) {
    if (!options.token) throw new SeptError("SEPT_TOKEN is required; refusing to start without bearer authentication");
    this.observability = options.telemetry ?? NOOP_TELEMETRY;
    this.workspaceRoot = canonicalWorkspaceRoot(options.workspaceRoot ?? process.cwd());
    this.worker = new WorkerRuntime({ stateRoot: options.stateRoot, agentDir: options.agentDir, workspaceRoot: this.workspaceRoot, hostFactory: options.hostFactory, observability: this.observability });
    this.webhooks = new WebhookRouter(options.stateRoot, options.piVersion, this.workspaceRoot, this.worker, this.observability);
    this.server = createServer((request, response) => void this.route(request, response));
  }

  async start(): Promise<{ host: string; port: number }> {
    return this.observability.span("sept.worker.start", {}, async () => {
      const host = this.options.host ?? "127.0.0.1";
      const port = this.options.port ?? 8090;
      await new Promise<void>((resolvePromise, reject) => {
        const onError = (error: Error): void => reject(error);
        this.server.once("error", onError);
        this.server.listen(port, host, () => { this.server.off("error", onError); resolvePromise(); });
      });
      this.listening = true;
      try {
        const adoption = this.worker.initialize();
        this.ready = true;
        const address = this.server.address();
        this.worker.syncObservability();
        const status = this.worker.status();
        this.observability.workerStarted(adoption);
        this.observability.setSpanFields({ "sept.adoption": adoption, "sept.worker.state": status.worker, "sept.outcome": "success" });
        this.observability.log("worker.started", { "sept.adoption": adoption, "sept.worker.state": status.worker, "sept.run.id": status.activeRunId ?? undefined });
        return { host, port: typeof address === "object" && address ? address.port : port };
      } catch (error) {
        try { await this.closeServer(); }
        finally { await this.worker.stop(); }
        throw error;
      }
    });
  }

  async stop(): Promise<void> {
    this.worker.beginStop();
    this.ready = false;
    this.stopPromise ??= this.observability.span("sept.worker.stop", {}, async () => {
      let closeError: unknown;
      try { await this.closeServer(); } catch (error) { closeError = error; }
      await this.worker.stop();
      if (closeError) throw closeError;
      this.observability.setWorkerState("stopped");
      this.observability.log("worker.stopped", { "sept.worker.state": "stopped", "sept.outcome": "success" });
    });
    return this.stopPromise;
  }

  private async closeServer(): Promise<void> {
    if (!this.listening) return;
    await new Promise<void>((resolvePromise, reject) => this.server.close((error) => error ? reject(error) : resolvePromise()));
    this.listening = false;
  }

  private authorized(request: IncomingMessage): boolean {
    const value = request.headers.authorization;
    if (typeof value !== "string") return false;
    const supplied = Buffer.from(value);
    const expected = Buffer.from(`Bearer ${this.options.token}`);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = Date.now();
    const method = normalizeHttpMethod(request.method);
    const pathname = safePathname(request.url);
    const route = routeTemplate(method, pathname);
    await this.observability.incomingSpan("sept.http.request", request.headers, { "http.request.method": method, "http.route": route }, async () => {
      try {
        await this.routeHandled(request, response);
      } catch (error) {
        if (!response.headersSent) json(response, 500, { error: "internal error" });
        this.observability.log("http.handler.failure", { "http.request.method": method, "http.route": route, "http.response.status_code": response.statusCode, "error.type": classifyError(error) }, "error");
      } finally {
        const duration = Date.now() - started;
        this.observability.setSpanFields({ "http.response.status_code": response.statusCode, "sept.outcome": response.statusCode < 400 ? "success" : "failure", duration_ms: duration });
        if (response.statusCode >= 500) this.observability.markSpanError("HttpServerError");
        this.observability.http(method, route, response.statusCode, duration);
        if (route !== "/health") this.observability.log("http.request", { "http.request.method": method, "http.route": route, "http.response.status_code": response.statusCode, "sept.outcome": response.statusCode < 400 ? "success" : "failure", duration_ms: duration }, response.statusCode >= 500 ? "error" : response.statusCode >= 400 ? "warn" : "info");
      }
    });
  }

  private async routeHandled(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.authorized(request)) return json(response, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      const url = new URL(request.url ?? "/", "http://worker.local");
      if (!this.ready) return json(response, 503, { error: "worker is not ready" });
      if (request.method === "GET" && url.pathname === "/health") {
        const status = this.worker.status();
        return json(response, 200, { status: "ok", worker: status.worker, activeRunId: status.activeRunId, runtime: "pi-sdk" });
      }
      if (request.method === "POST" && url.pathname === "/v1/tasks") {
        const input = await body<TaskRequest>(request, 256 * 1024);
        const result = this.worker.createTask(validateRequest(input, this.options.piVersion, this.workspaceRoot));
        return json(response, 202, result);
      }
      if (request.method === "POST" && url.pathname === "/v1/webhooks") {
        const input = await body<unknown>(request, 256 * 1024);
        const result = this.webhooks.receive(input);
        return json(response, result.status, result.body);
      }
      const match = url.pathname.match(/^\/v1\/tasks\/([A-Za-z0-9_-]+)(?:\/(events|log|messages))?$/);
      if (!match) return json(response, 404, { error: "not found" });
      let store;
      try { store = this.worker.findRun(match[1]); }
      catch (error) { if (error instanceof RunNotFoundError) return json(response, 404, { error: "unknown run" }); throw error; }
      const resource = match[2];
      if (request.method === "GET" && !resource) return json(response, 200, { manifest: store.manifest(), state: store.snapshot() });
      if (request.method === "GET" && resource === "events") {
        const after = integer(url.searchParams.get("after"), 0);
        const limit = integer(url.searchParams.get("limit"), 250);
        const events = store.events(after, limit);
        return json(response, 200, { events, nextCursor: events.at(-1)?.seq ?? after });
      }
      if (request.method === "GET" && resource === "log") return text(response, 200, store.logTail());
      if (request.method === "POST" && resource === "messages") {
        const input = await body<unknown>(request, 256 * 1024);
        const message = this.worker.sendMessage(store, validateMessageBody(input));
        return json(response, 202, { messageId: message.id });
      }
      return json(response, 405, { error: "method not allowed" });
    } catch (error) {
      const status = error instanceof RequestError ? error.status : error instanceof RunNotFoundError ? 404 : error instanceof WorkerConflictError ? 409 : error instanceof QueueCapacityError ? 429 : error instanceof SeptError || error instanceof SyntaxError ? 400 : 500;
      const message = error instanceof RequestError || error instanceof SeptError ? error.message : error instanceof SyntaxError ? "request body must be valid JSON" : "internal error";
      return json(response, status, { error: message });
    }
  }
}

function integer(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const result = Number.parseInt(value, 10);
  return Number.isFinite(result) && result >= 0 ? result : fallback;
}

async function body<T>(request: IncomingMessage, maxBytes: number): Promise<T> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new RequestError(415, "content-type must be application/json");
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) throw new RequestError(413, `request body exceeds ${Math.floor(maxBytes / 1024)} KiB`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new RequestError(413, `request body exceeds ${Math.floor(maxBytes / 1024)} KiB`);
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const payload = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), "Cache-Control": "no-store", ...headers });
  response.end(payload);
}

function text(response: ServerResponse, status: number, value: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(value), "Cache-Control": "no-store" });
  response.end(value);
}

function safePathname(value: string | undefined): string {
  try { return new URL(value ?? "/", "http://worker.local").pathname; }
  catch { return "/invalid"; }
}

function normalizeHttpMethod(value: string | undefined): string {
  const method = value?.toUpperCase();
  return method && ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "CONNECT", "TRACE"].includes(method) ? method : "OTHER";
}

function routeTemplate(method: string, pathname: string): string {
  if (method === "GET" && pathname === "/health") return "/health";
  if (method === "POST" && pathname === "/v1/tasks") return "/v1/tasks";
  if (method === "POST" && pathname === "/v1/webhooks") return "/v1/webhooks";
  const match = pathname.match(/^\/v1\/tasks\/[A-Za-z0-9_-]+(?:\/(events|log|messages))?$/);
  if (!match) return "unmatched";
  return `/v1/tasks/{runId}${match[1] ? `/${match[1]}` : ""}`;
}
