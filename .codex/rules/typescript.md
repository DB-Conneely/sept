---
paths: ["src/**/*.ts", "test/**/*.ts"]
---

# TypeScript Rules (SEPT Node)

These rules apply to every TypeScript file under `src/` and `test/`. The repository `AGENTS.md` and the execution specification for the active part also apply. When instructions conflict, preserve SEPT's product invariants and follow the stricter quality requirement.

SEPT is a thin, durable, single-slot wrapper around the native Pi runtime. Code must make ownership, authority, lifecycle, durability, cancellation, and security boundaries obvious to a reviewer. Working behavior hidden inside tangled or unauditable code is not acceptable delivery.

## Quality gates — non-negotiable

After each coherent module change:

- `npm run check` passes with zero TypeScript errors.
- The directly affected tests pass with zero failures.
- The changed module is reviewed against every structural and documentation rule below before work expands into another module.

The foundation-refactor migration is the only temporary exception to the first bullet because these gates were introduced against an already non-compliant tree. Until the first fully green `npm run check`, every touched module must pass targeted ESLint and Prettier checks plus its affected tests; the full gate must be rerun after each module, its remaining failures recorded, and the count must strictly decrease without a new violation appearing in a completed module. This exception ends permanently when the repository first reaches green and never relaxes the final handoff gate.

Before any tranche, phase, or implementation handoff:

- `npm test` passes with zero failures.
- `npm audit --omit=dev` reports no unresolved production vulnerability.
- The installed `./sept` entry point exercises the changed production path. Direct source imports, isolated fixtures, compilation, and unit tests alone are not completion evidence.
- Container-affecting work also passes a no-cache image build and exercises the same installed path inside the image.
- `git diff --check` passes.
- No changed production path is dormant, duplicated, or reachable only from tests.

The repository gate is `npm run gate`. `npm run check` composes strict typechecking, type-aware ESLint with zero warnings, and Prettier verification; `npm test` includes meta-tests that prove the custom lint rules, exact dependency pins, strict compiler flags, and exported-behavior coverage remain enforced. Do not weaken, bypass, exclude, or replace these gates to make a refactor pass.

## Structural delivery

- One module has one named responsibility. Separate durable persistence, validation/codecs, lifecycle orchestration, transport adaptation, Pi projection, and HTTP/CLI composition when they change for different reasons.
- Do not create god classes or service files that accumulate unrelated lifecycle, storage, transport, policy, validation, and presentation behavior.
- Functions over 40 logical lines must be split before review. Each function performs one operation at one abstraction level.
- Files over 300 logical lines require decomposition into cohesive modules. A public facade may coordinate those modules but must not reabsorb their implementation details.
- Do not compress control flow. Conditions, throws, loop bodies, `try`/`catch`/`finally` blocks, and multi-step callbacks use readable multi-line blocks.
- Do not place multiple actions or declarations on one line.
- Break long validation expressions into named predicates or sequential checks whose failures identify the violated invariant.
- Prefer early returns to deep nesting, but do not turn early returns into dense one-line guard clauses.
- Constructor dependencies and ownership must be explicit. Avoid process-wide mutable state and hidden singletons.
- There is one production path per behavior. Delete superseded implementations and unused scaffolding instead of retaining parallel mechanisms.
- `index.ts` files are intentional mechanism boundaries only. They contain documented exports, not business logic. Cross-mechanism imports go through the target mechanism's public `index.ts`, as enforced by `test/architecture/import-boundaries.test.ts`.
- Use named exports only. Default exports are prohibited.
- Ask before handoff: would a staff engineer approve the structure, naming, failure behavior, and reviewability of this diff? If not, fix it now.

## Comments and documentation

- Every exported class, function, interface, type alias, and non-obvious constant has concise TSDoc describing its contract, ownership, and relevant invariants. A barrel re-export does not need a duplicate comment when the exported declaration is documented at its source.
- Every security boundary, authority check, durable ordering requirement, state transition, cancellation/revocation race, retry/idempotency rule, and intentionally bounded resource has a nearby comment explaining **why** the rule exists and what must remain true.
- Complex state machines document legal states, transitions, and the owner of each transition at the state-machine boundary.
- Comments explain intent and constraints, not syntax. Do not narrate obvious code.
- Update or remove comments in the same change as the behavior they describe. Stale comments are defects.
- Public API and CLI behavior changes update their user-facing or execution-spec documentation in the same change.
- No `TODO`, `FIXME`, or `HACK` may remain in delivered code. Track deferred work outside production source.

