import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SeptError, atomicWrite } from "../durable/index.js";
import { assertUsableModelMetadata } from "./rollover.js";

const MAX_MODELS_FILE_BYTES = 1024 * 1024;
const SUPPORTED_CUSTOM_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SELECTION_FILE = "sept-model.json";

export type AuthenticationState = "configured" | "unconfigured" | "error";
export interface SafeAuthStatus {
  provider: string;
  state: AuthenticationState;
  authType?: "api_key" | "oauth";
  source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
  subscription: boolean;
  error?: string;
}

export interface SafeProvider {
  id: string;
  name: string;
  authMethods: Array<"api_key" | "oauth">;
  subscription: boolean;
  authentication: SafeAuthStatus;
  modelCount: number;
  availableModelCount: number;
}

export interface SafeModel {
  provider: string;
  id: string;
  name: string;
  available: boolean;
  api: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
}

export interface SafeCatalogue { providers: SafeProvider[]; models: SafeModel[]; configurationError?: string }
export interface ModelSelection { provider: string; model: string }

type LoginPrompt =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string; signal?: AbortSignal }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[]; signal?: AbortSignal };
type LoginEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };
export interface LoginInteraction { signal?: AbortSignal; prompt(value: LoginPrompt): Promise<string>; notify(value: LoginEvent): void }

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SeptError(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function safeId(value: unknown, name: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new SeptError(`${name} is invalid`);
  return value;
}
function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new SeptError(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}
function environmentReference(value: unknown, name: string): void {
  if (typeof value !== "string" || !/^\$(?:[A-Z_][A-Z0-9_]*|\{[A-Z_][A-Z0-9_]*\})$/.test(value)) {
    throw new SeptError(`${name} must be a single environment-variable reference; store API keys with sept auth login`);
  }
}
function safeBaseUrl(value: unknown, name: string): void {
  if (typeof value !== "string" || value.length > 2048) throw new SeptError(`${name} must be a URL`);
  let url: URL;
  try { url = new URL(value); } catch { throw new SeptError(`${name} must be a valid URL`); }
  if (url.username || url.password || url.search || url.hash) throw new SeptError(`${name} must not contain credentials, a query, or a fragment`);
  if (url.protocol === "https:") return;
  const host = url.hostname.toLowerCase();
  const local = url.protocol === "http:" && (host === "localhost" || host === "host.docker.internal" || host === "::1" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host));
  if (!local) throw new SeptError(`${name} must use HTTPS unless it targets a local or private endpoint`);
}

