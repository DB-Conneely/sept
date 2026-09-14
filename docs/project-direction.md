# SEPT Project Direction

## Purpose

SEPT is a small, durable agent worker built on the native Pi coding-agent SDK. A SEPT instance runs in its own container, owns one active work slot, and can remain idle until work arrives or continue a long-running task without sharing mutable runtime state with other instances.

The long-term operating model is a manager coordinating one or more SEPT workers. The manager assigns bounded work, monitors lifecycle and performance, reviews what each worker delivers, and verifies the real installed runtime path. SEPT workers do the implementation work inside their assigned repositories.

## Near-term direction

1. Preserve the existing single-slot worker and Pi-native lifecycle.
2. Rename the repository folder to `Sept` and establish a clean, intentional Git baseline without committing credentials, runtime state, logs, or generated secrets.
3. Add a small generalized webhook ingress that can accept events from arbitrary HTTP producers and route normalized work or operator messages to SEPT. Telegram, Slack, WhatsApp, monitoring systems, and future providers should be thin adapters around one core event contract rather than separate agent systems.

The webhook receiver must support the minimum production-worthy controls: fail-closed authentication, strict input and size limits, idempotent duplicate handling, clear routing, bounded observability, and safe failure responses. Provider-specific behavior belongs at the edge. The core should remain provider-neutral.

## Production runtime direction

SEPT must mature into a production-grade agent runtime rather than remain a collection of internal commands. The same small runtime should support three operating modes without separate implementations: an idle worker awakened by an authenticated webhook, a continuously running worker, and a scheduled worker invoked by an external scheduler. Each mode needs a clear public entry point, explicit process identity, durable state in an intentional location, safe configuration and secret handling, health and lifecycle signals, graceful shutdown and restart recovery, bounded resource use, and an exercised installed path.

## Control protocol improvements

These are recorded improvements, not additions to the current implementation scope:

- **Durable task revisions instead of mutating or manually reopening terminal runs.** A run's effective objective must remain accurate as operator direction evolves; otherwise the immutable original task, current work, lifecycle state, and final report can contradict one another. Revisions should be explicit, ordered, durable, and attributable.
- **A repeatable installed-runtime smoke suite.** Ad hoc shell probes are easy to misconfigure and difficult to reproduce. A small maintained suite should exercise the same public entry point, worker routes, Docker command, health check, process identity, and critical lifecycle path that operators actually use.
- **An intentional persistent state location.** Temporary operating-system directories may be cleaned without warning and are unsuitable for continuous or restart-sensitive agents. Production runs need a configured, access-restricted location with defined retention, backup, cleanup, and recovery behavior.
- **Concise operational metrics.** Operators need enough signal to distinguish useful work from stalls or resource degradation without flooding the event log. At minimum, expose worker uptime, current run and epoch, context pressure, queue depth, invocation latency, restart count, failures, and bounded CPU/memory indicators.
- **Explicit worker and run lifecycle actions suitable for the future dashboard.** Start, stop, drain, retry, revise, cancel, archive, and inspect operations need stable semantics and safe state transitions. A control plane cannot reliably manage workers if it must edit durable files directly or infer lifecycle state from implementation details.

## Ordered implementation sequence

Graceful stop is complete and exercised through the installed worker. The five remaining model-harness tranches are ordered as follows. Each item must preserve the single-slot and durability guarantees and be exercised through the installed runtime path before the next begins.

1. **Drain.** Refuse new work while allowing already accepted work to settle, with an explicit durable state and unambiguous readiness reporting.
2. **Cancel.** Interrupt the targeted run and its active Pi/tool work safely, durably record the terminal reason, and prevent late completion or duplicate-controller races.
3. **Durable conversational output.** Separate user-facing assistant messages from internal lifecycle controls and operational logs. Provide an authenticated, bounded, replayable transcript and live output stream that survive wait, wake, rotation, and restart without exposing reasoning, unsafe tool payloads, or credentials.
4. **ACP interoperability.** Use the standard Agent Client Protocol and existing Pi ACP integration work rather than inventing a proprietary client protocol. First expose SEPT conversations, sessions, output, and lifecycle through an ACP adapter; keep the boundary suitable for later supervising other ACP-compatible agents through capability negotiation.
5. **Model-neutral context rollover.** Generalize and prove the rollover trigger across supported Pi providers and models. Base decisions on the selected model's declared context window and finalized provider-reported usage, keep thresholds and reserves proportional to that active window, fail or defer safely when required metadata is unavailable, and add compatibility coverage beyond the Codex default without recreating provider clients or tokenizers.

