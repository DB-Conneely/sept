/** Same-run re-entry must authenticate captured ownership rather than reconcile equal generations. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { recordHandsBinding, reconcileDockerBinding } from "../../src/execution/docker-control.js";
import { qualifiedRunBinding } from "../../src/execution/hands-binding.js";
import { DockerEngineControl } from "../../src/execution/docker-engine.js";
import { recordNamespaceLifetime } from "../../src/execution/profile-configuration.js";
import { suppliedEngine, recordFixtureKernel } from "./backend-support.js";
import { fixtureDirectories, fixtureStore } from "./support.js";

async function bindingFixture() {
  const fixture = await suppliedEngine();
  const engine = await DockerEngineControl.open(fixture.path);
  const directories = fixtureDirectories("sept-resume-binding-");
  const store = fixtureStore(directories, "fixture", "wait for input");
  const configuration = {
    profile: "docker-linux-warm-v1" as const,
    dataDomain: "mutable-file-bind" as const,
    engineSocket: fixture.path,
    containerId: "a".repeat(64),
    generation: "original",
    workspace: directories.workspace,
    resources: directories.workspace,
    shell: false,
    readOnlyMounts: [],
  };
  const policyPath = join(store.runDir, "..", "capability-policy.json");
  recordFixtureKernel(configuration, policyPath);
  recordNamespaceLifetime(configuration, engine, policyPath, {
    pidNamespace: "pid:[42]",
    initStart: "123",
  });
  await recordHandsBinding(store, configuration, "/workspace", engine);
  return { fixture, engine, store, configuration };
}

void test("same run reopens its qualified namespace without replacement reconciliation", async () => {
  const { fixture, engine, store, configuration } = await bindingFixture();
  try {
    const path = join(store.runDir, "hands-binding.json");
    const before = readFileSync(path, "utf8");
    assert.deepEqual(
      qualifiedRunBinding(
        store,
        configuration,
        "/workspace",
        engine,
        join(store.runDir, "..", "capability-policy.json"),
      ),
      JSON.parse(before),
    );
    await recordHandsBinding(store, configuration, "/workspace", engine);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(fixture.facts.stops, 0);
    await assert.rejects(reconcileDockerBinding(configuration, configuration), /fresh namespace/);
  } finally {
    await engine.close();
    await fixture.close();
  }
});

void test("same generation refuses changed captured ownership without replacing its evidence", async () => {
  const { fixture, engine, store, configuration } = await bindingFixture();
  try {
    await rejectChangedOwnership(store, configuration, engine);
    assert.equal(fixture.facts.stops, 0);
  } finally {
    await engine.close();
    await fixture.close();
  }
});

async function rejectChangedOwnership(
  store: Parameters<typeof recordHandsBinding>[0],
  configuration: Parameters<typeof recordHandsBinding>[1],
  engine: DockerEngineControl,
): Promise<void> {
  const path = join(store.runDir, "hands-binding.json");
  const binding: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(typeof binding === "object" && binding !== null);
  for (const replacement of [
    { runId: "other-run" },
    { cwd: "/selected/other" },
    { daemonId: "other-daemon" },
    { socketIdentity: "other-socket" },
    { lifetime: { pidNamespace: "pid:[43]", initStart: "123" } },
    { kernel: { version: 1, image: "replacement" } },
    { lifetime: undefined },
  ]) {
    const changed: string = JSON.stringify({ ...binding, ...replacement });
    writeFileSync(path, changed);
    await assert.rejects(
      recordHandsBinding(store, configuration, "/workspace", engine),
      /ownership|receipt/,
    );
    assert.equal(readFileSync(path, "utf8"), changed);
  }
}
