# Pi contract pinned by SEPT

SEPT pins `@earendil-works/pi-durable`, `pi-coding-agent`, `pi-ai`, `pi-codemode` and `chord` exactly at 1.1.0 and uses their installed public contracts directly. Pi Durable owns generation, tool tasks, conversation persistence and replay. Coding-agent supplies ModelRuntime, resource loading and the existing tools. The built-in default is `openai-codex/gpt-6-sol` with `xhigh` reasoning.

## Model access and authentication

- `ModelRuntime.create()` is configured with the Pod's Pi `auth.json`, `models.json`, and `models-store.json`. Network catalogue refresh is off by default; Pi's built-ins, stored catalogues, custom providers, and llama.cpp integration remain authoritative.
- `getProviders`, `getModels`, `getAvailable`, `getModel`, `checkAuth`, `getAuth`, and `getProviderAuthStatus` supply discovery, availability, and preflight. SEPT normalizes only IDs, display names, auth state/methods, API dialect, context/output limits, reasoning, and input capabilities. Pi's public `ApiKeyAuth` contract permits both ambient-credential and keyless providers to omit interactive login. SEPT therefore uses the credential-blind `AuthCheck`: a source-free successful API-key check with no login methods is `not_required`, while a check carrying source evidence is `authenticated`/`api_key`. The source label itself is never projected.
- `ModelRuntime.login(providerId, authType, AuthInteraction)` and `logout()` are the only credential mutation paths. Pi's `CredentialStore` retains one credential per provider and owns serialized persistence and OAuth refresh. SEPT never reads or returns credential values.
- Pi `AuthInteraction` supports text, secret, option, and manual-code prompts plus information, authorization URL, device-code, and progress events. SEPT's terminal adapter preserves those forms and propagates cancellation; secrets and manual codes come from hidden TTY input or stdin.
- The Pod default is SEPT's separate `sept-model.json`, containing only format version, provider, and model. Every new direct or webhook run resolves explicit pair > current Pod default > built-in default, then requires Pi model existence, availability, usable metadata, and resolved auth before durable acceptance.
- Pi's `models.json` supports OpenAI Completions/Responses, Anthropic Messages, and Google Generative AI compatible endpoints, environment interpolation, and intentional credential commands. SEPT validates URL safety and requires explicit `contextWindow` and `maxTokens` for custom entries because Pi's generic defaults are insufficient evidence for rollover. Sensitive headers always require environment/command indirection; only the documented `local` API-key sentinel is accepted as plaintext for a keyless local/private HTTP endpoint. Loaded llama.cpp models use Pi's dynamic provider catalogue and are checked from their reported metadata.

## Session and rollover

- One native `Harness` opens each run's `pi-durable.sqlite` with WAL and verified `PRAGMA synchronous = FULL`. Native input submissions and generation/tool tasks commit before publication. SEPT retains its own task, lease, operator queue, checkpoints, handovers and bounded public conversation contract.
- SEPT's string session identity represents the native positive numeric conversation ID. A bounded `*.durable.json` locator identifies that conversation and optional predecessor locator; it is not a JSONL transcript. Native `pi.provider` state supplies a persistent provider-facing UUID, distinct for every fresh conversation.
- The host retains that native UUID before dispatch and calls Pi's supported `cleanupSessionResources(UUID)` on replacement and close. Harness shutdown joins active work before transport cleanup; unrelated sessions retain their own resources. This releases cached provider connections so an installed direct run exits after durable completion.
- SEPT persists cancellation intent before native `conversation.abort()`, including background descendants; the call joins native model/tool cancellation before controller settlement. Native event observation retains lifecycle classifications only.
- `calculateContextTokens(usage)` interprets finalized provider-reported assistant usage. SEPT has no tokenizer, character estimate, provider hardcoding, or cumulative-spend trigger.
- The selected Pi model's `contextWindow` and `maxTokens` are required trusted metadata. Native `GenerationTask.afterResponse` supplies finalized assistant usage. The adaptive policy keeps only positive same-conversation growth and reserves handover, an uncapped observed next-turn allowance, and a confidence margin. Missing, invalid, or regressing samples are never treated as zero.
- The third consecutive unusable finalized sample stops native dispatch before its proposed tool round or next generation. Critical usage, control or persistence failure synchronously closes the Harness, sealing commits and signalling active tasks; shutdown joins happen outside the failing hook. Native generation-hook exceptions alone are advisory and are not SEPT's stop mechanism.
- Rotation admits one native input with `whenBusy: "steer"` and a stable per-conversation request ID. Durable places it after the current tool batch and before the next generation. Recovery reuses a completed submission; an explicitly interrupted handover receives a distinct recovery input, preserving the original steer and predecessor progress.
- The controller passes the exact captured operator-message array into native admission. One bounded, fsynced `pi-durable-admission.json` version-2 record retains the original prompt, captured IDs and native request/conversation key. Recovery looks up that request in native storage, including completed submissions, and retains its original invocation number. Only the exact recovery capture is forwarded; later arrivals remain pending. Native answer IDs make public publication idempotent across a checkpoint crash. SEPT marks the admission checkpointed only after its domain transition is durable.
- `Harness.createConversation()` creates the successor after handover JSON, Markdown, event and state are fsynced. A committed predecessor locator supports successor adoption after interruption. SEPT never resets the old conversation as a substitute for fresh native/provider identity.

At each successful finalized sample, the adaptive policy keeps the last three positive same-conversation growth deltas. For context window W and used context U it reserves `H = clamp(8% of W, 8192, 65536)` for handover, `N = max(clamp(6% of W, 8192, 65536), ceil(1.5 × maxGrowth))` for the next turn, and confidence margin M of8%,5% or3% for zero, one or at least two growth samples. Rotation occurs when `U + H + N + M >= W`; observed tool-heavy growth is never capped.

SEPT subscribes to Pi events for operational evidence and finalized usage only. It never projects Pi reasoning, partial output, provider payloads, auth interactions, or tool payloads into public conversation. Only SEPT's separately validated assistant `message` field is publishable.

SEPT disables auto-compaction in Harness settings. Any observed `compaction_start` is recorded as a violation. Unattended resource loading uses `projectTrusted: false`: Pi still loads SYSTEM.md, APPEND_SYSTEM.md and context files such as AGENTS.md, plus text-only workspace and operator skills; repository-local extensions, packages, prompts and themes receive no execution authority from workspace assignment. Prompt-template expansion remains disabled.

Instructions and skills are rediscovered on host reopen and before fresh successor creation, so operator edits become effective at the next epoch. They are not reloaded on every generation. Native extension modules are imported through stable canonical file URLs and follow Node process/module-URL caching. Pi host replacement, fresh conversations and same-process `createWorker` stop/reopen do not guarantee re-evaluation of edited code. Stop/join the worker and start a fresh Node process to reliably load edits at the same module path. There is no hot reload or cache-busting API.

## Native tools and trusted extensions

SEPT registers Pi's image-capable `read` and existing `write`, `edit`, `bash`, `grep`, `find` and `ls` through native Durable `defineTool()`. Tool arguments, preparation, error results, cancellation and Pi's content limits remain native. A bounded allowance retains Pi's pagination/truncation footer rather than clipping it a second time. The selected model's image resize profile is retained. Read-only tools declare replay safe; write/edit/bash remain replay unsafe, so interrupted side effects are not silently repeated.

For installed image search, Pi's complete grep/find bodies retain native schemas, argv, ignore/git/glob behavior, parsing, formatting, limits and abort conventions. Only their optional spawn callback is patched, revision `sept-native-search-v1`, and SEPT binds it to the active admitted operation. Missing binding refuses. Fixed rg/fd requests carry only the closed program/argv/cwd/command identity; the parent reconstructs exact native argv, requires current READ authority/uniform readability and rejects private roots. Search consumes no Bash execute grant and always denies network. The existing enclosing run/revoke cancellation and native limit handling apply, with no new helper timer. Whole-`/tmp` searches retain physical epoch/MIME name exclusions. Stdout/stderr keep independent UTF-8/order for helpers; Bash combines decoded chunks in arrival order, while custom results remain stdout-only. The existing 4 MiB combined command-output budget and exact drain/descendant joins prevent loss/overflow/cancellation becoming partial normal helper success.

