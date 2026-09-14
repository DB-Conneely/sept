# SEPT Part 2 Execution Specification

## Status and authorization boundary

This file specifies the approved design for the next SEPT implementation run. It does not itself authorize the current chat to implement it. A future SEPT worker may execute this specification when the user explicitly instructs it to do so.

Part 2 now contains:

4. **Pi-native model access and selection.** Normalize Pi provider, model, authentication, and local-runtime capabilities into a small SEPT Node contract suitable for the installed CLI and the later dashboard.
5. **Adaptive model-neutral context rollover.** Replace the fixed percentage trigger with a durable headroom decision based on the active Pi model and finalized provider-reported usage.

ACP is deferred. Do not implement ACP in Part 2.

## Product objective

SEPT is a packaged customer-side agent runtime. A deployed SEPT Pod owns its Pi execution session, local model access, credentials, tools, workspace, durable state, cancellation, recovery, conversation, and context rollover. The later control plane selects and supervises Pods through stable Node contracts; it does not become a model provider or inference host.

The model-access experience must become:

1. List the providers and models Pi makes available to this Pod.
2. Show whether each provider is ready, requires authentication, does not require authentication, or has an actionable error.
3. Invoke Pi's native API-key or subscription/OAuth login when the user requests authentication.
4. Select a default provider/model for the Pod, with an explicit per-run override.
5. Give the resolved provider/model to the existing Pi session runtime.

This is explicit model selection and access normalization. It is not an automatic cost router, provider fallback framework, load balancer, model proxy, or replacement for Pi.

## Fixed architectural decisions

- Pi remains the only agent loop, provider/model catalog, provider client, authentication implementation, tool runner, session implementation, usage interpreter, and local/custom-provider compatibility layer.
- SEPT adds a thin model-access module around the installed Pi `ModelRuntime` public contract.
- Codex models use Pi's native ChatGPT Plus/Pro Codex OAuth provider or OpenAI API-key provider.
- Claude models use Pi's native Claude Pro/Max OAuth provider or Anthropic API-key provider. The complete Claude Code harness is not part of this work.
- Compatible local models use Pi's llama.cpp support or Pi-compatible Ollama, LM Studio, vLLM, OpenAI, Anthropic, or Google-style endpoints. SEPT does not download models, manage GPUs, implement inference, or recreate a local-model runtime.
- The MVP supports one stored credential per provider per Pod, matching Pi's current `CredentialStore` contract. Multiple named accounts for one provider are deferred.
- The Pod's configured Pi agent directory is the credential and model-access boundary. Credentials must never be copied into run manifests, state, logs, telemetry, conversation, fixtures, or cloud-facing metadata.
- Every durable run records the resolved provider and model at creation. Later Pod-default changes do not mutate existing runs.
- Run selection precedence is: explicit run selection, current Pod default, then SEPT built-in default only when valid.
- The core authentication operation is UI-neutral. The installed CLI supplies the first real interaction adapter. A later dashboard supplies another adapter without changing the Pi-facing service.
- Part 2 does not implement general remote access. Its contracts must remain transport-neutral so a later local UI or authenticated Node channel can reuse them.
- Do not move the current runtime out of `src` during Part 2. When dashboard and cloud components exist, perform one separately approved migration into top-level product modules rather than speculative empty scaffolding.

## Future top-level product layout

This is recorded direction, not a Part 2 refactor:

```text
packages/
  node/                 current customer-side SEPT runtime and container
apps/
  dashboard/            local/desktop/web orchestration workspace
services/
  cloud/                thin accounts, access, billing, entitlement, and relay API
```

Until those components exist, the current repository remains the Node package.

## Required current Node layout

Part 2 should establish the following bounded module structure:

```text
src/
  cli.ts                         thin command dispatch and composition
  cli/
    auth-interaction.ts          terminal Pi AuthInteraction adapter
  model-access/
    contracts.ts                 credential-blind Node-facing DTOs
    service.ts                   Pi ModelRuntime facade
    configuration.ts             Pod default and safe custom-model validation
    index.ts                     intentional public surface
  pi-integration/
    session.ts                   Pi agent session and rollover consumption
    rollover.ts                  adaptive decision and durable evidence
    diagnostics.ts               non-secret installed diagnostics
    prompts.ts
    index.ts
  ingress/
    service.ts                   authenticated Node HTTP projection
    validation.ts
  durable/
    contracts.ts
    store.ts

test/
  model-access/
    service.test.ts
    configuration.test.ts
  pi-integration/
    rollover.test.ts
    session.test.ts
  composition/
    model-access-cli.test.ts
  ingress/
    model-access.test.ts
```

Avoid unnecessary one-function files. If a proposed file remains trivial, keep it in its owning module. Do not leave duplicate old and new implementations wired simultaneously.

