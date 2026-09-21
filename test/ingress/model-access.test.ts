import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { listRuns, type Manifest } from "../../src/durable/index.js";
import { SeptService } from "../../src/ingress/index.js";
import { ModelAccessService } from "../../src/model-access/index.js";
import type { SessionHost, SessionRunResult } from "../../src/pi-integration/index.js";

const token = "model-route-token";
const auth = { Authorization: `Bearer ${token}` };
const complete: SessionRunResult = {
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
  sessionId = `session-${Math.random()}`;
  sessionFile: string | undefined;
  async run(): Promise<SessionRunResult> {
    return complete;
  }
  async newSession(): Promise<never> {
    throw new Error("unexpected replacement");
  }
  async abort(): Promise<void> {}
  async close(): Promise<void> {}
}

function model(id: string) {
  return {
    id,
    name: id.toUpperCase(),
    reasoning: false,
    input: ["text"] as Array<"text">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

async function environment() {
  const root = mkdtempSync(join(tmpdir(), "sept-model-routes-"));
  const agent = join(root, "agent");
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "runs");
  mkdirSync(agent);
  mkdirSync(workspace);
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
  const access = await ModelAccessService.create(agent, { runtime });
  const manifests: Manifest[] = [];
  const service = new SeptService({
    stateRoot,
    agentDir: agent,
    workspaceRoot: root,
    token,
    host: "127.0.0.1",
    port: 0,
    piVersion: "0.85.1",
    modelAccessService: access,
    hostFactory: async (manifest) => {
      manifests.push(manifest);
      return new Host();
    },
  });
  const address = await service.start();
  return {
    root,
    agent,
    workspace,
    stateRoot,
    manifests,
    service,
    base: `http://${address.host}:${address.port}`,
  };
}

async function json(base: string, path: string, method = "GET", value?: unknown, headers = auth) {
  return fetch(`${base}${path}`, {
    method,
    headers: value === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
}

async function waitIdle(base: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const response = await json(base, "/health");
    if (((await response.json()) as { worker: string }).worker === "idle") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("worker did not become idle");
}

test("authenticated model routes are strict, no-store, and credential-blind", async () => {
  const { service, base, workspace, stateRoot } = await environment();
  try {
    assert.equal((await fetch(`${base}/v1/model-access/providers`)).status, 401);
    const providers = await json(base, "/v1/model-access/providers");
    assert.equal(providers.status, 200);
    assert.equal(providers.headers.get("cache-control"), "no-store");
    const providerBody = (await providers.json()) as { providers: Array<Record<string, unknown>> };
    assert.ok(providerBody.providers.some((provider) => provider.id === "ready"));
    assert.deepEqual(
      Object.keys(providerBody.providers.find((provider) => provider.id === "ready")!).sort(),
      ["authentication", "availableModelCount", "id", "modelCount", "name"],
    );
    assert.equal(JSON.stringify(providerBody).includes('"apiKey"'), false);

    const models = await json(base, "/v1/model-access/models?provider=ready");
    const modelBody = (await models.json()) as { models: Array<Record<string, unknown>> };
    assert.equal(modelBody.models.length, 2);
    assert.deepEqual(Object.keys(modelBody.models[0]).sort(), [
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
    assert.equal(
      (
        await json(base, "/v1/model-access/selection", "PUT", {
          provider: "ready",
          model: "alpha",
          extra: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await json(base, "/v1/model-access/selection", "PUT", {
          provider: "locked",
          model: "gamma",
        })
      ).status,
      400,
    );
    const rejectedWebhook = await json(base, "/v1/webhooks", "POST", {
      version: 1,
      eventId: "locked",
      source: "test",
      kind: "task",
      task: { task: "must reject", workspace, provider: "locked", model: "gamma" },
    });
    assert.equal(rejectedWebhook.status, 400);
    assert.equal(existsSync(join(stateRoot, "webhook-receipts")), false);
  } finally {
    await service.stop();
  }
});

test("Pod defaults are read per direct and webhook admission while explicit pairs override without mutating old manifests", async () => {
  const { service, base, workspace, stateRoot, agent, manifests } = await environment();
  try {
    let selected = await json(base, "/v1/model-access/selection", "PUT", {
      provider: "ready",
      model: "alpha",
    });
    assert.equal(selected.status, 200);
    assert.deepEqual(((await selected.json()) as { selected: unknown }).selected, {
      provider: "ready",
      model: "alpha",
      source: "pod_default",
    });

    let task = await json(base, "/v1/tasks", "POST", { task: "first", workspace });
    assert.equal(task.status, 202);
    const firstId = ((await task.json()) as { runId: string }).runId;
    await waitIdle(base);
    assert.equal(
      listRuns(stateRoot)
        .find((run) => run.runId === firstId)!
        .manifest().model,
      "alpha",
    );

    selected = await json(base, "/v1/model-access/selection", "PUT", {
      provider: "ready",
      model: "beta",
    });
    assert.equal(selected.status, 200);
    task = await json(base, "/v1/tasks", "POST", { task: "second", workspace });
    assert.equal(task.status, 202);
    const secondId = ((await task.json()) as { runId: string }).runId;
    await waitIdle(base);
    assert.equal(
      listRuns(stateRoot)
        .find((run) => run.runId === secondId)!
        .manifest().model,
      "beta",
    );
    assert.equal(
      listRuns(stateRoot)
        .find((run) => run.runId === firstId)!
        .manifest().model,
      "alpha",
    );

    task = await json(base, "/v1/tasks", "POST", {
      task: "explicit",
      workspace,
      provider: "ready",
      model: "alpha",
    });
    assert.equal(task.status, 202);
    await waitIdle(base);
    assert.equal(manifests.at(-1)!.model, "alpha");
    assert.equal(
      (await json(base, "/v1/tasks", "POST", { task: "half", workspace, provider: "ready" }))
        .status,
      400,
    );

    const webhook = await json(base, "/v1/webhooks", "POST", {
      version: 1,
      eventId: "fresh-default",
      source: "test",
      kind: "task",
      task: { task: "webhook default", workspace },
    });
    assert.equal(webhook.status, 202);
    const webhookId = ((await webhook.json()) as { runId: string }).runId;
    await waitIdle(base);
    assert.equal(
      listRuns(stateRoot)
        .find((run) => run.runId === webhookId)!
        .manifest().model,
      "beta",
    );
    assert.deepEqual(JSON.parse(readFileSync(join(agent, "sept-model.json"), "utf8")), {
      formatVersion: 1,
      provider: "ready",
      model: "beta",
    });
  } finally {
    await service.stop();
  }
});
