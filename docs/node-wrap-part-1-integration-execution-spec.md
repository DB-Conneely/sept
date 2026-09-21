# Node Wrap Part 1: MCP Connector and Generalized Trigger-Source Execution Specification

## Status and authority

This document specifies the first of three sequential deliverables that complete the generalized SEPT Node foundation. It is an implementation specification, not approval to begin implementation by itself.

The sequence is:

1. **Part 1 — MCP connector and generalized trigger-source plane:** this document.
2. **Part 1.5 — Capability and filesystem boundary:** `docs/node-wrap-part-1-5-capability-execution-spec.md`.
3. **Part 2 — Local communication and supervision:** `docs/node-wrap-part-2-supervision-execution-spec.md`.

Part 1 may establish capability-policy interfaces needed by Part 1.5, but it must not implement a competing sandbox. Part 1 is not distributable on its own; Part 1.5 must close the execution boundary before the complete Node foundation is considered shippable.

The existing Part 1 and Part 2 reports remain authoritative for the already-delivered lifecycle, conversation, model-access, and adaptive-rollover behavior. This specification extends that runtime without weakening those guarantees.

### Locked architecture and mandatory delivery order

Part 1 is split into two ordered tranches:

1. **MCP connector plane.** Deliver discovery, import, authorization, identity, probe lifecycle, policy, MCP transport, tool translation, Pi wiring, cancellation, revocation, recovery, and installed-runtime proof as one coherent connector implementation.
2. **Generalized trigger-source and event plane.** After the MCP connector verification milestone passes, continue directly into descriptor-driven outbound trigger sources, durable checkpoints, deterministic filtering, event admission, and create/wake/queue behavior.

The implementation agent must not begin trigger-source production work while the MCP connector plane is incomplete or exercised only through isolated bridge tests. The first verification milestone requires an installed worker and production `PiSessionHost` to discover an explicitly granted connector, expose its bounded MCP tool, invoke it through Pi, propagate cancellation, survive restart, and revoke it cleanly. Once that evidence passes, the same installed SEPT worker continues immediately into the trigger-source tranche. This is not a user-approval pause, a worker handoff, a new task, or a reason to lose implementation momentum.

The trigger architecture is now locked. A local-first SEPT Pod uses a generalized, integration-owned **outbound trigger-source adapter**. The integration package hides whether that source uses streaming, long polling, cursor polling, pull subscriptions, scheduled API queries, MCP resource subscriptions, or trusted local observation. SEPT core supervises every source through one versioned protocol; it contains no provider-specific poller or event router. The source remains alive independently of Pi, so it can observe while the resident Pi session is absent or waiting.

The product unit is an integration package, not a transport setup exercise. A future control plane must be able to let the operator select or drag an integration onto a Pod, authorize it, choose a declared trigger, configure descriptor-backed deterministic filters, select delivery behavior, and enable it. Poll intervals, offsets, WebSocket URLs, subscription leases, provider acknowledgements, and reconnect rules are integration implementation details and are not ordinary user choices.

An ordinary local Pod requires no public URL, tunnel, inbound firewall rule, or SEPT-hosted relay. The initial trigger source communicates with the Pod over bounded local IPC and calls the same transport-independent event-admission service used by future trusted adapters. Part 1 does **not** add or extend a provider-facing webhook architecture or require a new public `POST /v1/events` route. The existing `POST /v1/webhooks` compatibility receiver remains unchanged and outside the Part 1 integration path. A future loopback, webhook, server-hosted, or relay transport may wrap the event-admission service as a separate mechanism, but dormant compatibility code is not trigger completion evidence.

### Implementation and review priorities

The worker and supervisor continuously assess both tranches against five priorities:

1. **Logical correctness.** Durable ordering, state transitions, idempotency, ownership, lifecycle behavior, failure recovery, and installed-path evidence must be explicit and internally consistent. A passing isolated test cannot excuse a broken production path.
2. **Code quality.** Keep one coherent runtime path, narrow module ownership, strict contracts, readable state machines, and tests that prove behavior rather than mirror implementation. Remove superseded or unwired code instead of maintaining parallel mechanisms.
3. **Security.** Treat provider data, MCP output, child-process output, imported definitions, and credentials as hostile or sensitive at the appropriate boundary. Fail closed, minimize authority, bound every input/output, preserve local secret isolation, and test revocation and cancellation races.
4. **Avoid overengineering.** Implement the smallest architecture that completely satisfies the approved contracts. Do not add speculative transports, provider abstractions, plugin frameworks, distributed coordination, generic expression engines, or future control-plane behavior. Prefer a direct versioned seam over a broad abstraction, and delete unused scaffolding.
5. **Scaling capacity.** Preserve the deliberately single-slot semantics of each Pod while avoiding designs that impose an artificial global bottleneck as connector, binding, event, or Pod counts grow. Keep resource use bounded and isolated per connector and binding; avoid unbounded queues, linear hot-path scans, process-wide mutable authority, and cross-Pod coupling; and retain a clean horizontal replication boundary for independently hosted Pods. Do not introduce distributed coordination or speculative scaling machinery without a present correctness requirement.

