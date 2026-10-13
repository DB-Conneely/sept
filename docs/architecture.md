# SEPT module map

SEPT is organized by the mechanisms it owns. Each mechanism has one public `index.ts`; production callers outside that folder use that surface rather than implementation files. Focused tests may import an implementation directly when doing so avoids widening a runtime facade.

```text
src/
  cli.ts                         installed command dispatch and composition
  cli/
    auth-interaction.ts          terminal adapter for Pi AuthInteraction
  model-access/
    index.ts                     intentional public surface
    contracts.ts                 credential-blind provider/model/auth/selection DTOs
    input.ts                     hostile-object narrowing at configuration boundaries
    jsonc.ts                     bounded JSONC parsing for Pi models.json
    custom-configuration.ts      endpoint, credential, and rollover-metadata safety
    model-metadata.ts            identifiers, model limits, and built-in fallback pair
    pod-selection.ts             atomic credential-free Pod default persistence
    normalization.ts             credential-blind Pi metadata and error projection
    runtime-factory.ts           validated installed Pi ModelRuntime construction
    service.ts                   catalogue, authentication, selection, and preflight facade
  durable/
    index.ts                     durable state public surface
    contracts.ts                 run, task, handover, conversation, lifecycle contracts
    errors.ts                    classified durability and capacity failures
    limits.ts                    queue, record, conversation, and control bounds
    filesystem.ts                atomic files, fsync ordering, bounded JSONL scanning
    validation-primitives.ts     shared hostile-input narrowing primitives
    state-codecs.ts              manifest and lifecycle-snapshot codecs
    evidence-codecs.ts           event, message, conversation, and readiness codecs
    control-codecs.ts            assistant control and handover validation
    lease.ts                     stable process identity and exclusive durable leases
    run-evidence.ts              sequenced internal events and bounded lifecycle logs
    conversation-store.ts        bounded client conversation retention and recovery
    operator-queue.ts            exact input admission, proof, and compaction
    context-transfer-store.ts    checkpoint and handover durability ordering
    run-store.ts                 cohesive facade over one run's durable mechanisms
    run-discovery.ts             fail-closed restart discovery
    worker-lifecycle-store.ts    durable drain/readiness authority
  ingress/
    index.ts                     HTTP public surface
    errors.ts                    request errors and HTTP status mapping
    service.ts                   authenticated HTTP, model projection, replay, SSE
    validation.ts                task/workspace validation and model preflight composition
    webhook.ts                   normalized event validation, hashes, receipts
    webhook-router.ts            idempotent event-to-worker routing
  observability/
    index.ts                     injected facade and construction surface
    contract.ts                  business-facing observability contract
    configuration.ts             identity, resource, exporter selection
    logger.ts                    bounded redacted JSON stderr logging
    safe-fields.ts               field allowlist and value bounds
    exporters.ts                 contained exporter wrappers
    metrics.ts                   runtime instruments and bounded state
    setup.ts                     SDK/exporter selection and signal-owner construction
    telemetry.ts                 facade implementation and signal lifecycle
    tracing.ts                   spans, propagation, limits, provider
  pi-integration/
    index.ts                     Pi session-policy public surface
    diagnostics.ts               non-secret installed diagnostics
    prompts.ts                   control, continuation, handover prompts
    rollover.ts                  adaptive arithmetic and durable evidence
    durable-host.ts              native Harness/conversation lifetime and sanitized events
    durable-runtime.ts           authenticated Models, registry and SQLite FULL construction
    durable-invocation.ts        native submission/recovery and finalized-usage steering
    durable-admission.ts         bounded captured operator IDs for native admission
    durable-session-files.ts     strict native locators and unique successor discovery
    durable-resources.ts         operator prompts/skills and untrusted repository instructions
    durable-extensions.ts        bounded trusted native module loading
    durable-tools.ts             existing Pi tools registered as native durable tasks
    message-text.ts              text-only native response projection
  execution/
    index.ts                     supplied backend public boundary
    contracts.ts                 one bounded effect/resource port and profile identity
    profile.ts                   actual Linux isolation and mount provenance validation
    protocol.ts                  bounded hostile request/result codecs
    docker-backend.ts            exclusive namespace lease, transport and joined cancellation
    hands-entry.ts               existing Pi body/resource operations inside hands
    native-env.ts                minimum native environment with typed unsupported operations
  runtime/
    index.ts                     runtime public surface
    controller.ts               durable cycling and Pi-native cancellation state machine
    worker.ts                   single resident slot, drain, controller ownership
```

The dependency direction is:

```text
cli -> ingress -> runtime -> pi-integration -> model-access
 |        |                         |               |
 +--------+-------------------------+---------------+-> durable
          +-------------------------+-----------------> observability contract
```

`model-access` is normalization and control around the installed Pi `ModelRuntime`, not another provider layer. Pi owns provider/model discovery, auth, credential storage/refresh, availability, compatible endpoint execution, and model requests. SEPT exposes only approved metadata, reads the atomic credential-free Pod default for every admission, and preflights the final pair before `RunStore.create()`. Direct and webhook tasks use the same admission function and service. Login remains UI-neutral in the service; only the installed CLI supplies an interaction adapter. Plain HTTP exposes authenticated read/selection routes but no secret mutation.

`durable` has no dependency on higher mechanisms. Existing format-2 manifests with fixed rollover options remain readable and normalize to format 3; all new manifests contain the resolved provider/model and no rollover knobs or credentials. The state-root `worker-state.json` remains authoritative for accepting/draining/drained readiness. Each run's bounded `conversation.jsonl` remains the sole client-facing event contract, separate from internal lifecycle events, logs, Pi sessions, rollover evidence, and checkpoint/handover controls.

