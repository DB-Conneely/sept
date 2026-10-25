import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const provenance = JSON.parse(
  readFileSync(join(root, "vendor/pi-coding-agent-provenance.json"), "utf8"),
);
const hash = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);

void test("Pi security distribution changes only the undici dependency pin and seals all stock bodies", () => {
  assert.equal(provenance.schema, 1);
  assert.equal(provenance.upstream.version, "1.1.0");
  assert.equal(provenance.distribution.path, "vendor/pi-coding-agent-1.1.0-undici-8.12.2.tgz");
  assert.deepEqual(provenance.change, {
    path: "package/package.json",
    field: "dependencies.undici",
    from: "8.10.2",
    to: "8.12.2",
    originalManifestSha256: "c662a36f8bc47843393a60dc8616a34dfcc8376e8fcc96dbc2f1020c60e38e2a",
  });
  const archive = join(root, provenance.distribution.path);
  const bytes = readFileSync(archive);
  assert.equal(hash(bytes), provenance.distribution.sha256);
  assert.equal(`sha512-${hash(bytes, "sha512", "base64")}`, provenance.distribution.integrity);
  const names = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
  const entries = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8" }).trim().split("\n");
  assert.equal(names.length, 1254);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every((name) => name.startsWith("package/") && !name.split("/").includes("..")));
  assert.ok(entries.every((entry) => entry.startsWith("-")));
  const directory = mkdtempSync(join(tmpdir(), "sept-pi-security-"));
  try {
    execFileSync("tar", ["-xzf", archive, "-C", directory]);
    const manifest = readFileSync(join(directory, "package/package.json"), "utf8");
    assert.equal(JSON.parse(manifest).dependencies.undici, "8.12.2");
    assert.equal(manifest.split('"undici": "8.12.2"').length, 2);
    const original = manifest.replace('"undici": "8.12.2"', '"undici": "8.10.2"');
    assert.equal(hash(original), provenance.change.originalManifestSha256);
    const bodies = names
      .filter((name) => name !== "package/package.json")
      .sort()
      .map((name) => [name, hash(readFileSync(join(directory, name)))]);
    assert.deepEqual(provenance.unchanged, {
      files: bodies.length,
      contentSha256: hash(JSON.stringify(bodies)),
    });
    assert.equal(bodies.length, 1253);
    assert.equal(
      hash(JSON.stringify(bodies)),
      "10bfaee05403cb20d1adc4724b6f47a8fbca86d907c3c61e121dac2cf2194416",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("source lock and Docker select the shipped security distribution without install hooks", () => {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const pi = lock.packages["node_modules/@earendil-works/pi-coding-agent"];
  assert.equal(pi.version, "1.1.0");
  assert.equal(pi.resolved, `file:${provenance.distribution.path}`);
  assert.equal(pi.integrity, provenance.distribution.integrity);
  assert.equal(pi.dependencies.undici, "8.12.2");
  const versions = Object.entries(lock.packages)
    .filter(([path]) => path.endsWith("node_modules/undici"))
    .map(([, dependency]) => dependency.version);
  assert.deepEqual(versions, ["8.12.2"]);
  const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
  assert.ok(dockerfile.indexOf("COPY vendor ./vendor") < dockerfile.indexOf("RUN npm ci"));
  assert.match(dockerfile, /COPY --from=build --chown=10001:10001 \/app\/vendor \.\/vendor/);
  const consumer = readFileSync(join(root, "scripts/ci/consumer.mjs"), "utf8");
  assert.match(consumer, /createRequire\(piManifestPath\)\.resolve\("undici\/package.json"\)/);
});
