# Pi contract pinned by SEPT

SEPT pins `@earendil-works/pi-coding-agent` 0.85.1 and uses its installed public contracts directly.

## Model access and authentication

- `ModelRuntime.create()` is configured with the Pod's Pi `auth.json`, `models.json`, and `models-store.json`. Network catalogue refresh is off by default; Pi's built-ins, stored catalogues, custom providers, and llama.cpp integration remain authoritative.
- `getProviders`, `getModels`, `getAvailable`, `getModel`, `checkAuth`, `getAuth`, and `getProviderAuthStatus` supply discovery, availability, and preflight. SEPT normalizes only IDs, display names, auth state/methods, API dialect, context/output limits, reasoning, and input capabilities. Pi's public `ApiKeyAuth` contract permits both ambient-credential and keyless providers to omit interactive login. SEPT therefore uses the credential-blind `AuthCheck`: a source-free successful API-key check with no login methods is `not_required`, while a check carrying source evidence is `authenticated`/`api_key`. The source label itself is never projected.
- `ModelRuntime.login(providerId, authType, AuthInteraction)` and `logout()` are the only credential mutation paths. Pi's `CredentialStore` retains one credential per provider and owns serialized persistence and OAuth refresh. SEPT never reads or returns credential values.
- Pi `AuthInteraction` supports text, secret, option, and manual-code prompts plus information, authorization URL, device-code, and progress events. SEPT's terminal adapter preserves those forms and propagates cancellation; secrets and manual codes come from hidden TTY input or stdin.
- The Pod default is SEPT's separate `sept-model.json`, containing only format version, provider, and model. Every new direct or webhook run resolves explicit pair > current Pod default > built-in default, then requires Pi model existence, availability, usable metadata, and resolved auth before durable acceptance.
- Pi's `models.json` supports OpenAI Completions/Responses, Anthropic Messages, and Google Generative AI compatible endpoints, environment interpolation, and intentional credential commands. SEPT validates URL safety and requires explicit `contextWindow` and `maxTokens` for custom entries because Pi's generic defaults are insufficient evidence for rollover. Sensitive headers always require environment/command indirection; only the documented `local` API-key sentinel is accepted as plaintext for a keyless local/private HTTP endpoint. Loaded llama.cpp models use Pi's dynamic provider catalogue and are checked from their reported metadata.

## Session and rollover

- `AgentSession` owns the agent lifecycle and exposes `subscribe()`, `steer()`, `abort()`, `setAutoCompactionEnabled()`, `sessionId`, `sessionFile`, and finalized `message_end` events. SEPT persists cancellation intent before native `abort()`; Pi propagates cancellation through provider and tool work.
- `calculateContextTokens(usage)` interprets finalized provider-reported assistant usage. SEPT has no tokenizer, character estimate, provider hardcoding, or cumulative-spend trigger.
- `session.model.contextWindow` and `session.model.maxTokens` are required trusted metadata. The adaptive policy keeps only positive same-session growth and reserves handover, an uncapped observed next-turn allowance, and a confidence margin. Missing, invalid, or regressing samples are never treated as zero.
- Persistent unusable usage is evaluated only after the current Pi invocation reaches a safe seam; SEPT does not abort an arbitrary active tool batch because a sample count was reached.
- `steer()` is delivered after the current assistant tool calls and before the next model call. A durable rotation flag survives restart. If the resumed Pi transcript already contains the exact steer and completed handover response, SEPT reuses it rather than steering twice. If that steer is present but its assistant response was interrupted, SEPT issues a distinct recovery turn for the handover and never reinjects the steer as an ordinary prompt.
- `AgentSessionRuntime.newSession()` genuinely replaces the active session. Subscriptions and disabled auto-compaction are rebound after replacement.

SEPT subscribes to Pi events for operational evidence and finalized usage only. It never projects Pi reasoning, partial output, provider payloads, auth interactions, or tool payloads into public conversation. Only SEPT's separately validated assistant `message` field is publishable.

SEPT disables auto-compaction in both settings and the live session. Any `compaction_start` is a run failure. Unattended sessions use `projectTrusted: false`: Pi still loads context files such as `AGENTS.md`, while repository-local extensions, packages, skills, prompts, and themes do not execute merely because a workspace was assigned.

Installed references inspected for Part 2: Pi 0.85.1 `ModelRuntime`, `Models`, `Provider`, `CredentialStore`, `AuthInteraction`, `AgentSessionRuntime`, custom-model, provider, llama.cpp, SDK, session, and usage declarations/documentation. Primary public documentation: [SDK](https://pi.dev/docs/latest/sdk), [models](https://pi.dev/docs/latest/models), [providers](https://pi.dev/docs/latest/providers), and [compaction](https://pi.dev/docs/latest/compaction).
