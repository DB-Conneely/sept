/** Exercises native extension, resource and tool behavior through both actual installed callers. */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  installedWorker,
  parseRecord,
  responseRecord,
  stopInstalled,
  stringField,
  type InstalledWorker,
} from "./cli-support.js";
import {
  assertNativeResources,
  nativeDirectRun,
  nativeResourceFixture,
  type NativeResourceFixture,
} from "./pi-durable-support.js";

await test("installed worker and direct run execute native trusted extensions, skills, image and seven tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "sept-native-resources-"));
  const fixture = await nativeResourceFixture(root);
  const token = "NATIVE-RESOURCE-BEARER-CANARY";
  const worker = installedWorker(fixture.state, fixture.agent, root, token, {
    SEPT_LOG_LEVEL: "info",
    SEPT_HANDS_FIXTURE_SHELL: "true",
  });
  try {
    await nativeWorkerScenario(fixture, worker, token);
    const direct = await nativeDirectRun(fixture);
    assert.equal(fixture.requests.length, 8);
    assertNativeResources(fixture, direct);
    process.stdout.write(`Native installed artifacts verified: ${root}\n`);
  } finally {
    await stopInstalled(worker.child);
    await fixture.close();
  }
});

async function nativeWorkerScenario(
  fixture: NativeResourceFixture,
  worker: InstalledWorker,
  token: string,
): Promise<void> {
  const base = await worker.address;
  const admitted = await fetch(`${base}/v1/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      task: "Exercise native resources",
      role: "NATIVE-ROLE-MARKER",
      workspace: fixture.workspace,
      provider: "local-native",
      model: "fixture",
      thinking: "off",
    }),
  });
  assert.equal(admitted.status, 202);
  const runId = stringField(await responseRecord(admitted), "runId");
  const stream = await fetch(`${base}/v1/tasks/${runId}/stream`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.match(await stream.text(), /event: terminal/);
  await stopInstalled(worker.child);
  assert.equal(fixture.requests.length, 4);
  assertNativeResources(fixture, join(fixture.state, runId));
  assert.equal(worker.child.exitCode, 0);
  verifyOperationalLogs(worker, token);
}

function verifyOperationalLogs(worker: InstalledWorker, token: string): void {
  assert.doesNotMatch(worker.stderr(), new RegExp(token));
  const logs = worker
    .stderr()
    .trim()
    .split("\n")
    .map((line) => parseRecord(line));
  assert.ok(logs.some((entry) => entry.lifecycle === "pi.sqlite.experimental"));
}
