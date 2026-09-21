import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelAccessService, type LoginPrompt } from "../../src/model-access/index.js";

class AuthenticationFixtureError extends Error {}

function nativeModel(provider: string, id: string): ReturnType<ModelRuntime["getModels"]>[number] {
  return {
    provider,
    id,
    name: `${provider} model`,
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

async function runtimeFixture(
  prefix: string,
): Promise<{ agentDir: string; runtime: ModelRuntime }> {
  const agentDir = mkdtempSync(join(tmpdir(), prefix));
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  return { agentDir, runtime };
}

function unavailableStream(): never {
  throw new AuthenticationFixtureError("model stream must not be invoked");
}

function registerKeyless(runtime: ModelRuntime): void {
  runtime.registerNativeProvider({
    id: "keyless-native",
    name: "Keyless native",
    auth: {
      apiKey: {
        name: "No authentication",
        check: () => Promise.resolve({ type: "api_key" as const }),
        resolve: () => Promise.resolve({ auth: {} }),
      },
    },
    getModels: () => [nativeModel("keyless-native", "local-model")],
    stream: unavailableStream,
    streamSimple: unavailableStream,
  });
}

function registerAmbient(runtime: ModelRuntime): void {
  runtime.registerNativeProvider({
    id: "ambient-native",
    name: "Ambient native",
    auth: {
      apiKey: {
        name: "Ambient credentials",
        check: () => Promise.resolve({ type: "api_key" as const, source: "ambient fixture" }),
        resolve: () => Promise.resolve({ auth: {}, source: "ambient fixture" }),
      },
    },
    getModels: () => [nativeModel("ambient-native", "ambient-model")],
    stream: unavailableStream,
    streamSimple: unavailableStream,
  });
}

function registerSubscription(runtime: ModelRuntime): void {
  runtime.registerProvider("subscription-local", {
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    models: [nativeModel("subscription-local", "subscription-model")],
    oauth: {
      name: "Fixture subscription",
      isSubscription: true,
      async login(callbacks) {
        callbacks.onAuth({
          url: "https://login.example.test/authorize",
          instructions: "Authorize in the browser",
        });
        callbacks.onDeviceCode({
          userCode: "DEVICE-CODE",
          verificationUri: "https://login.example.test/device",
        });
        callbacks.onProgress?.("Waiting for authorization");
        assert.equal(await callbacks.onPrompt({ message: "Account" }), "account");
        assert.equal(
          await callbacks.onSelect({ message: "Plan", options: [{ id: "pro", label: "Pro" }] }),
          "pro",
        );
        assert.equal(await callbacks.onManualCodeInput?.(), "manual-code");
        const suffix = String(Date.now());
        return {
          access: `fixture-access-${suffix}`,
          refresh: `fixture-refresh-${suffix}`,
          expires: Date.now() + 3_600_000,
        };
      },
      refreshToken: (credentials) => Promise.resolve(credentials),
      getApiKey: (credentials) => credentials.access,
    },
  });
}

function promptAnswer(prompt: LoginPrompt): string {
  if (prompt.type === "select") {
    return "pro";
  }
  if (prompt.type === "manual_code") {
    return "manual-code";
  }
  return "account";
}

await test("a Pi-native keyless provider is available and preflightable", async () => {
  const { agentDir, runtime } = await runtimeFixture("sept-model-keyless-");
  registerKeyless(runtime);
  const access = await ModelAccessService.create(agentDir, { runtime });
  assert.deepEqual(await access.authenticationStatus("keyless-native"), {
    provider: "keyless-native",
    state: "not_required",
    methods: [],
  });
  const catalogue = await access.catalogue("keyless-native");
  assert.deepEqual(catalogue.providers[0]?.authentication, {
    state: "not_required",
    methods: [],
  });
  assert.equal(catalogue.models[0]?.available, true);
  const preflight = await access.preflightSelection("keyless-native", "local-model");
  assert.equal(preflight.available, true);
  assert.equal(preflight.authenticated, true);
});

await test("ambient authentication never exposes Pi auth-source evidence", async () => {
  const { agentDir, runtime } = await runtimeFixture("sept-model-ambient-");
  registerAmbient(runtime);
  const access = await ModelAccessService.create(agentDir, { runtime });
  assert.deepEqual(await access.authenticationStatus("ambient-native"), {
    provider: "ambient-native",
    state: "authenticated",
    method: "api_key",
    methods: [],
  });
  const catalogue = await access.catalogue("ambient-native");
  assert.deepEqual(catalogue.providers[0]?.authentication, {
    state: "authenticated",
    method: "api_key",
    methods: [],
  });
  assert.equal(JSON.stringify(catalogue).includes("ambient fixture"), false);
  assert.equal(catalogue.models[0]?.available, true);
  const preflight = await access.preflightSelection("ambient-native", "ambient-model");
  assert.equal(preflight.authenticated, true);
});

await test("subscription login carries every Pi interaction form without credentials", async () => {
  const { agentDir, runtime } = await runtimeFixture("sept-model-oauth-");
  registerSubscription(runtime);
  const access = await ModelAccessService.create(agentDir, { runtime });
  const prompts: string[] = [];
  const events: string[] = [];
  const result = await access.login("subscription-local", "subscription", {
    prompt(prompt): Promise<string> {
      prompts.push(prompt.type);
      return Promise.resolve(promptAnswer(prompt));
    },
    notify(event): void {
      events.push(event.type);
    },
  });
  assert.equal(result.state, "authenticated");
  assert.equal(result.method, "subscription");
  assert.deepEqual(prompts, ["text", "select", "manual_code"]);
  assert.deepEqual(events, ["auth_url", "device_code", "progress"]);
  assert.equal(JSON.stringify(result).includes("fixture-access"), false);
  assert.equal((await access.logout("subscription-local")).state, "authentication_required");
});
