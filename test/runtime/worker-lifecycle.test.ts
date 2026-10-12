/**
 * Verifies state-root ownership, restart adoption, graceful shutdown, and bounded worker evidence.
 * HTTP composition drives the real WorkerRuntime while injected hosts remain subordinate fixtures.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunStore } from "../../src/durable/index.js";
import { SeptService } from "../../src/ingress/index.js";
import { testModelAccess } from "../support/model-access.js";
import { nativeFixtureFactory } from "../support/native-identity.js";
import {
  complete,
  FakeHost,
  GracefulStopHost,
  controllerFixture,
  responseJson,
} from "./support.js";

void test("worker fails closed and reports authenticated idle health", async () => {
  const { root } = controllerFixture();
  const service = new SeptService({
    stateRoot: join(root, "empty-runs"),
    agentDir: "/pi",
    token: "secret",
    port: 0,
    piVersion: "0.85.1",
    modelAccessService: await testModelAccess(),
  });
  const address = await service.start();
  try {
    const base = `http://${address.host}:${String(address.port)}`;
    assert.equal((await fetch(`${base}/health`)).status, 401);
    const response = await fetch(`${base}/health`, { headers: { Authorization: "Bearer secret" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      worker: "idle",
      readiness: "accepting",
      acceptingWork: true,
      activeRunId: null,
      runtime: "pi-sdk",
    });
  } finally {
    await service.stop();
  }
});

void test("worker ignores legacy manifest-only run directories without changing them", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-legacy-state-"));
  const stateRoot = join(root, "runs");
  const legacyDir = join(stateRoot, "legacy-run");
  mkdirSync(legacyDir, { recursive: true });
  const legacyManifest = `${JSON.stringify({ run_id: "legacy-run", task: "historical" })}\n`;
  const legacyEvents = `${JSON.stringify({ type: "legacy_event" })}\n`;
  writeFileSync(join(legacyDir, "manifest.json"), legacyManifest);
  writeFileSync(join(legacyDir, "events.jsonl"), legacyEvents);

  const service = new SeptService({
    stateRoot,
    agentDir: "/pi",
    token: "secret",
    port: 0,
    piVersion: "0.85.1",
    modelAccessService: await testModelAccess(),
  });
  const address = await service.start();
  try {
    const response = await fetch(`http://${address.host}:${String(address.port)}/health`, {
      headers: { Authorization: "Bearer secret" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      worker: "idle",
      readiness: "accepting",
      acceptingWork: true,
      activeRunId: null,
      runtime: "pi-sdk",
    });
    assert.equal(readFileSync(join(legacyDir, "manifest.json"), "utf8"), legacyManifest);
    assert.equal(readFileSync(join(legacyDir, "events.jsonl"), "utf8"), legacyEvents);
  } finally {
    await service.stop();
  }
});

void test("worker keeps its single slot busy while waiting to adopt a recent lease", async () => {
  const { root, store } = controllerFixture();
  writeFileSync(
    store.leasePath,
    `${JSON.stringify({ ownerId: "previous", pid: 999_999, hostname: hostname(), processStartedAt: 1, heartbeatAt: new Date().toISOString() })}\n`,
  );
  const almostStale = new Date(Date.now() - 4_500);
  utimesSync(store.leasePath, almostStale, almostStale);
  const host = new FakeHost([
    { text: JSON.stringify(complete), steered: false, contextTokens: 10, contextWindow: 100 },
  ]);
  const service = new SeptService({
    stateRoot: join(root, "runs"),
    agentDir: "/pi",
    workspaceRoot: root,
    token: "secret",
    port: 0,
    piVersion: "0.85.1",
    hostFactory: nativeFixtureFactory(() => Promise.resolve(host)),
    modelAccessService: await testModelAccess(),
  });
  const address = await service.start();
  try {
    const base = `http://${address.host}:${String(address.port)}`;
    const health = await fetch(`${base}/health`, { headers: { Authorization: "Bearer secret" } });
    assert.equal((await responseJson<{ worker: string }>(health)).worker, "busy");
    const create = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ task: "must be rejected while adoption is pending" }),
    });
    assert.equal(create.status, 409);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(store.snapshot().status, "complete");
  } finally {
    await service.stop();
  }
});

async function gracefulFixture(): Promise<{
  service: SeptService;
  host: GracefulStopHost;
  workspace: string;
  stateRoot: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "sept-graceful-stop-"));
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "runs");
  mkdirSync(workspace);
  const host = new GracefulStopHost();
  const service = new SeptService({
    stateRoot,
    agentDir: "/pi",
    workspaceRoot: root,
    token: "secret",
    host: "127.0.0.1",
    port: 0,
    piVersion: "0.85.1",
    hostFactory: nativeFixtureFactory(() => Promise.resolve(host)),
    modelAccessService: await testModelAccess(),
  });
  return { service, host, workspace, stateRoot };
}

void test("graceful service stop rejects admission and waits for one durable controller boundary before releasing ownership", async () => {
  const { service, host, workspace, stateRoot } = await gracefulFixture();
  const address = await service.start();
  const task = await fetch(`http://${address.host}:${String(address.port)}/v1/tasks`, {
    method: "POST",
    headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
    body: JSON.stringify({ task: "checkpoint before stop", workspace }),
  });
  assert.equal(task.status, 202);
  const { runId } = await responseJson<{ runId: string }>(task);
  while (!host.prompts.length) await new Promise((resolve) => setTimeout(resolve, 5));
  let stopped = false;
  const stopping = service.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(stopped, false);
  assert.equal(existsSync(join(stateRoot, "worker.lease")), true);
  host.release();
  await stopping;
  const store = new RunStore(join(stateRoot, runId));
  assert.equal(host.closed, true);
  assert.equal(store.snapshot().status, "active");
  assert.equal(store.events(0, 1000).filter((event) => event.type === "work_checkpoint").length, 1);
  assert.equal(existsSync(store.leasePath), false);
  assert.equal(existsSync(join(stateRoot, "worker.lease")), false);
});

void test("only one service can own a state root and ownership is released on stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-root-owner-"));
  const stateRoot = join(root, "runs");
  const first = new SeptService({
    stateRoot,
    agentDir: "/pi",
    workspaceRoot: root,
    token: "secret",
    host: "127.0.0.1",
    port: 0,
    piVersion: "0.85.1",
    modelAccessService: await testModelAccess(),
  });
  await first.start();
  const second = new SeptService({
    stateRoot,
    agentDir: "/pi",
    workspaceRoot: root,
    token: "secret",
    host: "127.0.0.1",
    port: 0,
    piVersion: "0.85.1",
    modelAccessService: await testModelAccess(),
  });
  await assert.rejects(second.start(), /state root is already owned|ownership lease/);
  await first.stop();
  const successor = new SeptService({
    stateRoot,
    agentDir: "/pi",
    workspaceRoot: root,
    token: "secret",
    host: "127.0.0.1",
    port: 0,
    piVersion: "0.85.1",
    modelAccessService: await testModelAccess(),
  });
  await successor.start();
  await successor.stop();
});

void test("bounded log endpoint storage truncates old records", () => {
  const { store } = controllerFixture();
  for (let i = 0; i < 40; i++) store.log({ text: "x".repeat(200), i }, 2048);
  assert.ok(readFileSync(store.logPath).byteLength <= 2048);
});
