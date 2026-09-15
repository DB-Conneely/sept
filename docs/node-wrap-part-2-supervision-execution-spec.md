# Node Wrap Part 2: Local Communication and Supervision Execution Specification

## Status and dependency

This document specifies the third and final sequential deliverable that completes the generalized SEPT Node foundation. It is an implementation specification, not approval to begin implementation by itself.

Part 2 begins only after both of the following are implemented and verified:

1. `docs/node-wrap-part-1-integration-execution-spec.md`
2. `docs/node-wrap-part-1-5-capability-execution-spec.md`

Part 2 reuses their stable Pod identity, durable event admission, create/wake/queue behavior, connector policy, scoped tool construction, cancellation, conversation, and restart guarantees. It does not introduce another agent runtime or bypass the capability boundary.

## Product outcome

After this part, multiple SEPT Pods on one user's device can operate as a configurable local agent organization:

- every Pod still contains exactly one Pi-backed agent;
- a Pod may operate independently or be assigned one direct supervisor;
- a supervisor is a SEPT Pod with the complete native authority to direct and quality-assure its assigned Pods;
- supervisors may themselves report to another supervisor, creating bounded nested clusters;
- workers can always communicate with their assigned supervisor;
- optional peer communication exists only between explicitly selected Pods;
- the local human can communicate with and control every Pod they own; and
- every message, delegation, revision, completion decision, cancellation, and result is durable, attributable, bounded, and recoverable.

This completes the agent/Node/Pod foundation. The later frontend presents and edits the topology; it does not invent the execution, authority, or delivery semantics.

## Mandatory invariants

1. **One agent per Pod remains absolute.** A supervisor occupies its own Pod; it is not an in-process collection of agents.
2. **Pi remains the agent runtime.** Local coordination is a SEPT control layer around Pi sessions, not a replacement agent loop.
3. **Single-device scope only.** No remote mesh, cross-user messaging, cloud relay, internet-facing Pod discovery, or distributed failover is implemented here.
4. **Supervisor authority is inherent, not checkbox-composed.** Assigning a supervisor grants the complete supervisor role over its direct reports.
5. **Each Pod has at most one direct supervisor.** This prevents contradictory task authority and produces a clear forest of supervision trees.
6. **Supervision cycles are forbidden.** No Pod can directly or transitively supervise itself.
7. **Workers always have a supervisor channel when supervised.** That channel cannot be disabled by peer-communication settings.
8. **Peer communication is explicit.** A worker may communicate with selected local Pods or with none; no implicit all-to-all network exists.
9. **Communication does not grant tools or files.** Supervisor, subordinate, and peer relationships do not alter Part 1 connector grants or Part 1.5 filesystem policy.
10. **Control authority comes from authenticated identity and topology.** Prompt text or a claimed sender name cannot create supervisor authority.
11. **Supervised completion requires supervisor disposition.** A worker proposes completion; its direct supervisor approves it or returns a revision. The human owner remains the recovery authority.
12. **Only bounded operational evidence is observable.** Supervisors receive objectives, state, public progress, verification, artifacts, and bounded tool activity—not chain-of-thought, secrets, prompts, raw connector results, or another Pod's private filesystem.
13. **Delivery is durable and idempotent.** Offline, restart, waiting, active, and terminal races cannot silently lose or duplicate accepted coordination messages.
14. **The agent cannot edit topology or authority.** Supervisor and peer edges are local human/control-plane configuration.
15. **Wired installed behavior is the completion metric.** A graph model or message type that does not drive real installed Pods is incomplete.

## Topology model

The local topology is a forest of supervision trees plus optional peer-communication edges.

### Supervision edge

```json
{
  "formatVersion": 1,
  "supervisorPodId": "engineering-supervisor",
  "workerPodId": "engineering-pod-1"
}
```

Rules:

- A Pod has zero or one incoming supervision edge.
- A supervisor has zero or more direct reports.
- A supervisor may itself have one supervisor.
- Adding an edge is rejected if it creates a cycle, references a missing/incompatible Pod, or gives a worker a second supervisor.
- Adding a supervision edge requires the prospective worker to be idle with no active, waiting, or review-pending run, so authority and completion semantics never change halfway through work.
- Removing an edge is a deliberate human operation and requires disposition of outstanding delegated work and review-pending completions.
- Topology changes do not copy workspaces, connector grants, credentials, or queued peer messages.

