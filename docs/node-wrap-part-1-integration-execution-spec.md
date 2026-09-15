# Node Wrap Part 1: Integration and Event Plane Execution Specification

## Status and authority

This document specifies the first of three sequential deliverables that complete the generalized SEPT Node foundation. It is an implementation specification, not approval to begin implementation by itself.

The sequence is:

1. **Part 1 — Integration and event plane:** this document.
2. **Part 1.5 — Capability and filesystem boundary:** `docs/node-wrap-part-1-5-capability-execution-spec.md`.
3. **Part 2 — Local communication and supervision:** `docs/node-wrap-part-2-supervision-execution-spec.md`.

Part 1 may establish capability-policy interfaces needed by Part 1.5, but it must not implement a competing sandbox. Part 1 is not distributable on its own; Part 1.5 must close the execution boundary before the complete Node foundation is considered shippable.

The existing Part 1 and Part 2 reports remain authoritative for the already-delivered lifecycle, conversation, model-access, and adaptive-rollover behavior. This specification extends that runtime without weakening those guarantees.

### Open discussion before implementation: trigger transport

The trigger/event mechanism is intentionally **not fully locked yet** and must be resolved in the next architecture discussion before Part 1 implementation begins.

The current preferred direction is that a local-first SEPT Pod should not require a public URL on the user's device. Its primary trigger path should instead be an integration-owned outbound subscription or observation process, selected according to the provider's supported interface: streaming, long polling, cursor-based polling, pull subscription, scheduled API query, or a trusted local watcher. That process runs independently of Pi, deterministically detects and normalizes configured events, submits them through the Pod's durable local event-admission seam, and advances any provider cursor only after local acceptance. The associated MCP connector then lets the awakened agent fetch additional detail and perform authorized actions.

Under this direction, `POST /v1/events` remains an internal loopback or IPC admission boundary rather than a public internet endpoint. Generic and provider-native webhooks remain possible optional transports for server-hosted Pods, explicitly advanced deployments, trusted local producers, or providers for which no viable outbound/pull mechanism exists. An automatic ngrok-style tunnel, SEPT-hosted relay, mandatory public endpoint, or user-configured networking dependency is **not** approved by this document.

The follow-up discussion must decide the supported initial trigger transports and revise the descriptor contract, implementation sequence, installed-runtime acceptance cases, and webhook terminology accordingly. Until that decision is recorded, all webhook-specific requirements below should be read as provisional transport details, not as a mandate that ordinary desktop Pods expose an inbound public webhook receiver.

## Product outcome

After this part, one SEPT Pod is a persistent, general-purpose agent with:

- one stable identity and standing role;
- one Pi-backed execution lane;
- deterministic trigger bindings;
- a durable Pod-level event inbox;
- locally discovered, explicitly authorized connectors;
- MCP tools exposed through Pi only when the connector is eligible for that Pod; and
- create, wake, queue, restart, cancellation, and deduplication behavior that does not require an integration to know SEPT run IDs.

The target user is initially a technically capable operator who understands the workflow they want to automate. SEPT supplies the safe runtime and composable primitives; it does not prescribe whether the agent performs engineering, monitoring, research, support, content, administration, social-media, or another kind of work.

## Mandatory invariants

1. **One agent per Pod.** The control plane selects a destination Pod. SEPT has no internal multi-agent router in this part.
2. **Pi remains the agent runtime.** SEPT does not recreate model clients, authentication, sessions, tool-loop execution, steering, cancellation, or context management already owned by Pi.
3. **The event admission controller chooses lifecycle behavior only.** It creates a run, wakes the resident run, or queues the event according to the binding and Pod state.
4. **Provider-specific detection is deterministic.** An LLM does not decide what constitutes a Gmail message, Sentry regression, Telegram message, scheduled occurrence, or log alert.
5. **Discovery is not authority.** A discovered connector is unusable until the operator grants it, required identity is satisfied, its probe succeeds, and the Pod policy includes it.
6. **An agent cannot self-install, self-grant, reconfigure, reconnect, or revoke connectors or triggers.** Those are control-plane operations outside the agent tool surface.
7. **External actions are connector-bounded.** General web research, Google/search access, browser automation, social-media access, and similar capabilities are permitted when surfaced as explicitly authorized connectors; they are not an implicit raw-network escape.
8. **Secrets remain local and out of agent-visible state.** Secret values never enter prompts, run manifests, conversations, event receipts, logs, telemetry, connector dossiers, API responses, or cloud-facing metadata.
9. **Inbound content is untrusted data.** Email bodies, issue descriptions, chat messages, logs, and webhook fields cannot amend the standing role, grants, or control protocol.
10. **Existing durability remains intact.** Single-slot ownership, drain, cancellation, wait/wake, restart adoption, rollover, handover ordering, limits, and graceful shutdown must not regress.
11. **Wired installed behavior is the completion metric.** Catalog parsing, isolated bridge tests, or dormant APIs do not constitute completion.

