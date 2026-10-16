import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { npmView } from "./npm-registry.mjs";
import { newer, versionParts } from "./release-contract.mjs";

function boundedVersion(version) {
  const parts = versionParts(version);
  assert.ok(
    parts.every((part) => part <= BigInt(Number.MAX_SAFE_INTEGER)),
    "Version exceeds its numeric bound",
  );
  return parts;
}

/** Failed checks consume no version; only a completed release advances the patch. */
export function releaseVersion(baseline, latest, release, commit) {
  boundedVersion(baseline);
  boundedVersion(latest);
  assert.match(commit, /^[a-f0-9]{40}$/);
  let completed = baseline;
  if (release !== undefined) {
    assert.equal(release.draft, false);
    assert.equal(release.prerelease, false);
    assert.equal(typeof release.tag_name, "string");
    assert.ok(release.tag_name.startsWith("v"));
    completed = release.tag_name.slice(1);
    boundedVersion(completed);
    assert.ok(!newer(baseline, completed), "Source baseline is ahead of completed releases");
    assert.match(release.target_commitish, /^[a-f0-9]{40}$/);
  }
  assert.equal(
    latest,
    completed,
    "npm and the completed GitHub release disagree; retry the original partial publication with its retained artifacts before starting another version",
  );
  if (release?.target_commitish === commit) {
    return completed;
  }
  const parts = boundedVersion(completed);
  assert.ok(
    parts[2] < BigInt(Number.MAX_SAFE_INTEGER),
    "Patch increment exceeds its numeric bound",
  );
  return `${parts[0]}.${parts[1]}.${parts[2] + 1n}`;
}

/** GitHub errors and malformed release metadata cannot silently reset the release sequence. */
export function releaseResponse(status, text) {
  const value = JSON.parse(text);
  if (status === 404) {
    assert.equal(value.message, "Not Found");
    return undefined;
  }
  assert.equal(status, 200, "GitHub release lookup failed");
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value;
}

/** Select once before checks; failed-job retries retain this output and the exact verified artifacts. */
export async function selectVersion(root, record) {
  assert.equal(process.env.GITHUB_REPOSITORY, "DB-Conneely/sept");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.equal(process.env.GITHUB_EVENT_NAME, "push");
  const response = await fetch("https://api.github.com/repos/DB-Conneely/sept/releases/latest", {
    signal: AbortSignal.timeout(15_000),
    headers: {
      accept: "application/vnd.github+json",
      ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
      "x-github-api-version": "2022-11-28",
    },
  });
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      assert.ok(bytes <= 1024 * 1024, "Release response exceeds its bound");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const release = releaseResponse(response.status, Buffer.concat(chunks).toString("utf8"));
  record({ githubStatus: response.status, release });
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const latest = npmView(manifest.name, "dist-tags.latest", record);
  const version = releaseVersion(manifest.version, latest, release, process.env.GITHUB_SHA);
  if (release?.target_commitish !== process.env.GITHUB_SHA) {
    assert.equal(
      npmView(`${manifest.name}@${version}`, "dist.integrity", record),
      undefined,
      "Next version is already submitted; retry its original publication instead of replacing it",
    );
  }
  return version;
}

/** Stamp only disposable CI checkout metadata, including the shipped example dependency pins. */
export function stampVersion(root, selected) {
  const packagePath = resolve(root, "package.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  const version = selected || manifest.version;
  boundedVersion(version);
  assert.ok(!newer(manifest.version, version), "Cannot stamp an older release version");
  const lockPath = resolve(root, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  const examples = ["node-app", "incident-investigator"].map((name) => {
    const path = resolve(root, "examples", name, "package.json");
    const example = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(example.dependencies[manifest.name], manifest.version);
    example.dependencies[manifest.name] = version;
    return { path, example };
  });
  for (const { path, example } of examples) {
    writeFileSync(path, JSON.stringify(example, null, 2) + "\n");
  }
  manifest.version = version;
  lock.version = version;
  lock.packages[""].version = version;
  writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "--select") {
    const receipt = { started: new Date().toISOString(), reads: [], passed: false };
    const save = () =>
      writeFileSync(process.env.SEPT_VERSION_RECEIPT, JSON.stringify(receipt, null, 2) + "\n");
    try {
      receipt.version = await selectVersion(process.cwd(), (item) => {
        receipt.reads.push(item);
        save();
      });
      receipt.passed = true;
      appendFileSync(process.env.GITHUB_OUTPUT, `version=${receipt.version}\n`);
      console.log(receipt.version);
    } catch (error) {
      receipt.failure = String(error);
      throw error;
    } finally {
      receipt.finished = new Date().toISOString();
      save();
    }
  } else {
    console.log(stampVersion(process.cwd(), process.env.RELEASE_VERSION));
  }
}
