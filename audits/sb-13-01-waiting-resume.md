# SB-13-01: qualified waiting-run resume

Fresh QA verdict on 25 October 2026: **UNVERIFIED overall; functionality passes.**
The sole remaining blocker is the mandatory production dependency audit. No push,
publication or deployment has occurred for this amendment.

## Delivered correction

Implementation checkpoint: `efe6fc949de20db6c7c9e77769d9ac96996135d8`.
Waiting closes the runtime while retaining its run/session. Re-entry now accepts
the existing namespace only when its complete captured run, cwd, profile,
daemon/socket, kernel and lifetime ownership matches qualified authority.
Explicit namespace replacement still requires a fresh generation. Rejected
ownership acquires no watcher or namespace-shutdown authority; accepted startup
rechecks live policy before opening native execution.

The amendment preserves existing waiting/wake behavior, exact operator evidence,
idempotency, single-slot ownership, model/budgets, durable ordering and cleanup.
The user's later scope instruction limits proof to Sept in isolation. Cortex
changes and its consumer upgrade remain separate work.

## Qualification

Fresh implementor, frozen candidate, fresh task auditor, report-specific patcher
and fresh write-capable QA completed their assigned sequence. Only QA awarded
the verdict above. The original regression fails on the old fresh-generation
guard. Strict type/lint/format checks, 357 runtime tests and 31 meta-tests pass;
fresh QA additionally passed 23 focused tests with zero failures/skips.

Installed public SDK, CLI and no-cache image CLI paths exercise native Pi
waiting, the exact accepted reply, same-session continuation, a real native file
effect and completed durable state after joined shutdown. A bounded live Codex
journey also passes. Rejected captured ownership fails before dispatch two;
dormant cancellation rejects later input and produces no resumed effect.

Audit caught premature observation of image completion and proof-harness hash
drift. The patcher corrected observation ordering and bound the exercised
harness identity; the same-image rerun remains complete after joined shutdown.
Failed attempts remain retained and excluded. QA inspected 22 retained containers:
all stopped with PID 0. Production source was unchanged during audit/patch/QA.

Unpublished local candidate: `sept-agent@0.1.0`, archive SHA-256
`8b7ba70d64950dfc9c2b1358c01258da178ff17e70e6bb404a3d78ef1728bc7b`.
Source baseline version 0.1.0 remains deliberate; no published-version claim is
made. Detailed private reports and authoritative evidence are retained under
`/var/tmp/sept-sb13-01-20261025-_by98g7w/`, including `qa.md`,
`qa-verdict.json`, `task-audit.md` and `patcher.md`.

## Release blocker

The full gate exits 1 at `npm audit --omit=dev`: unchanged Pi coding-agent 1.1.0
pins undici 8.10.2. The audit reports one high and one moderate package entry;
package.json and package-lock.json remain byte-identical to the task baseline.
The relevant advisories are [GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685),
[GHSA-f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472) and
[GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c).

The bug report requires preserving exact dependency pins. Separate authorization
has been requested for a bounded dependency-security amendment covering installed
npm consumers and Docker. No pin change, audit exclusion or gate waiver was
introduced. The conditional main push and existing GitHub release workflow remain
pending a resolved gate and QA release acceptance.
