import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { command, environment, managed, ready, stop } from "./process.mjs";
import {
  archiveConfiguration,
  imageConfiguration,
  sameImageConfiguration,
  sha256,
} from "./release-contract.mjs";

const root = process.cwd();
const output = resolve(process.env.SEPT_CI_OUTPUT);
mkdirSync(output, { mode: 0o700 });
const receipt = {
  started: new Date().toISOString(),
  pid: process.pid,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  commands: [],
  finalizers: [],
  passed: false,
};
const save = () =>
  writeFileSync(join(output, "verification.json"), JSON.stringify(receipt, null, 2) + "\n");
const record = (item) => {
  receipt.commands.push(item);
  save();
};
const run = (program, args, options = {}, cwd = root) =>
  command(cwd, program, args, record, options);
let imageContainer;
let worker;

async function main() {
  assert.equal(process.platform, "linux", "The full gate requires native Linux");
  assert.equal(process.arch, "x64", "The published image is Linux/amd64");
  receipt.commit = process.env.GITHUB_SHA ?? run("git", ["rev-parse", "HEAD"]);
  const socket = realpathSync(process.env.SEPT_ENGINE_SOCKET ?? "/run/docker.sock");
  assert.equal(statSync(socket).isSocket(), true);
  const dockerConfiguration = join(output, "docker-config");
  mkdirSync(dockerConfiguration, { mode: 0o700 });
  const docker = (args) =>
    run("docker", ["--host", `unix://${socket}`, ...args], {
      env: environment({ DOCKER_CONFIG: dockerConfiguration }),
    });
  const contextSocket = new URL(
    run("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]),
  ).pathname;
  assert.equal(realpathSync(contextSocket), socket, "Gate fixtures must use the pinned Engine");
  receipt.engine = JSON.parse(docker(["info", "--format", "{{json .}}"]));
  assert.equal(receipt.engine.CgroupVersion, "2");
  run("npm", ["ci"]);
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  docker([
    "build",
    "--no-cache",
    "--label",
    `org.opencontainers.image.version=${version}`,
    "--label",
    `org.opencontainers.image.revision=${receipt.commit}`,
    "--label",
    "org.opencontainers.image.source=https://github.com/DB-Conneely/sept",
    "--iidfile",
    join(output, "image.iid"),
    ".",
  ]);
  const image = readFileSync(join(output, "image.iid"), "utf8").trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const facts = JSON.parse(docker(["image", "inspect", image]))[0];
  assert.equal(facts.Architecture, "amd64");
  assert.equal(facts.Os, "linux");
  receipt.image = { id: image, architecture: facts.Architecture, os: facts.Os };
  const gate = run("npm", ["run", "gate"], { env: environment({ SEPT_HANDS_TEST_IMAGE: image }) });
  assert.match(gate, /# fail 0\b/);
  const skips = [...gate.matchAll(/# skipped (\d+)/g)].map((match) => Number(match[1]));
  assert.ok(
    skips.length >= 2 && skips.every((count) => count === 0),
    "Release gates cannot silently skip Docker tests",
  );
  run("npm", ["audit"]);
  const packed = JSON.parse(
    run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output]),
  );
  assert.equal(packed.length, 1);
  const tarball = join(output, packed[0].filename);
  receipt.package = {
    name: packed[0].name,
    version: packed[0].version,
    file: packed[0].filename,
    integrity: packed[0].integrity,
    sha256: sha256(tarball),
  };
  const consumer = await coldConsumer(tarball);
  await installedCli(consumer);
  await installedImage(consumer, image, docker);
  const localTag = `sept-ci-verified-${randomBytes(12).toString("hex")}:${receipt.package.version}`;
  assert.equal(
    docker(["image", "ls", "--quiet", localTag]),
    "",
    "Never replace an unrelated local image tag",
  );
  docker(["tag", image, localTag]);
  docker(["image", "save", "--output", join(output, "image.tar"), localTag]);
  const entries = JSON.parse(run("tar", ["-xOf", join(output, "image.tar"), "manifest.json"]));
  const identity = archiveConfiguration(entries, localTag);
  const raw = run("tar", ["-xOf", join(output, "image.tar"), identity.path], { rawOutput: true });
  const configuration = imageConfiguration(raw, identity, receipt.package.version, receipt.commit);
  docker(["load", "--input", join(output, "image.tar")]);
  const loaded = JSON.parse(docker(["image", "inspect", localTag]))[0];
  sameImageConfiguration(configuration.config, loaded.Config);
  assert.deepEqual(loaded.RootFS.Layers, configuration.rootfs.diff_ids);
  receipt.image.loadedId = loaded.Id;
  receipt.image.localTag = localTag;
  receipt.image.configuration = identity.digest;
  receipt.image.archive = "image.tar";
  receipt.image.sha256 = sha256(join(output, "image.tar"));
  receipt.passed = true;
  receipt.finished = new Date().toISOString();
  save();
}

async function coldConsumer(tarball) {
  // This root is outside the checkout and cannot resolve repository node_modules.
  const consumer = mkdtempSync(join(tmpdir(), "sept-ci-"));
  receipt.consumer = consumer;
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", ["install", "--omit=dev", "--ignore-scripts", "--save-exact", tarball], {}, consumer);
  run("npm", ["ls", "--omit=dev", "--all"], {}, consumer);
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
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        lib: ["ES2023"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        types: ["node"],
        typeRoots: [join(root, "node_modules/@types")],
      },
      include: ["imports.ts"],
    }),
  );
  run(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "-p", join(consumer, "tsconfig.json")],
    {},
    consumer,
  );
  run(
    process.execPath,
    ["consumer.mjs"],
    { env: environment({ SEPT_TOKEN: "sept-ci-only-noncredential" }) },
    consumer,
  );
  return consumer;
}

