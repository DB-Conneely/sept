# Complete SEPT codebase audit — 2026-09-14

## Executive summary

SEPT has a compact, intelligible architecture and correctly delegates the agent loop, provider access, tools, session management, steering, and token accounting to Pi. Its strongest paths are fail-closed HTTP authentication, bounded HTTP bodies and lifecycle logs, provider-reported context rotation, disabled auto-compaction, and the handover-before-session-replacement ordering. The tracked dependency graph is locked, the test suite passes, the production image builds and runs unprivileged, and no production dependency vulnerability was reported by `npm audit --omit=dev`.

The audit and independent cross-check identified seven high-severity defects in slot ownership, project trust, graceful shutdown, malformed-state adoption, hard-limit message admission, handover recovery ordering, and unstable live-process lease identity. Nine medium-severity findings covered unbounded append-only retrieval/queue growth, a first-create fsync gap, unconstrained workspace selection, bearer secrets in process arguments, missing production-`PiSessionHost` coverage, assistant payload leakage through lifecycle logs, controller work before successful bind, loss of accepted message whitespace, and unbounded assistant control records. Three low-severity findings covered public-schema divergence, Node compatibility, and text-based hard-limit inference.

No critical-severity finding was identified. No production code was changed during the audit phase. The final section records the subsequent narrow remediation and verification of every confirmed finding.

## Severity model

- **Critical:** immediate credential compromise, arbitrary unauthenticated code execution, or systemic irreversible loss under normal operation.
- **High:** a core product guarantee can be defeated, durable/restart correctness can fail, or trusted worker code can execute unexpectedly.
- **Medium:** meaningful availability, durability, security-boundary, reproducibility, or verification weakness requiring a bounded correction.
- **Low:** real but limited contract or compatibility defect with contained consequence.

## Independent cross-check disposition

The 2026-09-14 cross-check confirmed H-01, H-02, H-03, M-01, M-02, M-03, M-04, M-06, L-01, and L-02. H-04 was retained in narrowed form: SEPT must fully validate format-version-2 manifests and snapshots and fail closed for malformed v2 or partial v2 run state, while continuing to ignore known legacy manifest-only runs, hidden `.creating-*` directories, and the reserved `webhook-receipts` directory. It added H-05, H-06, H-07, M-07, M-08, M-09, M-10, and L-03 from independently reproduced failure cases, and required M-03 confinement to cover resident restart adoption as well as new ingress. The original M-05 was removed from confirmed remediation and is recorded only as a residual supply-chain/reproducibility risk because immutably pinning externally maintained image and Debian inputs is outside this repository's current correction scope.

## Scope

The audit covered the complete tracked repository as of 2026-09-14:

- Public composition and launch paths: `sept`, `src/cli.ts`, `package.json`, `package-lock.json`, and `tsconfig.json`.
- Durable contracts and storage: every file under `src/durable/`.
- HTTP and webhook interfaces: every file under `src/ingress/` and `docs/worker-api.md`.
- Worker/controller and Pi lifecycle: every file under `src/runtime/` and `src/pi-integration/`, plus the relevant installed Pi 0.85.1 settings, resource-loader, extension-loader, session-runtime, and compaction implementations.
- Observability: every file under `src/observability/` and `docs/observability.md`.
- Tests: all tracked files under `test/`, including composition, ingress, runtime, Pi SDK, telemetry, and architecture-boundary coverage.
- Operational and repository artifacts: `Dockerfile`, `.dockerignore`, `.gitignore`, `scripts/clean.mjs`, `README.md`, all tracked architecture/contract/direction documentation, `LICENSE`, `NOTICE`, and `AGENTS.md`.
- Installed production dependency resolution, declared licenses, container contents/user/command/health check, and public CLI/worker wiring.

`AGENTS.md` and `docs/project-direction.md` were treated as governing requirements. The pre-existing user modification adding the ordered implementation sequence in `docs/project-direction.md` was preserved. Finding sections cite the audited pre-remediation baseline; the final disposition table separately cites the corrected current lines and tests.

## Methods and checks

- Read every tracked file and traced request admission through durable storage, worker ownership, controller transitions, Pi session creation/rotation/disposal, telemetry, and recovery.
- Compared documented public contracts with runtime validation and state transitions.
- Inspected installed Pi 0.85.1 implementation where SEPT depends on trust/resource loading, session replacement, compaction, and usage accounting.
- Exercised the installed public worker and exact container command/health behavior through the repository suite and focused probes.
- Reproduced, in isolated temporary state roots:
  - two `WorkerRuntime` instances accepting and controlling different active runs under one state root;
  - a syntactically valid but schema-invalid `state.json` being omitted from resumable-run adoption, leaving the worker idle;
  - `SeptService.stop()` resolving while a deliberately blocked active host remained open;
  - execution of a project-local `.pi` extension when Pi services are created with `projectTrusted: true`;
  - four distinct same-process lease start values across a 4 ms tight-loop window, followed by stale-age self-takeover;
  - restart adoption of a durable workspace outside the configured root, including a symlink escape; and
  - a 65,537-character complete summary that could be checkpointed into an unreadable next snapshot.
- Confirmed that a CLI `--token` value remains visible in process arguments while the process is running.
- Reviewed tracked content for credential-like material without reading or emitting live credentials; matches were documentation placeholders and test-only fixtures.
- Inventoried declared licenses for the locked dependency tree.

### Audit-phase checks run

These are the pre-remediation audit checks; the 59-test and container results after correction are recorded under **Final remediation disposition**.

