# Pi contract pinned by SEPT

SEPT pins `@earendil-works/pi-coding-agent` 0.85.1.

The implementation uses these public contracts from the installed package:

- `AgentSession` owns the agent lifecycle and exposes `subscribe()`, `steer()`, `abort()`, `setAutoCompactionEnabled()`, `sessionId`, `sessionFile`, and finalized `message_end` events. SEPT persists cancellation intent before calling native `abort()`; Pi propagates its abort signal through active provider and tool work.
- `calculateContextTokens(usage)` interprets the assistant event's provider-reported usage. SEPT calls it only on a successful assistant `message_end`; zero/missing usable values defer rotation.
- `session.model.contextWindow` is the active model's Pi catalog context window.
- `steer()` is delivered after the current assistant tool calls finish and before the next model call.
- `AgentSessionRuntime.newSession()` replaces the active session. Subscriptions are rebound after replacement.
- Pi's OpenAI Codex provider uses ChatGPT Plus/Pro OAuth in `PI_CODING_AGENT_DIR/auth.json`.

SEPT subscribes to Pi events for operational evidence and finalized usage only. It never projects Pi reasoning, partial model output, or tool payloads into public conversation; only SEPT's separately validated assistant `message` response field becomes a conversation record. When finalized provider usage triggers steering, SEPT retains that completed response's validated public message before persisting the handover and calling native fresh-session replacement.

SEPT disables auto-compaction in both settings and the live session. Any observed `compaction_start` is a run failure, not a successful rotation. SEPT also constructs unattended sessions with `projectTrusted: false`: Pi continues loading context files such as `AGENTS.md`, but repository-local extensions, packages, skills, prompts, and themes are not trusted runtime resources.

Primary documentation: [SDK](https://pi.dev/docs/latest/sdk), [RPC](https://pi.dev/docs/latest/rpc), [compaction](https://pi.dev/docs/latest/compaction), [providers](https://pi.dev/docs/latest/providers).