`pi-integration` receives the selected Pi model from the manifest, verifies context/output metadata again, and opens the run's native Durable Harness with SQLite FULL and compaction disabled. Native conversation IDs are numeric; SEPT exposes their string form and bounded versioned locators. `rollover.json` remains scoped to provider, model, conversation identity and context window. Native finalized-response hooks supply usage; a stable steering submission is reused after restart or resumed with a distinct interrupted-handover recovery input. Handover JSON, Markdown, event and state commit before a fresh native conversation and provider UUID are created. Exact captured operator IDs accompany admission, so later queue arrivals cannot be marked in an earlier prompt.

Trusted agent-directory modules register native declarative extensions, including supported tools, sections, hooks, wrappers and tasks. Project trust remains false; repository instructions do not execute plugins. The existing Pi tools are adapted into native Durable tasks with explicit replay safety and cancellation. Both their complete existing bodies and the minimum native environment operations use the consumer-supplied `execution` backend. The backend enforces effects separately from brain; Pi remains the scheduler, replay and provider owner. New runs have one engine, with no coding-agent production host or historical transcript converter.

`runtime` retains execution, cancellation, wait/wake, shutdown, limits, restart adoption, and slot ownership without knowing HTTP. `ingress` translates the authenticated API and webhook contract onto runtime and model-access services. `observability` imports no business mechanisms and receives only bounded classifications/numbers; model identifiers, credentials, auth interactions, prompts, and provider errors are not telemetry fields.

The architecture suite enforces index-only cross-mechanism imports. `npm run build` cleans `dist`, so deleted or moved modules cannot survive as stale executable output. SEPT does not add ACP, a second agent loop, provider client, tokenizer, compactor, dashboard, cloud service, or model server.

`cli` composes the trusted supplied Docker Linux profile into both installed callers. Brain retains credentials, Models/Harness and SEPT control state; hands gets namespace aliases, a clean environment and exact bounded read-only resource projections. Missing/unsupported enforcement refuses without a local fallback. Default files use a private persistent writable workspace without Bash; granted arbitrary Bash requires a bounded ephemeral workspace and read-only selected mounts. Completed Bash calls join namespace descendants; normal close retains the consumer-owned idle namespace. Cancellation/loss stops and verifies it before settlement, and unverified cleanup durably blocks instead of publishing cancellation. Projection refresh relies on private bounded ownership receipts; consumer markers grant no deletion authority. See [the profile contract](pi-contract.md#supplied-hands-reference-profile).

## Capability policy ownership

`durable/capability-policy.ts` owns the bounded private record, exact codec, fsync and revision CAS; it imports no lifecycle or execution behavior. `cli/permissions.ts` is the local operator writer and installed worker/direct composition. `execution/capability-admission.ts` maps validated rights onto the supplied namespace and effective registrations. `DockerExecutionBackend` owns live revision/generation checks, queued/active ownership, policy-change shutdown and run binding reconciliation. `docker-control.ts` owns bounded trusted control subprocesses and exact-generation stop verification; `profile-configuration.ts` decodes trusted configuration while `profile.ts` validates actual kernel containment. `hands-files.ts` supplies complete supported Pi file operation seams within hands, with retained directory descriptors, independent rights and bounded regular single-link inode access.

Policy authority never enters HTTP task/webhook/model input. Nonempty old state without policy remains dormant; malformed present state fails closed. Native Harness still owns scheduling, safe/unsafe replay and task identity; the worker still owns its single slot, drain, exact queues and budgets. Live denial wins before any queued/replayed effect, while already accepted durable inputs remain recoverable. Supported uniform-read policy retains whole native search/resource bodies. Partial-read namespaces omit search/list and workspace resource discovery; they keep independent anchored file tools and trusted global sections. There is no alternate scheduler, policy editor, provisioner or new operation journal.

`hands-guard.c` is the fixed Linux constructor for trusted entry process protection. The build stage alone compiles its shared library; the runtime image contains the fixed library under its read-only root. `docker-control.ts` invokes it through an environment-cleared fixed preload, disables SIGUSR1 inspection and verifies the constructor acknowledgement in a fixed Node prelude before any old/new entry is loaded. Startup validation uses that same guarded invocation. The entry removes loader/acknowledgement variables from descendant environments. This prevents same-UID executed commands from treating entry memory or output descriptors as acknowledgement authority.


`durable/capability-request-codec.ts` validates exact bounded operation/content and decision facts; `capability-requests.ts` persists at most32 immutable original denials and one matching retry claim through the existing policy lease/atomic helpers. `execution/capability-requests.ts` connects those facts to live run/policy/generation checks; the Docker backend retains effect ownership, expiry timers, cancellation and namespace joins. `cli/permission-decisions.ts` owns local inspection/decision/direct retry only. Native Pi remains the sole task journal/scheduler/provider loop. Pending wait is typed by `permissionRequestId`, published after closure and cleared only by the shared explicit accepted-message wake. Recovery of an interrupted request closes the captured namespace before checkpointing input without dispatching native work. One optional operator-registered hand uses anchored hash-verified code in `execution/custom-hand.ts`, outside the protected entry and brain API.

The single custom tool pins its operator path/hash/replay in native task memo evidence before execution intent. Recovery requires that original pin to be present and unchanged before effects; replacement code needs a new native task. This memo grants no permission and never resumes a denied original call.
