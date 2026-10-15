import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
const tsconfig = JSON.parse(readFileSync(new URL("../../tsconfig.json", import.meta.url), "utf8"));

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

test("all registry dependencies are pinned exactly", () => {
  const violations = [];
  for (const field of dependencyFields) {
    const dependencies = packageJson[field] ?? {};
    for (const [name, specifier] of Object.entries(dependencies)) {
      const isExactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
        specifier,
      );
      const isLocalProtocol = /^(?:file|link|workspace):/.test(specifier);
      if (!isExactVersion && !isLocalProtocol) {
        violations.push(`${field}.${name}=${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("the compiler keeps the SEPT strictness baseline enabled", () => {
  const options = tsconfig.compilerOptions;
  for (const name of [
    "strict",
    "noUncheckedIndexedAccess",
    "exactOptionalPropertyTypes",
    "noImplicitOverride",
    "noImplicitReturns",
    "noFallthroughCasesInSwitch",
    "noUnusedLocals",
    "noUnusedParameters",
    "verbatimModuleSyntax",
    "isolatedModules",
  ]) {
    assert.equal(options[name], true, `${name} must remain enabled`);
  }
});

test("the root gate includes typecheck, lint, formatting, tests, and audit", () => {
  assert.match(packageJson.scripts.check, /typecheck/);
  assert.match(packageJson.scripts.check, /lint/);
  assert.match(packageJson.scripts.check, /format:check/);
  assert.match(packageJson.scripts.gate, /npm run check/);
  assert.match(packageJson.scripts.gate, /npm test/);
  assert.match(packageJson.scripts.gate, /npm audit --omit=dev/);
});

const root = fileURLToPath(new URL("../../", import.meta.url));
const assetDirectory = join(root, "image/pi-native-search");
const provenance = JSON.parse(readFileSync(join(assetDirectory, "provenance.json"), "utf8"));
const nativeFiles = [
  "dist/core/tools/find.d.ts",
  "dist/core/tools/find.js",
  "dist/core/tools/grep.d.ts",
  "dist/core/tools/grep.js",
];
const hashFile = (path, algorithm = "sha256") =>
  createHash(algorithm).update(readFileSync(path)).digest("hex");

function extractNativeOverlay(directory) {
  const archive = join(assetDirectory, "overlay.tgz");
  const names = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
  const entries = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(names.sort(), nativeFiles);
  assert.equal(entries.length, nativeFiles.length);
  assert.ok(entries.every((entry) => entry.startsWith("-")));
  execFileSync("tar", ["-xzf", archive, "-C", directory]);
}

function assertNativeHashes(directory, key) {
  for (const path of nativeFiles) {
    assert.equal(hashFile(join(directory, path)), provenance.files[path][key], path);
  }
}

test("image native search overlay pins its lock identity, exact regular files and reversible patch", () => {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const upstream = lock.packages["node_modules/@earendil-works/pi-coding-agent"];
  assert.deepEqual(readdirSync(assetDirectory).sort(), [
    "README.md",
    "native-search.patch",
    "overlay.tgz",
    "provenance.json",
  ]);
  assert.equal(packageJson.dependencies[provenance.upstream.name], upstream.version);
  assert.equal(
    Object.keys(lock.packages).filter((path) =>
      path.endsWith("node_modules/@earendil-works/pi-coding-agent"),
    ).length,
    1,
  );
  assert.equal(provenance.upstream.name, "@earendil-works/pi-coding-agent");
  assert.equal(provenance.upstream.version, upstream.version);
  assert.equal(provenance.upstream.registryUrl, upstream.resolved);
  assert.equal(provenance.upstream.integrity, upstream.integrity);
  assert.equal(provenance.patch.revision, "sept-native-search-v1");
  assert.deepEqual(Object.keys(provenance.files).sort(), nativeFiles);
  assert.equal(hashFile(join(assetDirectory, "native-search.patch")), provenance.patch.sha256);
  for (const algorithm of ["sha256", "sha512"]) {
    assert.equal(
      hashFile(join(assetDirectory, "overlay.tgz"), algorithm),
      provenance.overlay[algorithm],
    );
  }
  const readme = readFileSync(join(assetDirectory, "README.md"), "utf8");
  const notice = readme
    .split("<!-- BEGIN UPSTREAM MIT LICENSE -->\n\n```text\n")[1]
    ?.split("\n```\n\n<!-- END UPSTREAM MIT LICENSE -->")[0];
  assert.equal(
    createHash("sha256").update(notice).digest("hex"),
    provenance.upstream.licenseSha256,
  );
  assert.equal(provenance.upstream.archiveContainsLicense, false);
  assert.match(
    provenance.upstream.licenseUrl,
    new RegExp(`/pi/${provenance.upstream.revision}/LICENSE$`),
  );
  const directory = mkdtempSync(join(tmpdir(), "sept-native-overlay-"));
  try {
    extractNativeOverlay(directory);
    assertNativeHashes(directory, "effectiveSha256");
    execFileSync("patch", [
      "-R",
      "-p1",
      "-d",
      directory,
      "-i",
      join(assetDirectory, "native-search.patch"),
    ]);
    assertNativeHashes(directory, "originalSha256");
    execFileSync("patch", [
      "-p1",
      "-d",
      directory,
      "-i",
      join(assetDirectory, "native-search.patch"),
    ]);
    assertNativeHashes(directory, "effectiveSha256");
    for (const path of nativeFiles) {
      assert.doesNotMatch(readFileSync(join(directory, path), "utf8"), /sourceMappingURL=/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function nativeChild(output) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  setImmediate(() => {
    child.stdout.end(output);
    child.stderr.end();
    setImmediate(() => child.emit("close", 0));
  });
  return child;
}

test("patched Pi bodies use the optional minimal child callback with unchanged native argv", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sept-native-callback-"));
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  const installed = join(root, "node_modules/@earendil-works/pi-coding-agent");
  try {
    extractNativeOverlay(directory);
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
    symlinkSync(join(installed, "dist/utils"), join(directory, "dist/utils"), "dir");
    for (const path of [
      "renderers",
      "path-utils.js",
      "tool-definition-wrapper.js",
      "truncate.js",
    ]) {
      symlinkSync(
        join(installed, "dist/core/tools", path),
        join(directory, "dist/core/tools", path),
      );
    }
    const agentDirectory = join(directory, "agent");
    mkdirSync(join(agentDirectory, "bin"), { recursive: true });
    // Nonexecutables prove the native body never ambient-spawns the discovered aliases.
    for (const program of ["rg", "fd"]) {
      writeFileSync(join(agentDirectory, "bin", program), "not an executable", { mode: 0o600 });
    }
    process.env.PI_CODING_AGENT_DIR = agentDirectory;
    const grep = await import(pathToFileURL(join(directory, nativeFiles[3])).href);
    const find = await import(pathToFileURL(join(directory, nativeFiles[1])).href);
    const calls = [];
    const spawn = (command, argv, options) => {
      calls.push({ command, argv, options });
      return nativeChild(
        command.endsWith("/rg")
          ? JSON.stringify({
              type: "match",
              data: {
                path: { text: join(directory, "example.txt") },
                lines: { text: "needle\n" },
                line_number: 1,
              },
            }) + "\n"
          : join(directory, "example.txt") + "\n",
      );
    };
    const grepTool = grep.createGrepToolDefinition(directory, {
      spawn,
      operations: { isDirectory: () => true, readFile: () => "needle\n" },
    });
    const grepResult = await grepTool.execute(
      "grep",
      { pattern: "needle", literal: true },
      undefined,
    );
    const findTool = find.createFindToolDefinition(directory, { spawn });
    const findResult = await findTool.execute("find", { pattern: "*.txt", limit: 7 }, undefined);
    assert.match(grepResult.content[0].text, /example\.txt:1: needle/);
    assert.equal(findResult.content[0].text, "example.txt");
    assert.deepEqual(calls, [
      {
        command: join(agentDirectory, "bin/rg"),
        argv: [
          "--json",
          "--line-number",
          "--color=never",
          "--hidden",
          "--fixed-strings",
          "--",
          "needle",
          directory,
        ],
        options: { stdio: ["ignore", "pipe", "pipe"] },
      },
      {
        command: join(agentDirectory, "bin/fd"),
        argv: [
          "--glob",
          "--color=never",
          "--hidden",
          "--no-require-git",
          "--max-results",
          "7",
          "--",
          "*.txt",
          directory,
        ],
        options: { stdio: ["ignore", "pipe", "pipe"] },
      },
    ]);
  } finally {
    if (previousAgentDirectory === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
