/**
 * Exercises model configuration and Pod-selection safety at their filesystem boundaries. Tests prove
 * bounded JSONC, endpoint and plaintext-credential rejection, required rollover metadata, atomic
 * credential-free defaults, and strict model identity without invoking provider transports.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertModelMetadata,
  builtInDefault,
  readPodDefault,
  safeModelIdentifier,
  validateCustomConfiguration,
  writePodDefault,
} from "../../src/model-access/index.js";

function agent(): string {
  return mkdtempSync(join(tmpdir(), "sept-model-config-"));
}

function customModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "model", contextWindow: 128_000, maxTokens: 100, ...overrides };
}

function provider(
  baseUrl: string,
  apiKey: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    baseUrl,
    api: "openai-completions",
    apiKey,
    models: [customModel()],
    ...overrides,
  };
}

await test("custom configuration accepts Pi JSONC and deliberate local HTTP", () => {
  const directory = agent();
  writeFileSync(
    join(directory, "models.json"),
    `{
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
    }`,
  );
  assert.deepEqual(validateCustomConfiguration(directory), {
    configured: true,
    providers: 2,
    models: 2,
  });
});

await test("custom configuration requires rollover metadata and safe endpoints", () => {
  const directory = agent();
  const path = join(directory, "models.json");
  const cases: { configuration: unknown; expected: RegExp }[] = [
    {
      configuration: {
        providers: {
          local: provider("http://127.0.0.1:11434/v1", "local", {
            models: [customModel({ contextWindow: undefined })],
          }),
        },
      },
      expected: /contextWindow/,
    },
    {
      configuration: {
        providers: { remote: provider("http://public.example.test/v1", "$SAFE_KEY") },
      },
      expected: /must use HTTPS/,
    },
    {
      configuration: {
        providers: { remote: provider("https://user:password@example.test/v1", "$SAFE_KEY") },
      },
      expected: /must not contain credentials/,
    },
  ];
  for (const invalid of cases) {
    writeFileSync(path, JSON.stringify(invalid.configuration));
    assert.throws(() => validateCustomConfiguration(directory), invalid.expected);
  }
});

await test("custom configuration rejects plaintext credentials and unsupported APIs", () => {
  const directory = agent();
  const path = join(directory, "models.json");
  const unsafeProviders = [
    provider("https://example.test/v1", "plaintext-value"),
    provider("http://127.0.0.1:11434/v1", "opaque-local-value"),
    provider("http://127.0.0.1:11434/v1", "local", {
      headers: { "X-Access-Token": "opaque-local-value" },
    }),
  ];
  for (const unsafeProvider of unsafeProviders) {
    writeFileSync(path, JSON.stringify({ providers: { unsafe: unsafeProvider } }));
    assert.throws(() => validateCustomConfiguration(directory), /instead of plaintext/);
  }
  const unsupported = provider("https://example.test/v1", "$SAFE_KEY", {
    api: "unsupported",
  });
  writeFileSync(path, JSON.stringify({ providers: { unsupported } }));
  assert.throws(() => validateCustomConfiguration(directory), /Pi-supported compatible API/);
});

await test("Pod defaults are exact, credential-free, atomic, and strictly validated", () => {
  const directory = agent();
  assert.equal(readPodDefault(directory), undefined);
  writePodDefault(directory, { provider: "openai-codex", model: "gpt-6-sol" });
  assert.deepEqual(readPodDefault(directory), {
    provider: "openai-codex",
    model: "gpt-6-sol",
  });
  const path = join(directory, "sept-model.json");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    formatVersion: 1,
    provider: "openai-codex",
    model: "gpt-6-sol",
  });
  writeFileSync(
    path,
    JSON.stringify({
      formatVersion: 1,
      provider: "openai-codex",
      model: "gpt-6-sol",
      token: "forbidden",
    }),
  );
  assert.throws(() => readPodDefault(directory), /invalid fields/);
});

await test("model identity, fallback, and rollover metadata contracts fail closed", () => {
  assert.equal(safeModelIdentifier("provider/model:v1", "model"), "provider/model:v1");
  assert.throws(() => safeModelIdentifier(" invalid ", "model"), /invalid/);
  assert.deepEqual(builtInDefault(), {
    provider: "openai-codex",
    model: "gpt-6-sol",
  });
  assert.doesNotThrow(() => {
    assertModelMetadata({
      provider: "fixture",
      id: "valid",
      contextWindow: 128_000,
      maxTokens: 8_192,
    });
  });
  assert.throws(() => {
    assertModelMetadata({ provider: "fixture", id: "small", contextWindow: 1, maxTokens: 1 });
  }, /context-window metadata/);
  assert.throws(() => {
    assertModelMetadata({
      provider: "fixture",
      id: "output",
      contextWindow: 128_000,
      maxTokens: 128_001,
    });
  }, /maximum-output metadata/);
});

await test("private HTTP uses parsed address ranges and rejects deceptive DNS spellings", () => {
  const directory = agent();
  const path = join(directory, "models.json");
  for (const hostname of [
    "127.deceptive.invalid",
    "10.deceptive.invalid",
    "192.168.deceptive.invalid",
    "172.16.deceptive.invalid",
    "172.15.0.1",
    "172.32.0.1",
    "192.169.0.1",
  ]) {
    writeFileSync(
      path,
      JSON.stringify({ providers: { local: provider(`http://${hostname}/v1`, "local") } }),
    );
    assert.throws(() => validateCustomConfiguration(directory), /must use HTTPS/);
  }
  for (const hostname of [
    "localhost",
    "host.docker.internal",
    "[::1]",
    "127.255.0.1",
    "10.0.0.1",
    "192.168.0.1",
    "172.16.0.1",
    "172.31.255.255",
  ]) {
    writeFileSync(
      path,
      JSON.stringify({ providers: { local: provider(`http://${hostname}/v1`, "local") } }),
    );
    assert.equal(validateCustomConfiguration(directory).configured, true);
  }
});
