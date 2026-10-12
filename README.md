# SEPT

SEPT is a small, durable, single-slot coding worker built directly on the official Pi TypeScript SDK. Pi owns provider authentication, model access, the coding-agent tool loop, session history, events, context accounting, steering, native abort, and fresh-session creation. SEPT adds only a credential-blind model-access facade, explicit run selection, durable task/operator/handover and conversation records, drain/cancel lifecycle control, adaptive context rollover, strict limits, an authenticated HTTP worker, and one provider-neutral webhook ingress.

SEPT does not contain a separate provider abstraction, a TUI, or a Codex CLI/app-server transport.

## Install and authenticate

```bash
npm ci
npm run build
npx @earendil-works/pi-coding-agent@0.87.1
```

Build once, then use the installed `./sept` entry point. Authentication delegates to Pi and reads secrets or manual codes from a hidden TTY prompt or standard input—never a command-line option. Pi stores and refreshes credentials in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/auth.json`; SEPT never copies them into defaults, runs, logs, telemetry, conversation, or API responses.

```bash
./sept auth status --provider openai-codex
./sept auth login --provider openai-codex --method subscription
./sept auth login --provider anthropic --method api-key
./sept auth logout --provider anthropic
./sept doctor

./sept models list --provider openai-codex
./sept models select --provider openai-codex --model gpt-6-sol
./sept models current
./sept models validate
```

`sept-model.json` in the Pi agent directory is an atomic mode-0600 record containing only the Pod's default provider/model. Custom Ollama, LM Studio, vLLM, compatible endpoints, and loaded llama.cpp models remain Pi models. SEPT additionally requires explicit `contextWindow` and `maxTokens` on custom `models.json` entries, validates endpoint shape and credential indirection, and does not serve or download models. Sensitive headers always require environment or command indirection; keyless local/private HTTP providers may use only the documented non-secret `apiKey: "local"` sentinel instead of storing an arbitrary plaintext value.

## Run one task

```bash
./sept run \
  --task "Implement and verify the standing task" \
  --role "Act as the repository maintainer" \
  --workspace /absolute/path/to/repository \
  --provider openai-codex \
  --model gpt-6-sol \
  --thinking xhigh
```

Selection precedence is an explicit provider/model pair, the current Pod default, then `openai-codex/gpt-6-sol` only when Pi reports it valid and authenticated. Omitted thinking defaults to `xhigh`. Each admission rereads the Pod default, preflights Pi metadata, availability, and resolved authentication, and persists the final pair in the immutable run manifest before execution. The cwd-relative `.sept/runs` default is only a local-development fallback for an explicitly launched command. Server and container operation must set `--state-dir` or `SEPT_STATE_DIR` to a persistent external state root; never rely on a checkout-local directory or an ephemeral container layer.

## Worker

```bash
SEPT_TOKEN='a-long-random-secret' ./sept worker \
  --host 127.0.0.1 --port 8090 \
  --state-dir /absolute/state/path \
  --workspace-root /absolute/assigned/workspaces
```

Every route, including `/health` and the credential-blind model catalogue/selection routes, requires `Authorization: Bearer $SEPT_TOKEN`; bearer tokens are not accepted as CLI options. Secret-bearing login is intentionally CLI-only because this listener is plain HTTP. The worker accepts one resident run and one process owns a state root at a time, including against concurrent `sept run` commands. Its configured state root must be on persistent storage in server operation; durable worker readiness, manifests, state, events, operator evidence, bounded conversations, logs, Pi session files, and handovers live beneath that root. Server workspaces are canonicalized, must be directories beneath `--workspace-root` (default: the worker's launch directory), and cannot escape through symlinks. An agent can return `waiting` after checkpointing coherent work; SEPT then closes Pi/controller resources, reports `worker: "waiting"`, and preserves that run's session and slot without further invocations. An authenticated operator or webhook message is durably queued before acknowledgement and wakes the same Pi session. On restart, a waiting run stays dormant unless a queued wake was interrupted; active and interrupted-wake runs are adopted safely, and ambiguous or malformed format-version-2 run state is rejected. Input racing `complete`, `blocked`, or `waiting` defers the transition so accepted messages are delivered when another invocation remains available; admission fails before persistence at exhausted invocation/timeout boundaries and during an invocation in the final permitted epoch. `timeoutSeconds` counts Pi invocation wall time rather than dormant run age, while invocation and epoch caps remain hard. SIGINT/SIGTERM stops HTTP admission, lets the current Pi invocation reach its next durable checkpoint/handover/terminal boundary, closes Pi, releases both leases, and leaves nonterminal work active for restart adoption. This graceful process stop is separate from `POST /v1/drain`: drain is fsynced at the state root, rejects new tasks and messages, lets previously accepted input settle to waiting or terminal, reports `draining` then `drained`, and remains drained across restart. `POST /v1/tasks/:runId/cancel` first persists targeted cancellation intent, then calls Pi's native `session.abort()` so model requests and tools receive cancellation; restart completes any interrupted cancellation and late controller output cannot replace `cancelled`.

Each run also has one bounded `conversation.jsonl`. `GET /v1/tasks/:runId/conversation` replays stable cursor-addressed user, assistant, state, and terminal events; `GET /v1/tasks/:runId/stream` provides authenticated SSE replay/live delivery from `after=<cursor>`. Cursor inputs are validated without coercion, retention gaps return `410`, and transcript terminal metadata remains authoritative outside the requested page. Initial task and operator text are preserved exactly, including restart recovery of the durable queue-to-conversation seam. Assistant conversation text comes only from the validated public `message` field in SEPT's response envelope—not Pi reasoning, tool events, WorkControl/Handover data, or operational logs—and fails closed on unsafe controls or recognizable credential material. Validated progress immediately before Pi context steering remains visible across the fresh-session rotation. Streams close at terminal state and send bounded disconnect metadata on shutdown, stream lifetime, cursor expiry, or backpressure.

```bash
SEPT_TOKEN='a-long-random-secret' ./sept health --url http://127.0.0.1:8090/health

