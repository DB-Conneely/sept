# SEPT

SEPT is a small, durable, single-slot coding worker built directly on the official Pi TypeScript SDK. Pi owns provider authentication, model access, the coding-agent tool loop, session history, events, context accounting, steering, and fresh-session creation. SEPT adds only durable task/operator/handover records, a context-rotation policy, strict limits, an authenticated HTTP worker, and one provider-neutral webhook ingress.

SEPT does not contain a separate provider abstraction, a TUI, or a Codex CLI/app-server transport.

## Install and authenticate

```bash
npm ci
npm run build
npx @earendil-works/pi-coding-agent@0.85.1
```

Inside Pi, run `/login` and select **ChatGPT Plus/Pro (Codex)**. Pi stores and refreshes OAuth credentials in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/auth.json`; SEPT never copies or logs them. Build once, then use the first-class `./sept` entry point for every SEPT command. Verify only the non-secret status:

```bash
./sept doctor
```

## Run one task

```bash
./sept run \
  --task "Implement and verify the standing task" \
  --role "Act as the repository maintainer" \
  --workspace /absolute/path/to/repository \
  --threshold 75 \
  --handover-reserve 50000
```

The default provider/model is `openai-codex/gpt-5.6-sol`. The cwd-relative `.sept/runs` default is only a local-development fallback for an explicitly launched command. Server and container operation must set `--state-dir` or `SEPT_STATE_DIR` to a persistent external state root; never rely on a checkout-local directory or an ephemeral container layer.

## Worker

```bash
SEPT_TOKEN='a-long-random-secret' ./sept worker \
  --host 127.0.0.1 --port 8090 \
  --state-dir /absolute/state/path \
  --workspace-root /absolute/assigned/workspaces
```

Every route, including `/health`, requires `Authorization: Bearer $SEPT_TOKEN`; bearer tokens are not accepted as CLI options. The worker accepts one resident run and one process owns a state root at a time, including against concurrent `sept run` commands. Its configured state root must be on persistent storage in server operation; durable manifests, state, events, operator evidence, logs, Pi session files, and handovers live beneath that root. Server workspaces are canonicalized, must be directories beneath `--workspace-root` (default: the worker's launch directory), and cannot escape through symlinks. An agent can return `waiting` after checkpointing coherent work; SEPT then closes Pi/controller resources, reports `worker: "waiting"`, and preserves that run's session and slot without further invocations. An authenticated operator or webhook message is durably queued before acknowledgement and wakes the same Pi session. On restart, a waiting run stays dormant unless a queued wake was interrupted; active and interrupted-wake runs are adopted safely, and ambiguous or malformed format-version-2 run state is rejected. Input racing `complete`, `blocked`, or `waiting` defers the transition so accepted messages are delivered when another invocation remains available; admission fails before persistence at exhausted invocation/timeout boundaries and during an invocation in the final permitted epoch. `timeoutSeconds` counts Pi invocation wall time rather than dormant run age, while invocation and epoch caps remain hard. SIGINT/SIGTERM stops HTTP admission, lets the current Pi invocation reach its next durable checkpoint/handover/terminal boundary, closes Pi, releases both leases, and leaves nonterminal work active for restart adoption.

```bash
SEPT_TOKEN='a-long-random-secret' ./sept health --url http://127.0.0.1:8090/health

curl -X POST -H "Authorization: Bearer $SEPT_TOKEN" -H 'Content-Type: application/json' \
  http://127.0.0.1:8090/v1/tasks \
  -d '{"task":"Fix and verify the issue","role":"Repository maintainer","workspace":"/workspace"}'
```

## Provider-neutral webhook

`POST /v1/webhooks` accepts normalized `task` and `operator_message` events from thin edge adapters. Providers do not get separate agent systems. Each producer supplies a stable `source` and `eventId`; SEPT durably deduplicates identical retries and rejects key collisions.

```bash
curl -X POST -H "Authorization: Bearer $SEPT_TOKEN" -H 'Content-Type: application/json' \
  http://127.0.0.1:8090/v1/webhooks \
  -d '{"version":1,"eventId":"alert-123","source":"monitoring-edge","kind":"task","task":{"task":"Investigate and verify the alert","workspace":"/workspace"}}'
```

See [docs/worker-api.md](docs/worker-api.md) for the exact schemas, limits, retry behavior, and operator-message form.

## Module ownership

`src/cli.ts` is the thin public composition entry point. Mechanism folders expose intentional `index.ts` surfaces: `durable` owns state contracts and fsynced storage, `observability` owns the injected telemetry facade and its logger/export/metric internals, `pi-integration` owns Pi sessions and prompts, `runtime` owns the controller and single worker slot, and `ingress` owns authenticated HTTP, request validation, and provider-neutral webhook routing. Dependencies flow from composition to ingress/runtime, then to Pi integration and durable state; all runtime-facing mechanisms depend only on the observability facade. The suite enforces those boundaries, and `npm run build` cleans `dist` before compilation so moved modules cannot remain executable as stale output. See [docs/architecture.md](docs/architecture.md).

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

At the configured threshold (bounded by a separately configured handover reserve), SEPT calls `session.steer()` exactly once. Pi delivers that message after the current assistant tool batch completes and before the next model call. The predecessor must then emit a strict handover object. SEPT fsyncs the JSON, Markdown, event record, and state transition before it calls `AgentSessionRuntime.newSession()`. The successor receives the standing task, independent role, full handover, and any pending operator messages.

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

The acceptance suite drives the production `PiSessionHost` and installed `./sept` worker with deterministic local provider doubles. It proves atomic tool-batch completion, native steering preemption, provider-reported context triggering without a local text heuristic, durable-before-successor ordering, fresh session IDs, no same-session compaction, disabled project extension execution, restart continuity, graceful active SIGTERM, cross-process state-root ownership, strict caps, bounded queues/retrieval/logs, canonical workspace confinement, fail-closed HTTP authentication, strict direct/webhook validation, exact operator text, durable retry deduplication, collision handling, task/message routing, wired trace parentage/events, bounded metric labels, correlated JSON logs, payload exclusion, and contained exporter failure.
