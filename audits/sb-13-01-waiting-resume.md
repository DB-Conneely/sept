# SB-13-01: qualified waiting-run resume

Fresh release QA on 25 October 2026 awarded **VERIFIED** for source
`27317e5d6cfab879ff65ff814ce63cc68b65f527`, including the separately authorized
B1 dependency-security correction. The earlier functional-pass/UNVERIFIED verdict
was blocked only by B1 and is superseded by this qualification. Publication and
public-artifact verification follow through the existing GitHub release workflow.

## Delivered correction

Implementation checkpoint: `efe6fc949de20db6c7c9e77769d9ac96996135d8`.
Waiting closes the runtime while retaining its run/session. Re-entry now accepts
the existing namespace only when its complete captured run, cwd, profile,
daemon/socket, kernel and lifetime ownership matches qualified authority.
Explicit namespace replacement still requires a fresh generation. Rejected
ownership acquires no watcher or namespace-shutdown authority; accepted startup
rechecks live policy before opening native execution.

Exact operator evidence, idempotency, single-slot ownership, original model and
budgets, durable ordering, cancellation and joined cleanup remain protected.
The user explicitly deferred Cortex changes and limited this task to Sept in
isolation; no Cortex source, installation or dependency pin was changed.

## Authorized dependency correction

The user subsequently authorized fixing the current production-audit blocker
and releasing the result. Stock Pi 1.1.0 pins vulnerable undici 8.10.2. The sealed
Pi archive changes only that dependency field to 8.12.2: all 1,253 other files
and upstream executable bodies remain byte-identical. Original integrity,
reproduction instructions and effective-distribution integrity are recorded in
`vendor/`. The existing native-search overlay and its provenance are unchanged.

Source and Docker select the sealed distribution. The canonical
`npm run pack:consumer` command bundles only Pi and undici, projecting Pi's
existing exact dependency pins into the consumer manifest so other dependencies
resolve normally and share the native SDK classes. It excludes duplicate raw
archives and platform binaries. There are no install hooks or new provider
runtime. Direct source `npm pack` refuses an unsealed artifact. Installed package
metadata reports Pi's actual 1.1.0 version rather than a dependency file spec.

Both npm 10.9.4 and 11.21.0 passed clean consumer installation, `npm ci`, dependency
validation, audit, public SDK health/auth checks and strict declarations. The
source full audit and production audit report zero vulnerabilities. This closes
[GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685),
[GHSA-f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472) and
[GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c)
on the selected undici edge.

## Qualification

Fresh implementor, frozen candidate, fresh task auditor, report-specific patcher
and fresh write-capable QA completed the requested sequence. A fresh B1 patcher
then delivered the authorized security correction; a newly frozen candidate went
to fresh release QA, which alone awarded VERIFIED. No production change occurred
during final QA. The original regression fails on the old fresh-generation guard.

The final full gate passed strict type/lint/format checks, 357 runtime tests,
34 meta-tests and production audit, with zero failures or skips. Independent QA
validated the upstream archive, sole metadata edit, compressed-byte reproduction,
639 shipped source/emitted files, both sealed dependency trees, image code and
its existing search overlay. Unaffected earlier security/race/mismatch/cancel
proofs were reused; earlier QA had also passed 23 focused tests.

Three fresh final-candidate journeys passed: installed public CLI, actual
`/app/sept` CLI inside the no-cache image, and one bounded live
openai-codex/gpt-6.1-sol/xhigh CLI journey. Each exercised native waiting, the exact
accepted reply, same run/session/manifest/binding, a native write of the exact
marker, idle/absent lease before external inspection, and LAST durable terminal
complete after joined worker shutdown. Each native SQLite database has three
completed generation tasks and one completed tool, all in conversation 2, two
done submissions and no unsettled tasks. The deterministic journeys additionally
proved the trusted native ToolTask.afterTool hook fires exactly once, confirming
shared class identity. A separate installed upstream dispatcher/fetch probe
passed; that supporting probe is distinct from Sept's SDK lifecycle.

All 30 inspected task containers were exited/PID 0. Worker, provider-fixture and
compatibility-probe shutdowns joined; worker/controller leases were absent.

Local unpublished candidate: `sept-agent@0.1.0`, 8,711,765 bytes, archive SHA-256
`d3046ccfbe890c342d7267fad9852d571a9eee1993d5bf9baf50a044fa0eaeab`.
Source baseline 0.1.0 is deliberate; CI allocates the public release version.
Qualified image:
`sha256:74e26d6c8fcdd9ad83a35c8d41b35c700ed3e9538ccd132db148798373e7eb71`.
Executed proof-harness SHA-256:
`de3acb53e33713c511e5e35b58069ed6c840c09bd2c346019b177385e4464f57`.

Detailed private evidence is retained under
`/var/tmp/sept-sb13-01-20261025-_by98g7w/security-amendment/`, notably
`release-freeze.json`, `release-qa.md`, `release-qa-verdict.json`,
`release-qa-repeat.md`, `candidate.json` and `implementor.md`. Original audit and
failed attempts remain retained separately and excluded from final acceptance,
including premature image observation, old harness drift, nonportable file
packages, incomplete bundles and the superseded npm script-name collision.
