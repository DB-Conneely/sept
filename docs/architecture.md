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
    session.ts                   native Pi session and fresh-session lifecycle
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

`pi-integration` receives the selected Pi model from the manifest, verifies context/output metadata again at session creation, and disables Pi auto-compaction. `rollover.json` is scoped to provider, model, Pi session ID, and context window. It records finalized provider usage, the last three positive growth deltas, consecutive unusable samples, and the durable rotation-required flag. A recovered flag inspects the resumed Pi session: an already completed steer is reused without another model call or duplicate steer; an uncompleted steer resumes the handover request. Handover JSON, Markdown, event, and state still commit before `AgentSessionRuntime.newSession()`.

`runtime` retains execution, cancellation, wait/wake, shutdown, limits, restart adoption, and slot ownership without knowing HTTP. `ingress` translates the authenticated API and webhook contract onto runtime and model-access services. `observability` imports no business mechanisms and receives only bounded classifications/numbers; model identifiers, credentials, auth interactions, prompts, and provider errors are not telemetry fields.

The architecture suite enforces index-only cross-mechanism imports. `npm run build` cleans `dist`, so deleted or moved modules cannot survive as stale executable output. SEPT does not add ACP, a second agent loop, provider client, tokenizer, compactor, dashboard, cloud service, or model server.
