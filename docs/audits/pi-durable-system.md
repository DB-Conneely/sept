# Pi Durable migration — independent system audit, limited handover

Recorded 12 October 2026. **The full-system audit is incomplete.** A platform content-risk check stopped the turn; the orchestrator then prohibited further security/fault probes. Its detailed risk rationale was not supplied. This report preserves six already-recorded inherited defects and the completed source review. It is neither a complete audit nor a QA verdict, patch disposition or phase handover.

Loaded the exact BookedBy [audit_system role](/Users/sk3_neels/Desktop/bookedby/.codex/agents/audit_system.toml) and [delivery process](/Users/sk3_neels/Desktop/bookedby/docs/delivery-process.md), SEPT AGENTS/TypeScript rules, Ponytail full, the dated locked/native-extension/sequential scope amendments, current direction/contracts/as-built and bundle/phase-audit evidence. Sole sequential auditor; no subagents, product patch, Git mutation or deployment. Only this report and isolated nonsecret `system-audit/` artifacts were written.

## Candidate and cumulative boundary

- HEAD `66ad6333b5675ffa596b21028ef252370034e74f` plus inherited dirty/untracked foundation work; clean HEAD is not the candidate.
- Frozen 174-path identity `2a79a3ed96fd391da8846753bb073b09cc4b9bdd39adb5cedf97e6c675cd301c`; runtime/build identity `ac2b4acd05b32e7aaea3d4c1928bce01dda47ba69643cb162a0dd76b0e617fe8`.
- Candidate hashes, preserved 152-file baseline, 15 original history hashes and phase-patch hash match; HEAD is unchanged and diff-check exits 0. Original history was hashed only, never executed or inspected as content. Actual auth keys were not read. Both new audit reports are outside the frozen product map.
- Available cumulative provenance is the four commits beginning `8817244` (independent foundation), then `c907cd2`, `3121928`, `66ad633`, plus actual dirty/untracked source and the migration baseline. No separate earlier build-start filesystem snapshot was identified or invented.

Reviewed the current six production mechanisms and installed composition against cumulative delivered contracts: the source map contains 86 production files/12,854 physical lines. Read the current runtime/durable/ingress/model-access/Pi/observability owners, relevant tests and gates, cumulative Git inventory/history, and historical delivery reports. This broad source sweep does not complete the unfinished independent failure/capacity and exhaustive test review below.

Receipts: [integrity](</Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/system-audit/integrity-receipt.json>), [review boundary](</Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/system-audit/review-boundary.json>), [finding provenance](</Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/system-audit/finding-provenance.json>). The phase auditor independently matched all 258 installed production artifacts to in-memory TypeScript emission; I reused that [build comparison](</Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/phase-audit/installed-dist-identity.json>), without rebuilding or changing `dist`.

## Proved inherited findings

Each finding remains open. All six roots predate this migration and belong to the **system patcher**. Whole-file hashes or the baseline diff establish that provenance; migration changes to runtime forwarding/preflight do not change the defective authority/accounting logic.

### SA-1 — P1 — A blocked run can displace another waiting resident

Sources: [worker-policy.ts:121](/Users/sk3_neels/Desktop/Sept/src/runtime/worker-policy.ts:121), [worker.ts:321](/Users/sk3_neels/Desktop/Sept/src/runtime/worker.ts:321).

Installed HTTP sequence: A becomes model-blocked; B is admitted and waits, retaining the slot; a message to A returns **202** and runs A again. Both durable snapshots become waiting, while health now names A. Restart exits **1**, reporting two resumable runs. Three native provider calls were observed. This violates the documented requirement that a blocked run reopens only when the worker slot is genuinely idle.

Root: message authority carries only the active controller ID. A waiting resident has no active controller, so admission loses B's ownership and `launch()` overwrites the resident.

Smallest correction: include resident identity in the shared admission check and reject blocked reopening behind another resident before queueing/receipt claim. Preserve same-run waiting wake and duplicate receipts; regress direct and webhook routes with B dormant. Owner: inherited Part 1/foundation lifecycle, system patcher. [Recorded outcome](</Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/system-audit/resident-result.json>).

### SA-2 — P1 — A stale foreign-host lease does not prove its owner died

