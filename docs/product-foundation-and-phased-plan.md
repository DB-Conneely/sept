# SEPT Product Foundation and Phased Plan

## Status

This document records the product direction established after Part 1. Part 2 was subsequently authorized and implemented as Pi-native model access/selection plus adaptive model-neutral rollover. ACP remains outside the mandatory Node MVP unless a concrete ACP client and transport become a launch requirement.

## Product synopsis

SEPT is a customer-side, durable agent runtime and user orchestration product. It does not resell inference or move provider credentials into SEPT Cloud. Customers run the packaged SEPT Node on their own device or server, connect their own model access, and operate durable worker instances through a local or remote control plane.

The Node owns execution authority, Pi sessions, tools, workspaces, credentials, durable run state, cancellation, recovery, context cycling, and user-visible conversation data. A later SEPT Cloud service remains deliberately thin: accounts, access validation, billing, entitlements, node discovery, policy, bounded metadata, and secure command relay. It does not execute models or become the authoritative run store.

Terminology:

- **SEPT Node**: the packaged runtime image or binary.
- **SEPT Pod**: one deployed instance of the Node package and one isolated worker lane.
- **Host**: the customer device or server that can run one or more Pods.
- **Control plane**: the local or remote user workspace for assigning, supervising, and inspecting work.

## Pi, SEPT, and ACP

### Pi supplies model execution

Pi is the model and agent-runtime layer inside each SEPT Pod. The installed Pi runtime already supplies:

- Provider and model catalogs, lookup, availability, and explicit provider/model selection.
- The agent loop, streaming, sessions, tool execution, and provider-reported usage.
- API-key authentication through runtime values, environment variables, or a local auth store.
- OAuth and subscription login flows supported by the provider, including ChatGPT Plus/Pro Codex, Claude Pro/Max, and GitHub Copilot.
- Built-in API-key providers including OpenAI, Anthropic, Google, Kimi, DeepSeek, OpenRouter, Mistral, Groq, Cerebras, and others.
- Custom and local providers through supported OpenAI, Anthropic, and Google-compatible APIs, including Ollama, LM Studio, vLLM, and llama.cpp paths.
- Pluggable credential storage through Pi's `CredentialStore` contract.

SEPT already accepts `provider` and `model` on a run, resolves that pair through Pi's `ModelRuntime`, checks that authentication exists, and starts the Pi session with the selected model. The backend therefore already has explicit per-run model selection. What is missing is a safe product surface around that mechanism.

SEPT supplies the production guarantees around Pi: durable lifecycle state, drain, cancellation, restart recovery, bounded conversation output, wait/wake behavior, adaptive context cycling, workspace policy, Pod identity, and control-plane contracts.

### Delivered Node-MVP model-access surface

Part 2 exposes Pi's existing capabilities coherently:

1. A sanitized provider/model catalog with availability and capability metadata.
2. A local `sept auth` flow for Pi login, logout, and status, plus authenticated credential-blind Node catalogue/status metadata. Secret login is deliberately not exposed over the current plain HTTP listener.
3. Pi credential storage, environment interpolation, customer secret mounts, and intentional credential commands for headless operation.
4. Pi subscription/OAuth login interactions surfaced through the CLI and reusable service contract for a later dashboard adapter.
5. Explicit Pod defaults and per-run provider/model overrides, preflighted before acceptance and persisted in manifests.
6. Local/custom-provider validation with explicit context-window and maximum-output metadata.

Multiple named credential profiles remain deferred because Pi's current `CredentialStore` contract stores one credential per provider. The cloud may learn that a credential profile is available, but never its secret. Initial credential setup should occur directly on the Node. A future remote dashboard can either open a Node-local setup flow or use end-to-end encryption to the paired Node; SEPT Cloud must not receive plaintext credentials.

Examples:

- **Codex model access**: the user completes Pi's ChatGPT Plus/Pro Codex login on the Node, then selects an `openai-codex` model for the Pod or run.
- **Claude model access**: the user completes Pi's Claude Pro/Max login where supported or adds an Anthropic API key locally, then selects an Anthropic model.
- **Kimi, Google, OpenAI, or another API provider**: the user adds the corresponding key locally and selects a model Pi reports as available.
- **Local model**: the user configures the local endpoint and explicit model metadata; Pi executes through its compatible provider adapter.

This is provider/model selection, not sophisticated automatic routing. Cost-based routing, fallback chains, load balancing, and policy-driven model choice would be separate SEPT features and are not required for the first production Node.

### ACP supplies optional client interoperability

