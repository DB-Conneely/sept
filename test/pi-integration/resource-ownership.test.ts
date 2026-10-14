/** Preserves unrelated projection data and valid Unicode aliases at actual owning boundaries. */
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
} from "node:fs";
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

function inputOwnership(path: string) {
  const stat = statSync(path);
  // Reads may update atime; ownership, permissions, content and modification identity must not change.
  return { mode: stat.mode, uid: stat.uid, gid: stat.gid, ino: stat.ino, mtime: stat.mtimeMs };
}

function assertProjectionModes(root: string): void {
  const aliases = readdirSync(join(root, "skills"));
  assert.equal(aliases.length, 1);
  const projected = join(root, "skills", String(aliases[0]));
  for (const path of [
    root,
    join(root, "skills"),
    projected,
    join(projected, "deep"),
    join(projected, "deep", "more"),
  ]) {
    assert.equal(statSync(path).mode & 0o777, 0o755);
  }
  for (const path of [
    join(root, "SYSTEM.md"),
    join(root, "settings.json"),
    join(projected, "SKILL.md"),
    join(projected, "deep", "more", "text.txt"),
  ]) {
    assert.equal(statSync(path).mode & 0o777, 0o644);
  }
  assert.equal(readFileSync(join(projected, "alias.txt"), "utf8"), "NESTED-CURATED-CONTENT");
}

await test("curated nested text is readable under 022 and 077 without widening private inputs", async () => {
  // This file runs its async resource scenarios sequentially; restore the process mask even on refusal.
  for (const mask of [0o022, 0o077]) {
    const previous = process.umask(mask);
    try {
      const directories = fixtureDirectories("sept-projection-umask-");
      const backend = new FixtureExecutionBackend(directories.workspace);
      const store = fixtureStore(directories, "fixture", "resource modes");
      const skill = join(directories.agentDir, "skills", "nested");
      mkdirSync(join(skill, "deep", "more"), { recursive: true, mode: 0o700 });
      writeFileSync(
        join(skill, "SKILL.md"),
        "---\nname: nested\ndescription: curated marker\n---\nBODY",
        { mode: 0o600 },
      );
      const input = join(skill, "deep", "more", "text.txt");
      writeFileSync(input, "NESTED-CURATED-CONTENT", { mode: 0o600 });
      symlinkSync("deep/more/text.txt", join(skill, "alias.txt"));
      const before = inputOwnership(input);
      await loadDurableSections(store.manifest(), directories.agentDir, backend);
      const root = backend.resourceProjectionDirectory;
      assertProjectionModes(root);
      assert.equal(readFileSync(input, "utf8"), "NESTED-CURATED-CONTENT");
      assert.deepEqual(inputOwnership(input), before);
      assert.equal(statSync(backend.resourceProjectionReceipt).mode & 0o777, 0o600);
      chmodSync(root, 0o700);
      symlinkSync(input, join(root, "foreign.txt"));
      await assert.rejects(loadDurableSections(store.manifest(), directories.agentDir, backend));
      assert.equal(statSync(root).mode & 0o777, 0o700);
      assert.deepEqual(inputOwnership(input), before);
    } finally {
      process.umask(previous);
    }
  }
});
