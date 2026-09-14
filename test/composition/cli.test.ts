import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function waitForOutput(read: () => string, pattern: RegExp, timeoutMs = 15_000): Promise<RegExpMatchArray> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const poll = (): void => {
      const match = read().match(pattern);
      if (match) return resolvePromise(match);
      if (Date.now() - started >= timeoutMs) return reject(new Error(`output not observed: ${pattern}`));
      setTimeout(poll, 10).unref();
    };
    poll();
  });
}

test("clean build removes obsolete flat output before exercising the public worker", () => {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.clean, "node scripts/clean.mjs");
  assert.match(pkg.scripts.build, /^npm run clean && /);
  for (const stale of [
    "dist/src/controller.js", "dist/src/durable.js", "dist/src/pi.js", "dist/src/prompts.js", "dist/src/service.js", "dist/src/telemetry.js", "dist/src/types.js", "dist/src/webhook.js",
    "dist/test/cli-observability.test.js", "dist/test/controller.test.js", "dist/test/pi-sdk.test.js", "dist/test/telemetry.test.js", "dist/test/webhook.test.js",
  ]) assert.equal(existsSync(resolve(stale)), false, `stale build artifact remains: ${stale}`);
  assert.equal(existsSync(resolve("dist/src/cli.js")), true);
  assert.equal(existsSync(resolve("dist/src/runtime/index.js")), true);
});