curl -X POST -H "Authorization: Bearer $SEPT_TOKEN" -H 'Content-Type: application/json' \
  http://127.0.0.1:8090/v1/tasks \
  -d '{"task":"Fix and verify the issue","role":"Repository maintainer","workspace":"/workspace"}'

curl -N -H "Authorization: Bearer $SEPT_TOKEN" \
  'http://127.0.0.1:8090/v1/tasks/RUN_ID/stream?after=0'

curl -X POST -H "Authorization: Bearer $SEPT_TOKEN" \
  http://127.0.0.1:8090/v1/tasks/RUN_ID/cancel

curl -X POST -H "Authorization: Bearer $SEPT_TOKEN" \
  http://127.0.0.1:8090/v1/drain
```

## Provider-neutral webhook

`POST /v1/webhooks` accepts normalized `task` and `operator_message` events from thin edge adapters. Providers do not get separate agent systems. Each producer supplies a stable `source` and `eventId`; SEPT durably deduplicates identical retries and rejects key collisions.

```bash
curl -X POST -H "Authorization: Bearer $SEPT_TOKEN" -H 'Content-Type: application/json' \
  http://127.0.0.1:8090/v1/webhooks \
  -d '{"version":1,"eventId":"alert-123","source":"monitoring-edge","kind":"task","task":{"task":"Investigate and verify the alert","workspace":"/workspace"}}'