## Terminology and ownership

### Pod profile

A durable operator-owned definition for the one agent in a Pod. It contains no secrets and is not writable through agent tools.

Required fields:

- `formatVersion`
- `podId`: stable bounded identifier
- `displayName`: user-facing name
- `instructions`: standing role and behavioral instructions
- `defaultObjective`: optional standing objective used when a binding does not provide a narrower objective
- `deliveryMode`: `episodic` or `continuous`, governing every enabled binding in this single-slot Pod
- Pi provider/model/thinking defaults, referring to the existing model-access surface
- execution limits using the existing invocation, epoch, and active-time semantics
- connector policy
- filesystem/capability policy reference reserved for Part 1.5

The profile is the stable agent identity. A run is one durable execution of work by that agent. The current task-level `role` remains readable for migration but is no longer the primary identity mechanism for new Pod-event runs.

### Integration descriptor

A versioned, non-secret definition of one integration package. A package may expose:

- zero or more trigger types;
- zero or more MCP tools through one connector transport; or
- both triggers and MCP tools.

Trigger and tool capability are separate contracts even when bundled in one integration. The trigger side remains available while Pi is asleep; the MCP side becomes callable only while Pi is executing.

### Trigger binding

An operator-owned, versioned instance connecting one integration trigger to the current Pod. It records the exact event selection, deterministic filter, delivery behavior, and fixed objective.

### Connector definition

A non-secret MCP server definition, declared requirements, provenance, version, and transport. It does not imply installation trust, authorization, valid credentials, or live connectivity.

### Connector grant

The operator's decision that a connector may be considered for this Pod. A grant does not make the connector callable until identity and verification also succeed.

### Canonical Pod event

The bounded, normalized, provider-neutral event submitted to the Pod by a trigger adapter. The destination is implicit because the request reaches one Pod.

## Integration descriptor contract

Every integration descriptor must be strictly decoded and versioned. At minimum it contains:

```json
{
  "formatVersion": 1,
  "integrationId": "sentry",
  "integrationVersion": "1.0.0",
  "displayName": "Sentry",
  "description": "Error and performance monitoring",
  "origin": "sept|local|imported|registry",
  "publisher": "bounded display value",
  "triggers": [],
  "connector": null
}
```

Each trigger declaration contains:

- stable `triggerId`;
- display name and bounded description;
- supported `eventTypes`;
- JSON Schema for setup/configuration fields;
- JSON Schema for deterministic filters;
- JSON Schema for the normalized event attributes produced by the adapter;
- supported delivery modes;
- required companion connector IDs, which may be empty for a self-contained trigger;
- declared secret requirement names, never values; and
- adapter protocol/version needed to operate the trigger.

The optional connector declaration contains:

- stable `connectorId`;
- MCP transport kind and non-secret transport definition;
- declared authentication model;
- declared identity requirements by name and secret classification;
- package/version/content-hash provenance;
- capability summary for the future control plane; and
- probe requirements.

Unknown fields, unsupported versions, duplicate IDs, malformed schemas, inline secret-looking values, unsafe commands, and unsafe public plaintext URLs fail closed.

The backend returns these descriptors to the future control plane. The frontend renders forms and selectors from the descriptor schemas; it does not carry a second handwritten interpretation of each provider.

## Trigger binding contract

A binding is written only through the control surface and strictly validated against its descriptor:

