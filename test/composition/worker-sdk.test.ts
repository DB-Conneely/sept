/** Complete factory contracts use the real HTTP router, durable owners, Pi and supplied Docker hands. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SeptError } from "../../src/durable/index.js";
import { createTelemetry } from "../../src/observability/index.js";
import { packageMetadata } from "../../src/package-metadata.js";
import { createWorker, type Worker, type WorkerOptions } from "../../src/worker/index.js";
import {
  closeServer,
  listen,
  openAiReply,
  prepareDirectories,
  record,
  responseRecord,
  stringField,
  waitForTask,
  writeProvider,
} from "./cli-support.js";
import { activateHandsPolicy, supplyHands, type SuppliedHands } from "./hands-support.js";
import { base, headers, projection, assertMessageEvidence } from "./worker-sdk-support.js";

function options(): WorkerOptions {
  const root = mkdtempSync(join(tmpdir(), "sept-worker-sdk-"));
  const directories = prepareDirectories(root);
  return {
    stateRoot: directories.state,
    agentDir: directories.agent,
    workspaceRoot: directories.workspace,
    token: "SDK-SECRET-TOKEN",
    port: 0,
  };
}

void test("packageMetadata resolves installed identity independently of the caller cwd", () => {
  const cwd = process.cwd();
  try {
    process.chdir(tmpdir());
    assert.deepEqual(packageMetadata(), { piVersion: "1.1.0", septVersion: "0.1.0" });
  } finally {
    process.chdir(cwd);
  }
});

void test("createWorker requires explicit roots/token without library environment defaults", async () => {
  const configuration = options();
  for (const key of ["stateRoot", "agentDir", "workspaceRoot", "token"] as const) {
    await assert.rejects(createWorker({ ...configuration, [key]: "" }), SeptError);
  }
  assert.equal(existsSync(configuration.stateRoot), false);
});

void test("ready port zero authenticates and absent hands leaves health/history available", async () => {
  const configuration = options();
  let shutdowns = 0;
  const telemetry = createTelemetry({
    serviceVersion: "fixture",
    sdkDisabled: true,
    logsEnabled: false,
  });
  const shutdown = telemetry.shutdown.bind(telemetry);
  telemetry.shutdown = () => {
    shutdowns += 1;
    return shutdown();
  };
  const worker = await createWorker({ ...configuration, telemetry });
  try {
    assert.ok(worker.address.port > 0);
    assert.equal((await fetch(`${base(worker)}/health`)).status, 401);
    const health = await fetch(`${base(worker)}/health`, { headers: headers(configuration) });
    assert.equal(health.status, 200);
    assert.equal((await responseRecord(health)).acceptingWork, false);
    const unknown = await fetch(`${base(worker)}/v1/tasks/unknown`, {
      headers: headers(configuration),
    });
    assert.equal(unknown.status, 404);
    await assertDormant(worker, configuration);
  } finally {
    await Promise.all([worker.stop(), worker.stop()]);
    await worker.stop();
  }
  assert.equal(shutdowns, 0, "The caller retains ownership of injected telemetry");
  await telemetry.shutdown();
  assert.equal(existsSync(join(configuration.stateRoot, "worker.lease")), false);
  await assert.rejects(fetch(`${base(worker)}/health`));
});

async function assertDormant(worker: Worker, configuration: WorkerOptions): Promise<void> {
  const admission = await fetch(`${base(worker)}/v1/tasks`, {
    method: "POST",
    headers: headers(configuration),
    body: JSON.stringify({
      task: "No execution without hands",
      workspace: configuration.workspaceRoot,
    }),
  });
  assert.equal(admission.status, 400);
  assert.equal(existsSync(join(configuration.stateRoot, "capability-policy.json")), false);
}

void test("malformed hands and corrupt policy stay dormant without replacing operator bytes", async () => {
  for (const corruptPolicy of [false, true]) {
    const configuration = options();
    mkdirSync(configuration.stateRoot);
    const path = join(
      configuration.stateRoot,
      corruptPolicy ? "capability-policy.json" : "hands.json",
    );
    const original = "malformed operator input";
    writeFileSync(path, original);
    const worker = await createWorker({ ...configuration, handsConfigurationPath: path });
    try {
      const health = await fetch(`${base(worker)}/health`, { headers: headers(configuration) });
      assert.equal(health.status, 200);
      assert.equal((await responseRecord(health)).acceptingWork, false);
      assert.equal(readFileSync(path, "utf8"), original);
    } finally {
      await worker.stop();
    }
  }
});

void test("bind failure does not acquire worker authority or close the occupied listener", async () => {
  const listener = createServer();
  const port = await listen(listener);
  const configuration = { ...options(), port };
  try {
    await assert.rejects(createWorker(configuration), { code: "EADDRINUSE" });
    assert.equal(listener.listening, true);
    assert.equal(existsSync(join(configuration.stateRoot, "worker.lease")), false);
  } finally {
    await closeServer(listener);
  }
});

void test("post-bind initialization failure closes its listener and permits a corrected startup", async () => {
  const listener = createServer();
  const port = await listen(listener);
  await closeServer(listener);
  const configuration = { ...options(), port };
  writeFileSync(join(configuration.agentDir, "models.json"), "not-json");
  await assert.rejects(createWorker(configuration), SeptError);
  assert.equal(existsSync(join(configuration.stateRoot, "worker.lease")), false);
  writeFileSync(join(configuration.agentDir, "models.json"), '{"providers":{}}');
  const worker = await createWorker(configuration);
  try {
    assert.equal(worker.address.port, port);
  } finally {
    await worker.stop();
  }
});

function reply(response: ServerResponse, status: "waiting" | "complete"): void {
  openAiReply(
    response,
    JSON.stringify({
      message: status === "waiting" ? "Waiting for later evidence" : "Report uses later evidence",
      control: {
        status,
        summary: status,
        verification: ["real production factory"],
        next_action: status === "waiting" ? "Wait for later evidence" : "",
      },
    }),
  );
}

async function admit(worker: Worker, configuration: WorkerOptions): Promise<string> {
  const response = await fetch(`${base(worker)}/v1/tasks`, {
    method: "POST",
    headers: headers(configuration),
    body: JSON.stringify({
      task: "Wait for evidence, then report",
      workspace: configuration.workspaceRoot,
      provider: "sdk-fixture",
      model: "fixture",
      thinking: "off",
      maxInvocations: 3,
      maxEpochs: 2,
      timeoutSeconds: 60,
    }),
  });
  assert.equal(response.status, 202);
  return stringField(await responseRecord(response), "runId");
}

async function reopenWaiting(
  configuration: WorkerOptions,
  first: Worker,
  refreshHands: () => void,
): Promise<Worker> {
  const runId = await admit(first, configuration);
  await waitForTask(base(first), runId, configuration.token, "waiting");
  const before = await projection(first, configuration, runId);
  await first.stop();
  refreshHands();
  const second = await createWorker(configuration);
  try {
    const reopened = await projection(second, configuration, runId);
    assert.deepEqual(reopened, before);
    const message = await fetch(`${base(second)}/v1/tasks/${runId}/messages`, {
      method: "POST",
      headers: headers(configuration),
      body: JSON.stringify({ message: "  later evidence: exact bytes\n" }),
    });
    assert.equal(message.status, 202);
    await waitForTask(base(second), runId, configuration.token, "complete");
    const completed = await projection(second, configuration, runId);
    assert.equal(record(completed.state, "completed state").invocations, 2);
    assert.equal(
      record(completed.state, "completed state").activeSessionId,
      record(before.state, "waiting state").activeSessionId,
    );
    assert.deepEqual(completed.manifest, before.manifest);
    await assertMessageEvidence(second, configuration, runId);
    return second;
  } catch (error: unknown) {
    await second.stop();
    throw error;
  }
}

void test("production factory preserves waiting state, native identity and hard budgets on stop/reopen", async () => {
  const configuration = options();
  mkdirSync(configuration.stateRoot);
  const hands = [supplyHands(configuration.workspaceRoot)];
  let calls = 0;
  const provider = createServer((request, response) => {
    request.resume();
    calls += 1;
    reply(response, calls === 1 ? "waiting" : "complete");
  });
  const workers: Worker[] = [];
  try {
    writeProvider(configuration.agentDir, await listen(provider), "sdk-fixture", {
      apiKey: "local",
    });
    const initial = hands[0];
    assert.ok(initial);
    activateHandsPolicy(initial, configuration.stateRoot, configuration.agentDir);
    const supplied = { ...configuration, handsConfigurationPath: initial.path };
    const first = await createWorker(supplied);
    workers.push(first);
    workers.push(
      await reopenWaiting(supplied, first, () => {
        refreshSuppliedHands(configuration, hands);
      }),
    );
    assert.equal(calls, 2);
  } finally {
    try {
      await Promise.all(workers.map((worker) => worker.stop()));
    } finally {
      try {
        provider.closeAllConnections();
        await closeServer(provider);
      } finally {
        closeSuppliedHands(hands);
      }
    }
  }
});

function refreshSuppliedHands(configuration: WorkerOptions, owners: SuppliedHands[]): void {
  for (const owned of owners) {
    owned.close();
  }
  const fresh = supplyHands(configuration.workspaceRoot);
  owners.push(fresh);
  activateHandsPolicy(fresh, configuration.stateRoot, configuration.agentDir);
}

function closeSuppliedHands(owners: SuppliedHands[]): void {
  const failures: unknown[] = [];
  for (const owned of owners) {
    try {
      owned.close();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Supplied factory hands finalization failed");
  }
}