A supervisor assigned to another supervisor forms a bounded lower cluster. The parent directs and reviews the lower supervisor; the lower supervisor directs and reviews its own workers. The parent receives bounded roll-up status for that subtree but does not silently bypass the lower supervisor and directly command its workers.

If the user wants one supervisor to control every worker directly, every worker is attached directly to that supervisor. If the user wants five supervisors with one worker each, five independent two-node trees are valid. A Pod with no supervisor operates normally and completes its own runs without supervisor approval.

### Peer-communication edge

```json
{
  "formatVersion": 1,
  "podA": "content-agent",
  "podB": "marketing-agent"
}
```

Rules:

- A peer edge is an explicit local human selection and is symmetric.
- Either Pod may send a normal peer message to the other while the edge exists.
- Peer authority is limited to communication. A peer cannot observe private status, delegate authoritative work, revise, cancel, or approve another Pod's run.
- Revoking the edge prevents new peer messages immediately. Already accepted messages remain durable and attributable.
- A supervision edge already supplies the supervisor/subordinate channel and does not require a peer edge.

The control plane presents peer communication simply as “Allowed to communicate with” selected Pods or none. It does not expose a matrix of message-specific permissions.

## Supervisor archetype

A supervisor is the same SEPT Pod runtime with:

- a supervisor standing profile and role;
- continuous delivery mode while it has direct reports;
- one or more configured direct reports;
- the full native supervisor tool set;
- the same Part 1 connector selection and Part 1.5 filesystem policy as any other Pod; and
- its own durable run, session, queue, rollover, conversation, and limits.

Supervisor status does not inherently grant external connectors, broad filesystem access, shell, or peer communication. Those remain independently configured.

### Native supervisor authority

For each direct report, a supervisor can inherently:

- observe bounded execution status and progress;
- send messages and clarifying direction;
- delegate a new objective;
- request revision of in-progress or proposed-complete work;
- cancel active, waiting, or review-pending work;
- approve proposed completion; and
- receive durable progress, result, failure, waiting, and escalation notices.

These abilities are one indivisible supervisor role. The frontend does not ask the user to toggle them separately.

### Supervisor Pi tools

The supervisor receives local SEPT control tools generated through Pi's custom-tool seam:

- `sept_list_direct_reports`
- `sept_inspect_report`
- `sept_delegate`
- `sept_message_report`
- `sept_request_revision`
- `sept_cancel_report`
- `sept_approve_completion`

Each tool calls the authenticated local coordination service. It rechecks current topology and target state at invocation time, validates bounded input, propagates cancellation, and returns only bounded structured output.

These tools do not read another Pod's files or invoke its connectors. No raw bearer token or broker credential is exposed to the model or shell.

### In-process quality assurance

The supervisor is an active quality-assurance operator rather than a passive terminal approver. It can review:

- the assigned objective and ordered revisions;
- current lifecycle phase;
- last durable public progress/checkpoint;
- declared next action;
- verification evidence;
- published artifact references;
- bounded tool name/activity state without arguments or output;
- context/epoch/invocation pressure;
- waiting, failure, cancellation, and dependency state; and
- final proposed result.

The supervisor can intervene with one focused revision or cancellation while work is in progress. The message is durably queued and reaches the subordinate through the same safe active/waiting input seam established in Part 1.

The supervisor cannot inspect hidden chain-of-thought, internal prompts, MCP payloads, tool arguments/results, secrets, unshared local paths, or arbitrary raw logs.

## Worker behavior

### Supervised worker

- Receives authoritative tasks and revisions from its direct supervisor or the human owner.
- May send messages, questions, progress, waiting reasons, and results to its direct supervisor.
- May send ordinary non-authoritative messages to explicitly selected peers.
- Cannot delegate authoritative work to a peer merely because communication is allowed.
- Proposes completion to its direct supervisor instead of directly entering terminal `complete`.

### Unsupervised worker

- Receives work from the human, trigger bindings, schedules, or existing direct task paths.
- Operates through the same durable lifecycle.
- Enters terminal completion directly when its objective is fulfilled and verified.
- Has no supervisor channel or review-pending state.
- May use explicitly selected peer communication when configured.

### Supervisor as a subordinate

A supervisor with its own parent behaves as both:

