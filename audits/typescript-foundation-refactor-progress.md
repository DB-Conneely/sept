# TypeScript foundation refactor progress

This record tracks the temporary migration exception defined in `.codex/rules/typescript.md`. Counts are global across `src/**/*.ts` and `test/**/*.ts`; a module is complete only when its targeted checks are clean and the global debt decreases without adding a violation in that module.

## Baseline

| Stage | TypeScript diagnostics | ESLint errors | ESLint warnings | ESLint-failing files | Prettier-failing TypeScript files |
|---|---:|---:|---:|---:|---:|
| Foundation rules introduced | 127 | 2,501 | 0 | 42 | 42 |

Baseline commands:

- `npx tsc -p tsconfig.json --noEmit --pretty false`
- `npx eslint src test -f json`
- repository `npm run format:check` (the 42 failures are all TypeScript files)

## Mechanical format rebaseline

After the completed observability mechanism, the supervisor-authorized global Prettier write removed formatter noise without marking any additional mechanism complete. Future checkpoints report structural ESLint debt separately.

| Stage | TypeScript diagnostics | ESLint errors | Non-Prettier ESLint errors | ESLint-failing files | Non-Prettier failing files | Prettier-failing TypeScript files |
|---|---:|---:|---:|---:|---:|---:|
| Global TypeScript format sweep | 97 | 649 | 649 | 22 | 22 | 0 |

## Module ledger

| Completed module | TypeScript diagnostics | ESLint errors | ESLint-failing files | Prettier-failing TypeScript files | Focused verification | Repository gate |
|---|---:|---:|---:|---:|---|---|
| `src/durable/contracts.ts` | 127 | 2,479 | 41 | 41 | targeted TypeScript emitted no contract diagnostic; targeted ESLint and Prettier clean; emitted `dist/test/durable/store.test.js` passed 6/6 | Rerun; stops at the known 127 TypeScript migration diagnostics |
| complete `src/durable/` mechanism and `test/durable/store.test.ts` | 120 | 2,187 | 39 | 39 | zero targeted TypeScript/ESLint/Prettier violations; 69/69 affected lifecycle tests passed, followed by 20/20 final durable/conversation tests; durable exported-behavior meta-test debt is zero | Rerun; stops at the remaining 120 TypeScript migration diagnostics |
| complete `src/model-access/`, `test/model-access/`, and model-access support | 103 | 1,952 | 32 | 32 | zero targeted TypeScript/ESLint/Prettier violations; 14/14 focused tests and 23/23 affected installed CLI, ingress, model-access, and Pi-session tests passed; model-access exported-behavior meta-test debt is zero | Rerun; stops at the remaining 103 TypeScript migration diagnostics |
| predecessor observability structural checkpoint | 97 | 1,640 | 22 | 22 | zero targeted TypeScript/ESLint/Prettier violations; 7/7 focused observability tests and 80/80 affected architecture, installed CLI/worker, ingress, runtime, and Pi lifecycle tests passed; observability exported-behavior meta-test debt was zero | Superseded by the fresh documentation and behavior review below |
| fresh complete `src/observability/` and `test/observability/` acceptance | 97 | 649 non-Prettier | 22 | 0 | zero targeted TypeScript/ESLint/Prettier violations; 10/10 focused observability tests and 107/107 compiled repository tests passed; architecture boundary passed; exported-behavior meta-test reports zero observability debt and 16 remaining declarations outside this mechanism; `git diff --check` passed | `npm run gate` rerun; stops at the known 97 TypeScript migration diagnostics before later phases |

The durable refactor replaces the 804-line mixed-responsibility store with bounded modules for atomic persistence, codecs, leases, evidence, conversation retention, operator input, handover ordering, discovery, and worker readiness behind the unchanged `RunStore` facade. Fsync-before-transition ordering, exact input, cancellation authority, lease identity, queue limits, restart adoption, and the handover-before-consumption rule remain production-wired. A one-record interrupted conversation-retention seam now compacts safely on recovery. The completed durable scope has no compiler, lint, formatting, or exported-behavior meta-test violation. Global debt decreased by 7 TypeScript diagnostics and 292 ESLint errors in this module step.

The model-access refactor is structural rather than formatter-only: custom JSONC parsing, endpoint/credential safety, model metadata, atomic Pod selection, Pi normalization, and installed runtime construction now change independently behind the same `ModelAccessService` facade. Credential values and Pi auth sources remain excluded, selection precedence and per-admission rereads are unchanged, and provider/model availability and authentication remain Pi-owned. The completed model-access scope has no compiler, lint, formatting, or exported-behavior meta-test violation. Global debt decreased by 17 TypeScript diagnostics and 235 ESLint errors in this module step.

