# Capability confinement — current authoritative contract

The approved [confinement plan](</Users/sk3_neels/Documents/ChatGPT/Sept 3/SEPT-capability-confinement-plan.md>) supersedes the historical proposal retained below. Delivery status and exact evidence live in [the phase record](as-built/capability-confinement.md); current installed contracts live in [the Pi contract](pi-contract.md#supplied-hands-reference-profile). A specification is not a completion claim.

Brain retains native Pi Harness/Models, credentials and SEPT domain/control authority. A consumer supplies separately enforced hands and owns provisioning and orchestration. Ship one proved Linux reference profile and a small supplied-backend contract; other native/OS profiles remain unsupported until proved. No Pod grant editor, host-wide registry or universal backend-equivalence promise is required.

Default authority is private workspace read/write, shell absent and general hands network denied. Read and write grants remain independent; edit needs both. Operator-owned `full_access`, `scoped` and `request_approval` may change over time. Full access is bounded by the supplied hands domain and never reaches brain credentials, state, environment or control endpoints. Unsupported enforcement fails closed while authenticated health/history stays available.

Effects and resource reads use the same backend boundary on initial dispatch, native replay, successor and recovery. Live narrowing persists denial before incompatible effects are joined; expansion or environment replacement requires validated quiescence and fresh namespace identity. Interrupted mutations stay honestly uncertain. Native scheduling, replay, model access and application trust guarantees remain intact.

Permission requests do not grant authority. Durable operator decisions are followed by explicit retry through existing accepted-message/wake paths; original denied calls remain denied. Custom hands run outside brain without native Models/task/policy/control APIs. Trusted operator-installed native brain extensions remain application code. Mandatory supervision, agent loops, schedulers and extra durability infrastructure are outside this phase.

## Historical proposal — superseded

# Node Wrap Part 1.5: Capability, Filesystem, and Execution Boundary Specification

## Status and dependency

This document specifies the second of three sequential deliverables that complete the generalized SEPT Node foundation. It is an implementation specification, not approval to begin implementation by itself.

Part 1.5 begins only after `docs/node-wrap-part-1-integration-execution-spec.md` is implemented and verified. It applies one coherent capability boundary to Pi filesystem tools, shell execution, integration adapters, and MCP connector processes. Part 2 then relies on this boundary when supervisors and peer agents are introduced.

The existing lifecycle, conversation, model-access, rollover, and Part 1 integration guarantees remain mandatory.

## Product outcome

After this part, the operator can choose exactly one filesystem exposure mode for the agent in a Pod:

1. **Agent workspace only** — the default.
2. **Selected locations** — explicit local grants, each read-only or read/write.
3. **All user files** — an explicit advanced mode.

Regardless of mode, the agent cannot read or mutate SEPT's runtime, configuration, credentials, connector authorization, durable control state, or control-plane identity. File, shell, connector, and network capabilities are enforced structurally rather than by prompt instruction.

The same policy is representable in the future frontend and enforceable by either a container execution backend or a process-native backend. Backend choice does not change the meaning of a grant.

## Why this part is mandatory

SEPT currently canonicalizes a run's starting workspace and ensures it is beneath the configured workspace root. That is admission validation, not complete tool confinement.

Pi's standard read, write, and edit tools accept absolute paths. Pi's Bash tool can access any file and network capability available to its process. A read-only container image still has writable state, workspace, and Pi credential mounts. If all of those mounts are visible to the same shell identity, a model-issued command may inspect or corrupt state outside the assigned work surface.

Part 1.5 therefore closes an actual distribution boundary:

- selecting a working directory is not the same as confining every tool call;
- wrapping only `read` and `write` is insufficient while Bash remains unrestricted;
- a Pod-level connector allowlist is not a network security boundary while shell commands can make arbitrary outbound requests; and
- keeping state in a different directory is not isolation if the agent process can still address it.

## Mandatory invariants

1. **Control authority is outside the agent work plane.** The agent cannot modify its profile, grants, trigger bindings, connector definitions, supervision topology, limits, or runtime policy.
2. **Secrets are never files available to Pi tools.** Provider credentials, connector credentials, OAuth material, bearer tokens, and device identity stay outside the agent-visible mount and operation set.
3. **Durable run truth is not agent-writable.** Conversation, queue, receipt, checkpoint, rollover, handover, lease, and lifecycle state remain SEPT-owned.
4. **Every file-capable route obeys one policy.** Read, write, edit, list, find, grep, shell, integration adapter, and stdio connector behavior cannot diverge.
5. **Default is least authority.** New Pods receive workspace-only read/write access, no shell, connector-only external actions, and no selected shared location.
6. **Read and write are independent grants.** Read permission never implies mutation permission.
7. **Absolute paths do not bypass policy.** Relative, absolute, symlinked, aliased, Unicode-normalized, and non-existent-target paths resolve against the same capability map.
8. **Connector installation is executable-code installation.** Connector packages execute from an immutable runtime location and receive only their declared mounts, network access, and connector-specific identity.
9. **Permission expansion is controlled; restriction is immediate.** A new capability appears only at a safe boundary. Revocation prevents new use immediately and terminates incompatible in-flight execution.
10. **One Pod cannot inherit another Pod's workspace or grants.** Sharing is an explicit operator decision.
11. **Backend equivalence is tested.** A process-native backend is not a weaker “best effort” version of the container policy.
12. **Wired installed behavior is the completion metric.** A policy object without enforcement at the exact Pi and shell paths is a cardinal failure.

## Security planes and filesystem layout

The runtime has four distinct planes:

```text
Host/control plane
  Pod definitions, topology, local path-grant registry

Security plane
  model credentials, connector credentials, OAuth state, Pod/control identity

Execution truth
  manifests, queues, receipts, events, conversations, sessions, handovers, leases

Agent work plane
  private workspace, approved mounted locations, scratch, exportable artifacts
```

Only the agent work plane is available to Pi file and shell tools.

Recommended stable Pod-visible paths for the packaged backend are:

```text
/workspace                    private agent workspace
/workspace/artifacts          conventional exportable output location
/mounts/<grant-id>            selected local locations
/tmp                          bounded ephemeral scratch
```

The following are permanently excluded from the agent work plane, even in all-user-files mode:

- SEPT executable and installed packages;
- Pod and host configuration;
- connector catalog, installed integration packages, and policy state;
- provider and connector credential stores;
- event/run state and Pi session files;
- control-plane state and device keys; and
- container-engine or host-service control sockets.

The Pod may execute immutable runtime and connector files without exposing them through Pi's file tools.

## Filesystem policy contract

The durable operator-owned policy contains no secrets and is not writable by the agent:

```json
{
  "formatVersion": 1,
  "mode": "workspace_only|selected|all_user_files",
  "workspace": {
    "grantId": "pod-workspace",
    "access": "read_write"
  },
  "selectedGrants": [],
  "fileTools": "read_only|read_write",
  "shell": "disabled|sandboxed",
  "network": "connectors_only|unrestricted"
}
```

`fileTools` is the maximum mutation surface Pi receives. A read-only selected grant remains read-only even when `fileTools` is `read_write`.

`network` is explicit because unrestricted shell networking would otherwise bypass the Part 1 connector policy. General research, Google/search, browser, social-media, and other external capabilities remain available under `connectors_only` when provided by an authorized connector.

### Mode 1: workspace only

This is the mandatory default.

- The agent receives one private workspace.
- The workspace is read/write unless the operator deliberately makes the entire Pod read-only.
- No user directory outside that workspace is mounted or addressable.
- No other Pod receives the workspace automatically.
- Artifacts intended for the frontend are written under the workspace's conventional artifacts directory or explicitly published through a bounded artifact service.

This mode is suitable for monitoring, support, research, communication, analysis, and content agents that do not require an existing user directory.

### Mode 2: selected locations

The Pod receives its private workspace plus explicit local grants. Each grant has:

- a stable opaque `grantId`;
- a user-facing label;
- `read_only` or `read_write` access;
- a local host target held only by the host grant store;
- a stable Pod-visible alias under `/mounts/<grant-id>`; and
- creation, update, and revocation times.

The future desktop UI selects locations through the native OS file/folder picker. The cloud and ordinary Pod metadata receive the grant ID, label, access mode, and Pod alias—not the sensitive absolute host path or an OS security-scoped bookmark.

Selected locations are the normal mechanism for repositories, document trees, media libraries, and deliberate shared work areas.

### Mode 3: all user files

This is an explicit advanced/high-trust setting.

- It exposes the user-content surface made available by the local host backend.
- It does not expose the permanent SEPT exclusions above.
- It requires a deliberate confirmation with a clear statement that the agent may read or modify broadly according to `fileTools`.
- It is never inferred from a broad workspace path, supervisor relationship, or connector grant.

“All” means all user work content available to SEPT, not the right to rewrite SEPT's own security or execution state.

## Host path-grant store

The host owns the mapping from an opaque grant ID to a real local directory or OS security-scoped resource. Pods and cloud-facing records refer only to grant IDs.

Grant creation must:

1. be initiated by the local human/operator;
2. canonicalize and verify the selected target;
3. reject overlap with every permanent SEPT exclusion;
4. record the intended read/write mode;
5. assign a stable non-path-derived grant ID;
6. test that the selected execution backend can enforce the requested access; and
7. persist the mapping in a local access-restricted store.

The agent cannot enumerate arbitrary host locations through this service. The frontend uses an OS picker rather than a backend “list my filesystem” endpoint.

Deleting or narrowing a host grant revokes it from every referencing Pod. Expanding a grant requires a new explicit local action.

## Tool-surface construction

Part 1.5 must use Pi's existing tool-definition and pluggable-operation seams rather than rebuilding the agent loop.

### File tools

SEPT constructs the permitted Pi tools explicitly:

- `read`, `grep`, `find`, and `ls` are present only when read access is enabled;
- `write` and `edit` are present only when mutation access is enabled;
- each tool resolves through the same immutable effective grant map; and
- disallowed tools are absent rather than merely discouraged in the prompt.

The filesystem operations layer must:

- normalize and bound input paths;
- map Pod-visible aliases to approved host capabilities;
- verify the final target is inside an approved root;
- distinguish read-only and read/write roots;
- resolve existing symlinks and reject escapes;
- validate the nearest existing parent for new targets;
- prevent symlink-swap/time-of-check-to-time-of-use bypasses through backend isolation or descriptor-relative/no-follow operations;
- reject device files, control sockets, and other unsafe special targets unless a future explicit capability defines them; and
- propagate Pi cancellation without releasing a mutation lock before an in-flight write settles.

### Shell

Shell is a separate explicit capability because path wrappers cannot constrain arbitrary commands.

- `disabled` means Pi receives no Bash/PowerShell tool.
- `sandboxed` means Pi's shell tool delegates to the selected execution backend with exactly the effective mounts, working directory, environment allowlist, resource limits, cancellation signal, and network mode.
- Shell never inherits provider credentials, connector credentials, control-plane tokens, host service sockets, or the unrestricted parent environment.
- Shell output and duration remain bounded under the existing SEPT invocation/cancellation lifecycle.
- Command parsing or a denylist of programs is not accepted as the primary sandbox.

If a process-native backend cannot structurally enforce the selected mount and network policy for shell execution, it must refuse to enable shell rather than advertise partial confinement.

### Connectors and integration adapters

MCP connector and trigger-adapter processes execute from immutable installed packages. They receive:

- only their connector-specific credential values or references;
- only declared and operator-approved filesystem grants;
- only the transport/network access required for that integration;
- a bounded temporary directory; and
- no provider-model credential or SEPT control token unless the protocol explicitly requires a separate scoped token.

A remote MCP connector receives no local filesystem mount. A stdio connector receives none by default and must declare a filesystem capability before the control plane can offer a grant.

One connector's credential environment cannot be observed by another connector, the Pi shell, or the model-facing process environment.

## Network policy

Filesystem isolation and connector authorization are undermined if an unrestricted shell can call arbitrary network endpoints.

### Connectors only — default

- Pi model requests continue through the SEPT/Pi runtime.
- Authorized remote MCP clients and approved integration adapters receive only their required egress.
- Agent shell execution has no general network access.
- Web research/search is supplied through an explicitly surfaced trusted connector.
- A connector's endpoint does not become a general proxy for unrelated agent requests.

### Unrestricted — advanced

- Sandboxed shell may access external networks according to the host/backend policy.
- The frontend must state that raw network use can bypass connector-level audit and purpose limitation.
- Unrestricted network never exposes SEPT or connector credentials to the shell environment.
- This mode is explicit and never implied by all-user-files access.

The backend may implement connectors-only with separate process/network namespaces, an authenticated host broker, or an equivalent structural boundary. Prompt instructions, environment-variable conventions, and command denylisting are insufficient.

## Execution backend contract

Part 1.5 introduces one backend-neutral enforcement interface used by Pi tools, shell, adapters, and stdio connectors. Its responsibilities are:

- validate whether a declared policy is enforceable on this host;
- materialize the effective mount/grant map;
- create scoped filesystem operations for Pi tools;
- execute a bounded shell command when enabled;
- launch a scoped connector or trigger-adapter process;
- provide connector-specific environment and network policy;
- cancel active operations;
- report bounded capability/health metadata; and
- dispose all mounts, child processes, handles, and temporary state.

The interface must not expose raw unrestricted process spawning to the agent runtime.

### Container backend

The container backend enforces policy with:

- a read-only runtime image;
- a non-root identity;
- separate state, credential, and workspace volumes;
- only selected bind mounts, with read-only flags where required;
- no host control socket;
- bounded temporary storage;
- explicit process/resource limits; and
- the configured network boundary.

SEPT-owned writable state and credentials may be mounted into the runtime service, but they must not be mounted into the isolated shell/connector execution context presented to agent tools.

### Process-native backend

A process-native backend means SEPT runs as a normal local service rather than inside the Pod container.

It must provide the same logical boundary by combining:

- scoped Pi filesystem operations;
- an OS-enforced sandbox or subordinate sandbox runner for shell and executable connectors;
- a minimal environment allowlist;
- process-group cancellation and child cleanup;
- connector-specific credential delivery;
- resource limits; and
- local access-controlled state directories.

If the host OS cannot enforce an equivalent shell or connector boundary, the native backend may support file tools with shell disabled. It may not silently fall back to unrestricted child processes.

The control plane reports backend capabilities so unavailable options are disabled in the UI before save.

## Policy lifecycle and active-run semantics

Capability policy follows an explicit lifecycle:

```text
draft → validated → active → superseded
                         ↘ revoked
```

- Draft policy may be edited without affecting the Pod.
- Validation resolves host grants and proves backend support without exposing paths or secrets to the agent.
- Activation is atomic and records a monotonically increasing policy revision.
- A run manifest records the effective revision, grant IDs, access modes, tool set, shell mode, network mode, and backend identity used at admission.
- Expansions become available only before a new run or at a controlled Pi/session reconstruction boundary.
- Narrowing or revocation installs an immediate deny overlay, aborts affected in-flight file/shell/connector work, and reconstructs the sandbox before continuation.
- A removed grant is not kept alive merely because an older run snapshot referenced it.
- Restart reconciles the active policy, deny overlay, effective mounts, interrupted cancellation, and run snapshot before Pi resumes.

Changing the workspace or filesystem mode while a run is active or waiting is refused unless the operation explicitly cancels that run first. Narrowing one selected grant may use the immediate revocation path.

## Multi-Pod and shared-location behavior

- Each Pod receives a distinct private workspace by default.
- Supervisor assignment does not grant filesystem access to subordinates.
- Peer communication does not grant filesystem access.
- A user may deliberately assign the same selected location to several Pods.
- Shared read-only access is safe by default.
- Shared read/write access requires an explicit warning that filesystem-level conflicts are possible; SEPT does not invent distributed file locking or merge semantics in this part.
- Each Pod's durable records contain only the opaque grant ID and Pod alias, not another Pod's host path mapping.

Part 2 coordination should use durable messages and structured results rather than silently relying on shared mutable directories.

## Migration and recovery

- New Pods receive the workspace-only, read/write-files, shell-disabled, connectors-only default.
- An existing state root without a capability policy is not silently treated as unrestricted. Before new or resumed agent tool execution, the local operator must accept the safe default or activate an explicit validated policy.
- Existing durable runs, conversations, handovers, queues, and terminal records remain readable while policy configuration is required.
- A migration may offer a clearly labelled legacy-compatibility draft based on the prior configured workspace, but it cannot activate broad files, shell, or unrestricted network without explicit local confirmation.
- Policy migration never moves, rewrites, or exposes provider credentials, connector credentials, Pi sessions, or run truth.
- Startup reconstructs and validates the effective backend boundary before adopting an active or waiting run. If it cannot reproduce the recorded capability revision safely, the run remains dormant and the Node reports a bounded configuration-required state rather than resuming with broader access.

## Control-plane-ready service surface

Part 1.5 supplies UI-neutral service methods and credential/path-blind projections for:

- report execution-backend capabilities;
- get the current effective capability policy and revision;
- create, validate, activate, and supersede a draft policy;
- list sanitized host grants by ID, label, access, availability, and referencing Pod count;
- create a grant from a trusted local OS-picker result;
- narrow or revoke a grant;
- test a policy using bounded synthetic read/write/shell/network probes;
- report the effective Pi tool names without exposing paths; and
- report policy application or revocation state for an active run.

Sensitive host paths, OS bookmark data, secrets, shell commands, and probe content do not appear in ordinary HTTP projections, logs, telemetry, or cloud metadata.

The future frontend must be able to render:

- the three filesystem modes;
- selected locations and read/write badges;
- shell disabled/sandboxed;
- network connectors-only/unrestricted;
- permanent SEPT exclusions;
- backend capability limitations;
- active versus pending policy revision; and
- the consequences of expanding or revoking access.

## Required implementation sequence

The implementation agent must work in this order:

1. Add strict capability-policy, host-grant, effective-mount, backend-capability, and revision types/codecs.
2. Add versioned atomic Pod policy storage and the host grant-store interface without changing existing run truth.
3. Introduce the execution-backend interface and adapt Part 1 connector/adapter spawning to it.
4. Construct Pi file tools explicitly with scoped pluggable operations; stop relying on unrestricted default tools.
5. Enforce read-only/read-write roots, non-existent targets, absolute paths, symlinks, special files, cancellation, and mutation ordering.
6. Implement shell disabled/sandboxed behavior through the backend rather than command parsing.
7. Enforce connectors-only/unrestricted network semantics for shell, connectors, and trigger adapters.
8. Separate runtime, security, execution-truth, workspace, mount, artifact, and temporary storage in the container backend.
9. Implement or formally capability-gate the process-native backend so it never advertises enforcement it cannot supply.
10. Implement policy draft/validation/activation, revision snapshots, safe expansion, immediate narrowing, revocation, and restart reconciliation.
11. Add the control-plane-ready service surface and documentation.
12. Exercise the installed runtime, production Pi tools, real shell boundary, real connector process, restart paths, and no-cache container acceptance.

## Required verification

### Filesystem and tool enforcement

- A default new Pod exposes only its private workspace, with shell disabled.
- Relative and absolute reads inside an allowed root succeed through the production Pi session.
- Reads and writes outside every allowed root fail before filesystem access.
- Read-only grants allow read/list/find/grep and reject write/edit/shell mutation.
- Non-existent write targets are accepted only beneath an approved read/write parent.
- `..`, symlink escape, symlink swap, Unicode/path normalization, mount alias, special-file, and deleted/recreated-root cases fail safely.
- SEPT runtime, configuration, credential, connector, state, Pi session, and control-plane paths remain unavailable under all three modes.
- Disallowed Pi tools are absent from the session tool surface.
- File cancellation does not release mutation ordering before the underlying operation settles.

### Shell and network enforcement

- Shell-disabled Pods receive no shell tool.
- Sandboxed shell sees exactly the effective mounts and a bounded temporary directory.
- Sandboxed shell cannot read provider/connector credentials, SEPT state, host control sockets, or the parent environment.
- Connectors-only shell cannot make arbitrary network requests while Pi model access and explicitly authorized connectors still function.
- Unrestricted network requires explicit policy and is accurately reported.
- Timeout, cancellation, process-group termination, output limits, and orphan cleanup are verified through the installed path.

### Connector and adapter isolation

- A stdio MCP server receives only its own declared credential names/values and approved mounts.
- Another connector, Pi shell, and Pi prompt cannot observe those credentials.
- A remote MCP connector receives no local mounts.
- An integration adapter cannot read the Pod workspace unless it declares and receives a separate grant.
- Connector/adapter revocation terminates affected execution and restart does not revive stale authority.
- Immutable connector packages cannot be modified by agent file or shell tools.

### Policy lifecycle and persistence

- Malformed and unknown-version policy/grant files fail closed without reset.
- Draft, validation, activation, supersession, and revocation preserve monotonic revisions.
- Expansions wait for a safe boundary; reductions deny immediately and abort affected work.
- Active run manifests preserve their admission snapshot while the live deny overlay enforces revocation.
- Restart reconstructs the same effective policy before resuming Pi.
- Selected host paths remain local to the grant store and are absent from cloud-safe/API projections.

### Full regression and installed paths

- Existing drain, cancellation, conversation, wait/wake, rollover, model-access, event, connector, and shutdown tests remain green.
- `npm run check`, the complete test suite, full and production audits, and `git diff --check` pass.
- A high-confidence scan finds no credential, host-path, webhook-content, or control-token leakage in changed source, fixtures, outputs, logs, telemetry, state projections, or container metadata.
- A no-cache image builds and exercises all three filesystem modes, read-only/read-write selected mounts, no-shell and sandboxed-shell operation, connectors-only networking, a real MCP connector through Pi, policy revocation, and restart recovery through the installed entry point.
- If a process-native backend is shipped, the same applicable acceptance matrix passes through that installed backend. Unsupported capabilities are refused before run admission.

## Explicit non-goals

- No dashboard implementation.
- No cross-device access or remote filesystem mounts.
- No supervisor or peer messaging.
- No implicit shared workspace created by hierarchy.
- No agent-controlled permission editor.
- No unrestricted shell as a default.
- No command/program denylist presented as a sandbox.
- No plaintext credentials in Pod config, mounts, or agent environment.
- No distributed file locking, collaborative merge engine, or network filesystem.
- No promise that every OS can support every native-backend capability.

## Completion gate

Part 1.5 is complete only when the exact installed Pi file tools, shell path, trigger adapters, and stdio connector processes are structurally constrained by the same active policy; the three user-facing filesystem modes behave exactly as documented; SEPT-owned runtime, security, and execution state remain inaccessible; capability reduction survives races and restart; and the built container plus any shipped process-native backend pass the acceptance matrix.

A prompt that tells the agent to stay in its workspace, a canonical starting directory, or isolated unit tests without the installed Pi/tool path do not satisfy this gate.