The four image assets are `image/pi-native-search/{overlay.tgz,native-search.patch,provenance.json,README.md}`; only `dist/core/tools/{find,grep}.{js,d.ts}` changes in the installed dependency. Host npm Pi stays stock at 1.1.0; the exact package pins and locked graph are used by `npm ci`. The overlay is applied only inside the Docker build, never by an npm installation hook. Provenance binds upstream integrity/original hashes, patch revision/hash and overlay/effective hashes; Docker checks effective bytes before compilation, after prune and final COPY. The registry 1.1.0 archive omits LICENSE; the exact upstream MIT notice is retained in that existing README and privately copied into `/app` with provenance. [Asset instructions](../image/pi-native-search/README.md) own reproduction details.

Trusted modules are application brain code. Native `extensions/` discovery reads at most 64 directory entries, and `settings.json` may supply at most 64 local module paths. Settings are capped at 64 KiB, paths at 4,096 characters, modules at 1 MiB and each registration array at 64 entries. Canonical module paths must remain inside the configured trusted agent directory; workspace paths and symlink escapes are rejected. Supported files are `.js`, `.mjs`, `.cjs` and Node-supported `.ts`, exporting `extension` or a default native object with a unique bounded `name` and optional native `tools`, `sections`, `hooks`, `wraps` and `tasks`. Malformed present configuration, failed modules and legacy ExtensionAPI factories fail closed. Modules must resolve their own imported dependencies; SEPT supplies no plugin installer or compatibility shim.

Native extensions use the supported registry/GenerationTask/ToolTask/task APIs. Their code remains trusted and can customize behavior; it is not permission-bounded hands. The seven parity tools delegate their existing installed Pi bodies to a separately enforced, consumer-started Linux hands namespace. Native Harness remains the scheduler and replay owner. The supplied `BackendExecutionEnv` shares that backend for text reads/writes and pure namespace path arithmetic; native handle, binary, watch and shell APIs return typed unsupported results. There is no ambient Node fallback. Trusted extension code itself retains full application authority; only effects it requests through the environment use hands. Bash is absent by default and requires the bounded command combination below.

