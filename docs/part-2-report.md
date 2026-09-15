# Part 2 implementation report

## Scope and architecture

Part 2 delivers the two authorized Node-runtime tranches: Pi-native model access/selection and adaptive model-neutral context rollover. ACP, complete external-agent harnesses, packaging, dashboard, cloud, deployment, provider routing, and local-model serving remain deferred.

SEPT remains a thin boundary around the installed `@earendil-works/pi-coding-agent` 0.85.1 runtime. Pi remains responsible for provider/model catalogues, authentication, credential persistence and refresh, compatible endpoint requests, the agent and tool loop, sessions, finalized usage interpretation, steering, and fresh-session replacement. SEPT adds only credential-blind normalization, selection/admission control, safe configuration requirements, and durable rollover policy.

The cancelled flat `src/pi-integration/models.ts` implementation was reconciled into the bounded `src/model-access` surface. Terminal interaction moved to `src/cli/auth-interaction.ts`; no duplicate model-access implementation remains wired.

## Delivered model access and selection

- `ModelAccessService` directly uses Pi `ModelRuntime` for provider/model discovery, availability, authentication status, request-auth preflight, login, logout, and credential-store mutation.
- Provider, model, authentication, and selection DTOs contain only approved metadata. They exclude keys, tokens, headers, OAuth records, raw provider payloads, configuration paths, auth-source labels, and arbitrary provider configuration. Errors are bounded and credential-blind. Because Pi permits both keyless and ambient-credential providers to omit interactive login, SEPT distinguishes them through Pi's credential-blind `AuthCheck`: a source-free success is `not_required`, while source-backed ambient auth is `authenticated`/`api_key`. Both remain available and preflightable.
- UI-neutral login carries Pi text, secret, selection, manual-code, authorization-URL, device-code, progress/information, and cancellation forms. The installed terminal adapter reads keys and manual codes from hidden TTY input or stdin; no secret CLI argument exists.
- Installed commands provide `models list|select|current|validate` and `auth status|login|logout`. Pi remains the sole credential persistence path.
- `sept-model.json` is an atomic mode-0600, format-version-1 record containing only provider/model. Resolution precedence is explicit run pair, current Pod default, then the built-in default only after successful preflight.
- Direct and task-webhook admissions share one asynchronous resolution/preflight path. Each admission rereads the Pod default and verifies provider/model existence, required context/output metadata, Pi availability, and resolved auth before `RunStore.create()`, webhook receipt claim, or controller launch.
- Every new format-3 run manifest persists its immutable resolved provider/model. A later default change affects only later admissions.
- Authenticated, no-store HTTP routes expose provider catalogue, model catalogue, current selection, and selection mutation. Request bodies and query strings are strict and bounded. Secret login is intentionally absent from the plain HTTP listener.
- Custom `models.json` validation accepts Pi JSONC, supported compatible API dialects, environment interpolation, intentional credential commands, HTTPS endpoints, and deliberate local/private HTTP endpoints. It rejects credential-bearing URLs, unsafe public HTTP, plaintext API keys and sensitive headers, invalid identifiers, duplicate models, and missing/invalid explicit `contextWindow` or `maxTokens` rollover metadata. Keyless local/private endpoints may use only the documented non-secret `local` API-key sentinel; ordinary non-sensitive header literals remain valid.
- Pi-compatible local execution is exercised through the installed worker and its production `PiSessionHost`; SEPT adds no inference server, downloader, GPU manager, or provider client.

## Delivered adaptive rollover

For active context window `W`, finalized provider usage `U`, and the maximum `G` of the last three positive same-session growth deltas, SEPT computes integer reserves as follows:

- `H = clamp(ceil(0.08W), 8192, 65536)`
- `F = clamp(ceil(0.06W), 8192, 65536)`
- `N = max(F, ceil(1.5G))`
- `M = ceil(0.08W)`, `ceil(0.05W)`, or `ceil(0.03W)` for zero, one, or at least two growth samples
- rotate when `U + H + N + M >= W`

Observed growth is never capped. The decision and its bounded numeric classification are persisted as durable evidence. `rollover.json` is strictly scoped to provider, model, Pi session ID, and context window and retains only the last valid finalized usage, three positive deltas, consecutive unusable count, rotation-required flag, and update time. Scope mismatch resets evidence for the new session/model.

Only successful finalized Pi assistant usage interpreted by Pi's `calculateContextTokens()` is eligible. Missing, zero, invalid, over-window, or regressing samples are not treated as zero and never use a tokenizer, character estimate, provider name, or cumulative spend. Three consecutive unusable finalized samples block further autonomous invocation only after the active Pi invocation and tool batch reach a safe seam.

Pi auto-compaction remains disabled. Rotation still uses one native `session.steer()`. Handover JSON, Markdown, event evidence, and state are fsynced before genuine `AgentSessionRuntime.newSession()` replacement. Restart handling covers all rotation seams:

- a durable flag without a Pi steer marker queues the one required native steer;
- a completed steer/handover in the resumed transcript is reused without another provider call;
- a steer marker followed only by an interrupted/aborted assistant response recovers the finalized pre-rotation assistant text, uses a distinct handover-recovery turn, never reinjects the steer as an ordinary prompt, and then follows the normal durable handover/new-session path.

Cancellation, drain, graceful shutdown, waiting/wake, message ordering, restart adoption, strict limits, single-slot ownership, workspace confinement, and bounded conversation behavior remain unchanged and green.

## Migration

