# AGENTS.md

## Product

SEPT is a thin durable single-slot worker around the native Pi coding-agent SDK. Do not recreate provider clients, agent loops, tool runners, compaction, context tokenizers, TUI features, profiles, or Codex transports. Pi owns those concerns.

## Completion

- Wired code is the only completion metric. Exercise the installed CLI/worker path and the exact Pi SDK lifecycle path.
- Preserve durable ordering: handover JSON + Markdown + event + state must be fsynced before fresh-session replacement.
- Rotation uses finalized provider-reported Pi assistant usage and the active Pi model context window. Never use cumulative spend or add a local token/character estimate.
- Auto-compaction stays disabled for SEPT sessions. Rotation uses one native `session.steer()` and a genuine `AgentSessionRuntime.newSession()`.
- Preserve fail-closed bearer auth, a single active slot, restart adoption, bounded retrieval/logging, exact operator message evidence, and strict limits.
- Do not expose Pi credentials in logs, output, fixtures, commits, or images.
- Never deploy. The user deploys manually through GitHub CI/CD.

## Commands

```bash
npm test
npm audit --omit=dev
docker build -t sept:local .
```
