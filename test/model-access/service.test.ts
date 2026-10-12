/**
 * Verifies the ModelAccessService facade over isolated installed Pi runtimes. Native Pi remains the
 * provider/auth owner; tests assert credential-blind catalogue projection, login/logout delegation,
 * fresh selection preflight, bounded failures, and private agent-directory construction.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  ModelAccessService,
  createPodModelRuntime,
  type LoginInteraction,
} from "../../src/model-access/index.js";
import { testModelAccess } from "../support/model-access.js";

class ModelFixtureError extends Error {}

interface FixtureModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

interface ServiceFixture {
  agentDir: string;
  runtime: ModelRuntime;
  access: ModelAccessService;
}

function model(id: string, contextWindow = 128_000): FixtureModel {
  return {
    id,
    name: `Display ${id}`,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 16_384,
  };
}

async function fixture(): Promise<ServiceFixture> {
  const agentDir = mkdtempSync(join(tmpdir(), "sept-model-service-"));
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("ready-local", {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "local",
    api: "openai-completions",
    models: [model("alpha")],
  });
  runtime.registerProvider("login-local", {
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    models: [model("beta", 272_000)],
  });
  return {
    agentDir,
    runtime,
    access: await ModelAccessService.create(agentDir, { runtime }),
  };
}

function first<Element>(values: readonly Element[]): Element {
  const value = values[0];
  assert.ok(value !== undefined);
  return value;
}

await test("catalogue and status normalize only credential-blind Pi metadata", async () => {
  const { access } = await fixture();
  const catalogue = await access.catalogue("ready-local");
  const provider = first(catalogue.providers);
  const normalizedModel = first(catalogue.models);
  assert.deepEqual(Object.keys(provider).sort(), [
    "authentication",
    "availableModelCount",
    "id",
    "modelCount",
    "name",
  ]);
  assert.deepEqual(provider.authentication, {
    state: "authenticated",
    method: "api_key",
    methods: ["api_key"],
  });
  assert.deepEqual(normalizedModel.capabilities, {
    reasoning: true,
    input: ["text", "image"],
  });
  assert.equal(JSON.stringify(catalogue).includes('"apiKey"'), false);
  assert.deepEqual(await access.authenticationStatus("login-local"), {
    provider: "login-local",
    state: "authentication_required",
    methods: ["api_key"],
  });
  await assert.rejects(access.catalogue("unknown"), /provider not found/);
});

await test("API-key login and logout use only Pi credential operations", async () => {
  const { runtime, access } = await fixture();
  const notices: unknown[] = [];
  const interaction: LoginInteraction = {
    prompt(prompt): Promise<string> {
      assert.equal(prompt.type, "secret");
      return Promise.resolve("runtime-only-fixture-value");
    },
    notify(event): void {
      notices.push(event);
    },
  };
  const loggedIn = await access.login("login-local", "api_key", interaction);
  assert.equal(loggedIn.state, "authenticated");
  assert.deepEqual(await runtime.listCredentials(), [
    { providerId: "login-local", type: "api_key" },
  ]);
  assert.equal(JSON.stringify(loggedIn).includes("runtime-only-fixture-value"), false);
  assert.deepEqual(notices, []);
  assert.equal((await access.logout("login-local")).state, "authentication_required");
  assert.deepEqual(await runtime.listCredentials(), []);
});

await test("login failure and cancellation remain bounded and credential-blind", async () => {
  const { runtime, access } = await fixture();
  const events: unknown[] = [];
  await assert.rejects(
    access.login("login-local", "api_key", {
      prompt(): Promise<string> {
        return Promise.reject(new ModelFixtureError("provider included sensitive request details"));
      },
      notify(event): void {
        events.push(event);
      },
    }),
    /Login failed in Pi model access/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    access.login("login-local", "api_key", {
      signal: controller.signal,
      prompt: () => Promise.resolve("unused"),
      notify(event): void {
        events.push(event);
      },
    }),
    /cancelled/,
  );
  assert.deepEqual(await runtime.listCredentials(), []);
});

await test("installed Anthropic catalogue uses normalized subscription and API-key metadata", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "sept-model-anthropic-"));
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const access = await ModelAccessService.create(agentDir, { runtime });
  const catalogue = await access.catalogue("anthropic");
  assert.equal(first(catalogue.providers).id, "anthropic");
  assert.deepEqual(first(catalogue.providers).authentication, {
    state: "authentication_required",
    methods: ["subscription", "api_key"],
  });
  assert.ok(catalogue.models.length > 0);
  assert.ok(
    catalogue.models.every(
      (entry) =>
        entry.api === "anthropic-messages" && entry.contextWindow > 0 && entry.maxOutputTokens > 0,
    ),
  );
});

await test("selection preflight persists only available authenticated model authority", async () => {
  const { access } = await fixture();
  const selected = await access.setPodDefault("ready-local", "alpha");
  assert.deepEqual(selected.selected, {
    provider: "ready-local",
    model: "alpha",
    source: "pod_default",
  });
  assert.equal(selected.available, true);
  assert.equal(selected.authenticated, true);
  assert.deepEqual(access.resolveSelection(), selected.selected);
  assert.deepEqual(access.resolveSelection({ provider: "ready-local", model: "alpha" }), {
    provider: "ready-local",
    model: "alpha",
    source: "explicit",
  });
  await assert.rejects(access.preflightSelection("login-local", "beta"), /unavailable/i);
  await assert.rejects(access.preflightSelection("ready-local", "missing"), /model not found/);
});

await test("injected fixtures and installed runtime construction use isolated Pi auth paths", async () => {
  const access = await testModelAccess();
  assert.deepEqual(await access.authenticationStatus("openai-codex"), {
    provider: "openai-codex",
    state: "authenticated",
    method: "api_key",
    methods: ["subscription", "api_key"],
  });
  const agentDir = mkdtempSync(join(tmpdir(), "sept-model-runtime-"));
  const runtime = await createPodModelRuntime(agentDir);
  assert.ok(runtime.getProvider("anthropic") !== undefined);
});
