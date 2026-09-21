import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { SeptError } from "../durable/index.js";
import type { CustomConfigurationStatus } from "./contracts.js";
import { isUnknownRecord } from "./input.js";
import { parseJsonc } from "./jsonc.js";
import {
  MAX_MODEL_CONTEXT_WINDOW,
  MIN_MODEL_CONTEXT_WINDOW,
  safeModelIdentifier,
} from "./model-metadata.js";

const MAX_MODELS_FILE_BYTES = 1024 * 1024;
const SUPPORTED_CUSTOM_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);
const SECRET_VALUE =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}|\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;

type PlaintextPolicy = "forbidden" | "non-sensitive" | "local-sentinel";

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) {
    throw new SeptError(`${name} must be an object`);
  }
  return value;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  const valid =
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum;
  if (!valid) {
    throw new SeptError(`${name} must be an integer from ${String(minimum)} to ${String(maximum)}`);
  }
  return value;
}

function isPrivateHttpHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "host.docker.internal" ||
    hostname === "::1" ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

function parsedUrl(value: unknown, name: string): URL {
  if (typeof value !== "string" || value.length > 2048) {
    throw new SeptError(`${name} must be a URL`);
  }
  try {
    return new URL(value);
  } catch (error: unknown) {
    throw new SeptError(`${name} must be a valid URL`, { cause: error });
  }
}

function safeBaseUrl(value: unknown, name: string): URL {
  const url = parsedUrl(value, name);
  if (url.username || url.password || url.search || url.hash) {
    throw new SeptError(`${name} must not contain credentials, a query, or a fragment`);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const secure = url.protocol === "https:";
  const deliberatePrivateHttp = url.protocol === "http:" && isPrivateHttpHost(hostname);
  if (!secure && !deliberatePrivateHttp) {
    throw new SeptError(
      `${name} must use HTTPS unless it targets a deliberate local or private endpoint`,
    );
  }
  return url;
}

function credentialString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new SeptError(`${name} is invalid`);
  }
  const invalid = value.length < 1 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value);
  if (invalid) {
    throw new SeptError(`${name} is invalid`);
  }
  if (SECRET_VALUE.test(value)) {
    throw new SeptError(`${name} must not contain a plaintext credential`);
  }
  return value;
}

function credentialValue(value: unknown, name: string, policy: PlaintextPolicy): void {
  const credential = credentialString(value, name);
  const command = credential.startsWith("!") && credential.length > 1;
  const environment = /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/.test(credential);
  const allowedLiteral =
    policy === "non-sensitive" || (policy === "local-sentinel" && credential === "local");
  if (!command && !environment && !allowedLiteral) {
    throw new SeptError(
      `${name} must use Pi credential storage, environment interpolation, or a credential command instead of plaintext`,
    );
  }
}

function validateHeaders(providerId: string, value: unknown): void {
  const headers = record(value, `provider ${providerId} headers`);
  for (const [name, headerValue] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(name)) {
      throw new SeptError(`provider ${providerId} header name is invalid`);
    }
    const sensitive = /(?:authorization|api[-_]?key|token|secret|password)/i.test(name);
    credentialValue(
      headerValue,
      `provider ${providerId} header ${name}`,
      sensitive ? "forbidden" : "non-sensitive",
    );
  }
}

function validateApi(providerId: string, modelId: string, value: unknown): void {
  if (value !== undefined && (typeof value !== "string" || !SUPPORTED_CUSTOM_APIS.has(value))) {
    throw new SeptError(
      `provider ${providerId} model ${modelId} must use a Pi-supported compatible API`,
    );
  }
}

function validateModel(
  providerId: string,
  providerApi: unknown,
  rawModel: unknown,
  seen: Set<string>,
): void {
  const model = record(rawModel, `provider ${providerId} model`);
  const id = safeModelIdentifier(model.id, `provider ${providerId} model id`);
  if (seen.has(id)) {
    throw new SeptError(`provider ${providerId} contains duplicate model ${id}`);
  }
  seen.add(id);
  validateApi(providerId, id, model.api ?? providerApi);
  if (model.baseUrl !== undefined) {
    safeBaseUrl(model.baseUrl, `provider ${providerId} model ${id} baseUrl`);
  }
  const contextWindow = integer(
    model.contextWindow,
    `provider ${providerId} model ${id} contextWindow`,
    MIN_MODEL_CONTEXT_WINDOW,
    MAX_MODEL_CONTEXT_WINDOW,
  );
  integer(model.maxTokens, `provider ${providerId} model ${id} maxTokens`, 1, contextWindow);
}

function validateModels(providerId: string, providerApi: unknown, value: unknown): number {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000) {
    throw new SeptError(`provider ${providerId} models must contain 1-1000 entries`);
  }
  const seen = new Set<string>();
  for (const rawModel of value) {
    validateModel(providerId, providerApi, rawModel, seen);
  }
  return value.length;
}

function validateProvider(providerId: string, rawProvider: unknown): number {
  safeModelIdentifier(providerId, "custom provider id");
  const provider = record(rawProvider, `provider ${providerId}`);
  const providerUrl =
    provider.baseUrl === undefined
      ? undefined
      : safeBaseUrl(provider.baseUrl, `provider ${providerId} baseUrl`);
  if (provider.apiKey !== undefined) {
    credentialValue(
      provider.apiKey,
      `provider ${providerId} apiKey`,
      providerUrl?.protocol === "http:" ? "local-sentinel" : "forbidden",
    );
  }
  if (provider.headers !== undefined) {
    validateHeaders(providerId, provider.headers);
  }
  return provider.models === undefined
    ? 0
    : validateModels(providerId, provider.api, provider.models);
}

/** Enforce SEPT safety and rollover metadata while leaving provider compatibility to Pi. */
export function validateCustomConfiguration(agentDir: string): CustomConfigurationStatus {
  const path = join(resolve(agentDir), "models.json");
  if (!existsSync(path)) {
    return { configured: false, providers: 0, models: 0 };
  }
  if (statSync(path).size > MAX_MODELS_FILE_BYTES) {
    throw new SeptError(`models.json exceeds ${String(MAX_MODELS_FILE_BYTES)} bytes`);
  }
  const root = record(parseJsonc(readFileSync(path, "utf8")), "models.json");
  if (root.providers === undefined) {
    return { configured: true, providers: 0, models: 0 };
  }
  const providers = record(root.providers, "models.json providers");
  let models = 0;
  for (const [providerId, provider] of Object.entries(providers)) {
    models += validateProvider(providerId, provider);
  }
  return { configured: true, providers: Object.keys(providers).length, models };
}