## TypeScript and API design

- TypeScript strict mode remains enabled. Do not weaken `tsconfig.json` or add per-file exceptions.
- Zero explicit `any` types. Accept hostile or untyped input as `unknown`, then narrow it with a codec or type guard before use.
- Exported/public functions and methods have explicit return types. Parameters are explicitly typed. Internal inference is allowed only when the type is immediate and unambiguous.
- Prefer discriminated unions and exhaustive switches for lifecycle state. Do not model multi-state behavior with interacting booleans or loosely related string literals.
- Avoid boolean parameters whose meaning is unclear at the call site. Use a named options object or discriminated union.
- Avoid unsafe type assertions. A narrowing assertion such as `as SomeType` requires an immediately preceding `// CAST:` comment proving the runtime validation or invariant that makes it safe. `as const` and `satisfies` are allowed because they preserve or check types rather than bypass validation.
- A non-null assertion (`value!`) requires an immediately preceding `// ASSERT:` comment proving why null or undefined is impossible at that exact point. Prefer control-flow narrowing instead.
- No `@ts-ignore` or `@ts-expect-error` without an adjacent explanation and a focused test proving the boundary. A suppression cannot conceal production type unsafety.
- No `eslint-disable` or formatter-ignore directive without an adjacent explanation of the precise rule conflict. Broad file-level disables are prohibited.
- Parse external JSON, durable state, provider data, MCP data, environment values, CLI input, and HTTP bodies exactly once at their owning boundary. Downstream code receives validated domain types.
- Use semantic domain names. Avoid vague containers such as `data`, `item`, `thing`, `manager`, or `service` when a more precise name exists.
- Pin exact dependency versions in `package.json`. Version ranges using `^`, `~`, tags, or wildcards are prohibited.
- Prefer platform and already-installed primitives. A new dependency requires a present need, active maintenance, acceptable transitive/security cost, and production-path evidence.

## Errors and failure behavior

- Production code under `src/` does not throw raw strings or instantiate a generic `Error` for an expected domain, validation, lifecycle, capacity, authorization, or transport failure. Use `SeptError` or a focused typed subclass that callers can classify without parsing messages.
- Test fixtures use explicit fixture/assertion error types or assertion helpers rather than unclassified `Error` throws.
- Caught errors are `unknown` until narrowed. Preserve an original cause when wrapping an unexpected failure, while ensuring secrets and hostile payloads never enter the public message.
- Do not use error-message text as control flow when a typed error or discriminant can express the condition.
- Fail closed on malformed present durable state, ambiguous authority, unsupported protocol data, unsafe paths, exhausted capacity, and missing credentials.
- Cleanup errors must not skip lease release, process shutdown, durable settlement, or other mandatory finalization. Use nested `try`/`finally` where independent cleanup guarantees are required.

## SEPT architecture and ownership

- Pi remains the only agent runtime. Do not implement provider clients, agent loops, tool runners, compaction, context estimation, or alternate model orchestration in SEPT.
- `durable/` owns codecs, atomic persistence, fsync ordering, leases, and recovery. It does not import ingress, runtime, Pi, connector, or provider behavior.
- `runtime/` owns the single resident-run lifecycle and coordinates domain services. It does not own HTTP parsing, provider-specific trigger logic, or connector protocol implementations.
- `pi-integration/` is the narrow production seam to native Pi sessions and tools. It does not become a second runtime or policy store.
- `ingress/` authenticates, bounds, validates, and translates transport requests. Business state machines and provider behavior do not live in route handlers.
- `model-access/` remains a bounded normalization/control layer over Pi's installed `ModelRuntime`.
- `observability/` receives sanitized bounded facts and imports no SEPT business mechanism.
- Connector and trigger mechanisms added by Part 1 must remain separate from Pi lifecycle: deterministic trigger observation runs independently; authorized MCP tools enter only through production Pi wiring.
- Provider-specific polling, streaming, acknowledgement, cursor, subscription, and webhook behavior belongs to immutable integration-owned adapters, never generic SEPT core branches.
- Compatibility webhook code does not count as the generalized trigger implementation and must not dictate connector architecture.