async function installedCli(consumer) {
  const paths = ["cli-state", "cli-agent", "cli-workspace"].map((name) => join(consumer, name));
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
    environment({ SEPT_TOKEN: "sept-ci-only-noncredential" }),
    record,
  );
  try {
    const url = await ready(worker);
    run(
      process.execPath,
      ["consumer.mjs", url],
      { env: environment({ SEPT_TOKEN: "sept-ci-only-noncredential" }) },
      consumer,
    );
    run(
      join(consumer, "node_modules/.bin/sept"),
      ["health", "--url", `${url}/health`],
      { env: environment({ SEPT_TOKEN: "sept-ci-only-noncredential" }) },
      consumer,
    );
  } finally {
    await stop(worker);
    worker = undefined;
  }
}

async function installedImage(consumer, image, docker) {
  const nonce = randomBytes(8).toString("hex");
  imageContainer = docker([
    "run",
    "--detach",
    "--init",
    "--no-healthcheck",
    "--read-only",
    "--network",
    "host",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "1g",
    "--cpus",
    "2",
    "--name",
    `sept-ci-${nonce}`,
    "--env",
    "SEPT_TOKEN=sept-ci-only-noncredential",
    "--env",
    "OTEL_SDK_DISABLED=true",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=16777216,mode=1777",
    ...["/state", "/pi-agent", "/workspace"].flatMap((path) => [
      "--tmpfs",
      `${path}:rw,nosuid,nodev,noexec,size=67108864,uid=10001,gid=10001,mode=0700`,
    ]),
    image,
    "./sept",
    "worker",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--state-dir",
    "/state/runs",
    "--agent-dir",
    "/pi-agent",
    "--workspace-root",
    "/workspace",
  ]);
  receipt.image.container = imageContainer;
  const before = JSON.parse(docker(["inspect", imageContainer]))[0];
  receipt.image.generation = before.State.StartedAt;
  try {
    const url = await imageReady(docker);
    run(
      process.execPath,
      ["consumer.mjs", url],
      { env: environment({ SEPT_TOKEN: "sept-ci-only-noncredential" }) },
      consumer,
    );
    docker(["exec", imageContainer, "./sept", "health", "--url", `${url}/health`]);
  } finally {
    // Export tmpfs before stop, but a failed export must never skip shutdown.
    try {
      docker(["cp", `${imageContainer}:/state`, join(output, "image-state")]);
    } finally {
      finalizeImage(docker);
    }
  }
}

async function imageReady(docker) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const match = docker(["logs", imageContainer]).match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) {
      return `http://127.0.0.1:${match[1]}`;
    }
    assert.equal(JSON.parse(docker(["inspect", imageContainer]))[0].State.Running, true);
    await delay(100);
  }
  assert.fail("Image worker readiness budget exhausted");
}

function finalizeImage(docker) {
  const current = JSON.parse(docker(["inspect", imageContainer]))[0];
  assert.equal(current.State.StartedAt, receipt.image.generation);
  if (current.State.Running) {
    docker(["stop", "--time", "15", imageContainer]);
  }
  const after = JSON.parse(docker(["inspect", imageContainer]))[0];
  const finalizer = {
    container: imageContainer,
    generation: after.State.StartedAt,
    state: after.State,
  };
  receipt.finalizers.push(finalizer);
  save();
  imageContainer = undefined;
  assert.equal(after.State.StartedAt, receipt.image.generation);
  assert.equal(after.State.Running, false);
  assert.equal(after.State.Pid, 0);
  assert.equal(after.State.ExitCode, 0);
}

try {
  await main();
} catch (error) {
  receipt.failure = String(error);
  throw error;
} finally {
  try {
    if (worker) {
      await stop(worker);
    }
  } finally {
    try {
      if (imageContainer) {
        const socket = realpathSync(process.env.SEPT_ENGINE_SOCKET ?? "/run/docker.sock");
        finalizeImage((args) => run("docker", ["--host", `unix://${socket}`, ...args]));
      }
    } finally {
      save();
    }
  }
}