```json
{
  "formatVersion": 1,
  "bindingId": "sentry-production-errors",
  "integrationId": "sentry",
  "integrationVersion": "1.0.0",
  "triggerId": "issue",
  "eventTypes": ["issue.created", "issue.regressed"],
  "filter": {
    "projects": ["api"],
    "minimumLevel": "error"
  },
  "deliveryMode": "episodic",
  "objective": "Investigate the supplied issue and complete the configured response.",
  "requiredConnectorIds": ["sentry"],
  "enabled": true
}
```

Rules:

1. `integrationId`, `integrationVersion`, and `triggerId` must resolve to one installed descriptor.
2. `eventTypes` must be a non-empty subset of the descriptor's supported types.
3. `filter` must validate against the descriptor's filter schema. Filtering uses deterministic adapter code or the bounded generic filter language below, never an LLM. The Pod re-evaluates the declared filter against the normalized event at its trust boundary rather than trusting an adapter's claim that the event matched.
4. `objective` is fixed operator instruction. Event data is inserted separately as untrusted structured input and is never interpolated into the system/standing-instruction section.
5. `deliveryMode` must be supported by the trigger and equal the Pod profile's delivery mode. A Pod does not mix episodic and continuous bindings; changing mode requires no active or waiting run and revalidation of every enabled binding.
6. `requiredConnectorIds` is copied from the resolved descriptor version and cannot be weakened by the caller. A binding may be saved disabled before its dependencies are ready, but initial enablement requires every companion connector to be installed, granted, included by Pod policy, and successfully connected.
7. Disabling or deleting a binding prevents new events from being accepted under it but does not rewrite existing run history.
8. Bindings are ordered and identified explicitly; filesystem order or object-key order never decides precedence.

### Generic webhook filter

The generic webhook integration may expose a small declarative filter and mapping surface for providers without a native adapter. The initial language is deliberately limited to:

- JSON Pointer field selection;
- `exists`;
- `equals` and `not_equals` for bounded scalar values;
- `in` for bounded scalar lists;
- numeric `greater_than_or_equal` and `less_than_or_equal`;
- bounded string `contains`;
- explicit `all` and `any` groups with nesting limits; and
- mapping selected fields to declared normalized attributes or opaque references.

It must not execute JavaScript, shell, templates, regular expressions with unbounded evaluation, or arbitrary expressions. A binding must support a sample-event validation/replay operation before enablement. Native adapters remain preferred for common providers.

## Canonical Pod event contract

The new Pod-level ingress is `POST /v1/events`. It accepts a strict versioned body:

```json
{
  "formatVersion": 1,
  "bindingId": "sentry-production-errors",
  "eventId": "provider-stable-id",
  "eventType": "issue.regressed",
  "occurredAt": "ISO-8601 timestamp",
  "subject": "bounded optional summary",
  "attributes": {},
  "references": [
    { "kind": "sentry_issue", "id": "opaque-provider-id" }
  ]
}
```

Rules:

- `bindingId` resolves the trusted integration identity, schema, filter, delivery mode, and objective. The sender cannot redefine them in the event.
- `(bindingId, eventId)` is the durable idempotency key.
- Reuse of that key with non-identical canonical content is a collision and returns `409` without routing the conflicting content.
- The event type and attributes validate against the installed descriptor version named by the binding.
- The Pod deterministically evaluates the binding filter. A non-matching event is rejected as non-routable without creating a receipt, queue item, or run.
- The server authenticates before reading the body and applies strict byte, depth, field-count, collection-count, string, and total normalized-size limits.
- The adapter verifies provider signatures, OAuth identity, polling cursor, or local source authenticity before submitting the event. SEPT's bearer authentication authenticates the adapter to the Pod; it does not replace provider-signature verification.
- Raw provider bodies are not persisted by the Pod. Only the bounded normalized event and opaque references required for execution are durable.
- Sensitive detail should be fetched through the authorized connector by reference when the agent begins work.
- Event contents are never written to operational logs or telemetry.

The current `POST /v1/webhooks` version-1 `task` and `operator_message` forms remain available for compatibility during migration. New integration adapters use `/v1/events`; they never choose between task and operator-message forms and never supply a run ID.