Source: [lease.ts:102](/Users/sk3_neels/Desktop/Sept/src/durable/lease.ts:102), takeover at [lease.ts:123](/Users/sk3_neels/Desktop/Sept/src/durable/lease.ts:123).

Two real installed local workers targeted the **same** persistent root. An external preload changed only the first process's `os.hostname()` to a synthetic container name. SIGSTOP for 5.6 seconds suppressed its heartbeat while its PID stayed alive. The second worker replaced the lease; after SIGCONT both reported accepting work, each task returned **202**, and two different native requests were concurrently active. Both workers exited **0** after fixture settlement.

Root: death verification skips foreign-host owners, then mtime alone authorizes removal. This models a paused old container and replacement contending for one root; it does not assert support for a distributed shared run store. No deployment occurred.

Smallest correction: fail closed when the owner cannot be verified dead, retaining same-host dead-PID/graceful-release recovery. Automatic replacement across foreign container identities needs an explicit recovery policy before changing authority; a distributed-lock redesign is not implied. Owner: inherited foundation lease mechanism, system patcher. [Outcome and exact owner records](</Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/system-audit/lease-result.json>), [hostname-only instrumentation](</Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/system-audit/foreign-host-preload.mjs>).

### SA-3 — P1 — SIGKILL erases active execution time from the hard budget

Source: [runtime-state.ts:78](/Users/sk3_neels/Desktop/Sept/src/runtime/runtime-state.ts:78), elapsed persistence at [runtime-state.ts:99](/Users/sk3_neels/Desktop/Sept/src/runtime/runtime-state.ts:99).

A run configured for **1,000 ms** remained in native provider work for two measured intervals totaling **1,155 ms**, each followed by real SIGKILL. Each pre-crash snapshot recorded `activeMilliseconds: 0`. A third worker made another native call, then settled waiting with only **132 ms** recorded and invocation count 1. The two crash exits are SIGKILL; final worker exit is **0**. Only positively dead generated lease mtimes were aged for immediate fixture restarts; owner bytes were unchanged.

Root: active time is added only in `finally`; abrupt death bypasses that write. Native request identity survives, but its SEPT execution-budget debit does not. This proves lost time across crashes, not duplicate completed tool effects.

Smallest correction: persist in-flight budget authority before dispatch and reconcile interrupted expenditure before another provider dispatch, while permitting settled-answer reuse and excluding dormant waiting time. Regress aggregate observed active time across process death, not merely invocation counters. Owner: inherited Part 1/foundation deadline accounting, system patcher. [Recorded timings/state/exits](</Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/system-audit/timeout-crash-result.json>).

### SA-4 — P1 — Public DNS names pass the private HTTP exception

Source: [custom-configuration.ts:50](/Users/sk3_neels/Desktop/Sept/src/model-access/custom-configuration.ts:50).

Installed `./sept models validate` accepted `http://127.sa-public-host.invalid/v1`, returned a configured provider/model and exited **0**. This hostname is not a private IP literal. No public network request or credential transmission was made.

Root: `startsWith("127.")`, equivalent prefixes and the 172 expression test hostname spelling rather than IP address structure. Publicly resolvable names can therefore receive the cleartext exception intended for deliberate private endpoints, including configurations that interpolate authentication.

Smallest correction: use the platform IP parser and actual address ranges, retaining the explicit trusted local hostnames. Add deceptive-DNS-name and valid-private-address cases through the installed validator. Owner: inherited Part 2 model-access safety, system patcher. [Observed acceptance](</Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/system-audit/private-http-result.json>).

### SA-5 — P2 — Failed session publication leaves the opened native owner unclosed

Sources: [session-lifecycle.ts:37](/Users/sk3_neels/Desktop/Sept/src/runtime/session-lifecycle.ts:37), [controller.ts:101](/Users/sk3_neels/Desktop/Sept/src/runtime/controller.ts:101).

External instrumentation of the installed worker injected one EIO at initial `running` state publication after the real Harness/host opened. The run became failed at invocation 0, the controller lease was released and the worker became idle. The trace records one Harness open and host creation, but **zero Harness close calls**, including after graceful worker stop (exit **0**). This establishes omitted owned cleanup; descriptor exhaustion or later model work was not observed.

