/** Exact probe branch regression in an explicitly owned writable Linux image; never an admission claim. */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { SeptError } from "../../src/durable/index.js";
import { validateDockerConfiguration } from "../../src/execution/docker-control.js";
import { DockerEngineControl } from "../../src/execution/docker-engine.js";
import { guardedCommand } from "../../src/execution/hands-guarded-command.js";
import { HANDS_IMAGE_ISOLATION_PROBE } from "../../src/execution/hands-selected-inputs.js";
import { namespaceLifetimePath } from "../../src/execution/profile-configuration.js";
import { suppliedEngine } from "./backend-support.js";
import { profileFixture } from "./capability-profile-support.js";

const PROBE_COMMAND = guardedCommand([
  "--experimental-import-meta-resolve",
  "--input-type=module",
  "--eval",
  HANDS_IMAGE_ISOLATION_PROBE,
]);
const OWNED_FIXTURE = process.env.SEPT_HANDS_IMAGE_ISOLATION_FIXTURE === "owned-writable-linux-v1";
const TEST_IMAGE = process.env.SEPT_HANDS_TEST_IMAGE;
const PROVENANCE = "/app/pi-native-search-provenance.json";
const EFFECTIVE_BODY = "/app/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.js";

// This writable branch fixture has no grants, mounts or network and is never admitted.
const WRITABLE_FIXTURE_ARGUMENTS = [
  "run",
  "--detach",
  "--init",
  "--no-healthcheck",
  "--user",
  "0:0",
  "--network",
  "none",
  "--cap-drop",
  "ALL",
  "--cap-add",
  "SETUID",
  "--cap-add",
  "SETGID",
  "--cap-add",
  "FOWNER",
  "--cap-add",
  "DAC_OVERRIDE",
  "--cap-add",
  "KILL",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  "64",
  "--memory",
  "512m",
  "--cpus",
  "0.5",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,noexec,size=16777216,mode=1777",
];

void test(
  "exact image probe refuses private mode, provenance and effective-body mutations before receipts",
  { skip: !OWNED_FIXTURE && TEST_IMAGE === undefined, timeout: 60_000 },
  async (context) => {
    if (!OWNED_FIXTURE) {
      assert.ok(TEST_IMAGE);
      context.diagnostic(runWritableImage(TEST_IMAGE));
      return;
    }
    assert.equal(process.platform, "linux");
    assert.equal(process.geteuid?.(), 0);
    assertProbe(0);
    for (const target of ["private-mode", "provenance", "effective-body"] as const) {
      const restore = corruptFixture(target);
      try {
        assertProbe(126);
        await assertCallerRefusesBeforeReceipts();
      } finally {
        restore();
      }
      // Each negative case starts from independently revalidated original bytes and modes.
      assertProbe(0);
    }
  },
);

function runWritableImage(image: string): string {
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const containerId = dockerText([...WRITABLE_FIXTURE_ARGUMENTS, image, "sleep", "infinity"]);
  assert.match(containerId, /^[a-f0-9]{64}$/);
  let generation: string | undefined;
  let inner: string | undefined;
  const failures: unknown[] = [];
  try {
    generation = dockerText(["inspect", "--format", "{{.State.StartedAt}}", containerId]);
    inner = runInnerProbe(containerId);
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    finalizeProbeFixture(containerId, image, generation);
  } catch (error: unknown) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Owned Linux probe fixture failed; first failure retained");
  }
  assert.ok(inner);
  return JSON.stringify({ containerId, generation, inner, stopped: true, pid: 0 });
}

function runInnerProbe(containerId: string): string {
  const result = dockerCommand([
    "exec",
    "--user",
    "0:0",
    "--env",
    "SEPT_HANDS_IMAGE_ISOLATION_FIXTURE=owned-writable-linux-v1",
    containerId,
    "node",
    "--test",
    "/app/dist/test/pi-integration/hands-image-isolation.test.js",
  ]);
  assertDockerExit(result);
  return JSON.stringify({
    code: result.status,
    signal: result.signal,
    joined: true,
    stdout: result.stdout,
  });
}

function dockerCommand(arguments_: string[]): SpawnSyncReturns<string> {
  return spawnSync("docker", arguments_, {
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 30_000,
  });
}

