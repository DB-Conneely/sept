# SEPT worker API

Every request requires `Authorization: Bearer <SEPT_TOKEN>`. Use the installed `sept` entry point (or `./sept` after a checkout build), or the same complete [SDK worker factory](sdk.md#worker-lifecycle). Prepare [hands and first-boot rights](pi-contract.md#executable-supplied-hands-setup) before initialization. Operators start and monitor the local worker through that entry point. Server operation must configure a persistent external state root; the cwd-relative `.sept/runs` fallback is for explicit local development only:

```bash
SEPT_TOKEN='a-long-random-secret' ./sept worker --host 127.0.0.1 --port 8090 --state-dir /persistent/sept/runs --workspace-root /assigned/workspaces --hands /trusted/hands.json
SEPT_TOKEN='a-long-random-secret' ./sept health --url http://127.0.0.1:8090/health
```

- `GET /health` — worker state (`idle`, `busy`, or `waiting`), durable readiness (`accepting`, `draining`, or `drained`), `acceptingWork`, and the resident run ID in `activeRunId`. `waiting` means no Pi runtime/controller is allocated, but the resumable run retains the single slot. Health and reads remain available while drained.
- `POST /v1/drain` — durably begin drain. The body is empty. Returns the current worker/readiness object and is idempotent.
- `GET /v1/model-access/providers` — normalized Pi providers with credential-blind authentication state/methods and model counts.
- `GET /v1/model-access/models?provider=<id>` — normalized Pi models. The optional provider appears at most once. Fields are only provider/id/name, availability, API dialect, context/output limits, and reasoning/input capabilities.
- `GET /v1/model-access/selection` — resolved Pod selection with `selected.source`, `available`, `authenticated`, and normalized model metadata. It fails safely if the current default is no longer usable.
- `PUT /v1/model-access/selection` — atomically set a future-run Pod default from exactly `{ "provider": "...", "model": "..." }` after full Pi preflight. The body limit is 8 KiB.
- `POST /v1/tasks` — create the single active task. Required JSON: `task`. Optional: `role`, `workspace`, the complete `provider`/`model` pair, `thinking`, `maxInvocations`, `maxEpochs`, and `timeoutSeconds`. The workspace defaults to the configured workspace root and must resolve to a directory beneath it; symlink escapes are rejected.
- `GET /v1/tasks/:runId` — manifest and current durable state projected with hands workspace aliases and bounded session locator names; private host roots remain only in recovery storage.
- `GET /v1/tasks/:runId/events?after=<cursor>&limit=<1..1000>` — ordered durable events and next cursor.
- `GET /v1/tasks/:runId/log` — at most the last 1 MiB of the bounded agent lifecycle log.
- `GET /v1/tasks/:runId/conversation?after=<cursor>&limit=<1..250>` — replay bounded durable conversation events. Returns `events`, `nextCursor`, `retainedFrom`, and authoritative terminal state even when the terminal event is outside the requested page. A cursor older than retention receives `410`; malformed, duplicate, fractional, negative, or future cursor values receive `400` rather than being coerced.
- `GET /v1/tasks/:runId/stream?after=<cursor>` — replay and follow the same events as authenticated `text/event-stream`. SSE `id` is the durable cursor; reconnect with it as `after`. At the authoritative terminal boundary, a terminal event is followed by clean closure or a `disconnect` carrying terminal metadata when that event is before the requested cursor. `disconnect` events include `{ reason, retry, nextCursor, terminal? }` for server shutdown, five-minute connection renewal, backpressure, terminal reconnect, or retention expiry.
- `POST /v1/tasks/:runId/messages` — queue `{ "message": "..." }` durably; returns `202` and its ID.
- `POST /v1/tasks/:runId/cancel` — targeted idempotent cancellation with an empty body. Cancellation intent and a bounded fixed terminal reason are fsynced before Pi's native abort is requested. Returns `202` while settlement is still in progress or `200` once deterministic terminal/no-op state is known.
- `POST /v1/webhooks` — accept one normalized provider-neutral event and route it through the same task or operator-message lifecycle.

All responses use `Cache-Control: no-store`. Model routes expose no credential values, headers, OAuth records, auth paths, raw provider payloads, or arbitrary provider configuration. Login is intentionally absent from this plain HTTP listener; use the installed `sept auth status|login|logout` commands, which delegate to Pi and never accept a secret as an argument.

For every direct and task-webhook admission, SEPT validates the request, rereads `sept-model.json`, resolves explicit pair > Pod default > valid built-in default, and asks Pi for provider/model existence, availability, required metadata, and resolved authentication. Failure returns before `RunStore.create()`, webhook receipt claim, or controller launch. The final pair is immutable in each run manifest, so changing the Pod default affects only later runs.

Run states are `active`, `waiting`, `cancelling`, `cancelled`, `blocked`, `complete`, and `failed`. The agent control object accepts `continue`, `waiting`, `blocked`, or `complete`: `continue` immediately invokes Pi again; `waiting` means current work is coherent and only new input can make progress; `blocked` records a genuine operator impediment; and `complete` is successful termination.

On `waiting`, SEPT fsyncs the control checkpoint, then records the waiting state while preserving the Pi session ID/file. It closes the Pi runtime and controller lease and makes no further model call. An authenticated direct or webhook message is fsynced before acknowledgement, changes the run back to `active`, and reopens that same Pi session. A waiting run retains the single slot, so unrelated tasks receive `409`. If input arrives during the waiting decision or while its controller is closing, SEPT either continues in-place or launches one replacement controller after the old one releases ownership. On restart, a waiting run remains dormant; if a queued message survived a crash before the wake transition, startup completes the wake and adopts the session.

Operator delivery is at least once. SEPT preserves every accepted character, including edge whitespace, and writes the exact ID and text in a delivery-attempt event. Queue persistence precedes conversation projection, and a fsynced projection marker lets restart idempotently recover a crash between those writes without losing accepted text or defeating bounded transcript retention. An identical retry of accepted but unconsumed input completes projection and wake under the same live slot/readiness/limit checks before completing its webhook receipt. A consumed duplicate is inert and cannot revive expired text. Historical reconciliation retains at most 64 records / 512 KiB of text per batch while consulting durable projection markers. It acknowledges consumption only after a fsynced work checkpoint or handover event contains that same ID and text. The handover JSON, Markdown, event, and `handover_durable` state commit precede message consumption, so a crash before consumption leaves input pending and restart must replace the predecessor before delivery. If input is accepted while an invocation is returning `complete`, `blocked`, or `waiting`, SEPT defers that transition and delivers the pending input in the same session. A message reopens a model-blocked task only when the worker slot is genuinely idle; if any controller or another waiting resident owns the slot, both message routes return `409` before queueing or mutating the blocked run, and the caller may retry after the worker becomes idle.

`timeoutSeconds` limits accumulated Pi invocation wall time, not run age, so dormant waiting does not consume the execution budget. SEPT fsyncs an in-flight start before dispatch. Restart conservatively debits the uncertain crash interval, including downtime, up to the remaining hard budget because SIGKILL supplies no reliable death timestamp. A settled native answer can still be reused at exhaustion; new model/tool dispatch is refused. Each invocation gets only the remaining budget. Invocation and epoch caps remain hard across every wait/wake cycle. New input is rejected before durable acceptance when no invocation/timeout budget remains and while an invocation is running in the final permitted epoch; limit exhaustion is stored as a typed terminal cause rather than inferred from agent-authored text.

SIGINT/SIGTERM closes HTTP admission first and waits for the active invocation to reach its next durable checkpoint, handover, or terminal transition. SEPT then disposes the Pi runtime, releases controller and state-root ownership, and leaves nonterminal work active for restart adoption. A bind failure performs no adoption/controller work.

Drain is not process shutdown. The first authenticated drain writes `/worker-state.json` beneath the owned state root before returning. From that point direct and webhook task/message admission return `409`; accepted queued input continues. An active run reports `draining` until it reaches waiting or terminal, then reports `drained`. An already waiting or idle worker becomes drained immediately. Repeated drain requests return the same state, and startup never silently returns a drained root to accepting. The one-shot `sept run` command also refuses a drained state root.

Cancellation is run-targeted and does not alter unrelated terminal runs. Active or waiting cancellation moves the durable state through `cancelling` to `cancelled` with terminal cause `operator_cancelled`. Only after intent is durable does the controller call native Durable `conversation.abort()`, which joins Pi model/tool work, including background descendants. Controller checks after every Pi invocation and conversation-replacement await prevent late complete/wait/blocked/failure writes. Restart finalizes historical cancellation without invoking Pi when no hands binding exists. An interrupted supplied-hands cancellation has unknown cleanup ownership and becomes `blocked` with `controller_failure` until the consumer reconciles it. A live shutdown-verification failure uses the same durable blocked outcome, preserving cancellation intent and never publishing `cancelled`. Repeated cancellation of `cancelled` is successful; cancellation after another terminal result is a deterministic no-op. New messages to cancelling/cancelled runs are rejected.

New runs use native Pi Durable SQLite and `*.durable.json` conversation locators. Public session identity remains a string, containing the native numeric conversation ID. Context rotation creates a fresh conversation/provider identity only after the fsynced SEPT handover. Existing coding-agent JSONL sessions require the preserved old build; this build does not convert historical transcripts. Trusted operator plugins must use the native extension contract in [pi-contract.md](pi-contract.md).

## SDK and response statuses

The public [client](sdk.md) sends stable-ID writes through webhooks, not the non-idempotent direct task/message routes. A new webhook returns202; an identical replay returns200 with the original IDs and `duplicate:true`. A task receipt remains `{ "kind":"task", "runId":"...", "status":"active", "duplicate":true }` after later completion. `GET /v1/tasks/:runId` is the authority for current state. A message receipt is `{ "kind":"operator_message", "runId":"...", "messageId":"...", "duplicate":false }`. Cancel returns `{ "runId":"...", "status":"cancelling", "cancelled":true }` with202 while still settling; true alone does not certify terminal cancellation.

Successful reads return200, new direct task/message admissions202 and drain202. Errors preserve `{ "error": "bounded message" }`:400 malformed/invalid input,401 bearer failure,404 missing route/run,409 slot/drain/state/collision conflict,413 oversized body,415 wrong JSON content type,429 capacity and500 internal failure. Conversation expiry returns410 with additive machine-readable metadata:

```json
{ "error": "conversation cursor expired; earliest retained cursor is 25", "retainedFrom": 25 }
```

The exact existing error wording remains server-owned. `retainedFrom` is the earliest retained positive cursor for JSON replay and initial SSE replay errors. After a visible evidence-gap report, read current task state and explicitly choose whether to retry at `retainedFrom - 1` under a finite attempt budget; even after0 can expire. Never silently skip missing history. See [bounded recovery code](sdk.md#finite-410-recovery). A timeout/abort cannot retract durable task/message acceptance.

## Conversation contract

`conversation.jsonl` is separate from `events.jsonl`, `agent.log`, Pi session files, and WorkControl/Handover evidence. Its version-1 event union is:

```jsonl
{"formatVersion":1,"cursor":1,"id":"stable-id","type":"message","role":"user|assistant","text":"exact text","at":"ISO-8601"}
{"formatVersion":1,"cursor":2,"id":"stable-id","type":"state","state":"active|waiting","at":"ISO-8601"}
{"formatVersion":1,"cursor":3,"id":"terminal-complete-1-1","type":"terminal","status":"cancelled|complete|blocked|failed","at":"ISO-8601"}
```

Cursors are strictly increasing and IDs are deterministic for task, operator delivery, invocation output, lifecycle seams, and terminal occurrences identified by status, epoch and invocation. Reopening a blocked run therefore creates a distinct terminal event when it blocks again. Task/operator text is preserved exactly. Assistant records are committed before their corresponding control checkpoint and come only from the explicit `message` member of `{ "message": "...", "control": { ...WorkControl } }`; a validated message completed immediately before Pi steering is retained before the durable handover and fresh-session replacement. SEPT never projects Pi `thinking_delta`, raw streamed model output, prompts, tool calls/results, internal controls, webhook bodies, or lifecycle logs into conversation. Assistant message validation is bounded and rejects unsafe control characters, internal protocol fragments, and recognizable credential forms; rejection fails the run closed without publishing the text.

At most 1,024 events and 4 MiB are retained per run; one message is at most 32,768 characters. Retention atomically keeps the newest complete records and reports a gap with `410`. Replay pages are capped at 250. At most 32 streams are active per worker; each connection renews after five minutes. A write-side backpressure signal closes with a reconnect cursor rather than accumulating an unbounded application buffer. Streams poll only the bounded durable file, so restart and session rotation require no in-memory replay state.

## Webhook contract

Edge adapters normalize provider payloads before calling SEPT. SEPT does not implement Telegram, Slack, WhatsApp, monitoring, or other provider-specific behavior.

Task event:

```json
{
  "version": 1,
  "eventId": "producer-stable-event-id",
  "source": "monitoring-edge",
  "kind": "task",
  "task": {
    "task": "Investigate and verify the alert",
    "role": "Repository maintainer",
    "workspace": "/workspace"
  }
}
```

Operator-message event:

```json
{
  "version": 1,
  "eventId": "producer-stable-event-id",
  "source": "slack-edge",
  "kind": "operator_message",
  "runId": "target-run-id",
  "message": "Use the newer operator direction"
}
```

The task object accepts exactly the fields supported by `POST /v1/tasks`, including only a complete provider/model override. It uses the same fresh default resolution and Pi preflight before receipt claim. Event and nested object schemas reject unknown fields. Operator messages preserve normal tabs and line breaks while rejecting unsafe control characters. `source` is a bounded adapter identifier, and `(source, eventId)` is the durable idempotency key. The first accepted delivery returns `202`; an identical retry returns `200` with `"duplicate": true` and the original routing IDs. Reusing the key for a different event returns `409` without routing either retry. A distinct task event returns `409` while the single slot is busy. Receipts contain only hashes and routing IDs, never source payloads.

Durable run evidence is written beneath the configured state root. The production image fixes this at `/state/runs` and requires a persistent volume mounted at `/state`; it must not depend on an ephemeral container layer.

Task limits default to100 invocations,20 epochs and86,400 seconds of active invocation time; integer ranges are1..10,000,1..1000 and1..604,800 respectively. Thinking accepts `off|minimal|low|medium|high|xhigh|max`, default `xhigh`.

Request bodies accept at most 256 KiB. Operator messages and task text are limited to 32 KiB. At most 64 pending operator messages and 512 KiB of pending message text are accepted; saturation returns `429` without queueing the new message. JSON POSTs require `Content-Type: application/json`. The service authenticates before reading a body, binds to `127.0.0.1` by default, accepts the CLI bearer secret only from `SEPT_TOKEN` (library callers explicitly supply `token`), and does not expose credentials, assistant payload text, or raw webhook payloads in lifecycle logs and errors.

A non-limit failure during durable handover/replacement recovery holds the active resident and stops automatic relaunch. Health reports that slot as busy; a worker restart or explicitly admitted same-run input may attempt recovery again. Acquired native hosts are closed when publication fails before controller ownership transfers. Lease takeover requires a provably dead different local PID plus stale lease age; an unknown, malformed or foreign-host owner remains fail closed regardless of age. For container identity changes, the operator must independently establish that the previous owner cannot execute before retiring its lease through an explicit recovery procedure; automatic cross-host takeover is unsupported.

Execution requires one consumer-supplied Docker Linux hands container configured by `--hands` or `SEPT_HANDS_CONFIGURATION`; API task text cannot choose it. Health/history remain available if enforcement is missing, but scheduling fails closed. The supported `docker-linux-warm-v1` profile requires the explicit trusted local `engineSocket` plus inspected socket/daemon/container/generation facts. Native Pi remains the scheduler/tool-body/replay owner; one resident retains imports and an authenticated bounded attachment. The default private workspace is a finite consumer-seeded read/write tmpfs with Bash absent; explicitly granted Bash/custom use the same data. Consumers own export/preservation before stop and seed into a fresh generation. The separate `mutable-file-bind` domain permits anchored individual effects without commands, discovery or imageSelected. Cancellation stops the dedicated namespace (including detached descendants), may lose ephemeral contents and requires a fresh consumer generation before retry. Normal close joins the resident and preserves the idle consumer namespace. Ordinary body errors and verified command timeout/overflow may retain the channel; transport/identity loss or unverified joins seal authority and retain typed bounded stage/exit/closure facts. Each effect checks current rights; cached imports never cache grants. See [profile/configuration details](pi-contract.md#supplied-hands-reference-profile).

The resident runs UID10002; commands and fixed rg/fd run UID10003:GID10002 without the brain group. Private app/HOME/physical capture bytes and resident memory/control/signals are protected by DAC, nondumpability and guards, including a separate command session for SIGCONT. Some public `/proc` metadata and resident cmdline correlation remain visible; neither correlation nor command stdout can grant/acknowledge control. Native grep/find require their admitted parent's READ authority and uniform readability, consume no Bash execute grant and always deny network. They use enclosing run/revoke/native limit cancellation with no new helper timer. Stdout/stderr remain separate for search, Bash combines decoded chunks in arrival order and custom results use stdout only; the combined 4 MiB command-output budget, drain and exact joins remain authoritative. Helper loss/overflow/cancellation cannot be reported as partial normal success.

Opening verifies the image/DAC/private provenance and four effective Pi search-file hashes, then records literal isolation revision `uid-dac-fixed-helper-v1`. Old images/receipts refuse without rewriting history. The image-only `sept-native-search-v1` patch consists of four assets and changes only find/grep JS plus matching declarations; host Pi 1.1.0 remains stock; the exact locked package graph is retained. The pinned registry archive omits LICENSE; the exact upstream MIT notice is retained in the [asset README](../image/pi-native-search/README.md), privately copied with provenance. This internal patch adds no HTTP or client API.

## Local capability configuration

Capability activation is a local operator operation, exposed only by `sept permissions show|set|revoke|requests|inspect|approve|deny`; there is no HTTP grant endpoint or text approval parser. See [local policy schema and commands](pi-contract.md#local-hands-permissions). `GET /health` and authenticated history stay readable with missing, denied or malformed policy, and `acceptingWork` is false. New task or message admission under known denial returns a bounded refusal before persistence. If denial races an already durable accepted input, that input retains its identity and remains dormant without effects; restart does not reset budgets or silently grant authority. An interrupted active run can remain recorded as active while native scheduling is denied.

The default for genuinely empty state is workspace read/write, absent Bash, denied selected mounts and network none. Existing state requires explicit operator adoption. Full access means the supplied hands domain with brain exclusions and kernel mount protections. Explicit network grants require the connected consumer kernel profile documented in [the hands contract](pi-contract.md#explicit-hands-network); full_access alone keeps network false. Bash/custom network intent is an optional boolean in the native call and exact request digest. Missing network in request mode follows local decision plus explicit retry; default/scoped denial cannot produce a network effect. Write-only arbitrary execution and persistent selected RW plus Bash remain unsupported and are refused before activation. Independent file rights are supported; edit requires both. Partial-read namespaces omit native search/list and workspace resource discovery rather than broadening read authority. Narrow/revoke stops the exact dedicated namespace after fsynced policy publication; consumers supply a fresh validated generation and explicit restart/retry for expansion. Interrupted mutations remain uncertain and are not blindly replayed.

Only trusted local hands configuration may add optional `imageSelected`: exact `{ "alias": "reference" }` objects, normalized to `[]` when omitted. Image aliases match `[A-Za-z0-9_-]{1,64}`, denote baked RO `/selected/<alias>` trees and have no host source/stat/seed path. Existing host aliases retain their longer `[A-Za-z0-9_-]+` grammar. All image/RO/RW aliases share the eight-unique-alias bound and existing selected policy rights; configuration alone grants nothing. Private-domain image roots require the pinned image/read-only rootfs and no equal, ancestor or subtree overlapping mount at opening/live checks. Optional genuinely `FS_IMMUTABLE`-sealed Linux RO host inputs remain supported; ordinary RO/private RW alternatives refuse. Changed baked bytes need a new image and fresh generation/authority after quiescence. [Bounded consumer Dockerfile recipe](pi-contract.md#selected-image-data-and-code) adds no provisioner or HTTP input.

Capability expansion requires a consumer-supplied fresh namespace generation and verified quiescence of the old owner. Existing lease verification may reclaim a dead local owner after its grace period; a live, foreign or unverifiable owner refuses. After a crash/revoke, an active record can remain dormant with retained uncertain tool history. Explicit validated operator configuration and worker restart recover the same native session and captured admission/limits; unsafe interrupted mutations are not blindly re-executed. An operator message already durably accepted when denial wins is acknowledged with its exact queue identity and stays dormant; known denial refuses subsequent input before enqueue.


Permission waiting is durable domain state, not a model-authored wait response. The original native call remains denied; requests contain exact work-visible operation/content digest and source authority. Pending restart never auto-wakes from old accepted queue entries. Local approval activates an exact exception for an explicitly selected fresh namespace/current revision and never schedules a call. A newly accepted operator message supplies the explicit wake using existing queue, slot and limit rules. Local direct `sept run --resume <run-id> --message <text>` uses that same wake and cannot reset original limits or model choices. Deny/cancel/revoke/expiry prevent effects; expiry during active approved work stops and joins the namespace. Request/decision activation has no HTTP endpoint and task/chat content cannot create a grant. [Local decisions and the single custom hand](pi-contract.md#exact-permission-requests-and-local-retry) document the bounded operator commands.

The one operator `customHand` registration contains only path/SHA256/replay, below an admitted read-only image or genuinely sealed host alias, with the existing shell/execute/bounded RW workspace/uniform-read requirements. The parent checks anchored code (64 KiB maximum) and exact input against the pin; no native API object or credentials reach the clean child. Native `custom_hand` has text `maxLength: 256` plus a 1024-byte transport bound, optional boolean network intent, stdout-only 4096-byte output with native 4096-byte/64-line limits, and its existing 5-second timeout. Stderr is separately bounded/drained inside the 4 MiB output budget. SAFE replay checks current pin/rights; UNSAFE interruption retains uncertainty without repeating effects. These are native tool calls within a task, not a new worker endpoint.

Support is limited to the exact qualified source/image/host combination. Native Windows worker operation remains unsupported because Unix control/POSIX leases remain; Intel Mac and Windows Docker Linux/WSL recipes remain unqualified. [Repository-only historical evidence at d361123](https://github.com/DB-Conneely/sept/blob/d361123d7c242db5af3ae2d1cb4daea4a2acdeff/docs/as-built/capability-confinement.md) retains publicIPv6 ENETUNREACH/UFW INPUT-DROP, provider-outage/OAuth-refresh gaps and the unknown original physical stream-loss trigger.

The [task client](sdk.md#five-client-calls) wraps five operations only. Direct admissions, events/log retrieval, SSE, drain and model routes remain available here. The [canonical index](index.md) maps the same Markdown for people and AI readers.
