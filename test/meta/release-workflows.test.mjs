import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  priorSubmission,
  registryValue,
  shouldSubmit,
  submissionState,
  waitForIntegrity,
} from "../../scripts/ci/npm-registry.mjs";
import { pushVersion, stampVersion } from "../../scripts/ci/version.mjs";
import {
  archiveConfiguration,
  imageConfiguration,
  newer,
  registryDescriptor,
  npmPublishEnvironment,
  releaseIdentity,
  sameIntegrity,
  sameImageConfiguration,
  sha256,
  versionParts,
  verifiedDirectory,
} from "../../scripts/ci/release-contract.mjs";

void test("main push numbers allocate repeatable patch versions and refuse malformed or overflowing input", () => {
  assert.equal(pushVersion("0.1.0", 1), "0.1.1");
  assert.equal(pushVersion("0.1.0", 2), "0.1.2");
  assert.equal(pushVersion("2.4.9", 3), "2.4.12");
  assert.equal(pushVersion("0.1.0", 2), pushVersion("0.1.0", 2));
  for (const baseline of ["v0.1.0", "0.1", "0.01.0", "0.1.0-beta", "9007199254740992.0.0"]) {
    assert.throws(() => pushVersion(baseline, 1));
  }
  for (const increment of [-1, "01", "1.5", "1e3", "9007199254740992"]) {
    assert.throws(() => pushVersion("0.1.0", increment));
  }
  assert.throws(() => pushVersion("0.1.9007199254740991", 1));
});

function checkout() {
  const root = mkdtempSync(join(tmpdir(), "sept-release-meta-"));
  const metadata = { name: "sept-agent", version: "0.1.0", dependencies: { unchanged: "1.2.3" } };
  const lock = {
    version: "0.1.0",
    packages: { "": { version: "0.1.0" }, dependency: { integrity: "unchanged" } },
  };
  writeFileSync(join(root, "package.json"), JSON.stringify(metadata));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
  for (const name of ["node-app", "incident-investigator"]) {
    mkdirSync(join(root, "examples", name), { recursive: true });
    writeFileSync(
      join(root, "examples", name, "package.json"),
      JSON.stringify({ dependencies: { "sept-agent": "0.1.0", unchanged: "1.2.3" } }),
    );
  }
  return root;
}

void test("version stamping updates lock and shipped examples while preserving dependency pins", () => {
  const root = checkout();
  assert.equal(stampVersion(root, 7), "0.1.7");
  const manifest = JSON.parse(readFileSync(join(root, "package.json")));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json")));
  assert.equal(manifest.version, "0.1.7");
  assert.deepEqual(manifest.dependencies, { unchanged: "1.2.3" });
  assert.equal(lock.version, "0.1.7");
  assert.equal(lock.packages[""].version, "0.1.7");
  assert.deepEqual(lock.packages.dependency, { integrity: "unchanged" });
  for (const name of ["node-app", "incident-investigator"]) {
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "examples", name, "package.json"))).dependencies,
      { "sept-agent": "0.1.7", unchanged: "1.2.3" },
    );
  }
});

void test("inconsistent example metadata refuses before modifying any version file", () => {
  const root = checkout();
  const path = join(root, "examples", "incident-investigator", "package.json");
  writeFileSync(path, JSON.stringify({ dependencies: { "sept-agent": "wrong" } }));
  const packageBefore = readFileSync(join(root, "package.json"), "utf8");
  const firstBefore = readFileSync(join(root, "examples", "node-app", "package.json"), "utf8");
  assert.throws(() => stampVersion(root, 1));
  assert.equal(readFileSync(join(root, "package.json"), "utf8"), packageBefore);
  assert.equal(
    readFileSync(join(root, "examples", "node-app", "package.json"), "utf8"),
    firstBefore,
  );
});

