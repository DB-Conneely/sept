import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

/** The pinned download action flattens one match but names directories for multiple matches. */
export function verifiedDirectory(root, architecture = "amd64") {
  assert.ok(["amd64", "arm64"].includes(architecture));
  const attempts = readdirSync(root)
    .filter((name) => new RegExp(`^sept-verified-${architecture}-attempt[1-9]\\d*$`).test(name))
    .sort((left, right) => Number(left.split("attempt")[1]) - Number(right.split("attempt")[1]));
  const flat = existsSync(join(root, "verification.json"));
  assert.ok(!(flat && attempts.length), "Ambiguous verified artifact layouts");
  assert.ok(flat || attempts.length, "A retained verified artifact is required");
  return flat ? root : join(root, attempts.at(-1));
}

/** Hash large saved images without buffering them in memory. */
export function sha256(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.alloc(65536);
  try {
    let length;
    while ((length = readSync(descriptor, buffer)) > 0) {
      hash.update(buffer.subarray(0, length));
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

/** Validate a stable version before using it in registry tags and compare without numeric rounding. */
export function versionParts(version) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  return version.split(".").map(BigInt);
}

/** Never move mutable latest tags backwards when retrying an older main push. */
export function newer(candidate, current) {
  const left = versionParts(candidate);
  const right = versionParts(current);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] > right[index];
    }
  }
  return false;
}

/** Reusing a published version is allowed only for the exact already tested bytes. */
export function sameIntegrity(expected, actual) {
  assert.equal(actual, expected, "Published version has different bytes; refusing to overwrite it");
}

/** Exact npm 11.21 provenance/OIDC inputs; publishing credentials never reach verification children. */
export function npmPublishEnvironment(source) {
  const permitted = [
    "PATH",
    "HOME",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "GITHUB_ACTIONS",
    "GITHUB_EVENT_NAME",
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_REPOSITORY_OWNER_ID",
    "GITHUB_SERVER_URL",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_SHA",
    "GITHUB_REF",
    "GITHUB_WORKFLOW_REF",
    "RUNNER_ENVIRONMENT",
    "NPM_CONFIG_USERCONFIG",
  ];
  return Object.fromEntries(
    permitted.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
}

/** Draft releases have no tag yet; pin their target before attaching verified release assets. */
export function releaseIdentity(commit, tag, release, reference) {
  if (reference) {
    assert.equal(reference.object.type, "commit");
    sameIntegrity(commit, reference.object.sha);
  }
  if (release) {
    assert.equal(release.tag_name, tag);
    if (release.draft) {
      sameIntegrity(commit, release.target_commitish);
    } else {
      assert.ok(reference, "A published release must retain its verified source tag");
    }
  }
}

/** Docker stores may expose an index ID or a config ID; the saved config is the portable identity. */
export function archiveConfiguration(entries, localTag) {
  assert.ok(Array.isArray(entries) && entries.length === 1, "One saved platform image is required");
  assert.deepEqual(entries[0].RepoTags, [localTag]);
  const match = /^(?:blobs\/sha256\/)?([a-f0-9]{64})(?:\.json)?$/.exec(entries[0].Config);
  assert.ok(match, "Unsafe or unsupported image config entry");
  return { path: entries[0].Config, digest: `sha256:${match[1]}` };
}

/** Accept one explicit platform image and at most its one bound BuildKit attestation. */
export function registryDescriptor(document, architecture = "amd64") {
  assert.ok(["amd64", "arm64"].includes(architecture));
  if (document.config) {
    assert.match(document.config.digest, /^sha256:[a-f0-9]{64}$/);
    return { kind: "configuration", digest: document.config.digest };
  }
  assert.ok(Array.isArray(document.manifests) && document.manifests.length <= 2);
  const images = document.manifests.filter(
    (entry) => entry.platform?.os === "linux" && entry.platform?.architecture === architecture,
  );
  assert.equal(images.length, 1, `Exactly one Linux/${architecture} manifest is required`);
  assert.match(images[0].digest, /^sha256:[a-f0-9]{64}$/);
  for (const entry of document.manifests) {
    if (entry === images[0]) {
      continue;
    }
    assert.equal(entry.platform?.os, "unknown");
    assert.equal(entry.platform?.architecture, "unknown");
    assert.equal(entry.annotations?.["vnd.docker.reference.type"], "attestation-manifest");
    assert.equal(entry.annotations?.["vnd.docker.reference.digest"], images[0].digest);
  }
  return { kind: "platform", digest: images[0].digest };
}

/** Require the exact saved config bytes and the platform/source metadata before publication. */
export function imageConfiguration(raw, identity, version, commit, architecture = "amd64") {
  sameIntegrity(identity.digest, `sha256:${createHash("sha256").update(raw).digest("hex")}`);
  const configuration = JSON.parse(raw);
  assert.ok(["amd64", "arm64"].includes(architecture));
  assert.equal(configuration.architecture, architecture);
  assert.equal(configuration.os, "linux");
  assert.equal(configuration.config.Labels["org.opencontainers.image.version"], version);
  assert.equal(configuration.config.Labels["org.opencontainers.image.revision"], commit);
  return configuration;
}

/** Classic Docker inspect expands defaults omitted by OCI configs; all other fields stay exact. */
export function sameImageConfiguration(expected, actual) {
  const defaults = {
    Hostname: "",
    Domainname: "",
    Image: "",
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Entrypoint: null,
    OnBuild: null,
    Volumes: null,
  };
  assert.deepEqual({ ...defaults, ...actual }, { ...defaults, ...expected });
}

/** The published index contains exactly the two tested immutable platform manifests. */
export function registryIndex(document, expected) {
  assert.ok(document && Array.isArray(document.manifests));
  assert.deepEqual(Object.keys(expected).sort(), ["amd64", "arm64"]);
  assert.equal(document.manifests.length, 2);
  for (const architecture of ["amd64", "arm64"]) {
    const entries = document.manifests.filter(
      (entry) => entry.platform?.os === "linux" && entry.platform?.architecture === architecture,
    );
    assert.equal(entries.length, 1, `Exactly one Linux/${architecture} manifest is required`);
    assert.match(entries[0].digest, /^sha256:[a-f0-9]{64}$/);
    sameIntegrity(expected[architecture], entries[0].digest);
    assert.ok(
      entries[0].platform.variant === undefined ||
        (architecture === "arm64" && entries[0].platform.variant === "v8"),
    );
  }
  return document;
}