function assertDockerExit(result: SpawnSyncReturns<string>): void {
  assert.equal(result.error, undefined);
  assert.deepEqual(
    { code: result.status, signal: result.signal },
    { code: 0, signal: null },
    result.stdout + result.stderr,
  );
}

function dockerText(arguments_: string[]): string {
  const result = dockerCommand(arguments_);
  assertDockerExit(result);
  return result.stdout.trim();
}

function finalizeProbeFixture(
  containerId: string,
  image: string,
  generation: string | undefined,
): void {
  const current = dockerText(["inspect", "--format", "{{.State.StartedAt}}", containerId]);
  assert.equal(dockerText(["inspect", "--format", "{{.Image}}", containerId]), image);
  assert.equal(current, generation ?? current);
  try {
    if (dockerText(["inspect", "--format", "{{.State.Running}}", containerId]) === "true") {
      dockerText(["kill", containerId]);
    }
  } finally {
    assert.equal(dockerText(["inspect", "--format", "{{.State.StartedAt}}", containerId]), current);
    assert.equal(
      dockerText(["inspect", "--format", "{{.State.Running}}:{{.State.Pid}}", containerId]),
      "false:0",
    );
  }
}

function runProbe(): ReturnType<typeof spawnSync> {
  const executable = PROBE_COMMAND[0];
  assert.ok(executable);
  return spawnSync(executable, PROBE_COMMAND.slice(1), {
    cwd: "/app",
    uid: 10002,
    gid: 10002,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    encoding: "utf8",
    maxBuffer: 2048,
    timeout: 3000,
  });
}

function assertProbe(code: number): void {
  const result = runProbe();
  assert.equal(result.error, undefined);
  assert.equal(result.status, code, String(result.stderr));
  assert.equal(result.signal, null);
  assert.equal(String(result.stdout), code === 0 ? "isolated" : "");
}

function corruptFixture(target: "private-mode" | "provenance" | "effective-body"): () => void {
  if (target === "private-mode") {
    const mode = statSync("/app").mode & 0o7777;
    chmodSync("/app", 0o755);
    return () => {
      chmodSync("/app", mode);
    };
  }
  const path = target === "provenance" ? PROVENANCE : EFFECTIVE_BODY;
  const stat = statSync(path);
  assert.ok(stat.size < 1024 * 1024);
  const bytes = readFileSync(path);
  // Retain inode/owner/mode: the only changed predicate is the pinned content hash.
  writeFileSync(path, Buffer.concat([bytes, Buffer.from(" ")]));
  return () => {
    writeFileSync(path, bytes);
  };
}

async function assertCallerRefusesBeforeReceipts(): Promise<void> {
  const fixture = await suppliedEngine();
  const engine = await DockerEngineControl.open(fixture.path);
  const { configuration, inspected, brain } = profileFixture();
  const configured = { ...configuration, engineSocket: fixture.path };
  const policyPath = join(brain, "runs", "capability-policy.json");
  mkdirSync(dirname(policyPath));
  const lifetime = namespaceLifetimePath(policyPath, configured);
  const receipts = [lifetime, join(dirname(lifetime), "kernel.json")];
  const executed = installRealProbe(engine, inspected);
  try {
    await assert.rejects(
      validateDockerConfiguration(
        configured,
        [brain],
        configured.workspace,
        undefined,
        { policyPath, initialize: true },
        engine,
      ),
      SeptError,
    );
    assert.equal(executed(), 1);
    for (const path of receipts) {
      assert.equal(existsSync(path), false, path);
    }
  } finally {
    try {
      await engine.close();
    } finally {
      await fixture.close();
    }
  }
}

function installRealProbe(engine: DockerEngineControl, inspected: unknown): () => number {
  let executed = 0;
  engine.inspect = () => Promise.resolve(inspected);
  engine.exec = (_id, execution): Promise<string> => {
    executed += 1;
    assert.deepEqual(execution.command, PROBE_COMMAND);
    assert.equal(execution.maximum, 1024);
    const result = runProbe();
    assert.equal(result.error, undefined);
    assert.equal(result.status, 126);
    assert.equal(result.signal, null);
    assert.equal(String(result.stdout), "");
    return Promise.reject(new SeptError("Owned Linux image probe refused with exit126"));
  };
  return () => executed;
}
