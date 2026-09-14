# SEPT worker API

Every request requires `Authorization: Bearer <SEPT_TOKEN>`. After `npm run build`, operators start and monitor the local worker through the public SEPT entry point. Server operation must configure a persistent external state root; the cwd-relative `.sept/runs` fallback is for explicit local development only:

```bash
SEPT_TOKEN='a-long-random-secret' ./sept worker --host 127.0.0.1 --port 8090 --state-dir /persistent/sept/runs --workspace-root /assigned/workspaces
SEPT_TOKEN='a-long-random-secret' ./sept health --url http://127.0.0.1:8090/health
```

- `GET /health` — worker state (`idle`, `busy`, or `waiting`), durable readiness (`accepting`, `draining`, or `drained`), `acceptingWork`, and the resident run ID in `activeRunId`. `waiting` means no Pi runtime/controller is allocated, but the resumable run retains the single slot. Health and reads remain available while drained.
- `POST /v1/drain` — durably begin drain. The body is empty. Returns the current worker/readiness object and is idempotent.
- `POST /v1/tasks` — create the single active task. Required JSON: `task`. Optional: `role`, `workspace`, `provider`, `model`, `thinking`, `thresholdPercent`, `handoverReserveTokens`, `maxInvocations`, `maxEpochs`, `timeoutSeconds`. The workspace defaults to the configured workspace root and must resolve to a directory beneath it; symlink escapes are rejected.
- `GET /v1/tasks/:runId` — immutable manifest and current durable state.
- `GET /v1/tasks/:runId/events?after=<cursor>&limit=<1..1000>` — ordered durable events and next cursor.
- `GET /v1/tasks/:runId/log` — at most the last 1 MiB of the bounded agent lifecycle log.
- `GET /v1/tasks/:runId/conversation?after=<cursor>&limit=<1..250>` — replay bounded durable conversation events. Returns `events`, `nextCursor`, `retainedFrom`, and authoritative terminal state even when the terminal event is outside the requested page. A cursor older than retention receives `410`; malformed, duplicate, fractional, negative, or future cursor values receive `400` rather than being coerced.
- `GET /v1/tasks/:runId/stream?after=<cursor>` — replay and follow the same events as authenticated `text/event-stream`. SSE `id` is the durable cursor; reconnect with it as `after`. At the authoritative terminal boundary, a terminal event is followed by clean closure or a `disconnect` carrying terminal metadata when that event is before the requested cursor. `disconnect` events include `{ reason, retry, nextCursor, terminal? }` for server shutdown, five-minute connection renewal, backpressure, terminal reconnect, or retention expiry.
- `POST /v1/tasks/:runId/messages` — queue `{ "message": "..." }` durably; returns `202` and its ID.
- `POST /v1/tasks/:runId/cancel` — targeted idempotent cancellation with an empty body. Cancellation intent and a bounded fixed terminal reason are fsynced before Pi's native abort is requested. Returns `202` while settlement is still in progress or `200` once deterministic terminal/no-op state is known.
- `POST /v1/webhooks` — accept one normalized provider-neutral event and route it through the same task or operator-message lifecycle.

Run states are `active`, `waiting`, `cancelling`, `cancelled`, `blocked`, `complete`, and `failed`. The agent control object accepts `continue`, `waiting`, `blocked`, or `complete`: `continue` immediately invokes Pi again; `waiting` means current work is coherent and only new input can make progress; `blocked` records a genuine operator impediment; and `complete` is successful termination.

On `waiting`, SEPT fsyncs the control checkpoint, then records the waiting state while preserving the Pi session ID/file. It closes the Pi runtime and controller lease and makes no further model call. An authenticated direct or webhook message is fsynced before acknowledgement, changes the run back to `active`, and reopens that same Pi session. A waiting run retains the single slot, so unrelated tasks receive `409`. If input arrives during the waiting decision or while its controller is closing, SEPT either continues in-place or launches one replacement controller after the old one releases ownership. On restart, a waiting run remains dormant; if a queued message survived a crash before the wake transition, startup completes the wake and adopts the session.

Operator delivery is at least once. SEPT preserves every accepted character, including edge whitespace, and writes the exact ID and text in a delivery-attempt event. Queue persistence precedes conversation projection, and a fsynced projection marker lets restart idempotently recover a crash between those writes without losing accepted text or defeating bounded transcript retention. It acknowledges consumption only after a fsynced work checkpoint or handover event contains that same ID and text. The handover JSON, Markdown, event, and `handover_durable` state commit precede message consumption, so a crash before consumption leaves input pending and restart must replace the predecessor before delivery. If input is accepted while an invocation is returning `complete`, `blocked`, or `waiting`, SEPT defers that transition and delivers the pending input in the same session. A message reopens a model-blocked task only when the worker slot is genuinely idle; if any controller still owns the slot, both message routes return `409` before queueing or mutating the blocked run, and the caller may retry after the worker becomes idle.

