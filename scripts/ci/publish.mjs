import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { environment } from "./process.mjs";
import {
  npmView,
  priorSubmission,
  shouldSubmit,
  submissionState,
  waitForIntegrity,
} from "./npm-registry.mjs";
import {
  archiveConfiguration,
  imageConfiguration,
  newer,
  registryDescriptor,
  registryIndex,
  npmPublishEnvironment,
  releaseIdentity,
  sameIntegrity,
  sameImageConfiguration,
  sha256,
  versionParts,
  verifiedDirectory,
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
let platforms;
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

async function publishNpm() {
  const specification = `${verified.package.name}@${version}`;
  const record = (item) => {
    receipt.commands.push(item);
    save();
  };
  const read = (budget) => npmView(specification, "dist.integrity", record, budget);
  const binding = {
    runId: process.env.GITHUB_RUN_ID,
    commit: verified.commit,
    version,
    integrity: verified.package.integrity,
  };
  assert.match(binding.runId, /^[1-9]\d*$/);
  const previous = priorSubmission(artifactRoot, binding);
  const existing = read(15_000);
  const latest = npmView(verified.package.name, "dist-tags.latest", record);
  receipt.advanceLatest = latest === undefined || !newer(latest, version);
  if (existing !== undefined) {
    sameIntegrity(verified.package.integrity, existing);
    receipt.npm = "already published with matching integrity";
    return;
  }
  const submit = shouldSubmit(previous, process.env.GITHUB_RUN_ATTEMPT);
  const submission = previous ?? { binding, state: "submitted" };
  const store = () =>
    writeFileSync(join(output, "npm-submission.json"), JSON.stringify(submission, null, 2) + "\n");
  store();
  if (submit) {
    submission.state = "submitted";
    store();
    const result = attempt(
      "npm",
      [
        "publish",
        join(directory, verified.package.file),
        "--ignore-scripts",
        "--access",
        "public",
        "--provenance",
        "--json",
        "--tag",
        receipt.advanceLatest ? "latest" : "ci",
      ],
      { env: npmPublishEnvironment(process.env) },
    );
    submission.state = submissionState(result.status, result.stdout);
    store();
    assert.equal(result.status, 0, result.stderr);
  }
  receipt.npmAvailability = [];
  await waitForIntegrity({
    read,
    expected: verified.package.integrity,
    record: (item) => {
      receipt.npmAvailability.push(item);
      save();
    },
  });
  receipt.npm = "public registry integrity confirmed after bounded scanning wait";
}

function registryPlatform(reference, architecture) {
  const document = manifest(reference);
  if (!document) return undefined;
  const descriptor = registryDescriptor(document, architecture);
  if (descriptor.kind === "configuration") {
    const observed = JSON.parse(
      run("docker", [
        "buildx",
        "imagetools",
        "inspect",
        reference,
        "--format",
        "{{json .Manifest}}",
      ]),
    );
    assert.match(observed.digest, /^sha256:[a-f0-9]{64}$/);
    return { digest: observed.digest, configuration: descriptor.digest };
  }
  const platform = registryDescriptor(
    manifest(`${registryImage}@${descriptor.digest}`),
    architecture,
  );
  assert.equal(platform.kind, "configuration", "Nested image indexes are not supported");
  return { digest: descriptor.digest, configuration: platform.digest };
}

function publishImages() {
  run("docker", ["login", "ghcr.io", "--username", process.env.GITHUB_ACTOR, "--password-stdin"], {
    input: ghToken,
  });
  const images = {};
  for (const {
    architecture,
    directory: platformDirectory,
    verified: platformVerified,
  } of platforms) {
    const archive = join(platformDirectory, platformVerified.image.archive);
    const entries = JSON.parse(run("tar", ["-xOf", archive, "manifest.json"]));
    const identity = archiveConfiguration(entries, platformVerified.image.localTag);
    sameIntegrity(platformVerified.image.configuration, identity.digest);
    const extracted = attempt("tar", ["-xOf", archive, identity.path]);
    assert.equal(extracted.status, 0);
    const configuration = imageConfiguration(
      extracted.stdout,
      identity,
      version,
      verified.commit,
      architecture,
    );
    assert.equal(
      run("docker", ["image", "ls", "--quiet", platformVerified.image.localTag]),
      "",
      "Never replace an unrelated local tag",
    );
    run("docker", ["load", "--input", archive]);
    const facts = JSON.parse(
      run("docker", ["image", "inspect", platformVerified.image.localTag]),
    )[0];
    assert.equal(facts.Architecture, architecture);
    assert.equal(facts.Os, "linux");
    assert.deepEqual(facts.RootFS.Layers, configuration.rootfs.diff_ids);
    sameImageConfiguration(configuration.config, facts.Config);
    const target = `${registryImage}:${version}-${architecture}`;
    const existing = registryPlatform(target, architecture);
    if (existing) {
      sameIntegrity(identity.digest, existing.configuration);
    } else {
      run("docker", ["tag", platformVerified.image.localTag, target]);
      run("docker", ["push", target]);
    }
    const published = registryPlatform(target, architecture);
    sameIntegrity(identity.digest, published.configuration);
    images[architecture] = {
      reference: target,
      ...published,
      archiveSha256: platformVerified.image.sha256,
      rootfs: configuration.rootfs.diff_ids,
    };
  }
  const expected = Object.fromEntries(
    Object.entries(images).map(([architecture, image]) => [architecture, image.digest]),
  );
  const target = `${registryImage}:${version}`;
  const existing = manifest(target);
  if (existing) registryIndex(existing, expected);
  else
    run("docker", [
      "buildx",
      "imagetools",
      "create",
      "--tag",
      target,
      ...Object.values(expected).map((digest) => `${registryImage}@${digest}`),
    ]);
  const index = registryIndex(manifest(target), expected);
  const observed = JSON.parse(
    run("docker", ["buildx", "imagetools", "inspect", target, "--format", "{{json .Manifest}}"]),
  );
  assert.match(observed.digest, /^sha256:[a-f0-9]{64}$/);
  registryIndex(observed, expected);
  if (receipt.advanceLatest) {
    run("docker", [
      "buildx",
      "imagetools",
      "create",
      "--tag",
      `${registryImage}:latest`,
      `${registryImage}@${observed.digest}`,
    ]);
    registryIndex(manifest(`${registryImage}:latest`), expected);
  }
  receipt.image = {
    reference: target,
    digest: observed.digest,
    platforms: images,
    manifest: index,
  };
  save();
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
  const body = `${verified.package.name}@${version}\n\nSource: ${verified.commit}\nDocker: ${registryImage}:${version} (Linux/amd64 and Linux/arm64)\n\nNo deployment or live-provider/model verification is performed by this release workflow.`;
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
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.equal(process.env.GITHUB_EVENT_NAME, "push");
  assert.ok(ghToken);
  platforms = ["amd64", "arm64"].map((architecture) => {
    const directory = verifiedDirectory(artifactRoot, architecture);
    const verified = JSON.parse(readFileSync(join(directory, "verification.json"), "utf8"));
    assert.equal(verified.passed, true);
    assert.equal(verified.commit, process.env.GITHUB_SHA);
    assert.equal(verified.platform, "linux");
    assert.equal(verified.architecture, architecture);
    assert.equal(verified.arch, architecture === "amd64" ? "x64" : "arm64");
    assert.equal(verified.image.architecture, architecture);
    assert.equal(verified.image.os, "linux");
    versionParts(verified.package.version);
    assert.match(verified.package.file, /^sept-agent-\d+\.\d+\.\d+\.tgz$/);
    assert.equal(verified.image.archive, "image.tar");
    assert.match(verified.image.localTag, /^sept-ci-verified-[a-f0-9]{24}:\d+\.\d+\.\d+$/);
    assert.equal(verified.image.localTag.split(":")[1], verified.package.version);
    sameIntegrity(verified.package.sha256, sha256(join(directory, verified.package.file)));
    sameIntegrity(verified.image.sha256, sha256(join(directory, verified.image.archive)));
    return { architecture, directory, verified };
  });
  [{ directory, verified }] = platforms;
  assert.deepEqual(
    platforms[1].verified.package,
    verified.package,
    "Both native architectures must test exactly the same npm tarball",
  );
  version = verified.package.version;
  tag = `v${version}`;
  await publishNpm();
  publishImages();
  await publishRelease();
  receipt.passed = true;
} catch (error) {
  receipt.failure = String(error);
  throw error;
} finally {
  receipt.finished = new Date().toISOString();
  save();
}
