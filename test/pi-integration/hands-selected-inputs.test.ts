/** Bounded selected-input admission; installed Docker proof owns actual image qualification. */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SeptError } from "../../src/durable/index.js";
import type { DockerHandsConfiguration } from "../../src/execution/contracts.js";
import {
  loadHandsConfiguration,
  parseCustomHand,
} from "../../src/execution/profile-configuration.js";
import {
  parseImageSelected,
  validateSelectedInputs,
  HANDS_IMAGE_ISOLATION_PROBE,
} from "../../src/execution/hands-selected-inputs.js";
import {
  validateCapabilities,
  capabilityTools,
  defaultCapabilities,
} from "../../src/execution/capability-admission.js";
import { qualifyKernelProfile } from "../../src/execution/docker-control.js";
import { DockerEngineControl } from "../../src/execution/docker-engine.js";
import { suppliedEngine } from "./backend-support.js";
import { profileFixture } from "./capability-profile-support.js";

void test("image aliases accept only exact bounded entries without host path discovery", () => {
  assert.deepEqual(parseImageSelected(undefined), []);
  assert.deepEqual(parseImageSelected([{ alias: "A_1-valid" }, { alias: "a".repeat(64) }]), [
    { alias: "A_1-valid" },
    { alias: "a".repeat(64) },
  ]);
  assert.equal(
    parseImageSelected(Array.from({ length: 8 }, (_, index) => ({ alias: String(index) }))).length,
    8,
  );
  for (const value of [
    null,
    {},
    [null],
    [{}],
    [{ alias: "" }],
    [{ alias: "." }],
    [{ alias: "a/b" }],
    [{ alias: "a".repeat(65) }],
    [{ alias: "a", source: "/host" }],
    Array.from({ length: 9 }, (_, index) => ({ alias: String(index) })),
  ]) {
    assert.throws(() => parseImageSelected(value), SeptError);
  }
});

void test("configuration normalizes image aliases and refuses combined collisions, overflow and mutable binds", async () => {
  const fixture = await suppliedEngine();
  const { configuration, brain } = profileFixture();
  const path = join(brain, "configuration.json");
  const input = {
    ...configuration,
    engineSocket: fixture.path,
    dataDomain: "private",
    workspaceLimits: { bytes: 134217728, inodes: 32768 },
  };
  const load = (change: Record<string, unknown>): DockerHandsConfiguration => {
    writeFileSync(path, JSON.stringify({ ...input, ...change }));
    return loadHandsConfiguration(path);
  };
  try {
    assert.deepEqual(load({}).imageSelected, []);
    assert.deepEqual(load({ imageSelected: [{ alias: "baked" }] }).imageSelected, [
      { alias: "baked" },
    ]);
    assert.equal(
      load({
        readOnlyMounts: [{ source: input.resources, destination: `/selected/${"a".repeat(65)}` }],
      }).readOnlyMounts.length,
      1,
    );
    for (const change of invalidConfigurations(input.resources)) {
      assert.throws(() => load(change), SeptError);
    }
  } finally {
    await fixture.close();
  }
});

void test("image selected grants are read-only and must all be readable for search and execution", () => {
  const { configuration } = profileFixture();
  const selected: DockerHandsConfiguration = {
    ...configuration,
    shell: true,
    dataDomain: "private",
    imageSelected: [{ alias: "baked" }],
  };
  const full = validateCapabilities(
    { ...defaultCapabilities(), mode: "full_access", execute: true },
    selected,
  );
  assert.deepEqual(full.selected, [{ root: "/selected/baked", read: true, write: false }]);
  assert.ok(capabilityTools(full, selected).includes("grep"));
  assert.throws(
    () => validateCapabilities({ ...full, mode: "scoped", selected: [] }, selected),
    /all selected mounts/,
  );
  assert.throws(
    () =>
      validateCapabilities(
        {
          ...full,
          mode: "scoped",
          selected: [{ root: "/selected/baked", read: true, write: true }],
        },
        selected,
      ),
    /grant differs/,
  );
  assert.equal(capabilityTools(defaultCapabilities(), selected).includes("grep"), false);
});

