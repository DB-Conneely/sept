/** Supporting regression coverage for the production resident's anchored effects and private epoch capture. */
import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SeptError } from "../../src/durable/index.js";
import { HandsFiles } from "../../src/execution/hands-files.js";
import {
  openHandsRoots,
  resolveResourceAlias,
  sniffCapturedMime,
} from "../../src/execution/hands-paths.js";
import {
  prepareHandsResourceEpoch,
  closeHandsResourceEpoch,
} from "../../src/execution/hands-resources.js";
import type { HandsEffectCheck } from "../../src/execution/contracts.js";
import type { HandsResourceEpoch } from "../../src/execution/hands-resources.js";

const allow: HandsEffectCheck = () => Promise.resolve();

function resourceFixture(): {
  root: string;
  workspace: string;
  resources: string;
  files: HandsFiles;
  close: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "sept-resource-epoch-"));
  const workspace = join(root, "workspace");
  const resources = join(root, "resources");
  mkdirSync(join(workspace, "project/.pi/skills/example"), { recursive: true });
  mkdirSync(resources);
  writeFileSync(join(resources, "SYSTEM.md"), "TRUSTED-SYSTEM");
  writeFileSync(join(resources, "AGENTS.md"), "GLOBAL-INSTRUCTIONS");
  writeFileSync(join(workspace, "AGENTS.md"), "ANCESTOR-INSTRUCTIONS");
  writeFileSync(join(workspace, "project/AGENTS.md"), "CURRENT-INSTRUCTIONS");
  writeFileSync(
    join(workspace, "project/.pi/skills/example/SKILL.md"),
    "---\nname: example\ndescription: current workspace skill\n---\nSKILL-BODY\n",
  );
  writeFileSync(join(workspace, "project/.pi/skills/example/image.png"), "IMAGE-DATA");
  const descriptors = [workspace, resources].map((path) =>
    openSync(path, constants.O_RDONLY | constants.O_DIRECTORY),
  );
  const files = new HandsFiles([{ root, read: true, write: true }], allow, [
    { alias: "/workspace", descriptor: descriptors[0] ?? -1 },
    { alias: "/resources", descriptor: descriptors[1] ?? -1 },
  ]);
  return {
    root,
    workspace,
    resources,
    files,
    close: () => {
      files.close();
      descriptors.forEach(closeSync);
    },
  };
}

await test("prepareHandsResourceEpoch protects native instructions, internal skills/images and refresh aliases", async () => {
  const fixture = resourceFixture();
  let first: HandsResourceEpoch | undefined;
  let second: HandsResourceEpoch | undefined;
  try {
    symlinkSync("example", join(fixture.workspace, "project/.pi/skills/internal"));
    first = await prepareHandsResourceEpoch("/workspace/project", fixture.files, allow, true);
    assertEpochView(first);
    writeFileSync(join(fixture.workspace, "project/AGENTS.md"), "REFRESHED-INSTRUCTIONS");
    assert.match(first.resources.instructions, /CURRENT-INSTRUCTIONS/);
    second = await prepareHandsResourceEpoch("/workspace/project", fixture.files, allow, true);
    assert.match(second.resources.instructions, /REFRESHED-INSTRUCTIONS/);
    assert.notEqual(first.alias, second.alias);
    await assertEpochAlias(fixture.root, first);
  } finally {
    closeHandsResourceEpoch(first);
    closeHandsResourceEpoch(second);
    fixture.close();
  }
});

await test("resource capture refuses proc/control aliases and keeps original global files", async () => {
  const fixture = resourceFixture();
  try {
    symlinkSync("/proc/self/fd/0", join(fixture.workspace, "project/.pi/skills/hostile"));
    await assert.rejects(
      prepareHandsResourceEpoch("/workspace/project", fixture.files, allow, true),
    );
    assert.equal(readFileSync(join(fixture.resources, "SYSTEM.md"), "utf8"), "TRUSTED-SYSTEM");
    const roots = openHandsRoots([{ root: fixture.workspace, read: true, write: false }], []);
    try {
      assert.throws(() =>
        resolveResourceAlias(join(fixture.workspace, "project/.pi/skills/hostile"), roots),
      );
    } finally {
      roots.forEach(({ descriptor }) => {
        closeSync(descriptor);
      });
    }
  } finally {
    fixture.close();
  }
});