test("public worker keeps stdout stable and emits JSON lifecycle logs on stderr", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-cli-telemetry-"));
  const state = join(root, "runs");
  const agent = join(root, "agent");
  mkdirSync(agent);
  const token = "CLI-SECRET-TOKEN";
  const child = spawn(resolve("sept"), ["worker", "--host", "127.0.0.1", "--port", "0", "--state-dir", state, "--agent-dir", agent], {
    cwd: process.cwd(),
    env: { ...process.env, SEPT_TOKEN: token, OTEL_SDK_DISABLED: "true", SEPT_WORKER_ID: "cli-test-worker" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
  child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
  try {
    const match = await waitForOutput(() => stdout, /SEPT Pi worker listening on http:\/\/127\.0\.0\.1:(\d+)\n/);
    const base = `http://127.0.0.1:${match[1]}`;
    assert.equal((await fetch(`${base}/health`)).status, 401);
    const response = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.equal((await fetch(`${base}/v1/tasks/unknown`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
    const competing = spawnSync(resolve("sept"), ["run", "--task", "must not start", "--workspace", process.cwd(), "--state-dir", state, "--agent-dir", agent], { cwd: process.cwd(), env: { ...process.env, OTEL_SDK_DISABLED: "true" }, encoding: "utf8" });
    assert.equal(competing.status, 1);
    assert.match(competing.stderr, /state root is already owned|ownership lease/);
    const rejectedWebhook = await fetch(`${base}/v1/webhooks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, kind: "unknown" }),
    });
    assert.equal(rejectedWebhook.status, 400);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    });
    child.kill("SIGTERM");
    const exit = await exited;
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(stdout, match[0]);
    const records = stderr.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(records.some((record) => record.lifecycle === "worker.started"));
    assert.ok(records.some((record) => record.lifecycle === "worker.stopped"));
    assert.ok(records.every((record) => record["service.name"] === "sept" && record["sept.worker.id"] === "cli-test-worker"));
    assert.doesNotMatch(stderr, new RegExp(token));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("public worker SIGTERM waits for an active production PiSessionHost checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-cli-graceful-"));
  const state = join(root, "runs");
  const agent = join(root, "agent");
  const workspace = join(root, "workspace");
  mkdirSync(agent);
  mkdirSync(workspace);
  let pendingResponse: ServerResponse | undefined;
  let markRequested!: () => void;
  const requested = new Promise<void>((resolvePromise) => { markRequested = resolvePromise; });
  const provider = createServer((request, response) => {
    request.resume();
    pendingResponse = response;
    markRequested();
  });
  await new Promise<void>((resolvePromise) => provider.listen(0, "127.0.0.1", resolvePromise));
  const providerAddress = provider.address();
  assert.ok(providerAddress && typeof providerAddress === "object");
  writeFileSync(join(agent, "models.json"), `${JSON.stringify({ providers: { "local-test": { baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`, api: "openai-completions", apiKey: "test-only", models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 200 }] } } })}\n`);

  const token = "graceful-cli-token";
  const child = spawn(resolve("sept"), ["worker", "--host", "127.0.0.1", "--port", "0", "--state-dir", state, "--agent-dir", agent, "--workspace-root", root], {
    cwd: process.cwd(), env: { ...process.env, SEPT_TOKEN: token, OTEL_SDK_DISABLED: "true" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
  child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
  try {
    const match = await waitForOutput(() => stdout, /http:\/\/127\.0\.0\.1:(\d+)/);
    const response = await fetch(`http://127.0.0.1:${match[1]}/v1/tasks`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ task: "checkpoint on signal", workspace, provider: "local-test", model: "fixture", thinking: "off", maxInvocations: 2 }),
    });
    assert.equal(response.status, 202);
    await requested;
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
    assert.equal(child.exitCode, null, "worker must not exit before the active Pi invocation settles");
    assert.equal(existsSync(join(state, "worker.lease")), true);

    const control = JSON.stringify({ status: "continue", summary: "signal-safe checkpoint", verification: ["provider replied"], next_action: "resume after restart" });
    pendingResponse!.writeHead(200, { "Content-Type": "text/event-stream" });
    pendingResponse!.write(`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: control }, finish_reason: null }] })}\n\n`);
    pendingResponse!.write(`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
    pendingResponse!.end("data: [DONE]\n\n");

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    });
    assert.deepEqual(exit, { code: 0, signal: null });
    const runDir = join(state, readdirSync(state).find((name) => !name.startsWith("."))!);
    const snapshot = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as { status: string };
    assert.equal(snapshot.status, "active");
    assert.match(readFileSync(join(runDir, "events.jsonl"), "utf8"), /"work_checkpoint"/);
    assert.equal(existsSync(join(state, "worker.lease")), false);
    assert.equal(existsSync(join(runDir, "controller.lease")), false);
    assert.doesNotMatch(stderr, /signal-safe checkpoint/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await new Promise<void>((resolvePromise, reject) => provider.close((error) => error ? reject(error) : resolvePromise()));
  }
});

test("CLI rejects bearer tokens and unknown options without echoing values", () => {
  const secret = "ARGV-SECRET-MUST-NOT-ECHO";
  const token = spawnSync(resolve("sept"), ["health", "--token", secret], { cwd: process.cwd(), env: { ...process.env, SEPT_TOKEN: "environment-only" }, encoding: "utf8" });
  assert.equal(token.status, 1);
  assert.match(token.stderr, /Unknown option --token/);
  assert.doesNotMatch(token.stderr, new RegExp(secret));
  const unknown = spawnSync(resolve("sept"), ["worker", "--surprise", "value"], { cwd: process.cwd(), env: { ...process.env, SEPT_TOKEN: "environment-only" }, encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option --surprise/);
});

test("declared Node floor matches the installed Pi runtime requirement", () => {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { engines: { node: string } };
  assert.equal(pkg.engines.node, ">=22.19.0");
});

test("container startup pins durable evidence and workspace confinement to production mounts", () => {
  const dockerfile = readFileSync(resolve("Dockerfile"), "utf8");
  const readme = readFileSync(resolve("README.md"), "utf8");
  assert.match(dockerfile, /SEPT_STATE_DIR=\/state\/runs/);
  assert.match(dockerfile, /"--state-dir", "\/state\/runs"/);
  assert.match(dockerfile, /SEPT_WORKSPACE_ROOT=\/workspace/);
  assert.match(dockerfile, /"--workspace-root", "\/workspace"/);
  assert.match(readme, /-v sept-state:\/state/);
});