void test("opening qualification invokes the pinned image probe before capacity and both selected checker modes", async () => {
  const fixture = await suppliedEngine();
  const engine = await DockerEngineControl.open(fixture.path);
  const { configuration, inspected } = profileFixture();
  const selected: DockerHandsConfiguration = {
    ...configuration,
    engineSocket: fixture.path,
    dataDomain: "private",
    imageSelected: [{ alias: "baked" }],
    readOnlyMounts: [{ source: fixture.root, destination: "/selected/sealed" }],
  };
  const commands: string[][] = [];
  engine.exec = (_id, execution): Promise<string> => {
    commands.push(execution.command);
    return Promise.resolve(checkerResponse(execution.command));
  };
  try {
    await qualifyKernelProfile(selected, inspected, engine);
    assert.ok(commands[0]?.includes(HANDS_IMAGE_ISOLATION_PROBE));
    assert.ok(commands[1]?.some((entry) => entry.includes("memory.max")));
    assert.deepEqual(commands.slice(2), [
      ["/app/hands-guard-check", "--sealed", "/selected/sealed"],
      ["/app/hands-guard-check", "--image-snapshot", "/selected/baked"],
    ]);
    engine.exec = (): Promise<string> => Promise.resolve("old image");
    await assert.rejects(qualifyKernelProfile(selected, inspected, engine), /image isolation/);
    await assert.rejects(validateSelectedInputs(selected, engine), /immutable provenance/);
    await assert.rejects(
      validateSelectedInputs({ ...selected, dataDomain: "mutable-file-bind" }, engine),
      /private data domain/,
    );
  } finally {
    await engine.close();
    await fixture.close();
  }
});

function checkerResponse(command: string[]): string {
  if (command.includes(HANDS_IMAGE_ISOLATION_PROBE)) {
    return "isolated";
  }
  if (command[1] === "--sealed") {
    return "sealed\n";
  }
  if (command[1] === "--image-snapshot") {
    return "image-snapshot\n";
  }
  return "qualified";
}

void test("opening image probe pins the private provenance bytes and installed native resolution", () => {
  const provenance = readFileSync("image/pi-native-search/provenance.json");
  assert.ok(
    HANDS_IMAGE_ISOLATION_PROBE.includes(createHash("sha256").update(provenance).digest("hex")),
  );
  assert.ok(
    HANDS_IMAGE_ISOLATION_PROBE.includes(
      "import.meta.resolve('@earendil-works/pi-coding-agent', 'file:///app/dist/src/execution/hands-entry.js')",
    ),
  );
});

void test("image custom code requires exact admitted alias, pin and explicit replay declaration", () => {
  const valid = { path: "/selected/hand/hand.mjs", sha256: "a".repeat(64), replay: "safe" };
  for (const replay of ["safe", "unsafe"]) {
    assert.deepEqual(parseCustomHand({ ...valid, replay }, [], true, [{ alias: "hand" }]), {
      ...valid,
      replay,
    });
  }
  for (const path of ["/selected/hand", "/selected/hand-other/a.mjs", "/selected/other/a.mjs"]) {
    assert.throws(
      () => parseCustomHand({ ...valid, path }, [], true, [{ alias: "hand" }]),
      SeptError,
    );
  }
  assert.throws(
    () => parseCustomHand({ ...valid, sha256: "tag" }, [], true, [{ alias: "hand" }]),
    SeptError,
  );
});

function invalidConfigurations(resources: string): Record<string, unknown>[] {
  return [
    { imageSelected: [{ alias: "a" }, { alias: "a" }] },
    {
      imageSelected: [{ alias: "a" }],
      readOnlyMounts: [{ source: resources, destination: "/selected/a" }],
    },
    {
      imageSelected: Array.from({ length: 8 }, (_, index) => ({ alias: String(index) })),
      readOnlyMounts: [{ source: resources, destination: "/selected/ninth" }],
    },
    {
      imageSelected: [{ alias: "a" }],
      dataDomain: "mutable-file-bind",
      workspaceLimits: undefined,
    },
    {
      imageSelected: [{ alias: "a" }],
      readWriteMounts: [{ source: resources, destination: "/selected/rw" }],
    },
  ];
}
