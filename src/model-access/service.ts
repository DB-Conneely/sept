import { resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SeptError } from "../durable/index.js";
import { validateCustomConfiguration as validateConfigurationFile } from "./custom-configuration.js";
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
import { assertModelMetadata, builtInDefault, safeModelIdentifier } from "./model-metadata.js";
import {
  boundedFailure,
  methodsFor,
  normalizeModel,
  providerAuthentication,
  signalOptions,
} from "./normalization.js";
import { readPodDefault, writePodDefault } from "./pod-selection.js";
import { createPodModelRuntime, type ModelAccessCreateOptions } from "./runtime-factory.js";

interface AvailabilityResult {
  keys: Set<string>;
  failed: boolean;
}

/** Thin credential-blind normalization and admission facade over Pi's installed ModelRuntime. */
export class ModelAccessService {
  private constructor(
    private readonly agentDir: string,
    private readonly runtime: ModelRuntime,
  ) {}

  /** Create a facade around an injected or newly owned Pi model runtime. */
  public static async create(
    agentDir: string,
    options: ModelAccessCreateOptions = {},
  ): Promise<ModelAccessService> {
    const directory = resolve(agentDir);
    const runtime = options.runtime ?? (await createPodModelRuntime(directory, options));
    return new ModelAccessService(directory, runtime);
  }

  /** Return normalized provider/model metadata without credential values or auth sources. */
  public async catalogue(providerId?: string, signal?: AbortSignal): Promise<ModelCatalogue> {
    this.assertProviderFilter(providerId);
    const providers = this.runtime
      .getProviders()
      .filter((provider) => providerId === undefined || provider.id === providerId);
    const statuses = await Promise.all(
      providers.map(async (provider) => this.authenticationStatus(provider.id, signal)),
    );
    const statusByProvider = new Map(statuses.map((status) => [status.provider, status] as const));
    const availability = await this.availableModelKeys(
      providers.map((provider) => provider.id),
      signal,
    );
    const models = providers
      .flatMap((provider) => this.runtime.getModels(provider.id))
      .map((model) =>
        normalizeModel(model, availability.keys.has(`${model.provider}\0${model.id}`)),
      );
    const descriptions = providers.map((provider) =>
      this.describeProvider(provider.id, provider.name, statusByProvider, models),
    );
    return this.catalogueResult(descriptions, models, availability.failed);
  }

  /** Return one credential-blind authentication state using Pi's current auth check. */
  public async authenticationStatus(
    providerId: string,
    signal?: AbortSignal,
  ): Promise<AuthenticationStatus> {
    safeModelIdentifier(providerId, "provider");
    const provider = this.runtime.getProvider(providerId);
    if (provider === undefined) {
      throw new SeptError(`Pi provider not found: ${providerId}`);
    }
    const methods = methodsFor(this.runtime, providerId);
    try {
      const check = await this.runtime.checkAuth(providerId, signalOptions(signal));
      if (check === undefined) {
        return { provider: providerId, state: "authentication_required", methods };
      }
      // Pi uses source-free api_key success for keyless providers; any source is auth evidence.
      if (methods.length === 0 && check.type === "api_key" && check.source === undefined) {
        return { provider: providerId, state: "not_required", methods };
      }
      const oauthMethod = provider.auth.oauth?.isSubscription === true ? "subscription" : "oauth";
      const method: AuthenticationMethod = check.type === "oauth" ? oauthMethod : "api_key";
      return { provider: providerId, state: "authenticated", method, methods };
    } catch (error: unknown) {
      return {
        provider: providerId,
        state: "error",
        methods,
        error: boundedFailure(error, "Authentication check"),
      };
    }
  }

  /** Delegate a supported login flow to Pi without retaining prompt or credential values. */
  public async login(
    providerId: string,
    method: AuthenticationMethod,
    interaction: LoginInteraction,
  ): Promise<AuthenticationStatus> {
    safeModelIdentifier(providerId, "provider");
    const provider = this.runtime.getProvider(providerId);
    if (provider === undefined) {
      throw new SeptError(`Pi provider not found: ${providerId}`);
    }
    this.assertLoginSupported(providerId, method, provider.auth);
    try {
      const piMethod = method === "api_key" ? "api_key" : "oauth";
      await this.runtime.login(providerId, piMethod, interaction);
    } catch (error: unknown) {
      throw new SeptError(boundedFailure(error, "Login"), { cause: error });
    }
    return this.authenticationStatus(providerId, interaction.signal);
  }

  /** Delegate credential removal to Pi and return the resulting safe status. */
  public async logout(providerId: string, signal?: AbortSignal): Promise<AuthenticationStatus> {
    safeModelIdentifier(providerId, "provider");
    if (this.runtime.getProvider(providerId) === undefined) {
      throw new SeptError(`Pi provider not found: ${providerId}`);
    }
    try {
      await this.runtime.logout(providerId, signalOptions(signal));
    } catch (error: unknown) {
      throw new SeptError(boundedFailure(error, "Logout"), { cause: error });
    }
    return this.authenticationStatus(providerId, signal);
  }

  /** Reread the credential-free Pod default rather than caching admission authority. */
  public getPodDefault(): ModelSelection | undefined {
    return readPodDefault(this.agentDir);
  }