## Durability, concurrency, and cancellation

- Preserve the documented fsync-before-transition order. A state change cannot become visible before every artifact required to recover it is durable.
- Make the owner of every cursor, checkpoint, lease, acknowledgement, lifecycle transition, and queue disposition explicit in code and comments.
- Race-sensitive operations require tests for both orderings. This includes cancellation versus completion, revoke versus call/probe, message arrival versus waiting/terminal transition, shutdown versus active work, and retry versus durable settlement.
- Register cancellation ownership before an operation can become externally active. Revocation or shutdown must not miss an operation in the gap between eligibility checking and in-flight registration.
- Cleanup is idempotent. Partial initialization, repeated cancellation, repeated revocation, and restart reconciliation cannot acquire duplicate authority or leak a process, connection, listener, timer, or lease.
- Never advance a provider cursor or acknowledgement before durable local acceptance or a durable filtered disposition.

## Security and secret handling

- Credentials remain local to their owning provider or connector boundary. They never enter prompts, manifests, conversations, durable event data, logs, telemetry, API projections, thrown messages, snapshots, or fixtures.
- Imported definitions, filesystem paths, provider payloads, MCP schemas/results, child output, and HTTP input are hostile until strictly validated and bounded.
- Discovery is never execution, installation, grant, connection, or authority.
- Check authority at admission and again immediately before an external action. Live revocation overrides any earlier manifest snapshot.
- Do not pass the general process environment to child processes. Construct the smallest explicit environment and prevent connector-controlled values from replacing execution-critical variables such as `PATH`, runtime loaders, or SEPT/Pi credentials.
- Bound requests, responses, schemas, pagination, queues, subprocess output, stderr capture, retries, timers, and retained diagnostics before buffering or parsing them.
- Logs and telemetry use bounded classifications, not raw payloads, arguments, results, headers, tokens, checkpoint values, or exception text from hostile systems.
- Do not expose secret-bearing operations through the ordinary plain TCP control listener.

## Scaling capacity without speculative infrastructure

- Preserve one active Pi execution slot per Pod while keeping independent Pods horizontally replicable without shared mutable process state.
- Resource limits are explicit and isolated per connector, trigger binding, run, and Pod. One noisy integration cannot exhaust every binding or Pod.
- No unbounded collection, queue, retry loop, pagination loop, stream buffer, child-process output, or in-memory history is permitted.
- Avoid repeated whole-state scans on hot event/tool paths. Where a bounded scan is intentionally acceptable, name the bound and test the capacity edge.
- Backpressure is explicit, deterministic, observable through bounded classifications, and tested at capacity.
- Do not add distributed coordination, a global scheduler, a registry framework, multiplexing, caching, or batching without a present measured or correctness requirement.

## Tests and acceptance evidence

- Every exported production function or class has at least one focused test of its public contract. Important error variants and state transitions have direct regression coverage.
- Tests assert observable behavior and durable evidence, not private implementation details.
- A bug fix begins with or includes a regression test that fails for the original defect.
- Security tests use unmistakable canary secrets and assert their absence from every public and operational surface.
- Capacity tests exercise the exact configured boundary and one item beyond it.
- Recovery tests use real durable files and process restart where restart behavior is claimed.
- Installed-path tests invoke `./sept`, the installed worker, production `PiSessionHost`, and the built container when those paths are in scope. Bypassing composition with a direct class call is supporting evidence only.
- No test-only production branch, alternate runtime, dormant adapter, or mocked proof may be presented as acceptance.

## Existing debt and scope discipline

- Do not add a new violation because similar legacy code already exists.
- When changing a legacy function or module, leave the touched area compliant with this file rather than preserving poor structure for consistency.
- Record material pre-existing violations discovered outside the approved scope; do not silently broaden feature work into an unrelated rewrite.
- During an explicitly approved foundation-refactor phase, the full agreed TypeScript scope must meet these rules before Part 1 feature implementation resumes.
- Preserve unrelated user work. Never use quality cleanup as permission to discard behavior, weaken tests, rewrite history, commit, push, or deploy.