| Check | Result |
|---|---|
| `npm test` | Passed: 37/37 tests |
| `npm audit --omit=dev` | Passed: 0 reported vulnerabilities |
| `docker build -t sept:audit .` | Passed |
| Container Pi import probe | Passed under Node v22.23.2 for `createAgentSessionRuntime` and `calculateContextTokens` |
| Container startup without `SEPT_TOKEN` | Failed closed as intended |
| Container identity/command/health inspection | Runs as uid/gid 10001; expected `./sept worker` command and authenticated health check present |
| `git diff --check` before report | Passed |
| Locked dependency license inventory | 113 MIT, 61 Apache-2.0, 13 BSD-3-Clause, 8 ISC, 2 BlueOak-1.0.0, 1 Unlicense, 1 0BSD; none undeclared |

## Findings summary

| ID | Severity | Finding |
|---|---|---|
| H-01 | High | The single active slot is enforced only inside one `WorkerRuntime` instance |
| H-02 | High | SEPT force-trusts every task workspace, enabling project-local Pi extension execution |
| H-03 | High | Worker shutdown exits without settling the active controller or disposing its Pi host |
| H-04 | High | Invalid durable run schemas can be ignored and free a resident slot during restart |
| H-05 | High | Input accepted during the last permitted invocation can be stranded by the hard cap |
| H-06 | High | Handover messages are consumed before the recovery-forcing phase is durable |
| H-07 | High | Recomputed process start values let a live process take over its own stale lease |
| M-01 | Medium | Append-only event/message retrieval and the operator queue are unbounded |
| M-02 | Medium | First creation of append-only evidence is not parent-directory-fsynced |
| M-03 | Medium | The public task contract accepts any existing filesystem path as a workspace |
| M-04 | Medium | CLI bearer tokens can be supplied in process-visible arguments |
| M-06 | Medium | The real-SDK test bypasses the production `PiSessionHost` lifecycle implementation |
| M-07 | Medium | Raw assistant terminal text is written to the publicly retrievable lifecycle log |
| M-08 | Medium | Adoption/controller execution starts before the HTTP listener has bound successfully |
| M-09 | Medium | Accepted operator text is silently trimmed before durable persistence and delivery |
| M-10 | Medium | Assistant work and handover controls can exceed their durable state/record bounds |
| L-01 | Low | Direct HTTP schemas are looser than the webhook and documented strict contract |
| L-02 | Low | SEPT's Node engine range is broader than its pinned Pi dependency supports |
| L-03 | Low | Hard-limit exhaustion is inferred from agent-authored reason text |

## High-severity findings

### H-01 — The single active slot is enforced only inside one `WorkerRuntime` instance

**Evidence**

- `WorkerRuntime.initialize()` scans resumable runs and assigns only its own in-memory `resident` field; there is no state-root ownership claim (`src/runtime/worker.ts:27-44`).
- New-task admission checks only that in-memory field and then creates a run (`src/runtime/worker.ts:69-80`).
- Controller leases are stored inside each individual run directory, so controllers for two different runs never contend (`src/durable/store.ts:224-257`).
- The standalone `run` command creates a `RunStore` and starts a controller directly, bypassing `WorkerRuntime` slot admission altogether (`src/cli.ts:45-66`).
- The focused probe initialized two runtimes against the same empty root; each accepted a different task and both hosts became active.

**Consequence**

Two worker processes, two service objects, or a service plus `sept run` can concurrently own different runs beneath one state root. This violates the core single-slot guarantee, permits concurrent mutation/tool activity that operators were told cannot happen, and leaves the next restart facing multiple resumable runs and refusing adoption. Per-run leases prevent duplicate control of one run but do not protect the worker slot.

**Smallest suitable correction**

Add one durable, exclusive state-root worker/slot lease and require every executing entry point (`worker` and `run`) to acquire it before scanning or creating runs and hold it through controller shutdown. Reuse the existing lease ownership/staleness rules rather than introducing a distributed scheduler. Add a two-process acceptance test proving the second owner fails closed before task creation.

### H-02 — SEPT force-trusts every task workspace, enabling project-local Pi extension execution

**Evidence**