Correctness and security are never traded away for speed. Code quality means clarity and maintainability, not abstraction for its own sake. Scaling capacity means preserving bounded, composable runtime behavior, not prebuilding a distributed system. Verification is continuous. During each tranche, the supervisor reviews the worker's direction, diffs, wiring, and runtime evidence and maintains a bounded defect list containing only concrete findings under the five priorities above. Urgent security, data-loss, architectural-drift, compounding-quality, or scaling defects may receive one focused correction immediately; non-urgent findings are batched rather than interrupting momentum.

At the end of Tranche A, the supervisor gives the same worker one consolidated quality-pass list. The worker corrects every valid item, removes any superseded or dormant implementation, and reruns the complete Tranche A installed-path evidence before proceeding directly into Tranche B. An empty list is explicitly cleared. The same process occurs at the end of Tranche B before full Part 1 acceptance. These are internal quality passes, not user-approval stops, worker handoffs, separate tasks, or permission to redirect work for preferences outside the five priorities.

## Product outcome

After this part, one SEPT Pod is a persistent, general-purpose agent with:

- one stable identity and standing role;
- one Pi-backed execution lane;
- locally discovered, explicitly authorized connectors;
- MCP tools exposed through Pi only when the connector is eligible for that Pod;
- descriptor-driven integration packages that require no provider-specific SEPT core changes;
- independently supervised outbound trigger sources;
- deterministic trigger bindings and a durable Pod-level event inbox; and
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
9. **External content is untrusted data.** Email bodies, issue descriptions, chat messages, logs, provider events, and compatibility webhook fields cannot amend the standing role, grants, or control protocol.
10. **Existing durability remains intact.** Single-slot ownership, drain, cancellation, wait/wake, restart adoption, rollover, handover ordering, limits, and graceful shutdown must not regress.
11. **Wired installed behavior is the completion metric.** Catalog parsing, isolated bridge tests, or dormant APIs do not constitute completion.
12. **Integration transport is package-owned.** SEPT core supervises one trigger-source protocol and one MCP bridge; it does not acquire provider-specific polling, streaming, acknowledgement, or webhook branches.

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

### Trigger-source adapter

An immutable installed integration component that observes one provider or trusted local source through the provider-appropriate outbound mechanism. It implements SEPT's versioned trigger-source protocol, produces bounded canonical candidates, and performs provider acknowledgement or cursor advancement only after SEPT returns a durable settlement. It is not an agent, Pi tool, webhook receiver, or alternate task runner.

### Trigger-source checkpoint

A bounded, versioned, non-secret, core-owned record of the last durably settled position for one binding and adapter version. Its provider-specific cursor value is opaque to SEPT core but validates against the descriptor's checkpoint schema. It contains no raw provider event or credential.

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
- one `source` definition containing:
  - protocol name `sept-trigger-source` and protocol version `1`;
  - an immutable installed runtime reference and content hash;
  - an operational observation kind from `stream`, `long_poll`, `cursor_poll`, `pull_subscription`, `scheduled_query`, `mcp_subscription`, or `local_watch`;
  - a strict schema for the opaque non-secret checkpoint;
  - supported initial-position choices, normally `from_now`, `available_history`, or a provider-specific bounded choice rendered from schema;
  - declared provider acknowledgement/replay and cursor-expiry behavior;
  - declared offline-retention or gap-detection limitations for operator display; and
  - trigger-source protocol capabilities required by the adapter.

The optional connector declaration contains:

- stable `connectorId`;
- MCP transport kind and non-secret transport definition;
- declared authentication model;
- declared identity requirements by name and secret classification;
- package/version/content-hash provenance;
- capability summary for the future control plane; and
- probe requirements.

Unknown fields, unsupported versions, duplicate IDs, malformed schemas, inline secret-looking values, unsafe commands, and unsafe public plaintext URLs fail closed.

`observationKind` is operational metadata and is not a request for the operator to configure transport details. The backend returns these descriptors to the future control plane. The frontend renders integration cards, forms, trigger selectors, filters, and initial-position choices from the descriptor schemas; it does not carry a second handwritten interpretation of each provider.

## Tranche A — MCP connector plane

This tranche is implemented and verified before trigger-source production work begins. It must result in a usable connector subsystem even when no trigger is configured: a connector can be discovered, granted, authenticated, probed, allowed by Pod policy, projected into the production Pi tool surface, called, cancelled, recovered, and revoked.