- New manifests use format 3 and contain no fixed rollover threshold or token-reserve options.
- Existing complete format-2 manifests remain strictly readable and normalize to the current manifest contract. Their legacy `thresholdPercent` and `handoverReserveTokens` values are validated for safe migration but no longer drive rollover.
- Partial or malformed format-2 state continues to fail closed.
- Existing run manifests retain their recorded provider/model. Pod-default changes never rewrite them.
- Existing rollover evidence is accepted only when its complete validated scope matches the active provider, model, Pi session, and context window; otherwise SEPT initializes fresh evidence.

## Installed-runtime acceptance evidence

Evidence was completed on 2026-09-14 without paid cross-provider requests or real credential mutation.

- `npm run check` passed.
- `npm test` passed all 94 tests with bounded test-file concurrency (`94` pass, `0` fail, `0` skipped). The suite includes the installed `./sept` CLI and worker, authenticated API, production `PiSessionHost`, real Pi session/runtime lifecycle, deterministic local providers, native model/tool abort, drain, wait/wake, restart, transcript/SSE, limits, and migration regressions.
- The installed model/auth CLI test validated custom configuration, performed API-key login through Pi from stdin into an isolated temporary Pi auth store, verified mode-0600 persistence and credential-blind output, selected/reported a Pod default, logged out through Pi, and confirmed unavailable selection after logout.
- Deterministic subscription tests exercised Pi authorization URL, device code, progress, text, option, and manual-code interactions plus logout, failure, and cancellation. A Pi-native keyless provider with a source-free successful auth check and no login method reported `not_required`, remained available, and passed selection preflight. A separate ambient-only no-login provider supplied Pi source evidence, reported `authenticated`/`api_key`, remained available/preflightable, and did not expose its source. Injected admission fixtures use unique temporary Pi auth paths and assert deterministic `api_key` state, proving they do not inherit the host Pi store.
- Read-only installed status reported `openai-codex` as `authenticated` through `subscription`. No request was sent and no credential was changed.
- The installed Pi Anthropic catalogue exposed 14 models and the same normalized `subscription`/`api_key` method contract. Deterministic tests used an isolated empty auth path and asserted `authentication_required`; no real Anthropic credential was modified.
- The installed worker used a real Pi-compatible local HTTP adapter for four model calls. It proved a default change from `alpha` to `beta` without restart, immutable old manifests, explicit override back to `alpha`, webhook use of the fresh default, and rejection of an unauthenticated model before acceptance.
- Rollover arithmetic passed exact before/at boundaries for 128,000, 272,000, and 1,048,576-token windows, plus ordinary and 200,000-token tool-heavy growth, positive-history bounding, invalid/missing/regressing usage, and scope reset.
- Production Pi lifecycle tests proved disabled project extension execution, preserved `AGENTS.md` context, no text-length heuristic, completed atomic tool batches before native steering, one steer event, no compaction, durable-before-successor ordering, and distinct successor session IDs.
- A deterministic interrupted-handover restart test instrumented the real `AgentSession.steer()` contract and observed exactly one native steer across interruption/restart, one durable steer event, no duplicate steer text, exactly-once public pre-rotation progress before successor completion, handover evidence before successor creation, epoch advancement, and completion by a genuine fresh successor.
- `npm audit` and `npm audit --omit=dev` each reported zero vulnerabilities.
- `docker build --no-cache -t sept:part2-local .` passed, including production dependency pruning with zero vulnerabilities. The resulting local image was exercised through its installed entry point.
- Container smoke proved fail-closed unauthenticated catalogue access (`401`), authenticated health and provider catalogue (`200`), `Cache-Control: no-store`, normalized provider fields, and installed CLI catalogue access. In a credential-free container, Anthropic correctly reported `authentication_required` and 14 catalogue models.
- `git diff --check` passed. A high-confidence credential scan over intentionally changed text files found no private keys or provider credential patterns; fixture-only bearer/key placeholders remain synthetic and isolated. Operational outputs, manifests, defaults, logs, telemetry, conversations, and container context were reviewed for credential-blindness.

## Remaining risks and deferred work

- Pi 0.85.1 public contracts and catalogue semantics are pinned dependencies; a Pi upgrade requires contract and installed-path revalidation.
- Network catalogue refresh is disabled by default. Availability reflects Pi built-ins, stored catalogue state, configured local/custom providers, and current credential resolution unless a future approved operation explicitly refreshes Pi.
- Deliberate local/private HTTP endpoints and credential commands are trusted Pod configuration. Operators must protect the Pi agent directory and review commands they configure. The `local` API-key sentinel is intentionally non-secret and must not be replaced with a real service credential; real local credentials use Pi storage or environment/command indirection.
- Provider usage that cannot remain compatible with finalized usage reporting deliberately blocks autonomous continuation after the bounded safe-seam threshold rather than guessing headroom.
- The MVP retains Pi's one-credential-per-provider boundary. Multiple named accounts, automatic routing/fallback, remote secret onboarding, and end-to-end dashboard auth remain deferred.
- Test-file concurrency is bounded to four because unrestricted simultaneous installed Pi runtimes and spawned workers caused a reproducible resource-sensitive worker reset; the complete bounded suite is green.
- No paid live Anthropic, Google, or local-model service request was needed. Cross-provider compatibility evidence is deterministic and uses Pi's installed contracts/catalogues.

Part 2 stops at the authorized Node runtime boundary. No packaging migration, dashboard, cloud service, ACP, deployment, or external-agent harness work was started.
