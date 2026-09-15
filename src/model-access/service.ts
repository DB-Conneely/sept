import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SeptError } from "../durable/index.js";
import {
  assertModelMetadata,
  builtInDefault,
  readPodDefault,
  safeModelIdentifier,
  validateCustomConfiguration as validateConfigurationFile,
  writePodDefault,
} from "./configuration.js";
import type {
  AuthenticationMethod,
  AuthenticationStatus,
  CustomConfigurationStatus,
  LoginInteraction,
  ModelCatalogue,
  ModelDescription,
  ModelSelection,
  PreflightedModelSelection,
  ProviderDescription,
  ResolvedModelSelection,
} from "./contracts.js";

export interface ModelAccessCreateOptions {
  runtime?: ModelRuntime;
  signal?: AbortSignal;
  allowModelNetwork?: boolean;
}

function boundedFailure(error: unknown, operation: string): string {
  const message = error instanceof Error ? error.message : "";
  if (/abort|cancel/i.test(message)) return `${operation} was cancelled`;
  if (/invalid_grant|expired|revoked|refresh/i.test(message)) return `${operation} failed because the subscription credential is expired or revoked; log in again`;
  if (/timeout|timed out/i.test(message)) return `${operation} timed out`;
  if (/network|fetch|connect|ENOTFOUND|ECONN/i.test(message)) return `${operation} failed because the provider could not be reached`;
  if (/models\.json|contextWindow|maxTokens|baseUrl|configuration/i.test(message)) return `${operation} failed because the Pi model configuration is invalid`;
  return `${operation} failed in Pi model access`;
}

function methodsFor(runtime: ModelRuntime, providerId: string): AuthenticationMethod[] {
  const provider = runtime.getProvider(providerId);
  if (!provider) return [];
  return [
    ...(provider.auth.oauth ? [provider.auth.oauth.isSubscription === true ? "subscription" as const : "oauth" as const] : []),
    ...(provider.auth.apiKey?.login ? ["api_key" as const] : []),
  ];
}

function providerAuthentication(status: AuthenticationStatus): ProviderDescription["authentication"] {
  return {
    state: status.state,
    ...(status.method ? { method: status.method } : {}),
    methods: status.methods,
    ...(status.error ? { error: status.error } : {}),
  };
}

function normalizeModel(model: ReturnType<ModelRuntime["getModels"]>[number], available: boolean): ModelDescription {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    available,
    api: model.api,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    capabilities: { reasoning: model.reasoning, input: [...model.input] },
  };
}

export async function createPodModelRuntime(agentDir: string, options: Omit<ModelAccessCreateOptions, "runtime"> = {}): Promise<ModelRuntime> {
  const directory = resolve(agentDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  validateConfigurationFile(directory);
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    modelsStorePath: join(directory, "models-store.json"),
    allowModelNetwork: options.allowModelNetwork ?? false,
    signal: options.signal,
  });
  if (runtime.getError()) throw new SeptError("Pi rejected the configured provider or model metadata; run sept models validate");
  return runtime;
}

/** Thin, credential-blind facade over Pi's installed ModelRuntime. */
export class ModelAccessService {
  private constructor(readonly agentDir: string, private readonly runtime: ModelRuntime) {}

  static async create(agentDir: string, options: ModelAccessCreateOptions = {}): Promise<ModelAccessService> {
    const directory = resolve(agentDir);
    const runtime = options.runtime ?? await createPodModelRuntime(directory, options);
    return new ModelAccessService(directory, runtime);
  }

  async catalogue(providerId?: string, signal?: AbortSignal): Promise<ModelCatalogue> {
    if (providerId !== undefined) safeModelIdentifier(providerId, "provider");
    if (providerId && !this.runtime.getProvider(providerId)) throw new SeptError(`Pi provider not found: ${providerId}`);
    const providers = this.runtime.getProviders().filter((provider) => !providerId || provider.id === providerId);
    const authStatuses = await Promise.all(providers.map((provider) => this.authenticationStatus(provider.id, signal)));
    const availableKeys = new Set<string>();
    let availabilityFailed = false;
    for (const provider of providers) {
      try {
        for (const model of await this.runtime.getAvailable(provider.id, { signal })) availableKeys.add(`${model.provider}\0${model.id}`);
      } catch { availabilityFailed = true; }
    }
    const models = providers.flatMap((provider) => this.runtime.getModels(provider.id))
      .map((model) => normalizeModel(model, availableKeys.has(`${model.provider}\0${model.id}`)));
    return {
      providers: providers.map((provider, index) => ({
        id: provider.id,
        name: provider.name,
        authentication: providerAuthentication(authStatuses[index]),
        modelCount: models.filter((model) => model.provider === provider.id).length,
        availableModelCount: models.filter((model) => model.provider === provider.id && model.available).length,
      })),
      models,
      ...((availabilityFailed || this.runtime.getError()) ? { error: "One or more Pi provider availability checks failed; validate authentication and models.json" } : {}),
    };
  }

