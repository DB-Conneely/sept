/**
 * Enforces source dependency direction from filesystem imports. The test owns no product behavior:
 * each mechanism may cross only through a public index, and observability remains dependency-free.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { posix } from "node:path";
import test from "node:test";

const mechanisms = new Set([
  "durable",
  "execution",
  "ingress",
  "model-access",
  "observability",
  "pi-integration",
  "runtime",
]);

function sourceFiles(directory = "src"): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        return sourceFiles(path);
      }
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    })
    .sort();
}

function mechanism(path: string): string | undefined {
  const candidate = path.split("/")[1];
  return candidate !== undefined && mechanisms.has(candidate) ? candidate : undefined;
}

function relativeImports(path: string): string[] {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)]
    .flatMap((match) => {
      const specifier = match[1];
      return specifier?.startsWith(".") ? [specifier] : [];
    })
    .sort();
}

void test("source mechanisms cross boundaries only through public index modules", () => {
  let crossings = 0;
  const observabilityForeignImports: string[] = [];
  for (const source of sourceFiles()) {
    const sourceMechanism = mechanism(source);
    for (const specifier of relativeImports(source)) {
      const target = posix.normalize(posix.join(posix.dirname(source), specifier));
      const targetMechanism = mechanism(target);
      if (!targetMechanism || targetMechanism === sourceMechanism) {
        continue;
      }
      crossings++;
      assert.equal(
        target,
        `src/${targetMechanism}/index.js`,
        `${source} imports ${targetMechanism} implementation ${specifier}`,
      );
      if (sourceMechanism === "observability") {
        observabilityForeignImports.push(`${source} -> ${target}`);
      }
    }
  }
  assert.ok(crossings > 0, "expected the architecture check to inspect cross-mechanism imports");
  assert.deepEqual(
    observabilityForeignImports,
    [],
    "observability must not import SEPT business mechanisms",
  );
});