The first three tranches form Part 1 and were completed as one focused backend pass: durable drain, Pi-native targeted cancellation, and bounded durable conversation replay/streaming are wired and exercised through the installed worker and production Pi lifecycle. Part 2 remains behind the mandatory decision checkpoint. Orchestration must stop and surface a concrete decision brief for ACP interoperability and model-neutral rollover; Part 2 begins only after the user resolves those protocol, transport, capability, provider, and compatibility choices.

Completion of all five establishes the main AI service: SEPT's model harness and utility layer. It does not authorize dashboard, control-plane, deployment, or speculative infrastructure work.

## Product surface sequence

After the five model-harness tranches, make the service locally packageable and straightforward to install, authenticate, start, diagnose, upgrade, and exercise. Packaging is a product boundary, not a deployment project; cloud infrastructure, CI/CD expansion, hosting, fleet operations, and other DevOps work remain later concerns.

Once packaging is coherent, build a native dashboard whose first purpose is to make the agent itself legible: conversation, current action, live assistant output, lifecycle state, epoch/session transitions, context pressure, tool activity, queueing, handovers, failures, and recovery. Use this real visual surface to discover the right control-plane interactions.

Only after the dashboard accurately visualizes the agent should it grow into the control plane. Add operator actions such as start, stop, drain, cancel, retry, revise, archive, route, and inspect directly from the dashboard against the stable service contracts. Do not design a speculative control plane independently of the dashboard and observed operator needs.

## Future control plane

A later phase should evolve the native agent-visualization dashboard into the SEPT control plane. It should make worker state, routing, lifecycle, progress, failures, and operator actions visible without requiring the user to work indirectly through an orchestration chat. This is recorded direction only and is not part of the five model-harness tranches; its abstractions should be introduced only after the dashboard exposes concrete operator needs.

## Engineering principles

- **Quality through simplicity.** Implement the smallest complete design that satisfies the current requirement. Do not build speculative frameworks or infrastructure for imagined future scale.
- **Wired behavior is the completion metric.** A component is complete only when the installed CLI/worker reaches it through the real runtime path and that exact path has been exercised.
- **Isolation is intentional.** One worker must not silently absorb unrelated work intended for another worker. Routing and lifecycle ownership must be explicit.
- **Pi owns the agent loop.** Do not recreate provider clients, authentication, tool execution, session management, compaction, token accounting, or other behavior already owned by Pi.
- **Durability before transition.** Preserve SEPT's established ordering and recovery guarantees when waking, rotating, restarting, or handing work between sessions.
- **Security is a boundary, not a feature backlog.** Keep credentials and sensitive payloads out of source control, fixtures, logs, images, and error responses. Validate Git staging before every commit boundary. Authenticate before processing, bind conservatively by default, and grant only the filesystem and network access required.
- **Observe what matters.** Monitor task cycling, stalled or repeated work, queue and lifecycle behavior, resource growth, latency, failure rates, and regressions. Prefer a few actionable signals over high-volume telemetry.
- **No deployment.** Deployment is performed manually by the user through GitHub CI/CD.

## Orchestration contract

The manager uses GPT-5.6 Sol with high reasoning for SEPT implementation work; Astra is not used. The manager keeps a concise progress log, checks scope and architectural fit, reviews security-sensitive changes, and rejects dormant or unexercised code. Work pauses at agreed checkpoints for user review.

This document records direction rather than a frozen implementation specification. New abstractions must earn their complexity through an immediate, exercised need.
