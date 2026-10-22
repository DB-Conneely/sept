# Inline incident investigator

A small existing-service integration over `sept-agent/client`, using only bounded redacted inline evidence. It submits E1 and a cutoff/unknowns, observes authoritative WAIT, sends exact later E2 with a stable identity, then requires a same-run/session report citing both IDs. It collects no data and performs no remediation.

Use Node **22.23.3**, npm **11.21.0** and the exact SEPT tarball. Copy this directory outside the repository and ancestor module lookup, set `SEPT_TARBALL` to its absolute tarball path, then install:

```sh
cd "$SEPT_INCIDENT_APP"
npm install --omit=dev --save-exact "$SEPT_TARBALL"
npm ls --omit=dev --json > production-dependencies.json
```

Follow the [fresh-instance setup](../../README.md#install-and-prepare) with `--root "$SEPT_INCIDENT_APP/instance" --access none`, choosing the actual local Engine socket and locally available image. Use an instance separate from the native file example. Valid hands is mandatory even for inline text. The helper activates zero workspace/selected/execute/network rights before worker initialization; do not grant file/shell/network rights to make this app pass.

Set `SEPT_STATE_DIR`, `PI_CODING_AGENT_DIR`, `SEPT_WORKSPACE_ROOT` and `SEPT_HANDS_CONFIGURATION` from setup's `stateRoot`, `agentDir`, `workspaceRoot` and `handsConfigurationPath` fields. Configure a suitable provider/model through [model authentication](../../README.md#model-authentication). Start the installed complete worker with explicit paths and a privately supplied token (or use the [Node host](../node-app/worker.mjs) with these incident roots). The app's five explicit inputs are the authenticated worker origin, token, workspace, provider and model; a stable event ID identifies the logical investigation.

```sh
sept worker --state-dir "$SEPT_STATE_DIR" --agent-dir "$PI_CODING_AGENT_DIR" \
  --workspace-root "$SEPT_WORKSPACE_ROOT" --hands "$SEPT_HANDS_CONFIGURATION" \
  --host 127.0.0.1 --port 8090
```

In a separate terminal:

```sh
export SEPT_BASE_URL=http://127.0.0.1:8090
export SEPT_PROVIDER=your-configured-provider
export SEPT_MODEL=your-configured-model
export SEPT_EVENT_ID=incident-001
node investigate.mjs wait
```

The `wait` command prints authoritative WAIT and exits, deliberately retaining the coherent waiting run. Stop/join the worker. Export any needed workspace, then stop and verify its exact owned generation using the supplied-hands guards. Create a **fresh minimal** generation and a dedicated initially-empty resources root/profile; preserve the same private state/agent/workspace roots and model selection. Use installed `permissions show` to obtain the current revision and `permissions set --revision CURRENT` with the same zero-rights policy and fresh profile; confirm `freshBackendRequired:false` and the fresh running generation. Start the worker again with that profile and the same persistent roots. The earlier generation must remain stopped/PID0; never reuse it.

The fresh-instance helper does not orchestrate this durable restart/rebind. The advanced operator-managed snippet below requires separately supplied `sept_docker`/`sept_socket_matches` guards pinned to the original local socket identity and daemon, `SEPT_ENGINE_ID`, immutable `SEPT_IMAGE`, private `SEPT_OPERATOR_ROOT`, `SEPT_EVIDENCE/socket.json`, and `SEPT_OPERATOR_ROOT/minimal-policy.json` containing the same zero-rights policy. These guards, receipts and exact-generation finalizers are prerequisites, not outputs of the helper. With those existing operator inputs, the fresh generation and current-revision activation are:

```sh
set -eu
export SEPT_PREVIOUS_EVIDENCE="$SEPT_EVIDENCE"
SEPT_EVIDENCE="$(mktemp -d "$SEPT_OPERATOR_ROOT/evidence.XXXXXXXX")" || exit 1
export SEPT_EVIDENCE
cp "$SEPT_PREVIOUS_EVIDENCE/socket.json" "$SEPT_EVIDENCE/socket.json"
sept_socket_matches || exit 1
test "$(sept_docker info --format '{{.ID}}')" = "$SEPT_ENGINE_ID" || exit 1
SEPT_FRESH_RESOURCES="$(mktemp -d "$SEPT_OPERATOR_ROOT/resources.XXXXXXXX")" || exit 1
export SEPT_FRESH_RESOURCES
chmod 0755 "$SEPT_FRESH_RESOURCES"
SEPT_HANDS_ID="$(sept_docker run --detach --init --no-healthcheck \
  --entrypoint '' --user 10002:10002 --read-only --cap-drop ALL \
  --security-opt no-new-privileges --ipc private --network none \
  --pids-limit 128 --memory 1g --cpus 2 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16777216,mode=1777 \
  --tmpfs /workspace:rw,nosuid,nodev,noexec,size=134217728,nr_inodes=32768,mode=2770,uid=10002,gid=10002 \
  --mount "type=bind,src=$SEPT_FRESH_RESOURCES,dst=/resources,readonly" \
  "$SEPT_IMAGE" sleep infinity)" || exit 1
export SEPT_HANDS_ID
SEPT_HANDS_GENERATION="$(sept_docker inspect --format '{{.State.StartedAt}}' "$SEPT_HANDS_ID")" || exit 1
export SEPT_HANDS_GENERATION
export SEPT_HANDS_CONFIGURATION="$SEPT_OPERATOR_ROOT/hands-reopened.json"
sept_docker inspect "$SEPT_HANDS_ID" > "$SEPT_EVIDENCE/reopened-opening.json"
node --input-type=module <<'JS'
import { writeFileSync } from "node:fs";
writeFileSync(process.env.SEPT_HANDS_CONFIGURATION, JSON.stringify({
  profile: "docker-linux-warm-v1", engineSocket: process.env.SEPT_ENGINE_SOCKET,
  containerId: process.env.SEPT_HANDS_ID, generation: process.env.SEPT_HANDS_GENERATION,
  workspace: process.env.SEPT_WORKSPACE_ROOT, dataDomain: "private",
  workspaceLimits: { bytes: 134217728, inodes: 32768 },
  resources: process.env.SEPT_FRESH_RESOURCES, shell: false, readOnlyMounts: [], imageSelected: [],
}), { mode: 0o600 });
JS
sept permissions show --state-dir "$SEPT_STATE_DIR" --agent-dir "$PI_CODING_AGENT_DIR" \
  > "$SEPT_EVIDENCE/policy-before-reopen.json"
SEPT_REVISION="$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.env.SEPT_EVIDENCE+"/policy-before-reopen.json","utf8")).revision)')" || exit 1
export SEPT_REVISION
sept permissions set --revision "$SEPT_REVISION" --policy "$SEPT_OPERATOR_ROOT/minimal-policy.json" \
  --hands "$SEPT_HANDS_CONFIGURATION" --state-dir "$SEPT_STATE_DIR" \
  --agent-dir "$PI_CODING_AGENT_DIR" > "$SEPT_EVIDENCE/policy-reopened.json"
sept_docker inspect "$SEPT_HANDS_ID" > "$SEPT_EVIDENCE/reopened-after-policy.json"
node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = name => JSON.parse(readFileSync(`${process.env.SEPT_EVIDENCE}/${name}`, "utf8"));
assert.equal(read("policy-reopened.json").freshBackendRequired, false);
const before = read("reopened-opening.json")[0];
const after = read("reopened-after-policy.json")[0];
assert.equal(after.Id, before.Id);
assert.equal(after.State.StartedAt, before.State.StartedAt);
assert.equal(after.State.Running, true);
JS
```

The workspace is intentionally empty and needs no seed in this evidence-only app. Reuse the CLI worker command above with the new hands profile; state, agent, workspace and model stay the same. The fresh evidence directory preserves the earlier generation's export/stop receipts when the canonical finalizers run again. Retain both directories and each generation's independent finalization receipts.

Set `SEPT_BASE_URL` to the reopened listener. Keep the exact same `SEPT_EVENT_ID`, provider/model/workspace and token, then run:

```sh
node investigate.mjs report
```

`report` replays the original stable task admission, checks authoritative waiting state, and sends E2. This explicit stop/fresh-generation/CAS/reopen boundary is required by the existing hands reconciliation contract. Sending E2 immediately to the old generation fails closed; the app does not provision a replacement or work around authority.

The source fixes the bounded evidence bodies, cutoff and unknowns. It polls at most 240 times with 250ms waits per phase, plus one resume-state check in the report command, uses 10-second request deadlines, and admits at most three native invocations/two epochs/120 active seconds. It submits E2 twice deliberately with the same source/event ID and identical whitespace/text, asserting one durable receipt plus its duplicate. There is no automatic transport retry. An ambiguous acceptance retains the same stable ID; the original admission receipt's `active` status is not current state.

Expected output is a `WAIT` record from `getTask`, followed by a `report` record with exact accepted E2 in the public conversation and a report citing E1/E2. Root cause/recovery remain unknown unless evidence supports them. The app asserts immutable task budgets and the same native session. Public task state is authority; prose saying WAIT alone is insufficient.

On failure or SIGINT/SIGTERM, `finally` independently attempts bounded cancellation of an unfinished admitted run. Cancellation can return while settlement continues; inspect authoritative state and reconcile an ambiguous request. The app does not own an external worker/provider/hands process. Their operator must independently stop/join each worker/provider/listener/attachment/lease and the exact owned generation using the setup's authority guards, verify stopped/PID0, and retain mutexes/stopped resources/recovery. A successful wait command retains WAIT; a successful report retains the terminal run. The external worker remains under its caller's lifecycle control.

Persistent WAIT/stop/reopen requires the existing SDK lifecycle: await stop, supply a fresh hands generation under current revision CAS, reopen the same persistent roots, and then send later evidence. Do not reuse a stopped generation or reset the task's budget/history. Provider outages/OAuth refresh, full Darwin/Intel/Windows and arbitrary Docker hosts remain unqualified.
