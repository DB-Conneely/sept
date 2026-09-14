# Part 1 implementation report

## Audit findings

SEPT already had the correct Pi-native session, steering, replacement, durable handover, single-slot, webhook, authentication, workspace, limits, and graceful-stop foundations. It had no durable worker admission state, no targeted cancellation state or native-abort path, and no client-safe conversation projection: assistant text existed only as Pi output and bounded lifecycle byte counts. The installed Pi SDK 0.85.1 exposes `AgentSession.abort()` and propagates its signal through provider and tool work, so cancellation did not require a second execution mechanism.

## Delivered behavior

- **Drain:** authenticated `POST /v1/drain`, fsynced state-root readiness, accepting/draining/drained health, synchronous admission gating for direct and webhook task/message routes, settlement of preaccepted queues, immediate waiting/idle settlement, idempotence, restart persistence, and one-shot CLI refusal on a drained root. Graceful process stop remains separate.
- **Cancel:** authenticated targeted `POST /v1/tasks/:runId/cancel`; durable `cancelling` intent and fixed bounded reason precede native Pi abort; `cancelled` is immutable against late controller results; model, tool, host-open, retry/error, checkpoint/handover, replacement, waiting, repeated, terminal, and restart seams have deterministic handling. Late messages fail before persistence.
- **Conversation:** one versioned durable event union for user/assistant messages plus active/waiting/terminal lifecycle; stable IDs and monotonic cursors; exact user text with marker-based recovery of the durable queue-to-conversation crash seam; assistant output isolated behind a validated public response field and retained across Pi steering/rotation; 1,024-event/4-MiB retention, 32,768-character records, 250-event replay pages, strict non-coercing cursors, cursor-gap `410`, authoritative terminal metadata outside the requested page, 32 live streams, five-minute renewal, and fail-closed backpressure. Authenticated transcript replay and SSE use the same durable records, support cursor reconnect, survive wait/wake, rotation, restart and cancellation, and never project Pi reasoning, prompts, internal controls, raw webhook data, or tool arguments/results.

## Installed-runtime evidence

- `npm run check` passed.
- `npm test` passed all 72 tests, including installed `./sept worker` processes using the production `PiSessionHost` with local deterministic providers.
- The installed worker test exercised initial conversation output, provider-usage-triggered native steering, visible pre-rotation progress, durable handover and fresh Pi session, waiting, process restart, same-session wake, exact follow-up text, SSE reconnect/replay, restart while readiness remained `draining`, recovery to clean terminal output, durable `drained`, and direct `sept run` refusal.
- The installed worker cancellation test held a real production Pi provider response open after fully consuming its request body, persisted cancellation, invoked native abort, observed the unfinished `ServerResponse` close, and proved no late completion.
- Production SDK tests proved abort propagation during both model work and active custom-tool work, plus the existing native steer/new-session rotation lifecycle. Adversarial service tests cover queue-projection crash recovery, strict/future cursor rejection, terminal metadata after the terminal cursor, SSE replay expiry, backpressure disconnect, 32-stream saturation, reconnect, terminal closure, restart, and server shutdown.
- `npm audit` and `npm audit --omit=dev` reported zero vulnerabilities.
- `docker build -t sept:local .` passed from a fresh build stage.
- A fresh `sept:local` container smoke proved fail-closed bearer auth, authenticated health, strict empty drain bodies, drain, graceful container stop, and durable drained readiness after a second container adopted the same mounted state.
- `git diff --check` passed; credentials and payload text were not added to logs or fixtures.

## Remaining risks and intentionally deferred work

Conversation retention is intentionally finite; clients that reconnect behind `retainedFrom` must perform an explicit reset after `410`. SSE is polling-backed and connection-bounded rather than a second protocol or in-memory event bus. Credential safety is structural (only the explicit assistant message field can publish) plus fail-closed filtering for control fragments and recognizable credential forms; operators must still treat model-authored conversation as untrusted display text. ACP, model-neutral rollover changes, packaging, UI/control-plane work, and deployment are not part of Part 1.

## Mandatory Part 2 decision brief

### ACP interoperability

The installed Pi package exports `RpcClient` and `runRpcMode`, but contains no Agent Client Protocol package, ACP server/client, transport, or documentation. Pi RPC is therefore not an ACP implementation and should not be relabeled. SEPT should be an **ACP server first**, projecting the Part 1 conversation/lifecycle contract; any later ACP client/supervisor role should be a separate boundary.

Recommendation: approve the official ACP TypeScript SDK as one explicit dependency and target a single stdio ACP server compatible with Zed (or the user's named ACP client) first. Map one SEPT run to one ACP session, replay/stream durable conversation cursors as session updates, map native cancellation to the existing cancel action, expose bounded tool activity only as metadata (never payload), keep SEPT bearer authentication at the worker boundary, and negotiate only capabilities actually implemented. A network transport should be added only for a concrete client that cannot launch stdio; alternatives are local stdio via a thin adapter or a later authenticated HTTP transport if the selected ACP SDK/spec and client both support it.

Material decision required before Part 2: confirm the first concrete ACP client and transport, and authorize the official ACP SDK dependency/version selected from that client's compatibility requirements.

### Model-neutral rollover

The offline installed Pi catalog provides positive context windows for the current `openai-codex/gpt-5.6-sol` (272,000), other Codex models (128,000/272,000), OpenAI models (128,000–1,047,576), Anthropic models (200,000/1,000,000), and Google Gemini models (131,072/1,048,576). Only OpenAI Codex authentication is currently configured. SEPT already consumes finalized assistant `message_end` usage through Pi's `calculateContextTokens()` and never estimates locally; deterministic production-host tests prove that path, while no new billable cross-provider live request was made.

Recommendation: begin with a compatibility matrix of (1) Codex `gpt-5.6-sol` as the installed baseline, (2) Anthropic Messages with one 200k or 1m model, and (3) Google Generative AI with one 1m Gemini model, using deterministic provider-event coverage for all three and optional credentialed live checks only with explicit cost approval. Fail before invocation when the selected model has missing/invalid context-window metadata; defer an individual rollover sample when finalized successful usage is missing/invalid, never use cumulative spend or a tokenizer fallback. Replace the absolute default reserve with a proportional reserve (recommended 15% of the active context window) while retaining the 75% threshold, so rotation occurs at `min(threshold, 100%-reserve)` across 128k, 272k, and 1m windows. Preserve one native steer and genuine runtime `newSession()`.

Material decision required before Part 2: approve the initial provider/model matrix, proportional reserve and migration policy for the existing token-valued option, and whether any paid live Anthropic/Google checks are authorized or deterministic compatibility evidence is sufficient.
