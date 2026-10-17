/** Focused ownership/setup contracts supplement the mandatory real installed Docker/Pi proof. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { SeptError } from "../../src/durable/index.js";
import { DockerEngineControl, type DockerHandsConfiguration } from "../../src/execution/index.js";
import { runHands } from "../../src/cli/hands.js";
import { finishHands } from "../../src/cli/hands-finish.js";
import {
  createHandsRoot,
  handsPaths,
  newHandsOwner,
  readHandsMetadata,
  readHandsReceipt,
  trustedHandsRoot,
  writeHandsReceipt,
  type HandsReceipt,
} from "../../src/cli/hands-record.js";
import {
  createHandsArguments,
  exportHandsWorkspace,
  handsDocker,
} from "../../src/cli/hands-docker.js";
import {
  captureHandsOwner,
  inspectHandsOwner,
  openHandsEngine,
  stopHandsOwner,
} from "../../src/cli/hands-owner.js";
import { suppliedEngine } from "../pi-integration/backend-support.js";

function setupRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), "sept-setup-test-"));
  const root = join(parent, "instance");
  createHandsRoot(trustedHandsRoot(root, true));
  return root;
}

function receipt(): HandsReceipt {
  return {
    version: 1,
    owner: newHandsOwner(),
    engineSocket: "/run/docker.sock",
    socketIdentity: "private-socket",
    daemonId: "daemon",
    image: `sha256:${"a".repeat(64)}`,
    phase: "prepared",
  };
}

void test("fresh hands paths preserve private brain/evidence directories and refuse existing roots", () => {
  const root = setupRoot();
  assert.equal(trustedHandsRoot(root), root);
  assert.equal(handsPaths(root).handsConfigurationPath, join(root, "hands.json"));
  assert.equal(statSync(handsPaths(root).agentDir).mode & 0o777, 0o700);
  assert.throws(() => createHandsRoot(root));
  assert.throws(() => trustedHandsRoot("relative"), SeptError);
  const unsafe = join(root, "unsafe");
  mkdirSync(unsafe, { mode: 0o777 });
  chmodSync(unsafe, 0o777);
  assert.throws(() => trustedHandsRoot(join(unsafe, "child"), true), SeptError);
});

void test("private setup receipts round-trip and malformed JSON never enters installed stderr", () => {
  const root = setupRoot();
  const owned = receipt();
  writeHandsReceipt(root, owned);
  assert.deepEqual(readHandsReceipt(root), owned);
  const path = join(root, "evidence", "setup.json");
  const secret = "QA-SECRET-MALFORMED-RECEIPT-CANARY";
  writeFileSync(path, `{ "oops":${secret}}`, { mode: 0o600 });
  assert.throws(() => readHandsMetadata(path, 16384), /metadata is unavailable or malformed/);
  const child = spawnSync(
    process.execPath,
    ["dist/src/cli.js", "hands", "finish", "--root", root],
    { encoding: "utf8", timeout: 15000, env: { PATH: process.env.PATH } },
  );
  assert.equal(child.status, 1);
  assert.doesNotMatch(child.stderr, /QA-SECRET/);
  assert.match(child.stderr, /metadata is unavailable or malformed/);
});

void test("installed hands syntax requires explicit bounded choices before creating resources", async () => {
  await assert.rejects(runHands({ command: "hands", action: "unknown", options: {} }), SeptError);
  await assert.rejects(
    runHands({
      command: "hands",
      action: "init",
      options: { root: "/var/tmp/sept-uncreated-fixture" },
    }),
    /explicit --access/,
  );
  await assert.rejects(
    finishHands({ root: "/var/tmp/no-instance", image: "unexpected" }),
    /only --root/,
  );
  const arguments_ = createHandsArguments("/var/tmp/instance", receipt());
  assert.equal(arguments_[arguments_.indexOf("--pull") + 1], "never");
  assert.equal(arguments_[arguments_.indexOf("--network") + 1], "none");
  assert.equal(arguments_[arguments_.indexOf("--entrypoint") + 1], "");
  assert.ok(arguments_.includes("--read-only"));
});

void test("Docker setup and bounded archive children exclude ambient credentials and context", async () => {
  const root = setupRoot();
  const binary = join(root, "docker");
  writeFileSync(
    binary,
    `#!${process.execPath}\nif(['DOCKER_HOST', 'DOCKER_CONTEXT', 'SEPT_TOKEN', 'ANTHROPIC_API_KEY'].some(key => process.env[key])) process.exit(126);\nprocess.stdout.write(process.argv.includes('exec') ? 'ARCHIVE' : JSON.stringify(process.argv.slice(2)));\n`,
    { mode: 0o700 },
  );
  const restore = dockerFixtureEnvironment(root);
  const owned = { ...receipt(), containerId: "a".repeat(64), generation: "original" };
  try {
    assert.match(handsDocker(root, owned, ["version"]), /unix:\/\/\/run\/docker.sock/);
    writeFileSync(
      join(root, "evidence", "lifetime.json"),
      JSON.stringify({ pidNamespace: "pid:[123]", initStart: "1" }),
      { mode: 0o600 },
    );
    const archive = join(root, "evidence", "archive.tar");
    await exportHandsWorkspace(root, owned, archive);
    assert.equal(readFileSync(archive, "utf8"), "ARCHIVE");
    assert.equal(statSync(archive).mode & 0o777, 0o600);
    // Execute the exact fixed entry with a forged lifetime; a tar launch would emit the canary.
    writeFileSync(
      binary,
      `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst at=process.argv.indexOf('--eval');\nconst script="require('node:child_process').spawnSync=()=>{process.stdout.write('WRONG-GENERATION-ARCHIVE');return {status:0,signal:null}};"+process.argv[at+1];\nconst result=spawnSync(process.execPath,['--eval',script,...process.argv.slice(at+2)],{stdio:'inherit',env:{}});\nprocess.exit(result.status??126);\n`,
      { mode: 0o700 },
    );
    const refused = join(root, "evidence", "refused.tar");
    await assert.rejects(exportHandsWorkspace(root, owned, refused), /export failed/);
    assert.equal(statSync(refused).size, 0);
  } finally {
    restore();
  }
});

function dockerFixtureEnvironment(root: string): () => void {
  const keys = ["PATH", "DOCKER_HOST", "DOCKER_CONTEXT", "SEPT_TOKEN", "ANTHROPIC_API_KEY"];
  const previous = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) {
    process.env[key] = key === "PATH" ? root : `QA-SECRET-${key}-CANARY`;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  };
}

void test("setup owners use authenticated Engine facts and refuse foreign setup labels", async () => {
  const fixture = await suppliedEngine();
  const root = setupRoot();
  const engine = await DockerEngineControl.open(fixture.path);
  const owned = {
    ...receipt(),
    engineSocket: fixture.path,
    socketIdentity: engine.socketIdentity,
    daemonId: engine.daemonId,
    containerId: "a".repeat(64),
    generation: fixture.facts.generation,
  };
  try {
    const opened = await openHandsEngine(owned);
    await opened.close();
    await assert.rejects(inspectHandsOwner(root, owned, engine), SeptError);
    await assert.rejects(stopHandsOwner(root, owned, engine), SeptError);
    fixture.facts.output = JSON.stringify({ pidNamespace: "pid:[123]", initStart: "1" });
    const paths = handsPaths(root);
    const configuration: DockerHandsConfiguration = {
      profile: "docker-linux-warm-v1",
      engineSocket: fixture.path,
      containerId: owned.containerId,
      generation: owned.generation,
      workspace: paths.workspaceRoot,
      resources: join(root, "resources"),
      dataDomain: "private",
      workspaceLimits: { bytes: 134217728, inodes: 32768 },
      shell: false,
      readOnlyMounts: [],
    };
    await captureHandsOwner(root, owned, configuration, engine);
    assert.equal(readHandsReceipt(root).phase, "running");
    assert.equal(fixture.facts.stops, 0);
  } finally {
    await engine.close();
    await fixture.close();
  }
});
