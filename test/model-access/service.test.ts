import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelAccessService, type LoginInteraction } from "../../src/model-access/index.js";
import { testModelAccess } from "../support/model-access.js";

function model(id: string, contextWindow = 128_000) {
  return { id, name: `Display ${id}`, reasoning: true, input: ["text", "image"] as Array<"text" | "image">, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 16_384 };
}

async function fixture() {
  const agent = mkdtempSync(join(tmpdir(), "sept-model-service-"));
  const runtime = await ModelRuntime.create({ authPath: join(agent, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("ready-local", { baseUrl: "http://127.0.0.1:9/v1", apiKey: "local", api: "openai-completions", models: [model("alpha")] });
  runtime.registerProvider("login-local", { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [model("beta", 272_000)] });
  return { agent, runtime, access: await ModelAccessService.create(agent, { runtime }) };
}

test("catalogue and status normalize only credential-blind Pi metadata", async () => {
  const { access } = await fixture();
  const catalogue = await access.catalogue("ready-local");
  assert.equal(catalogue.providers.length, 1);
  assert.deepEqual(Object.keys(catalogue.providers[0]).sort(), ["authentication", "availableModelCount", "id", "modelCount", "name"]);
  assert.deepEqual(catalogue.providers[0].authentication, { state: "authenticated", method: "api_key", methods: ["api_key"] });
  assert.deepEqual(Object.keys(catalogue.models[0]).sort(), ["api", "available", "capabilities", "contextWindow", "id", "maxOutputTokens", "name", "provider"]);
  assert.deepEqual(catalogue.models[0].capabilities, { reasoning: true, input: ["text", "image"] });
  assert.equal(JSON.stringify(catalogue).includes('"apiKey"'), false);
  assert.deepEqual(await access.authenticationStatus("login-local"), { provider: "login-local", state: "authentication_required", methods: ["api_key"] });
  await assert.rejects(access.catalogue("unknown"), /provider not found/);
});

test("a Pi-native keyless provider is not-required, available, and preflightable", async () => {
  const agent = mkdtempSync(join(tmpdir(), "sept-model-keyless-"));
  const runtime = await ModelRuntime.create({ authPath: join(agent, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const keylessModel = {
    provider: "keyless-native", id: "local-model", name: "Keyless local model", api: "openai-completions" as const,
    baseUrl: "http://127.0.0.1:9/v1", reasoning: false, input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8_192,
  };
  runtime.registerNativeProvider({
    id: "keyless-native", name: "Keyless native",
    auth: { apiKey: { name: "No authentication", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
    getModels: () => [keylessModel],
    stream: () => { throw new Error("not invoked"); },
    streamSimple: () => { throw new Error("not invoked"); },
  });
  const access = await ModelAccessService.create(agent, { runtime });
  assert.deepEqual(await access.authenticationStatus("keyless-native"), { provider: "keyless-native", state: "not_required", methods: [] });
  const catalogue = await access.catalogue("keyless-native");
  assert.deepEqual(catalogue.providers[0].authentication, { state: "not_required", methods: [] });
  assert.equal(catalogue.models[0].available, true);
  const preflight = await access.preflightSelection("keyless-native", "local-model");
  assert.equal(preflight.available, true);
  assert.equal(preflight.authenticated, true);
});

test("an ambient-only provider without login reports authenticated without exposing its auth source", async () => {
  const agent = mkdtempSync(join(tmpdir(), "sept-model-ambient-"));
  const runtime = await ModelRuntime.create({ authPath: join(agent, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const ambientModel = {
    provider: "ambient-native", id: "ambient-model", name: "Ambient model", api: "openai-completions" as const,
    baseUrl: "http://127.0.0.1:9/v1", reasoning: false, input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8_192,
  };
  runtime.registerNativeProvider({
    id: "ambient-native", name: "Ambient native",
    auth: { apiKey: {
      name: "Ambient credentials",
      check: async () => ({ type: "api_key", source: "ambient fixture" }),
      resolve: async () => ({ auth: {}, source: "ambient fixture" }),
    } },
    getModels: () => [ambientModel],
    stream: () => { throw new Error("not invoked"); },
    streamSimple: () => { throw new Error("not invoked"); },
  });
  const access = await ModelAccessService.create(agent, { runtime });
  assert.deepEqual(await access.authenticationStatus("ambient-native"), {
    provider: "ambient-native", state: "authenticated", method: "api_key", methods: [],
  });
  const catalogue = await access.catalogue("ambient-native");
  assert.deepEqual(catalogue.providers[0].authentication, { state: "authenticated", method: "api_key", methods: [] });
  assert.equal(JSON.stringify(catalogue).includes("ambient fixture"), false);
  assert.equal(catalogue.models[0].available, true);
  const preflight = await access.preflightSelection("ambient-native", "ambient-model");
  assert.equal(preflight.available, true);
  assert.equal(preflight.authenticated, true);
});

test("API-key login, logout, failure, and cancellation use Pi credential operations", async () => {
  const { runtime, access } = await fixture();
  const notices: unknown[] = [];
  const interaction: LoginInteraction = {
    async prompt(prompt) { assert.equal(prompt.type, "secret"); return "runtime-only-fixture-value"; },
    notify(event) { notices.push(event); },
  };
  const loggedIn = await access.login("login-local", "api_key", interaction);
  assert.equal(loggedIn.state, "authenticated");
  assert.deepEqual(await runtime.listCredentials(), [{ providerId: "login-local", type: "api_key" }]);
  assert.equal(JSON.stringify(loggedIn).includes("runtime-only-fixture-value"), false);
  assert.deepEqual(notices, []);
  const loggedOut = await access.logout("login-local");
  assert.equal(loggedOut.state, "authentication_required");
  assert.deepEqual(await runtime.listCredentials(), []);

  await assert.rejects(access.login("login-local", "api_key", { prompt: async () => { throw new Error("provider included sensitive request details"); }, notify() {} }), /Login failed in Pi model access/);
  assert.deepEqual(await runtime.listCredentials(), []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(access.login("login-local", "api_key", { signal: controller.signal, prompt: async () => "unused", notify() {} }), /cancelled/);
  assert.deepEqual(await runtime.listCredentials(), []);
});

test("subscription login faithfully carries Pi interaction forms without exposing returned credentials", async () => {
  const agent = mkdtempSync(join(tmpdir(), "sept-model-oauth-"));
  const runtime = await ModelRuntime.create({ authPath: join(agent, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("subscription-local", {
    baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [model("subscription-model")],
    oauth: {
      name: "Fixture subscription", isSubscription: true,
      async login(callbacks) {
        callbacks.onAuth({ url: "https://login.example.test/authorize", instructions: "Authorize in the browser" });
        callbacks.onDeviceCode({ userCode: "DEVICE-CODE", verificationUri: "https://login.example.test/device" });
        callbacks.onProgress?.("Waiting for authorization");
        assert.equal(await callbacks.onPrompt({ message: "Account" }), "account");
        assert.equal(await callbacks.onSelect({ message: "Plan", options: [{ id: "pro", label: "Pro" }] }), "pro");
        assert.equal(await callbacks.onManualCodeInput?.(), "manual-code");
        return { access: `fixture-access-${Date.now()}`, refresh: `fixture-refresh-${Date.now()}`, expires: Date.now() + 3_600_000 };
      },
      async refreshToken(credentials) { return credentials; },
      getApiKey(credentials) { return credentials.access; },
    },
  });
  const access = await ModelAccessService.create(agent, { runtime });
  const prompts: string[] = []; const events: string[] = [];
  const result = await access.login("subscription-local", "subscription", {
    async prompt(prompt) { prompts.push(prompt.type); return prompt.type === "select" ? "pro" : prompt.type === "manual_code" ? "manual-code" : "account"; },
    notify(event) { events.push(event.type); },
  });
  assert.equal(result.state, "authenticated");
  assert.equal(result.method, "subscription");
  assert.deepEqual(prompts, ["text", "select", "manual_code"]);
  assert.deepEqual(events, ["auth_url", "device_code", "progress"]);
  assert.equal(JSON.stringify(result).includes("fixture-access"), false);
  assert.equal((await access.logout("subscription-local")).state, "authentication_required");
});

test("installed Anthropic catalogue uses the same normalized subscription/API-key contract", async () => {
  const agent = mkdtempSync(join(tmpdir(), "sept-model-anthropic-"));
  const runtime = await ModelRuntime.create({ authPath: join(agent, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const access = await ModelAccessService.create(agent, { runtime });
  const catalogue = await access.catalogue("anthropic");
  assert.equal(catalogue.providers[0].id, "anthropic");
  assert.deepEqual(catalogue.providers[0].authentication, { state: "authentication_required", methods: ["subscription", "api_key"] });
  assert.ok(catalogue.models.length > 0);
  assert.ok(catalogue.models.every((entry) => entry.api === "anthropic-messages" && entry.contextWindow > 0 && entry.maxOutputTokens > 0));
});

test("injected admission fixtures never inherit the host Pi credential store", async () => {
  const access = await testModelAccess();
  assert.deepEqual(await access.authenticationStatus("openai-codex"), { provider: "openai-codex", state: "authenticated", method: "api_key", methods: ["subscription", "api_key"] });
});

test("selection preflight distinguishes selected, available, and authenticated", async () => {
  const { access } = await fixture();
  const selected = await access.setPodDefault("ready-local", "alpha");
  assert.deepEqual(selected.selected, { provider: "ready-local", model: "alpha", source: "pod_default" });
  assert.equal(selected.available, true);
  assert.equal(selected.authenticated, true);
  assert.deepEqual(access.resolveSelection(), selected.selected);
  assert.deepEqual(access.resolveSelection({ provider: "ready-local", model: "alpha" }), { provider: "ready-local", model: "alpha", source: "explicit" });
  await assert.rejects(access.preflightSelection("login-local", "beta"), /unavailable.*authentication/i);
  await assert.rejects(access.preflightSelection("ready-local", "missing"), /model not found/);
});
