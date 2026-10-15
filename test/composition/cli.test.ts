/**
 * Exercises the installed CLI's build, listener, option secrecy, package floor, and container
 * wiring. Product mechanisms remain black boxes; assertions cover public process behavior only.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  installedWorker,
  parseRecord,
  record,
  stopInstalled,
  waitForExit,
  stringField,
} from "./cli-support.js";

void test("clean build removes obsolete flat output before exercising the public worker", () => {
  const pkg = parseRecord(readFileSync(resolve("package.json"), "utf8"), "package metadata");
  const scripts = record(pkg.scripts, "package scripts");
  assert.equal(scripts.clean, "node scripts/clean.mjs");
  assert.match(String(scripts.build), /^npm run clean && /);
  const staleOutputs = [
    "dist/src/controller.js",
    "dist/src/durable.js",
    "dist/src/pi.js",
    "dist/src/prompts.js",
    "dist/src/service.js",
    "dist/src/telemetry.js",
    "dist/src/types.js",
    "dist/src/webhook.js",
    "dist/test/cli-observability.test.js",
    "dist/test/controller.test.js",
    "dist/test/pi-sdk.test.js",
    "dist/test/telemetry.test.js",
    "dist/test/webhook.test.js",
  ];
  for (const stale of staleOutputs) {
    assert.equal(existsSync(resolve(stale)), false, `stale build artifact remains: ${stale}`);
  }
  assert.equal(existsSync(resolve("dist/src/cli.js")), true);
  assert.equal(existsSync(resolve("dist/src/runtime/index.js")), true);
});

async function verifyWorkerSurface(
  base: string,
  token: string,
  state: string,
  agent: string,
): Promise<void> {
  assert.equal((await fetch(`${base}/health`)).status, 401);
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${base}/health`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/v1/tasks/unknown`, { headers })).status, 404);
  const competing = spawnSync(
    resolve("sept"),
    [
      "run",
      "--task",
      "must not start",
      "--workspace",
      process.cwd(),
      "--state-dir",
      state,
      "--agent-dir",
      agent,
    ],
    { cwd: process.cwd(), env: { ...process.env, OTEL_SDK_DISABLED: "true" }, encoding: "utf8" },
  );
  assert.equal(competing.status, 1);
  assert.match(competing.stderr, /state root is already owned|ownership lease/);
  const rejected = await fetch(`${base}/v1/webhooks`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, kind: "unknown" }),
  });
  assert.equal(rejected.status, 400);
}

function verifyLifecycleLogs(stderr: string, token: string): void {
  const records = stderr
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => parseRecord(line));
  assert.ok(records.some((entry) => entry.lifecycle === "worker.started"));
  assert.ok(records.some((entry) => entry.lifecycle === "worker.stopped"));
  assert.ok(
    records.every(
      (entry) => entry["service.name"] === "sept" && entry["sept.worker.id"] === "cli-test-worker",
    ),
  );
  assert.doesNotMatch(stderr, new RegExp(token));
}

async function telemetryScenario(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "sept-cli-telemetry-"));
  const state = join(root, "runs");
  const agent = join(root, "agent");
  mkdirSync(agent);
  mkdirSync(join(root, "workspace"));
  const token = "CLI-SECRET-TOKEN";
  const worker = installedWorker(state, agent, process.cwd(), token, {
    SEPT_LOG_LEVEL: "info",
    SEPT_WORKER_ID: "cli-test-worker",
  });
  try {
    const base = await worker.address;
    await verifyWorkerSurface(base, token, state, agent);
    const exited = waitForExit(worker.child);
    worker.child.kill("SIGTERM");
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.equal(worker.stdout(), `SEPT Pi worker listening on ${base}\n`);
    verifyLifecycleLogs(worker.stderr(), token);
  } finally {
    await stopInstalled(worker.child);
  }
}

void test(
  "public worker keeps stdout stable and emits JSON lifecycle logs on stderr",
  telemetryScenario,
);

void test("CLI rejects bearer tokens and unknown options without echoing values", () => {
  const secret = "ARGV-SECRET-MUST-NOT-ECHO";
  const token = spawnSync(resolve("sept"), ["health", "--token", secret], {
    cwd: process.cwd(),
    env: { ...process.env, SEPT_TOKEN: "environment-only" },
    encoding: "utf8",
  });
  assert.equal(token.status, 1);
  assert.match(token.stderr, /Unknown option --token/);
  assert.doesNotMatch(token.stderr, new RegExp(secret));
  const unknown = spawnSync(resolve("sept"), ["worker", "--surprise", "value"], {
    cwd: process.cwd(),
    env: { ...process.env, SEPT_TOKEN: "environment-only" },
    encoding: "utf8",
  });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option --surprise/);
});

void test("declared Node floor matches the installed Pi runtime requirement", () => {
  const pkg = parseRecord(readFileSync(resolve("package.json"), "utf8"), "package metadata");
  const engines = record(pkg.engines, "package engines");
  assert.equal(engines.node, ">=22.19.0");
});

void test("container startup pins durable evidence and workspace confinement to production mounts", () => {
  const dockerfile = readFileSync(resolve("Dockerfile"), "utf8");
  const readme = readFileSync(resolve("README.md"), "utf8");
  assert.match(dockerfile, /SEPT_STATE_DIR=\/state\/runs/);
  assert.match(dockerfile, /"--state-dir", "\/state\/runs"/);
  assert.match(dockerfile, /SEPT_WORKSPACE_ROOT=\/workspace/);
  assert.match(dockerfile, /"--workspace-root", "\/workspace"/);
  assert.match(readme, /-v sept-state:\/state/);
});

void test("container installs fixed UID helpers while keeping resident imports and provenance private", () => {
  const dockerfile = readFileSync(resolve("Dockerfile"), "utf8");
  const command = readFileSync(resolve("src/execution/hands-command.c"), "utf8");
  const guard = readFileSync(resolve("src/execution/hands-guard.c"), "utf8");
  assert.match(dockerfile, /chown 10002:10001 \/app/);
  assert.match(dockerfile, /chmod 0750 \/app/);
  assert.match(dockerfile, /chmod 0700 \/home\/sept-hands/);
  assert.match(dockerfile, /\/usr\/local\/libexec\/sept\/hands-command/);
  assert.match(dockerfile, /chmod 0555 \/usr\/local\/libexec\/sept/);
  assert.match(dockerfile, /pi-native-search-provenance\.json/);
  assert.match(dockerfile, /pi-native-search-README\.md/);
  assert.match(dockerfile, /npm run build && npm prune --omit=dev/);
  assert.equal((dockerfile.match(/hashes\.effectiveSha256/g) ?? []).length, 3);
  assert.doesNotMatch(dockerfile, /hands-(?:rg|fd)|cp \/app\/hands-guard-check|CAP_SETUID/);
  assert.match(command, /getuid\(\) == 10003/);
  assert.match(command, /getgid\(\) == 10002/);
  assert.match(command, /setsid\(\) < 0 && getsid\(0\) != getpid\(\)/);
  assert.match(command, /SYS_close_range/);
  assert.match(command, /sept-hands-epoch-\*/);
  assert.match(command, /sept-hands-mime-\*/);
  assert.doesNotMatch(command + guard, /landlock|execute_discovery_helper|helper_scratch_rules/);
  assert.match(guard, /__attribute__\(\(constructor\)\)/);
  assert.match(guard, /PR_SET_DUMPABLE/);
  assert.match(guard, /__NR_io_uring_setup/);
  assert.match(guard, /--sealed/);
});

