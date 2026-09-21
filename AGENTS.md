# AGENTS.md

## TypeScript delivery rules

All work under `src/**/*.ts` and `test/**/*.ts` must comply with `.codex/rules/typescript.md`. Treat its structural, documentation, typing, error, security, durability, scaling, testing, and installed-runtime requirements as non-negotiable review gates. Read that file before changing TypeScript. Part 1 implementation must not resume until the separately approved foundation refactor satisfies those rules and its required repository gates are wired.

## Product

SEPT is a thin durable single-slot worker around the native Pi coding-agent SDK. Do not recreate provider clients, agent loops, tool runners, compaction, context tokenizers, TUI features, profiles, or Codex transports. Pi owns those concerns.

The current repository is the customer-side SEPT Node package. Keep model access as a bounded normalization and control module over Pi, not a new provider abstraction. Provider/model discovery, authentication, local/custom-model compatibility, and requests continue to use the installed Pi `ModelRuntime`. A Pod has one Pi credential per provider for the MVP; credentials remain in its configured Pi agent directory and never enter run state, logs, telemetry, conversations, or cloud-facing metadata.

Part 2 is specified in `docs/part-2-execution-spec.md`. It replaces the earlier ACP tranche with Pi-native model access and selection plus adaptive model-neutral rollover. ACP and complete external-agent harnesses are deferred. Do not begin Part 2 merely because the specification exists; execution requires an explicit user instruction.

Do not move the current `src` runtime into speculative monorepo folders during Part 2. When real dashboard and cloud components exist, a separate approved packaging change may place the Node, dashboard, and thin cloud service into clearly separated top-level modules.

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
npm run check
npm test
npm audit --omit=dev
docker build -t sept:local .
```

`npm run gate` composes the strict TypeScript, ESLint, Prettier, complete test, and production dependency-audit gates. Run it after every completed module and before any phase transition. A red or unrun gate is incomplete work, even when the process exits cleanly.
