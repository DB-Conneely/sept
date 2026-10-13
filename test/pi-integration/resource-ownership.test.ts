/** Preserves unrelated projection data and valid Unicode aliases at actual owning boundaries. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadDurableSections } from "../../src/pi-integration/durable-resources.js";
import { publicTaskProjection } from "../../src/ingress/index.js";
import { FixtureExecutionBackend } from "./backend-support.js";
import { fixtureDirectories, fixtureStore } from "./support.js";

await test("a consumer marker cannot grant deletion of pre-existing skill data", async () => {
  const directories = fixtureDirectories("sept-projection-preservation-");
  const backend = new FixtureExecutionBackend(directories.workspace);
  const store = fixtureStore(directories, "fixture", "preserve data");
  const root = backend.resourceProjectionDirectory;
  mkdirSync(join(root, "skills"));
  writeFileSync(join(root, "skills", "keep.md"), "ORIGINAL-USER-DATA");
  writeFileSync(join(root, ".sept-resource-projection.json"), '{"formatVersion":1}');
  await assert.rejects(loadDurableSections(store.manifest(), directories.agentDir, backend));
  assert.equal(readFileSync(join(root, "skills", "keep.md"), "utf8"), "ORIGINAL-USER-DATA");
});

await test("unknown __proto__ projection data refuses refresh and preserves existing bytes", async () => {
  const directories = fixtureDirectories("sept-projection-prototype-");
  const backend = new FixtureExecutionBackend(directories.workspace);
  const store = fixtureStore(directories, "fixture", "preserve prototype-named data");
  await loadDurableSections(store.manifest(), directories.agentDir, backend);
  const path = join(backend.resourceProjectionDirectory, "__proto__");
  writeFileSync(path, "ORIGINAL-PROTOTYPE-NAMED-DATA");
  await assert.rejects(loadDurableSections(store.manifest(), directories.agentDir, backend));
  assert.equal(readFileSync(path, "utf8"), "ORIGINAL-PROTOTYPE-NAMED-DATA");
});

void test("public projections preserve canonical Unicode workspace aliases", () => {
  const directories = fixtureDirectories("sept-unicode-alias-");
  const store = fixtureStore(directories, "fixture", "unicode");
  writeFileSync(
    join(store.runDir, "hands-binding.json"),
    JSON.stringify({ cwd: "/workspace/café/日本語" }),
  );
  assert.equal(publicTaskProjection(store).manifest.workspace, "/workspace/café/日本語");
});