- The production session factory unconditionally constructs Pi settings with `{ projectTrusted: true }`, then loads session services for the caller-selected workspace (`src/pi-integration/session.ts:59-70`).
- Pi includes `.pi/extensions` from the project whenever `isProjectTrusted()` is true (`node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js:1977-1993`).
- Pi loads those extension modules through `jiti.import()` and immediately calls their exported factory (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:409-427,458-480`).
- The isolated probe placed a side-effecting extension in a temporary workspace and observed that side effect during service creation, before any model-directed tool call.

**Consequence**

Merely assigning a repository can execute repository-controlled TypeScript with the full SEPT process authority. In the documented container that process can read the Pi agent directory containing authentication state and write the mounted state/workspace. This silently collapses the distinction between repository content and trusted worker code and is more direct than the expected, model-mediated coding-tool boundary.

**Smallest suitable correction**

Create SEPT sessions with project trust disabled and explicitly disable project extensions/packages for unattended worker sessions while retaining required context-file behavior. Do not invent a second extension loader. Add a production-`PiSessionHost` test containing a sentinel `.pi/extensions` module and prove the sentinel never executes.

### H-03 — Worker shutdown exits without settling the active controller or disposing its Pi host

**Evidence**

- `SeptService.stop()` only closes the HTTP server and immediately records the worker as stopped (`src/ingress/service.ts:56-61`). It has no call into `WorkerRuntime` and does not await the runtime's private active promise.
- The controller is the owner that closes the Pi host and releases the run lease, and it does so only in its `finally` block (`src/runtime/controller.ts:195-203`).
- Signal handlers await `service.stop()` and telemetry, then force normal process termination with `process.exit(0)` (`src/cli.ts:36-42`).
- The composition test validates SIGTERM only while idle (`test/composition/cli.test.ts:33-75`); the focused blocked-host probe showed `stop()` resolving while the active host had not been closed.
- Graceful stop is explicitly the first sanctioned implementation tranche (`docs/project-direction.md:33-39`).

**Consequence**

SIGINT/SIGTERM can terminate an in-flight Pi/tool operation without allowing it to reach a durable checkpoint, close the SDK runtime, or release its lease. The process emits a successful `worker.stopped` lifecycle record even though active work remains unsettled. Restart can recover the run as active, but it cannot know whether an interrupted external side effect completed, which is precisely the unsafe ambiguity the durability boundary is intended to minimize.

**Smallest suitable correction**

Add a worker stop operation that first rejects new admissions, then waits for the active controller to reach its existing durable completion/finally boundary and confirms host disposal and lease release. Make `SeptService.stop()` await it before logging success, and remove the unconditional `process.exit(0)` from the normal graceful path. Cover SIGTERM during a blocked invocation through `./sept worker`.

### H-04 — Invalid durable run schemas can be ignored and free a resident slot during restart

**Evidence**

- `jsonFile<T>()` performs JSON parsing followed only by a TypeScript cast; `manifest()` and `snapshot()` therefore do no runtime schema validation (`src/durable/store.ts:64-67,115-117`).
- `listRuns()` silently skips run directories with a missing manifest/state file or a manifest whose only checked property is not `formatVersion: 2` (`src/durable/store.ts:260-273`).
- Adoption recognizes a run only when the unchecked `status` value exactly equals `active` or `waiting` (`src/runtime/worker.ts:27-35`).
- A focused restart probe replaced an active run's status with an invalid enum value while keeping valid JSON; initialization returned `none`/idle and task admission was then available.

**Consequence**

A torn, partially migrated, or semantically corrupt durable record can make an unfinished resident run disappear from ownership decisions. The worker can accept a new task instead of failing closed for operator recovery, violating restart adoption and single-slot safety. Invalid values in other snapshot or manifest fields can also flow into limits and transitions because the same unchecked casts are used throughout.

**Smallest suitable correction**

Runtime-validate the complete format-version-2 manifest and snapshot schema at the storage boundary, including exact required fields, enum values, finite integer bounds, matching directory/run IDs, and path/string types. During `listRuns()`, fail closed for malformed v2 state and partial directories that contain v2 run evidence; continue to ignore known legacy manifest-only runs, hidden `.creating-*` directories, and the reserved `webhook-receipts` directory. Add malformed, missing, semantically invalid, legacy, hidden-temporary, and reserved-directory restart fixtures.

### H-05 — Input accepted during the last permitted invocation can be stranded by the hard cap

**Evidence**

- At the audit baseline, invocation count was durably incremented before awaiting Pi, but message admission inspected only lifecycle status and reason text, not the manifest's remaining invocation budget (`src/runtime/controller.ts`, baseline lines 87-101; `src/runtime/worker.ts`, baseline lines 154-161).
- After a terminal response, pending late input changed the control back to `continue`; the next loop then enforced `maxInvocations` before constructing a prompt (`src/runtime/controller.ts`, baseline lines 145-166,75-77).
- The accepted reproduction used `maxInvocations=1`: one message was acknowledged during invocation one, completion was deferred, and the controller blocked at the cap with one undelivered pending message.

**Consequence**

SEPT could acknowledge durable operator input it had no legal invocation budget to deliver. The run then became a hard-limit block with exact text still pending, contradicting its at-least-once delivery guarantee.

**Smallest suitable correction**

Before first-time persistence, reject input when the durable invocation or timeout budget is exhausted and reject input racing an invocation in the final permitted epoch, where a rotation could otherwise strand it. Keep duplicate lookup idempotent and do not weaken any cap. Cover the exact last-invocation race plus epoch and typed timeout seams.

### H-06 — Handover messages are consumed before the recovery-forcing phase is durable

**Evidence**

- At the audit baseline, `persistHandover()` wrote JSON, Markdown, and `handover_written`, then called `consumeMessages()`, and only afterward updated `phase` to `handover_durable` (`src/durable/store.ts`, baseline lines 177-186).
- Restart replacement depends on seeing `handover_durable` or `replacing`; a `running` snapshot reuses the recorded active session (`src/runtime/controller.ts`, baseline lines 30-60).
- The accepted injected-fault reproduction failed the final phase update after consumption: exact handover evidence existed, pending input was empty, the phase remained `running`, and restart reused the predecessor without `newSession()`.

**Consequence**

A crash/failure in the ordering gap could acknowledge and remove input yet fail to force successor creation. The predecessor could resume despite having emitted its final handover, violating fresh-session rotation and overstating the durability guarantee.

**Smallest suitable correction**

Commit `handover_durable` after the handover files/event but before message consumption. Preserve active handover/replacement state on non-limit faults so restart must perform or adopt exactly one successor; keep pending text for at-least-once delivery if consumption did not finish. Add fault/restart proof.

### H-07 — Recomputed process start values let a live process take over its own stale lease

**Evidence**

- At the cross-check baseline, both `RunStore.acquireLease()` and `acquireStateRootLease()` recomputed `processStartedAt` as `Date.now() - floor(process.uptime() * 1000)` for every acquisition (`src/durable/store.ts`, cross-check baseline lines 400 and 443).
- Same-process ownership required exact equality of that recomputed value, while the live-PID branch explicitly skipped the current PID (`src/durable/store.ts`, cross-check baseline lines 406-415 and 455-462).
- The accepted tight-loop reproduction produced four distinct values over 4 ms. Once the lease mtime was older than five seconds, a second acquisition by the same live PID unlinked and replaced its own lease.

**Consequence**

An event-loop stall or delayed heartbeat can make a live lease appear stale. A second controller/service acquisition in the same process can then bypass the ownership guard, invalidating the single-slot exclusion that H-01 relies on.

**Smallest suitable correction**

Create one immutable module-level process identity and use it for both run and state-root lease owners so every acquisition by that process compares identically. Add a regression that ages both lease files past the takeover threshold and proves reacquisition is still rejected.

## Medium-severity findings

### M-01 — Append-only event/message retrieval and the operator queue are unbounded

**Evidence**

- `jsonLines()` reads an entire file, splits every line, and parses every record into memory (`src/durable/store.ts:69-74`).
- Event pagination limits only the returned slice after `allEvents()` has loaded the complete event history (`src/durable/store.ts:131-135`).
- Message lookup and pending-queue calculation repeatedly load all messages and all events (`src/durable/store.ts:137-161`).
- Sending a message performs fixed-ID lookup where applicable, append, then another full pending-queue scan (`src/runtime/worker.ts:93-100`).
- HTTP limits each request body but applies no pending-message count, queue-byte, event-file, or total evidence bound (`src/ingress/service.ts:101-129,146-159`).
- The public contract promises bounded retrieval and strict limits (`AGENTS.md:13`; `docs/worker-api.md:13-15,63`).

**Consequence**

An authenticated producer can enqueue an arbitrary number of 32 KiB messages while an invocation is blocked. Disk use grows without a cap, and ordinary status, wake, delivery, deduplication, and paginated event reads become O(total history) in memory and CPU. The 1,000-event response cap therefore does not make retrieval bounded and can eventually make the worker unavailable.

**Smallest suitable correction**

Enforce explicit pending-message count and byte limits before append, returning a retryable capacity response. Read event pages and log tails with bounded file/range scanning rather than materializing complete JSONL files. Maintain the exact durable operator evidence; do not solve this by silently dropping accepted records. Add saturation and large-history tests.

### M-02 — First creation of append-only evidence is not parent-directory-fsynced

**Evidence**

- `appendSynced()` opens with `O_CREAT`, writes, and fsyncs the file, but never fsyncs its parent directory (`src/durable/store.ts:58-62`).
- Atomic replacement helpers do fsync their containing directory, demonstrating that directory-entry durability is otherwise intentional (`src/durable/store.ts:25-55`).
- The first operator message is written through `appendSynced()` and acknowledged after a separate queued event that contains only its ID, not its text (`src/durable/store.ts:141-155`; `src/ingress/service.ts:125-129`).
- Exact text is copied into an event only when a later delivery attempt/checkpoint/handover occurs (`src/durable/store.ts:164-196`).

**Consequence**

After acknowledgement of the first direct or webhook operator message, power loss can preserve the fsynced queued event while losing the newly created `operator-messages.jsonl` directory entry. Recovery then has evidence that an ID was queued but no exact operator text to redeliver, violating durable acceptance and exact-message evidence. The same helper creates other append-only files, so first-create ordering is not uniformly durable.

**Smallest suitable correction**

In `appendSynced()`, detect whether the path was newly created and fsync the parent directory after the file fsync/close and before returning. Add an ordering test around the first append. Destructive power-loss fault injection was not performed, so the test should assert syscall/order behavior rather than claim to simulate hardware semantics.

### M-03 — The public task contract accepts any existing filesystem path as a workspace

**Evidence**

- Request validation resolves the supplied `workspace` and checks only `existsSync()` (`src/ingress/validation.ts:9-15`). It does not require a directory, canonicalize symlinks for an allowlist, or bind the path to a configured assignment root.
- The HTTP task route exposes that value directly to authenticated callers (`src/ingress/service.ts:101-104`).
- Pi receives the resulting path as both session-manager cwd and runtime cwd (`src/pi-integration/session.ts:69-70`).
- The production image makes `/pi-agent`, `/state`, and `/workspace` available to the same uid and documents a worker assigned to a mounted workspace (`Dockerfile:18-19,27-33`; `README.md:77-89`).

**Consequence**

A bearer credential authorizes task execution against any path visible to the SEPT process, including state or agent-configuration locations, rather than only the worker's assigned repository. Because a coding-agent task intentionally has powerful filesystem/shell tools, this makes the bearer token a host-wide execution authority and defeats the stated per-worker isolation/least-filesystem-access boundary.

**Smallest suitable correction**

For server mode, configure one canonical allowed workspace (or one allowed root), resolve it with `realpath`, require a directory, and reject task paths outside that boundary, including symlink escapes. Keep broader arbitrary paths only for the explicitly local `sept run` interface if needed. The deployment should continue mounting only the assigned workspace and state/agent volumes.

### M-04 — CLI bearer tokens can be supplied in process-visible arguments

**Evidence**

- The generic option parser accepts every `--key value` pair (`src/cli.ts:15-22`).
- Both `worker` and `health` prefer `options.token` over `SEPT_TOKEN` (`src/cli.ts:36-38,76-80`).
- The focused process probe confirmed the supplied value remained in the operating-system process argument list.

**Consequence**

Using the supported `--token` form can disclose the worker bearer credential through process listings, service-manager diagnostics, shell history, or process telemetry. The documented examples use the environment, but the undocumented argument remains an active unsafe boundary.

**Smallest suitable correction**

Reject/remove `--token` and accept the secret only through `SEPT_TOKEN` or a purpose-built secret file descriptor/file option with permission checks. Keep error output limited to the option name, never the value, and add a CLI test proving the argument form is rejected.

### M-06 — The real-SDK test bypasses the production `PiSessionHost` lifecycle implementation

**Evidence**

- The test imports Pi primitives and `ROTATION_STEER`, but not `PiSessionHost` (`test/pi-integration/session.test.ts:6-12`).
- It independently recreates settings, services, session runtime, context sampling/steering, `newSession()`, and disposal (`test/pi-integration/session.test.ts:71-111`).
- Runtime/controller and ingress tests inject `SessionHost` doubles rather than constructing the production host (for example `test/runtime/controller.test.ts:20-49,69-101`; `test/ingress/webhook.test.ts:26-64`).
- Production behavior—including auth/model resolution, project-trust settings, event subscription, compaction violation handling, finalized-usage capture, and subscription rebinding—lives in `PiSessionHost` (`src/pi-integration/session.ts:50-159`).

**Consequence**

The suite can pass while the exact installed lifecycle path used by `./sept worker` is broken or unsafe. The forced-project-trust defect is present in both duplicated factories and therefore was not detected; future divergence in usage/steer/rebind/disposal logic can likewise evade the acceptance claim in `README.md`.

**Smallest suitable correction**

Introduce only the narrow dependency injection needed for `PiSessionHost.create()` to use the deterministic registered provider/model runtime, then drive `PiSessionHost.run()`, `newSession()`, and `close()` itself. Retain controller doubles for state-machine tests, but add one installed public worker test whose host is the production implementation and whose assertions cover finalized usage, one steer, fresh session replacement, no compaction, and disposal.

### M-07 — Raw assistant terminal text is written to the publicly retrievable lifecycle log

**Evidence**

- At the audit baseline, the controller appended up to 64,000 characters of unvalidated assistant output as `assistant_terminal.text` before parsing the control object (`src/runtime/controller.ts`, baseline line 121).
- `GET /v1/tasks/:runId/log` returned that lifecycle file to any bearer-authenticated caller (`src/ingress/service.ts`, baseline line 122).
- The accepted reproduction placed a unique marker in a control summary and retrieved it from `/log`.

**Consequence**

Assistant output can contain source fragments, tool results, operator text, or other sensitive repository content. Persisting it in a broadly retrievable lifecycle log creates an unnecessary second payload store and contradicts the observability contract.

**Smallest suitable correction**

Record only bounded metadata such as response byte count and steering state. Keep parse errors payload-free and test the public log endpoint with a unique assistant marker.

### M-08 — Adoption/controller execution starts before the HTTP listener has bound successfully

**Evidence**

- At the audit baseline, `SeptService.start()` called `worker.initialize()` before `server.listen()` (`src/ingress/service.ts`, baseline lines 38-47).
- Initialization launches an adopted active controller immediately (`src/runtime/worker.ts`, baseline lines 27-44).
- With the requested port occupied, the accepted reproduction observed an adopted controller execute and complete even though `start()` rejected with `EADDRINUSE`.

**Consequence**

A process that operators reasonably regard as failed to start can still invoke Pi and tools, causing unobserved side effects without a reachable health or control endpoint. Any newly added root lease could also be stranded on startup failure.

**Smallest suitable correction**

Bind first, expose no ready routes until initialization succeeds, and close/release ownership on every post-bind startup failure. Add an occupied-port fixture proving zero host/controller calls and no lease.

### M-09 — Accepted operator text is silently trimmed before durable persistence and delivery

**Evidence**

- At the audit baseline, both durable enqueue and webhook validation assigned `text.trim()` before creating the accepted message (`src/durable/store.ts`, baseline lines 141-155; `src/ingress/webhook.ts`, baseline lines 43-50).
- The accepted reproduction sent 28 characters with meaningful edge whitespace and found only 24 characters persisted.

**Consequence**

Webhook hashes describe one payload while messages, events, checkpoints, handovers, and prompts carry another. Whitespace can be meaningful in code, quoting, Markdown, or exact operator evidence, so acknowledgement did not preserve the accepted instruction.

**Smallest suitable correction**

Use trimming only to decide whether text is empty; preserve the original accepted string everywhere else. Share the same unsafe-control and size validator between direct and webhook ingress and test tabs, line endings, and leading/trailing whitespace through both routes.

### M-10 — Assistant work and handover controls can exceed their durable state/record bounds

**Evidence**

- At the cross-check baseline, `validateWork()` and `validateHandover()` checked only value types and array shape; their summary, action, item-size, item-count, and aggregate payload sizes were unbounded (`src/durable/store.ts`, cross-check baseline lines 523-551).
- Snapshot validation capped `reason` at 65,536 characters, but `RunStore.update()` wrote the merged object without validating it first (`src/durable/store.ts`, cross-check baseline lines 185-215 and 263-267).
- The accepted reproduction returned a valid 65,537-character `complete` summary. It could be checkpointed and assigned to `state.reason`, after which the next snapshot read and `listRuns()` failed validation.

**Consequence**

A syntactically valid assistant response could make SEPT persist state that its own v2 reader rejects, breaking controller completion and restart adoption. Unbounded arrays could also exceed the 2 MiB JSONL record limit only after the response had passed semantic validation.

**Smallest suitable correction**

Bound each work/handover string, each array count, and the aggregate control size before any checkpoint or handover write. Validate every merged snapshot before atomic replacement. Add an oversized terminal-control regression proving rejection leaves readable, fail-closed state and no checkpoint.

## Low-severity findings

### L-01 — Direct HTTP schemas are looser than the webhook and documented strict contract

**Evidence**

- Webhook envelopes require exact keys and nested task objects reject unknown keys (`src/ingress/webhook.ts:25,32-35,53-72`).
- `validateRequest()` validates known values but never rejects unknown request keys (`src/ingress/validation.ts:5-35`), so `POST /v1/tasks` silently accepts misspelled/extra fields.
- The direct message route checks only that `message` is a string (`src/ingress/service.ts:125-129`), and `enqueueMessage()` applies trimming/length only (`src/durable/store.ts:141-155`); the webhook path additionally rejects unsafe control characters (`src/ingress/webhook.ts:44-50`).
- Documentation says nested schemas reject unknown fields and operator messages reject unsafe controls (`docs/worker-api.md:59,63`).

**Consequence**

Equivalent public routes accept different payloads. Producer mistakes can be acknowledged while ignored, and control characters rejected through webhook ingress can enter the same durable/operator prompt path through the direct endpoint. This is a strictness and interoperability defect, though bearer authentication and body/message size limits contain its impact.

**Smallest suitable correction**

Use one exact task-key validator and one operator-message sanitizer for direct and webhook routes. Reject unknown direct message fields as well. Add parity tests that submit the same invalid payload to both interfaces.

### L-02 — SEPT's Node engine range is broader than its pinned Pi dependency supports

**Evidence**

- SEPT declares Node `>=22.0.0` (`package.json:7-9`; `package-lock.json:30-32`).
- The pinned Pi package declares Node `>=22.19.0` (`package-lock.json:64-66`).
- The image currently happened to resolve Node v22.23.2, but its floating tag does not define that patch in repository source (`Dockerfile:1,11`).

**Consequence**

An installation on Node 22.0–22.18 satisfies SEPT's advertised engine while violating its required runtime's engine. npm may only warn, leaving operators with unsupported or failing installed behavior.

**Smallest suitable correction**

Set SEPT's engine floor to `>=22.19.0` (or the exact higher floor required by the locked dependency graph), update the lockfile through npm, and exercise that minimum in CI/container verification.

### L-03 — Hard-limit exhaustion is inferred from agent-authored reason text

**Evidence**

- At the audit baseline, message admission treated a blocked run as exhausted when its free-form `reason` matched `/Maximum Pi|timeout reached/` (`src/runtime/worker.ts`, baseline lines 154-161).
- The reason is the assistant's control summary for normal `blocked` outcomes (`src/runtime/controller.ts`, baseline lines 168-173).
- The accepted reproduction used an operator-resolvable summary containing “remote dependency timeout reached”; message admission incorrectly rejected it as a hard limit.

**Consequence**

Ordinary agent prose can accidentally make a resolvable run permanently non-reopenable, while future wording changes to genuine limit errors could make exhaustion reopenable. Lifecycle authority should not depend on prose.

**Smallest suitable correction**

Persist a bounded typed terminal cause for invocation, epoch, timeout, agent block, and controller failure. Base admission on that cause and structural counters, retaining compatibility with existing v2 snapshots that lack the optional field.

## Confirmed strengths and non-findings

- HTTP authentication fails closed at construction and is checked before URL routing or body consumption; comparison is length-checked and timing-safe (`src/ingress/service.ts:34-40,91-97,120-124`). Unauthenticated health checks correctly receive 401.
- Request bodies are limited both by declared length and streamed bytes, JSON content type is required, and response errors avoid raw payloads (`src/ingress/service.ts:159-163,173-190`).
- Agent lifecycle logs are tail-bounded on disk and retrieval is capped at 1 MiB (`src/durable/store.ts:392-405`). This does not offset M-01 for events/messages.
- Rotation uses finalized assistant `message_end` usage through Pi's `calculateContextTokens()` and the active model context window; unavailable/failed samples defer rather than use a local estimate (`src/pi-integration/session.ts:110-150`). Auto-compaction is disabled on creation and rebind (`src/pi-integration/session.ts:67-78,153-166`).
- The audit baseline did persist handover JSON, Markdown, event, consumption evidence, and state before `host.newSession()`, but the cross-check correctly narrowed the false strength in that statement: message consumption preceded the recovery-forcing `handover_durable` state. H-06 addresses that unsafe internal ordering. No cumulative spend or local character/token heuristic drove rotation.
- Webhook receipts store hashes/routing results rather than raw source payloads and use deterministic IDs for crash retry (`src/ingress/webhook.ts:82-87,102-148`; `src/ingress/webhook-router.ts:28-52,81-96`).
- Telemetry uses bounded allowlisted fields and keeps operational JSON on stderr; tests cover payload/credential exclusion and exporter containment. No credential was found in tracked production content or the built image.
- The module boundaries remain simple and Pi-native. The architecture test prevents cross-mechanism internal imports, and no duplicate provider client, agent loop, tokenizer, compactor, TUI, scheduler, or control plane was found.
- Exact npm versions and lockfile integrity are present. `npm audit --omit=dev` found no known production advisory; this is not treated as proof of general supply-chain safety.
- The image runs as uid/gid 10001 and startup refuses an empty token. The documented example uses a read-only root filesystem and explicit persistent state/Pi/workspace mounts.
- `.gitignore` excludes dependencies, builds, local state, environment files, logs, editor data, and common temporary artifacts (`.gitignore:1-13`). The only pre-audit tracked modification was the operator's intentional `docs/project-direction.md` change.

## Final remediation disposition

All seven high-, nine medium-, and three low-severity confirmed findings are resolved in the working tree. M-05 remains removed from remediation. The corrections stay within SEPT's owned composition, durability, ingress, and lifecycle boundaries; no provider client, agent loop, tokenizer, compactor, scheduler, or alternate Pi runtime was introduced.

| ID | Final disposition and concrete current evidence |
|---|---|
| H-01 | **Resolved.** A heartbeat state-root lease is acquired before scan/create and held through controller settlement (`src/durable/store.ts:447-493`; `src/runtime/worker.ts:33-75`). Both installed `worker` and local `run` participate (`src/cli.ts:56-77,94-104`). Public-path contention and release are covered at `test/composition/cli.test.ts:34-81` and `test/runtime/controller.test.ts:357-368`. |
| H-02 | **Resolved.** Production Pi settings use `projectTrusted: false` while retaining context files (`src/pi-integration/session.ts:64-73`). The production host test proves a sentinel `.pi/extensions` module never executes, `AGENTS.md` is loaded, and native tool/steer/session behavior still works (`test/pi-integration/session.test.ts:38-106`). |
| H-03 | **Resolved.** Service stop closes admission, waits for `WorkerRuntime.stop()`, and releases root ownership only after the active promise (`src/ingress/service.ts:71-87`; `src/runtime/worker.ts:67-75`). Controller stop checks occur only at safe boundaries and host disposal remains in `finally` (`src/runtime/controller.ts:72-75,129-135,145-186,205-212`). The installed `./sept worker` SIGTERM test holds a real production Pi invocation open, proves the process/lease remain alive, then proves checkpoint, host/controller settlement, lease removal, and clean exit (`test/composition/cli.test.ts:83-146`). |
| H-04 | **Resolved as narrowed.** Exact runtime validators cover every v2 manifest/snapshot field, bounds, dates, enums, terminal cause, state/phase combinations, run ID, and handover consistency (`src/durable/store.ts:131-223,267-269`). Discovery fails closed for partial/malformed v2 evidence while preserving hidden, reserved, unrelated, and legacy manifest-only directories (`src/durable/store.ts:496-522`; `test/durable/store.test.ts:18-48`). |
| H-05 | **Resolved.** Admission now checks structural invocation/timeout exhaustion and rejects racing input during an invocation in the final epoch before enqueue (`src/runtime/worker.ts:209-221`). Exact max-invocation and epoch races plus typed timeout rejection retain zero pending messages (`test/ingress/webhook.test.ts:490-548`). Caps remain enforced by the controller (`src/runtime/controller.ts:216-238`). |
| H-06 | **Resolved.** `persistHandover()` commits JSON, Markdown, handover event, then `handover_durable` state before consumption (`src/durable/store.ts:358-367`). Non-limit faults after that phase preserve active recovery state (`src/runtime/controller.ts:189-203`). Injected consumption failure and restart prove the pending exact message survives, one successor is created, and the message is delivered (`test/runtime/controller.test.ts:107-124`). |
| H-07 | **Resolved.** One immutable module-level identity supplies both lease owner types, so repeated acquisitions compare the same PID/host/start tuple (`src/durable/store.ts:17-21,407-415,447-463`). The aged-lease regression proves both run and root reacquisitions by the live process fail closed (`test/durable/store.test.ts:75-92`). |
| M-01 | **Resolved.** JSONL records are stream-scanned with a 2 MiB per-record bound; event pages stop at the requested bounded result (`src/durable/store.ts:71-123,283-290`). Pending input is capped at 64 messages/512 KiB and compacted only after exact proof, with event fallback preserving fixed-ID idempotency (`src/durable/store.ts:293-355`). Saturation returns HTTP 429 (`src/ingress/service.ts:159-163`; `test/durable/store.test.ts:50-72`; `test/ingress/webhook.test.ts:673-685`). |
| M-02 | **Resolved.** First append creation now fsyncs the append file and then its parent directory before returning (`src/durable/store.ts:71-79`). All installed controller/message tests traverse this helper; ordering-sensitive checkpoint/handover tests pass. |
| M-03 | **Resolved.** Server workspaces are realpath-canonical directories confined beneath one configured root, and adoption/reopen rechecks that boundary (`src/ingress/validation.ts:24-73`; `src/runtime/worker.ts:38-45,93-99,196-207`). Direct and webhook paths cover files, outside paths, and symlink escapes (`test/ingress/webhook.test.ts:591-650`); restart adoption of a durable symlink escape fails before host creation and releases ownership (`test/ingress/webhook.test.ts:652-671`). Docker explicitly assigns `/workspace` (`Dockerfile:27-40`). |
| M-04 | **Resolved.** Worker and health secrets come only from `SEPT_TOKEN`; `--token` is not an allowed option (`src/cli.ts:15-42,59,116-117`). Installed CLI coverage proves rejection without echoing the supplied value (`test/composition/cli.test.ts:148-157`). |
| M-06 | **Resolved.** The deterministic SDK test now constructs and drives production `PiSessionHost` itself through `run()`, one native `steer()`, `newSession()`, rebind, and `close()` (`src/pi-integration/session.ts:51-167`; `test/pi-integration/session.test.ts:38-106`). The installed SIGTERM test also drives production host creation through `./sept worker` (`test/composition/cli.test.ts:83-146`). |
| M-07 | **Resolved.** Assistant lifecycle logging retains only bounded byte-count/steering metadata, and parse errors omit parser payload snippets (`src/runtime/controller.ts:122`; `src/durable/store.ts:525-528`). The authenticated public `/log` test excludes a unique control-summary marker (`test/ingress/webhook.test.ts:550-571`). |
| M-08 | **Resolved.** `server.listen()` succeeds before `worker.initialize()`; pre-ready routes return 503 and every post-bind failure closes the server and stops ownership (`src/ingress/service.ts:43-68,123-125`). The occupied-port fixture proves zero host creations/invocations and no controller/root lease (`test/ingress/webhook.test.ts:573-589`). |
| M-09 | **Resolved.** Shared message validation uses trim only for emptiness and returns the original string (`src/ingress/validation.ts:40-50`; `src/ingress/webhook.ts:51-63`). Durable storage, hashes, prompts, event proof, checkpoint/handover evidence, and ID lookup retain that exact value (`src/durable/store.ts:307-367`; `test/ingress/webhook.test.ts:591-630`). |
| M-10 | **Resolved.** Work and handover validators cap each string at 65,536 characters, each array at 64 items, and each complete control at 512 KiB before durable use; merged snapshots are validated before atomic replacement (`src/durable/store.ts:271-275,531-564`). Unit coverage exercises work and handover bounds, and the controller regression proves a 65,537-character terminal summary creates no checkpoint and leaves readable failed state (`test/durable/store.test.ts:94-104`; `test/runtime/controller.test.ts:232-243`). |
| L-01 | **Resolved.** One task-key list and operator validator serve both routes; direct message bodies require exactly one `message` key, unsafe controls are rejected, and workspace values must be directories (`src/ingress/validation.ts:5-75`; `src/ingress/webhook.ts:5,51-63`; `src/ingress/service.ts:129-156`). CLI parsing uses command-specific allowlists and rejects unknown/duplicate/missing options (`src/cli.ts:15-38`). |
| L-02 | **Resolved.** SEPT and its lockfile now declare Node `>=22.19.0`, matching Pi 0.85.1 (`package.json:7-9`; `package-lock.json:29-31`). The built image ran the installed path on Node v22.23.2. |
| L-03 | **Resolved.** `RunSnapshot.terminalCause` is a validated typed field (`src/durable/contracts.ts:13-14,48-63`; `src/durable/store.ts:193-223`); controller outcomes persist it and admission no longer matches reason prose (`src/runtime/controller.ts:169-203`; `src/runtime/worker.ts:209-221`). Tests distinguish a genuine timeout cause from an agent block whose summary says “remote dependency timeout reached” (`test/ingress/webhook.test.ts:531-548`). |

### Final verification evidence

| Gate | Final result |
|---|---|
| `npm run check` | Passed with no TypeScript diagnostics. |
| `npm test` | Passed: 59/59 tests, including installed `./sept`, production `PiSessionHost`, fault/restart, hard-limit races, stable live-process leases, state-root contention, resident workspace confinement, oversized control rejection, bind failure, exact text, queue saturation, and graceful active SIGTERM. |
| `npm audit` | Passed: 0 vulnerabilities across the full installed dependency graph. |
| `docker build -t sept:local .` | Passed. Build-stage `npm ci`, TypeScript build, production prune, and image export all succeeded. |
| Installed container health/identity | Passed: health became `healthy`; `./sept health` succeeded; uid was 10001; Node was v22.23.2; configured user was `10001:10001`; command included `--state-dir /state/runs --workspace-root /workspace`; health check used `./sept health`; `SEPT_WORKSPACE_ROOT=/workspace` was present. |
| Container startup without `SEPT_TOKEN` | Failed closed with status 1 and the required-token diagnostic. |
| `git diff --check` | Passed. |

No live authenticated provider request, deployment, commit, push, merge, or external-system mutation was performed.

## Residual supply-chain and reproducibility risk

The container continues to use the floating `node:22-bookworm-slim` tag and unversioned Debian repository packages (`Dockerfile:1,11,13-15`). Consequently, rebuilding one Git revision at different times can resolve different external runtime artifacts. The independent cross-check removed this from confirmed remediation: this repository currently has no owned digest/package refresh mechanism with which to keep immutable external pins safely current. The risk should be managed by the user's CI/CD provenance, scanning, and reviewed base-image update process rather than by a one-time stale pin in this remediation.

## Coverage limitations

- No live authenticated provider request was made, to avoid cost, external mutation, and credential exposure. Pi behavior was exercised with the installed SDK and a deterministic provider double.
- Live credential contents were not opened or printed. Authentication-path existence/status was inspected only through safe diagnostics and no-token startup behavior.
- Power-loss semantics were reviewed from syscall ordering; destructive filesystem or kernel fault injection was not performed. M-02's audit finding was based on the concrete baseline absence of a parent-directory fsync, and the correction adds that syscall ordering.
- Docker was built and inspected locally but not deployed, pushed, signed, or scanned by an external container service. Deployment is explicitly outside scope.
- `npm audit` covers advisories known to npm for the installed production graph; it does not establish provenance, maintainer trust, or OS-image safety.
- License results are package-declared metadata, not a legal opinion.

## Correction order used

1. Implemented graceful stop first, as required by `docs/project-direction.md`, with the lifecycle hook needed to hold/release state-root ownership safely.
2. Enforced state-root single ownership across both public execution modes and stabilized live-process lease identity.
3. Disabled unattended project trust/extension execution and constrained new and resident server workspaces.
4. Failed closed on invalid durable schemas, bounded assistant controls, validated every state update, and closed the first-create fsync gap.
5. Bounded queue/history retrieval and added the exact production-`PiSessionHost` acceptance path.
6. Removed argv token support, unified public schemas, and aligned the Node engine floor.

The corrections remained narrow, preserved Pi ownership of agent/runtime concerns, and were exercised through `./sept` and the installed SDK path. No later project-direction tranche (drain, cancel, ACP, or generalized rollover) was started.
