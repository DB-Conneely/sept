import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import test from "node:test";

import ts from "typescript";

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return walk(path);
    }
    return entry.isFile() && extname(entry.name) === ".ts" ? [path] : [];
  });
}

function hasExportModifier(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function exportedBehaviors(path) {
  const source = readFileSync(path, "utf8");
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const names = [];
  sourceFile.forEachChild((node) => {
    if (
      hasExportModifier(node) &&
      ((ts.isFunctionDeclaration(node) && node.name !== undefined) ||
        ts.isClassDeclaration(node)) &&
      node.name !== undefined
    ) {
      names.push(node.name.text);
    }
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer !== undefined &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer))
        ) {
          names.push(declaration.name.text);
        }
      }
    }
  });
  return names;
}

test("every exported production behavior is referenced by a test", () => {
  const productFiles = walk("src");
  const testText = walk("test")
    .filter((path) => path.endsWith(".test.ts"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  const missing = productFiles.flatMap((path) =>
    exportedBehaviors(path)
      .filter((name) => !new RegExp(`\\b${name}\\b`).test(testText))
      .map((name) => `${path}:${name}`),
  );
  assert.deepEqual(missing, []);
});