/** Validate the credential-blind custom-model file before Pi loads it. */
export function validateModelsConfiguration(agentDir: string): { configured: boolean; providers: number; models: number } {
  const path = join(resolve(agentDir), "models.json");
  if (!existsSync(path)) return { configured: false, providers: 0, models: 0 };
  if (statSync(path).size > MAX_MODELS_FILE_BYTES) throw new SeptError(`models.json exceeds ${MAX_MODELS_FILE_BYTES} bytes`);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new SeptError("models.json must contain valid JSON"); }
  const root = object(parsed, "models.json");
  if (Object.keys(root).some((key) => key !== "providers")) throw new SeptError("models.json has unexpected top-level fields");
  const providers = object(root.providers, "models.json providers");
  let modelCount = 0;
  for (const [providerId, rawProvider] of Object.entries(providers)) {
    safeId(providerId, "custom provider id");
    const provider = object(rawProvider, `provider ${providerId}`);
    if (provider.baseUrl !== undefined) safeBaseUrl(provider.baseUrl, `provider ${providerId} baseUrl`);
    if (provider.apiKey !== undefined) environmentReference(provider.apiKey, `provider ${providerId} apiKey`);
    if (provider.headers !== undefined) {
      const headers = object(provider.headers, `provider ${providerId} headers`);
      for (const [name, value] of Object.entries(headers)) {
        if (!/^[A-Za-z0-9-]{1,128}$/.test(name)) throw new SeptError(`provider ${providerId} header name is invalid`);
        environmentReference(value, `provider ${providerId} header ${name}`);
      }
    }
    if (provider.models === undefined) continue;
    if (!Array.isArray(provider.models) || provider.models.length < 1 || provider.models.length > 1000) throw new SeptError(`provider ${providerId} models must contain 1-1000 entries`);
    const seen = new Set<string>();
    for (const rawModel of provider.models) {
      const model = object(rawModel, `provider ${providerId} model`);
      const id = safeId(model.id, `provider ${providerId} model id`);
      if (seen.has(id)) throw new SeptError(`provider ${providerId} contains duplicate model ${id}`);
      seen.add(id);
      const api = model.api ?? provider.api;
      if (typeof api !== "string" || !SUPPORTED_CUSTOM_APIS.has(api)) throw new SeptError(`provider ${providerId} model ${id} must use a Pi-supported compatible API`);
      if (model.baseUrl !== undefined) safeBaseUrl(model.baseUrl, `provider ${providerId} model ${id} baseUrl`);
      if (model.baseUrl === undefined && provider.baseUrl === undefined) throw new SeptError(`provider ${providerId} model ${id} requires baseUrl`);
      const contextWindow = integer(model.contextWindow, `provider ${providerId} model ${id} contextWindow`, 4_096, 10_000_000);
      const maxTokens = integer(model.maxTokens, `provider ${providerId} model ${id} maxTokens`, 1, contextWindow);
      if (typeof model.reasoning !== "boolean") throw new SeptError(`provider ${providerId} model ${id} requires reasoning metadata`);
      if (!Array.isArray(model.input) || model.input.length < 1 || model.input.some((item) => item !== "text" && item !== "image")) throw new SeptError(`provider ${providerId} model ${id} requires valid input metadata`);
      if (maxTokens > contextWindow) throw new SeptError(`provider ${providerId} model ${id} maxTokens exceeds contextWindow`);
      modelCount++;
    }
  }
  return { configured: true, providers: Object.keys(providers).length, models: modelCount };
}

export async function createPodModelRuntime(agentDir: string, options: { signal?: AbortSignal; allowModelNetwork?: boolean } = {}): Promise<ModelRuntime> {
  mkdirSync(resolve(agentDir), { recursive: true, mode: 0o700 });
  validateModelsConfiguration(agentDir);
  return ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: options.allowModelNetwork ?? false,
    signal: options.signal,
  });
}

function safeFailure(error: unknown, operation: string): string {
  const message = error instanceof Error ? error.message : "";
  if (/abort/i.test(message)) return `${operation} was cancelled`;
  if (/invalid_grant|expired|refresh/i.test(message)) return `${operation} failed because the subscription credential is expired or revoked; log in again`;
  if (/timeout|timed out/i.test(message)) return `${operation} timed out`;
  if (/network|fetch|connect|ENOTFOUND|ECONN/i.test(message)) return `${operation} failed because the provider could not be reached`;
  if (/models\.json|contextWindow|maxTokens|baseUrl|provider/i.test(message)) return `${operation} failed because the Pi provider or model configuration is invalid`;
  return `${operation} failed in Pi authentication`;
}

export class PiModelAccess {
  private constructor(readonly agentDir: string, private readonly runtime: ModelRuntime) {}

  static async create(agentDir: string, options: { runtime?: ModelRuntime; signal?: AbortSignal; allowModelNetwork?: boolean } = {}): Promise<PiModelAccess> {
    const directory = resolve(agentDir);
    const runtime = options.runtime ?? await createPodModelRuntime(directory, options);
    return new PiModelAccess(directory, runtime);
  }

  async authStatus(providerId: string, validate = false, signal?: AbortSignal): Promise<SafeAuthStatus> {
    const provider = this.runtime.getProvider(providerId);
    if (!provider) return { provider: providerId, state: "error", subscription: false, error: "Pi provider was not found" };
    try {
      const check = await this.runtime.checkAuth(providerId, { signal });
      if (!check) return { provider: providerId, state: "unconfigured", subscription: false };
      if (validate && !(await this.runtime.getAuth(providerId, { signal }))) return { provider: providerId, state: "unconfigured", subscription: false };
      const status = this.runtime.getProviderAuthStatus(providerId);
      return { provider: providerId, state: "configured", authType: check.type, source: status.source, subscription: check.type === "oauth" && provider.auth.oauth?.isSubscription === true };
    } catch (error) {
      return { provider: providerId, state: "error", subscription: false, error: safeFailure(error, "Authentication check") };
    }
  }