## Pod event admission semantics

The event admission controller is the only component that maps a valid accepted event onto the run lifecycle.

### Continuous delivery

- **Idle:** create a new run from the Pod profile and binding objective, attach the event, and start Pi.
- **Active:** append the event to the resident run's durable input queue. It is delivered at the existing safe input seam without starting a second controller.
- **Waiting:** fsync the queued event, change the resident run to active, and reopen the same Pi session.
- **Terminal previous run:** create a fresh run for the new event.

### Episodic delivery

- Every accepted event represents one logical run.
- **Idle:** create and start its run immediately.
- **Active or waiting:** append the event to the bounded durable Pod pending-event queue without altering the resident run.
- After the resident run becomes terminal and releases the slot, the oldest eligible pending event is atomically claimed and creates the next run.
- A waiting episodic run retains its slot because it is still awaiting task-specific input. New unrelated episodic events remain queued rather than contaminating its session.

### Common behavior

- Queue persistence precedes successful acknowledgement.
- If a required companion connector becomes unavailable after binding enablement, matching events remain durably accepted but are marked dependency-waiting and are not delivered to Pi until eligibility returns. Reconnection wakes queue processing. Disabling or revoking the binding requires explicit operator disposition of its already accepted events rather than silently dropping them.
- Admission and queue claim are crash-recoverable and idempotent.
- Active delivery retains the current at-least-once input proof rules.
- Queue limits apply by event count and normalized bytes. Saturation returns `429` before persistence.
- Drain rejects new events while allowing already accepted events to settle according to existing drain semantics.
- Cancellation applies to a run, not unrelated queued episodic events. The control surface may remove a queued event explicitly before it becomes a run; removal is durable and auditable.
- Graceful shutdown stops admission, settles the active safe seam, and leaves accepted events recoverable.
- Restart reconciles pending receipt claims, queued events, active delivery, and interrupted wake exactly once without duplicate Pi invocation.

## Connector discovery and import

Discovery is an operator-initiated, read-only process. It may inspect only configured sources; it must not crawl the user's home directory or silently adopt arbitrary executable definitions.

Initial discovery sources:

1. SEPT's managed integration catalog.
2. An explicitly selected MCP JSON/configuration file or directory.
3. Explicitly enabled importers for common local MCP configuration formats.
4. A future configured registry source behind the same catalog interface.

Discovery produces sanitized candidates containing identity, origin, version, transport type, declared requirements, and a content hash. It never returns credential values or automatically executes a server.

Import rules:

- Local definitions override registry definitions only through an explicit, visible precedence rule.
- ID collisions with different content hashes require operator resolution.
- Existing environment references may remain references.
- Existing connector-owned authentication caches may be used by that connector if its probe succeeds, but SEPT does not copy or scrape those credentials.
- Inline credentials in imported definitions are rejected or require an explicit secure migration flow; they are never copied into the normal catalog.
- Imported executable commands remain inactive until explicit grant and probe.

The discovery lever belongs to SEPT's MCP subsystem, not to the running agent. The future frontend can expose “discover existing connectors,” show the sanitized candidates, and let the user select which definitions to import and grant.

## Connector authorization and identity lifecycle

Required durable lifecycle states:

```text
discovered
  → granted
  → awaiting_credentials (when required)
  → verifying
  → connected
  → degraded or failed
  → verifying on explicit recheck/recovery
  → revoked
```

Required transitions and rules:

- Discovery records reference data and provenance only.
- Grant is an operator action and contains no credential value.
- Missing declared requirements produce `awaiting_credentials` with names only.
- Satisfied identity initiates one probe per connector at a time.
- Successful protocol initialization and capability proof produce `connected` with bounded proof metadata and time.
- Transport or authentication failure records a sanitized bounded reason and produces `failed` or `degraded` without echoing remote text blindly.
- Boot reconciliation re-drives granted connectors that were interrupted in awaiting, verifying, connected, degraded, or failed states.
- Revocation immediately removes the connector from Pod eligibility, prevents new calls, cancels or invalidates an in-flight call according to the cancellation contract, closes its transport, and removes SEPT-owned credential material.
- The agent cannot cause a grant transition through MCP output, prompt text, tool return data, or filesystem changes.