Root: `sessions.open()` reconciles durable state before returning the host to `CycleController`. A reconciliation/abort failure occurs before `this.host` is assigned, so controller finalization has no owner to close.

Smallest correction: close a successfully acquired host if reconciliation fails before ownership transfer, preserving the original failure and guaranteed lease cleanup. Regress publication and cancellation-during-open failures using the real host. Owner: unchanged inherited foundation lifecycle, system patcher. [Outcome/trace](</Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/system-audit/open-failure-result.json>), [external instrumentation](</Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/system-audit/open-failure-preload.mjs>). An earlier preload attempt failed before listening because it treated the native Harness namespace as a class; it is not defect evidence.

### SA-6 — P2 — Unauthenticated model-access paths become operational payloads

Source: [http.ts:179](/Users/sk3_neels/Desktop/Sept/src/ingress/http.ts:179).

An unauthenticated GET to `/v1/model-access/SA-ROUTE-CANARY-PRIVATE-PAYLOAD` correctly returned **401**, but Pino emitted the exact path/canary in `http_route`. Worker exit was **0**. The canary is synthetic; no actual credential disclosure was observed. The same route value feeds spans/metrics in source; only the Pino sink was reproduced here.

Root: the model-access prefix branch returns arbitrary pathname text instead of a finite route template. Length/control checks at the telemetry sink do not remove short payloads.

Smallest correction: recognize only the installed provider/model/selection paths and classify every unknown suffix as `unmatched`, before instrumentation. Regress both authorized and unauthorized unknown paths. Owner: inherited foundation ingress/observability seam, system patcher. [Recorded log evidence](</Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/system-audit/telemetry-result.json>).

All six completed scenarios use the [retained installed driver](</Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/system-audit/installed-probes.mjs>) with isolated explicit environments, generated state and loopback providers. They exercise `./sept worker → authenticated HTTP → WorkerRuntime/default CycleController → PiSessionHost/Harness/SQLite`, or the installed model CLI. No production test branch was added.

## Current-phase overlaps and reviewed system boundaries

The original [current-phase report](/Users/sk3_neels/Desktop/Sept/docs/audits/pi-durable-current.md) remains unchanged. Its **PA-1** initial native-publication window, **PA-2** rotation operator-identity loss, **PA-3** dormant admission reader and **PA-4** pre-steer rotation replay belong to the **phase patcher**. Their existing proofs were inspected and source paths cross-referenced; none was rerun or duplicated as a new SA finding.

Traced both installed worker/direct-run compositions and model/auth CLI, shared direct/webhook admission, immutable model resolution, receipts, exact queues/checkpoint/handover consumption, leases, cancel/drain/stop, wait/wake, public replay/SSE and observability sanitization. Source preserves Pi ownership of providers/auth/generation/tools/storage/replay and SEPT ownership of domain authority. Native 1.1.0 registrations/resources use the approved declarative extension API; no legacy converter, compatibility engine or provider client was found. Trusted plugins remain application code; repository instructions do not grant execution authority. The seven parity tools and shell remain unconfined, as already recorded for the separate confinement plan; this is not a new migration finding or security pass.

B2's recorded final gate is **145 compiled + six meta tests, zero failures and audit vulnerabilities**. Its ten installed fault receipts and final no-cache image `sha256:f400cb127ac0435e461b73879e2e13859fe4373cafc0e12c95fd637ec3388ef9` record exit 0 for worker/restart/direct paths. These are prior source-bound evidence, not checks rerun by this auditor. [B2 handover](</Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/b2/handover.md>). The export-reference meta-test establishes name references rather than behavior or runtime reachability; PA-3 and the omitted seams above show why its green result cannot substitute for audit. No other dormant component or broad consolidation requirement is claimed.

## Unfinished review, prerequisites and closure

The platform stop prevented completion of independent full-system qualification. Remaining targets include persistent failures after durable handover and automatic retry/resource growth; lifetime operator/conversation recovery collections and repeated blocked/reopen terminal seams; remaining cross-route receipt/publication failures and exhaustive cumulative test coverage. These are **unverified review targets, not additional proved findings**. No further probes were run after the stop.

