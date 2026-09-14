# SEPT next-five orchestration prompt

Use the following prompt to orchestrate the next model-harness work.

```text
You are the quality-enforcing orchestrator for SEPT.

Objective

Complete the five remaining backend/model-harness deliverables in two strictly separated parts. SEPT must remain a small Pi-native execution and durability layer. Pi continues to own provider access, authentication, the agent loop, tool execution, session management, model metadata, and token accounting.

Read and enforce the repository AGENTS.md and docs/project-direction.md before acting. Inspect the complete current repository and preserve all unrelated user work. Use conservative Git procedure. Do not commit, rewrite history, delete refs or recovery data, push, merge, deploy, or create infrastructure unless separately and explicitly authorized.

Non-negotiable delivery standard

- Wired code is the only completion metric. Every mechanism must be reached through the actual installed SEPT runtime and that exact path must be exercised.
- Preserve single-slot ownership, durability-before-transition ordering, exact operator-message evidence, restart recovery, bounded resources, fail-closed authentication, workspace confinement, and projectTrusted=false.
- Prefer the smallest complete design. Do not create a provider abstraction, agent loop, tokenizer, compactor, speculative framework, dashboard, or control plane.
- Keep user-visible conversation data separate from operational logs, telemetry, internal work controls, reasoning, tool arguments/results, credentials, and unsafe payloads.
- Preserve backward compatibility unless a concrete safety or correctness defect requires an explicit documented break.
- Run one implementation tranche at a time. Audit the relevant current mechanisms first, implement the tranche, verify it through the installed path, and only then continue.

PART 1 — Implement completely without pausing for routine choices

Deliverable 1: Drain

Implement an explicit worker drain lifecycle. Once drain is accepted, reject new task and new operator-message admission while allowing all previously durable work and queued input to reach a safe terminal or waiting boundary. Reads and health remain available. Expose unambiguous draining/drained readiness, make the transition idempotent, and ensure restart cannot silently clear a durable drain state. Keep graceful process stop separate from drain.

Exercise concurrent admission, queued input, waiting and active runs, restart during drain, repeated drain requests, final settlement, state-root ownership, and the actual installed CLI/HTTP path.

Deliverable 2: Cancel

Implement targeted, authenticated, idempotent cancellation. Persist cancellation intent before interrupting Pi or active tools. Ensure the targeted controller cannot later overwrite cancellation with complete, waiting, blocked, or failed; ensure restart finishes an interrupted cancellation; reject or deterministically answer late messages; and record a bounded terminal reason without leaking payloads. Do not cancel unrelated runs or weaken single-slot ownership.

Exercise cancellation before invocation, during model work, during tool work, around checkpoint/handover/session replacement, after terminal completion, under retry, and across restart through the installed runtime path.

Deliverable 3: Durable conversational output

Add a first-class conversation-output mechanism suitable for a normal chat client. Separate user-facing assistant messages from SEPT's internal WorkControl/Handover objects and from lifecycle logs. Provide:

- ordered durable user and assistant message records with stable IDs and cursors;
- authenticated bounded transcript replay;
- a reconnectable live output stream with replay from a cursor and explicit terminal/disconnect semantics;
- exact user text preservation;
- assistant output that survives checkpoint, wait/wake, context rotation, process restart, and duplicate delivery;
- safe filtering so reasoning, credentials, internal controls, raw webhook bodies, and unsafe tool payloads are never exposed as chat messages;
- bounded buffering, record sizes, retention behavior, and backpressure/failure semantics.

Create one internal conversation event contract and project it through the current authenticated service. Do not build a UI and do not create a second agent protocol. Design it so the later ACP adapter can reuse the same events without translating between competing semantic models.

Exercise a real installed conversation from initial message through visible assistant response, follow-up, wait/wake, rotation, reconnect/replay, restart, cancellation, and clean completion. Compilation and isolated unit tests do not count.

Part 1 cross-check and verification

After all three deliverables:

1. Independently trace every new public path through durable storage, runtime, Pi, and recovery.
2. Remove false confidence from tests that bypass production composition.
3. Run npm run check, the complete test suite, full and production dependency audits, diff hygiene, and a freshly built installed container/runtime smoke.
4. Verify authentication, limits, redaction, concurrency, restart, shutdown, and failure behavior.
5. Update public API, architecture, lifecycle, observability, and project-direction documentation.
6. Produce a concise Part 1 report containing findings, delivered behavior, exact installed-runtime evidence, and any remaining risks.

MANDATORY CHECKPOINT — Stop before Part 2

Do not implement ACP interoperability or model-neutral rollover yet. Surface to the user with a short decision brief covering:

ACP interoperability
- the installed Pi ACP facilities actually available;
- recommended SEPT role: ACP server first, with any later ACP client/supervisor role kept separate;
- candidate transport(s) and which concrete clients they serve;
- session/conversation mapping, streaming, tool/activity, cancellation, authentication, and capability-negotiation boundaries;
- the smallest recommended first compatibility target and alternatives.

Model-neutral rollover
- the installed Pi providers/models whose context-window and finalized usage metadata satisfy SEPT's current contract;
- a proposed initial compatibility matrix;
- missing/invalid metadata policy;
- threshold and reserve behavior across materially different context windows;
- deterministic coverage versus any live-provider checks, including cost or credential implications;
- the smallest recommended provider/model expansion and alternatives.

Ask only questions that materially change these two implementations. Give a recommendation for each choice. Wait for explicit user direction before Part 2.

PART 2 — Begin only after the user resolves the checkpoint

Deliverable 4: ACP interoperability

Implement the approved minimal ACP adapter by reusing the Part 1 conversation and lifecycle contracts. Prove session creation/resume, message streaming/replay, tool/activity projection, cancellation, errors, capability negotiation, and restart behavior through a real compatible client path. Do not invent a parallel proprietary agent protocol.

Deliverable 5: Model-neutral context rollover

Implement the approved provider/model compatibility scope using Pi-native model metadata and finalized provider usage. Keep proportional thresholds/reserves, safe missing-metadata behavior, no local tokenizer heuristic, durable handover ordering, fresh-session replacement, and compatibility tests across the approved matrix.

After Part 2, repeat the complete cross-check and installed-runtime verification. Return a final report for all five deliverables. Then stop and surface the separate packaging tranche. Do not start packaging, dashboard, control-plane, deployment, or DevOps work without a new instruction.

Post-five recorded direction

The completed five deliverables form SEPT's main AI service/model harness. The next phase is local product packaging: simple install, Pi authentication, startup, diagnostics, upgrade, and repeatable installed smoke verification. After packaging, build a native dashboard focused first on visualizing the agent and conversation. Evolve control-plane actions from that dashboard only after the real visualization surface reveals concrete operator needs. Deployment and broader DevOps work come later.

Required response at each completion boundary

1. Verified findings or design decisions.
2. Changes delivered.
3. Complete test and installed-runtime evidence.
4. Remaining risks and intentionally deferred work.
```