await test("sniffCapturedMime exposes only captured private bytes to native MIME work", async () => {
  const result = await sniffCapturedMime(Buffer.from("CAPTURED"), (path) => {
    assert.equal(readFileSync(path, "utf8"), "CAPTURED");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    return Promise.resolve("image/png");
  });
  assert.equal(result, "image/png");
  await assert.rejects(
    sniffCapturedMime(Buffer.from("CAPTURED"), (path) =>
      Promise.reject(new SeptError(`PRIVATE-PATH-CANARY ${path}`)),
    ),
    (error: unknown) =>
      error instanceof SeptError && error.message === "Hands captured MIME could not be inspected",
  );
});

await test("resource epoch admits its exact bounded file capacity and refuses one more", async () => {
  const fixture = resourceFixture();
  let epoch: HandsResourceEpoch | undefined;
  try {
    rmSync(join(fixture.workspace, "project/.pi/skills"), { recursive: true });
    // Two projected and two workspace instruction files consume four of the 256-file bound.
    for (let index = 0; index < 252; index += 1) {
      writeFileSync(join(fixture.resources, `resource-${String(index)}.txt`), "bounded");
    }
    epoch = await prepareHandsResourceEpoch("/workspace/project", fixture.files, allow, true);
    writeFileSync(join(fixture.resources, "one-more.txt"), "beyond");
    await assert.rejects(
      prepareHandsResourceEpoch("/workspace/project", fixture.files, allow, true),
    );
    assert.equal(readFileSync(join(fixture.resources, "one-more.txt"), "utf8"), "beyond");
  } finally {
    closeHandsResourceEpoch(epoch);
    fixture.close();
  }
});

function assertEpochView(first: HandsResourceEpoch): void {
  assert.equal(first.resources.system, "TRUSTED-SYSTEM");
  assert.equal(
    first.resources.instructions,
    "GLOBAL-INSTRUCTIONS\n\nANCESTOR-INSTRUCTIONS\n\nCURRENT-INSTRUCTIONS",
  );
  assert.match(first.resources.skills, /\/resources\/epochs\/sept-hands-epoch-/);
  assert.doesNotMatch(first.resources.skills, /sept-resource-epochs|\/Users\/|\/home\//);
  assert.equal(lstatSync(first.directory).mode & 0o777, 0o700);
  assert.equal(
    readFileSync(join(first.directory, "workspace/project/.pi/skills/internal/image.png"), "utf8"),
    "IMAGE-DATA",
  );
}
async function assertEpochAlias(root: string, first: HandsResourceEpoch): Promise<void> {
  const files = new HandsFiles([{ root, read: true, write: false }], allow, [
    { alias: first.alias, descriptor: first.descriptor },
  ]);
  try {
    assert.equal(
      (
        await files.read(`${first.alias}/workspace/project/.pi/skills/example/image.png`)
      ).toString(),
      "IMAGE-DATA",
    );
    await assert.rejects(files.write(`${first.alias}/agent/SYSTEM.md`, "DENIED"));
  } finally {
    files.close();
  }
}

await test("ordinary projects without .pi load a protected resource epoch", async () => {
  const fixture = resourceFixture();
  let epoch: HandsResourceEpoch | undefined;
  try {
    rmSync(join(fixture.workspace, "project/.pi"), { recursive: true });
    epoch = await prepareHandsResourceEpoch("/workspace/project", fixture.files, allow, true);
    assert.match(epoch.resources.instructions, /CURRENT-INSTRUCTIONS/);
    assert.equal(epoch.resources.skills, "");
  } finally {
    closeHandsResourceEpoch(epoch);
    fixture.close();
  }
});