### Authentication models

The lifecycle must account for:

- no authentication;
- environment or customer secret-mount references;
- SEPT-local secret storage;
- connector-managed existing local authentication;
- browser/OAuth authorization with a Node-local callback; and
- future OS-keychain-backed storage through a pluggable secret-store interface.

Only requirement names and credential-presence state appear in ordinary state and API projections.

Part 1 must implement the secret-store and OAuth/service abstractions, but it must not add a secret-bearing route to the current plain TCP listener. Before the desktop control plane exists, authenticated connectors may use environment/keychain references, secret mounts, or connector-managed local authorization. A later desktop adapter may invoke the same service over trusted local IPC or a Node-local browser flow without sending plaintext secrets through SEPT Cloud.

## Pod connector policy

The profile stores one of:

```json
{ "mode": "none" }
```

```json
{ "mode": "allow_only", "connectorIds": ["sentry", "github"] }
```

```json
{ "mode": "all" }
```

Effective eligibility is always:

```text
installed definition
∩ explicit operator grant
∩ satisfied identity
∩ verified connected state
∩ current Pod connector policy
```

`all` means every otherwise eligible connector currently assigned to this Pod. It is an explicit advanced selection, not a default and not permission to consume newly discovered-but-ungranted definitions.

The run manifest records the eligible connector IDs and descriptor versions used at admission for reproducibility. A live revocation overrides that snapshot immediately. An expansion applies only at a controlled tool/session boundary; connectors do not appear halfway through an atomic model/tool batch.

## Native MCP-to-Pi bridge

### Required transports

The initial bridge must support the standard MCP transports needed for real local use:

- stdio; and
- streamable HTTP.

Legacy SSE may be supported when required by an accepted connector fixture. Arbitrary WebSocket protocols are outside the initial bridge unless implemented by the selected MCP client library as a standard compatible transport.

### Session construction

For each eligible connector, SEPT:

1. resolves its non-secret transport definition;
2. resolves only that connector's credential requirements;
3. starts or connects to the MCP server without placing connector secrets into Pi prompts or general process environment;
4. performs MCP initialization and version/capability negotiation;
5. calls `tools/list`;
6. validates and bounds every returned tool name, description, and input schema;
7. maps each tool to a Pi `ToolDefinition`; and
8. supplies the resulting definitions through Pi's existing `customTools` seam.

Tool names are deterministic and collision-safe:

```text
mcp__<connector-id>__<tool-name>
```

Invalid identifiers, duplicate normalized names, unsupported schemas, or a tool-count/description/schema-size limit violation keep the connector out of the Pi tool surface and mark the connection degraded with a bounded reason.

### Tool-call enforcement

Every generated Pi tool wrapper must, at call time:

- recheck that the connector remains granted, connected, and permitted by the Pod policy;
- validate input against the captured MCP schema;
- propagate Pi's abort signal to the MCP request;
- apply a bounded timeout;
- cap incremental and final output size;
- treat MCP content as untrusted tool output;
- redact known credential values from all bounded errors before persistence;
- avoid persisting tool arguments or raw results to SEPT logs, telemetry, or conversation; and
- record only bounded connector ID, tool name, duration class, and success/cancel/failure outcome for operations.

A connector `tools/list_changed` notification may refresh the cached inventory only at a safe session/tool boundary. It must never inject a new tool into an in-progress atomic batch.

### Transport isolation seam

Part 1 must route stdio process creation and remote transport creation through an explicit execution-policy dependency owned by Part 1.5. It must not scatter direct `spawn` or unrestricted filesystem/network behavior through the bridge.

Until Part 1.5 is complete, the bridge is development-only and the combined Node is not distributable. Part 1.5 will decide the mounts, environment, shell/network policy, and lifecycle of connector processes without changing the connector lifecycle or Pi mapping defined here.

## Prompt and agent-language generalization

All new Pod-event runs use neutral prompts:

