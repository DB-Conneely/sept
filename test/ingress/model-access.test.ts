/**
 * Exercises authenticated model-access HTTP composition and per-admission Pod selection. The
 * fixture uses the real Pi ModelRuntime while keeping provider credentials and network calls local.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { listRuns, SeptError, type Manifest, type RunStore } from "../../src/durable/index.js";
import { SeptService } from "../../src/ingress/index.js";
import { ModelAccessService } from "../../src/model-access/index.js";
import type { SessionHost, SessionRunResult } from "../../src/pi-integration/index.js";
import { jsonRecord, recordArray, stringField } from "./webhook-support.js";

const TOKEN = "model-route-token";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const COMPLETE: SessionRunResult = {
  text: JSON.stringify({
    status: "complete",
    summary: "done",
    verification: ["ok"],
    next_action: "",
  }),
  steered: false,
  contextTokens: 10,
  contextWindow: 128_000,
};

class Host implements SessionHost {
  public sessionId = `session-${String(Math.random())}`;
  public sessionFile: string | undefined;

  public run(): Promise<SessionRunResult> {
    return Promise.resolve(COMPLETE);
  }

  public newSession(): Promise<never> {
    return Promise.reject(new SeptError("unexpected replacement"));
  }

  public abort(): Promise<void> {
    return Promise.resolve();
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

function model(id: string) {
  return {
    id,
    name: id.toUpperCase(),
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

async function modelAccess(agent: string): Promise<ModelAccessService> {
  const runtime = await ModelRuntime.create({
    authPath: join(agent, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("ready", {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "local",
    api: "openai-completions",
    models: [model("alpha"), model("beta")],
  });
  runtime.registerProvider("locked", {
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    models: [model("gamma")],
  });
  return ModelAccessService.create(agent, { runtime });
}

async function environment() {
  const root = mkdtempSync(join(tmpdir(), "sept-model-routes-"));
  const agent = join(root, "agent");
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "runs");
  mkdirSync(agent);
  mkdirSync(workspace);
  const manifests: Manifest[] = [];
  const service = new SeptService({
    stateRoot,
    agentDir: agent,
    workspaceRoot: root,
    token: TOKEN,
    host: "127.0.0.1",
    port: 0,
    piVersion: "0.85.1",
    modelAccessService: await modelAccess(agent),
    hostFactory: (manifest) => {
      manifests.push(manifest);
      return Promise.resolve(new Host());
    },
  });
  const address = await service.start();
  return {
    agent,
    workspace,
    stateRoot,
    manifests,
    service,
    base: `http://${address.host}:${String(address.port)}`,
  };
}

async function json(
  base: string,
  path: string,
  method = "GET",
  value?: unknown,
  headers = AUTH,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: value === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  };
  return fetch(`${base}${path}`, init);
}

function runById(stateRoot: string, runId: string): RunStore {
  const run = listRuns(stateRoot).find((candidate) => candidate.runId === runId);
  assert.ok(run);
  return run;
}

async function waitIdle(base: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const response = await json(base, "/health");
    if ((await jsonRecord(response)).worker === "idle") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new SeptError("worker did not become idle");
}

async function assertCatalogueRoutes(base: string): Promise<void> {
  assert.equal((await fetch(`${base}/v1/model-access/providers`)).status, 401);
  const providers = await json(base, "/v1/model-access/providers");
  assert.equal(providers.status, 200);
  assert.equal(providers.headers.get("cache-control"), "no-store");
  const providerBody = await jsonRecord(providers);
  const ready = recordArray(providerBody.providers).find((provider) => provider.id === "ready");
  assert.ok(ready);
  assert.deepEqual(Object.keys(ready).sort(), [
    "authentication",
    "availableModelCount",
    "id",
    "modelCount",
    "name",
  ]);
  assert.equal(JSON.stringify(providerBody).includes('"apiKey"'), false);
}

async function assertModelRoutes(base: string): Promise<void> {
  const models = await json(base, "/v1/model-access/models?provider=ready");
  const modelBody = await jsonRecord(models);
  const modelRecords = recordArray(modelBody.models);
  assert.equal(modelRecords.length, 2);
  const first = modelRecords[0];
  assert.ok(first);
  assert.deepEqual(Object.keys(first).sort(), [
    "api",
    "available",
    "capabilities",
    "contextWindow",
    "id",
    "maxOutputTokens",
    "name",
    "provider",
  ]);
  assert.equal(
    (await json(base, "/v1/model-access/models?provider=ready&provider=locked")).status,
    400,
  );
  assert.equal((await json(base, "/v1/model-access/providers?extra=true")).status, 400);
}

async function assertRejectedSelections(base: string, workspace: string): Promise<void> {
  const extra = await json(base, "/v1/model-access/selection", "PUT", {
    provider: "ready",
    model: "alpha",
    extra: true,
  });
  assert.equal(extra.status, 400);
  const locked = await json(base, "/v1/model-access/selection", "PUT", {
    provider: "locked",
    model: "gamma",
  });
  assert.equal(locked.status, 400);
  const webhook = await json(base, "/v1/webhooks", "POST", {
    version: 1,
    eventId: "locked",
    source: "test",
    kind: "task",
    task: { task: "must reject", workspace, provider: "locked", model: "gamma" },
  });
  assert.equal(webhook.status, 400);
}

void test("authenticated model routes are strict, no-store, and credential-blind", async () => {
  const { service, base, workspace, stateRoot } = await environment();
  try {
    await assertCatalogueRoutes(base);
    await assertModelRoutes(base);
    await assertRejectedSelections(base, workspace);
    assert.equal(existsSync(join(stateRoot, "webhook-receipts")), false);
  } finally {
    await service.stop();
  }
});

async function setDefault(base: string, modelName: string): Promise<void> {
  const response = await json(base, "/v1/model-access/selection", "PUT", {
    provider: "ready",
    model: modelName,
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await jsonRecord(response)).selected, {
    provider: "ready",
    model: modelName,
    source: "pod_default",
  });
}

async function createTask(base: string, workspace: string, task: string): Promise<string> {
  const response = await json(base, "/v1/tasks", "POST", { task, workspace });
  assert.equal(response.status, 202);
  return stringField(await jsonRecord(response), "runId");
}

void test("Pod defaults are read per admission while explicit pairs do not mutate history", async () => {
  const context = await environment();
  const { service, base, workspace, stateRoot, agent, manifests } = context;
  try {
    await setDefault(base, "alpha");
    const firstId = await createTask(base, workspace, "first");
    await waitIdle(base);
    assert.equal(runById(stateRoot, firstId).manifest().model, "alpha");

    await setDefault(base, "beta");
    const secondId = await createTask(base, workspace, "second");
    await waitIdle(base);
    assert.equal(runById(stateRoot, secondId).manifest().model, "beta");
    assert.equal(runById(stateRoot, firstId).manifest().model, "alpha");

    await assertExplicitAndWebhook(context);
    const storedSelection: unknown = JSON.parse(
      readFileSync(join(agent, "sept-model.json"), "utf8"),
    );
    assert.deepEqual(storedSelection, {
      formatVersion: 1,
      provider: "ready",
      model: "beta",
    });
    assert.equal(manifests.at(-1)?.model, "beta");
  } finally {
    await service.stop();
  }
});

async function assertExplicitAndWebhook(
  context: Awaited<ReturnType<typeof environment>>,
): Promise<void> {
  const { base, workspace, stateRoot, manifests } = context;
  const explicit = await json(base, "/v1/tasks", "POST", {
    task: "explicit",
    workspace,
    provider: "ready",
    model: "alpha",
  });
  assert.equal(explicit.status, 202);
  await waitIdle(base);
  assert.equal(manifests.at(-1)?.model, "alpha");
  const half = await json(base, "/v1/tasks", "POST", {
    task: "half",
    workspace,
    provider: "ready",
  });
  assert.equal(half.status, 400);

  const webhook = await json(base, "/v1/webhooks", "POST", {
    version: 1,
    eventId: "fresh-default",
    source: "test",
    kind: "task",
    task: { task: "webhook default", workspace },
  });
  assert.equal(webhook.status, 202);
  const webhookId = stringField(await jsonRecord(webhook), "runId");
  await waitIdle(base);
  assert.equal(runById(stateRoot, webhookId).manifest().model, "beta");
}