Fresh full gates/container qualification were not repeated without a source change. Live model usefulness, external-provider failures and OAuth/subscription refresh remain unverified: usable credentials in the selected Pi agent directory and provider connectivity are external prerequisites; credential availability was not inferred. Deterministic fixtures prove owned mechanics only. Historical coding-agent reports describe previous APIs; the native locked contract supersedes those API names. Void integrations, future backend/supervision, SDK packaging, confinement implementation and deployment are excluded.

All 10 recorded owned child PIDs are absent; all seven recorded listener ports refuse connections; no matching audit Node worker/driver remains; no fixture lease file remains. Successful drivers await worker/provider cleanup. Some worker ports and the failed-preload PID were not separately recorded, so closure also checked matching owned Node commands. No container was created and no cleanup signal was needed. All evidence/files were preserved. [Owned closure](</Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/system-audit/owned-closure.json>).

**Count: six proved inherited findings — four P1, two P2 — plus four existing phase-report cross-references. None is resolved. The independent full-system audit remains incomplete.**

## 12 October 2026 — independent source-only completion appendix

Checkpoint: **15:04:39 UTC**. Loaded the exact BookedBy `audit_system` role/delivery process, SEPT AGENTS/TypeScript rules, Ponytail full and the dated lock/native-extension/sequential amendments. This continuation completes only the four previously unfinished **source** targets using actual source/tests and saved evidence. No new runtime, fault, security or network probe was run; the platform-stopped work was not retried. The original interruption, findings and limitations above remain intact. This is advisory review, without a QA verdict or phase wrap.

### Completed coverage and dispositions

| Previously unchecked question | Source disposition |
| --- | --- |
| Persistent failures after durable handover; automatic retry/resource growth | Traced controller failure classification → execution settlement → worker relaunch → session reconciliation/native construction. Native generation retry is explicitly capped at three; it does not govern the worker relaunch in **SSA-1**. Existing **SA-5** cleanup omission can compound that loop. No resource-exhaustion measurement is claimed. |
| Lifetime operator/conversation recovery; repeated blocked/reopen seams | Traced queue compaction, historical exact-message proof, conversation reconciliation/markers, terminal publication, wake and startup. Public retention remains bounded, while recovery collections have **SSA-2** and repeated terminal publication has **SSA-3**. |
| Remaining cross-route receipt/publication failure logic | Traced direct/webhook ingress → shared message authority/queue/wake and pending/complete receipts. Stable task IDs support retry after task creation/receipt-completion interruption; an already complete receipt returns its stored result. Partial operator acceptance before wake instead establishes **SSA-4**. Pre-rotation publication failure remains covered by B2's saved receipt; **PA-1/2/4** remain separate native publication/replay defects. |
| Cumulative meaningful tests/configuration/dependencies/history | Inventoried all **40 test files / 145 named compiled cases**, with **49 TypeScript test/helper files**, and reviewed the relevant test bodies, helpers and installed caller assertions alongside the earlier audit. Reviewed all six meta tests, compiler/lint/local-rule/build/launcher/container wiring and lockfile pins. The four available commit identities and preserved dirty/untracked baseline remain the cumulative provenance boundary; no earlier snapshot or ancestry is invented. |

Coverage gaps are concrete: controller tests exercise successful replacement/adoption and a repaired one-shot consumption failure, but do not bound repeated worker-level failure/relaunch. Queue tests cover 64 pending records and public retention tests cover 1,024 projection events; neither exercises lifetime operator recovery after repeated consumed batches. Conversation tests cover wait/restart/wake/complete and single terminal metadata, without a second blocked boundary after reopening. Webhook tests cover pending **task** receipts and fully completed operator duplicates, without enqueue/projection failure followed by retry before wake. Constructor/name-reference assertions remain supporting checks; neither the export meta-test nor `typeof` assertions establish ownership, installed reachability or these failure contracts. Existing native recovery assertions retain the exact five/two/four provider-call expectations; their green evidence does not close **PA-2/4**'s omitted request/identity seams. No further dormant component beyond **PA-3** is established.

### Additional inherited source findings — all open

