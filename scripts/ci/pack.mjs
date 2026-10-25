import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function npmPack(root, output) {
  return JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output], {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    }),
  );
}

function extract(archive, directory) {
  mkdirSync(directory, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", directory]);
}

function sealedArchive(root, artifact) {
  const path = join(root, artifact.path);
  const actual = createHash("sha512").update(readFileSync(path)).digest("base64");
  assert.equal(`sha512-${actual}`, artifact.integrity);
  return path;
}

function bundledManifest(stage, provenance) {
  const path = join(stage, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const pi = JSON.parse(
    readFileSync(join(stage, "node_modules", provenance.upstream.name, "package.json"), "utf8"),
  );
  const required = Object.fromEntries(
    Object.entries(pi.dependencies).map(([name, version]) => {
      const pin = version.replace(/^\^/, "");
      assert.match(pin, /^\d+\.\d+\.\d+$/);
      return [name, pin];
    }),
  );
  // npm skips missing dependencies beneath bundles; root pins retain one shared Pi/Chord graph.
  manifest.dependencies = { ...required, ...manifest.dependencies };
  manifest.dependencies[pi.name] = pi.version;
  manifest.bundleDependencies = [pi.name, provenance.patchedDependency.name];
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

/** Pack only the two sealed security packages; all remaining dependencies resolve normally. */
export function packDistribution(root, output) {
  const provenance = JSON.parse(
    readFileSync(join(root, "vendor/pi-coding-agent-provenance.json"), "utf8"),
  );
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  assert.equal(
    lock.packages["node_modules/undici"].integrity,
    provenance.patchedDependency.integrity,
  );
  const workspace = mkdtempSync(join(tmpdir(), "sept-pack-"));
  const base = join(workspace, "base");
  const stage = join(workspace, "stage");
  mkdirSync(base);
  const [source] = npmPack(root, base);
  extract(join(base, source.filename), stage);
  for (const artifact of [
    { ...provenance.distribution, name: provenance.upstream.name },
    provenance.patchedDependency,
  ]) {
    extract(sealedArchive(root, artifact), join(stage, "node_modules", artifact.name));
  }
  bundledManifest(stage, provenance);
  mkdirSync(output, { recursive: true });
  assert.equal(
    existsSync(join(output, source.filename)),
    false,
    "Never replace an existing artifact",
  );
  return npmPack(stage, output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "--reject-unsealed") {
    console.error(
      "Use npm run pack:consumer -- <output-directory> to produce the sealed consumer package.",
    );
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(packDistribution(process.cwd(), resolve(process.argv[2] ?? "."))));
  }
}
