import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPodDefault, validateCustomConfiguration, writePodDefault } from "../../src/model-access/index.js";

function agent(): string { return mkdtempSync(join(tmpdir(), "sept-model-config-")); }

test("custom configuration accepts Pi JSONC, commands, environment indirection, and deliberate local HTTP", () => {
  const directory = agent();
  writeFileSync(join(directory, "models.json"), `{
    // Pi-compatible local and managed endpoints
    "providers": {
      "managed": {
        "baseUrl": "https://models.example.test/v1",
        "api": "openai-completions",
        "apiKey": "!credential-helper read managed",
        "headers": { "X-Tenant": "public-tenant", "X-Access-Token": "$MANAGED_TOKEN" },
        "models": [{ "id": "managed-model", "contextWindow": 272000, "maxTokens": 32000, }],
      },
      "ollama": {
        "baseUrl": "http://127.0.0.1:11434/v1",
        "api": "openai-completions",
        "apiKey": "local",
        "models": [{ "id": "qwen2.5-coder:7b", "contextWindow": 128000, "maxTokens": 16384 }]
      }
    }
  }`);
  assert.deepEqual(validateCustomConfiguration(directory), { configured: true, providers: 2, models: 2 });
});

test("custom configuration requires rollover metadata and rejects unsafe endpoints and plaintext secrets", () => {
  const directory = agent();
  const write = (value: unknown): void => writeFileSync(join(directory, "models.json"), JSON.stringify(value));
  write({ providers: { local: { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", apiKey: "local", models: [{ id: "missing", maxTokens: 100 }] } } });
  assert.throws(() => validateCustomConfiguration(directory), /contextWindow/);
  write({ providers: { remote: { baseUrl: "http://public.example.test/v1", api: "openai-completions", apiKey: "$SAFE_KEY", models: [{ id: "m", contextWindow: 128000, maxTokens: 100 }] } } });
  assert.throws(() => validateCustomConfiguration(directory), /must use HTTPS/);
  write({ providers: { remote: { baseUrl: "https://user:password@example.test/v1", api: "openai-completions", apiKey: "$SAFE_KEY", models: [{ id: "m", contextWindow: 128000, maxTokens: 100 }] } } });
  assert.throws(() => validateCustomConfiguration(directory), /must not contain credentials/);
  write({ providers: { remote: { baseUrl: "https://example.test/v1", api: "openai-completions", apiKey: "plaintext-value", models: [{ id: "m", contextWindow: 128000, maxTokens: 100 }] } } });
  assert.throws(() => validateCustomConfiguration(directory), /instead of plaintext/);
  write({ providers: { local: { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", apiKey: "opaque-local-value", models: [{ id: "m", contextWindow: 128000, maxTokens: 100 }] } } });
  assert.throws(() => validateCustomConfiguration(directory), /instead of plaintext/);
  write({ providers: { local: { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", apiKey: "local", headers: { "X-Access-Token": "opaque-local-value" }, models: [{ id: "m", contextWindow: 128000, maxTokens: 100 }] } } });
  assert.throws(() => validateCustomConfiguration(directory), /instead of plaintext/);
  write({ providers: { remote: { baseUrl: "https://example.test/v1", api: "unsupported", apiKey: "$SAFE_KEY", models: [{ id: "m", contextWindow: 128000, maxTokens: 100 }] } } });
  assert.throws(() => validateCustomConfiguration(directory), /Pi-supported compatible API/);
});

test("Pod defaults are exact, credential-free, atomic, and strictly validated", () => {
  const directory = agent();
  assert.equal(readPodDefault(directory), undefined);
  writePodDefault(directory, { provider: "openai-codex", model: "gpt-5.6-sol" });
  assert.deepEqual(readPodDefault(directory), { provider: "openai-codex", model: "gpt-5.6-sol" });
  const path = join(directory, "sept-model.json");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { formatVersion: 1, provider: "openai-codex", model: "gpt-5.6-sol" });
  writeFileSync(path, JSON.stringify({ formatVersion: 1, provider: "openai-codex", model: "gpt-5.6-sol", token: "forbidden" }));
  assert.throws(() => readPodDefault(directory), /invalid fields/);
});
