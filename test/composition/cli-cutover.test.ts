/** Installed format fencing leaves generated legacy history byte-exact and read-only. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { RunStore } from "../../src/durable/index.js";
import {
  assertCompatibleStateRoot,
  assertNativeRun,
  isLegacyRun,
} from "../../src/pi-integration/index.js";
import { installedWorker, stopInstalled } from "./cli-support.js";

function legacyFixture(status: "active" | "waiting" | "cancelling" | "blocked") {
  const root = mkdtempSync(join(tmpdir(), "sept-cutover-"));
  const state = join(root, "runs");
  const agent = join(root, "agent");
  const workspace = join(root, "workspace");
  mkdirSync(agent);
  mkdirSync(workspace);
  const store = RunStore.create(state, {
    formatVersion: 3,
    task: "historical task",
    role: "",
    workspace,
    provider: "legacy-fixture",
    model: "fixture",
    thinking: "off",
    maxInvocations: 100,
    maxEpochs: 10,
    timeoutSeconds: 3600,
    piVersion: "0.87.1",
  });
  const sessions = join(store.runDir, "pi-sessions");
  mkdirSync(sessions);
  const file = join(sessions, "legacy.jsonl");
  writeFileSync(
    file,
    `${JSON.stringify({ type: "session", version: 3, id: "legacy-native", timestamp: new Date().toISOString(), cwd: workspace })}\n`,
  );
  if (status === "waiting") {
    store.enqueueMessage("  preserved waiting input\n  ");
  }
  store.update({
    status,
    phase: legacyPhase(status),
    invocations: 1,
    activeSessionId: "legacy-native",
    activeSessionFile: file,
  });
  return { root, state, agent, workspace, store };
}

function legacyPhase(
  status: "active" | "waiting" | "cancelling" | "blocked",
): "running" | "terminal" | "waiting" | "cancelling" {
  if (status === "active") {
    return "running";
  }
  if (status === "blocked") {
    return "terminal";
  }
  return status;
}

function treeHashes(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true });
    assert.ok(entries.length <= 64);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else {
        hashes[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
      }
    }
  };
  visit(root);
  return hashes;
}

function rejectedCommand(
  fixture: ReturnType<typeof legacyFixture>,
  command: "worker" | "run",
): void {
  const args =
    command === "worker"
      ? ["worker", "--port", "0", "--workspace-root", fixture.root]
      : ["run", "--task", "fresh task", "--workspace", fixture.workspace];
  const child = spawnSync(
    resolve("sept"),
    [...args, "--state-dir", fixture.state, "--agent-dir", fixture.agent],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SEPT_TOKEN: "cutover-fixture",
        OTEL_SDK_DISABLED: "true",
        SEPT_LOG_LEVEL: "silent",
      },
    },
  );
  assert.equal(child.status, 1, child.stderr);
  assert.equal(child.signal, null);
  assert.match(child.stderr, /Legacy Pi history/);
}

await test("installed worker and direct run reject active/waiting/cancelling legacy history before any write", () => {
  for (const status of ["active", "waiting", "cancelling"] as const) {
    const fixture = legacyFixture(status);
    const before = treeHashes(fixture.state);
    assert.equal(isLegacyRun(fixture.store), true);
    assert.throws(() => {
      assertNativeRun(fixture.store);
    }, /Legacy Pi history/);
    assert.throws(() => {
      assertCompatibleStateRoot(fixture.state);
    }, /Legacy Pi history/);
    rejectedCommand(fixture, "worker");
    rejectedCommand(fixture, "run");
    assert.deepEqual(treeHashes(fixture.state), before);
  }
});

await test("legacy blocked history remains readable while installed message/cancel mutations are fenced", async () => {
  const fixture = legacyFixture("blocked");
  const before = treeHashes(fixture.store.runDir);
  const worker = installedWorker(fixture.state, fixture.agent, fixture.root, "cutover-fixture");
  try {
    const base = await worker.address;
    const headers = { Authorization: "Bearer cutover-fixture", "Content-Type": "application/json" };
    const path = `${base}/v1/tasks/${fixture.store.runId}`;
    assert.equal((await fetch(`${path}/conversation`, { headers })).status, 200);
    for (const resource of ["messages", "cancel"]) {
      const response = await fetch(`${path}/${resource}`, {
        method: "POST",
        headers,
        body:
          resource === "messages"
            ? JSON.stringify({ message: "must never wake legacy history" })
            : "",
      });
      assert.equal(response.status, 400);
      assert.match(await response.text(), /Legacy Pi history/);
    }
    assert.deepEqual(treeHashes(fixture.store.runDir), before);
  } finally {
    await stopInstalled(worker.child);
  }
});