Each finding below is a **source-proved logical defect**, not a newly reproduced runtime experiment. All four roots exist in the preserved foundation/Part 1 baseline and belong to the **system patcher**. Eight supporting files are byte-identical to baseline; the two changed worker/recovery files add native preflight/fencing without changing these roots. [Verified provenance](</Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/system-source-review/finding-provenance.json>).

#### SSA-1 — P1 — Persistent handover recovery failure triggers unlimited immediate relaunch

Sources: [controller.ts:143](/Users/sk3_neels/Desktop/Sept/src/runtime/controller.ts:143), [worker-execution.ts:76](/Users/sk3_neels/Desktop/Sept/src/runtime/worker-execution.ts:76), [worker.ts:276](/Users/sk3_neels/Desktop/Sept/src/runtime/worker.ts:276), [session-lifecycle.ts:50](/Users/sk3_neels/Desktop/Sept/src/runtime/session-lifecycle.ts:50).

A non-limit failure with phase `handover_durable`/`replacing` deliberately leaves status `active`. The execution wrapper returns on a non-lease error, clears its owner and calls `finishController`; that callback immediately launches every still-active run again. A persistent native-open/resource/reconciliation failure therefore re-enters the same path indefinitely, without delay or retry ceiling. Session opening precedes invocation-limit/deadline accounting, so those budgets do not terminate this recovery loop; epoch remains unchanged when replacement cannot publish. Repeated attempts append diagnostics and may reopen native owners. **SA-5** separately proves failure to close a host acquired before reconciliation; descriptor or memory exhaustion here remains unmeasured.

Root: successful wake settlement and failed recoverable handover settlement share an unconditional active-run relaunch decision. Smallest correction: distinguish those settlement causes and stop or explicitly bound failed recovery attempts while retaining durable handover and resident authority; preserve legitimate wake-after-close relaunch. Regress a persistent failure through the worker's actual settlement/relaunch caller, with bounded attempts, ownership cleanup and recovery evidence. This is an inherited runtime retry correction, not a new scheduler.

#### SSA-2 — P2 — Operator recovery materializes lifetime history outside the configured bounds

Sources: [conversation-store.ts:222](/Users/sk3_neels/Desktop/Sept/src/durable/conversation-store.ts:222), [conversation-store.ts:249](/Users/sk3_neels/Desktop/Sept/src/durable/conversation-store.ts:249), [conversation-store.ts:193](/Users/sk3_neels/Desktop/Sept/src/durable/conversation-store.ts:193), installed startup at [worker-recovery.ts:21](/Users/sk3_neels/Desktop/Sept/src/runtime/worker-recovery.ts:21).

`recoverOperatorMessages` retains every distinct embedded historical operator record in one Map; `recordedOperatorIds` retains every historical projection marker in a Set and is also reconstructed on each operator projection. Neither collection applies a count/byte guard or discards acknowledged historical entries. Valid consumed batches accumulate in append-only checkpoint/handover evidence even after the pending queue and public conversation compact. Thus 64 pending records / 512 KiB and 1,024 events / 4 MiB do not bound these recovery allocations or repeated scans. The invocation cap limits completed work, but permits lifetime histories far larger than those bounds. No OOM or latency threshold was measured.

Root: streaming JSONL parsing feeds collections indexed by lifetime history rather than a bounded reconciliation workset. Smallest correction: reconcile in bounded batches/streaming form while consulting durable projection markers, preserving exact idempotency and never reviving text intentionally expired from retention. Keep historical authority intact; an extra store redesign is unnecessary. Add consumed-batch/restart coverage across the retention boundary, including allocation/workset bounds and absence of duplicate projection.

#### SSA-3 — P2 — Reopening a blocked run suppresses its next terminal event

Sources: [conversation-store.ts:123](/Users/sk3_neels/Desktop/Sept/src/durable/conversation-store.ts:123), [conversation-store.ts:185](/Users/sk3_neels/Desktop/Sept/src/durable/conversation-store.ts:185), [transitions.ts:262](/Users/sk3_neels/Desktop/Sept/src/runtime/transitions.ts:262), [worker-messages.ts:64](/Users/sk3_neels/Desktop/Sept/src/runtime/worker-messages.ts:64).