  async authenticationStatus(providerId: string, signal?: AbortSignal): Promise<AuthenticationStatus> {
    safeModelIdentifier(providerId, "provider");
    const provider = this.runtime.getProvider(providerId);
    if (!provider) throw new SeptError(`Pi provider not found: ${providerId}`);
    const methods = methodsFor(this.runtime, providerId);
    try {
      const check = await this.runtime.checkAuth(providerId, { signal });
      if (!check) return { provider: providerId, state: "authentication_required", methods };
      // Pi's ApiKeyAuth contract permits both keyless and ambient-only providers to omit
      // login. A source-free successful check is Pi's credential-blind keyless signal;
      // any reported source is authentication evidence but is never projected by SEPT.
      if (methods.length === 0 && check.type === "api_key" && check.source === undefined) {
        return { provider: providerId, state: "not_required", methods };
      }
      const method = check.type === "oauth" ? (provider.auth.oauth?.isSubscription === true ? "subscription" : "oauth") : "api_key";
      return { provider: providerId, state: "authenticated", method, methods };
    } catch (error) {
      return { provider: providerId, state: "error", methods, error: boundedFailure(error, "Authentication check") };
    }
  }

  async login(providerId: string, method: AuthenticationMethod, interaction: LoginInteraction): Promise<AuthenticationStatus> {
    safeModelIdentifier(providerId, "provider");
    const provider = this.runtime.getProvider(providerId);
    if (!provider) throw new SeptError(`Pi provider not found: ${providerId}`);
    if (method === "api_key" && !provider.auth.apiKey?.login) throw new SeptError(`Pi provider ${providerId} does not support API-key login`);
    if ((method === "subscription" || method === "oauth") && !provider.auth.oauth) throw new SeptError(`Pi provider ${providerId} does not support subscription/OAuth login`);
    if (method === "subscription" && provider.auth.oauth?.isSubscription !== true) throw new SeptError(`Pi provider ${providerId} does not expose subscription login`);
    try { await this.runtime.login(providerId, method === "api_key" ? "api_key" : "oauth", interaction); }
    catch (error) { throw new SeptError(boundedFailure(error, "Login")); }
    return this.authenticationStatus(providerId, interaction.signal);
  }

  async logout(providerId: string, signal?: AbortSignal): Promise<AuthenticationStatus> {
    safeModelIdentifier(providerId, "provider");
    if (!this.runtime.getProvider(providerId)) throw new SeptError(`Pi provider not found: ${providerId}`);
    try { await this.runtime.logout(providerId, { signal }); }
    catch (error) { throw new SeptError(boundedFailure(error, "Logout")); }
    return this.authenticationStatus(providerId, signal);
  }

  getPodDefault(): ModelSelection | undefined {
    return readPodDefault(this.agentDir);
  }

  async setPodDefault(provider: string, model: string, signal?: AbortSignal): Promise<PreflightedModelSelection> {
    const selected = await this.preflightSelection(provider, model, "explicit", signal);
    writePodDefault(this.agentDir, selected.selected);
    return { ...selected, selected: { ...selected.selected, source: "pod_default" } };
  }

  resolveSelection(explicitSelection?: ModelSelection): ResolvedModelSelection {
    if (explicitSelection) {
      return {
        provider: safeModelIdentifier(explicitSelection.provider, "provider"),
        model: safeModelIdentifier(explicitSelection.model, "model"),
        source: "explicit",
      };
    }
    const configured = this.getPodDefault();
    if (configured) return { ...configured, source: "pod_default" };
    return { ...builtInDefault(), source: "built_in_default" };
  }

  async preflightSelection(provider: string, modelId: string, source: ResolvedModelSelection["source"] = "explicit", signal?: AbortSignal): Promise<PreflightedModelSelection> {
    safeModelIdentifier(provider, "provider");
    safeModelIdentifier(modelId, "model");
    if (!this.runtime.getProvider(provider)) throw new SeptError(`Pi provider not found: ${provider}`);
    const model = this.runtime.getModel(provider, modelId);
    if (!model) throw new SeptError(`Pi model not found: ${provider}/${modelId}`);
    assertModelMetadata(model);
    let available;
    try { available = (await this.runtime.getAvailable(provider, { signal })).some((candidate) => candidate.id === modelId); }
    catch (error) { throw new SeptError(boundedFailure(error, "Model availability check")); }
    if (!available) throw new SeptError(`Pi model ${provider}/${modelId} is unavailable because provider authentication or provider model access is not configured`);
    try {
      if (!(await this.runtime.getAuth(model, { signal }))) throw new SeptError(`Pi provider ${provider} is not authenticated; run sept auth login --provider ${provider}`);
    } catch (error) {
      if (error instanceof SeptError) throw error;
      throw new SeptError(boundedFailure(error, "Authentication preflight"));
    }
    return { selected: { provider, model: modelId, source }, available: true, authenticated: true, model: normalizeModel(model, true) };
  }

  validateCustomConfiguration(): CustomConfigurationStatus {
    const status = validateConfigurationFile(this.agentDir);
    if (this.runtime.getError()) throw new SeptError("Pi rejected the configured provider or model metadata");
    return status;
  }
}
