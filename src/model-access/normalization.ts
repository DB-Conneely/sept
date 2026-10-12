/**
 * Projects installed Pi provider, model, and failure data into bounded credential-blind contracts.
 * ModelAccessService owns orchestration; these helpers never expose auth sources, credential values,
 * raw provider failures, or alternate provider behavior.
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  AuthenticationMethod,
  AuthenticationStatus,
  ModelDescription,
  ProviderDescription,
} from "./contracts.js";

function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function boundedFailure(error: unknown, operation: string): string {
  const message = error instanceof Error ? error.message : "";
  if (/abort|cancel/i.test(message)) {
    return `${operation} was cancelled`;
  }
  if (/invalid_grant|expired|revoked|refresh/i.test(message)) {
    return `${operation} failed because the subscription credential is expired or revoked; log in again`;
  }
  if (/timeout|timed out/i.test(message)) {
    return `${operation} timed out`;
  }
  if (/network|fetch|connect|ENOTFOUND|ECONN/i.test(message)) {
    return `${operation} failed because the provider could not be reached`;
  }
  if (/models\.json|contextWindow|maxTokens|baseUrl|configuration/i.test(message)) {
    return `${operation} failed because the Pi model configuration is invalid`;
  }
  return `${operation} failed in Pi model access`;
}

function methodsFor(runtime: ModelRuntime, providerId: string): AuthenticationMethod[] {
  const provider = runtime.getProvider(providerId);
  if (provider === undefined) {
    return [];
  }
  const methods: AuthenticationMethod[] = [];
  if (provider.auth.oauth !== undefined) {
    methods.push(provider.auth.oauth.isSubscription === true ? "subscription" : "oauth");
  }
  if (provider.auth.apiKey?.login !== undefined) {
    methods.push("api_key");
  }
  return methods;
}

function providerAuthentication(
  status: AuthenticationStatus,
): ProviderDescription["authentication"] {
  const authentication: ProviderDescription["authentication"] = {
    state: status.state,
    methods: status.methods,
  };
  if (status.method !== undefined) {
    authentication.method = status.method;
  }
  if (status.error !== undefined) {
    authentication.error = status.error;
  }
  return authentication;
}

function normalizeModel(
  model: ReturnType<ModelRuntime["getModels"]>[number],
  available: boolean,
): ModelDescription {
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

export { boundedFailure, methodsFor, normalizeModel, providerAuthentication, signalOptions };