The first blocked transition records `terminal-blocked` and a lifetime marker keyed only by status. An admitted message reopens that same run and appends an active event. If the next valid assistant control blocks again, `ensureTerminal` finds the old blocked marker and appends nothing: there is no terminal cursor for this new boundary, and replay can end at the reopening's active event. GET terminal metadata and SSE's snapshot-based disconnect still disclose the current blocked status; this is missing durable lifecycle evidence, not a claim that the stream stays open or native work continues.

Root: status-wide deduplication treats separate terminal occurrences as one crash replay. Smallest correction: key terminal event and recovery marker by the authoritative lifecycle occurrence (for example epoch/invocation), idempotently repairing that same occurrence across restart. Regress blocked → reopen → blocked, then restart and reconnect from the first terminal cursor; assert exactly one event for each distinct boundary.

#### SSA-4 — P1 — Operator webhook retry can complete a receipt without completing the wake

Sources: [operator-queue.ts:101](/Users/sk3_neels/Desktop/Sept/src/durable/operator-queue.ts:101), [worker-messages.ts:30](/Users/sk3_neels/Desktop/Sept/src/runtime/worker-messages.ts:30), [webhook-router.ts:77](/Users/sk3_neels/Desktop/Sept/src/ingress/webhook-router.ts:77), startup selection at [worker-recovery.ts:58](/Users/sk3_neels/Desktop/Sept/src/runtime/worker-recovery.ts:58).

For an idle model-blocked (or dormant waiting) run, queue fsync precedes conversation projection and wake. A projection/event failure after queue acceptance leaves the fixed webhook message ID durable and its receipt pending, without changing the dormant snapshot. On identical retry, `existing` is present: duplicate reconciliation can repair the projection, but `WorkerMessages.send` skips wake for every existing ID. The router then marks the receipt complete and returns duplicate success. The message remains pending with no controller. Waiting startup may repair its wake; blocked startup excludes the run, so restart alone does not repair that case. This follows the actual shared ingress path; no failure injection was performed in this continuation.

Root: an existing queue identity is treated as evidence that its whole admission/wake transaction completed. Smallest correction: for an existing **unconsumed** accepted message, reconcile any unfinished wake/launch under live slot/readiness/limit authority before completing its receipt; consumed duplicates stay inert. Coordinate the slot check with **SA-1** so repair cannot displace another resident. Cover both dormant states and enqueue/projection/wake interruption, including retry and restart outcomes. The original text/ID and consumption proof must remain unchanged.

### Integrity, evidence limits and closure

The frozen **174-path** source map still matches `2a79a3ed96fd391da8846753bb073b09cc4b9bdd39adb5cedf97e6c675cd301c`; the **143-path runtime/build map** still matches `ac2b4acd05b32e7aaea3d4c1928bce01dda47ba69643cb162a0dd76b0e617fe8`. The preserved **152-file source baseline** matches its hashes, and HEAD remains `66ad6333b5675ffa596b21028ef252370034e74f`. Original history/credential contents were not read: the prior integrity receipt remains the hash-only evidence for the 15 history files. All four native direct dependencies and their lockfile entries remain exactly **1.1.0**, with registry integrity records. No source, installed build, Git or product configuration was changed.

The original report remains the exact **16,472-byte prefix**, SHA256 **`0810e36dd6b967fda1f779e618bea63d437412573230d1ea41744b4079533b6f`**. [Continuation integrity/closure](</Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/system-source-review/integrity-and-closure.json>); [static test inventory](</Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/system-source-review/test-inventory.json>).

**Independent SOURCE review is now complete for this frozen candidate**, incorporating the earlier broad review and the four completed targets above. Full empirical/live qualification remains incomplete. The original **SA-1–6** and **PA-1–4** stay open; this appendix adds **SSA-1–4 (two P1, two P2)**, all open. There is no audit approval, patch disposition or QA verdict.