An ACP server would allow ACP-compatible clients such as editors and IDEs to use SEPT through a standard session protocol. It would translate session creation, prompting, streaming, replay, and cancellation into SEPT's existing run lifecycle.

ACP does **not** provide:

- Model routing or provider selection.
- API-key or subscription login.
- Local-model support.
- Agent execution.
- Durable state or restart recovery.
- The SEPT dashboard or remote control plane.

ACP is therefore not required for the core product vision. It is valuable only if SEPT must launch as an agent inside ACP clients or provide a public interoperability surface. The recommendation is to defer the ACP server until there is a concrete client requirement, rather than making it a mandatory Node-MVP deliverable.

Running the complete Claude Code or Codex CLI harness is also distinct from using Claude or Codex models through Pi. Those products own their own agent loops, tools, prompts, and credentials. If SEPT later needs to supervise them as complete external agents, it should add a bounded external-agent adapter and let each harness perform its own Node-local authentication. SEPT should not scrape or repurpose another product's credentials.

## Phased product plan

### Phase 1: complete the production Node

Delivered as Parts 1 and 2:

- Existing Part 1 lifecycle and conversational guarantees.
- Adaptive model-neutral context cycling.
- Pi-backed provider/model catalog and explicit run selection.
- Local API-key, subscription/OAuth, and credential-status surfaces.
- Local/custom-model configuration and metadata validation.
- Credential isolation suitable for local and container operation.
- Installed CLI, worker, Pi, restart, failure, and container verification.

**Delivered:** a durable Pi-native Pod that can use customer-owned subscription access, API keys, or compatible local models without SEPT Cloud. Installed CLI, authenticated worker, production Pi session/runtime, and container evidence are recorded in the Part 1 and Part 2 reports.

ACP is an optional interoperability addition to this phase only if a named launch client requires it.

### Phase 2: package the Node

- Versioned native package and container image.
- Explicit configuration, workspace, credential, and persistent-state boundaries.
- Simple install, authenticate, start, stop, diagnose, and upgrade workflows.
- Stable health, readiness, identity, and capability reporting.
- The same package from an individual machine to a private server.

**Deliverable:** the shippable local runtime package.

### Phase 3: build the local orchestration workspace

- A local desktop or web dashboard connected directly to the Node API.
- Agent conversation and live output as the primary visual surface.
- Run creation, model selection, Pod assignment, cancellation, drain, retry, resume, and inspection.
- Context pressure, handovers, failures, recovery, tool activity, and Pod state.
- A carefully permissioned terminal or command workspace where it materially improves operation.

**Deliverable:** a real agent workspace and local user control plane, not a passive status dashboard.

### Phase 4: add remote coordination and the thin SEPT Cloud API

- Accounts, organisations, authentication, and access validation.
- Billing, trials, plans, and entitlements.
- Node registration, pairing, discovery, and capability metadata.
- An outbound authenticated Node connection for remote commands and bounded status.
- Remote dashboard access without cloud-held provider credentials or mandatory inbound SSH.
- Policy-controlled transcript relay only where explicitly enabled.

**Deliverable:** remote control of customer-hosted Pods while execution authority and secrets remain customer-side.

### Phase 5: complete the commercial control plane

- Unified local, desktop, and remote dashboard modes.
- Team roles, permissions, audit history, and enterprise administration.
- Pod, concurrency, seat, and plan enforcement as entitlements rather than different runtime builds.
- Free-trial and paid-product journeys.
- Optional enterprise-private control-plane arrangements.

**Deliverable:** the complete subscription product built around the same customer-side Node.

## Recorded design questions

These are questions for their relevant phase, not blockers for the current decision:

- Does each Pod connect independently to the control plane, or does a host-level supervisor manage multiple Pod containers?
- Is credential onboarding always Node-local, or should a later remote dashboard support end-to-end encrypted delivery to a paired Node?
- Is transcript data local-only by default, with cloud relay and retention separately opt-in?
- How should a remote terminal be authorized, isolated, audited, and disabled when unnecessary?
- Should commercial entitlements measure Pods, active concurrency, seats, or a combination?
- Which concrete client demand would justify adding the ACP server?
- Which complete external agent harnesses, if any, deserve a future supervised-execution adapter?

## Commercial alignment

The proposed market position remains coherent: private customer-side execution, customer-supplied model access, durable workers, and a paid runtime/control plane. The pricing figures are hypotheses rather than runtime architecture. Plan and trial controls belong in cloud entitlements, while every tier should run the same Node package.