## Deliverable 4: Pi-native model access and selection

### Model-access service

Create one `ModelAccessService` backed directly by Pi `ModelRuntime`. It must own no provider-specific request code. Its public operations are:

```text
catalogue(provider?)
authenticationStatus(provider)
login(provider, method, interaction)
logout(provider)
getPodDefault()
setPodDefault(provider, model)
resolveSelection(explicitSelection?)
preflightSelection(provider, model)
validateCustomConfiguration()
```

The service must use Pi's existing `getProviders`, `getModels`, `getAvailable`, `getModel`, `checkAuth`, `getAuth`, `login`, `logout`, and credential-store behavior. Do not duplicate Pi provider knowledge beyond stable display normalization and safe validation.

### Normalized provider contract

Return only credential-blind fields required by the CLI and later UI:

```json
{
  "id": "anthropic",
  "name": "Anthropic",
  "authentication": {
    "state": "authenticated",
    "method": "subscription",
    "methods": ["subscription", "api_key"]
  },
  "modelCount": 3,
  "availableModelCount": 3
}
```

Authentication state is one of:

- `authenticated`
- `authentication_required`
- `not_required`
- `error`

Errors must be bounded, actionable, provider-accurate, and credential-blind. Do not return raw Pi/provider errors when they might include request data or secrets.

### Normalized model contract

```json
{
  "provider": "anthropic",
  "id": "model-id",
  "name": "Display name",
  "available": true,
  "api": "anthropic-messages",
  "contextWindow": 1000000,
  "maxOutputTokens": 64000,
  "capabilities": {
    "reasoning": true,
    "input": ["text", "image"]
  }
}
```

Do not expose credentials, authentication headers, OAuth data, raw provider payloads, credential paths, or arbitrary provider configuration.

### Authentication contract

Use Pi's UI-neutral `ModelRuntime.login(providerId, authType, AuthInteraction)` and `logout` contracts.

The SEPT interaction abstraction must faithfully carry Pi's current interaction forms:

- secret prompt
- text prompt
- option selection
- manual authorization code
- authorization URL
- device code
- progress/information
- cancellation
- success/failure

Do not build separate OpenAI, Anthropic, Google, Kimi, or local-provider login implementations.

The first installed presentation adapter is terminal based:

```bash
sept auth status --provider <provider>
sept auth login --provider <provider> --method subscription
sept auth login --provider <provider> --method api-key
sept auth logout --provider <provider>
```

Requirements:

- API keys and manual authorization codes are read from a hidden TTY prompt or standard input, never a command-line argument.
- Secret input, OAuth tokens, redirect contents, authorization headers, and credentials never enter logs, telemetry, durable run data, conversation, or command output.
- OAuth URLs and device-code instructions may be shown to the user because they are required interactions, but must not be logged as operational fields.
- Login cancellation must cancel the Pi login operation and release terminal/listener resources.
- Pi owns credential persistence and refresh through the Pod's credential store.
- The auth status result contains metadata only.

The later dashboard Authenticate button will supply a UI `AuthInteraction` adapter to the same service. Do not implement the dashboard or a cloud auth relay in Part 2. Do not expose plaintext secret mutation over the current general HTTP listener, which does not terminate TLS.

### Pod default and per-run selection

Store one small, credential-free, atomically written Pod default beside the Pod's Pi model-access configuration. The exact filename may remain `sept-model.json` if it is validated and documented.

The default record contains only:

```json
{
  "formatVersion": 1,
  "provider": "openai-codex",
  "model": "gpt-5.6-sol"
}
```

Requirements:

- Read the current default when each new run is admitted; do not cache it only at worker startup.
- Permit an explicit run request to override both provider and model together.
- Reject a request that supplies only one half of the pair.
- Validate provider existence, model existence, required metadata, and usable authentication before returning task acceptance.
- Never accept a task and then discover ordinary missing authentication only after the controller starts.
- Persist the final resolved pair into the run manifest.
- Changing the Pod default affects future runs only.
- Selection output must clearly distinguish `selected` from `available` and `authenticated`.

Installed commands:

```bash
sept models list [--provider <provider>]
sept models select --provider <provider> --model <model>
sept models current
sept models validate
```

Names can be adjusted for consistency, but the capabilities must remain one-step and scriptable with stable JSON output.

### Node API prepared for the dashboard

Expose only non-secret read and selection operations over the current authenticated Node API:

```text
GET /v1/model-access/providers
GET /v1/model-access/models
GET /v1/model-access/selection
PUT /v1/model-access/selection
```

These routes must use the same `ModelAccessService` as the CLI. They must be authenticated, strictly validated, size bounded, no-store, and credential-blind. Selection mutation contains provider/model identifiers only.