- SEPT is a durable Pi-backed agent runtime, not inherently a coding worker.
- The profile contains the standing role.
- The binding contains the triggering objective.
- The canonical event is clearly delimited as untrusted data.
- The agent uses only the tools and resources present in its actual Pi tool surface.
- Completion means the configured objective is fulfilled and verified, not necessarily that code was written.
- Workspace instructions such as `AGENTS.md` remain applicable when the assigned workspace uses them, but are not presented as a universal assumption about all work.

Existing repository/coding tasks must continue to work through the same generalized prompt and explicitly granted file/shell surface.

## Control-plane-ready service surface

Part 1 supplies UI-neutral service methods and authenticated, credential-blind HTTP projections for:

- get/update the Pod profile;
- list integration descriptors and view one sanitized descriptor;
- run explicit connector discovery and view sanitized candidates;
- import a selected non-secret connector definition;
- list connector lifecycle state and view one dossier;
- grant, revoke, and recheck a connector;
- get/update the Pod connector policy;
- list/create/update/enable/disable/delete trigger bindings;
- validate a binding and sample normalized event without enabling it;
- submit a canonical Pod event;
- inspect bounded pending-event state; and
- cancel a queued event before claim.

The exact HTTP routes must use strict request schemas, authentication-before-body-read, `Cache-Control: no-store`, bounded pagination, and the existing safe-error posture. Secret submission and OAuth callbacks use the local credential-service abstraction rather than the ordinary plain HTTP control listener.

The future frontend must be able to render every connector, trigger, binding, lifecycle state, and policy from these projections without reading durable files directly.

## Persistence and recovery

Part 1 uses versioned, atomic, access-restricted local records consistent with the existing single-writer Node:

- Pod profile;
- installed integration catalog and descriptor provenance;
- trigger bindings;
- connector lifecycle and grants;
- connector secret store or opaque keychain references;
- connector probe evidence;
- pending episodic events;
- per-run continuous event delivery;
- event receipts and claim state; and
- catalog/import reconciliation evidence.

Raw provider webhook bodies and secret values are excluded from receipts and ordinary lifecycle evidence.

Startup must refuse malformed present configuration rather than silently resetting it. Absent new files receive documented safe defaults: neutral empty profile additions, no trigger bindings, no connector grants, connector policy `none`, and an empty event queue.

Run creation remains atomic. An event receipt must never report completion unless the event is durably queued or its run is durably created. Interrupted pending receipt claims are reconciled from durable queue/run evidence.

## Security and observability

- Bind loopback by default and retain bearer authentication for the current control listener.
- Provider-facing adapters verify provider-specific authenticity before normalization.
- Apply replay protection through stable event IDs and bounded acceptance windows where the provider supports timestamps.
- Never record bearer headers, webhook signatures, OAuth codes, tokens, cookies, connector environment values, raw webhook bodies, MCP arguments, MCP results, prompts, or event attributes in operational telemetry.
- Connector/process errors are capped, sanitized, and classified before persistence.
- Metrics use bounded labels only: lifecycle state, transport kind, delivery mode, and success/cancel/failure classes.
- Agent-facing text cannot grant authority or alter the profile, binding, connector state, or filesystem policy.
- Connector installation is executable-code installation. Local/imported definitions display origin, command/endpoint, requirements, and content hash before grant.

## Required implementation sequence

The implementation agent must work in this order and keep each step wired:

1. Add strict types/codecs and versioned storage for the Pod profile, descriptors, bindings, connector policy, canonical events, and pending-event state.
2. Generalize prompts and move standing identity from per-event free text to the Pod profile while preserving legacy task compatibility.
3. Implement descriptor-backed binding validation and deterministic generic-webhook filtering/mapping.
4. Introduce `POST /v1/events`, durable receipts, and the Pod event admission controller.
5. Implement continuous create/wake/queue and episodic create/pending-queue/claim behavior with restart, drain, cancellation, and shutdown reconciliation.
6. Implement explicit connector discovery/import and sanitized control-plane projections.
7. Implement connector grants, local identity abstraction, probe lifecycle, boot reconciliation, and revocation.
8. Implement stdio and streamable-HTTP MCP clients through the transport-isolation seam.
9. Discover MCP tools, translate them into Pi `ToolDefinition`s, and enforce call-time eligibility/cancellation/output controls.
10. Wire connector policy, descriptor versions, and tool inventory into real production `PiSessionHost` creation and replacement.
11. Add the complete authenticated service surface and documentation.
12. Exercise the exact installed CLI/service/container paths and complete the acceptance audit below.

