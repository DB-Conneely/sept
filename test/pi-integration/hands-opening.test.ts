/** Failed preflight and partial startup independently release their control and lease owners. */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { CapabilityPolicyStore, SeptError } from "../../src/durable/index.js";
import { openHandsControl, closeFailedHandsOpening } from "../../src/execution/hands-opening.js";
import { suppliedEngine } from "./backend-support.js";
import { fixtureDirectories, fixtureStore } from "./support.js";
void test("openHandsControl refuses failed qualification and closeFailedHandsOpening independently releases lease", async () => {
  const fixture = await suppliedEngine();
  const directories = fixtureDirectories("sept-opening-control-");
  const store = fixtureStore(directories, "fixture", "opening ownership");
  const policyStore = new CapabilityPolicyStore(join(directories.root, "runs"));
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
  const { DockerEngineControl } = await import("../../src/execution/docker-engine.js");
  const engine = await DockerEngineControl.open(fixture.path);
  let released = false;
  try {
    await assert.rejects(openHandsControl(configuration, store, [], policyStore), SeptError);
    await assert.rejects(
      closeFailedHandsOpening(
        engine,
        () => {
          released = true;
        },
        undefined,
        () => Promise.reject(new SeptError("failed exact stop")),
      ),
      SeptError,
    );
    assert.equal(released, true);
  } finally {
    await engine.close();
    await fixture.close();
  }
});