Secret-bearing login is not added to the current plain HTTP listener. The service-level `login` operation and installed CLI prove the complete underlying mechanism needed by the future UI. A later local IPC, loopback UI bridge, or end-to-end secured Node channel can adapt it without changing the model-access core.

### Local and custom models

Use Pi's installed mechanisms. SEPT validates and normalizes configuration; it does not run an inference service.

Requirements:

- Support already available Pi llama.cpp models through catalogue and selection.
- Support user-managed Ollama, LM Studio, vLLM, and compatible endpoints through Pi `models.json`.
- Require explicit context-window and maximum-output metadata for custom models used by SEPT rollover.
- Validate identifiers, supported Pi API dialect, model metadata, and endpoint shape before Pi session creation.
- Permit HTTPS endpoints and deliberate local/private HTTP endpoints.
- Do not silently accept a generic context-window default for a custom model.
- Do not unnecessarily reject safe Pi-supported credential indirection such as environment references or intentional credential commands in the trusted Pod configuration.
- Reject or prevent plaintext provider secrets in non-secret selection/configuration records.
- Do not implement model download, serving, GPU allocation, quantization, or runtime lifecycle management.

## Deliverable 5: adaptive model-neutral context rollover

Keep rollover in `src/pi-integration/rollover.ts` unless it becomes materially too large. It is a Pi session policy, not a provider-routing feature.

### Evidence

For the active Pi session, persist bounded evidence containing:

```text
provider
model
session ID
trusted context window W
last valid finalized usage U
last three positive context-growth deltas
consecutive unusable finalized samples
rotation-required flag
updated timestamp
```

Evidence is scoped to the exact provider, model, Pi session, and context window. Reset it on a fresh session or model mismatch. Validate it strictly on restart.

### Decision

Use finalized provider-reported Pi usage only. No tokenizer, character heuristic, cumulative spend, or provider-name hardcoding.

For context window `W` and current usage `U`:

```text
G = maximum of the last three positive finalized usage deltas
H = clamp(8% of W, 8,192, 65,536)                 handover allowance
F = clamp(6% of W, 8,192, 65,536)                 ordinary next-turn floor
N = max(F, ceil(1.5 * G))                          observed next-turn allowance
M = confidence margin:
      no growth samples: 8% of W
      one growth sample: 5% of W
      two or more:       3% of W
R = H + N + M                                             required headroom

rotate when U + R >= W
```

Do not cap `N` below observed growth merely to preserve a preferred percentage. If observed growth makes the remaining session unsafe, rotate at the next Pi-safe seam. If `R` approaches or exceeds the remaining usable window, record the reason and require immediate rotation rather than shrinking the reserve.

The exact arithmetic must be isolated and deterministically tested. Integer rounding must be specified. Logged events expose only numeric policy evidence and bounded classifications.

### Missing and invalid information

- Missing or invalid model context-window or maximum-output metadata fails before invocation.
- Unsuccessful or aborted model responses do not count as valid usage samples.
- A missing/invalid finalized usage sample is recorded as unusable; never treat it as zero.
- Do not abort arbitrary in-progress tool work solely because a sample counter was reached.
- Evaluate persistent unusable usage at a safe session/invocation seam. If SEPT cannot establish safe remaining headroom, block further autonomous model calls with an actionable credential-blind compatibility error.
- Usage regression within the same uncompacted Pi session is invalid evidence. Do not feed a negative delta into the estimator.
- A restart with a durable rotation-required flag must perform one native steer and complete the normal durable handover/new-session path without a duplicate steer.

### Preserved lifecycle contract

- Pi auto-compaction remains disabled.
- Any observed same-session compaction remains a failure.
- Rotation uses one native `session.steer()`.
- The predecessor completes the required handover.
- Handover JSON, Markdown, event, and state are fsynced before `AgentSessionRuntime.newSession()`.
- The successor is a genuine fresh Pi session.
- Cancellation, drain, shutdown, wait/wake, and conversation continuity from Part 1 remain intact.

## Audit of the cancelled partial implementation

The cancelled worker left uncommitted, incomplete Part 2 work. The next worker must audit and reconcile it; do not assume it is correct and do not discard unrelated Part 1/user changes.

Aligned partial work:

- `src/pi-integration/models.ts` wraps Pi `ModelRuntime` rather than creating provider clients.
- It sketches credential-blind catalogue DTOs and generic login/logout.
- `src/cli.ts` sketches `models` and `auth` commands with hidden terminal secret input.
- `sept-model.json` sketches an atomic Pod default.
- `src/pi-integration/rollover.ts` isolates arithmetic and durable evidence.
- `src/pi-integration/session.ts` begins consuming provider-reported usage and model metadata.
- The partial tree currently passes `npm run check`.