  async catalogue(providerId?: string, signal?: AbortSignal): Promise<SafeCatalogue> {
    if (providerId && !this.runtime.getProvider(providerId)) throw new SeptError(`Pi provider not found: ${providerId}`);
    const providers = this.runtime.getProviders().filter((provider) => !providerId || provider.id === providerId);
    const available = new Set((await this.runtime.getAvailable(providerId, { signal })).map((model) => `${model.provider}\0${model.id}`));
    const auth = new Map((await Promise.all(providers.map((provider) => this.authStatus(provider.id, false, signal)))).map((status) => [status.provider, status]));
    const models = providers.flatMap((provider) => this.runtime.getModels(provider.id)).map((model): SafeModel => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      available: available.has(`${model.provider}\0${model.id}`),
      api: model.api,
      reasoning: model.reasoning,
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));
    return {
      providers: providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        authMethods: [...(provider.auth.apiKey?.login ? ["api_key" as const] : []), ...(provider.auth.oauth ? ["oauth" as const] : [])],
        subscription: provider.auth.oauth?.isSubscription === true,
        authentication: auth.get(provider.id)!,
        modelCount: models.filter((model) => model.provider === provider.id).length,
        availableModelCount: models.filter((model) => model.provider === provider.id && model.available).length,
      })),
      models,
      ...(this.runtime.getError() ? { configurationError: "Pi reported an invalid model or availability configuration" } : {}),
    };
  }

  async login(providerId: string, method: "api_key" | "oauth", interaction: LoginInteraction): Promise<SafeAuthStatus> {
    const provider = this.runtime.getProvider(providerId);
    if (!provider) throw new SeptError(`Pi provider not found: ${providerId}`);
    if (method === "api_key" && !provider.auth.apiKey?.login) throw new SeptError(`Pi provider ${providerId} does not support API-key login`);
    if (method === "oauth" && !provider.auth.oauth) throw new SeptError(`Pi provider ${providerId} does not support subscription/OAuth login`);
    try { await this.runtime.login(providerId, method, interaction as never); }
    catch (error) { throw new SeptError(safeFailure(error, "Login")); }
    return this.authStatus(providerId, false, interaction.signal);
  }

  async logout(providerId: string, signal?: AbortSignal): Promise<SafeAuthStatus> {
    if (!this.runtime.getProvider(providerId)) throw new SeptError(`Pi provider not found: ${providerId}`);
    try { await this.runtime.logout(providerId, { signal }); }
    catch (error) { throw new SeptError(safeFailure(error, "Logout")); }
    return this.authStatus(providerId, false, signal);
  }

  async select(providerId: string, modelId: string): Promise<{ selection: ModelSelection; available: boolean }> {
    const model = this.runtime.getModel(providerId, modelId);
    if (!model) throw new SeptError(`Pi model not found: ${providerId}/${modelId}`);
    assertUsableModelMetadata(model);
    const available = (await this.runtime.getAvailable(providerId)).some((entry) => entry.id === modelId);
    const selection = { provider: providerId, model: modelId };
    atomicWrite(join(this.agentDir, SELECTION_FILE), { formatVersion: 1, ...selection });
    return { selection, available };
  }

  selection(): ModelSelection | undefined { return readModelSelection(this.agentDir); }
}

export function readModelSelection(agentDir: string): ModelSelection | undefined {
  const path = join(resolve(agentDir), SELECTION_FILE);
  if (!existsSync(path)) return undefined;
  let input: Record<string, unknown>;
  try { input = object(JSON.parse(readFileSync(path, "utf8")), "model selection"); }
  catch (error) { if (error instanceof SeptError) throw error; throw new SeptError("model selection must contain valid JSON"); }
  if (Object.keys(input).sort().join() !== ["formatVersion", "model", "provider"].sort().join() || input.formatVersion !== 1) throw new SeptError("model selection has invalid fields");
  return { provider: safeId(input.provider, "selected provider"), model: safeId(input.model, "selected model") };
}
