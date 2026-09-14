# SEPT worker API

Every request requires `Authorization: Bearer <SEPT_TOKEN>`. After `npm run build`, operators start and monitor the local worker through the public SEPT entry point. Server operation must configure a persistent external state root; the cwd-relative `.sept/runs` fallback is for explicit local development only:

```bash
SEPT_TOKEN='a-long-random-secret' ./sept worker --host 127.0.0.1 --port 8090 --state-dir /persistent/sept/runs --workspace-root /assigned/workspaces
SEPT_TOKEN='a-long-random-secret' ./sept health --url http://127.0.0.1:8090/health
```

- `GET /health` — worker state (`idle`, `busy`, or `waiting`) and resident run ID in `activeRunId`. `waiting` means no Pi runtime/controller is allocated, but the resumable run retains the single slot.
- `POST /v1/tasks` — create the single active task. Required JSON: `task`. Optional: `role`, `workspace`, `provider`, `model`, `thinking`, `thresholdPercent`, `handoverReserveTokens`, `maxInvocations`, `maxEpochs`, `timeoutSeconds`. The workspace defaults to the configured workspace root and must resolve to a directory beneath it; symlink escapes are rejected.
- `GET /v1/tasks/:runId` — immutable manifest and current durable state.
- `GET /v1/tasks/:runId/events?after=<cursor>&limit=<1..1000>` — ordered durable events and next cursor.
- `GET /v1/tasks/:runId/log` — at most the last 1 MiB of the bounded agent lifecycle log.
- `POST /v1/tasks/:runId/messages` — queue `{ "message": "..." }` durably; returns `202` and its ID.
- `POST /v1/webhooks` — accept one normalized provider-neutral event and route it through the same task or operator-message lifecycle.

Run states are `active`, `waiting`, `blocked`, `complete`, and `failed`. The agent control object accepts `continue`, `waiting`, `blocked`, or `complete`: `continue` immediately invokes Pi again; `waiting` means current work is coherent and only new input can make progress; `blocked` records a genuine operator impediment; and `complete` is successful termination.

On `waiting`, SEPT fsyncs the control checkpoint, then records the waiting state while preserving the Pi session ID/file. It closes the Pi runtime and controller lease and makes no further model call. An authenticated direct or webhook message is fsynced before acknowledgement, changes the run back to `active`, and reopens that same Pi session. A waiting run retains the single slot, so unrelated tasks receive `409`. If input arrives during the waiting decision or while its controller is closing, SEPT either continues in-place or launches one replacement controller after the old one releases ownership. On restart, a waiting run remains dormant; if a queued message survived a crash before the wake transition, startup completes the wake and adopts the session.

Operator delivery is at least once. SEPT preserves every accepted character, including edge whitespace, and writes the exact ID and text in a delivery-attempt event. It acknowledges consumption only after a fsynced work checkpoint or handover event contains that same ID and text. The handover JSON, Markdown, event, and `handover_durable` state commit precede message consumption, so a crash before consumption leaves input pending and restart must replace the predecessor before delivery. If input is accepted while an invocation is returning `complete`, `blocked`, or `waiting`, SEPT defers that transition and delivers the pending input in the same session. A message reopens a model-blocked task only when the worker slot is genuinely idle; if any controller still owns the slot, both message routes return `409` before queueing or mutating the blocked run, and the caller may retry after the worker becomes idle.

`timeoutSeconds` limits accumulated Pi invocation wall time, not run age, so dormant time does not consume the execution budget. Each invocation gets only the remaining budget. Invocation and epoch caps remain hard across every wait/wake cycle. New input is rejected before durable acceptance when no invocation/timeout budget remains and while an invocation is running in the final permitted epoch; limit exhaustion is stored as a typed terminal cause rather than inferred from agent-authored text.

SIGINT/SIGTERM closes HTTP admission first and waits for the active invocation to reach its next durable checkpoint, handover, or terminal transition. SEPT then disposes the Pi runtime, releases controller and state-root ownership, and leaves nonterminal work active for restart adoption. A bind failure performs no adoption/controller work.

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
