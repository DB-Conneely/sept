import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWrite, DEFAULTS, SeptError } from "../durable/index.js";
import type { CustomConfigurationStatus, ModelSelection } from "./contracts.js";

const MAX_MODELS_FILE_BYTES = 1024 * 1024;
const MAX_CONTEXT_WINDOW = 10_000_000;
const MIN_CONTEXT_WINDOW = 4_096;
const SUPPORTED_CUSTOM_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SELECTION_FILE = "sept-model.json";
const SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}|\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SeptError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

export function safeModelIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new SeptError(`${name} is invalid`);
  return value;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SeptError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function assertModelMetadata(model: { provider: string; id: string; contextWindow: number; maxTokens: number }): void {
  const { contextWindow, maxTokens } = model;
  if (!Number.isSafeInteger(contextWindow) || contextWindow < MIN_CONTEXT_WINDOW || contextWindow > MAX_CONTEXT_WINDOW) {
    throw new SeptError(`Pi model ${model.provider}/${model.id} has missing or invalid context-window metadata`);
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > contextWindow) {
    throw new SeptError(`Pi model ${model.provider}/${model.id} has missing or invalid maximum-output metadata`);
  }
}

function stripJsonComments(input: string): string {
  let output = "";
  let string = false;
  let escaped = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    const next = input[index + 1];
    if (string) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') { string = true; output += char; continue; }
    if (char === "/" && next === "/") {
      output += "  "; index++;
      while (index + 1 < input.length && input[index + 1] !== "\n" && input[index + 1] !== "\r") { output += " "; index++; }
      continue;
    }
    if (char === "/" && next === "*") {
      output += "  "; index++;
      let closed = false;
      while (index + 1 < input.length) {
        index++;
        if (input[index] === "*" && input[index + 1] === "/") { output += "  "; index++; closed = true; break; }
        output += input[index] === "\n" || input[index] === "\r" ? input[index] : " ";
      }
      if (!closed) throw new SeptError("models.json contains an unterminated comment");
      continue;
    }
    output += char;
  }
  if (string) throw new SeptError("models.json contains an unterminated string");
  return output;
}

function removeTrailingCommas(input: string): string {
  let output = "";
  let string = false;
  let escaped = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (string) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') { string = true; output += char; continue; }
    if (char === ",") {
      let next = index + 1;
      while (/\s/.test(input[next] ?? "")) next++;
      if (input[next] === "}" || input[next] === "]") continue;
    }
    output += char;
  }
  return output;
}

function parseModelsJson(text: string): unknown {
  try { return JSON.parse(removeTrailingCommas(stripJsonComments(text))); }
  catch (error) { if (error instanceof SeptError) throw error; throw new SeptError("models.json must contain valid JSON or JSONC"); }
}

function safeBaseUrl(value: unknown, name: string): URL {
  if (typeof value !== "string" || value.length > 2048) throw new SeptError(`${name} must be a URL`);
  let url: URL;
  try { url = new URL(value); } catch { throw new SeptError(`${name} must be a valid URL`); }
  if (url.username || url.password || url.search || url.hash) throw new SeptError(`${name} must not contain credentials, a query, or a fragment`);
  if (url.protocol === "https:") return url;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const local = url.protocol === "http:" && (host === "localhost" || host === "host.docker.internal" || host === "::1" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host));
  if (!local) throw new SeptError(`${name} must use HTTPS unless it targets a deliberate local or private endpoint`);
  return url;
}

function credentialValue(value: unknown, name: string, plaintext: "forbidden" | "non_sensitive" | "local_sentinel"): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new SeptError(`${name} is invalid`);
  if (SECRET_VALUE.test(value)) throw new SeptError(`${name} must not contain a plaintext credential`);
  if (value.startsWith("!") && value.length > 1) return;
  if (/\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/.test(value)) return;
  if (plaintext === "non_sensitive") return;
  if (plaintext === "local_sentinel" && value === "local") return;
  throw new SeptError(`${name} must use Pi credential storage, environment interpolation, or a credential command instead of plaintext`);
}