B2's literal **145+6 / audit 0** gate, final no-cache container/fault receipts and phase/system installed receipts remain valid evidence for their unchanged source-bound scenarios. They were not rerun or enlarged by this source review. Missing empirical checks are persistent recovery retry/cleanup/resource behavior, lifetime reconciliation bounds, repeated blocked terminal evidence and partial operator-admission retry/restart seams. Fresh QA owns integrated installed proof and affected gates/container checks after repairs; source inference cannot satisfy the wired-and-exercised completion rule. Live model usefulness, external-provider failures and OAuth/subscription refresh still require usable selected Pi-agent credentials and provider connectivity. Deterministic fixtures supply no live-provider qualification. Ambient filesystem/shell confinement remains a separate plan; packaging, supervision, cloud/distributed work and deployment remain excluded.

This continuation started **no worker, provider, listener, container or other long-lived owned process**. Read-only shell commands all exited; there is no new runtime cleanup or listener check to report. Earlier owned-closure evidence is preserved without recasting it as a fresh probe. Only this appendix and private source-review notes were written.


## 12 October 2026 — current-phase patch cross-reference

The sole phase patcher independently verified and corrected **PA-1–4**; the [current-phase disposition appendix](pi-durable-current.md) records source owners, actual installed crash/capture/latch/direct-run results and gate **152+6 / audit 0**. Original report prefixes remain preserved. This is phase-patch evidence awaiting fresh integrated QA, not a system or phase verdict. **SA-1–6 and SSA-1–4 remain open**, reserved for the next system patcher; no inherited root was changed. Final container and live-provider qualification remain QA's recorded responsibilities.

## 12 October 2026 — inherited system patch dispositions

The sole sequential system patcher loaded the exact BookedBy patch role/delivery process, SEPT rules and Ponytail full, independently verified the ten inherited roots and corrected them through the existing installed worker. Original finding/report prefixes remain preserved. This is correction evidence awaiting fresh QA; it supplies no QA verdict or phase wrap.

| Findings | Shared correction and evidence |
| --- | --- |
| SA-1, SSA-4 | Resident identity now participates in live message/launch authority. Unconsumed duplicate input repairs projection and wake before receipt completion; consumed duplicates remain inert. Installed direct/webhook requests behind another waiting resident return 409 and restart adopts that resident. Generated projection-marker interruptions from both blocked and waiting return 400, retry returns duplicate 200, exact input is consumed once, and no second slot launches. `resident-result.json`, `operator-retry-result.json`. |
| SA-2 | Lease age never authorizes takeover when owner death is unverifiable. Installed stale foreign owner is refused unchanged; positively dead local PID recovers and graceful stop releases the lease. `lease-result.json`. Cross-container identity recovery requires operator proof that the old owner cannot execute and an explicitly authorized lease-retirement procedure; no distributed lock or automatic foreign-host takeover is introduced. |
| SA-3 | An in-flight active start is fsynced before dispatch and debited under controller ownership on restart. Native model/tool hooks refuse exhausted durable budget while settled answers remain reusable. Installed real SIGKILL/restart makes no second provider call and blocks with timeout; a separate real native-settlement SIGKILL plus generated exhausted budget reuses its answer with one total call. `timeout-crash-result.json`, `settled-budget-result.json`; actual native regression tests cover both settled reuse and admitted-but-unsubmitted dispatch refusal. Crash death time is unknowable: the bounded debit conservatively includes uncertain downtime; dormant waiting has no in-flight start and is excluded. |
| SA-4 | HTTP exceptions use Node's IP parser and numeric private ranges, retaining explicit localhost/container-local names. Installed deceptive DNS spelling is rejected with exit 1 and no network request; private-range edge cases pass focused tests. `private-http-result.json`. |
| SA-5, SSA-1 | Session opening closes an acquired native host if publication/abort fails before controller ownership transfers. Failed controller settlement no longer automatically relaunches recoverable handover; its active resident remains busy for explicit retry/restart. Installed publication failure observes one Harness close. Persistent replacement failure makes one attempt, rejects another task, and restart completes epoch 2 with three total provider calls. `open-failure-result.json`, `recovery-failure-result.json`. |
| SA-6 | Only installed canonical model-access routes become operational route labels; unknown suffixes classify as unmatched. Installed unauthenticated canary path returns 401 without appearing in logs; the same shared classifier feeds metrics/spans. `telemetry-result.json`. No separate exporter-sink experiment is claimed. |
| SSA-2, SSA-3 | Operator reconciliation retains at most 64 records / 512 KiB of text per batch and consults durable markers before projection, preserving expired text. Terminal IDs bind status/epoch/invocation, with legacy-marker compatibility and idempotent recovery. Installed restart over 1,089 historical consumed inputs and a 1,024-event retained projection repairs one missing marker without resurrection or duplication. Blocked/reopen/blocked emits two distinct terminal events; SSE reconnect and restart preserve each once. `history-result.json`, `operator-retry-result.json`. Bounded batches may require repeated disk scans of append-only evidence; no whole-store redesign or throughput claim is made. |