```

See [docs/worker-api.md](docs/worker-api.md) for the exact schemas, limits, retry behavior, model-access routes, and operator-message form. Part 1 evidence is in [docs/part-1-report.md](docs/part-1-report.md); Part 2 delivery evidence is in [docs/part-2-report.md](docs/part-2-report.md).

## Module ownership

`src/cli.ts` is the thin public composition entry point and `src/cli/auth-interaction.ts` is only the terminal Pi auth adapter. Mechanism folders expose intentional `index.ts` surfaces: `model-access` owns credential-blind DTOs, Pi `ModelRuntime` normalization, Pod default, preflight, and safe custom configuration; `durable` owns state contracts and fsynced storage; `observability` owns the injected telemetry facade and its logger/export/metric internals; `pi-integration` owns Pi sessions, prompts, and adaptive rollover; `runtime` owns the controller and single worker slot; and `ingress` owns authenticated HTTP, request validation, model-access projection, and provider-neutral webhook routing. Dependencies flow from composition to ingress/runtime, then to Pi integration and durable state; all runtime-facing mechanisms depend only on the observability facade. The suite enforces those boundaries, and `npm run build` cleans `dist` before compilation so moved modules cannot remain executable as stale output. See [docs/architecture.md](docs/architecture.md).

## Observability

Worker and `run` processes emit bounded-field Pino JSON logs to stderr for container-runtime collection, leaving command results on stdout. OTLP traces and metrics remain collector-bound, while durable run evidence remains under the configured state root. SEPT does not create repository log files. OpenTelemetry traces and metrics are optional and use OTLP/HTTP when a conventional endpoint is configured:

```bash
OTEL_SERVICE_NAME=sept \
SEPT_WORKER_ID=review-worker-1 \
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.internal:4318 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
SEPT_TOKEN='a-long-random-secret' ./sept worker
```

Telemetry covers HTTP, webhook, queue, controller, lease, Pi session/invocation/context/rotation, checkpoint/handover, lifecycle outcomes, exporter health, and bounded process indicators. It never replaces durable files/events and excludes payloads, prompts, model output, tool data, credentials, paths, and session/message IDs. Metric labels use only bounded state/outcome/kind sets. See [docs/observability.md](docs/observability.md) for exact identity, environment, collector topology, retention, cardinality, and safety guidance.

## Context rotation contract

SEPT disables Pi auto-compaction on every active `AgentSession` and keeps project trust disabled, so repository-local Pi extensions/packages are not executed merely by assigning a workspace; Pi still loads project context files such as `AGENTS.md`. It observes Pi's finalized assistant `message_end` event and uses that event's provider-reported `usage` through Pi's exported `calculateContextTokens()` plus the active Pi model's declared `contextWindow`. Missing/zero usage or a missing context window defers the decision; SEPT has no tokenizer or character-count fallback. Cumulative spend from `getSessionStats()` never drives rotation.

At each successful finalized sample, SEPT keeps the last three positive same-session growth deltas. It reserves `H = clamp(8% of W, 8192, 65536)` for handover, `N = max(clamp(6% of W, 8192, 65536), ceil(1.5 × maxGrowth))` for the next turn, and a confidence margin of 8%, 5%, or 3% for zero, one, or at least two growth samples. It rotates when `U + H + N + M >= W`; observed tool-heavy growth is never capped. Three consecutive unusable finalized samples block further invocations only at a safe invocation seam. SEPT then calls `session.steer()` exactly once. Pi delivers that message after the current assistant tool batch completes and before the next model call. The predecessor must then emit a strict handover object. SEPT fsyncs the JSON, Markdown, event record, and state transition before it calls `AgentSessionRuntime.newSession()`. The successor receives the standing task, independent role, full handover, and any pending operator messages.

Pi's official contracts: [SDK](https://pi.dev/docs/latest/sdk), [compaction](https://pi.dev/docs/latest/compaction), [providers](https://pi.dev/docs/latest/providers), and [RPC](https://pi.dev/docs/latest/rpc).

## Docker

Build locally; deployment is intentionally not performed here.

```bash
docker build -t sept:local .
docker volume create sept-pi
docker volume create sept-state

# One-time OAuth login in the same Pi volume:
docker run --rm -it -v sept-pi:/pi-agent sept:local ./node_modules/.bin/pi

docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  -e SEPT_TOKEN='a-long-random-secret' \
  -p 127.0.0.1:8090:8090 \
  -v sept-pi:/pi-agent \
  -v sept-state:/state \
  -v /absolute/workspace:/workspace \
  sept:local
```

The image runs as uid/gid `10001`, contains no credentials, sets `SEPT_STATE_DIR=/state/runs` and `SEPT_WORKSPACE_ROOT=/workspace`, and starts `./sept` with `--state-dir /state/runs --workspace-root /workspace`. The required `sept-state:/state` mount therefore backs the production durable state root. Do not omit it or replace it with an ephemeral container layer. The image writes only to the mounted workspace, state, Pi agent directory, and `/tmp`; operational JSON logs go to stderr rather than that volume.

## Verification

```bash
npm test
npm audit --omit=dev
docker build -t sept:local .
```

The acceptance suite drives the production `PiSessionHost`, installed model/auth CLI, authenticated installed `./sept` worker, and deterministic local Pi providers. It proves normalized credential-blind catalogues, Pi credential login/logout/cancellation, fresh per-admission defaults, direct/webhook override and preflight rejection, real custom-provider execution, 128k/272k/~1M adaptive arithmetic, ordinary/tool-heavy growth, persistent unusable usage at safe seams, restart-safe non-duplicate steering, atomic tool-batch completion, native steering preemption, provider-reported context triggering without a local text heuristic, durable-before-successor ordering, fresh session IDs, pre-rotation conversation continuity, no same-session compaction, disabled project extension execution, restart continuity, graceful active SIGTERM, restart while durably draining, Pi-native model/tool cancellation and provider-response abort, bounded transcript replay/SSE reconnect/expiry/backpressure/capacity/shutdown behavior, terminal metadata outside replay pages, queue-to-conversation crash recovery, wait/wake conversation continuity, cross-process state-root ownership, strict caps and cursors, bounded queues/retrieval/logs, canonical workspace confinement, fail-closed HTTP authentication, strict direct/webhook validation, exact operator text, durable retry deduplication, collision handling, task/message routing, wired trace parentage/events, bounded metric labels, correlated JSON logs, payload exclusion, and contained exporter failure.
