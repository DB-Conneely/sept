# SEPT

SEPT is a durable, single-slot task worker for Node.js, built on the native Pi Durable Harness. Embed a complete worker in an application, submit tasks from an existing service, or use the installed `sept` CLI. Pi owns models, authentication, generation, tools and native conversation persistence; SEPT adds durable task/operator evidence, wait/wake, bounded HTTP transport, cancellation, drain and context rollover.

## Install and prepare

Requires Node.js **22.19.0 or newer**, ESM, Pi credentials or a suitable configured model, persistent local state, and an operator-supplied Docker Linux hands namespace. Valid hands are required even for text-only tasks. The package does not install Docker or serve models. Optional local setup commands prepare the supported hands profile.

The npm worker runs natively on Linux and macOS; task effects use Linux Docker containers. Apple Silicon uses the ARM64 image through Docker Desktop. Published image tags select AMD64 or ARM64 automatically. Native Windows and Intel Mac task execution remain unqualified. See [release verification](https://github.com/DB-Conneely/sept/blob/main/docs/releasing.md) for exact proof boundaries.

Add SEPT to your application with `npm install --save-exact sept-agent`. The command is `sept` and the import name is `sept-agent`.

To install a retained exact package artifact for a qualified source revision:

```sh
npm install --save-exact /absolute/path/sept-agent-0.1.0.tgz
```

This works without assuming a registry publication. For development from a complete checkout, use `npm ci` then `npm run build`. Configure [models and Pi authentication](docs/models.md), then follow the [supplied-hands setup](docs/pi-contract.md#executable-supplied-hands-setup), including the explicit first-boot policy **before starting a worker or direct run**.

For a fresh empty workspace, the optional helper replaces the manual Docker flags, identity capture and initial permission setup. Have Docker CLI/Engine running and a compatible matching SEPT image already available locally:

```sh
sept hands init --root /absolute/new/sept-instance \
  --engine-socket /run/docker.sock \
  --image ghcr.io/db-conneely/sept:0.1.3 --access files > worker-paths.json
```

Use the four path fields in `worker-paths.json` with `createWorker`, supply your own token, and configure model credentials in its returned `agentDir`. `files` grants workspace read/write; `none` grants neither. Both disable shell and networking. The helper never pulls images or imports an existing project. After awaiting `worker.stop()`, run `sept hands finish --root /absolute/new/sept-instance` to retain a private workspace tar archive and stop the exact owned container. Containers and receipts are preserved. See [helper limits and recovery](docs/pi-contract.md#optional-local-setup-helper).

The supplied brain image runs as UID10001 and stores durable evidence at `/state/runs`. Container operation requires persistent storage, for example `-v sept-state:/state`, plus explicit private Pi credential storage and assigned workspaces. Supply hands as a separate namespace using the linked setup.

## Embed a JavaScript worker

Save as `worker.mjs`. These environment variables are application inputs; the library itself reads no CLI/environment defaults.

```js
import { createWorker } from "sept-agent";

const worker = await createWorker({
  stateRoot: process.env.SEPT_STATE_DIR,
  agentDir: process.env.PI_CODING_AGENT_DIR,
  workspaceRoot: process.env.SEPT_WORKSPACE_ROOT,
  handsConfigurationPath: process.env.SEPT_HANDS_CONFIGURATION,
  token: process.env.SEPT_TOKEN,
  host: "127.0.0.1",
  port: 8090,
});

// The host owns signal handling and must await shutdown.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void worker.stop().catch(() => { process.exitCode = 1; });
  });
}
console.log(worker.address);
```

Required roots/token must be nonempty; use canonical absolute paths and a persistent external state root. Readiness covers the listener/router and synchronous durable adoption; asynchronous Pi/backend execution is observed through task state. `stop()` joins the existing durable boundary. See [SDK lifecycle and ownership](docs/sdk.md#worker-lifecycle).

## Submit from TypeScript

```ts
import { createTaskClient, type TaskRequest } from "sept-agent/client";

const task: TaskRequest = {
  task: "Summarize the supplied evidence, cite its IDs and state what remains unknown",
  maxInvocations: 3,
  maxEpochs: 2,
  timeoutSeconds: 120,
};
const client = createTaskClient({
  baseUrl: "http://127.0.0.1:8090",
  token: process.env.SEPT_TOKEN ?? "",
});
const admission = await client.createTask({
  source: "my-service",
  eventId: "evidence-case-001",
  task,
});
const current = await client.getTask(admission.runId);
console.log(current.state.status);
```

Keep `source`/`eventId` stable across retries. Admission receipts retain their original `active` status; `getTask` reports current state. A timeout or abort can occur after durable acceptance. The [SDK guide](docs/sdk.md) covers all five client methods, finite cursor-gap recovery, limits and error classifications.

## CLI and integrations

The installed CLI uses the same complete worker composition:

```sh
sept auth login --provider openai-codex --method subscription --agent-dir "$PI_CODING_AGENT_DIR"
sept models current --agent-dir "$PI_CODING_AGENT_DIR"
sept worker --state-dir "$SEPT_STATE_DIR" --agent-dir "$PI_CODING_AGENT_DIR" \
  --workspace-root "$SEPT_WORKSPACE_ROOT" --hands "$SEPT_HANDS_CONFIGURATION"
```

The bearer comes from `SEPT_TOKEN`, never a CLI token option. Every HTTP route requires it. One state root has one owner and one resident slot, including while waiting. The [Node application](examples/node-app/README.md) and [incident investigator](examples/incident-investigator/README.md) show the two integration patterns; each owns its finite work and cleanup.

[Formal documentation and AI navigation](docs/index.md) · [HTTP/SSE API](docs/worker-api.md) · [Pi, hands and security contract](docs/pi-contract.md) · [Architecture](docs/architecture.md) · [Observability](docs/observability.md) · [Contributing](CONTRIBUTING.md)

Support is scoped to qualified source/image/host combinations; see [version and support](docs/index.md#version-and-support). The npm artifact is a consumer package; build the Docker image from a pinned complete repository checkout. Host npm Pi stays stock; the [four native-search image assets](image/pi-native-search/README.md) describe the image-only overlay. No publication or deployment is performed by these instructions.

SEPT is [MIT licensed](LICENSE). [NOTICE](NOTICE) retains the known upstream attribution and image-overlay provenance.

Maintainers: [automatic checks and publishing setup](https://github.com/DB-Conneely/sept/blob/main/docs/releasing.md) describes main-push releases, npm trusted publishing and GHCR configuration. Publishing does not deploy a service.