Receipts are under `/Users/sk3_neels/Documents/ChatGPT/Sept 3/.sept-pi-durable-migration-evidence-20261012/system-patch/`. Final `npm run gate` actually exits 0: **164 compiled + six meta tests**, zero failures/skips/cancellations and audit vulnerabilities. `git diff --check` passes. Ten successful deterministic installed scenarios exercise `./sept worker → authenticated ingress → default controller → PiSessionHost/Harness/SQLite`, or the installed model validator. Earlier failed fixture/style attempts remain preserved. Existing five/two/four provider-call assertions and phase-patch paths remain intact. Exact source/runtime maps, original baseline152/history15 preservation, audit-prefix checks and owned cleanup are recorded in `handover-source.json`.

All ten inherited findings have correction and available owned-functionality evidence for fresh QA review. Integrated no-cache container qualification, live-provider usefulness/failures/auth refresh, the sole QA verdict and any remaining qualified external prerequisites remain with fresh QA. The platform-stopped unfinished experiments were not resumed. No Git mutation, deployment, history deletion, real secret access, public request, user-history execution or extra framework occurred.

Frozen-source rebinding: all six original inherited installed scenarios also pass against the final gate-produced build; `final-{resident,lease,open-failure,timeout-crash,telemetry,private-http}-result.json` are the latest receipts. The earlier correction receipts, failed attempts and original failure evidence remain intact. The other four installed correction receipts were already exercised after the final production changes.


## 12 October 2026 — sole integrated QA disposition: BLOCKED

Fresh QA reviewed the integrated corrections and reproduced their current-source installed contracts. PA-1–4, SA-1–6 and SSA-1–4 have accepted correction evidence: all 14 focused drivers/19 scenarios pass after the final runtime change. Exact first-open identity, operator capture/late arrival, steer placement, resident slot/wake retry, lease refusal/recovery, crash budget/settled reuse, acquired cleanup/failed recovery, endpoint/telemetry bounds and history/terminal/SSE outcomes remain evidenced. QA additionally repaired retained live provider-session transports through supported per-UUID Pi cleanup; actual configured live direct CLI/default-worker artifact tasks now exit 0. Original findings and failed receipts remain intact.

This is **not phase completion**: the definitive post-edit gate exits 1 (163/165 compiled; two worker-startup waits), and the final-source uncached Docker build fails with containerd sync I/O error on a measured 100%-full Data volume. The successful earlier container predates QA's transport correction. Prior green gates cannot override the red required final gate. No disk-filling retry, deletion/prune, Git mutation, deployment or original-history execution followed. The [sole QA phase handover](../as-built/pi-durable-migration.md) and private `qa/handover-source.json` bind current source, preserved baseline/history, emission equality, actual exits and closure. Continuation QA must repeat only the required gate/final-source uncached installed container qualification after capacity recovery, then issue a follow-up verdict. Live controlled outages/expiring-credential refresh and separate confinement remain qualified as documented.


## 12 October 2026 — same-owner recovered final QA: VERIFIED

After approved capacity recovery, the same sole QA completed the exact missing checks on unchanged runtime: final gate165+6/audit0, fresh no-cache current-source image and actual installed container worker/restart/direct paths all exit0. Image264/host423 artifacts match verified source emission; owned execution is closed. The earlier BLOCKED gate/build/disk chronology and all original findings remain intact. **Final locked-migration verdict: VERIFIED**, with controlled outage/auth-refresh and separate confinement qualifications retained. The phase record and `qa/recovered-1945/handover-source.json` bind exact source, preservation and outcomes; no other agent may override the verdict.
