# SEPT module map

SEPT is organized by the mechanisms it owns. Each mechanism has one public `index.ts`; production callers outside that folder use the public surface rather than implementation files. Mechanism-focused tests may import an internal directly when verifying that internal, rather than widening the runtime facade solely for tests.

```text
src/
  cli.ts                    public CLI composition
  durable/
    index.ts                durable state public surface
    contracts.ts            run, task, handover, conversation, and lifecycle contracts
    store.ts                fsynced files, ordering, leases, drain/cancel state, and bounded evidence
  ingress/
    index.ts                HTTP/webhook public surface
    errors.ts               ingress request errors and HTTP status mapping
    service.ts              authenticated HTTP, transcript replay, and bounded SSE routes
    validation.ts           task request validation
    webhook.ts              normalized event validation, hashes, and receipts
    webhook-router.ts       idempotent event-to-worker routing
  observability/
    index.ts                injected facade and construction surface
    contract.ts             business-facing observability contract
    configuration.ts        identity, resource, and exporter selection
    logger.ts               bounded redacted JSON stderr logging
    safe-fields.ts          field allowlist and value bounds
    exporters.ts            contained trace/metric exporter wrappers
    metrics.ts              runtime instruments and bounded state
    telemetry.ts            facade implementation and signal lifecycle
    tracing.ts              spans, propagation, limits, and trace provider
  pi-integration/
    index.ts                Pi integration public surface
    diagnostics.ts          agent-directory and authentication diagnostics
    prompts.ts              control, continuation, and handover prompts
    session.ts              native Pi session lifecycle and context rotation
  runtime/
    index.ts                runtime public surface
    controller.ts           durable invocation/cycling and Pi-native cancellation state machine
    worker.ts               single resident slot, durable drain, and controller ownership
```

The dependency direction is:

```text
cli -> ingress -> runtime -> pi-integration
 |        |          |             |
 +--------+----------+-------------+-> durable
          +----------+-------------+-> observability contract
```

`durable` has no dependency on higher-level mechanisms. The state-root `worker-state.json` is authoritative for accepting/draining/drained readiness. Each run's bounded `conversation.jsonl` is the sole client-facing event contract; it is separate from internal lifecycle events, logs, Pi sessions, and checkpoint/handover controls. Durable projection markers reconcile the operator queue-to-conversation crash seam without resurrecting records removed by transcript retention. `observability` does not import durable, ingress, runtime, or Pi business implementations. `pi-integration` depends on durable contracts/storage only for the evidence it must record and receives observability through the facade. `runtime` owns execution and slot lifecycle without knowing HTTP, including the process-wide state-root lease, durable drain admission gate, native Pi abort coordination, and graceful checkpoint boundary. Cancellation state is durable before interruption, and checks after Pi awaits make it impossible for a cancelled controller to publish a later lifecycle result. `ingress` translates the stable authenticated API and normalized webhook contract onto the runtime and projects the durable conversation contract through strict bounded replay/SSE; streams hold no authoritative state, and terminal metadata comes from the run snapshot rather than page position.

A deterministic architecture test enforces index-only cross-mechanism source imports and the absence of observability-to-business imports. `npm run build` first removes `dist` with the Node-built-in cleaner so deleted or moved modules cannot survive as stale executable output.

This structure does not add a second agent loop, provider layer, telemetry system, scheduler, or control plane. Pi remains responsible for authentication, tools, model calls, sessions, context accounting, steering, and fresh-session replacement.
