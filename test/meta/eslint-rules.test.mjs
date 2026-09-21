import assert from "node:assert/strict";
import test from "node:test";

import { ESLint } from "eslint";
import tseslint from "typescript-eslint";

import { septPlugin, septRules } from "../../eslint-rules/index.js";

const overrideConfig = [
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin, sept: septPlugin },
    rules: {
      ...septRules,
      "@typescript-eslint/no-explicit-any": "error",
      "max-lines-per-function": ["error", { max: 40, skipBlankLines: true, skipComments: true }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportDefaultDeclaration",
          message: "Default exports are banned; use a named export.",
        },
      ],
    },
  },
];

function createEslint() {
  return new ESLint({ overrideConfigFile: true, overrideConfig });
}

async function ruleIdsFor(source) {
  const [result] = await createEslint().lintText(source, { filePath: "fixture.ts" });
  return result?.messages.map((message) => message.ruleId ?? "") ?? [];
}

test("strict lint rules reject the prohibited TypeScript patterns", async () => {
  const longBody = Array.from({ length: 41 }, (_, index) => `  consume(${index});`).join("\n");
  const cases = [
    [
      "export function unsafe(value: any): any { return value; }",
      "@typescript-eslint/no-explicit-any",
    ],
    ["export default function unnamed(): void {}", "no-restricted-syntax"],
    ["throw new Error('untyped');", "sept/no-generic-error-throw"],
    [`function tooLong(): void {\n${longBody}\n}`, "max-lines-per-function"],
    ["const value = input as { id: string };", "sept/require-cast-justification"],
    ["const value = input!.id;", "sept/require-nonnull-justification"],
    ["export function undocumented(): void {}", "sept/require-export-documentation"],
  ];

  for (const [source, expectedRule] of cases) {
    assert.ok(
      (await ruleIdsFor(source)).includes(expectedRule),
      `${expectedRule} did not reject its fixture`,
    );
  }
});

test("strict lint rules accept documented, named, and justified TypeScript", async () => {
  const source = [
    "/** Return the already validated connector identity. */",
    "export function connectorIdentity(input: unknown): { id: string } {",
    "  // CAST: the caller validated this value with the connector identity codec.",
    "  return input as { id: string };",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(await ruleIdsFor(source), []);
});