  /** Preflight and atomically set the Pod default used only by future admissions. */
  public async setPodDefault(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreflightedModelSelection> {
    const selected = await this.preflightSelection(provider, model, "explicit", signal);
    writePodDefault(this.agentDir, selected.selected);
    return { ...selected, selected: { ...selected.selected, source: "pod_default" } };
  }

  /** Resolve explicit pair, fresh Pod default, then the unprivileged built-in fallback. */
  public resolveSelection(explicitSelection?: ModelSelection): ResolvedModelSelection {
    if (explicitSelection !== undefined) {
      return {
        provider: safeModelIdentifier(explicitSelection.provider, "provider"),
        model: safeModelIdentifier(explicitSelection.model, "model"),
        source: "explicit",
      };
    }
    const configured = this.getPodDefault();
    if (configured !== undefined) {
      return { ...configured, source: "pod_default" };
    }
    return { ...builtInDefault(), source: "built_in_default" };
  }

  /** Require model existence, rollover metadata, availability, and resolved Pi auth. */
  public async preflightSelection(
    providerId: string,
    modelId: string,
    source: ResolvedModelSelection["source"] = "explicit",
    signal?: AbortSignal,
  ): Promise<PreflightedModelSelection> {
    safeModelIdentifier(providerId, "provider");
    safeModelIdentifier(modelId, "model");
    if (this.runtime.getProvider(providerId) === undefined) {
      throw new SeptError(`Pi provider not found: ${providerId}`);
    }
    const model = this.runtime.getModel(providerId, modelId);
    if (model === undefined) {
      throw new SeptError(`Pi model not found: ${providerId}/${modelId}`);
    }
    assertModelMetadata(model);
    await this.assertAvailable(providerId, modelId, signal);
    await this.assertAuthenticated(providerId, model, signal);
    return {
      selected: { provider: providerId, model: modelId, source },
      available: true,
      authenticated: true,
      model: normalizeModel(model, true),
    };
  }

  /** Validate custom Pi configuration and reject any Pi catalogue parse failure. */
  public validateCustomConfiguration(): CustomConfigurationStatus {
    const status = validateConfigurationFile(this.agentDir);
    if (this.runtime.getError() !== undefined) {
      throw new SeptError("Pi rejected the configured provider or model metadata");
    }
    return status;
  }

  private assertProviderFilter(providerId: string | undefined): void {
    if (providerId === undefined) {
      return;
    }
    safeModelIdentifier(providerId, "provider");
    if (this.runtime.getProvider(providerId) === undefined) {
      throw new SeptError(`Pi provider not found: ${providerId}`);
    }
  }

  private async availableModelKeys(
    providerIds: string[],
    signal: AbortSignal | undefined,
  ): Promise<AvailabilityResult> {
    const keys = new Set<string>();
    let failed = false;
    for (const providerId of providerIds) {
      try {
        const models = await this.runtime.getAvailable(providerId, signalOptions(signal));
        for (const model of models) {
          keys.add(`${model.provider}\0${model.id}`);
        }
      } catch {
        failed = true;
      }
    }
    return { keys, failed };
  }

  private describeProvider(
    id: string,
    name: string,
    statuses: ReadonlyMap<string, AuthenticationStatus>,
    models: ModelDescription[],
  ): ProviderDescription {
    const status = statuses.get(id);
    if (status === undefined) {
      throw new SeptError("Pi authentication status was not resolved for a provider");
    }
    const providerModels = models.filter((model) => model.provider === id);
    return {
      id,
      name,
      authentication: providerAuthentication(status),
      modelCount: providerModels.length,
      availableModelCount: providerModels.filter((model) => model.available).length,
    };
  }

  private catalogueResult(
    providers: ProviderDescription[],
    models: ModelDescription[],
    availabilityFailed: boolean,
  ): ModelCatalogue {
    const partial = availabilityFailed || this.runtime.getError() !== undefined;
    if (!partial) {
      return { providers, models };
    }
    return {
      providers,
      models,
      error:
        "One or more Pi provider availability checks failed; validate authentication and models.json",
    };
  }

  private assertLoginSupported(
    providerId: string,
    method: AuthenticationMethod,
    auth: NonNullable<ReturnType<ModelRuntime["getProvider"]>>["auth"],
  ): void {
    if (method === "api_key" && auth.apiKey?.login === undefined) {
      throw new SeptError(`Pi provider ${providerId} does not support API-key login`);
    }
    if (method !== "api_key" && auth.oauth === undefined) {
      throw new SeptError(`Pi provider ${providerId} does not support subscription/OAuth login`);
    }
    if (method === "subscription" && auth.oauth?.isSubscription !== true) {
      throw new SeptError(`Pi provider ${providerId} does not expose subscription login`);
    }
  }

  private async assertAvailable(
    providerId: string,
    modelId: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    let available: boolean;
    try {
      const models = await this.runtime.getAvailable(providerId, signalOptions(signal));
      available = models.some((candidate) => candidate.id === modelId);
    } catch (error: unknown) {
      throw new SeptError(boundedFailure(error, "Model availability check"), { cause: error });
    }
    if (!available) {
      throw new SeptError(
        `Pi model ${providerId}/${modelId} is unavailable because provider authentication or provider model access is not configured`,
      );
    }
  }

  private async assertAuthenticated(
    providerId: string,
    model: NonNullable<ReturnType<ModelRuntime["getModel"]>>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      const authentication = await this.runtime.getAuth(model, signalOptions(signal));
      if (authentication === undefined) {
        throw new SeptError(
          `Pi provider ${providerId} is not authenticated; run sept auth login --provider ${providerId}`,
        );
      }
    } catch (error: unknown) {
      if (error instanceof SeptError) {
        throw error;
      }
      throw new SeptError(boundedFailure(error, "Authentication preflight"), { cause: error });
    }
  }
}
