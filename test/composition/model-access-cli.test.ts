/**
 * Exercises installed model/auth CLI commands and fresh model selection at worker admission. Pi
 * owns credentials and provider calls; tests assert only credential-blind process projections.
 */

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  arrayField,
  closeServer,
  installedWorker,
  listen,
  openAiReply,
  parseRecord,
  record,
  responseRecord,
  stopInstalled,
  stringField,
  writeProvider,
} from "./cli-support.js";

function run(arguments_: string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync(resolve("sept"), arguments_, {
    cwd: process.cwd(),
    env: { ...process.env, OTEL_SDK_DISABLED: "true", SEPT_LOG_LEVEL: "silent" },
    input,
    encoding: "utf8",
  });
}

function prepareModelCli(): string {
  const root = mkdtempSync(join(tmpdir(), "sept-model-cli-"));
  const agent = join(root, "agent");
  mkdirSync(agent);
  writeProvider(agent, 9, "cli-local");
  return agent;
}

function validateAndList(agent: string): void {
  const validated = run(["models", "validate", "--agent-dir", agent]);
  assert.equal(validated.status, 0, validated.stderr);
  assert.deepEqual(parseRecord(validated.stdout), { configured: true, providers: 1, models: 1 });
  const before = run(["models", "list", "--agent-dir", agent, "--provider", "cli-local"]);
  assert.equal(before.status, 0, before.stderr);
  const catalogue = parseRecord(before.stdout, "model catalogue");
  const provider = record(arrayField(catalogue, "providers")[0], "provider");
  const authentication = record(provider.authentication, "authentication");
  const model = record(arrayField(catalogue, "models")[0], "model");
  assert.equal(authentication.state, "authentication_required");
  assert.equal(model.available, false);
}

function loginAndSelect(agent: string, entered: string): Record<string, unknown> {
  const login = run(
    ["auth", "login", "--agent-dir", agent, "--provider", "cli-local", "--method", "api-key"],
    `${entered}\n`,
  );
  assert.equal(login.status, 0, login.stderr);
  assert.equal(parseRecord(login.stdout).state, "authenticated");
  assert.doesNotMatch(login.stdout + login.stderr, new RegExp(entered));
  assert.equal(statSync(join(agent, "auth.json")).mode & 0o777, 0o600);
  const selected = run([
    "models",
    "select",
    "--agent-dir",
    agent,
    "--provider",
    "cli-local",
    "--model",
    "fixture",
  ]);
  assert.equal(selected.status, 0, selected.stderr);
  return parseRecord(selected.stdout, "model selection");
}

function verifySelectionAndLogout(
  agent: string,
  entered: string,
  selection: Record<string, unknown>,
): void {
  assert.deepEqual(record(selection.selected, "selected model"), {
    provider: "cli-local",
    model: "fixture",
    source: "pod_default",
  });
  assert.equal(selection.available, true);
  assert.equal(selection.authenticated, true);
  const current = run(["models", "current", "--agent-dir", agent]);
  assert.equal(current.status, 0, current.stderr);
  assert.deepEqual(parseRecord(current.stdout).selected, selection.selected);
  assert.equal(readFileSync(join(agent, "sept-model.json"), "utf8").includes(entered), false);
  const logout = run(["auth", "logout", "--agent-dir", agent, "--provider", "cli-local"]);
  assert.equal(logout.status, 0, logout.stderr);
  assert.equal(parseRecord(logout.stdout).state, "authentication_required");
  const unavailable = run(["models", "current", "--agent-dir", agent]);
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stderr, /unavailable.*authentication/i);
  assert.doesNotMatch(unavailable.stdout + unavailable.stderr, new RegExp(entered));
}

void test("installed CLI validates, authenticates, selects, reports, and logs out through Pi ModelRuntime", () => {
  const agent = prepareModelCli();
  const entered = "temporary-stdin-only-value";
  validateAndList(agent);
  verifySelectionAndLogout(agent, entered, loginAndSelect(agent, entered));
});

interface AdmissionFixture {
  agent: string;
  calls(): number;
  provider: Server;
  state: string;
  token: string;
  worker: ReturnType<typeof installedWorker>;
  workspace: string;
}

