/** Cleanup regression uses a bounded fake Docker control client; it makes no kernel confinement claim. */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { CompositionFixtureError, stopInstalled, waitForExit } from "./cli-support.js";
import { ownHands, supplyHands } from "./hands-support.js";

void test("workspace export failure still stops and verifies the owned namespace", () => {
  const root = mkdtempSync(join(tmpdir(), "sept-hands-finalization-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const control = join(root, "docker");
  const running = join(root, "running");
  const ledger = join(root, "calls.jsonl");
  writeFileSync(running, "true");
  writeFileSync(control, fakeControl(running, ledger));
  chmodSync(control, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${root}:${previous ?? "/usr/bin:/bin"}`;
  try {
    const hands = supplyHands(workspace, true);
    assert.throws(() => {
      hands.close();
    }, AggregateError);
    assert.equal(readFileSync(running, "utf8"), "false");
    const calls = readFileSync(ledger, "utf8");
    assert.match(calls, /"kill"/);
    assert.match(calls, /State.Pid/);
    hands.close();
    assert.equal(readFileSync(ledger, "utf8"), calls);
  } finally {
    restorePath(previous);
  }
});

void test("partial initialization preserves the seed failure and still attempts stop and verification", () => {
  const root = mkdtempSync(join(tmpdir(), "sept-hands-partial-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const running = join(root, "running");
  const ledger = join(root, "calls.jsonl");
  writeFileSync(running, "true");
  writeFileSync(join(root, "docker"), fakeControl(running, ledger, true));
  chmodSync(join(root, "docker"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${root}:${previous ?? "/usr/bin:/bin"}`;
  try {
    assert.throws(
      () => supplyHands(workspace, true),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        const first: unknown = error.errors[0];
        assert.ok(first instanceof assert.AssertionError);
        assert.deepEqual(first.actual, { code: 7, signal: null });
        return true;
      },
    );
    assert.match(readFileSync(ledger, "utf8"), /"kill"/);
    assert.match(readFileSync(ledger, "utf8"), /State.Pid/);
  } finally {
    restorePath(previous);
  }
});

void test("an already exited worker retains code and signal while failed cleanup still runs", async () => {
  const child = spawn(process.execPath, ["--eval", "process.exitCode = 7"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.deepEqual(await waitForExit(child), { code: 7, signal: null });
  assert.deepEqual(await waitForExit(child), { code: 7, signal: null });
  const cleanupFailure = new CompositionFixtureError("controlled close failure");
  let closeAttempts = 0;
  ownHands(child, {
    path: "controlled",
    containerId: "a".repeat(64),
    workspace: "controlled",
    exportWorkspace: () => {
      assert.fail("Worker finalization must use fixture close");
    },
    close: () => {
      closeAttempts += 1;
      throw cleanupFailure;
    },
  });
  await assert.rejects(stopInstalled(child), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [cleanupFailure]);
    return true;
  });
  assert.equal(closeAttempts, 1);
});

void test("a failed stop stays retryable and verified closure stays idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "sept-hands-stop-retry-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const running = join(root, "running");
  const ledger = join(root, "calls.jsonl");
  const killFailure = join(root, "kill-failure");
  writeFileSync(running, "true");
  writeFileSync(killFailure, "true");
  writeFileSync(join(root, "docker"), fakeControl(running, ledger, false, killFailure));
  chmodSync(join(root, "docker"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${root}:${previous ?? "/usr/bin:/bin"}`;
  try {
    const hands = supplyHands(workspace, true);
    assert.throws(
      () => {
        hands.close();
      },
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 3);
        const first: unknown = error.errors[0];
        assert.ok(first instanceof assert.AssertionError);
        assert.deepEqual(first.actual, { code: 1, signal: null });
        return true;
      },
    );
    writeFileSync(killFailure, "false");
    assert.throws(() => {
      hands.close();
    }, AggregateError);
    assert.equal(readFileSync(running, "utf8"), "false");
    const calls = readFileSync(ledger, "utf8");
    hands.close();
    assert.equal(readFileSync(ledger, "utf8"), calls);
  } finally {
    restorePath(previous);
  }
});

void test("waitForExit preserves an actual signal exit after the child has joined", async () => {
  const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = waitForExit(child);
  child.kill("SIGTERM");
  assert.deepEqual(await exited, { code: null, signal: "SIGTERM" });
  assert.deepEqual(await waitForExit(child), { code: null, signal: "SIGTERM" });
});

void test("worker stop failure cannot skip hands finalization or replace its first failure", async () => {
  const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const originalKill = child.kill.bind(child);
  const stopFailure = new CompositionFixtureError("controlled worker stop failure");
  const handsFailure = new CompositionFixtureError("controlled hands close failure");
  child.kill = () => {
    child.emit("error", stopFailure);
    return false;
  };
  ownHands(child, {
    path: "controlled",
    containerId: "a".repeat(64),
    workspace: "controlled",
    exportWorkspace: () => {
      assert.fail("Worker finalization must use fixture close");
    },
    close: () => {
      throw handsFailure;
    },
  });
  try {
    await assert.rejects(stopInstalled(child), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [stopFailure, handsFailure]);
      return true;
    });
  } finally {
    child.kill = originalKill;
    const exited = waitForExit(child);
    child.kill("SIGTERM");
    await exited;
  }
});

void test("a replacement generation is neither exported nor stopped by the old fixture", () => {
  const root = mkdtempSync(join(tmpdir(), "sept-hands-generation-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const running = join(root, "running");
  const ledger = join(root, "calls.jsonl");
  writeFileSync(running, "true");
  writeFileSync(join(root, "docker"), fakeControl(running, ledger));
  chmodSync(join(root, "docker"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${root}:${previous ?? "/usr/bin:/bin"}`;
  try {
    const hands = supplyHands(workspace, true);
    const before = readFileSync(ledger, "utf8");
    writeFileSync(`${running}.generation`, "replacement");
    assert.throws(() => {
      hands.close();
    }, AggregateError);
    const calls = readFileSync(ledger, "utf8").slice(before.length);
    assert.doesNotMatch(calls, /"kill"|"exec"/);
    assert.equal(readFileSync(running, "utf8"), "true");
  } finally {
    restorePath(previous);
  }
});

function restorePath(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = previous;
  }
}

function fakeControl(
  running: string,
  ledger: string,
  partialFailure = false,
  killFailure?: string,
): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const running = ${JSON.stringify(running)};
fs.appendFileSync(${JSON.stringify(ledger)}, JSON.stringify(args) + "\\n");
if (args[0] === "run") console.log("a".repeat(64));
if (args[0] === "context") console.log("unix:///run/docker.sock");
if (args[0] === "inspect") {
  const state = fs.readFileSync(running, "utf8");
  const generation = fs.existsSync(running + ".generation") ? fs.readFileSync(running + ".generation", "utf8") : "fresh";
  console.log(args[2].includes("StartedAt") ? generation : args[2].includes("Pid") ? state + ":0" : state);
}
if (args[0] === "kill") {
  const killFailure = ${JSON.stringify(killFailure ?? null)};
  if (${String(partialFailure)} || (killFailure && fs.readFileSync(killFailure, "utf8") === "true")) process.exitCode = 9;
  else fs.writeFileSync(running, "false");
}
if (args[0] === "exec") {
  if (${String(partialFailure)} && args.includes("-i")) process.exitCode = 7;
  else if (!args.includes("-i")) process.exitCode = 1;
}
`;
}