- supervisor over its direct reports; and
- supervised worker for the cluster-level objective assigned by its parent.

It approves/revises its direct workers. When its own cluster objective is fulfilled, it proposes its own completion to its parent supervisor. This composes supervision without a separate hierarchy engine.

## Local coordination service

One host-local coordination service owns Pod discovery, authenticated Pod identity, topology, message routing, and durable broker queues for the current user's device.

It may run as part of the future desktop host service or as a bounded local service before the UI exists. It is not SEPT Cloud.

### Identity and transport

- Every Pod has a stable `podId` and a separate local control identity.
- Pods connect to the broker through an access-controlled Unix-domain socket, named pipe, authenticated loopback channel, or equivalent container-safe local transport.
- Pods do not receive each other's bearer credentials and do not discover arbitrary peer ports.
- The broker authenticates the sending principal and derives its authority from the current topology. It never trusts `from` inside an unverified body.
- The human/control-plane principal is distinct from every agent principal and retains full authority over locally owned Pods.
- Runtime service, broker, and Pod credentials remain outside Pi prompts, tools, shell environments, messages, logs, and telemetry.

### Durable coordination envelope

Every accepted message uses one strict envelope:

```json
{
  "formatVersion": 1,
  "messageId": "stable-id",
  "fromPodId": "engineering-supervisor",
  "toPodId": "engineering-pod-1",
  "type": "delegate",
  "correlationId": "objective-123",
  "parentRunId": "optional-bounded-lineage-id",
  "createdAt": "ISO-8601 timestamp",
  "expiresAt": null,
  "body": {}
}
```

The broker supplies or verifies the sender identity. `fromPodId` is absent for a human principal and replaced by bounded human/control-plane provenance in private broker metadata.

Initial message types are:

- `message`: ordinary human, supervisor, subordinate, or allowed-peer communication;
- `delegate`: authoritative objective from human or direct supervisor;
- `progress`: bounded subordinate checkpoint or roll-up;
- `result_proposed`: supervised completion candidate;
- `revision`: authoritative focused correction from human or direct supervisor;
- `completion_approved`: supervisor or human approval;
- `cancel`: authoritative cancellation; and
- `status`: bounded lifecycle/waiting/failure/dependency notification.

Each type has an exact bounded body schema:

- `message`: `text` and optional `targetRunId`;
- `delegate`: `delegationId`, `objective`, bounded `acceptanceCriteria`, optional parent delegation/run reference, and depth/fan-out values assigned or checked by the broker;
- `progress`: `runId`, lifecycle state, summary, bounded verification entries, and next action;
- `result_proposed`: `runId`, `proposalId`, public message, summary, bounded verification entries, and bounded artifact references;
- `revision`: `runId`, `revisionId`, and one focused instruction;
- `completion_approved`: `runId` and `proposalId`;
- `cancel`: `runId`; and
- `status`: optional `runId`, bounded state, and bounded summary.

Unknown types or fields fail closed. Agent-generated message bodies remain untrusted content; authority comes from authenticated sender identity, envelope type, and topology.

### Delivery guarantees

- Broker outbox persistence precedes acceptance to the sender.
- Recipient inbox persistence precedes broker acknowledgement/removal.
- Delivery is at least once with stable `messageId` deduplication.
- Reuse of one ID with different content is a collision and is rejected.
- Ordering is stable per sender/recipient pair; global ordering across unrelated pairs is not promised.
- Offline Pods retain bounded queued messages until reconnect, expiry, explicit human cancellation, or delivery.
- Count and byte limits apply to every outbox, inbox, and Pod queue. Saturation fails before accepting additional data.
- Message content, objectives, and results do not enter operational logs or metrics.
- Restart reconciles interrupted send, receipt, enqueue, wake, review, and acknowledgement seams without silent loss or duplicate work.

### Pod delivery

The coordination service delivers through the Part 1 Pod event admission controller:

- `delegate` always represents a new logical objective. It creates a fresh run when the recipient is idle and otherwise enters the bounded pending-work queue; it never contaminates an unrelated active, waiting, or review-pending run.
- `revision` always names the affected run. It queues at the next safe seam when active, wakes the same session when waiting or review-pending, and is refused for a different or already terminal run.
- `message` with `targetRunId` is delivered only to that current nonterminal run. A message without a target is delivered to the resident run when one exists or creates a new profile-based interaction run when the Pod is idle.
- `cancel` and `completion_approved` always target the named run and use their dedicated durable state transitions rather than ordinary prompt delivery.
- `progress`, `result_proposed`, and `status` enter the supervisor's durable coordination inbox; they wake its continuous supervisory run or create it from the supervisor profile when idle.
- An offline recipient retains the broker outbox until the Pod becomes available.

A peer `message` is contextual input, not an authoritative objective replacement. A `delegate`, `revision`, `cancel`, or `completion_approved` is accepted only from the human or current direct supervisor.

## Delegation and lineage

A delegation contains:

- stable correlation/objective ID;
- bounded objective text;
- originating human/supervisor identity;
- parent run or delegation reference when applicable;
- expected outcome and acceptance criteria;
- optional deadline/expiry;
- bounded depth and fan-out counters; and
- no implicit connector, filesystem, shell, or model grant.

Delegation creates a fresh run when the target is idle. When another run owns the target's slot, the delegation remains a distinct bounded pending objective until that run becomes terminal and releases the slot.

Every revision is ordered and attributable. The effective objective shown to the worker, supervisor, and human is the original objective plus the durable ordered revision history; history is not rewritten.

The broker enforces configured maximum delegation depth, outstanding delegations per supervisor, message size, queue size, and rate. Reaching a limit produces a bounded failure/escalation rather than recursive spawning.

## Supervised completion lifecycle

Part 2 adds `review_pending` as a nonterminal run state for supervised work.

```text
active/waiting
  → result_proposed
  → review_pending
      → completion_approved → complete
      → revision → active
      → cancel → cancelling → cancelled
```

Rules:

1. When a supervised worker returns a valid `complete` control result, SEPT persists its public result, summary, verification, and artifact references, then records `result_proposed` and enters `review_pending` instead of terminal `complete`.
2. The direct supervisor receives one idempotent `result_proposed` notice.
3. `review_pending` closes Pi/controller resources and retains the run slot similarly to waiting; no model calls occur while review is pending.
4. Approval is durable before terminal `complete` is recorded.
5. Revision is durable before the same run returns to active and the same Pi session is reopened with the ordered supervisor message.
6. Cancellation follows the existing durable intent-before-abort rules.
7. The human owner may approve, revise, or cancel when the supervisor is unavailable or the topology is being changed.
8. Removing a supervision edge is refused while a direct report is review-pending unless the human resolves or explicitly assumes that review.
9. An unsupervised run retains the existing direct-completion behavior.
10. Restart and topology reload cannot accidentally auto-approve a completion candidate.

For a nested hierarchy, each direct supervisor disposes only its direct report's completion. A lower supervisor may approve its workers and later propose completion of its own cluster objective to its parent.

## Progress and roll-up behavior

SEPT emits bounded coordination updates at durable lifecycle seams rather than streaming private model reasoning between agents.

Required automatic notices include:

- task/delegation accepted;
- durable progress checkpoint;
- waiting with bounded reason and next action;
- context rollover/handover summary;
- dependency unavailable/recovered;
- result proposed;
- failure or cancellation; and
- approved completion.

A lower supervisor produces a bounded roll-up for its parent from its own direct-report states and declared results. The parent does not receive every subordinate tool event by default.

The human control plane may inspect any locally owned Pod directly. Agent supervisors see only their configured direct reports plus bounded roll-up metadata supplied by directly supervised lower supervisors.

## Relationship to capability and connector policy

- Assigning a supervisor never changes the worker's connector policy.
- A delegated objective does not add an MCP tool.
- A supervisor cannot grant itself or a worker a connector.
- A supervisor cannot change a worker's filesystem, shell, or network policy.
- Peer communication does not mount a shared directory.
- Artifact transfer occurs through explicit bounded references or an approved shared-location grant.
- A worker asked to perform work outside its granted capabilities reports the limitation to its supervisor; the supervisor may revise the task or escalate to the human, but cannot bypass the grant.

This keeps human permission decisions distinct from agent task authority.

## Control-plane-ready service surface

Part 2 supplies UI-neutral local service methods and authenticated projections for:

- list local Pods and their bounded capabilities/status;
- read the supervision forest and peer edges;
- validate/add/remove one supervision edge;
- validate/add/remove one peer-communication edge;
- inspect direct-report and subtree roll-up state;
- send a human message or delegation;
- inspect bounded message delivery state;
- cancel an undelivered message;
- inspect a supervised completion candidate;
- approve, revise, or cancel a review-pending run; and
- replay bounded human/agent communication history.

The future frontend can therefore render agent nodes and draw:

- one directed supervisor edge from supervisor to direct report; and
- one undirected communication edge between selected peers.

Creating or deleting a graph edge calls the validated service method. The frontend does not infer authority from canvas position, visual nesting, labels, or prompt text.

## Persistence and recovery

Part 2 persists, with strict versions and bounded retention:

- stable local Pod identities;
- supervision and peer edges;
- topology revision;
- broker outboxes and recipient inbox acknowledgements;
- coordination message envelopes;
- delegation correlation and parent lineage;
- ordered revisions;
- result proposals and supervisor dispositions;
- review-pending state;
- bounded progress/roll-up projections; and
- delivery reconciliation markers.

Topology and message stores are outside every agent work plane. Malformed present state fails closed; it is never silently reset or reconstructed from prompts.

Pods retain authoritative run truth. The local coordination service retains authoritative delivery/topology truth. Either side can restart without causing accepted work to disappear or allowing a stale supervisor to retain authority.

Migration rules:

- Existing Pods begin with no supervisor and no peer edges.
- Existing active, waiting, terminal, and historical runs retain their original completion semantics and are not retroactively placed under review.
- Changing a Pod into or out of the supervisor archetype requires it to be idle and validates the resulting topology before mutation.
- Adding or removing peer edges does not rewrite already accepted messages.
- Absent new coordination state means an empty supervision forest, no peer communication, and no broker messages; malformed present state fails closed.

## Security and observability

- Authenticate every Pod and human principal at the local coordination boundary.
- Check topology and authority again at message delivery and supervisor-tool invocation, not only when a session starts.
- Do not expose broker credentials, Pod tokens, objectives, message bodies, results, local paths, connector state details, or conversation text in operational telemetry.
- Use bounded IDs only where operational correlation is necessary and permitted.
- Reject spoofed sender IDs, stale topology revisions, duplicate-content collisions, malformed lineage, cycles, unauthorized peer messages, and unauthorized supervisor commands.
- Treat all peer and subordinate text as untrusted input. Authenticated supervisor/human revisions are authoritative only through the typed control envelope.
- Enforce rate, count, byte, depth, fan-out, and expiry limits before persistence where rejection is required.
- Revoked topology authority cannot be restored by replaying an old message after restart.

## Required implementation sequence

The implementation agent must work in this order:

1. Add strict Pod identity, topology, peer-edge, coordination-envelope, delegation, revision, and disposition codecs.
2. Add durable topology revision, broker outbox/inbox, message receipt, lineage, and reconciliation stores outside all agent work planes.
3. Implement the authenticated host-local coordination service and Pod registration/reconnect lifecycle.
4. Implement at-least-once broker delivery, idempotent Pod receipt, ordering, expiry, backpressure, offline queueing, and restart reconciliation.
5. Deliver local messages through the Part 1 create/wake/queue controller without introducing another run path.
6. Implement supervision-forest validation: one parent, no cycles, safe edge addition/removal, and bounded lower-cluster roll-up.
7. Implement symmetric selected-peer communication and enforce the absence of every unconfigured edge.
8. Generate the complete supervisor Pi tool set and wire it only into Pods whose profile is the supervisor archetype.
9. Add durable delegation objectives, ordered revisions, lineage, and depth/fan-out limits.
10. Add `review_pending`, result proposal, supervisor/human approval, revision reactivation, cancellation, topology-change handling, and restart recovery.
11. Add automatic bounded progress/status/result notices and nested-supervisor roll-ups.
12. Add the complete frontend-ready service surface and documentation.
13. Exercise a real multi-Pod hierarchy, peer messaging, supervised completion, restart, and no-cache container paths through the installed runtime.

## Required verification

### Topology and authority

