import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { command, environment, managed, ready, stop } from "./process.mjs";
import { sameIntegrity, sha256, verifiedDirectory } from "./release-contract.mjs";

const root = process.cwd();
const output = resolve(process.env.SEPT_CI_OUTPUT);
mkdirSync(output, { mode: 0o700 });
const receipt = {
  started: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  commands: [],
  passed: false,
};
const save = () =>
  writeFileSync(join(output, "macos-verification.json"), JSON.stringify(receipt, null, 2) + "\n");
const record = (item) => {
  receipt.commands.push(item);
  save();
};
const run = (program, args, options = {}, cwd = root) =>
  command(cwd, program, args, record, options);
let worker;
try {
  assert.equal(process.platform, "darwin");
  assert.ok(["x64", "arm64"].includes(process.env.SEPT_CI_NODE_ARCH));
  assert.equal(
    process.arch,
    process.env.SEPT_CI_NODE_ARCH,
    "Native macOS architecture is required",
  );
  const directory = verifiedDirectory(resolve(process.env.SEPT_CI_ARTIFACTS), "amd64");
  const verified = JSON.parse(readFileSync(join(directory, "verification.json"), "utf8"));
  assert.equal(verified.passed, true);
  assert.equal(verified.commit, process.env.GITHUB_SHA);
  assert.match(verified.package.file, /^sept-agent-\d+\.\d+\.\d+\.tgz$/);
  const tarball = join(directory, verified.package.file);
  sameIntegrity(verified.package.sha256, sha256(tarball));
  receipt.commit = verified.commit;
  receipt.package = verified.package;
  run("npm", ["ci"]);
  const consumer = mkdtempSync(join(tmpdir(), "sept-macos-"));
  receipt.consumer = consumer;
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", ["install", "--omit=dev", "--ignore-scripts", "--save-exact", tarball], {}, consumer);
  run("npm", ["ls", "--omit=dev", "--all", "--json"], {}, consumer);
  run("npm", ["audit", "--omit=dev"], {}, consumer);
  copyFileSync(join(root, "scripts/ci/consumer.mjs"), join(consumer, "consumer.mjs"));
  writeFileSync(
    join(consumer, "imports.ts"),
    [
      'import { createWorker, SeptError } from "sept-agent";',
      'import { createTaskClient, TaskClientError } from "sept-agent/client";',
      'import { loadHandsConfiguration, networkFirewall } from "sept-agent/hands";',
      "export const imports = { createWorker, SeptError, createTaskClient, TaskClientError, loadHandsConfiguration, networkFirewall };",
    ].join("\n") + "\n",
  );
  run(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--strict",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2023",
      "--lib",
      "ES2023",
      "--skipLibCheck",
      "false",
      "--noEmit",
      "--types",
      "node",
      "--typeRoots",
      join(root, "node_modules/@types"),
      "imports.ts",
    ],
    {},
    consumer,
  );
  const env = environment({ SEPT_TOKEN: "sept-ci-only-noncredential" });
  run(process.execPath, ["consumer.mjs"], { env }, consumer);
  const paths = ["state", "agent", "workspace"].map((name) => join(consumer, name));
  paths.forEach((path) => mkdirSync(path, { mode: 0o700 }));
  worker = managed(
    consumer,
    [
      join(consumer, "node_modules/.bin/sept"),
      "worker",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--state-dir",
      paths[0],
      "--agent-dir",
      paths[1],
      "--workspace-root",
      paths[2],
    ],
    env,
    record,
  );
  const url = await ready(worker);
  run(process.execPath, ["consumer.mjs", url], { env }, consumer);
  run(
    join(consumer, "node_modules/.bin/sept"),
    ["health", "--url", `${url}/health`],
    { env },
    consumer,
  );
  await stop(worker);
  worker = undefined;
  receipt.qualification =
    "Native macOS cold install, strict public declarations, embedded/CLI worker readiness, auth/client errors and graceful stop. Linux Docker hands/task effects are qualified separately on Apple Silicon; no Intel task/effect qualification is inferred.";
  receipt.passed = true;
} catch (error) {
  receipt.failure = String(error);
  throw error;
} finally {
  try {
    if (worker) await stop(worker);
  } finally {
    receipt.finished = new Date().toISOString();
    save();
  }
}
