# SEPT Node SDK

Use ESM on Node.js >=22.19.0. Installation/prerequisites are in the [README](../README.md); complete operator preparation is in [Pi and hands](pi-contract.md#executable-supplied-hands-setup). A valid supplied hands profile is mandatory for execution, including text-only work.

## Public imports

```ts
import { createWorker, SeptError } from "sept-agent";
import type { Worker, WorkerOptions, WorkerAddress, Observability } from "sept-agent";
import { createTaskClient, TaskClientError } from "sept-agent/client";
import type {
  TaskClient, TaskClientOptions, RequestOptions, CreateTaskInput, SendMessageInput,
  TaskAdmission, MessageAdmission, TaskProjection, ConversationOptions,
  TerminalStatus, ConversationPage, CancelResult,
  TaskRequest, RunStatus, Manifest, RunSnapshot, ConversationEvent,
} from "sept-agent/client";
import { loadHandsConfiguration, networkFirewall } from "sept-agent/hands";
import type { DockerHandsConfiguration } from "sept-agent/hands";
```

These are the complete public entries. There is no raw service/store/runtime/host injection or public policy writer. The client entry imports no CLI/worker composition. Imports start no worker, listener, process handler, exporter or configuration write. Source is shipped for maps and inspection, not deep imports. Root and hands declarations do not expose the native Pi authoring declaration graph.

## Worker options

```ts
interface WorkerOptions {
  stateRoot: string;
  agentDir: string;
  workspaceRoot: string;
  token: string;
  handsConfigurationPath?: string;
  host?: string;
  port?: number;
  telemetry?: Observability;
}
interface WorkerAddress { readonly host: string; readonly port: number; }
interface Worker { readonly address: WorkerAddress; stop(): Promise<void>; }
// createWorker(options: WorkerOptions): Promise<Worker>
```

Supply explicit nonempty roots/token. Use canonical absolute directories: persistent private state, a private trusted Pi agent directory for credentials/configuration/code, and a separate workspace root. A worker canonicalizes requested workspaces beneath its assigned root; a symlink cannot escape it. Do not mount state, credentials, agent code or the Engine socket into hands. The library has no CLI/environment/path defaults. Listener defaults are `127.0.0.1:8090`; `port: 0` selects a real ephemeral port. Every route, including health/history/model access, requires the bearer.

The [README host](../README.md#embed-a-javascript-worker) and [complete Node example](../examples/node-app/README.md) show composition through the public factory. `loadHandsConfiguration(path)` parses bounded trusted operator configuration; `networkFirewall(configuration, inspected, family)` generates an exact filter family from actual inspection. They neither provision a namespace nor install filters nor grant permissions; see [operator network setup](pi-contract.md#explicit-hands-network).

## Worker lifecycle

`await createWorker(options)` binds the listener before adoption and resolves after router construction and existing synchronous restart adoption. The returned address is the actual bound endpoint used by backend validation. Pi/backend/model opening continues asynchronously; readiness does not certify a successful first invocation. Observe subsequent lifecycle/error state through `getTask` and authenticated evidence.

`await worker.stop()` stops admission, closes streams/listener, waits for the current durable checkpoint/handover/terminal boundary and releases ownership. Repeated/concurrent calls share idempotent shutdown. There is no force deadline, `start()` or `restart()` method. Failed startup attempts cleanup before rejecting. The caller owns process signals and any supplied telemetry shutdown; default telemetry is no-op. To stop independent resources even after another finalizer fails, attempt each and collect errors (for example `Promise.allSettled` over worker, provider/listener and application-owned telemetry finalizers), then report failed closure.

To reopen, await stop and call `createWorker` again using the same persistent state/agent/workspace roots and validated hands authority. WAIT remains dormant, retaining the run, session, slot and original hard budgets. An accepted later message wakes that same session. A run-bound hands recovery requires an explicitly supplied fresh generation and operator policy activation after old-owner reconciliation; do not reuse a stopped generation or reset state to evade that requirement. Workspace tmpfs export/reseed is consumer-owned.

A same-process stop/reopen resumes durable state but does not promise native extension code reload. The loader imports stable canonical file URLs; Node's process/module-URL cache survives worker and Pi host replacement. Restart the Node process to reliably load edited code at the same path. Instructions/skills have their separate resource-refresh lifecycle; see [native authoring](pi-contract.md#author-build-and-load-a-native-extension).

Stop, drain and cancel are distinct. `POST /v1/drain` durably rejects new tasks/messages across restarts while previously accepted input settles; the five-method client does not wrap it. `cancel(runId)` persists targeted cancellation and requests native abort. `cancelled: true` may accompany `status: "cancelling"`; inspect later state. Cancellation/loss can already have stopped hands and lost tmpfs bytes. Failed cleanup verification becomes blocked with uncertainty, never a successful cancellation claim.

## Integrate an existing service

Create one client for a worker origin. Store delivery identities in your existing request/event store; do not generate a fresh event ID when retrying an uncertain delivery. The service owns retry decisions, finite polling, user-visible status and shutdown. SEPT supplies no scheduler, automatic retries, polling or SSE client.

```ts
const client = createTaskClient({
  baseUrl: "http://127.0.0.1:8090",
  token: process.env.SEPT_TOKEN ?? "",
  timeoutMs: 30_000,
});
const input: CreateTaskInput = {
  source: "case-service",
  eventId: "case-42-initial",
  task: {
    task: "Assess E1. Wait for E2 before writing the final report; cite evidence IDs.",
    role: "Careful evidence reviewer",
    maxInvocations: 3,
    maxEpochs: 2,
    timeoutSeconds: 120,
  },
};
const admission = await client.createTask(input);
```

Omitted workspace uses the worker's configured root. Optional `provider`/`model` must appear together; `thinking` is per task. [Model selection](models.md) is validated before durable admission. One slot includes waiting runs, so a separate task may receive HTTP409 until the resident releases ownership.

## Five client calls

```ts
const admission = await client.createTask(input, { signal });
const current = await client.getTask(admission.runId, { signal });
const page = await client.getConversation(admission.runId, { after: 0, limit: 100, signal });
const message = await client.sendMessage({
  source: "case-service",
  eventId: "case-42-evidence-E2",
  runId: admission.runId,
  message: "E2: the accepted later evidence, preserved exactly\n",
}, { signal });
const cancellation = await client.cancel(admission.runId, { signal });
```

Here `signal` is an application-owned `AbortSignal`; omit options when cancellation is unnecessary. These are independent operations, not an instruction to cancel every completed evidence workflow. `createTask` and `sendMessage` construct version-1 task/operator-message envelopes for `POST /v1/webhooks`. Reads use task/conversation GETs; cancel uses the existing empty-body POST. The [incident example](../examples/incident-investigator/README.md) supplies finite WAIT/evidence/report orchestration.

| Result | Contract |
| --- | --- |
| `TaskAdmission` | `{ kind: "task", runId, status: "active", duplicate }` |
| `MessageAdmission` | `{ kind: "operator_message", runId, messageId, duplicate }` |
| `TaskProjection` | `{ manifest: Manifest, state: RunSnapshot }`, current durable state with public workspace/session aliases |
| `ConversationPage` | `{ events: ConversationEvent[], nextCursor, retainedFrom, terminal }`; terminal is null or `{ status: TerminalStatus }` |
| `CancelResult` | `{ runId, status: RunStatus, cancelled: boolean }`; true need not mean settled |

`TerminalStatus` is `cancelled | complete | blocked | failed`; `RunStatus` also includes `active | waiting | cancelling`. A historical blocked terminal event can precede a later reopened run; current terminal metadata is independent of page position. Request/options types match the import list above: `RequestOptions` is `{ signal?: AbortSignal }`, `ConversationOptions` adds `after?`/`limit?`, `CreateTaskInput` is `{ source, eventId, task }`, and `SendMessageInput` is `{ source, eventId, runId, message }`. `TaskClientOptions` is `{ baseUrl, token, timeoutMs? }`; every method returns a Promise of its named result.

Identical `(source,eventId)` replay returns the original receipt and routing IDs with `duplicate: true`, even after the task finishes. Its `active` admission status is not current status: always use `getTask`. Changed content under the same key returns HTTP409. Stable message identity prevents a duplicate durable admission; operator delivery itself remains at least once and exact accepted text is checkpointed. A timeout, caller abort or transport failure cannot retract acceptance already made durable. Reconcile using the same identity and current state; never assume cancellation of fetch cancelled the task.

## Bounds and errors

| Boundary | Exact limit/default |
| --- | --- |
| Worker origin | HTTP(S), origin only (optional trailing `/`), at most 8192 characters; no userinfo, query, fragment or nonroot path |
| Bearer token | 1..8192 printable ASCII characters (`!` through `~`), no spaces/controls |
| Run ID | `[A-Za-z0-9_-]{1,128}` |
| Timeout | Default 30,000 ms; integer 1..2,147,483,647 |
| Request | At most 256 KiB encoded UTF-8 bytes before sending |
| Response | At most 5 MiB streamed bytes before JSON parsing |
| Conversation options | `after` defaults 0, nonnegative safe integer; `limit` defaults 100, integer 1..250 |
| Delivery source/event | Source `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`; event ID1..256 characters, trimmed, no controls |

Node fetch refuses redirects. Caller abort and timeout share the first owned cancellation cause; timers/readers settle. JSON is decoded as unknown and checked for exact successful status, identity, durable DTO validity, count/cursor ordering and terminal metadata. The retained 4 MiB conversation bound already includes JSON escaping; the transport cap is not a raw-text approximation.

`TaskClientError extends SeptError` has readonly `kind`, optional `status`, and optional validated positive `retainedFrom` for conversation HTTP410. Classify with `instanceof` and `kind`, not message parsing:

| `kind` | Meaning |
| --- | --- |
| `configuration` | Invalid options, identifiers, page/signal or oversized/unencodable request |
| `aborted` | Caller cancellation won; durable acceptance may have occurred |
| `timeout` | Client timeout won; durable acceptance may have occurred |
| `transport` | Fetch/stream transport failed, including redirect refusal; acceptance may have occurred |
| `http` | Non-success HTTP status; `status` is available |
| `protocol` | Malformed, oversized or contract-invalid successful response |

Messages are fixed bounded safe text. They exclude tokens, hostile response bodies and URL/parser secrets, and do not attach unsafe underlying causes. HTTP409 includes occupied slot/drain/key collision; HTTP429 is admission capacity. The [wire API](worker-api.md) retains its routes/statuses and bounds independently of the client.

## Finite 410 recovery

Expired history is a visible evidence gap, including when requesting `after: 0`. Never silently restart at zero or imply retained tail is full history. This example attempts at most three page requests, records the gap, checks authoritative state and requires the application's explicit decision before moving its cursor:

```ts
async function readPage(
  client: TaskClient,
  runId: string,
  after: number,
  acceptGap: (gap: { after: number; retainedFrom: number; current: TaskProjection }) => Promise<boolean>,
): Promise<ConversationPage> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await client.getConversation(runId, { after, limit: 100 });
    } catch (error: unknown) {
      if (!(error instanceof TaskClientError) || error.status !== 410 || error.retainedFrom === undefined) {
        throw error;
      }
      const current = await client.getTask(runId);
      const gap = { after, retainedFrom: error.retainedFrom, current };
      console.warn("Conversation evidence gap", { after, retainedFrom: error.retainedFrom });
      if (!(await acceptGap(gap))) {
        throw error;
      }
      after = error.retainedFrom - 1;
    }
  }
  throw new SeptError("Conversation recovery attempt budget exhausted");
}
```

The decision callback must preserve/report the gap in the application's own evidence. New retention can advance between requests, hence the finite budget. Full pagination/polling also needs caller-owned finite budgets and cancellation.

## Troubleshooting

- Ready but execution refused: verify hands/profile/image, current policy revision and exact running generation. Missing/corrupt policy leaves authenticated history available; do not edit durable JSON or assume default grants.
- Admission HTTP409: inspect current state and readiness; WAIT owns the slot and drain persists. Retry only with a deliberate stable-ID decision after the condition changes.
- WAIT survives restart: expected. Send an explicitly accepted later operator message once authority and budgets permit; do not create a replacement run to hide lost evidence.
- Model failure after ready: inspect task state and run `sept models validate` with the same private agent directory. Readiness is not a successful provider call.
- Edited extension still runs old code: stop/join the worker and start a fresh Node process. Same-process reopen retains module caching.
- Native TypeScript authoring errors: SEPT's public declarations and raw Pi authoring headers are separate graphs. Follow the [Node example's authoring command](../examples/node-app/README.md) and its stated upstream limitations; do not weaken a strict SDK consumer to hide them.