void test("publication comparison cannot downgrade latest or overwrite a released identity", () => {
  assert.equal(newer("0.1.10", "0.1.9"), true);
  assert.equal(newer("0.2.0", "0.1.99"), true);
  assert.equal(newer("0.1.9", "0.1.10"), false);
  assert.equal(newer("0.1.10", "0.1.10"), false);
  assert.throws(() => versionParts("0.1.1-ci"));
  sameIntegrity("exact", "exact");
  assert.throws(() => sameIntegrity("exact", "different"));
  const root = mkdtempSync(join(tmpdir(), "sept-hash-meta-"));
  writeFileSync(join(root, "asset"), "abc");
  assert.equal(
    sha256(join(root, "asset")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

void test("untrusted checks cannot publish and main publication depends on completed verification", () => {
  const checks = readFileSync(
    new URL("../../.github/workflows/checks.yml", import.meta.url),
    "utf8",
  );
  const publish = readFileSync(
    new URL("../../.github/workflows/publish.yml", import.meta.url),
    "utf8",
  );
  assert.match(checks, /permissions:\n  contents: read/);
  assert.doesNotMatch(
    checks,
    /pull_request_target|secrets:|id-token: write|packages: write|self-hosted/,
  );
  assert.match(publish, /branches: \[main\]/);
  assert.match(publish, /needs: checks/);
  assert.match(publish, /release-number: \$\{\{ fromJSON\(github.run_number\) \}\}/);
  assert.match(publish, /pattern: sept-verified-amd64-attempt\*/);
  assert.doesNotMatch(
    checks + publish,
    /cancel-in-progress: true|npm publish|NPM_TOKEN|deploy|ollama|huggingface/i,
  );
  assert.match(checks, /nice -n 10 node scripts\/ci\/verify.mjs/);
});

void test("npm OIDC publication retains complete upstream provenance metadata and excludes unrelated credentials", () => {
  const source = {
    PATH: "/tools/bin",
    HOME: "/private/home",
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REPOSITORY_ID: "123",
    GITHUB_REPOSITORY_OWNER_ID: "456",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_REPOSITORY: "DB-Conneely/sept",
    GITHUB_WORKFLOW_REF: "DB-Conneely/sept/.github/workflows/publish.yml@refs/heads/main",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "OIDC_CANARY",
    GH_TOKEN: "GH_CANARY",
    NPM_TOKEN: "NPM_CANARY",
    PROVIDER_SECRET: "MODEL_CANARY",
  };
  const selected = npmPublishEnvironment(source);
  for (const key of [
    "GITHUB_EVENT_NAME",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_REPOSITORY_OWNER_ID",
    "RUNNER_ENVIRONMENT",
    "GITHUB_WORKFLOW_REF",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  ]) {
    assert.equal(selected[key], source[key]);
  }
  for (const key of ["GH_TOKEN", "NPM_TOKEN", "PROVIDER_SECRET"]) {
    assert.equal(Object.hasOwn(selected, key), false);
  }
  assert.doesNotMatch(JSON.stringify(selected), /GH_CANARY|NPM_CANARY|MODEL_CANARY/);
});

void test("publication writes an explicit failed receipt for missing or malformed verification before any registry call", () => {
  for (const malformed of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "sept-publish-preflight-"));
    if (malformed) {
      const directory = join(root, "sept-verified-amd64-attempt1");
      mkdirSync(directory);
      writeFileSync(join(directory, "verification.json"), "{invalid");
    }
    const child = spawnSync(
      process.execPath,
      [new URL("../../scripts/ci/publish.mjs", import.meta.url).pathname],
      {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, SEPT_CI_ARTIFACTS: root },
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 65536,
      },
    );
    assert.equal(child.status, 1);
    assert.equal(child.signal, null);
    const receipt = JSON.parse(readFileSync(join(root, "publication/publication.json")));
    assert.equal(receipt.passed, false);
    assert.equal(typeof receipt.failure, "string");
    assert.ok(receipt.finished);
    assert.deepEqual(receipt.commands, []);
  }
});

void test("existing draft releases and published tags cannot point outside the verified source commit", () => {
  const commit = "a".repeat(40);
  const tag = "v0.1.1";
  const draft = { tag_name: tag, draft: true, target_commitish: commit };
  const reference = { object: { type: "commit", sha: commit } };
  releaseIdentity(commit, tag, draft, undefined);
  releaseIdentity(commit, tag, { ...draft, draft: false }, reference);
  assert.throws(() =>
    releaseIdentity(commit, tag, { ...draft, target_commitish: "main" }, undefined),
  );
  assert.throws(() => releaseIdentity(commit, tag, { ...draft, tag_name: "v0.1.2" }, reference));
  assert.throws(() => releaseIdentity(commit, tag, { ...draft, draft: false }, undefined));
  assert.throws(() =>
    releaseIdentity(commit, tag, draft, { object: { type: "commit", sha: "b".repeat(40) } }),
  );
});

void test("saved image config identity supports both Docker archive layouts and refuses ambiguous ownership", () => {
  const digest = "a".repeat(64);
  const localTag = "sept-ci-verified-" + "1".repeat(24) + ":0.1.1";
  for (const path of [`blobs/sha256/${digest}`, `${digest}.json`]) {
    assert.deepEqual(archiveConfiguration([{ Config: path, RepoTags: [localTag] }], localTag), {
      path,
      digest: `sha256:${digest}`,
    });
  }
  assert.throws(() =>
    archiveConfiguration([{ Config: "../../foreign", RepoTags: [localTag] }], localTag),
  );
  assert.throws(() =>
    archiveConfiguration([{ Config: `${digest}.json`, RepoTags: ["unrelated:tag"] }], localTag),
  );
  assert.throws(() => archiveConfiguration([], localTag));
});

void test("registry identity resolves one amd64 OCI image with its bound attestation and refuses incompatible indexes", () => {
  const digest = "sha256:" + "a".repeat(64);
  const configuration = "sha256:" + "b".repeat(64);
  const image = { digest, platform: { os: "linux", architecture: "amd64" } };
  const attestation = {
    digest: "sha256:" + "c".repeat(64),
    platform: { os: "unknown", architecture: "unknown" },
    annotations: {
      "vnd.docker.reference.type": "attestation-manifest",
      "vnd.docker.reference.digest": digest,
    },
  };
  assert.deepEqual(registryDescriptor({ config: { digest: configuration } }), {
    kind: "configuration",
    digest: configuration,
  });
  assert.deepEqual(registryDescriptor({ manifests: [image, attestation] }), {
    kind: "platform",
    digest,
  });
  assert.throws(() => registryDescriptor({ manifests: [image, image] }));
  assert.throws(() =>
    registryDescriptor({
      manifests: [{ ...image, platform: { os: "linux", architecture: "arm64" } }],
    }),
  );
  assert.throws(() =>
    registryDescriptor({ manifests: [image, { ...attestation, annotations: {} }] }),
  );
});

void test("saved config bytes must match their digest, source commit, version and platform", () => {
  const commit = "a".repeat(40);
  const configuration = {
    architecture: "amd64",
    os: "linux",
    config: {
      Labels: {
        "org.opencontainers.image.version": "0.1.1",
        "org.opencontainers.image.revision": commit,
      },
    },
  };
  const raw = JSON.stringify(configuration) + "\n";
  const identity = { digest: "sha256:" + createHash("sha256").update(raw).digest("hex") };
  assert.deepEqual(imageConfiguration(raw, identity, "0.1.1", commit), configuration);
  assert.throws(() => imageConfiguration(raw.trim(), identity, "0.1.1", commit));
  assert.throws(() => imageConfiguration(raw, identity, "0.1.2", commit));
  assert.throws(() => imageConfiguration(raw, identity, "0.1.1", "b".repeat(40)));
});

void test("classic Docker inspect defaults preserve exact image behavior and reject every other difference", () => {
  const compact = {
    User: "10001:10001",
    Env: ["NODE_ENV=production"],
    Cmd: ["./sept", "worker"],
    ExposedPorts: { "8090/tcp": {} },
    WorkingDir: "/app",
    Labels: { "org.opencontainers.image.version": "0.1.1" },
    ArgsEscaped: true,
    Healthcheck: { Test: ["CMD", "./sept", "health"] },
  };
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
  const expanded = { ...defaults, ...compact };
  sameImageConfiguration(compact, compact);
  sameImageConfiguration(compact, expanded);
  sameImageConfiguration(expanded, compact);
  for (const [key, value] of Object.entries(defaults)) {
    const changed = value === false ? true : value === "" ? "changed" : ["changed"];
    assert.throws(() => sameImageConfiguration(compact, { ...expanded, [key]: changed }));
    assert.throws(() => sameImageConfiguration({ ...compact, [key]: changed }, expanded));
  }
  for (const key of Object.keys(compact)) {
    assert.throws(() => sameImageConfiguration(compact, { ...expanded, [key]: "changed" }));
    const missing = Object.fromEntries(Object.entries(expanded).filter(([name]) => name !== key));
    assert.throws(() => sameImageConfiguration(compact, missing));
  }
  assert.throws(() => sameImageConfiguration(compact, { ...expanded, Unknown: false }));
});

void test("npm registry reads distinguish pending E404 from authentication and malformed responses", () => {
  assert.equal(registryValue(0, '"sha512-exact"'), "sha512-exact");
  assert.equal(registryValue(1, '{"error":{"code":"E404"}}'), undefined);
  for (const text of ["not-json", '""', "123", "null", "{}"]) {
    assert.throws(() => registryValue(0, text));
  }
  for (const code of ["E401", "E403", "E500"]) {
    assert.throws(() => registryValue(1, JSON.stringify({ error: { code } })));
  }
});

void test("publication waits for exact integrity after missing versions without submitting anything", async () => {
  let clock = 0;
  let reads = 0;
  const records = [];
  const actual = await waitForIntegrity({
    expected: "exact",
    timeoutMs: 100,
    intervalMs: 10,
    now: () => clock,
    pause: async (ms) => {
      clock += ms + 0.25;
    },
    read: (budget) => {
      assert.ok(budget <= 100);
      assert.equal(Number.isInteger(budget), true);
      reads += 1;
      return reads < 3 ? undefined : "exact";
    },
    record: (item) => records.push(item),
  });
  assert.equal(actual, "exact");
  assert.deepEqual(
    records.map((item) => item.state),
    ["pending", "pending", "visible"],
  );
  assert.equal(reads, 3);
});

void test("publication scanning timeout, wrong integrity and registry errors cannot become success", async () => {
  let clock = 0;
  const records = [];
  await assert.rejects(
    waitForIntegrity({
      expected: "exact",
      timeoutMs: 30,
      intervalMs: 10,
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
      },
      read: () => undefined,
      record: (item) => records.push(item),
    }),
    /do not republish/,
  );
  assert.equal(records.length, 3);
  await assert.rejects(
    waitForIntegrity({
      expected: "exact",
      read: () => "different",
      record: (item) => assert.ok(item),
    }),
    /different bytes/,
  );
  await assert.rejects(
    waitForIntegrity({
      expected: "exact",
      read: () => registryValue(1, '{"error":{"code":"E401"}}'),
      record: (item) => assert.ok(item),
    }),
    /rejected the read/,
  );
});

