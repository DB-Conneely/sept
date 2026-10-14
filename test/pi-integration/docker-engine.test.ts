import { EngineStreamDecoder } from "../../src/execution/engine-stream.js";
import { guardedCommand } from "../../src/execution/hands-processes.js";
/** Unix HTTP/framing regressions are supporting fixtures; installed Engine proof remains mandatory. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SeptError } from "../../src/durable/index.js";
import { EngineControlError } from "../../src/execution/contracts.js";
import { DockerEngineControl } from "../../src/execution/docker-engine.js";
import { parseEngineJson } from "../../src/execution/protocol.js";
import {
  engineSocketIdentity,
  engineText,
  apiMinor,
  immutableId,
  recordNamespaceLifetime,
  readNamespaceLifetime,
  namespaceLifetimePath,
  readBoundedHandsRecord,
} from "../../src/execution/profile-configuration.js";
import {
  acquireHandsLease,
  initializeCapabilityEngine,
  qualifyCapabilityEngine,
  recordHandsBinding,
  revokeDockerBinding,
  revokeRecordedHandsBinding,
  reconcileDockerBinding,
} from "../../src/execution/docker-control.js";
import { suppliedEngine, recordFixtureKernel, engineFrame as frame } from "./backend-support.js";
import {
  captureNamespaceLifetime,
  stopCapturedNamespace,
  parseNamespaceLifetime,
} from "../../src/execution/hands-processes.js";
import { fixtureDirectories, fixtureStore } from "./support.js";

const ID = "a".repeat(64);
void test("DockerEngineControl, HandsAttachment, engineExchange, openEngineAttachment, collectEngineMetadata and collectHandsAttachment join stdin/stdout", async () => {
  const fixture = await suppliedEngine();
  const engine = await DockerEngineControl.open(fixture.path);
  try {
    assert.equal(engine.daemonId, fixture.facts.daemon);
    const execution = {
      cwd: "/workspace",
      input: "EXACT_STDIN",
      command: guardedCommand(["--eval", "0"]),
    };
    assert.equal(await engine.exec(ID, execution), "bounded result");
    assert.equal(fixture.facts.input, "EXACT_STDIN");
    // Actual fixture HTTP completion exercises settleResponse before retaining the idle Agent socket.
    assert.ok(execution.command.includes("PI_OFFLINE=1"));
    assert.ok(execution.command.includes("SEPT_HANDS_NETWORK=0"));
    assert.deepEqual(fixture.facts.command, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: execution.command,
      Env: [],
      WorkingDir: "/workspace",
      User: "",
      Privileged: false,
    });
    fixture.facts.exitCode = 7;
    await assert.rejects(engine.exec(ID, execution), (error: unknown) => {
      assert.ok(error instanceof EngineControlError);
      assert.equal(error.facts.code, 7);
      assert.equal(error.facts.signal, null);
      assert.doesNotMatch(JSON.stringify(error), /HOSTILE_STDERR_CANARY/);
      return true;
    });
    fixture.facts.daemon = "replacement";
    await assert.rejects(engine.inspect(ID), /daemon identity changed/);
  } finally {
    await engine.close();
    await fixture.close();
  }
});
void test("EngineStreamDecoder accepts exact capacity and refuses overflow, forged or truncated frames", () => {
  const accepted: Buffer[] = [];
  const decoder = new EngineStreamDecoder(4, (chunk) => {
    accepted.push(chunk);
  });
  decoder.write(frame(1, "1234").subarray(0, 5));
  decoder.write(frame(1, "1234").subarray(5));
  decoder.finish();
  assert.equal(Buffer.concat(accepted).toString(), "1234");
  assert.throws(() => {
    new EngineStreamDecoder(4).write(frame(1, "12345"));
  }, EngineControlError);
  assert.throws(() => {
    new EngineStreamDecoder(4).write(frame(0, "bad"));
  }, SeptError);
  const truncated = new EngineStreamDecoder(4);
  truncated.write(frame(1, "1234").subarray(0, 9));
  assert.throws(() => {
    truncated.finish();
  }, SeptError);
  assert.equal(apiMinor("1.52"), 52);
  assert.throws(() => apiMinor("2.1"), SeptError);
  assert.equal(engineText("daemon"), "daemon");
  assert.throws(() => engineText("HOSTILE\nCANARY"), SeptError);
  assert.equal(immutableId(ID), ID);
  assert.throws(() => immutableId("name"), SeptError);
  assert.deepEqual(parseEngineJson(Buffer.from('{"ok":true}')), { ok: true });
  assert.throws(() => parseEngineJson(Buffer.from("HOSTILE_JSON_CANARY")), SeptError);
});
void test("Engine receipt refuses old/mismatched adoption and generation replacement never receives kill", async () => {
  const fixture = await suppliedEngine();
  const engine = await DockerEngineControl.open(fixture.path);
  const directories = fixtureDirectories("sept-engine-binding-");
  const store = fixtureStore(directories, "fixture", "bounded ownership");
  const config = {
    profile: "docker-linux-warm-v1" as const,
    dataDomain: "mutable-file-bind" as const,
    engineSocket: fixture.path,
    containerId: ID,
    generation: "original",
    workspace: directories.workspace,
    resources: directories.workspace,
    shell: false,
    readOnlyMounts: [],
  };
  try {
    await assertEngineReceipt(fixture.root, config, store, engine, directories.agentDir);
    await assert.rejects(revokeRecordedHandsBinding(store, config), /receipt is absent/);
    await assertGenerationClosure(config, fixture, engine);
    assert.match(readFileSync(join(store.runDir, "hands-binding.json"), "utf8"), /fixture-daemon/);
    writeFileSync(
      join(fixture.root, "hands-engine.json"),
      JSON.stringify({ version: 1, daemonId: "other", socketIdentity: engine.socketIdentity }),
    );
    assert.throws(() => {
      qualifyCapabilityEngine(engine, join(fixture.root, "policy.json"), { initialize: false });
    }, /incompatible/);
  } finally {
    await engine.close();
    await fixture.close();
  }
});
async function assertGenerationClosure(
  config: Parameters<typeof recordHandsBinding>[1],
  fixture: Awaited<ReturnType<typeof suppliedEngine>>,
  engine: DockerEngineControl,
): Promise<void> {
  fixture.facts.generation = "replacement";
  await assert.rejects(
    revokeDockerBinding(config, config, undefined, engine),
    /changed backend generation/,
  );
  assert.equal(fixture.facts.stops, 0);
  await reconcileDockerBinding(config, { ...config, generation: "replacement" }, undefined, engine);
  const next = { ...config, generation: "replacement" };
  const policyPath = join(fixture.root, "policy.json");
  recordNamespaceLifetime(next, engine, policyPath, await captureNamespaceLifetime(next, engine));
  await revokeDockerBinding(next, config, { policyPath }, engine);
  assert.equal(fixture.facts.stops, 1);
  assert.equal(fixture.facts.running, false);
}
async function assertEngineReceipt(
  root: string,
  config: Parameters<typeof recordHandsBinding>[1],
  store: Parameters<typeof recordHandsBinding>[0],
  engine: DockerEngineControl,
  agentDir: string,
): Promise<void> {
  const policyPath = join(root, "policy.json");
  assert.throws(() => {
    qualifyCapabilityEngine(engine, policyPath, { initialize: false });
  }, /absent/);
  await initializeCapabilityEngine(config, policyPath);
  qualifyCapabilityEngine(engine, policyPath, { initialize: false });
  const release = acquireHandsLease(config, store, [agentDir, join(store.runDir, "..")]);
  release();
  const lifetime = await captureNamespaceLifetime(config, engine);
  const runPolicy = join(store.runDir, "..", "capability-policy.json");
  recordFixtureKernel(config, runPolicy);
  recordNamespaceLifetime(config, engine, runPolicy, lifetime);
  assert.deepEqual(readNamespaceLifetime(config, engine, runPolicy), lifetime);
  assert.ok(readBoundedHandsRecord(namespaceLifetimePath(runPolicy, config)).lifetime);
  assert.deepEqual(parseNamespaceLifetime(lifetime), lifetime);
  await recordHandsBinding(store, config, "/workspace", engine);
  await assert.rejects(recordHandsBinding(store, config, "/workspace", engine), /fresh namespace/);
}
void test("explicit socket provenance rejects files, relative paths and publicly writable endpoints", async () => {
  const fixture = await suppliedEngine();
  try {
    assert.match(engineSocketIdentity(fixture.path), /engine.sock/);
    assert.throws(() => engineSocketIdentity("relative.sock"), SeptError);
    mkdirSync(join(fixture.root, "directory"));
    assert.throws(() => engineSocketIdentity(join(fixture.root, "directory")), SeptError);
    chmodSync(fixture.path, 0o666);
    assert.throws(() => engineSocketIdentity(fixture.path), SeptError);
  } finally {
    await fixture.close();
  }
});

void test("Engine close uses joinEngineConnections and settleAttachment to join blocked control and refuses reopening", async () => {
  const fixture = await suppliedEngine();
  const engine = await DockerEngineControl.open(fixture.path);
  fixture.facts.blocked = true;
  const attached = new Promise<void>((resolve) => {
    fixture.facts.onAttachment = resolve;
  });
  const result = engine.exec(ID, {
    command: guardedCommand(["--eval", "0"]),
  });
  try {
    await attached;
    await engine.close();
    await assert.rejects(result, (error: unknown) => {
      assert.ok(error instanceof EngineControlError);
      assert.equal(error.facts.signal, null);
      assert.equal(error.facts.requestJoined, true);
      assert.equal(error.facts.attachmentClosed, true);
      assert.equal(error.facts.connectionsReleased, true);
      return true;
    });
    await assert.rejects(engine.inspect(ID), (error: unknown) => {
      assert.ok(error instanceof EngineControlError);
      assert.equal(error.facts.stage, "closed-owner");
      return true;
    });
  } finally {
    await engine.close();
    await fixture.close();
  }
});
void test("pinnedConfirmation refuses replacement before acknowledgment and stopCapturedNamespace joins same generation", async () => {
  const fixture = await suppliedEngine();
  const engine = await DockerEngineControl.open(fixture.path);
  const binding = { containerId: ID, generation: "original" };
  const lifetime = { pidNamespace: "pid:[42]", initStart: "123" };
  try {
    fixture.facts.beforePin = () => {
      fixture.facts.generation = "replacement";
    };
    await assert.rejects(stopCapturedNamespace(binding, lifetime, engine), /generation changed/);
    assert.equal(fixture.facts.stops, 0);
    assert.equal(fixture.facts.running, true);
    fixture.facts.beforePin = undefined;
    fixture.facts.generation = "original";
    await stopCapturedNamespace(binding, lifetime, engine);
    assert.equal(fixture.facts.stops, 1);
  } finally {
    await engine.close();
    await fixture.close();
  }
});