The observability refactor separates bounded contracts and fields, process/resource configuration, receiver-safe exporter containment, log ownership, metric registration/state, SDK setup, trace propagation, and facade lifecycle. The fresh review added substantive ownership/boundary documentation to every observability source and test file and to every exported declaration. It also closes two fail-open seams: malformed or oversized allowed string fields now collapse to `unknown`, and span/context wrappers preserve exactly-once operation outcomes when the SDK fails after callback entry. Signal owners begin flush/shutdown independently so a synchronous SDK failure cannot skip sibling cleanup or final log flushing. Telemetry remains payload-free, credential-blind, bounded, and strictly advisory: collector, exporter, logger, and span failures cannot replace durable lifecycle authority. The focused suite directly covers each exported observability behavior as well as W3C parentage, correlation, metric labels, disabled SDK behavior, deadlines, receiver binding, payload exclusion, and installed service/controller rotation. The accepted observability scope has no compiler, lint, formatting, documentation, or exported-behavior violation.

## File-by-file documentation audit

`Reviewed` means the resulting file was read in full and its comments were assessed for responsibility, dependency direction, ownership, failure semantics, and nearby non-obvious invariants. `Pending fresh read` is explicit non-acceptance even where an earlier structural mechanism checkpoint is preserved.

| TypeScript file | File header | Exported API TSDoc | Local invariant comments | Review status |
|---|---|---|---|---|
| `src/cli.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/cli/auth-interaction.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/durable/context-transfer-store.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/durable/contracts.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/durable/control-codecs.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/durable/conversation-store.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/durable/errors.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/durable/evidence-codecs.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/durable/filesystem.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/durable/index.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/durable/lease.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/durable/limits.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/durable/operator-queue.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/durable/run-discovery.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/durable/run-evidence.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/durable/run-store.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/durable/state-codecs.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/durable/validation-primitives.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/durable/worker-lifecycle-store.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/ingress/errors.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/ingress/index.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/ingress/service.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/ingress/validation.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/ingress/webhook-router.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/ingress/webhook.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/model-access/contracts.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/model-access/custom-configuration.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/model-access/index.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/model-access/input.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/model-access/jsonc.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/model-access/model-metadata.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/model-access/normalization.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/model-access/pod-selection.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/model-access/runtime-factory.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/model-access/service.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/observability/configuration.ts` | Reviewed | Reviewed | Reviewed | Accepted: observability seam |
| `src/observability/contract.ts` | Reviewed | Reviewed | Reviewed | Accepted: observability seam |
| `src/observability/exporters.ts` | Reviewed | Reviewed | Reviewed | Accepted: observability seam |
| `src/observability/index.ts` | Reviewed | Reviewed | Reviewed | Accepted: observability seam |
| `src/observability/logger.ts` | Reviewed | Reviewed | Reviewed | Accepted: observability seam |
| `src/observability/metrics.ts` | Reviewed | Reviewed | Reviewed | Accepted: observability seam |
| `src/observability/safe-fields.ts` | Reviewed | Reviewed | Reviewed | Accepted: observability seam |
| `src/observability/setup.ts` | Reviewed | Reviewed | Reviewed | Accepted: observability seam |
| `src/observability/telemetry.ts` | Reviewed | Reviewed | Reviewed | Accepted: observability seam |
| `src/observability/tracing.ts` | Reviewed | Reviewed | Reviewed | Accepted: observability seam |
| `src/pi-integration/diagnostics.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/pi-integration/index.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/pi-integration/prompts.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/pi-integration/rollover.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/pi-integration/session.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/runtime/controller.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/runtime/index.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `src/runtime/worker.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `test/architecture/import-boundaries.test.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `test/composition/cli.test.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `test/composition/model-access-cli.test.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `test/durable/store.test.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `test/ingress/model-access.test.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `test/ingress/webhook.test.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `test/model-access/authentication.test.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `test/model-access/configuration.test.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `test/model-access/service.test.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `test/observability/safety.test.ts` | Reviewed | N/A (no exports) | Reviewed | Accepted: observability seam |
| `test/observability/support.ts` | Reviewed | Reviewed | Reviewed | Accepted: observability seam |
| `test/observability/telemetry.test.ts` | Reviewed | N/A (no exports) | Reviewed | Accepted: observability seam |
| `test/observability/tracing-failure.test.ts` | Reviewed | N/A (no exports) | Reviewed | Accepted: observability seam |
| `test/pi-integration/rollover.test.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `test/pi-integration/session.test.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `test/runtime/controller.test.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `test/runtime/part1.test.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
| `test/support/model-access.ts` | Pending fresh read | Pending fresh read | Pending fresh read | Pending dependency-order audit |