function fixtureDocker(arguments_: string[]): string {
  const result = spawnSync("docker", arguments_, {
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  assert.deepEqual({ code: result.status, signal: result.signal }, { code: 0, signal: null });
  return result.stdout.trim();
}

/** Recorded fixture identity grants cleanup authority only for this exact namespace generation. */
interface OwnedSetupHands {
  containerId: string;
  generation: string;
}

function observeSetupHands(owned: OwnedSetupHands): string {
  return fixtureDocker([
    "inspect",
    "--format",
    "{{.State.StartedAt}}:{{.State.Running}}:{{.State.Pid}}",
    owned.containerId,
  ]);
}

function closeSetupHands(owned: OwnedSetupHands): void {
  // Recheck immediately before stop; a failed observation never authorizes a replacement generation.
  const current = observeSetupHands(owned);
  if (current === `${owned.generation}:false:0`) {
    return;
  }
  assert.ok(current.startsWith(`${owned.generation}:true:`), "Fixture generation changed");
  fixtureDocker(["stop", owned.containerId]);
  assert.equal(observeSetupHands(owned), `${owned.generation}:false:0`);
}

function verifySetupRefusal(owned: OwnedSetupHands, setupFailure: unknown): void {
  const failures: unknown[] = [];
  try {
    assert.ok(setupFailure instanceof AggregateError);
    assert.equal(setupFailure.errors.length, 1);
    const original: unknown = setupFailure.errors[0];
    assert.ok(original instanceof assert.AssertionError);
    assert.equal(observeSetupHands(owned), `${owned.generation}:false:0`);
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    closeSetupHands(owned);
  } catch (cleanupError: unknown) {
    failures.push(cleanupError);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Worker setup refusal verification failed");
  }
}

void test("worker policy setup refusal closes its supplied namespace before returning", () => {
  const root = mkdtempSync(join(tmpdir(), "sept-cli-setup-refusal-"));
  const state = join(root, "runs");
  const agent = join(root, "agent");
  mkdirSync(state);
  mkdirSync(agent);
  mkdirSync(join(root, "workspace"));
  writeFileSync(join(state, "capability-policy.json"), "{malformed");
  let setupFailure: unknown;
  try {
    installedWorker(state, agent, process.cwd(), "fixture-only");
  } catch (error: unknown) {
    setupFailure = error;
  }
  const configuration = parseRecord(readFileSync(join(root, "hands-configuration.json"), "utf8"));
  const owned = {
    containerId: stringField(configuration, "containerId"),
    generation: stringField(configuration, "generation"),
  };
  verifySetupRefusal(owned, setupFailure);
});