/** Enforce only SEPT's safety and rollover requirements; Pi remains the schema and compatibility authority. */
export function validateCustomConfiguration(agentDir: string): CustomConfigurationStatus {
  const path = join(resolve(agentDir), "models.json");
  if (!existsSync(path)) return { configured: false, providers: 0, models: 0 };
  if (statSync(path).size > MAX_MODELS_FILE_BYTES) throw new SeptError(`models.json exceeds ${MAX_MODELS_FILE_BYTES} bytes`);
  const root = object(parseModelsJson(readFileSync(path, "utf8")), "models.json");
  if (root.providers === undefined) return { configured: true, providers: 0, models: 0 };
  const providers = object(root.providers, "models.json providers");
  let modelCount = 0;
  for (const [providerId, rawProvider] of Object.entries(providers)) {
    safeModelIdentifier(providerId, "custom provider id");
    const provider = object(rawProvider, `provider ${providerId}`);
    const providerUrl = provider.baseUrl === undefined ? undefined : safeBaseUrl(provider.baseUrl, `provider ${providerId} baseUrl`);
    const localProvider = providerUrl?.protocol === "http:";
    if (provider.apiKey !== undefined) credentialValue(provider.apiKey, `provider ${providerId} apiKey`, localProvider ? "local_sentinel" : "forbidden");
    if (provider.headers !== undefined) {
      const headers = object(provider.headers, `provider ${providerId} headers`);
      for (const [name, value] of Object.entries(headers)) {
        if (!/^[A-Za-z0-9-]{1,128}$/.test(name)) throw new SeptError(`provider ${providerId} header name is invalid`);
        const sensitive = /(?:authorization|api[-_]?key|token|secret|password)/i.test(name);
        credentialValue(value, `provider ${providerId} header ${name}`, sensitive ? "forbidden" : "non_sensitive");
      }
    }
    if (provider.models === undefined) continue;
    if (!Array.isArray(provider.models) || provider.models.length < 1 || provider.models.length > 1000) throw new SeptError(`provider ${providerId} models must contain 1-1000 entries`);
    const seen = new Set<string>();
    for (const rawModel of provider.models) {
      const model = object(rawModel, `provider ${providerId} model`);
      const id = safeModelIdentifier(model.id, `provider ${providerId} model id`);
      if (seen.has(id)) throw new SeptError(`provider ${providerId} contains duplicate model ${id}`);
      seen.add(id);
      const api = model.api ?? provider.api;
      if (api !== undefined && (typeof api !== "string" || !SUPPORTED_CUSTOM_APIS.has(api))) throw new SeptError(`provider ${providerId} model ${id} must use a Pi-supported compatible API`);
      if (model.baseUrl !== undefined) safeBaseUrl(model.baseUrl, `provider ${providerId} model ${id} baseUrl`);
      const contextWindow = integer(model.contextWindow, `provider ${providerId} model ${id} contextWindow`, MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW);
      const maxTokens = integer(model.maxTokens, `provider ${providerId} model ${id} maxTokens`, 1, contextWindow);
      if (maxTokens > contextWindow) throw new SeptError(`provider ${providerId} model ${id} maxTokens exceeds contextWindow`);
      modelCount++;
    }
  }
  return { configured: true, providers: Object.keys(providers).length, models: modelCount };
}

export function readPodDefault(agentDir: string): ModelSelection | undefined {
  const path = join(resolve(agentDir), SELECTION_FILE);
  if (!existsSync(path)) return undefined;
  let input: Record<string, unknown>;
  try { input = object(JSON.parse(readFileSync(path, "utf8")), "model selection"); }
  catch (error) { if (error instanceof SeptError) throw error; throw new SeptError("model selection must contain valid JSON"); }
  if (Object.keys(input).sort().join() !== ["formatVersion", "model", "provider"].sort().join() || input.formatVersion !== 1) throw new SeptError("model selection has invalid fields");
  return { provider: safeModelIdentifier(input.provider, "selected provider"), model: safeModelIdentifier(input.model, "selected model") };
}

export function writePodDefault(agentDir: string, selection: ModelSelection): void {
  atomicWrite(join(resolve(agentDir), SELECTION_FILE), { formatVersion: 1, provider: selection.provider, model: selection.model });
}

export function builtInDefault(): ModelSelection {
  return { provider: DEFAULTS.provider, model: DEFAULTS.model };
}
