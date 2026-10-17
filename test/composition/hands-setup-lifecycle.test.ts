/** Supporting lifecycle regressions use the real Engine client, leases and fixed pinned finalizer. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockerEngineControl } from "../../src/execution/index.js";
import { acquireStateRootLease } from "../../src/durable/index.js";
import {
  createHandsRoot,
  newHandsOwner,
  writeHandsReceipt,
  type HandsReceipt,
} from "../../src/cli/hands-record.js";
import { finishHands } from "../../src/cli/hands-finish.js";
import { suppliedEngine } from "../pi-integration/backend-support.js";

async function finalizationFixture(): Promise<{
  root: string;
  owned: HandsReceipt;
  facts: Awaited<ReturnType<typeof suppliedEngine>>["facts"];
  close(): Promise<void>;
}> {
  const backend = await suppliedEngine();
  const root = join(mkdtempSync(join(tmpdir(), "sept-setup-finish-")), "instance");
  createHandsRoot(root);
  const engine = await DockerEngineControl.open(backend.path);
  const owned: HandsReceipt = {
    version: 1,
    owner: newHandsOwner(),
    engineSocket: backend.path,
    socketIdentity: engine.socketIdentity,
    daemonId: engine.daemonId,
    image: `sha256:${"a".repeat(64)}`,
    containerId: "a".repeat(64),
    generation: backend.facts.generation,
    phase: "ready",
  };
  await engine.close();
  backend.facts.setupOwner = owned.owner;
  writeHandsReceipt(root, owned);
  writeFileSync(
    join(root, "evidence", "lifetime.json"),
    JSON.stringify({ pidNamespace: "pid:[42]", initStart: "123" }),
    { mode: 0o600 },
  );
  return { root, owned, facts: backend.facts, close: backend.close };
}

void test("finish refuses foreign roots without creating directories or lease lock files", async () => {
  const foreign = mkdtempSync(join(tmpdir(), "sept-foreign-finish-"));
  const before = readdirSync(foreign);
  await assert.rejects(finishHands({ root: foreign }), /existing private owned setup layout/);
  assert.deepEqual(readdirSync(foreign), before);
  for (const directory of ["state", "evidence"]) {
    mkdirSync(join(foreign, directory), { mode: 0o700 });
  }
  const marker = join(foreign, "evidence", "setup.json");
  writeFileSync(marker, "FOREIGN-MARKER-CANARY", { mode: 0o600 });
  const entries = readdirSync(foreign, { recursive: true });
  await assert.rejects(finishHands({ root: foreign }), /metadata is unavailable or malformed/);
  assert.deepEqual(readdirSync(foreign, { recursive: true }), entries);
  assert.equal(readFileSync(marker, "utf8"), "FOREIGN-MARKER-CANARY");
});

void test("finish refuses a live worker and never stops its namespace", async () => {
  const fixture = await finalizationFixture();
  const release = acquireStateRootLease(join(fixture.root, "state"));
  try {
    await assert.rejects(finishHands({ root: fixture.root }), /already owned/);
    assert.equal(fixture.facts.stops, 0);
  } finally {
    release();
    await fixture.close();
  }
});

void test("failed export and malformed prior export cannot skip pinned stop", async () => {
  const fixture = await finalizationFixture();
  writeFileSync(join(fixture.root, "evidence", "finish.json"), "MALFORMED-EXPORT-CANARY", {
    mode: 0o600,
  });
  // Missing Docker CLI makes export fail; exact shutdown still uses the existing Engine client.
  const previous = process.env.PATH;
  process.env.PATH = "/nonexistent-sept-docker-path";
  try {
    await assert.rejects(finishHands({ root: fixture.root }), /export failed or unavailable/);
    assert.equal(fixture.facts.stops, 1);
    assert.equal(fixture.facts.running, false);
    assert.match(
      readFileSync(join(fixture.root, "evidence", "finish.json"), "utf8"),
      /"stopped": true/,
    );
  } finally {
    process.env.PATH = previous;
    await fixture.close();
  }
});

void test("finished repeat requires successful archive evidence and refuses replacement generation", async () => {
  const fixture = await finalizationFixture();
  const archive = join(fixture.root, "evidence", `workspace-${newHandsOwner()}.tar`);
  writeFileSync(archive, "retained archive", { mode: 0o600 });
  writeFileSync(
    join(fixture.root, "evidence", "finish.json"),
    JSON.stringify({ exported: true, stopped: true, archive }),
    { mode: 0o600 },
  );
  fixture.owned.phase = "finished";
  writeHandsReceipt(fixture.root, fixture.owned);
  fixture.facts.running = false;
  try {
    assert.deepEqual(await finishHands({ root: fixture.root }), {
      exported: true,
      stopped: true,
      archive,
    });
    fixture.facts.running = true;
    fixture.facts.generation = "replacement";
    await assert.rejects(finishHands({ root: fixture.root }), /generation changed/);
    assert.equal(fixture.facts.stops, 0);
    assert.equal(fixture.facts.running, true);
  } finally {
    await fixture.close();
  }
});
