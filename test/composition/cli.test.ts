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

function openAiReply(response: ServerResponse, text: string, promptTokens = 10): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-part1", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-part1", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function installedWorker(state: string, agent: string, workspaceRoot: string, token: string) {
  const child = spawn(resolve("sept"), ["worker", "--host", "127.0.0.1", "--port", "0", "--state-dir", state, "--agent-dir", agent, "--workspace-root", workspaceRoot], {
    cwd: process.cwd(), env: { ...process.env, SEPT_TOKEN: token, OTEL_SDK_DISABLED: "true", SEPT_LOG_LEVEL: "silent" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
  child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
  const address = waitForOutput(() => stdout, /http:\/\/127\.0\.0\.1:(\d+)/).then((match) => `http://127.0.0.1:${match[1]}`);
  return { child, address, stderr: () => stderr };
}

async function stopInstalled(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise, reject) => { child.once("error", reject); child.once("exit", () => resolvePromise()); });
  child.kill("SIGTERM");
  await exited;
}

async function killInstalled(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise, reject) => { child.once("error", reject); child.once("exit", () => resolvePromise()); });
  child.kill("SIGKILL");
  await exited;
}

async function waitForTask(base: string, runId: string, token: string, expected: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (true) {
    const result = await fetch(`${base}/v1/tasks/${runId}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await result.json() as { state: { status: string } };
    if (body.state.status === expected) return;
    if (Date.now() >= deadline) throw new Error(`run did not reach ${expected}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
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

test("installed worker preserves conversation through Pi rotation and restart while drain is active", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-cli-part1-conversation-"));
  const state = join(root, "runs");
  const agent = join(root, "agent");
  const workspace = join(root, "workspace");
  mkdirSync(agent); mkdirSync(workspace);
  let providerCalls = 0;
  let markInterrupted!: () => void;
  const interrupted = new Promise<void>((resolvePromise) => { markInterrupted = resolvePromise; });
  const provider = createServer((request, response) => {
    request.resume();
    providerCalls++;
    const progress = JSON.stringify({ message: "Progress remains visible across rotation.", control: { status: "continue", summary: "rotate", verification: ["provider usage"], next_action: "Continue after rotation." } });
    const handover = JSON.stringify({ handover_summary: "rotated", entry_state_and_done: "finish the installed conversation", completed: ["progress published"], in_flight: [], not_started: ["follow-up"], decisions: [], rejected_approaches: [], verification: ["provider usage"], uncertainties: [], references: [], lessons: [], next_action: "Wait safely for operator input." });
    const waiting = JSON.stringify({ message: "Waiting safely for your follow-up.", control: { status: "waiting", summary: "waiting", verification: ["checkpointed"], next_action: "Wait for input." } });
    const complete = JSON.stringify({ message: "The installed conversation is complete.", control: { status: "complete", summary: "done", verification: ["installed path"], next_action: "" } });
    if (providerCalls === 1) return openAiReply(response, progress, 800);
    if (providerCalls === 2) return openAiReply(response, handover);
    if (providerCalls === 3) return openAiReply(response, waiting);
    if (providerCalls === 4) { markInterrupted(); return; }
    return openAiReply(response, complete);
  });
  await new Promise<void>((resolvePromise) => provider.listen(0, "127.0.0.1", resolvePromise));
  const providerAddress = provider.address();
  assert.ok(providerAddress && typeof providerAddress === "object");
  writeFileSync(join(agent, "models.json"), `${JSON.stringify({ providers: { "local-part1": { baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`, api: "openai-completions", apiKey: "test-only", models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 200 }] } } })}\n`);
  const token = "installed-part1-conversation-token";
  const first = installedWorker(state, agent, root, token);
  let second: ReturnType<typeof installedWorker> | undefined;
  let third: ReturnType<typeof installedWorker> | undefined;
  try {
    const firstBase = await first.address;
    const taskText = "  installed initial message\nexact  ";
    const task = await fetch(`${firstBase}/v1/tasks`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ task: taskText, workspace, provider: "local-part1", model: "fixture", thinking: "off" }) });
    assert.equal(task.status, 202);
    const runId = (await task.json() as { runId: string }).runId;
    await waitForTask(firstBase, runId, token, "waiting");
    const replay = await fetch(`${firstBase}/v1/tasks/${runId}/conversation?limit=250`, { headers: { Authorization: `Bearer ${token}` } });
    const firstPage = await replay.json() as { events: Array<{ cursor: number; text?: string }>; nextCursor: number };
    assert.equal(firstPage.events[0].text, taskText);
    assert.equal(firstPage.events[1].text, "Progress remains visible across rotation.");
    assert.equal(firstPage.events[2].text, "Waiting safely for your follow-up.");
    const events = readFileSync(join(state, runId, "events.jsonl"), "utf8");
    assert.match(events, /"rotation_steer_queued"/);
    assert.match(events, /"successor_session_started"/);
    await stopInstalled(first.child);

    second = installedWorker(state, agent, root, token);
    const secondBase = await second.address;
    const interruptedStream = fetch(`${secondBase}/v1/tasks/${runId}/stream?after=${firstPage.nextCursor}`, { headers: { Authorization: `Bearer ${token}` } }).then((result) => result.text()).catch(() => "");
    const followUp = "  exact installed follow-up\t  ";
    const message = await fetch(`${secondBase}/v1/tasks/${runId}/messages`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ message: followUp }) });
    assert.equal(message.status, 202);
    await interrupted;
    const drain = await fetch(`${secondBase}/v1/drain`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await drain.json() as { readiness: string }).readiness, "draining");
    await killInstalled(second.child);
    await interruptedStream;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_200));

    third = installedWorker(state, agent, root, token);
    const thirdBase = await third.address;
    const resumed = await fetch(`${thirdBase}/v1/tasks/${runId}/stream?after=${firstPage.nextCursor}`, { headers: { Authorization: `Bearer ${token}` } });
    const resumedText = await resumed.text();
    assert.match(resumedText, /event: terminal/);
    await waitForTask(thirdBase, runId, token, "complete");
    const health = await fetch(`${thirdBase}/health`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await health.json() as { readiness: string }).readiness, "drained");
    const tail = await fetch(`${thirdBase}/v1/tasks/${runId}/conversation?after=${firstPage.nextCursor}&limit=250`, { headers: { Authorization: `Bearer ${token}` } });
    const tailPage = await tail.json() as { events: Array<{ role?: string; text?: string }>; terminal: { status: string } };
    assert.equal(tailPage.events.find((event) => event.role === "user")?.text, followUp);
    assert.equal(tailPage.events.find((event) => event.role === "assistant")?.text, "The installed conversation is complete.");
    assert.equal(tailPage.terminal.status, "complete");
    assert.equal(providerCalls, 5);
    assert.doesNotMatch(first.stderr() + second.stderr() + third.stderr(), new RegExp(token));
    await stopInstalled(third.child);
    const direct = spawnSync(resolve("sept"), ["run", "--task", "must remain drained", "--workspace", workspace, "--state-dir", state, "--agent-dir", agent], { cwd: process.cwd(), env: { ...process.env, OTEL_SDK_DISABLED: "true", SEPT_LOG_LEVEL: "silent" }, encoding: "utf8" });
    assert.equal(direct.status, 1);
    assert.match(direct.stderr, /drained and not accepting/);
  } finally {
    await stopInstalled(first.child);
    if (second) await stopInstalled(second.child);
    if (third) await stopInstalled(third.child);
    await new Promise<void>((resolvePromise, reject) => provider.close((error) => error ? reject(error) : resolvePromise()));
  }
});

test("installed worker cancellation aborts active production Pi model work after durable intent", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-cli-part1-cancel-"));
  const state = join(root, "runs");
  const agent = join(root, "agent");
  const workspace = join(root, "workspace");
  mkdirSync(agent); mkdirSync(workspace);
  let markRequested!: () => void;
  const requested = new Promise<void>((resolvePromise) => { markRequested = resolvePromise; });
  let providerResponseAborted = false;
  const provider = createServer((request, response) => {
    response.once("close", () => { if (!response.writableEnded) providerResponseAborted = true; });
    request.once("end", markRequested);
    request.resume();
  });
  await new Promise<void>((resolvePromise) => provider.listen(0, "127.0.0.1", resolvePromise));
  const providerAddress = provider.address();
  assert.ok(providerAddress && typeof providerAddress === "object");
  writeFileSync(join(agent, "models.json"), `${JSON.stringify({ providers: { "local-cancel": { baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`, api: "openai-completions", apiKey: "test-only", models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 200 }] } } })}\n`);
  const token = "installed-part1-cancel-token";
  const worker = installedWorker(state, agent, root, token);
  try {
    const base = await worker.address;
    const task = await fetch(`${base}/v1/tasks`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ task: "cancel the installed model request", workspace, provider: "local-cancel", model: "fixture", thinking: "off" }) });
    const runId = (await task.json() as { runId: string }).runId;
    await requested;
    const cancel = await fetch(`${base}/v1/tasks/${runId}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    assert.ok(cancel.status === 200 || cancel.status === 202);
    await waitForTask(base, runId, token, "cancelled");
    const events = readFileSync(join(state, runId, "events.jsonl"), "utf8");
    assert.ok(events.indexOf("run_cancellation_requested") < events.indexOf("run_cancelled"));
    assert.doesNotMatch(events, /run_completed/);
    const transcript = await fetch(`${base}/v1/tasks/${runId}/conversation`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await transcript.json() as { terminal: { status: string } }).terminal.status, "cancelled");
    const deadline = Date.now() + 4_000;
    while (!providerResponseAborted && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    assert.equal(providerResponseAborted, true, "native Pi abort must close the unfinished provider response after its request body was consumed");
    assert.doesNotMatch(worker.stderr(), new RegExp(token));
  } finally {
    await stopInstalled(worker.child);
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
