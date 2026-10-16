// SEPT uses type-aware linting for product and test TypeScript. Tooling files stay on the
// syntactic ruleset so they do not need to become part of the production tsconfig project.
import eslintConfigPrettier from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

import { septPlugin, septRules } from "./eslint-rules/index.js";

/** Generated output, dependencies, runtime state, and coverage are never lint inputs. */
export const ignores = ["**/dist/**", "**/node_modules/**", "**/coverage/**", ".sept/**"];

export default tseslint.config(
  { ignores },
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      prettier: prettierPlugin,
      sept: septPlugin,
    },
    rules: {
      ...septRules,
      "prettier/prettier": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      complexity: ["error", 10],
      curly: ["error", "all"],
      "max-depth": ["error", 3],
      "max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 40, skipBlankLines: true, skipComments: true }],
      "max-statements-per-line": ["error", { max: 1 }],
      "no-nested-ternary": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportDefaultDeclaration",
          message: "Default exports are banned; use a named export.",
        },
      ],
      "no-throw-literal": "error",
      "no-warning-comments": ["error", { terms: ["todo", "fixme", "hack"], location: "anywhere" }],
    },
  },
  {
    files: [
      "eslint-rules/**/*.js",
      "scripts/**/*.{js,mjs}",
      "test/meta/**/*.mjs",
      "examples/**/*.{ts,mjs}",
      "*.mjs",
    ],
    name: "sept/tooling-files",
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: globals.node,
    },
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "prettier/prettier": "error",
      "no-undef": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  eslintConfigPrettier,
);
