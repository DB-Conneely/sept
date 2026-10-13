# SEPT

SEPT is a small, durable, single-slot coding worker built directly on the native Pi Durable Harness. Pi owns provider authentication/model access, generation and tool tasks, SQLite conversation history, events, context accounting, steering and native abort. SEPT adds a credential-blind model-access facade, explicit run selection, durable task/operator/handover and public conversation records, drain/cancel lifecycle control, adaptive context rollover, strict limits, an authenticated HTTP worker, and one provider-neutral webhook ingress.

SEPT does not contain a separate provider abstraction, a TUI, or a Codex CLI/app-server transport.

## Install and authenticate

```bash
npm ci
npm run build
npx @earendil-works/pi-coding-agent@1.1.0
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

Every route, including `/health` and the credential-blind model catalogue/selection routes, requires `Authorization: Bearer $SEPT_TOKEN`; bearer tokens are not accepted as CLI options. Secret-bearing login is intentionally CLI-only because this listener is plain HTTP. The worker accepts one resident run and one process owns a state root at a time, including against concurrent `sept run` commands. Its configured state root must be on persistent storage in server operation; durable worker readiness, manifests, state, events, operator evidence, bounded conversations, logs, Pi session files, and handovers live beneath that root. Server workspaces are canonicalized, must be directories beneath `--workspace-root` (default: the worker's launch directory), and cannot escape through symlinks. An agent can return `waiting` after checkpointing coherent work; SEPT then closes Pi/controller resources, reports `worker: "waiting"`, and preserves that run's session and slot without further invocations. An authenticated operator or webhook message is durably queued before acknowledgement and wakes the same Pi session. On restart, a waiting run stays dormant unless a queued wake was interrupted; active and interrupted-wake runs are adopted safely, and ambiguous or malformed format-version-2 run state is rejected. Input racing `complete`, `blocked`, or `waiting` defers the transition so accepted messages are delivered when another invocation remains available; admission fails before persistence at exhausted invocation/timeout boundaries and during an invocation in the final permitted epoch. `timeoutSeconds` counts Pi invocation wall time rather than dormant run age, while invocation and epoch caps remain hard. SIGINT/SIGTERM stops HTTP admission, lets the current Pi invocation reach its next durable checkpoint/handover/terminal boundary, closes Pi, releases both leases, and leaves nonterminal work active for restart adoption. This graceful process stop is separate from `POST /v1/drain`: drain is fsynced at the state root, rejects new tasks and messages, lets previously accepted input settle to waiting or terminal, reports `draining` then `drained`, and remains drained across restart. `POST /v1/tasks/:runId/cancel` first persists targeted cancellation intent, then calls native Durable `conversation.abort()` to join model and tool cancellation; unverified hands cleanup, including an interrupted cancellation on restart, becomes durably blocked for consumer reconciliation, and late controller output cannot replace verified `cancelled`.

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

SEPT disables Pi auto-compaction on its native Durable Harness and keeps project trust disabled. Repository-local Pi extensions/packages do not execute merely by assigning a workspace; Pi still loads project AGENTS.md and operator SYSTEM/APPEND_SYSTEM/skills. Finalized native response hooks supply provider-reported `usage` through Pi's exported `calculateContextTokens()` and the selected model's declared `contextWindow`. Missing/zero usage defers the decision; SEPT has no tokenizer or character-count fallback. Cumulative spend never drives rotation.

At each successful finalized sample, SEPT keeps the last three positive same-conversation growth deltas. It reserves `H = clamp(8% of W, 8192, 65536)` for handover, `N = max(clamp(6% of W, 8192, 65536), ceil(1.5 × maxGrowth))` for the next turn, and a confidence margin of 8%, 5%, or 3% for zero, one, or at least two growth samples. It rotates when `U + H + N + M >= W`; observed tool-heavy growth is never capped. The third consecutive unusable finalized sample stops before the proposed tool round or next generation. SEPT admits one native input with `whenBusy: "steer"` and a stable request identity. Pi places it after the active tool batch and before the next generation. SEPT fsyncs handover JSON, Markdown, event and state before creating a fresh native conversation and provider identity. The successor receives the standing task, independent role, full handover and pending operator messages.

Trusted plugins now use Pi Durable's native declarative extension API; legacy coding-agent ExtensionAPI factories require porting. Place bounded native modules in the trusted agent directory's `extensions/`, or reference agent-directory-local files from `settings.json`'s `extensions` array. Export a native object as `extension` or the default export. Malformed present modules fail closed. Native tools, sections, hooks, wrappers and tasks are supported without a compatibility shim or automatic workspace trust. See [docs/pi-contract.md](docs/pi-contract.md) for format, bounds and trust. The seven Pi tools and minimum native environment use a consumer-supplied Linux hands backend. Brain retains Pi Harness/Models, credentials and SEPT control; see [the supplied profile](docs/pi-contract.md#supplied-hands-reference-profile).

New runs persist `pi-durable.sqlite` and native conversation locators. Start the Durable build with a new persistent `--state-dir`; keep historical coding-agent state with the preserved old runnable build to finish/drain its work. Startup and mutation preflight reject incompatible or incomplete published native history before repair or wake. Terminal legacy history remains readable without repair. See [cutover and recovery](docs/pi-contract.md#cutover-and-recovery); there is no historical converter or permanent engine selector.

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

The image runs as uid/gid `10001`, contains no credentials, sets `SEPT_STATE_DIR=/state/runs` and `SEPT_WORKSPACE_ROOT=/workspace`, and starts `./sept` with `--state-dir /state/runs --workspace-root /workspace`. The required `sept-state:/state` mount therefore backs the production durable state root. Do not omit it or replace it with an ephemeral container layer. That command starts authenticated health/history without execution authority. Supply `--hands` or `SEPT_HANDS_CONFIGURATION` and the explicitly trusted brain Docker control socket to execute in a separately supplied hands namespace. Brain retains state and Pi credentials; hands receives only declared workspace/selected mounts and a read-only text/image resource projection. Operational JSON logs go to stderr.

## Verification

```bash
docker build --no-cache -t sept:c1-confinement .
SEPT_HANDS_TEST_IMAGE=sept:c1-confinement npm run gate
npm audit
```

The acceptance suite drives the production `PiSessionHost`, installed model/auth CLI, authenticated installed `./sept` worker, and deterministic local Pi providers. It proves normalized credential-blind catalogues, Pi credential login/logout/cancellation, fresh per-admission defaults, direct/webhook override and preflight rejection, real custom-provider execution, 128k/272k/~1M adaptive arithmetic, ordinary/tool-heavy growth, persistent unusable usage at safe seams, restart-safe non-duplicate steering, atomic tool-batch completion, native steering preemption, provider-reported context triggering without a local text heuristic, durable-before-successor ordering, fresh session IDs, pre-rotation conversation continuity, no same-session compaction, disabled project extension execution, restart continuity, graceful active SIGTERM, restart while durably draining, Pi-native model/tool cancellation and provider-response abort, bounded transcript replay/SSE reconnect/expiry/backpressure/capacity/shutdown behavior, terminal metadata outside replay pages, queue-to-conversation crash recovery, wait/wake conversation continuity, cross-process state-root ownership, strict caps and cursors, bounded queues/retrieval/logs, canonical workspace confinement, fail-closed HTTP authentication, strict direct/webhook validation, exact operator text, durable retry deduplication, collision handling, task/message routing, wired trace parentage/events, bounded metric labels, correlated JSON logs, payload exclusion, and contained exporter failure.

## Supplied hands

Operators start the dedicated hands namespace separately; SEPT does not provision Docker. The default `docker-linux-v1` profile is file-only with a private persistent writable `/workspace`, read-only `/resources` projection, no shell and no general network. Explicit arbitrary Bash uses a 64 MiB/4096-inode private workspace tmpfs with selected host mounts read-only; the operator seeds/exports artifacts before stopping it. Arbitrary exec with an unquotaed writable host bind is refused.

Pass the trusted JSON profile using `./sept worker --hands /trusted/hands.json` or `./sept run ... --hands /trusted/hands.json`. The immutable container ID and generation, exact flags, mount layout, limits and recovery behavior are documented in [the profile contract](docs/pi-contract.md#supplied-hands-reference-profile). The profile uses `--init` and fixed `sleep infinity`; completed Bash calls join all descendants before returning. Normal close preserves an idle consumer namespace; cancellation/loss stops and verifies all descendants and requires a fresh supplied generation. Failed verification durably blocks the run instead of claiming cancellation. Missing/unsupported enforcement keeps health/history available and refuses native execution.

Installed composition tests own generated consumer containers, seed/export command workspace contents and verify their stopped state. They require the freshly built image identified by `SEPT_HANDS_TEST_IMAGE` (default `sept:c1-confinement`); no alternate production fixture backend is selectable.

### Local hands permissions

`./sept permissions show --state-dir <root> --agent-dir <agent>` reports the current revision. Only local operator commands activate authority; task, webhook and model text cannot grant it. A genuinely empty state root started with `--hands` receives private workspace read/write with Bash absent, selected mounts denied and network none. Existing nonempty state with no valid policy remains readable and dormant until explicit operator configuration. Malformed present policy is never replaced automatically.

Use `./sept permissions set --hands <hands.json> --mode full_access --revision <current> --state-dir <root> --agent-dir <agent>` for the complete supplied hands domain. Full access preserves brain exclusions and the supplied kernel mount protections. This reference profile supports **network none only**; an explicit network request is refused. Persistent selected RW mounts use `readWriteMounts` in the trusted hands configuration and require file-only execution.

For independent file rights, use `permissions set --policy <private-policy.json>` with this bounded schema (at most eight selected aliases):

```json
{
  "mode": "scoped",
  "workspace": { "read": true, "write": true },
  "selected": [{ "root": "/selected/reference", "read": true, "write": false }],
  "execute": false,
  "network": false
}
```

Read and write are independent; edit needs both. File-only operations refuse symlink components, hardlinks and special files and open each directory through a retained descriptor before touching the final inode. Files are bounded to 16 MiB. Search/list tools and workspace instruction/skill discovery require every supplied data mount to be readable; under a partial-read policy those tools are absent and only trusted global resources load. The complete native search/resource bodies remain available for uniform read. Arbitrary Bash requires read/write in the bounded private tmpfs workspace and readable kernel RO selected mounts; write-only execution or persistent RW plus Bash is unsupported.

`./sept permissions revoke --revision <current> --state-dir <root> --agent-dir <agent>` fsyncs denial before stopping and verifying the exact old namespace. Narrowing also stops the dedicated namespace; tmpfs contents may be lost and interrupted writes/commands remain uncertain. Expansion or changed roots/backend requires verified old-owner quiescence and an actual fresh namespace identity/generation, then an explicit worker restart/retry. Changed configuration bytes or root fingerprints alone cannot create a fresh generation. Restart with missing, denied or malformed policy retains history without native scheduling or budget reset; an interrupted active run may remain recorded as active while dormant. Messages refused under known denial are not queued; accepted messages raced by denial retain their exact durable identity without starting effects. No automatic provisioning, permission grants or unsafe replay is performed.

The fixed hands invocation clears ambient environment, disables Node SIGUSR1 inspection and requires a native `PR_SET_DUMPABLE=0` startup acknowledgement before loading any entry or consuming a request. Same-UID commands cannot open the trusted entry's memory or control descriptors. Missing/older images without this guard refuse before effects. The invocation removes its preload and acknowledgement variables before executing commands. Local dead-owner lease reconciliation uses the existing verified owner identity and grace rules; live, foreign or unverifiable owners remain a refusal.