void test("retry submission state is bound to the exact run/source/version/integrity", () => {
  const root = mkdtempSync(join(tmpdir(), "sept-submission-meta-"));
  const directory = join(root, "sept-publication-attempt1");
  mkdirSync(directory);
  const binding = {
    runId: "123",
    commit: "a".repeat(40),
    version: "0.1.1",
    integrity: "sha512-exact",
  };
  const path = join(directory, "npm-submission.json");
  writeFileSync(path, JSON.stringify({ binding, state: "accepted" }));
  assert.equal(priorSubmission(root, binding).state, "accepted");
  for (const key of ["runId", "commit", "version", "integrity"]) {
    assert.throws(() => priorSubmission(root, { ...binding, [key]: "different" }));
  }
  writeFileSync(path, JSON.stringify({ binding, state: "invented" }));
  assert.throws(() => priorSubmission(root, binding));
  writeFileSync(path, "{bad");
  assert.throws(() => priorSubmission(root, binding));
});

void test("accepted or ambiguous npm submission stays owned; only definite auth rejection permits retry", () => {
  assert.equal(submissionState(0, ""), "accepted");
  for (const code of ["E401", "ENEEDAUTH", "EOTP"]) {
    assert.equal(submissionState(1, JSON.stringify({ error: { code } })), "rejected-auth");
  }
  assert.equal(submissionState(1, '{"error":{"code":"E403"}}'), "submitted");
  assert.equal(submissionState(1, "ambiguous"), "submitted");
  assert.equal(shouldSubmit(undefined, "1"), true);
  assert.equal(shouldSubmit({ state: "accepted" }, "2"), false);
  assert.equal(shouldSubmit({ state: "submitted" }, "2"), false);
  assert.equal(shouldSubmit({ state: "rejected-auth" }, "2"), true);
  assert.throws(() => shouldSubmit(undefined, "2"), /no submission receipt/);
  assert.throws(() => shouldSubmit(undefined, "invalid"));
});

