import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { environment } from "./process.mjs";
import {
  archiveConfiguration,
  imageConfiguration,
  newer,
  registryDescriptor,
  npmPublishEnvironment,
  releaseIdentity,
  sameIntegrity,
  sha256,
  versionParts,
} from "./release-contract.mjs";

const artifactRoot =
  process.env.SEPT_CI_ARTIFACTS ?? mkdtempSync(join(tmpdir(), "sept-missing-artifact-"));
const output = resolve(artifactRoot, "publication");
mkdirSync(output, { mode: 0o700 });
const dockerConfiguration = mkdtempSync(join(tmpdir(), "sept-publish-docker-"));
const receipt = { started: new Date().toISOString(), commands: [], passed: false };
const save = () =>
  writeFileSync(join(output, "publication.json"), JSON.stringify(receipt, null, 2) + "\n");
let directory;
let verified;
let version;
let tag;
const repository = "DB-Conneely/sept";
const registryImage = "ghcr.io/db-conneely/sept";
const ghToken = process.env.GH_TOKEN;

function attempt(program, args, options = {}) {
  const started = new Date().toISOString();
  const result = spawnSync(program, args, {
    env: environment(program === "docker" ? { DOCKER_CONFIG: dockerConfiguration } : {}),
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  receipt.commands.push({
    command: [program, ...args],
    pid: result.pid,
    started,
    finished: new Date().toISOString(),
    code: result.status,
    signal: result.signal,
    joined: true,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.code,
  });
  save();
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

function run(program, args, options) {
  const result = attempt(program, args, options);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function npmView(specification, field) {
  const result = attempt("npm", [
    "view",
    specification,
    field,
    "--json",
    "--registry=https://registry.npmjs.org",
  ]);
  if (result.status === 0) {
    return JSON.parse(result.stdout);
  }
  const failure = JSON.parse(result.stdout);
  assert.equal(failure.error?.code, "E404", result.stderr);
  return undefined;
}

function manifest(reference) {
  const result = attempt("docker", ["manifest", "inspect", reference]);
  if (result.status === 0) {
    return JSON.parse(result.stdout);
  }
  assert.equal(result.status, 1);
  assert.match(result.stderr, /manifest unknown|no such manifest|manifest not found/i);
  return undefined;
}

async function api(path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    ...options,
    signal: AbortSignal.timeout(120_000),
    headers: {
      authorization: `Bearer ${ghToken}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...options.headers,
    },
  });
  const text = await boundedText(response);
  if (response.status === 404 && !options.method) {
    return undefined;
  }
  assert.ok(response.ok, `GitHub API failed with HTTP ${response.status}`);
  return text ? JSON.parse(text) : undefined;
}

async function boundedText(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      assert.ok(bytes <= 1024 * 1024, "Registry/API response exceeded its bound");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel();
  }
}

function publishNpm() {
  const specification = `${verified.package.name}@${version}`;
  const existing = npmView(specification, "dist.integrity");
  const latest = npmView(verified.package.name, "dist-tags.latest");
  receipt.advanceLatest = latest === undefined || !newer(latest, version);
  if (existing !== undefined) {
    sameIntegrity(verified.package.integrity, existing);
    receipt.npm = "already published with matching integrity";
    return;
  }
  run(
    "npm",
    [
      "publish",
      join(directory, verified.package.file),
      "--ignore-scripts",
      "--access",
      "public",
      "--provenance",
      "--tag",
      receipt.advanceLatest ? "latest" : "ci",
    ],
    { env: npmPublishEnvironment(process.env) },
  );
  sameIntegrity(verified.package.integrity, npmView(specification, "dist.integrity"));
  receipt.npm = "published and registry integrity confirmed";
}

function registryConfiguration(reference) {
  const document = manifest(reference);
  if (!document) {
    return undefined;
  }
  const descriptor = registryDescriptor(document);
  if (descriptor.kind === "configuration") {
    return descriptor.digest;
  }
  const platform = registryDescriptor(manifest(`${registryImage}@${descriptor.digest}`));
  assert.equal(platform.kind, "configuration", "Nested image indexes are not supported");
  return platform.digest;
}

function publishImage() {
  const archive = join(directory, verified.image.archive);
  const entries = JSON.parse(run("tar", ["-xOf", archive, "manifest.json"]));
  const identity = archiveConfiguration(entries, verified.image.localTag);
  sameIntegrity(verified.image.configuration, identity.digest);
  const extracted = attempt("tar", ["-xOf", archive, identity.path]);
  assert.equal(extracted.status, 0);
  const configuration = imageConfiguration(extracted.stdout, identity, version, verified.commit);
  run("docker", ["login", "ghcr.io", "--username", process.env.GITHUB_ACTOR, "--password-stdin"], {
    input: ghToken,
  });
  assert.equal(
    run("docker", ["image", "ls", "--quiet", verified.image.localTag]),
    "",
    "Never replace an unrelated local tag",
  );
  run("docker", ["load", "--input", archive]);
  const facts = JSON.parse(run("docker", ["image", "inspect", verified.image.localTag]))[0];
  assert.equal(facts.Architecture, "amd64");
  assert.equal(facts.Os, "linux");
  assert.deepEqual(facts.RootFS.Layers, configuration.rootfs.diff_ids);
  assert.deepEqual(facts.Config, configuration.config);
  const target = `${registryImage}:${version}`;
  const existing = registryConfiguration(target);
  if (existing) {
    sameIntegrity(identity.digest, existing);
  } else {
    run("docker", ["tag", verified.image.localTag, target]);
    run("docker", ["push", target]);
  }
  sameIntegrity(identity.digest, registryConfiguration(target));
  if (receipt.advanceLatest) {
    run("docker", ["tag", verified.image.localTag, `${registryImage}:latest`]);
    run("docker", ["push", `${registryImage}:latest`]);
  }
  receipt.image = { reference: target, configuration: identity.digest, manifest: manifest(target) };
}

async function publishRelease() {
  const reference = await api(`/git/ref/tags/${tag}`);
  let release = await api(`/releases/tags/${tag}`);
  releaseIdentity(verified.commit, tag, release, reference);
  const metadata = {
    commit: verified.commit,
    version,
    npm: verified.package,
    image: receipt.image,
  };
  const body = `${verified.package.name}@${version}\n\nSource: ${verified.commit}\nDocker: ${registryImage}:${version} (Linux/amd64)\n\nNo deployment or live-provider/model verification is performed by this release workflow.`;
  if (!release) {
    release = await api("/releases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: verified.commit,
        name: tag,
        body,
        draft: true,
        make_latest: "false",
      }),
    });
  }
  await upload(
    release,
    verified.package.file,
    readFileSync(join(directory, verified.package.file)),
  );
  await upload(release, "release.json", Buffer.from(JSON.stringify(metadata, null, 2) + "\n"));
  const published = await api(`/releases/${release.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draft: false, make_latest: receipt.advanceLatest ? "true" : "false" }),
  });
  const finalReference = await api(`/git/ref/tags/${tag}`);
  releaseIdentity(verified.commit, tag, published, finalReference);
  assert.equal(published.draft, false);
  assert.ok(finalReference, "Published source tag must be independently observed");
  receipt.release = published.html_url;
}

async function upload(release, name, bytes) {
  assert.ok(bytes.byteLength <= 10 * 1024 * 1024, "Release asset exceeds the upload bound");
  const existing = release.assets.find((asset) => asset.name === name);
  const digest = `sha256:${(await import("node:crypto")).createHash("sha256").update(bytes).digest("hex")}`;
  if (existing) {
    sameIntegrity(digest, existing.digest);
    return;
  }
  const response = await fetch(
    `${release.upload_url.split("{")[0]}?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${ghToken}`, "content-type": "application/octet-stream" },
      body: bytes,
    },
  );
  assert.equal(response.status, 201);
  sameIntegrity(digest, JSON.parse(await boundedText(response)).digest);
}

