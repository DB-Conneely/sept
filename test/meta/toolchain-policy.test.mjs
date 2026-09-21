import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