### Connector discovery and import

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

### Connector authorization and identity lifecycle

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

#### Authentication models

The lifecycle must account for:

- no authentication;
- environment or customer secret-mount references;
- SEPT-local secret storage;
- connector-managed existing local authentication;
- browser/OAuth authorization with a Node-local callback; and
- future OS-keychain-backed storage through a pluggable secret-store interface.

Only requirement names and credential-presence state appear in ordinary state and API projections.

Part 1 must implement the secret-store and OAuth/service abstractions, but it must not add a secret-bearing route to the current plain TCP listener. Before the desktop control plane exists, authenticated connectors may use environment/keychain references, secret mounts, or connector-managed local authorization. A later desktop adapter may invoke the same service over trusted local IPC or a Node-local browser flow without sending plaintext secrets through SEPT Cloud.

### Pod connector policy

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

### Native MCP-to-Pi bridge

#### Required transports

The initial bridge must support the standard MCP transports needed for real local use:

- stdio; and
- streamable HTTP.

Legacy SSE may be supported when required by an accepted connector fixture. Arbitrary WebSocket protocols are outside the initial bridge unless implemented by the selected MCP client library as a standard compatible transport.

#### Session construction

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

#### Tool-call enforcement

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

#### Transport isolation seam

Part 1 must route stdio process creation and remote transport creation through an explicit execution-policy dependency owned by Part 1.5. It must not scatter direct `spawn` or unrestricted filesystem/network behavior through the bridge.

Until Part 1.5 is complete, the bridge is development-only and the combined Node is not distributable. Part 1.5 will decide the mounts, environment, shell/network policy, and lifecycle of connector processes without changing the connector lifecycle or Pi mapping defined here.

### Connector-plane verification milestone

Before any trigger-source production implementation begins, the installed `./sept worker` path and production `PiSessionHost` must prove all of the following in one wired path:

- discover or load a real MCP definition without executing it during discovery;
- explicitly grant it, satisfy its declared identity, probe it, and include it through Pod policy;
- initialize the MCP transport and validate `tools/list`;
- expose the generated `mcp__<connector-id>__<tool-name>` definition to Pi;
- make a deterministic Pi-backed invocation call the real MCP server and consume its bounded result;
- propagate cancellation into an active MCP request;
- restart and reconcile the connector without acquiring duplicate authority; and
- revoke it so the tool is absent or fails closed before any later call.

Passing compilation, codec tests, direct MCP client tests, or a tool wrapper invoked outside production Pi does not satisfy this milestone. When the complete installed-path evidence does satisfy it, the same worker continues immediately into Tranche B without an approval handshake.

## Tranche B — Generalized trigger-source and event plane

### Trigger binding contract

A binding is written only through the control surface and strictly validated against its descriptor:

