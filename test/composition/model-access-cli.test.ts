import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";

function run(args: string[], input?: string) {
  return spawnSync(resolve("sept"), args, { cwd: process.cwd(), env: { ...process.env, OTEL_SDK_DISABLED: "true", SEPT_LOG_LEVEL: "silent" }, input, encoding: "utf8" });
}

test("installed CLI validates, authenticates, selects, reports, and logs out through Pi ModelRuntime", () => {
  const root = mkdtempSync(join(tmpdir(), "sept-model-cli-"));
  const agent = join(root, "agent"); mkdirSync(agent);
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { "cli-local": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "fixture", name: "CLI fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192 }] } } }));

  const validated = run(["models", "validate", "--agent-dir", agent]);
  assert.equal(validated.status, 0, validated.stderr);
  assert.deepEqual(JSON.parse(validated.stdout), { configured: true, providers: 1, models: 1 });

  const before = run(["models", "list", "--agent-dir", agent, "--provider", "cli-local"]);
  assert.equal(before.status, 0, before.stderr);
  const catalogue = JSON.parse(before.stdout) as { providers: Array<{ authentication: { state: string } }>; models: Array<{ available: boolean }> };
  assert.equal(catalogue.providers[0].authentication.state, "authentication_required");
  assert.equal(catalogue.models[0].available, false);

  const entered = "temporary-stdin-only-value";
  const login = run(["auth", "login", "--agent-dir", agent, "--provider", "cli-local", "--method", "api-key"], `${entered}\n`);
  assert.equal(login.status, 0, login.stderr);
  assert.equal((JSON.parse(login.stdout) as { state: string }).state, "authenticated");
  assert.doesNotMatch(login.stdout + login.stderr, new RegExp(entered));
  assert.equal(statSync(join(agent, "auth.json")).mode & 0o777, 0o600);

  const select = run(["models", "select", "--agent-dir", agent, "--provider", "cli-local", "--model", "fixture"]);
  assert.equal(select.status, 0, select.stderr);
  const selection = JSON.parse(select.stdout) as { selected: { provider: string; model: string; source: string }; available: boolean; authenticated: boolean };
  assert.deepEqual(selection.selected, { provider: "cli-local", model: "fixture", source: "pod_default" });
  assert.equal(selection.available, true); assert.equal(selection.authenticated, true);

  const current = run(["models", "current", "--agent-dir", agent]);
  assert.equal(current.status, 0, current.stderr);
  assert.deepEqual((JSON.parse(current.stdout) as { selected: unknown }).selected, selection.selected);
  assert.equal(readFileSync(join(agent, "sept-model.json"), "utf8").includes(entered), false);

  const logout = run(["auth", "logout", "--agent-dir", agent, "--provider", "cli-local"]);
  assert.equal(logout.status, 0, logout.stderr);
  assert.equal((JSON.parse(logout.stdout) as { state: string }).state, "authentication_required");
  const unavailable = run(["models", "current", "--agent-dir", agent]);
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stderr, /unavailable.*authentication/i);
  assert.doesNotMatch(unavailable.stdout + unavailable.stderr, new RegExp(entered));
});

test("installed worker preflights and resolves fresh defaults for direct and webhook admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-model-worker-"));
  const agent = join(root, "agent"); const state = join(root, "runs"); const workspace = join(root, "workspace");
  mkdirSync(agent); mkdirSync(workspace);
  let calls = 0;
  const provider = createServer((request, response) => {
    request.resume(); calls++;
    const content = JSON.stringify({ message: `completed ${calls}`, control: { status: "complete", summary: "done", verification: ["installed"], next_action: "" } });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: `call-${calls}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: `call-${calls}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolvePromise) => provider.listen(0, "127.0.0.1", resolvePromise));
  const address = provider.address(); assert.ok(address && typeof address === "object");
  const definition = (id: string) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192 });
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: {
    ready: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local", models: [definition("alpha"), definition("beta")] },
    locked: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", models: [definition("gamma")] },
  } }));
  const workerToken = "installed-model-worker-token";
  const child = spawn(resolve("sept"), ["worker", "--host", "127.0.0.1", "--port", "0", "--state-dir", state, "--agent-dir", agent, "--workspace-root", root], { cwd: process.cwd(), env: { ...process.env, SEPT_TOKEN: workerToken, OTEL_SDK_DISABLED: "true", SEPT_LOG_LEVEL: "silent" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value; }); child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
  const headers = { Authorization: `Bearer ${workerToken}` };
  const wait = async (predicate: () => Promise<boolean>) => { const deadline = Date.now() + 10_000; while (!await predicate()) { if (Date.now() > deadline) throw new Error("installed worker condition not reached"); await new Promise((resolvePromise) => setTimeout(resolvePromise, 20)); } };
  try {
    await wait(async () => /http:\/\/127\.0\.0\.1:\d+/.test(stdout));
    const port = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/)![1]; const base = `http://127.0.0.1:${port}`;
    const put = (model: string) => fetch(`${base}/v1/model-access/selection`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ provider: "ready", model }) });
    const task = (body: unknown) => fetch(`${base}/v1/tasks`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await put("alpha")).status, 200);
    assert.equal((await task({ task: "first default", workspace })).status, 202);
    await wait(async () => (await (await fetch(`${base}/health`, { headers })).json() as { worker: string }).worker === "idle");
    assert.equal((await put("beta")).status, 200);
    assert.equal((await task({ task: "second default", workspace })).status, 202);
    await wait(async () => (await (await fetch(`${base}/health`, { headers })).json() as { worker: string }).worker === "idle");
    assert.equal((await task({ task: "explicit override", workspace, provider: "ready", model: "alpha" })).status, 202);
    await wait(async () => (await (await fetch(`${base}/health`, { headers })).json() as { worker: string }).worker === "idle");
    const webhook = await fetch(`${base}/v1/webhooks`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, eventId: "installed-default", source: "test", kind: "task", task: { task: "webhook default", workspace } }) });
    assert.equal(webhook.status, 202);
    await wait(async () => (await (await fetch(`${base}/health`, { headers })).json() as { worker: string }).worker === "idle");
    assert.equal((await task({ task: "reject locked", workspace, provider: "locked", model: "gamma" })).status, 400);
    const manifests = readdirSync(state, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== "webhook-receipts").map((entry) => JSON.parse(readFileSync(join(state, entry.name, "manifest.json"), "utf8")) as { task: string; model: string });
    assert.deepEqual(Object.fromEntries(manifests.map((manifest) => [manifest.task, manifest.model])), { "first default": "alpha", "second default": "beta", "explicit override": "alpha", "webhook default": "beta" });
    assert.equal(calls, 4);
    assert.doesNotMatch(stderr, new RegExp(workerToken));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())); child.kill("SIGTERM"); await exited; }
    await new Promise<void>((resolvePromise, reject) => provider.close((error) => error ? reject(error) : resolvePromise()));
  }
});