`timeoutSeconds` limits accumulated Pi invocation wall time, not run age, so dormant time does not consume the execution budget. Each invocation gets only the remaining budget. Invocation and epoch caps remain hard across every wait/wake cycle. New input is rejected before durable acceptance when no invocation/timeout budget remains and while an invocation is running in the final permitted epoch; limit exhaustion is stored as a typed terminal cause rather than inferred from agent-authored text.

SIGINT/SIGTERM closes HTTP admission first and waits for the active invocation to reach its next durable checkpoint, handover, or terminal transition. SEPT then disposes the Pi runtime, releases controller and state-root ownership, and leaves nonterminal work active for restart adoption. A bind failure performs no adoption/controller work.

Drain is not process shutdown. The first authenticated drain writes `/worker-state.json` beneath the owned state root before returning. From that point direct and webhook task/message admission return `409`; accepted queued input continues. An active run reports `draining` until it reaches waiting or terminal, then reports `drained`. An already waiting or idle worker becomes drained immediately. Repeated drain requests return the same state, and startup never silently returns a drained root to accepting. The one-shot `sept run` command also refuses a drained state root.

Cancellation is run-targeted and does not alter unrelated terminal runs. Active or waiting cancellation moves the durable state through `cancelling` to `cancelled` with terminal cause `operator_cancelled`. Only after intent is durable does the controller call native `AgentSession.abort()`, which propagates to Pi model and tool work. Controller checks after every Pi invocation and session-replacement await prevent late complete/wait/blocked/failure writes. Restart finalizes a surviving `cancelling` state without invoking Pi. Repeated cancellation of `cancelled` is successful; cancellation after another terminal result is a deterministic no-op. New messages to cancelling/cancelled runs are rejected.

## Conversation contract

`conversation.jsonl` is separate from `events.jsonl`, `agent.log`, Pi session files, and WorkControl/Handover evidence. Its version-1 event union is:

```json
{"formatVersion":1,"cursor":1,"id":"stable-id","type":"message","role":"user|assistant","text":"exact text","at":"ISO-8601"}
{"formatVersion":1,"cursor":2,"id":"stable-id","type":"state","state":"active|waiting","at":"ISO-8601"}
{"formatVersion":1,"cursor":3,"id":"terminal-complete","type":"terminal","status":"cancelled|complete|blocked|failed","at":"ISO-8601"}
```

Cursors are strictly increasing and IDs are deterministic for task, operator delivery, invocation output, lifecycle seams, and terminal state. Task/operator text is preserved exactly. Assistant records are committed before their corresponding control checkpoint and come only from the explicit `message` member of `{ "message": "...", "control": { ...WorkControl } }`; a validated message completed immediately before Pi steering is retained before the durable handover and fresh-session replacement. SEPT never projects Pi `thinking_delta`, raw streamed model output, prompts, tool calls/results, internal controls, webhook bodies, or lifecycle logs into conversation. Assistant message validation is bounded and rejects unsafe control characters, internal protocol fragments, and recognizable credential forms; rejection fails the run closed without publishing the text.

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

The task object accepts exactly the fields supported by `POST /v1/tasks`. Event and nested object schemas reject unknown fields. Operator messages preserve normal tabs and line breaks while rejecting unsafe control characters. `source` is a bounded adapter identifier, and `(source, eventId)` is the durable idempotency key. The first accepted delivery returns `202`; an identical retry returns `200` with `"duplicate": true` and the original routing IDs. Reusing the key for a different event returns `409` without routing either retry. A distinct task event returns `409` while the single slot is busy. Receipts contain only hashes and routing IDs, never source payloads.

Durable run evidence is written beneath the configured state root. The production image fixes this at `/state/runs` and requires a persistent volume mounted at `/state`; it must not depend on an ephemeral container layer.

Request bodies accept at most 256 KiB. Operator messages and task text are limited to 32 KiB. At most 64 pending operator messages and 512 KiB of pending message text are accepted; saturation returns `429` without queueing the new message. JSON POSTs require `Content-Type: application/json`. The service authenticates before reading a body, binds to `127.0.0.1` by default, accepts its bearer secret only from `SEPT_TOKEN`, and does not expose credentials, assistant payload text, or raw webhook payloads in lifecycle logs and errors.