```json
{
  "formatVersion": 1,
  "bindingId": "sentry-production-errors",
  "integrationId": "sentry",
  "integrationVersion": "1.0.0",
  "triggerId": "issue",
  "eventTypes": ["issue.created", "issue.regressed"],
  "startPosition": "from_now",
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
3. `startPosition` must be one choice declared by the trigger source. First enablement requires an explicit choice; neither SEPT nor the adapter silently discards existing provider history by assuming `from_now`.
4. `filter` must validate against the descriptor's filter schema and use the bounded shared filter language below, never an LLM or provider-specific SEPT-core code. If a provider needs richer source-side selection, its adapter normalizes the required fields and may narrow the provider subscription as an optimization, but the Pod still evaluates the complete configured filter against every candidate it receives.
5. `objective` is fixed operator instruction. Event data is inserted separately as untrusted structured input and is never interpolated into the system/standing-instruction section.
6. `deliveryMode` must be supported by the trigger and equal the Pod profile's delivery mode. A Pod does not mix episodic and continuous bindings; changing mode requires no active or waiting run and revalidation of every enabled binding.
7. `requiredConnectorIds` is copied from the resolved descriptor version and cannot be weakened by the caller. A binding may be saved disabled before its dependencies are ready, but initial enablement requires every companion connector to be installed, granted, included by Pod policy, and successfully connected.
8. Enablement pins the integration version, trigger-source protocol version, runtime content hash, and checkpoint schema version. An incompatible package update requires a declared checkpoint migration or an explicit recovery decision; it never resets a live cursor silently.
9. Disabling or deleting a binding stops observation and prevents new events from being accepted under it but does not rewrite its checkpoint, already accepted events, or run history.
10. Bindings are ordered and identified explicitly; filesystem order or object-key order never decides precedence.

#### Bounded deterministic filter

Any integration may expose this shared declarative filter surface instead of requiring provider-specific frontend or SEPT-core logic. The initial language is deliberately limited to:

- JSON Pointer field selection;
- `exists`;
- `equals` and `not_equals` for bounded scalar values;
- `in` for bounded scalar lists;
- numeric `greater_than_or_equal` and `less_than_or_equal`;
- bounded string `contains`;
- explicit `all` and `any` groups with nesting limits; and
- mapping selected fields to declared normalized attributes or opaque references.

It must not execute JavaScript, shell, templates, regular expressions with unbounded evaluation, or arbitrary expressions. A binding must support a sample normalized-event validation operation before enablement. Provider-specific adapters may normalize provider data, but they do not get final authority to decide that a binding matched.

### Canonical Pod event contract

The transport-independent Pod event-admission service accepts this strict versioned value from the supervised trigger-source boundary:

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
- Reuse of that key with non-identical canonical content is a collision failure and does not route the conflicting content. A future HTTP adapter may map this outcome to `409`.
- The event type and attributes validate against the installed descriptor version named by the binding.
- The Pod deterministically evaluates the binding filter. A non-matching event is rejected as non-routable without creating a receipt, queue item, or run.
- The trigger supervisor attaches the binding identity from the process it launched; an adapter cannot select another binding by writing a different `bindingId`.
- The IPC decoder applies strict message, byte, depth, field-count, collection-count, string, and total normalized-size limits before admission.
- The adapter establishes provider authenticity through its authorized provider connection, subscription identity, signed stream, or trusted local source before submitting the event. It receives no general SEPT bearer token.
- Raw provider bodies are not persisted by the Pod. Only the bounded normalized event and opaque references required for execution are durable.
- Sensitive detail should be fetched through the authorized connector by reference when the agent begins work.
- Event contents are never written to operational logs or telemetry.

The trigger source never chooses between task and operator-message forms and never supplies a run ID. Part 1 does not add a provider-facing event endpoint. The current `POST /v1/webhooks` version-1 `task` and `operator_message` forms remain unchanged as a separate compatibility mechanism and are not used by integration trigger sources or counted as Part 1 trigger evidence.

### Generalized outbound trigger-source runtime

#### Process and ownership model

The installed worker owns a `TriggerSupervisor` beside, not inside, `WorkerRuntime` or Pi. After the state-root lease, descriptors, bindings, connector dependencies, source checkpoints, and event-admission service are reconciled, the supervisor starts one logical trigger-source instance for each enabled binding. The initial implementation may use one child process per binding; any later multiplexing must preserve independent binding identity, checkpoint, backpressure, cancellation, and failure state.

Each child runs from the immutable runtime reference and content hash pinned by the binding. It remains available while the Pod is idle, Pi is executing, or a continuous run is waiting. It does not open a Pi session, call model APIs, choose lifecycle behavior, or invoke the companion MCP tools. Trigger and MCP components may belong to one integration package and use the same declared account identity, but they run through separate lifecycle and authority boundaries.

The launcher resolves trigger-specific credentials from the local secret/identity service and supplies them through the execution-policy seam, never in the protocol `initialize` message or process-wide Pi environment. Where a provider permits narrower observation and action identities, the descriptor declares them separately; sharing one provider credential is allowed only when the provider itself makes that unavoidable and the operator has granted the combined scope.

Provider transport selection is entirely adapter-owned. SEPT core does not contain provider names, provider endpoints, polling schedules, cursor interpretation, subscription lease logic, or acknowledgement branches. `observationKind` is used only for sanitized capability and health reporting.

#### Versioned local protocol

The initial source transport is bounded bidirectional stdio using strict newline-delimited JSON with protocol name `sept-trigger-source` and version `1`. Part 1.5 must later route process launch through the shared execution backend; no direct spawning may be scattered outside that seam.

The minimum exchange is:

1. SEPT sends `initialize` with the binding's non-secret, schema-validated source configuration, enabled event types, selected initial position, and the last core-owned checkpoint or `null`.
2. The adapter returns `ready` with its pinned integration identity and protocol capabilities. A mismatch fails before provider observation.
3. The adapter emits at most one unresolved `candidate` containing an ephemeral `deliveryId`, a bounded normalized event without caller-controlled Pod identity, and a proposed `checkpointAfter` conforming to the descriptor schema.
4. SEPT validates the candidate, attaches the known `bindingId`, evaluates the deterministic filter, and asks the event-admission service for a durable disposition.
5. SEPT returns `settle` only after the required event and checkpoint durability ordering below. The settlement is `admitted`, `duplicate`, or `filtered`.
6. Only after `settle` may the adapter acknowledge that delivery, advance the provider cursor, or request the next observation.

SEPT may send `retry` with a bounded delay class without settling the candidate, `pause` when drain or backpressure forbids progress, and `stop` during disablement, revocation, or shutdown. The adapter must stop a blocking poll, stream read, pull lease, or scheduled query on cancellation and return a bounded terminal acknowledgement. Unknown message types, duplicate unresolved delivery IDs, concurrent candidates, malformed checkpoints, output after stop, protocol flooding, and size-limit violations terminate and degrade the source without advancing it.

The adapter protocol carries no arbitrary command, executable update, secret value, raw provider body, Pi prompt, run ID, global bearer token, or MCP tool call. Adapter stderr is bounded and treated as untrusted diagnostic input; provider payloads and credentials must not be written there.

#### Durable settlement and checkpoint ordering

The source checkpoint is stored by SEPT core under the binding, not trusted to an adapter-owned working directory. At minimum it records format version, binding ID, integration/version/content hash, source protocol and checkpoint-schema versions, checkpoint generation, opaque bounded checkpoint value, last disposition class, and update time. It contains no raw event, event attributes, credential, provider response, or executable configuration.

For an admitted candidate, ordering is mandatory:

1. validate and deterministically filter the normalized candidate;
2. fsync the matching event receipt and the queue, run, or dependency-waiting state that constitutes local acceptance;
3. fsync the new source checkpoint referring to that settled candidate;
4. send `settle` to the adapter; and
5. let the adapter perform the provider acknowledgement or cursor-advancing operation.

For a non-matching candidate, SEPT creates no Pod event receipt, queue item, or run. It does, however, fsync a bounded `filtered` disposition with the source checkpoint before settlement, because a shared provider cursor cannot safely pass an irrelevant item without durable local proof that it was intentionally filtered.

For an identical retry, the existing event receipt proves `duplicate`; SEPT may repair a missing checkpoint and settle it without a second delivery to Pi. Reuse of `(bindingId, eventId)` with different canonical content is a poison collision: the source becomes degraded, the candidate is not settled, and the provider position does not advance automatically.

If the Pod event queue is saturated, SEPT returns retryable backpressure before event or checkpoint persistence. The source retains the unresolved candidate, pauses provider intake, and retries with bounded exponential backoff. There is no unbounded adapter-side spool and no second hidden work queue. At-least-once provider redelivery is expected; SEPT's durable idempotency boundary supplies effective exactly-once admission for identical canonical content.

Crash ordering remains safe:

- failure before durable event acceptance causes provider replay with no false receipt;
- failure after event acceptance but before checkpoint persistence replays into durable deduplication and repairs the checkpoint;
- failure after checkpoint persistence but before provider acknowledgement may redeliver once and settles from the same proof; and
- failure after provider acknowledgement resumes from the core-owned checkpoint.

#### Lifecycle, recovery, and provider limitations

Each binding exposes a sanitized source state: `disabled`, `starting`, `observing`, `backpressured`, `degraded`, `recovery_required`, `stopping`, or `stopped`. State includes only bounded reason class, checkpoint generation, last successful observation time, backoff class, and declared provider retention/gap status.

- Startup reconciles event receipts and queues before starting sources, then supplies the last valid checkpoint to exactly one source instance per binding.
- A source crash is restarted with bounded backoff from that checkpoint. Repeated protocol, authentication, or provider failures become degraded rather than a tight restart loop.
- Initial enablement uses the operator-selected initial position. Neither first start nor package upgrade silently skips to the provider's latest position.
- Offline catch-up is bounded by what the provider actually retains. If a provider reports an expired cursor, missing history, lost subscription, or unrecoverable gap, SEPT records `recovery_required` and stops automatic advancement. The operator must select a descriptor-supported resynchronization action; SEPT never claims complete recovery when the provider cannot supply it.
- Lease-based and explicit-ack providers renew only bounded in-flight work. They acknowledge after local settlement and tolerate redelivery.
- Streams and MCP resource subscriptions are acceptable adapter internals only when the integration supplies stable event identity plus replay, explicit acknowledgement, or a correct gap signal. A bare “resource changed” notification is not durable trigger proof.
- Scheduled queries and cursor polling must obey provider rate-limit and retry metadata, use stable pagination, and stop at the first unsettled item.
- Providers that genuinely offer only inbound webhooks are unavailable to ordinary local Pods in this part. Supporting them later requires a separately approved server-hosted or relay mechanism; SEPT does not disguise webhook dependence as outbound operation.

Disabling a binding quiesces and stops its source without deleting the checkpoint. Drain pauses new candidates at the last settled checkpoint while already accepted events settle. Cancelling a run does not acknowledge, delete, or reorder unrelated episodic events. Graceful worker shutdown first quiesces every source and resolves or abandons the single current candidate without advancement, then settles the worker safe seam and releases the state-root lease. Restart must not create two observers for the same binding.

### Pod event admission semantics

The event admission controller is the only component that maps a valid accepted event onto the run lifecycle.

#### Continuous delivery

- **Idle:** create a new run from the Pod profile and binding objective, attach the event, and start Pi.
- **Active:** append the event to the resident run's durable input queue. It is delivered at the existing safe input seam without starting a second controller.
- **Waiting:** fsync the queued event, change the resident run to active, and reopen the same Pi session.
- **Terminal previous run:** create a fresh run for the new event.

#### Episodic delivery

- Every accepted event represents one logical run.
- **Idle:** create and start its run immediately.
- **Active or waiting:** append the event to the bounded durable Pod pending-event queue without altering the resident run.
- After the resident run becomes terminal and releases the slot, the oldest eligible pending event is atomically claimed and creates the next run.
- A waiting episodic run retains its slot because it is still awaiting task-specific input. New unrelated episodic events remain queued rather than contaminating its session.

#### Common behavior

- Queue persistence precedes successful acknowledgement.
- If a required companion connector becomes unavailable after binding enablement, matching events remain durably accepted but are marked dependency-waiting and are not delivered to Pi until eligibility returns. Reconnection wakes queue processing. Disabling or revoking the binding requires explicit operator disposition of its already accepted events rather than silently dropping them.
- Admission and queue claim are crash-recoverable and idempotent.
- Active delivery retains the current at-least-once input proof rules.
- Queue limits apply by event count and normalized bytes. Saturation returns a retryable backpressure disposition before persistence; a future HTTP adapter may map that disposition to `429`.
- Drain rejects new events while allowing already accepted events to settle according to existing drain semantics.
- Cancellation applies to a run, not unrelated queued episodic events. The control surface may remove a queued event explicitly before it becomes a run; removal is durable and auditable.
- Graceful shutdown stops admission, settles the active safe seam, and leaves accepted events recoverable.
- Restart reconciles pending receipt claims, queued events, active delivery, and interrupted wake exactly once without duplicate Pi invocation.

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
- inspect sanitized trigger-source lifecycle, checkpoint generation, backpressure, and gap state;
- pause, resume, recheck, or stop a trigger source through binding lifecycle operations;
- select one descriptor-supported recovery action after an expired cursor or provider gap;
- inspect bounded pending-event state; and
- cancel a queued event before claim.

The exact non-secret HTTP routes must use strict request schemas, authentication-before-body-read, `Cache-Control: no-store`, bounded pagination, and the existing safe-error posture. They do not expose a general event-injection route in this part. Secret submission and OAuth callbacks use the local credential-service abstraction rather than the ordinary plain HTTP control listener. Trigger candidates enter through the supervised local protocol and transport-independent event-admission service.

The future frontend must be able to render every connector, trigger, binding, lifecycle state, and policy from these projections without reading durable files directly.

## Persistence and recovery

Part 1 uses versioned, atomic, access-restricted local records consistent with the existing single-writer Node:

- Pod profile;
- installed integration catalog and descriptor provenance;
- trigger bindings;
- connector lifecycle and grants;
- connector secret store or opaque keychain references;
- connector probe evidence;
- trigger-source lifecycle and bounded failure state;
- core-owned trigger-source checkpoints and filtered dispositions;
- pending episodic events;
- per-run continuous event delivery;
- event receipts and claim state; and
- catalog/import reconciliation evidence.

Raw provider bodies, subscription frames, acknowledgement handles, transient delivery tokens, and secret values are excluded from receipts, checkpoints, and ordinary lifecycle evidence.

Startup must refuse malformed present configuration rather than silently resetting it. Absent new files receive documented safe defaults: neutral empty profile additions, no trigger bindings, no connector grants, connector policy `none`, no running trigger sources, and an empty event queue.

Run creation remains atomic. An event receipt must never report completion unless the event is durably queued or its run is durably created. Interrupted pending receipt claims are reconciled from durable queue/run evidence.

## Security and observability

- Bind loopback by default and retain bearer authentication for the current control listener.
- Trigger-source children receive only their own descriptor-approved non-secret configuration and credential requirements. They receive no model credential, Pi agent directory, general SEPT bearer, unrelated connector secret, run-state path, or unrestricted parent environment.
- Provider-facing adapters verify provider-specific connection identity or authenticity before normalization.
- Apply replay protection through stable event IDs and bounded acceptance windows where the provider supports timestamps.
- Never record bearer headers, provider acknowledgement handles, OAuth codes, tokens, cookies, connector environment values, raw provider bodies, MCP arguments, MCP results, prompts, event attributes, or opaque checkpoint values in operational telemetry.
- Connector/process errors are capped, sanitized, and classified before persistence.
- Metrics use bounded labels only: lifecycle state, MCP transport kind, trigger observation kind, delivery mode, backpressure class, gap class, and success/cancel/failure classes.
- Agent-facing text cannot grant authority or alter the profile, binding, connector state, or filesystem policy.
- Connector installation is executable-code installation. Local/imported definitions display origin, command/endpoint, requirements, and content hash before grant.

## Required implementation sequence

The implementation agent must work in this order and keep each step wired.

### Tranche A sequence — MCP connector plane

1. Add strict shared Pod-profile, integration-descriptor, connector-definition, connector-grant, identity, lifecycle, and connector-policy types/codecs plus versioned atomic storage.
2. Implement explicit connector discovery/import, provenance/hash collision handling, and sanitized projections without executing discovered definitions.
3. Implement grants, local secret/identity abstractions, probe serialization, boot reconciliation, recheck, degradation, and revocation.
4. Implement stdio and streamable-HTTP MCP clients through the single transport-isolation seam reserved for Part 1.5.
5. Perform initialization and bounded `tools/list`; translate validated schemas into deterministic Pi `ToolDefinition`s with call-time eligibility, timeout, output, redaction, cancellation, and revocation enforcement.
6. Wire connector policy, descriptor versions, and exact tool inventory into real production `PiSessionHost` creation, restart adoption, and genuine fresh-session replacement.
7. Add the connector-specific UI-neutral service surface, credential-blind HTTP projections, documentation, and installed CLI operations required to configure and inspect the connector lifecycle without editing durable files.
8. Run the connector-plane verification milestone through the installed worker and built container. The supervisor performs the consolidated Tranche A quality pass; the same worker corrects the resulting bounded defect list and reruns every affected installed-path criterion. Once the list is clear and the evidence passes, continue immediately to step 9 in the same worker.

**Continuation rule:** production trigger bindings, source children, checkpoints, event queues, and event admission begin only after step 8 and its internal quality pass are evidenced, but this does not require user confirmation, a new worker, or a new task. Shared descriptor fields and interfaces may be defined earlier only when directly required by the connector plane; dormant trigger code does not count as progress.

### Tranche B sequence — generalized trigger-source and event plane

9. Add strict trigger declarations, binding/start-position contracts, canonical events, source lifecycle, source protocol messages, opaque checkpoints, filtered dispositions, receipts, and pending-event storage.
10. Implement the single `TriggerSupervisor`, versioned stdio source protocol, immutable adapter launch seam, one-unsettled-candidate rule, durable checkpoint ownership, backpressure, pause, stop, restart, and gap recovery.
11. Implement descriptor-backed binding validation and the bounded deterministic filter/mapping surface, with core re-evaluation of every normalized candidate.
12. Implement the transport-independent event-admission controller and continuous create/wake/active-delivery plus episodic create/FIFO-pending/claim behavior.
13. Reconcile source settlement with receipt, queue, run-creation, dependency-waiting, active-delivery, waiting-wake, queue-claim, drain, cancellation, rollover, terminal, and graceful-shutdown crash seams.
14. Generalize prompts and move standing identity from per-event free text to the Pod profile while preserving legacy direct-task and compatibility-webhook behavior unchanged.
15. Add binding/source/pending-event service surfaces, credential-blind projections, documentation, and drag-and-drop-ready schemas. Do not add a provider-facing event or webhook route.
16. Exercise two distinct source observation strategies plus one real external outbound integration through the exact installed CLI/service/worker/Pi/container path. The supervisor performs the consolidated Tranche B quality pass; the same worker corrects the bounded defect list, removes dormant/superseded code, reruns affected evidence, and then completes the full acceptance audit below.

Later steps may refine earlier types, but the implementation must remain one coherent runtime path. No alternate agent loop, duplicate event runner, provider-specific SEPT-core poller, or dormant connector subsystem is acceptable.

## Required verification

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

The connector acceptance subsection is the mandatory Tranche A verification milestone. It must pass before the implementation begins the following trigger acceptance work; once it passes, work continues directly without a new authorization.

### Trigger-source protocol and lifecycle acceptance

- Two independently installed conforming integration packages or fixtures exercise different observation semantics—one cursor/poll style and one streamed or explicit-ack style—through the same source protocol, supervisor, checkpoint store, and event-admission service without provider-specific core code.
- A source package is added by descriptor/runtime installation and control-surface configuration only. It requires no new SEPT core route, CLI flag, provider-name branch, or handwritten frontend schema.
- Malformed descriptor source fields, source messages, binding, initial position, filter, checkpoint, normalized event, version, size, and unknown-field cases fail closed.
- Protocol mismatch, concurrent candidates, duplicate delivery IDs, output flooding, process crash, repeated failure, pause, disable, stop timeout, and restart backoff are bounded and deterministic.
- Adapter credentials remain isolated from Pi, other connectors, SEPT state, prompts, manifests, conversations, checkpoints, logs, telemetry, and API projections.
- Checkpoint tests prove the required crash seams before acceptance, after acceptance/before checkpoint, after checkpoint/before provider acknowledgement, and after acknowledgement.
- A filtered event creates no run or event receipt but cannot be passed by the provider cursor until its filtered disposition/checkpoint is durable.
- Backpressure retains exactly one unresolved candidate, advances no checkpoint, creates no partial receipt, performs no provider acknowledgement, and resumes without reordering.
- Initial-position selection, offline catch-up, expired cursor, missing history, lost subscription, explicit recovery, and incompatible adapter-version migration never skip silently.
- Drain, disablement, cancellation, revocation, and graceful shutdown quiesce source work in the documented order and restart never creates two observers for one binding.

### Trigger and event acceptance

- Binding enablement refuses missing, ungranted, policy-excluded, or unverified required connectors; later connector degradation dependency-waits rather than losing an accepted event.
- The Pod deterministically re-evaluates every normalized candidate and refuses an adapter's false claim that a non-matching event matched.
- A real installed Pod receives a real external outbound event while idle and creates a run using the profile and binding, with no caller-supplied run ID and no public callback, tunnel, firewall rule, or SEPT-hosted relay.
- The real acceptance integration is selected according to an available provider-appropriate outbound interface; its provider-specific code remains inside the installed integration package. A local fake server or direct event injection cannot replace this live proof.
- The awakened production `PiSessionHost` uses an operator-authorized MCP tool from the integration through the exact Tranche A bridge to retrieve further context or perform the configured bounded action.
- A continuous event observed while waiting wakes the same Pi session without a caller-supplied run ID.
- A continuous event observed while active is durably delivered at the next safe seam.
- Episodic events observed while busy are queued FIFO and create distinct later runs.
- Queue count/byte saturation returns retryable backpressure without partial persistence or provider advancement.
- Identical retries deduplicate; key collisions poison and stop advancement rather than routing conflicting content.
- Restart tests cover receipt/queue/run-creation, active-delivery, waiting-wake, queue-claim, source checkpoint, and provider-settlement crash seams.
- Drain, cancellation, rollover, terminal races, connector dependency recovery, source restart, and graceful shutdown preserve existing behavior.
- Raw provider data, normalized attributes, acknowledgements, delivery tokens, and checkpoint values do not appear in operational logs or telemetry.

### Full regression and installed paths

- `npm run check` passes.
- The complete test suite passes with no regressions.
- `npm audit` and `npm audit --omit=dev` pass under the repository's vulnerability policy.
- `git diff --check` passes.
- A high-confidence secret scan covers every intentionally changed text file and generated acceptance output.
- A no-cache production image builds successfully.
- The built image exercises descriptor listing, connector lifecycle, real MCP tool use through Pi, two source strategies, a real outbound event, idle event admission, waiting wake, active queueing, backpressure, source/worker restart recovery, authenticated reads, and fail-closed unauthenticated access through the installed entry point.
- The ordinary local/container acceptance configuration publishes no provider-facing port, registers no public callback URL, starts no tunnel, and uses no SEPT-hosted relay.

## Explicit non-goals

- No dashboard or visual drag-and-drop editor. Part 1 does deliver the descriptor, schema, lifecycle, and service mechanisms that let the later frontend remain provider-agnostic.
- No remote or cross-device communication.
- No supervisor hierarchy.
- No cloud account, billing, or entitlement service.
- No agent-authored code executing directly from its live Pod workspace.
- No automatic grant based on LLM output.
- No mandatory public connector registry or ranking engine.
- No new provider-facing webhook receiver, generic webhook integration, automatic tunnel, or hosted trigger relay.
- No provider-specific polling, streaming, subscription, cursor, or acknowledgement implementation in SEPT core.
- No unrestricted raw network/browser/shell capability disguised as a connector.
- No replacement of Pi's agent/model/session runtime.
- No ACP or complete external-agent harness.

## Completion gate

Part 1 is complete only when both ordered tranches pass their verification. First, the installed Node and built container must deliver a clean MCP connector implementation that discovers, authorizes, probes, exposes, invokes, cancels, recovers, and revokes a real connector through production Pi wiring. The same worker then continues directly into the second tranche: the installed runtime must supervise provider-agnostic outbound trigger sources, receive a real external event without a public callback, durably settle its provider checkpoint, select create/wake/queue behavior without a run ID, and make the awakened Pi agent use the authorized MCP connector. All existing lifecycle guarantees must survive restart, drain, cancellation, rollover, backpressure, dependency loss, and shutdown, while credentials and unsafe payloads remain outside every public and operational surface.

Code that is not reached through that exact installed path must be wired and exercised or removed.
