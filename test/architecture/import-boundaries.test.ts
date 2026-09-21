import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { posix } from "node:path";
import test from "node:test";

const mechanisms = new Set([
  "durable",
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
      return entry.isDirectory()
        ? sourceFiles(path)
        : entry.isFile() && entry.name.endsWith(".ts")
          ? [path]
          : [];
    })
    .sort();
}

function mechanism(path: string): string | undefined {
  const candidate = path.split("/")[1];
  return mechanisms.has(candidate) ? candidate : undefined;
}

function relativeImports(path: string): string[] {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((specifier) => specifier.startsWith("."))
    .sort();
}

test("source mechanisms cross boundaries only through public index modules", () => {
  let crossings = 0;
  const observabilityForeignImports: string[] = [];
  for (const source of sourceFiles()) {
    const sourceMechanism = mechanism(source);
    for (const specifier of relativeImports(source)) {
      const target = posix.normalize(posix.join(posix.dirname(source), specifier));
      const targetMechanism = mechanism(target);
      if (!targetMechanism || targetMechanism === sourceMechanism) continue;
      crossings++;
      assert.equal(
        target,
        `src/${targetMechanism}/index.js`,
        `${source} imports ${targetMechanism} implementation ${specifier}`,
      );
      if (sourceMechanism === "observability")
        observabilityForeignImports.push(`${source} -> ${target}`);
    }
  }
  assert.ok(crossings > 0, "expected the architecture check to inspect cross-mechanism imports");
  assert.deepEqual(
    observabilityForeignImports,
    [],
    "observability must not import SEPT business mechanisms",
  );
});