try {
  save();
  assert.ok(process.env.SEPT_CI_ARTIFACTS, "SEPT_CI_ARTIFACTS is required");
  const attempts = readdirSync(artifactRoot)
    .filter((name) => /^sept-verified-amd64-attempt[1-9]\d*$/.test(name))
    .sort((left, right) => Number(left.split("attempt")[1]) - Number(right.split("attempt")[1]));
  assert.ok(attempts.length > 0, "A retained verified artifact is required");
  directory = resolve(artifactRoot, attempts.at(-1));
  verified = JSON.parse(readFileSync(join(directory, "verification.json"), "utf8"));
  version = verified.package?.version;
  tag = `v${version}`;
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.equal(process.env.GITHUB_EVENT_NAME, "push");
  assert.equal(verified.passed, true);
  assert.equal(verified.commit, process.env.GITHUB_SHA);
  versionParts(version);
  assert.match(verified.package.file, /^sept-agent-\d+\.\d+\.\d+\.tgz$/);
  assert.equal(verified.image.archive, "image.tar");
  assert.match(verified.image.localTag, /^sept-ci-verified-[a-f0-9]{24}:\d+\.\d+\.\d+$/);
  assert.equal(verified.image.localTag.split(":")[1], version);
  assert.ok(ghToken);
  sameIntegrity(verified.package.sha256, sha256(join(directory, verified.package.file)));
  sameIntegrity(verified.image.sha256, sha256(join(directory, verified.image.archive)));
  publishNpm();
  publishImage();
  await publishRelease();
  receipt.passed = true;
} catch (error) {
  receipt.failure = String(error);
  throw error;
} finally {
  receipt.finished = new Date().toISOString();
  save();
}