function modelDefinition(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

async function admissionFixture(): Promise<AdmissionFixture> {
  const root = mkdtempSync(join(tmpdir(), "sept-model-worker-"));
  const agent = join(root, "agent");
  const state = join(root, "runs");
  const workspace = join(root, "workspace");
  mkdirSync(agent);
  mkdirSync(workspace);
  let calls = 0;
  const provider = createServer((request, response) => {
    request.resume();
    calls += 1;
    openAiReply(
      response,
      JSON.stringify({
        message: `completed ${String(calls)}`,
        control: {
          status: "complete",
          summary: "done",
          verification: ["installed"],
          next_action: "",
        },
      }),
    );
  });
  const port = await listen(provider);
  writeModelDefinitions(agent, port);
  const token = "installed-model-worker-token";
  return {
    agent,
    provider,
    state,
    token,
    workspace,
    calls: () => calls,
    worker: installedWorker(state, agent, root, token),
  };
}

function writeModelDefinitions(agent: string, port: number): void {
  const endpoint = `http://127.0.0.1:${String(port)}/v1`;
  writeFileSync(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        ready: {
          baseUrl: endpoint,
          api: "openai-completions",
          apiKey: "local",
          models: [modelDefinition("alpha"), modelDefinition("beta")],
        },
        locked: {
          baseUrl: endpoint,
          api: "openai-completions",
          models: [modelDefinition("gamma")],
        },
      },
    }),
  );
}

async function waitForIdle(base: string, token: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const health = await fetch(`${base}/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if ((await responseRecord(health)).worker === "idle") {
      return;
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 20);
    });
  }
  assert.fail("installed worker condition not reached");
}

async function select(base: string, token: string, model: string): Promise<Response> {
  return fetch(`${base}/v1/model-access/selection`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "ready", model }),
  });
}

async function task(base: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${base}/v1/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function exerciseFreshDefaults(fixture: AdmissionFixture, base: string): Promise<void> {
  assert.equal((await select(base, fixture.token, "alpha")).status, 200);
  assert.equal(
    (await task(base, fixture.token, { task: "first default", workspace: fixture.workspace }))
      .status,
    202,
  );
  await waitForIdle(base, fixture.token);
  assert.equal((await select(base, fixture.token, "beta")).status, 200);
  assert.equal(
    (await task(base, fixture.token, { task: "second default", workspace: fixture.workspace }))
      .status,
    202,
  );
  await waitForIdle(base, fixture.token);
  assert.equal(
    (
      await task(base, fixture.token, {
        task: "explicit override",
        workspace: fixture.workspace,
        provider: "ready",
        model: "alpha",
      })
    ).status,
    202,
  );
  await waitForIdle(base, fixture.token);
}

async function exerciseWebhookAndRejection(fixture: AdmissionFixture, base: string): Promise<void> {
  const headers = { Authorization: `Bearer ${fixture.token}` };
  const webhook = await fetch(`${base}/v1/webhooks`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1,
      eventId: "installed-default",
      source: "test",
      kind: "task",
      task: { task: "webhook default", workspace: fixture.workspace },
    }),
  });
  assert.equal(webhook.status, 202);
  await waitForIdle(base, fixture.token);
  const locked = await task(base, fixture.token, {
    task: "reject locked",
    workspace: fixture.workspace,
    provider: "locked",
    model: "gamma",
  });
  assert.equal(locked.status, 400);
}

function verifyManifests(fixture: AdmissionFixture): void {
  const manifests = readdirSync(fixture.state, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "webhook-receipts")
    .map((entry) =>
      parseRecord(readFileSync(join(fixture.state, entry.name, "manifest.json"), "utf8")),
    );
  assert.deepEqual(
    Object.fromEntries(
      manifests.map((manifest) => [stringField(manifest, "task"), stringField(manifest, "model")]),
    ),
    {
      "first default": "alpha",
      "second default": "beta",
      "explicit override": "alpha",
      "webhook default": "beta",
    },
  );
  assert.equal(fixture.calls(), 4);
  assert.doesNotMatch(fixture.worker.stderr(), new RegExp(fixture.token));
}

async function freshDefaultsScenario(): Promise<void> {
  const fixture = await admissionFixture();
  try {
    const base = await fixture.worker.address;
    await exerciseFreshDefaults(fixture, base);
    await exerciseWebhookAndRejection(fixture, base);
    verifyManifests(fixture);
  } finally {
    await stopInstalled(fixture.worker.child);
    await closeServer(fixture.provider);
  }
}

void test(
  "installed worker preflights and resolves fresh defaults for direct and webhook admission",
  freshDefaultsScenario,
);
