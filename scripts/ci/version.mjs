import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** A push reserves one patch number; a failed attempt or rerun never reuses another push's number. */
export function pushVersion(baseline, runNumber) {
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(baseline);
  assert.ok(parts, "The source version must be a stable semantic version");
  assert.match(String(runNumber), /^(0|[1-9]\d*)$/);
  assert.ok(parts.slice(1).every((part) => Number.isSafeInteger(Number(part))));
  const increment = Number(runNumber);
  const patch = Number(parts[3]) + increment;
  assert.ok(Number.isSafeInteger(increment) && Number.isSafeInteger(patch));
  return `${parts[1]}.${parts[2]}.${patch}`;
}

/** Stamp only disposable CI checkout metadata, including the shipped example dependency pins. */
export function stampVersion(root, runNumber) {
  const packagePath = resolve(root, "package.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  const version = pushVersion(manifest.version, runNumber);
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
  console.log(stampVersion(process.cwd(), process.env.RELEASE_NUMBER ?? "0"));
}
