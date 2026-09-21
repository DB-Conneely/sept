// These local rules encode SEPT review requirements that off-the-shelf ESLint rules cannot
// express. Keep them small, syntactic, and covered by test/meta/eslint-rules.test.mjs.

/**
 * Return whether a marker comment is on the assertion's line or immediately above it.
 *
 * @param {import("eslint").Rule.RuleContext} context
 * @param {{ loc: { start: { line: number } } }} node
 * @param {string} marker
 * @returns {boolean}
 */
function hasMarkerNear(context, node, marker) {
  const nodeLine = node.loc.start.line;
  return context.sourceCode.getAllComments().some((comment) => {
    if (!comment.value.includes(marker)) {
      return false;
    }
    const endLine = comment.loc.end.line;
    return endLine === nodeLine || endLine === nodeLine - 1;
  });
}

/**
 * Return whether a declaration has an adjacent block-form TSDoc comment.
 *
 * @param {import("eslint").Rule.RuleContext} context
 * @param {{ loc: { start: { line: number } } }} node
 * @returns {boolean}
 */
function hasTsDoc(context, node) {
  const comments = context.sourceCode.getCommentsBefore(node);
  const comment = comments.at(-1);
  return (
    comment !== undefined &&
    comment.type === "Block" &&
    comment.value.startsWith("*") &&
    comment.loc.end.line === node.loc.start.line - 1
  );
}

/** @type {import("eslint").Rule.RuleModule} */
const noGenericErrorThrow = {
  meta: {
    type: "problem",
    docs: { description: "Require typed domain errors instead of generic Error throws." },
    schema: [],
    messages: {
      typedError: "Use SeptError, a focused typed subclass, or a Result union; do not throw Error.",
    },
  },
  create(context) {
    return {
      ThrowStatement(node) {
        const thrown = node.argument;
        const throwsGenericError =
          (thrown.type === "NewExpression" || thrown.type === "CallExpression") &&
          thrown.callee.type === "Identifier" &&
          thrown.callee.name === "Error";
        if (throwsGenericError) {
          context.report({ node, messageId: "typedError" });
        }
      },
    };
  },
};

/** @type {import("eslint").Rule.RuleModule} */
const requireCastJustification = {
  meta: {
    type: "suggestion",
    docs: { description: "Require an adjacent CAST justification for type assertions." },
    schema: [],
    messages: {
      needsCast: "Type assertions require an adjacent // CAST: runtime proof.",
    },
  },
  create(context) {
    /**
     * `as const` narrows rather than bypassing runtime validation, so it needs no waiver.
     *
     * @param {import("@typescript-eslint/types").TSESTree.TSAsExpression} node
     * @returns {void}
     */
    function checkAsExpression(node) {
      const annotation = node.typeAnnotation;
      const isAsConst =
        annotation.type === "TSTypeReference" &&
        annotation.typeName.type === "Identifier" &&
        annotation.typeName.name === "const";
      if (!isAsConst && !hasMarkerNear(context, node, "CAST:")) {
        context.report({ node, messageId: "needsCast" });
      }
    }

    return {
      TSAsExpression: checkAsExpression,
      TSTypeAssertion(node) {
        if (!hasMarkerNear(context, node, "CAST:")) {
          context.report({ node, messageId: "needsCast" });
        }
      },
    };
  },
};

/** @type {import("eslint").Rule.RuleModule} */
const requireNonNullJustification = {
  meta: {
    type: "suggestion",
    docs: { description: "Require an adjacent ASSERT proof for non-null assertions." },
    schema: [],
    messages: {
      needsAssert: "Non-null assertions require an adjacent // ASSERT: proof.",
    },
  },
  create(context) {
    return {
      TSNonNullExpression(node) {
        if (!hasMarkerNear(context, node, "ASSERT:")) {
          context.report({ node, messageId: "needsAssert" });
        }
      },
    };
  },
};

/** @type {import("eslint").Rule.RuleModule} */
const requireDisableJustification = {
  meta: {
    type: "suggestion",
    docs: { description: "Require a reason on every ESLint disable directive." },
    schema: [],
    messages: {
      needsReason: "ESLint disable directives require a -- reason justification.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const text = comment.value.trim();
          if (/^eslint-disable(?:-next-line|-line)?\b/.test(text) && !text.includes("--")) {
            context.report({ loc: comment.loc, messageId: "needsReason" });
          }
        }
      },
    };
  },
};

/** @type {import("eslint").Rule.RuleModule} */
const requireExportDocumentation = {
  meta: {
    type: "suggestion",
    docs: { description: "Require TSDoc on exported TypeScript declarations." },
    schema: [],
    messages: {
      missingDocumentation: "Exported declarations require adjacent TSDoc describing the contract.",
    },
  },
  create(context) {
    return {
      ExportNamedDeclaration(node) {
        if (node.declaration !== null && !hasTsDoc(context, node)) {
          context.report({ node, messageId: "missingDocumentation" });
        }
      },
    };
  },
};

/** SEPT-local ESLint plugin containing mechanically enforced hygiene rules. */
export const septPlugin = {
  meta: { name: "sept", version: "0.1.0" },
  rules: {
    "no-generic-error-throw": noGenericErrorThrow,
    "require-cast-justification": requireCastJustification,
    "require-disable-justification": requireDisableJustification,
    "require-export-documentation": requireExportDocumentation,
    "require-nonnull-justification": requireNonNullJustification,
  },
};

/** Rules enabled for all SEPT product and test TypeScript. */
export const septRules = {
  "sept/no-generic-error-throw": "error",
  "sept/require-cast-justification": "error",
  "sept/require-disable-justification": "error",
  "sept/require-export-documentation": "error",
  "sept/require-nonnull-justification": "error",
};