Later steps may refine earlier types, but the implementation must remain one coherent runtime path. No alternate agent loop, duplicate event runner, or dormant connector subsystem is acceptable.

## Required verification

### Trigger and event acceptance

- Native descriptor and generic-webhook fixtures validate deterministically.
- Malformed descriptor, binding, filter, normalized event, version, and unknown-field cases fail closed.
- Binding enablement refuses missing, ungranted, policy-excluded, or unverified required connectors; later connector degradation dependency-waits rather than losing an accepted event.
- The Pod repeats deterministic filter evaluation and rejects a normalized event that does not actually match its binding.
- A real installed Pod receives an event while idle and creates a run using the profile and binding.
- A continuous event received while waiting wakes the same Pi session without a caller-supplied run ID.
- A continuous event received while active is durably delivered at the next safe seam.
- Episodic events received while busy are queued FIFO and create distinct later runs.
- Queue count/byte saturation returns `429` without partial persistence.
- Identical retries deduplicate; key collisions return `409`.
- Restart tests cover receipt/queue/run-creation, active-delivery, waiting-wake, and queue-claim crash seams.
- Drain, cancellation, rollover, terminal races, and graceful shutdown preserve existing behavior.
- Raw webhook data and normalized attributes do not appear in operational logs or telemetry.

### Connector acceptance

- Explicit discovery finds a sanitized existing MCP definition without executing or granting it.
- Import rejects inline secrets, unsafe public plaintext transport, malformed specs, and ID/hash collisions.
- Grant with no identity requirement proceeds to one probe.
- Missing credentials remain awaiting with names only.
- Environment/keychain/secret-store and connector-managed authentication paths are covered without leaking values.
- Probe success, failure, degradation, recheck, revocation, and restart reconciliation are deterministic.
- Connector policy `none`, `allow_only`, and `all` produce the exact eligible set.
- At least one real local stdio MCP server and one streamable-HTTP fixture complete initialize, `tools/list`, and `tools/call` through the installed bridge.
- A real production `PiSessionHost` receives the generated tool and a deterministic Pi-backed model invokes it successfully.
- Pi cancellation reaches an active MCP call.
- Revocation prevents a later call and safely terminates or invalidates an in-flight call.
- Tool/schema/output limits fail closed without corrupting the Pi session or durable run.
- No connector credential appears in process-wide Pi environment, prompt, manifest, state, conversation, log, telemetry, error, or response fixtures.

### Full regression and installed paths

- `npm run check` passes.
- The complete test suite passes with no regressions.
- `npm audit` and `npm audit --omit=dev` pass under the repository's vulnerability policy.
- `git diff --check` passes.
- A high-confidence secret scan covers every intentionally changed text file and generated acceptance output.
- A no-cache production image builds successfully.
- The built image exercises descriptor listing, connector lifecycle, real MCP tool use through Pi, idle event admission, waiting wake, active queueing, restart recovery, authenticated reads, and fail-closed unauthenticated access through the installed entry point.

## Explicit non-goals

- No dashboard or drag-and-drop UI.
- No remote or cross-device communication.
- No supervisor hierarchy.
- No cloud account, billing, or entitlement service.
- No agent-authored code executing directly from its live Pod workspace.
- No automatic grant based on LLM output.
- No mandatory public connector registry or ranking engine.
- No unrestricted raw network/browser/shell capability disguised as a connector.
- No replacement of Pi's agent/model/session runtime.
- No ACP or complete external-agent harness.

## Completion gate

Part 1 is complete only when the installed Node and built container can receive a descriptor-valid event, durably select create/wake/queue behavior without a run ID, expose only operator-authorized verified MCP tools to the production Pi session, execute a real MCP call, preserve all existing lifecycle guarantees, recover across restart, and demonstrate that credentials and unsafe payloads remain outside every public and operational surface.

Code that is not reached through that exact installed path must be wired and exercised or removed.