void test("the pinned download action's flat and grouped artifact layouts select the same verified identities", () => {
  const flat = mkdtempSync(join(tmpdir(), "sept-flat-artifact-"));
  writeFileSync(join(flat, "verification.json"), "{}");
  assert.equal(verifiedDirectory(flat), flat);
  const grouped = mkdtempSync(join(tmpdir(), "sept-grouped-artifact-"));
  assert.throws(() => verifiedDirectory(grouped), /retained verified artifact/);
  for (const attempt of [1, 2, 10]) {
    mkdirSync(join(grouped, `sept-verified-amd64-attempt${attempt}`));
  }
  assert.equal(verifiedDirectory(grouped), join(grouped, "sept-verified-amd64-attempt10"));
  writeFileSync(join(grouped, "verification.json"), "{}");
  assert.throws(() => verifiedDirectory(grouped), /Ambiguous/);
  const binding = { runId: "123", commit: "exact", version: "0.1.1", integrity: "sha512-exact" };
  writeFileSync(join(flat, "npm-submission.json"), JSON.stringify({ binding, state: "accepted" }));
  assert.equal(priorSubmission(flat, binding).state, "accepted");
  mkdirSync(join(flat, "sept-publication-attempt1"));
  assert.throws(() => priorSubmission(flat, binding), /Ambiguous/);
});