- One supervisor can manage multiple direct Pods.
- Multiple supervisors can each manage one or more independent Pods.
- A supervisor can report to another supervisor and manage a lower cluster.
- A single supervisor can directly manage every worker when configured that way.
- A Pod with no supervisor operates and completes normally.
- Second-parent and direct/transitive-cycle attempts fail before state mutation.
- Removing a supervisor edge with outstanding delegated or review-pending work requires explicit disposition.
- Supervisor tools work for direct reports and fail for non-reports or indirect descendants.
- A parent receives a lower supervisor's bounded roll-up without direct hidden access to lower workers.

### Communication

- Supervisor-to-worker and worker-to-supervisor messaging always works while the edge exists.
- Explicit peer edges permit symmetric ordinary messages.
- Missing or revoked peer edges reject communication before acceptance.
- Peers cannot delegate, revise, cancel, approve, or inspect each other.
- Human messages and commands reach every locally owned Pod through authenticated provenance.
- Spoofed sender identity or stale topology authority fails closed.
- Offline delivery, restart between outbox/inbox/ack, duplicate retries, collision, ordering, expiry, and queue saturation are deterministic.
- A new delegation received while active, waiting, or review-pending remains a distinct pending objective and never alters the resident run.
- A targeted revision reaches only its named current run; a mismatched or terminal target fails closed.
- Untargeted ordinary messages use the resident run or create a profile-based interaction when idle.
- Message bodies do not enter operational logs or telemetry.

### Supervision and review

- A supervised worker's complete result enters `review_pending`, closes Pi, and notifies its direct supervisor exactly once.
- Approval durably produces terminal completion.
- Revision durably reopens the same run/session with ordered authoritative input.
- Cancellation preserves existing intent-before-abort and terminal immutability.
- Human recovery works while a supervisor is stopped, failed, or removed.
- Restart at every result-proposal, notification, approval, revision, cancellation, and session-reopen seam cannot lose work or auto-approve.
- A nested supervisor approves its direct reports and separately proposes its own cluster completion to its parent.
- In-process intervention reaches the worker at a safe seam without exposing hidden reasoning or raw tool data.

### Capability isolation

- Supervisor tools do not expose or mutate subordinate files, credentials, connectors, or policies.
- Communication and topology changes do not add Pi tools except the fixed supervisor tool set on supervisor Pods.
- Delegated tasks fail or escalate normally when the worker lacks required capabilities; no authority escalation occurs.
- Shared files exist only when independently granted through Part 1.5.
- Connector and filesystem revocation remain effective across active coordination and restart.

### Full regression and installed paths

- Existing drain, cancellation, conversation, event, connector, wait/wake, rollover, model-access, capability, filesystem, shell, and shutdown tests remain green.
- `npm run check`, the complete suite, full and production audits, and `git diff --check` pass.
- A high-confidence scan finds no credential, control-token, message-content, objective, result, local-path, or tool-payload leakage.
- Installed acceptance launches at least one supervisor Pod and two worker Pods, delegates real deterministic work through Pi, intervenes during progress, receives a completion proposal, requests one revision, approves the corrected result, and proves final durable state.
- The same acceptance adds a lower supervisor cluster and one selected peer edge, proves allowed and forbidden communication, stops/restarts the local broker and Pods across pending deliveries, and reaches the same final topology/run truth.
- A no-cache production image exercises the shipped local coordination transport and exact installed entry points. No test-only message or agent path may substitute for the production runtime.

## Explicit non-goals

- No cross-device or cross-user communication.
- No mTLS mesh, private-network discovery, cloud relay, or remote failover.
- No cloud accounts, teams, billing, or entitlements.
- No dashboard implementation in this part.
- No configurable supervisor permission matrix.
- No multiple direct supervisors for one Pod.
- No supervision cycles.
- No implicit all-to-all peer communication.
- No filesystem access derived from hierarchy or messaging.
- No hidden reasoning or raw tool-output sharing.
- No separate orchestrator engine or non-Pi agent loop.
- No automatic connector or capability grant by a supervisor.

## Completion gate

Part 2 is complete only when real installed Pods on one device communicate through the authenticated durable local broker; the configured supervision forest and selected peer edges are the sole source of agent authority; supervisors actively observe, direct, revise, cancel, and approve their direct reports through Pi tools; supervised completion and nested clusters survive restart; capability boundaries remain intact; and the complete multi-Pod path is exercised in the built container/runtime without test-only substitutions.

At that point the generalized agent/Node/Pod foundation is complete and the remaining product work can build the frontend and surrounding service plumbing on stable, proven contracts.