Required corrections:

- Move the model-access concern into the target `src/model-access` module rather than leaving catalogue, auth, configuration, and selection mixed in one vague `models.ts` file.
- Move terminal interaction code out of the composition-heavy `src/cli.ts`.
- Read the Pod default per task admission; the partial service caches it at worker construction.
- Preflight model metadata and authentication before accepting a task.
- Add the required credential-blind Node API; the partial code does not implement it.
- Reconcile custom-model validation with Pi's supported trusted credential indirection rather than narrowing Pi without cause.
- Correct the rollover formula: the partial implementation caps next-turn reserve below observed tool-heavy growth.
- Evaluate persistent missing usage at a safe boundary rather than aborting arbitrary active work after three assistant responses.
- Complete focused model-access and rollover tests plus installed CLI/worker/container exercises.
- Reconcile manifest migration, documentation, and obsolete fixed-threshold options deliberately.

## Implementation order for the SEPT worker

1. Inspect Git/worktree state and distinguish Part 1, user-authored documentation, and cancelled Part 2 edits. Preserve unrelated work. Do not commit, push, deploy, or rewrite history.
2. Read the installed Pi 0.85.1 public `ModelRuntime`, authentication, credential-store, model catalogue, custom-model, llama.cpp, session, and usage contracts.
3. Establish `src/model-access` and move/refactor only the relevant partial behavior into its bounded public surface. Remove dormant duplicates.
4. Implement normalized catalogue, authentication status, UI-neutral login/logout, Pod default, selection resolution, preflight, and custom-model validation.
5. Implement the terminal auth adapter and installed CLI commands. Exercise real non-secret Codex subscription status; exercise login interaction mechanics with credential-free deterministic Pi providers. Do not perform paid calls or alter the user's real provider credentials.
6. Add authenticated credential-blind Node catalogue/status/selection routes using the same service.
7. Wire per-admission selection resolution and preflight through direct task and webhook paths. Persist the resolved pair in every run manifest.
8. Correct and finish adaptive rollover and its durable restart behavior in the existing Pi session lifecycle.
9. Add deterministic compatibility coverage for 128k, 272k, and approximately 1M windows; ordinary and tool-heavy growth; exact boundaries; missing/invalid/regressing usage; fresh-session replacement; cancellation; wait/wake; and restart.
10. Exercise an API-key/custom local provider through the installed worker and Pi adapter without real secrets. Exercise installed model catalogue, default selection, explicit override, unauthenticated rejection, and container paths.
11. Run `npm run check`, the complete test suite, production and full dependency audits, diff hygiene, and a no-cache container build/smoke. Verify no secrets appear in source, fixtures, outputs, logs, telemetry, state, or conversation.
12. Update README, Pi contract, architecture, worker API, project direction, and orchestration prompt. Record ACP and complete external harnesses as deferred.
13. Write `docs/part-2-report.md` with delivered behavior, exact installed-runtime evidence, compatibility coverage, migration notes, and remaining risks. Stop after Part 2; do not begin packaging or dashboard work.

## Required acceptance evidence

Completion requires all of the following through wired installed paths:

- Codex provider appears with correct non-secret subscription authentication status.
- Claude exposes the same normalized authentication and selection contract through deterministic tests and installed Pi catalogue evidence; no real user credential may be modified without explicit permission.
- API-key login interaction stores through Pi's credential contract without command-line secret exposure.
- Provider logout and failed/cancelled login are bounded and leave coherent status.
- Provider/model catalogue contains only approved normalized fields.
- Pod default changes affect new runs without restarting the worker and never alter existing manifests.
- Explicit per-run selection overrides the Pod default.
- Invalid, unavailable, or unauthenticated selection is rejected before task acceptance.
- Compatible local-model configuration is validated and executed through the real installed Pi adapter.
- Adaptive rollover decisions are proven across materially different windows and growth patterns.
- Rollover evidence survives restart and cannot cause duplicate steering.
- Drain, cancel, shutdown, wait/wake, transcript, and fresh-session guarantees remain green.
- The installed CLI, authenticated worker, and built container all reach the delivered code.

Compilation or isolated unit tests alone do not count.

## Explicitly deferred

- ACP server or client work.
- Complete Claude Code, Codex CLI, or other external-agent harness supervision.
- Multiple named credentials for the same provider inside one Pod.
- Automatic cost/quality routing, fallbacks, or load balancing.
- Dashboard implementation.
- General remote access, cloud relay, accounts, billing, or deployment.
- Local model serving, downloads, GPU management, or inference infrastructure.
- Moving the current Node runtime into a future monorepo layout.