Version-authoritative references are the installed 1.1.0 public declarations, package READMEs and registry metadata. Public native documentation: [pinned Durable README](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/README.md), [models](https://pi.dev/docs/latest/models), [providers](https://pi.dev/docs/latest/providers), and [compaction](https://pi.dev/docs/latest/compaction). The pinned source and installed 1.1.0 declarations are authoritative; moving latest documentation may describe later APIs.

## Author, build and load a native extension

Use the installed 1.1.0 API, with normal bare imports from matching dependencies in the external application. For example:

```ts
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

const marker = defineTool({
  name: "write_marker",
  description: "Write the operator-approved marker to the hands workspace",
  parameters: Type.Object({ text: Type.String({ maxLength: 128 }) }),
  replay: "unsafe",
  async execute(args, api, context) {
    const result = await api.env.writeFile("/workspace/native-marker.txt", args.text, context);
    if (!result.ok) {
      throw result.error;
    }
    return { content: [{ type: "text", text: "Marker written through hands" }] };
  },
});
export const extension = defineExtension({
  name: "example-marker",
  tools: [marker],
  sections: [section("example-marker", () => "Use write_marker only for the requested marker.")],
});
```

The [Node integration](../examples/node-app/README.md) owns the complete pinned authoring/build/copy/run commands. Copy that example into an external ESM app, install the exact SEPT tarball and matching `@earendil-works/pi-durable@1.1.0`/`@earendil-works/pi-ai@1.1.0` authoring dependencies, then run its build command. Compile to ESM `.js` (under a `type: module` package) or `.mjs` **physically beneath that app's private agentDir**, such as `brain/agent/extensions/example.js`. The loaded file's normal ancestor `node_modules` lookup must resolve its bare dependencies. Do not symlink out of agentDir, import an absolute native-dist path or depend on process-CWD repository fixtures. A `.ts` suffix is accepted only to the extent the running Node version supports it; compiled JS is the portable authoring route.

Discovery includes direct supported modules in agentDir's `extensions/`; alternatively set `settings.json` to `{ "extensions": ["custom/example.mjs"] }` for a physical agent-local file. Named `extension` and default native object exports are accepted. Names must match `[A-Za-z][A-Za-z0-9_.-]{0,127}` and be unique; `sept` and `sept-tools` are reserved. Settings 64 KiB, module 1 MiB, path 4096 characters, discovery/settings modules 64 and each registration array 64 remain hard bounds. Malformed objects and legacy coding-agent `ExtensionAPI` factory functions refuse. Port a legacy factory into native declarative tools/sections/hooks/wraps/tasks; do not add an adapter that bypasses native ownership.

Native extensions are **trusted full-authority Node brain code**. Loading confinement controls who installs code; it does not sandbox JS. Effects routed through the supplied `api.env` use hands policy and task identity; direct Node effects retain application authority. Text read/write/path operations are supported; binary/handle/watch/shell environment operations return typed unsupported results. The seven parity tools have their own complete native hands-backed bodies. Instructions, skills, selected mounts and task text never install executable brain code or grant rights.

Raw upstream Pi authoring headers are a separate graph from SEPT's strict public declarations. Their NodeNext JSON declaration imports, optional MCP declarations and DOM types require the example's explicit authoring-tooling diagnosis; do not claim SEPT's public declaration boundary repaired those stock headers or mask a strict SDK failure. Compilation alone is not acceptance: the native loader/registry/Harness must select the tool, include its section in an actual provider request, and produce the supported effect in hands.

Start a **fresh Node process** after edits to reliably reload an unchanged canonical module URL. `await worker.stop()` followed by `createWorker()` in the same process resumes state without promising edited code reload. Instructions/skills refresh on host reopen/successor under their separate resource contract. No hot reload/cache-busting is provided.

## Cutover and recovery

Use a new persistent `--state-dir` for Pi Durable. Keep the original state root and preserved coding-agent build together; use that build to finish or drain its existing work. There is no JSONL converter or engine selector. A new worker or direct run rejects active, waiting or cancelling legacy history before acquiring a lease, repairing conversations or waking queued input. Terminal legacy history can be read without repair; message, cancellation and webhook mutation remain fenced.

Before native adoption or mutation, SEPT reads engine/version, bounded locators/admission and the pinned SQLite schema/metadata without migration. A run-bound initialization receipt is fsynced before first database creation; interrupted initialization resumes only before any published session/invocation or native work, reusing its unique native conversation. Published history missing its engine or locator, corrupt present evidence and mixed engines fail closed; restore a compatible recovery copy or resolve the state before restart. It never interprets missing published native state as a fresh conversation. Unsafe write/edit/bash tasks retain Pi's interrupted-effect report and are not silently replayed. A crash cannot establish whether an external mutation completed; no exactly-once tool-effect guarantee is made.

## Executable supplied-hands setup

These commands are operator-owned setup for one **local** Docker Linux Engine, not deployment or a provisioner. Run from an external ESM application with the exact SEPT tarball installed and its `node_modules/.bin` on PATH. Use POSIX shell, Node and tar; Linux operators also need access to the trusted Engine socket. Docker Desktop operators must choose their actual canonical local Unix socket explicitly. No remote daemon/backend is supported. The brain process needs socket access and private state/agent directories; Docker must traverse the resources bind path as its actual host actor. Check every ancestor's owner/mode and actual memory/PID/disk headroom before initialization. Example limits below are finite values, not throughput promises.

### Pin source, image and Engine authority

Build images from a **complete pinned source checkout**, using an operator-selected commit. The npm artifact is intentionally not a Docker build context: it does not ship the test/compiler/helper-build context. A separate checkout at the required revision avoids modifying another working tree.

```sh
export SEPT_SOURCE=/absolute/path/to/pinned/full/sept-checkout
export SEPT_SOURCE_REVISION=the-full-commit-you-selected
export SEPT_ENGINE_SOCKET=/run/docker.sock  # explicitly choose your trusted local socket
export SEPT_ENGINE_SOCKET="$(node -e 'console.log(require("node:fs").realpathSync(process.env.SEPT_ENGINE_SOCKET))')"
export SEPT_ENGINE_HOST="unix://$SEPT_ENGINE_SOCKET"
sept_docker() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT docker --host "$SEPT_ENGINE_HOST" "$@"
}
test "$(git -C "$SEPT_SOURCE" rev-parse HEAD)" = "$SEPT_SOURCE_REVISION"
git -C "$SEPT_SOURCE" diff --exit-code -- Dockerfile package.json package-lock.json src image
```

Keep the same function/socket for **every** create/inspect/build/seed/export/filter/stop command. Verify the complete source against the chosen revision (including untracked build-context inputs), not only the illustrative tracked diff above. Build after selecting a fresh evidence directory below, or supply an already qualified exact image ID with its corresponding source/provenance receipts.

### Separate roots and capture receipts

Set `SEPT_OPERATIONS_ROOT` to an existing canonical directory whose ancestors the actual Docker actor can traverse. Create a fresh root per task/authority profile. Brain credentials and state remain private; only the initially empty resources directory is mounted into hands. Do not reuse an existing projection directory.

```sh
export SEPT_OPERATIONS_ROOT=/absolute/operator-owned/traversable-directory
export SEPT_OPERATOR_ROOT="$(mktemp -d "$SEPT_OPERATIONS_ROOT/sept.XXXXXXXX")"
export SEPT_OPERATOR_ROOT="$(cd "$SEPT_OPERATOR_ROOT" && pwd -P)"
umask 077
mkdir "$SEPT_OPERATOR_ROOT/brain" "$SEPT_OPERATOR_ROOT/brain/agent" \
  "$SEPT_OPERATOR_ROOT/state" "$SEPT_OPERATOR_ROOT/workspace" \
  "$SEPT_OPERATOR_ROOT/resources" "$SEPT_OPERATOR_ROOT/evidence"
chmod 0755 "$SEPT_OPERATOR_ROOT" "$SEPT_OPERATOR_ROOT/resources"
chmod 0700 "$SEPT_OPERATOR_ROOT/brain" "$SEPT_OPERATOR_ROOT/brain/agent" \
  "$SEPT_OPERATOR_ROOT/state" "$SEPT_OPERATOR_ROOT/evidence"
chmod 2770 "$SEPT_OPERATOR_ROOT/workspace"
export PI_CODING_AGENT_DIR="$SEPT_OPERATOR_ROOT/brain/agent"
export SEPT_STATE_DIR="$SEPT_OPERATOR_ROOT/state"
export SEPT_WORKSPACE_ROOT="$SEPT_OPERATOR_ROOT/workspace"
export SEPT_HANDS_CONFIGURATION="$SEPT_OPERATOR_ROOT/hands.json"
export SEPT_EVIDENCE="$SEPT_OPERATOR_ROOT/evidence"
export PATH="$PWD/node_modules/.bin:$PATH"
sept_docker version --format '{{json .}}' > "$SEPT_EVIDENCE/engine-version.json"
sept_docker info --format '{{json .}}' > "$SEPT_EVIDENCE/engine-info.json"
node --input-type=module <<'JS'
import { statSync, writeFileSync } from "node:fs";
const socket = statSync(process.env.SEPT_ENGINE_SOCKET);
if (!socket.isSocket()) throw new Error("Configured Engine endpoint is not a Unix socket");
writeFileSync(`${process.env.SEPT_EVIDENCE}/socket.json`, JSON.stringify({
  path: process.env.SEPT_ENGINE_SOCKET, dev: socket.dev, ino: socket.ino,
  uid: socket.uid, gid: socket.gid, mode: socket.mode,
}));
JS
```

Capture the daemon ID for later exact-authority comparisons:

```sh
export SEPT_ENGINE_ID="$(sept_docker info --format '{{.ID}}')"
sept_socket_matches() {
  node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
const before = JSON.parse(readFileSync(`${process.env.SEPT_EVIDENCE}/socket.json`, "utf8"));
const now = statSync(process.env.SEPT_ENGINE_SOCKET);
assert.equal(now.isSocket(), true);
for (const key of ["dev", "ino", "uid", "gid", "mode"]) assert.equal(now[key], before[key]);
JS
}
```

Inspect these receipts: the daemon ID, Linux OS, supported API 1.44–1.52 and cgroup v2 must match the intended local authority. Verify the socket is OS-protected against untrusted replacement. Recheck it and the daemon before later setup/finalization. Configure Pi credentials/models privately as described in [models](models.md); never print their values into receipts.

```sh
sept_docker build --no-cache --iidfile "$SEPT_EVIDENCE/image.iid" "$SEPT_SOURCE" \
  > "$SEPT_EVIDENCE/build.log" 2>&1
export SEPT_IMAGE="$(cat "$SEPT_EVIDENCE/image.iid")"
sept_docker image inspect "$SEPT_IMAGE" > "$SEPT_EVIDENCE/image.json"
```

Retain the exact image ID, Linux platform, source revision, helper/dependency/provenance identity and build result. The supplied image owns `/app`, UID10001 brain, UID10002 resident, UID10003:GID10002 commands, C guards and native-search overlay. Installing the host npm package does not produce that image.

### Create and seed one minimal generation

The baseline has `network:none`, `shell:false`, no selected roots and exactly the declared mounts/tmpfs. Do not add host namespaces, devices, ports, control sockets or extra environment/volumes. `--entrypoint ''` selects the fixed idle command independently of the image's brain entrypoint.

```sh
export SEPT_HANDS_ID="$(sept_docker run --detach --init --no-healthcheck \
  --entrypoint '' --user 10002:10002 --read-only --cap-drop ALL \
  --security-opt no-new-privileges --ipc private --network none \
  --pids-limit 128 --memory 1g --cpus 2 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16777216,mode=1777 \
  --tmpfs /workspace:rw,nosuid,nodev,noexec,size=134217728,nr_inodes=32768,mode=2770,uid=10002,gid=10002 \
  --mount "type=bind,src=$SEPT_OPERATOR_ROOT/resources,dst=/resources,readonly" \
  "$SEPT_IMAGE" sleep infinity)"
export SEPT_HANDS_GENERATION="$(sept_docker inspect --format '{{.State.StartedAt}}' "$SEPT_HANDS_ID")"
sept_docker inspect "$SEPT_HANDS_ID" > "$SEPT_EVIDENCE/container-opening.json"
```

Check full 64-character container ID, exact StartedAt, image/platform, Running/PID, finite limits and mounts against the profile. The workspace path on the brain is a **seed/export directory**, not a private-domain RW bind. Put only intended bounded seed files there; use group-compatible directories 2770/files 0660 and no symlinks/hardlinks/special files. The minimal text-only case can keep it empty. Seed using the actual hands actor (the fresh tmpfs is already UID10002:GID10002):

```sh
COPYFILE_DISABLE=1 tar -C "$SEPT_WORKSPACE_ROOT" -cf "$SEPT_EVIDENCE/seed.tar" .
sept_docker exec -i --user 10002:10002 "$SEPT_HANDS_ID" \
  tar --no-same-owner -C /workspace -xf - < "$SEPT_EVIDENCE/seed.tar"
node --input-type=module <<'JS'
import { writeFileSync } from "node:fs";
writeFileSync(process.env.SEPT_HANDS_CONFIGURATION, JSON.stringify({
  profile: "docker-linux-warm-v1",
  engineSocket: process.env.SEPT_ENGINE_SOCKET,
  containerId: process.env.SEPT_HANDS_ID,
  generation: process.env.SEPT_HANDS_GENERATION,
  workspace: process.env.SEPT_WORKSPACE_ROOT,
  dataDomain: "private",
  workspaceLimits: { bytes: 134217728, inodes: 32768 },
  resources: `${process.env.SEPT_OPERATOR_ROOT}/resources`,
  shell: false, readOnlyMounts: [], imageSelected: [],
}), { mode: 0o600 });
JS
```

### Set first-boot rights before initialization

Do this **before any** `createWorker`, `sept worker` or `sept run`. Empty-root default initialization otherwise grants workspace read/write. `permissions show` must demonstrate absent policy/revision 0; do not use these commands to overwrite an initialized policy.

```sh
sept permissions show --state-dir "$SEPT_STATE_DIR" --agent-dir "$PI_CODING_AGENT_DIR" \
  > "$SEPT_EVIDENCE/policy-before.json"
node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
const before = JSON.parse(readFileSync(`${process.env.SEPT_EVIDENCE}/policy-before.json`, "utf8"));
assert.equal(before.revision, 0);
assert.equal(before.denied, true);
writeFileSync(`${process.env.SEPT_OPERATOR_ROOT}/minimal-policy.json`, JSON.stringify({
  mode: "scoped", workspace: { read: false, write: false },
  selected: [], execute: false, network: false,
}), { mode: 0o600 });
JS
sept permissions set --revision 0 --policy "$SEPT_OPERATOR_ROOT/minimal-policy.json" \
  --hands "$SEPT_HANDS_CONFIGURATION" --state-dir "$SEPT_STATE_DIR" \
  --agent-dir "$PI_CODING_AGENT_DIR" > "$SEPT_EVIDENCE/policy-activation.json"
sept_docker inspect "$SEPT_HANDS_ID" > "$SEPT_EVIDENCE/container-after-policy.json"
node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (name) => JSON.parse(readFileSync(`${process.env.SEPT_EVIDENCE}/${name}`, "utf8"));
assert.equal(read("policy-activation.json").freshBackendRequired, false);
const before = read("container-opening.json")[0];
const after = read("container-after-policy.json")[0];
assert.equal(after.Id, before.Id);
assert.equal(after.State.StartedAt, before.State.StartedAt);
assert.equal(after.State.Running, true);
JS
```

Now run the [SDK host](sdk.md#worker-lifecycle) or installed CLI with these exact roots/profile and a secret `SEPT_TOKEN` supplied privately. Minimal rights permit the evidence-only incident workflow while valid hands remains mandatory. Authenticated health/history is available under missing/invalid authority, but that is refused execution rather than a successful task.

For the native file-effect example, set `SEPT_OPERATIONS_ROOT` to the external app directory (so agent-local imports have normal ancestor access to its `node_modules`), then repeat setup with **separate fresh** state/workspace/empty resources/profile/generation; before its first initialization set a scoped policy with workspace read/write true, selected empty, execute/network false. Keep `shell:false`. Never broaden the incident policy to make a file example pass. An existing policy change needs its current revision, old-owner quiescence/reconciliation and fresh generation as described below; do not mutate policy JSON or reuse a stopped generation.

### Export and finalize the owned generation

First await/join the worker and each owned provider/listener; record failure independently. Normal worker stop preserves idle hands, so export needed tmpfs bytes **before** operator stop. Cancel/loss may already have stopped it; export after that is not guaranteed. Keep the archive and seed it into a separately started fresh generation for recovery, retaining private resource-projection ownership receipts. Reuse no unknown/edited projection or marker as deletion authority.

Use these two independent shell stages even if export fails. Before each stage, compare the captured socket/daemon authority, full ID, StartedAt and image to the opening receipt. A mismatch refuses; never stop a replacement. Each authority guard explicitly exits on failure (do not rely on `set -e` inside conditional shell stages). A `set -e` parent must not skip the second stage. Record each actual exit code (and signal/join in the process owner), then inspect both receipts:

```sh
(
  set -eu
  sept_socket_matches || exit 1
  test "$(sept_docker info --format '{{.ID}}')" = "$SEPT_ENGINE_ID" || exit 1
  test "$(sept_docker inspect --format '{{.State.StartedAt}}' "$SEPT_HANDS_ID")" = "$SEPT_HANDS_GENERATION" || exit 1
  test "$(sept_docker inspect --format '{{.Image}}' "$SEPT_HANDS_ID")" = "$SEPT_IMAGE" || exit 1
  test "$(sept_docker inspect --format '{{.State.Running}}' "$SEPT_HANDS_ID")" = true || exit 1
  sept_docker exec --user 10002:10002 "$SEPT_HANDS_ID" \
    tar -C /workspace -cf - . > "$SEPT_EVIDENCE/workspace-export.tar"
) && export_code=0 || export_code=$?
printf '%s\n' "$export_code" > "$SEPT_EVIDENCE/export.exit"
(
  set -eu
  sept_socket_matches || exit 1
  test "$(sept_docker info --format '{{.ID}}')" = "$SEPT_ENGINE_ID" || exit 1
  test "$(sept_docker inspect --format '{{.State.StartedAt}}' "$SEPT_HANDS_ID")" = "$SEPT_HANDS_GENERATION" || exit 1
  test "$(sept_docker inspect --format '{{.Image}}' "$SEPT_HANDS_ID")" = "$SEPT_IMAGE" || exit 1
  if test "$(sept_docker inspect --format '{{.State.Running}}' "$SEPT_HANDS_ID")" = true; then
    sept_docker stop --time 10 "$SEPT_HANDS_ID" || exit 1
  fi
  sept_docker inspect "$SEPT_HANDS_ID" > "$SEPT_EVIDENCE/container-stopped.json" || exit 1
  test "$(sept_docker inspect --format '{{.State.Running}}:{{.State.Pid}}' "$SEPT_HANDS_ID")" = false:0 || exit 1
) && stop_code=0 || stop_code=$?
printf '%s\n' "$stop_code" > "$SEPT_EVIDENCE/stop.exit"
```

Independently verify public listener closure, no live durable controller/state-root/namespace owner, joined Engine attachments/leases and stopped/PID0. A failed export or finalizer remains failed evidence; attempt the other finalizers and reconcile uncertainty. Retain mutex inodes, stopped containers, receipts and recovery bytes; do not remove/prune containers, images, volumes, state or unrelated resources.

## Supplied hands reference profile

`./sept worker` and `./sept run` accept trusted operator `--hands /absolute/configuration.json` (or `SEPT_HANDS_CONFIGURATION`). No configuration means execution refuses before native scheduling while authenticated health/history/model access remain available. SEPT never creates, restarts or removes containers. The one supported profile is `docker-linux-warm-v1`, one dedicated sole-run Docker Linux hands container, immutable container ID plus exact `State.StartedAt` generation. The consumer supplies this shape:

```json
{"profile":"docker-linux-warm-v1","engineSocket":"/var/run/docker.sock","containerId":"64 lowercase hex characters","generation":"Docker State.StartedAt","workspace":"/canonical/consumer-seed-and-export-directory","dataDomain":"private","workspaceLimits":{"bytes":134217728,"inodes":32768},"resources":"/canonical/dedicated/initially-empty/projection","shell":false,"readOnlyMounts":[],"imageSelected":[]}
```

The inspected namespace must use `--init`, an empty image entrypoint, fixed `sleep infinity` idle command and `10002:10002`, with a read-only image, private PID/IPC/UTS/mount namespaces, network `none` or the explicitly configured/inspected filtered network, all capabilities dropped, `no-new-privileges`, and no devices/shared volumes/control socket. Docker memory, PID and CPU limits must be positive finite supported values and match actual cgroup v2 limits. Admission binds their exact values, image and data limits to the generation; live Engine changes refuse before effects. `/tmp` is exactly `rw,nosuid,nodev,noexec,size=16777216,mode=1777`. The image fixes resident UID10002 and command UID10003:GID10002 without the brain group. `/app` is UID10002:GID10001 mode 0750; resident HOME `/home/sept-hands` and physical epoch/MIME captures are private 0700, with captured files 0600. Only the fixed command entry and rg/fd are public root-owned 0555 libexec executables. Guarded processes use clean offline environments and immutable helper/import lookup. Opening verifies these modes, private pinned provenance and all four effective Pi file hashes before recording literal isolation revision `uid-dac-fixed-helper-v1`. The version2 constructor guard remains required. Older images or incompatible receipts refuse without rewriting them; recovery needs fresh qualified generation/authority. Every bind is declared and independently checked; private brain paths and overlaps are rejected. Opening-only RO source provenance checks remain bounded to 4096 entries; neither a native file call nor live profile validation recursively scans the private workspace. Live anchored effects and immutable selected inputs enforce their own identity.

The `private` data domain always uses one shared `/workspace` tmpfs, independent of `shell`: `rw,nosuid,nodev,noexec,size=<workspaceLimits.bytes>,nr_inodes=<workspaceLimits.inodes>,mode=2770,uid=10002,gid=10002`. Bytes are finite/page-aligned and inodes positive finite; declared limits must match actual tmpfs totals and leave measured memory for tools/helpers/commands. Consumer seeding/export and fresh-generation preservation are explicit; stopping loses tmpfs data. Group-compatible native files are 0660 and directories inherit the setgid workspace group. `mutable-file-bind` retains an anchored workspace bind plus selected individual-file binds; commands, discovery, workspace resource traversal and imageSelected refuse. Private-domain RW host binds and ordinary unsealed RO host inputs refuse. Genuinely sealed RO host data remains optional Linux compatibility: its root, every directory and regular single-link file require `FS_IMMUTABLE_FL`. Only trusted host administration can remove seals; changes need quiescence, resealing and fresh generation. This is not a requirement for the empty/image-selected path and no sealing machinery is added. `/resources` is the brain-owned read-only public projection. The resident builds a bounded authorized executor-private epoch view before Pi's resource loader reads it; commands and hostile workspace aliases cannot read its private bytes or substitute control authority.

Optional `imageSelected` is an array of exact `{ "alias": "reference" }` objects, absent→`[]`. Each alias matches `[A-Za-z0-9_-]{1,64}` and denotes `/selected/<alias>` in the exact pinned image, without a host source path/stat/seed. Existing host aliases retain `[A-Za-z0-9_-]+`, including longer aliases. The combined image/RO/RW inventory allows at most eight unique aliases; existing selected read grants and fingerprints cover them. Only `private` admits image aliases. Opening `hands-selected-inputs` invokes the shared descriptor-anchored C walk: one filesystem, directories/single-link regular files only, 4096 entries, depth 128 and 4096-byte paths. Symlinks, hardlinks, devices, FIFO/socket and oversized trees refuse. Image mode relies on image/read-only-rootfs provenance instead of per-inode host seals. No equal, ancestor or subtree mount may overlap an image alias, at opening or live effects. The consumer must bake changed data/code into a new image and supply fresh generation/authority after quiescence; no runtime COPY/provisioning path exists. See [the bounded consumer Dockerfile recipe](#selected-image-data-and-code).

Brain reaches only the explicitly configured absolute OS-protected Engine Unix socket, with API negotiation in 1.44–1.52, bounded core HTTP and non-TTY exec streams. Ambient context/`DOCKER_HOST` never select authority; socket device/inode/owner/mode and daemon identity are retained and checked. Hands rejects the control socket mount. One guarded resident uses a clean offline environment (`PATH`, `HOME=/home/sept-hands`, `TMPDIR=/tmp`, `PI_OFFLINE=1`) and retains installed Pi imports, native discovery bodies and its length-prefixed RPC attachment. Version/generation/configuration/session/sequence/challenge correlation authenticates the exact exec and grants no rights. Requests refresh grants, roots, arguments, abort owner and resource epoch; the brain parent checks live authority adjacent to each anchored effect. Bash/custom bytes and fixed rg/fd children execute at UID10003:GID10002 with the same workspace, without Pi startup, provider credentials or inherited control descriptors. A separate command session plus DAC/nondumpability/guards protect resident fd/mem/environ, ptrace/process_vm, signals (including SIGCONT), private app/HOME/capture bytes and imports. Some public proc metadata and resident cmdline correlation remain visible; stdout/correlation knowledge cannot dispatch or acknowledge control. Global instructions and bounded text/image skill assets are copied byte-for-byte to a dedicated projection, mounted read-only at `/resources`. Refresh requires a private fsynced ownership receipt whose bounded file/directory hashes match the existing projection. A consumer-created marker grants no deletion authority; unknown or edited projection data causes refusal before mutation. Only verified derived projection files are refreshed. Native skill locations and workspace cwd/tool paths use hands aliases, never the brain agent directory. Workspace resources are rediscovered in hands on reopen and before a successor epoch; workspace extensions never execute in brain.

If projection refresh refuses after a durable handover, the existing recovery protocol retains `active`/`replacing` and the resident reports busy, while the controller and hands lease close. Provider calls and active-time accounting stop; SEPT does not automatically relaunch. The consumer restores the dedicated projection or supplies a fresh supported namespace/projection, then uses the existing explicit worker restart recovery path. Original consumer bytes and the durable predecessor handover remain intact.

A private fsynced `hands-binding.json` records run/namespace/generation/cwd before scheduling; a namespace lease excludes concurrent runs. Recovery requires a fresh consumer-started generation, with consumer-reproduced workspace contents. Native conversation, provider identity and captured admission remain unchanged; cwd is configured while Harness is paused. Generated session locators in successor and initial recovery model contexts use `<pi-session>/basename`; private fsynced handovers retain their original locators and exact operator text. Native safe replay also uses hands; missing backend authority never replays locally. Unsafe effects retain native interrupted/uncertain results.

Every completed Bash/custom/helper operation joins detached, setsid, SIGTERM-resistant, forking and socket descendants through the fixed trusted command owner before returning. Its bounded namespace census preserves only the captured init/idle/resident PID+start identities. Ambiguous identity, churn or unverified joins stop and verify the entire exact generation. Normal close joins queued/active operations, closes the resident attachment and releases its Engine connections/namespace lease, retaining the idle consumer namespace. Ordinary native body errors and verified command timeout/overflow can leave that channel usable. Cancellation, revocation, expiry, backend identity/transport loss or malformed/oversized frames seal admission and stop the dedicated generation; `Running=false`/`Pid=0` is required before successful settlement. Uncertain effects remain uncertain. Failed shutdown verification durably records `blocked` with `controller_failure`, preserves cancellation intent and requires consumer reconciliation. A fresh supplied generation and explicit retry are required after stop; tmpfs bytes are lost unless the consumer exported them before teardown.

The channel bounds requests to 512 KiB, results to 4 MiB and owned FIFO work to eight with one active operation. Setup, partial-frame and shutdown deadlines do not impose a generic 30-second native work limit; native Bash timeout and enclosing run budget remain authoritative. `EngineControlError` retains sanitized stage/elapsed/status/exit-code/timeout/overflow and observed join facts; unknown signals remain null. `HandsBackendUnavailableError` records authority loss, possible uncertain effects and observed namespace closure. Peer command bytes, stderr, credentials and raw RPC payloads are excluded from operational diagnostics.

The image includes image-owned `ripgrep` and official fd 10.5.0 (musl archives with pinned hashes) for the installed Pi bodies. It has no Docker CLI dependency: trusted brain control uses the configured Engine socket directly. Reference enforcement follows [Docker run](https://docs.docker.com/engine/containers/run/). Live per-effect rights and exact local operator decisions share the installed backend. Missing permission blocks the original native call, fsyncs bounded exact facts, closes active ownership and publishes dormant waiting. Approval selects a validated fresh namespace and current revision; only a new explicit accepted input may retry the exact operation. No parked hook, hidden provider loop or automatic original-call resumption exists. Native task identity distinguishes a new task reusing a provider call ID from the original denied task.

The official [fd 10.5.0 release](https://github.com/sharkdp/fd/releases/tag/v10.5.0) matches the pinned Pi tools-manager Linux artifact selection and supports `--no-require-git`; Debian bookworm fd 8.6 does not. Transport admits at most eight owned requests and dispatches one at a time to fit the kernel PID/memory limits. This is bounded effect transport backpressure; native Pi retains all task scheduling and replay.

## Live operator capability authority

Installed worker and direct composition bind `CapabilityPolicyStore` to the same `DockerExecutionBackend` used by native tools, safe replay, resource refresh and `BackendExecutionEnv`. The private version-1 policy is at the state root, bounded to 16 KiB/eight selected aliases, atomically fsynced with monotonic compare-and-swap revisions. Revocation/narrowing persists before exact-generation namespace stop; the registered FIFO owner rechecks current revision, roots and generation immediately before dispatch and result settlement. A file watcher joins active incompatible effects after policy replacement or malformed state. Failed stop acknowledgement remains a failed close; cleanup uncertainty is never reported as successful cancellation.

Native registrations reflect independent read/write rights; edit requires both. Complete Pi read/write/edit bodies use anchored hands-side operations, including MIME detection, bounded regular single-link file access and no symlink component following. Native text read/write uses that same owner. The reference profile deliberately refuses partial-read native search/list and project-resource discovery: all configured image/RO/RW selected roots, including omitted aliases, must be readable for those complete bodies. Restricted policies retain trusted global prompts/resources and independent file tools. Supported uniform-read policy preserves existing seven-tool, image, ancestor, internal resource-symlink, global skill and refresh behavior. Trusted operator extensions remain application code; native API access never makes task text a policy writer.

Full access covers only the supplied domain. Network is independently explicit and requires a consumer-owned connected namespace with exact inspected IPv4/IPv6 exclusions (see [explicit hands network](#explicit-hands-network)); arbitrary Bash requires the existing bounded tmpfs workspace and readable selected RO image/sealed-host roots. Selected persistent RW is file-only. Every expansion/backend/root change requires validated quiescence and a genuinely fresh container/generation; a root fingerprint change cannot qualify the current namespace. Recovery stops and verifies an old run-bound namespace before binding fresh authority and native scheduling. Missing/denied/malformed policy leaves state dormant, preserves exact accepted inputs and budgets, and does not blindly replay uncertain mutations. Explicit accepted operator configuration plus the existing restart/retry/message path is required; exact local decisions never dispatch without a new accepted retry input.

The reference image must include the fixed `hands-guard.so` built from `hands-guard.c`. Trusted transport uses only the fixed cleared environment/preload, `--disable-sigusr1` and a fixed pre-entry acknowledgement check. The guard sets and verifies Linux process nondumpability before Node; the entry clears preload/marker variables before tools. Old/missing-guard images fail startup validation and cannot be adopted. Executed command children cannot open trusted entry memory or control descriptors; descendant membership is still joined before Bash settlement.


Trusted native tool registrations keep their API/Models/task ABI. SEPT supplies the same BackendExecutionEnv with actual conversation/task identity for supported text effects; an identity-unavailable missing-permission native effect refuses. One exact operator `customHand` pins path/lowercase SHA256/`safe` or `unsafe` replay below an admitted RO image or genuinely sealed host alias. The bounded execution profile still requires shell:true, execute, workspace read/write and all selected roots readable. Anchored code is read once (64 KiB maximum), hash-checked and the exact bytes/input rechecked by the parent before clean Node execution. Native `custom_hand` text has `maxLength: 256`, with an additional 1024-byte transport bound and optional boolean network intent. Result stdout is limited to 4096 bytes (native output limits 4096 bytes/64 lines); stderr is separately drained/bounded inside the 4 MiB operation budget and excluded from the result. The existing 5-second custom timeout remains. No native API object or credentials enter the child. SAFE replay rechecks live authority/pin; UNSAFE retains interruption uncertainty without repeating effects. The original denied task remains denied even after broader operator mode changes. See [exact local decisions, expiry and direct resume](#exact-permission-requests-and-local-retry).

The single custom tool pins its operator path/hash/replay in native task memo evidence before execution intent. Recovery requires that original pin to be present and unchanged before effects; replacement code needs a new native task. This memo grants no permission and never resumes a denied original call.

Bash/custom argument `network` is a validated optional boolean, default false, retained in the exact native permission digest. The dispatch owner checks live policy or the exact approved retry before supplying the guard environment. Network denial uses inherited seccomp with native architecture validation and denied io_uring setup; positive grants permit ordinary private/CGNAT/ULA peers and private DNS while the connected firewall excludes all reachable public/private brain aliases, special and metadata addresses. A shared protected/gateway resolver allows only destination53 and requires complete protected service facts without a port53 conflict. Consumer inventory, runtime-derived namespace topology and current brain interfaces are portable facts checked at each effect and bound by the existing configuration fingerprint. Malformed topology/filter/guard or stale policy prevents dispatch. The existing native tool bodies, unsafe replay declarations, scheduler and cancellation ownership remain the production path.


## Selected image data and code

Trusted hands JSON may add `"imageSelected": [{ "alias": "reference" }, { "alias": "hand" }]`. Omission normalizes to `[]`; each object contains exactly `alias`, matching `[A-Za-z0-9_-]{1,64}`, and maps to `/selected/<alias>` in the pinned image. The combined `imageSelected`, `readOnlyMounts` and `readWriteMounts` inventory has at most eight unique aliases. Existing host-mount aliases keep their `[A-Za-z0-9_-]+` grammar, including aliases longer than 64; only image aliases have the 64-character limit. These read-only image roots enter the existing selected policy grants; merely configuring an alias grants no read right. There is no host source path, host stat, mutable seed or runtime copy API for an image alias.

For example, a consumer Dockerfile can add two small regular files to an already qualified SEPT base image. Supply its immutable image reference as `SEPT_IMAGE`; this recipe is documentation only:

```dockerfile
ARG SEPT_IMAGE
FROM ${SEPT_IMAGE}
USER 0:0
COPY --chown=0:0 --chmod=0444 reference.txt /selected/reference/reference.txt
COPY --chown=0:0 --chmod=0444 hand.mjs /selected/hand/hand.mjs
RUN chmod 0555 /selected /selected/reference /selected/hand
USER 10001:10001
```

Keep selected trees on one filesystem, with only directories and single-link regular files: at most 4096 entries, depth 128 and paths 4096 bytes. Symlinks, hardlinks, sockets, devices and other special files refuse. Start a fresh consumer container from the resulting exact image with the required read-only rootfs/profile, record its actual ID/`State.StartedAt`, and activate fresh policy authority after verified old-owner quiescence. No mount may equal, cover an ancestor of, or lie below an image alias; this is checked at opening and live effects. New data/code requires a new image and fresh generation/authority. Workspace seed/export remains separate. Genuinely recursively sealed RO host inputs remain optional Linux compatibility, without a sealing provisioner or a seal prerequisite for the image route.

The image-only Pi patch is revision `sept-native-search-v1`. [Its four assets](../image/pi-native-search/README.md) are `overlay.tgz`, `native-search.patch`, `provenance.json` and `README.md`; the overlay changes only native `find`/`grep` JS and their matching declarations. Host npm Pi stays stock1.1.0; the image build uses the exact locked package graph. The overlay is Docker-only. Provenance binds upstream integrity, original/effective hashes and patch/archive hashes; Docker checks effective bytes before compilation, after prune and final COPY. The pinned registry 1.1.0 archive omits LICENSE, so the exact upstream MIT notice is retained in the asset README and privately copied into `/app` with provenance. Opening checks private modes and installed hashes before recording literal isolation revision `uid-dac-fixed-helper-v1`. Older images/receipts refuse without rewriting history; use fresh qualified authority.


## Local hands permissions

`sept permissions show --state-dir <root> --agent-dir <agent>` reports the current revision. Only local operator commands activate authority; task, webhook and model text cannot grant it. A genuinely empty state root started with `--hands` receives private workspace read/write with Bash absent, selected mounts denied and network none. Existing nonempty state with no valid policy remains readable and dormant until explicit operator configuration. Malformed present policy is never replaced automatically.

Use `sept permissions set --hands <hands.json> --mode full_access --revision <current> --state-dir <root> --agent-dir <agent>` for the complete supplied hands domain. Full access preserves brain exclusions and the supplied kernel mount protections. Network remains an independent explicit operator right: `--mode full_access` leaves it disabled. A connected consumer namespace may supply the enforced network contract below; enable `network: true` in `--policy` to grant its network domain. Persistent selected RW mounts use `readWriteMounts` in the trusted hands configuration and require file-only execution.

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

Read and write are independent; edit needs both. File-only operations refuse symlink components, hardlinks and special files and open each directory through a retained descriptor before touching the final inode. Files are bounded to 16 MiB. Search/list tools and workspace instruction/skill discovery require every supplied data root to be readable; under a partial-read policy those tools are absent and only trusted global resources load. The complete native search/resource bodies remain available for uniform read. Arbitrary Bash requires read/write in the bounded private tmpfs workspace and readable selected RO image/sealed-host roots; write-only execution or persistent RW plus Bash is unsupported.

`sept permissions revoke --revision <current> --state-dir <root> --agent-dir <agent>` fsyncs denial before stopping and verifying the exact old namespace. Narrowing also stops the dedicated namespace; tmpfs contents may be lost and interrupted writes/commands remain uncertain. Expansion or changed roots/backend requires verified old-owner quiescence and an actual fresh namespace identity/generation, then an explicit worker restart/retry. Changed configuration bytes or root fingerprints alone cannot create a fresh generation. Restart with missing, denied or malformed policy retains history without native scheduling or budget reset; an interrupted active run may remain recorded as active while dormant. Messages refused under known denial are not queued; accepted messages raced by denial retain their exact durable identity without starting effects. No automatic provisioning, permission grants or unsafe replay is performed.

The fixed hands invocation clears ambient environment, disables Node SIGUSR1 inspection and requires a version-2 native `PR_SET_DUMPABLE=0` guard acknowledgement before loading the resident. Commands use their separate fixed UID and receive no Engine socket, resident control descriptors, Models/task API or credentials. Missing/older guard images refuse before effects. Immutable image helpers and a fixed trusted process join owner protect the resident and current resource epoch from command memory, signal and path access. Local dead-owner lease reconciliation uses the existing verified owner identity and grace rules; live, foreign or unverifiable owners remain a refusal.

## Exact permission requests and local retry

Set `mode: "request_approval"` in the same private policy schema to keep its baseline independent rights and let supported native tool calls request missing authority. Missing permission fsyncs an exact bounded request and blocks the original call before effects. The active native invocation and effect handles close before SEPT publishes `waiting`; no provider work or active budget is parked while the operator decides. Pending restart stays dormant, including previously accepted queue entries. An uncertain crashed active interval keeps the existing conservative budget debit.

Use the installed local commands, supplying the inspected request ID/digest, current revision and genuinely fresh profile in the named environment variables:

```sh
sept permissions requests --state-dir "$SEPT_STATE_DIR" --agent-dir "$PI_CODING_AGENT_DIR"
sept permissions inspect --request "$SEPT_REQUEST_ID" --state-dir "$SEPT_STATE_DIR" --agent-dir "$PI_CODING_AGENT_DIR"
sept permissions approve --request "$SEPT_REQUEST_ID" --digest "$SEPT_REQUEST_DIGEST" --revision "$SEPT_POLICY_REVISION" --hands "$SEPT_FRESH_HANDS" --expires 300 --state-dir "$SEPT_STATE_DIR" --agent-dir "$PI_CODING_AGENT_DIR"
sept permissions deny --request "$SEPT_REQUEST_ID" --digest "$SEPT_REQUEST_DIGEST" --revision "$SEPT_POLICY_REVISION" --state-dir "$SEPT_STATE_DIR" --agent-dir "$PI_CODING_AGENT_DIR"
```

Approval matches the original operation/content digest and source revision/namespace, validates quiescence and an explicitly selected genuinely fresh target, then binds the exception to that target revision/generation. Policy activation precedes the exact decision, so interruption between writes grants nothing. Duplicate decisions are inert; conflicting decisions, changed content, cancellation, revoke and expiry cannot resurrect the original call. One later matching native task can claim the exception. Safe replay still checks live authority; unsafe replay keeps native uncertainty rather than repeating effects. Approval expiry stops and joins an executing namespace.

Approval itself never dispatches. Send a new accepted operator message to the existing worker run, or use the local direct path after a direct run has returned waiting:

```sh
sept run --resume "$SEPT_RUN_ID" --message "Retry the exact approved operation" --hands "$SEPT_FRESH_HANDS" --state-dir "$SEPT_STATE_DIR" --agent-dir "$PI_CODING_AGENT_DIR"
```

The existing slot, accepted-message capacity, invocation/epoch limits and active-time budget apply. Resume cannot change the original task, model or limits. A state root retains at most 32 exact requests with at most 64 KiB canonical argument content each; overflow refuses without dropping prior denial evidence. Existing policy-permitted calls retain the separate 512 KiB transport bound.

The supplied hands configuration may register one exact `customHand` with `{ "path": "/selected/hand/hand.mjs", "sha256": "<64 lowercase hex>", "replay": "unsafe" }`. Its code path must be below an admitted read-only image alias or genuinely sealed host alias; `shell:true`, execute authority, bounded tmpfs read/write and uniform selected read rights are required. The protected entry reads anchored regular code once (at most 64 KiB), checks its SHA256 and runs those exact bytes as a clean Node child. The parent rechecks the exact code hash and input; no native Models/task/policy/control object or credentials enter the child. Native `custom_hand` accepts `{ "text": "...", "network": false }` with optional network intent, text `maxLength: 256` and an additional 1024-byte transport bound. Its result is stdout only, bounded to 4096 bytes with native output limits of 4096 bytes/64 lines; stderr is separately bounded/drained within the 4 MiB operation budget and never appended to the result. The existing 5-second custom timeout, cancellation and descendant joining use the same live namespace owner. The operator declares truthful `safe`/`unsafe` native replay: SAFE rechecks live rights/pin before replay, UNSAFE retains interruption uncertainty without repeating effects. Repository instructions and model arguments cannot register code or choose executable paths.

The single custom tool pins its operator path/hash/replay in native task memo evidence before execution intent. Recovery requires that original pin to be present and unchanged before effects; replacement code needs a new native task. This memo grants no permission and never resumes a denied original call.

## Explicit hands network

A connected `docker-linux-warm-v1` hand sets its `network` field to this trusted object, in addition to its existing identity/mount fields:

```json
{
  "networkId": "64 lowercase hex characters from docker network inspect",
  "protectedAddresses": ["203.0.113.20", "2001:db8::20"],
  "dnsServers": ["1.1.1.1"]
}
```

The consumer starts hands on that exact dedicated network ID with `--dns` matching `dnsServers`, no published ports, and the same uid, capabilities, mount and resource protections. `protectedAddresses` is the complete trusted inventory of reachable brain/control aliases and deployment-specific metadata endpoints, public or private. SEPT requires every current routable brain interface to appear in this inventory and derives the hands namespace's gateway and self addresses from Docker inspection. Its fixed trusted inspection also resolves `host.docker.internal` and `gateway.docker.internal` through each configured resolver and the namespace's hosts file; discovered addresses must be protected. Docker Desktop requires both aliases to be inspectable, so a private resolver which omits them needs the actual engine upstream as the second resolver. Ordinary Linux engines may have no such aliases. `127.0.0.11` is the embedded resolver, not an upstream recursive server. An explicit network grant permits ordinary private IPv4, CGNAT and IPv6 ULA peers and private DNS. Loopback, special/link-local/multicast, known metadata and all protected/gateway/self addresses remain excluded. DNS names, redirects and address changes cannot bypass destination drops.

When a configured resolver shares a protected or gateway address, also supply `protectedEndpoints`, a complete list of its protected `{ "address": "10.20.30.1", "port": 8090 }` services. Missing overlap facts or a protected service on port 53 refuse admission. The worker's actual bound endpoint is checked before adoption and dispatch; an actual protected port 53 conflict overrides a declared non-53 endpoint. Only UDP/TCP destination port 53 is allowed before the address exclusion; every other port stays blocked. The inventory is bounded to 32 protected addresses, two resolvers and 64 protected endpoints and belongs to trusted consumer configuration, never model input. All configuration facts enter the existing fingerprint; topology, interface or filter changes refuse effects until validated quiescence and a fresh generation. Docker's embedded resolver `127.0.0.11` permits only DNS original tuples and their established replies. No device-specific address or path is built into the network profile.

Before admission the consumer installs the exact filter tables generated by `networkFirewall(configuration, inspectedContainer, "ipv4"|"ipv6")` from the public `sept-agent/hands` entry, using its own privileged `iptables-restore`/`ip6tables-restore` setup. The image contains these utilities; commands retain no capabilities. SEPT only inspects the actual tables with its trusted Docker control client, before configuration and every dispatch, and refuses absent or altered protection. Consumers own setup/restart; there is no new network service.

Bash and `custom_hand` accept optional `network: true` in their native argument schema. Omitted/false intent inherits a seccomp socket denial even inside a connected namespace; child environment changes and exec cannot remove it. Both an explicit policy grant and true intent are needed for network effects. In `request_approval`, missing network creates an exact argument/digest-bound request: the original call remains denied, a local operator decision binds a fresh generation, and an explicit retry may produce the network effect. Revocation publishes denial before stopping/joining the exact namespace. Network expansion requires quiescence and a fresh generation, including restart.

The connected proof uses a **separate fresh root and generation**, with `shell:true` only where the existing Bash/custom network effect requires it. Supply an already provisioned dedicated network and an audited complete `network` object; this package does not discover/provision your deployment inventory. Obtain its full ID with the same explicit authority:

```sh
sept_docker network inspect "$SEPT_NETWORK_NAME" > "$SEPT_EVIDENCE/network.json"
export SEPT_NETWORK_ID="$(sept_docker network inspect --format '{{.Id}}' "$SEPT_NETWORK_NAME")"
```

In the fresh create command replace `--network none` with `--network "$SEPT_NETWORK_ID"` and `--dns` for each exact configured upstream resolver. Preserve all other containment flags and no published ports. Save the audited `network` object in a private file `SEPT_NETWORK_CONFIGURATION`, add it to this fresh hands profile, and set `shell:true` if demonstrating Bash/custom. Include all actual reachable brain addresses and overlapping protected service ports; the example addresses above are illustrative and must be replaced. Before first policy activation, retain actual inspection and generate **both** tables via the installed public helpers:

```sh
sept_docker inspect "$SEPT_HANDS_ID" > "$SEPT_EVIDENCE/network-container.json"
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import { loadHandsConfiguration, networkFirewall } from "sept-agent/hands";
const profile = JSON.parse(readFileSync(process.env.SEPT_HANDS_CONFIGURATION, "utf8"));
profile.network = JSON.parse(readFileSync(process.env.SEPT_NETWORK_CONFIGURATION, "utf8"));
profile.shell = true;
writeFileSync(process.env.SEPT_HANDS_CONFIGURATION, JSON.stringify(profile), { mode: 0o600 });
const configuration = loadHandsConfiguration(process.env.SEPT_HANDS_CONFIGURATION);
const inspected = JSON.parse(readFileSync(`${process.env.SEPT_EVIDENCE}/network-container.json`, "utf8"))[0];
for (const family of ["ipv4", "ipv6"]) {
  writeFileSync(`${process.env.SEPT_EVIDENCE}/${family}.rules`, networkFirewall(configuration, inspected, family));
}
JS
sept_docker exec --privileged --user 0:0 -i "$SEPT_HANDS_ID" \
  /usr/sbin/iptables-restore < "$SEPT_EVIDENCE/ipv4.rules"
sept_docker exec --privileged --user 0:0 -i "$SEPT_HANDS_ID" \
  /usr/sbin/ip6tables-restore < "$SEPT_EVIDENCE/ipv6.rules"
sept_docker exec --privileged --user 0:0 "$SEPT_HANDS_ID" \
  /usr/sbin/iptables-save > "$SEPT_EVIDENCE/ipv4-installed.rules"
sept_docker exec --privileged --user 0:0 "$SEPT_HANDS_ID" \
  /usr/sbin/ip6tables-save > "$SEPT_EVIDENCE/ipv6-installed.rules"
```

Only these operator filter-install/inspection execs are privileged. Actual hands processes retain dropped capabilities and the guarded command identity. Verify topology/DNS/brain endpoint inventory and both installed exact families; the live backend independently refuses absent/altered protection. At revision 0, explicitly set the separate network policy with workspace read/write true, execute true and network true (selected grants only for declared readable roots), then assert `freshBackendRequired:false` and unchanged running generation as in the minimal recipe. An existing policy instead requires quiescence/current CAS/fresh generation. A configured network/table alone is never a grant. Prove one controlled permitted peer and one protected refusal through an actual installed native call with `network:true`; pure table generation is not an effect proof. Retain the IPv6 reachability qualification below and independently finalize that exact generation.

## Portability qualification

Support requires the exact source/image/host qualification. The prior [repository-only as-built verdict at d361123](https://github.com/DB-Conneely/sept/blob/d361123d7c242db5af3ae2d1cb4daea4a2acdeff/docs/as-built/capability-confinement.md) confirms executable source3bf4f560 and its exact images; it is **not package QA**. New package/image consumers require their own installed proof.

- Native Linux qualification is abyss Ubuntu26.04.1/x86_64, kernel7.0.0-38, Docker29.1.3/cgroup v2, Node22.22.1 with controlled loopback responses through real Pi. Native Mac ARM qualifies only its scoped Docker Linux installed/search/dependency path. Full Darwin, Intel Mac, Windows/WSL and arbitrary combinations remain unqualified; native Windows worker operation is unsupported because Unix control/POSIX leases remain.
- External publicIPv6 has matching confined/unconfined `ENETUNREACH`; UFW INPUT-DROP remains. Real-provider outages and expiring OAuth/subscription refresh remain unexercised. A successful live task does not qualify those cases. The original first physical pre-effect Engine stream-loss trigger remains unknown.
- Public proc metadata/resident cmdline correlation remains visible. Active epoch/70-byte MIME `EACCES` is privacy evidence; a4100-byte transient `ENOENT` establishes disappearance. Stronger-actor process_vm/ptrace observations retain that qualification. Mount-refusal injections used inspect metadata, not physical hot mounts.
- Reverse overflow/cancel evidence establishes typed hard Engine stream-budget loss before native cancel, zero normal partial results, joins and fresh-authority recovery. It does not establish a returned command-exit overflow or unique `collecting.catch` cause; separate owner counterfactual/both-order/limit-first proof establishes that repair.
- Earlier security/checker/genuinely sealed-host evidence applies only to unchanged exact owners and compared compiled bytes, not a new whole-image certification. Host npm Pi remains stock; compatible image overlay/provenance/helpers/profile are required. There is no blanket Docker portability or extension-sandbox claim.

[SDK embedding](sdk.md), [HTTP/SSE](worker-api.md) and [the canonical index](index.md) describe the current package surface. Publication and deployment remain outside these setup instructions.
