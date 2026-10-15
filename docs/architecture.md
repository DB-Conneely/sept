# SEPT module map

SEPT is organized by the mechanisms it owns. Each mechanism has one public `index.ts`; production callers outside that folder use that surface rather than implementation files. Focused tests may import an implementation directly when doing so avoids widening a runtime facade.

```text
src/
  cli.ts                         installed command dispatch and composition
  cli/
    auth-interaction.ts          terminal adapter for Pi AuthInteraction
  model-access/
    index.ts                     intentional public surface
    contracts.ts                 credential-blind provider/model/auth/selection DTOs
    input.ts                     hostile-object narrowing at configuration boundaries
    jsonc.ts                     bounded JSONC parsing for Pi models.json
    custom-configuration.ts      endpoint, credential, and rollover-metadata safety
    model-metadata.ts            identifiers, model limits, and built-in fallback pair
    pod-selection.ts             atomic credential-free Pod default persistence
    normalization.ts             credential-blind Pi metadata and error projection
    runtime-factory.ts           validated installed Pi ModelRuntime construction
    service.ts                   catalogue, authentication, selection, and preflight facade
  durable/
    index.ts                     durable state public surface
    contracts.ts                 run, task, handover, conversation, lifecycle contracts
    errors.ts                    classified durability and capacity failures
    limits.ts                    queue, record, conversation, and control bounds
    filesystem.ts                atomic files, fsync ordering, bounded JSONL scanning
    validation-primitives.ts     shared hostile-input narrowing primitives
    state-codecs.ts              manifest and lifecycle-snapshot codecs
    evidence-codecs.ts           event, message, conversation, and readiness codecs
    control-codecs.ts            assistant control and handover validation
    lease.ts                     stable process identity and exclusive durable leases
    run-evidence.ts              sequenced internal events and bounded lifecycle logs
    conversation-store.ts        bounded client conversation retention and recovery
    operator-queue.ts            exact input admission, proof, and compaction
    context-transfer-store.ts    checkpoint and handover durability ordering
    run-store.ts                 cohesive facade over one run's durable mechanisms
    run-discovery.ts             fail-closed restart discovery
    worker-lifecycle-store.ts    durable drain/readiness authority
  ingress/
    index.ts                     HTTP public surface
    errors.ts                    request errors and HTTP status mapping
    service.ts                   authenticated HTTP, model projection, replay, SSE
    validation.ts                task/workspace validation and model preflight composition
    webhook.ts                   normalized event validation, hashes, receipts
    webhook-router.ts            idempotent event-to-worker routing
  observability/
    index.ts                     injected facade and construction surface
    contract.ts                  business-facing observability contract
    configuration.ts             identity, resource, exporter selection
    logger.ts                    bounded redacted JSON stderr logging
    safe-fields.ts               field allowlist and value bounds
    exporters.ts                 contained exporter wrappers
    metrics.ts                   runtime instruments and bounded state
    setup.ts                     SDK/exporter selection and signal-owner construction
    telemetry.ts                 facade implementation and signal lifecycle
    tracing.ts                   spans, propagation, limits, provider
  pi-integration/
    index.ts                     Pi session-policy public surface
    diagnostics.ts               non-secret installed diagnostics
    prompts.ts                   control, continuation, handover prompts
    rollover.ts                  adaptive arithmetic and durable evidence
    durable-host.ts              native Harness/conversation lifetime and sanitized events
    durable-runtime.ts           authenticated Models, registry and SQLite FULL construction
    durable-invocation.ts        native submission/recovery and finalized-usage steering
    durable-admission.ts         bounded captured operator IDs for native admission
    durable-session-files.ts     strict native locators and unique successor discovery
    durable-resources.ts         operator prompts/skills and untrusted repository instructions
    durable-extensions.ts        bounded trusted native module loading
    durable-tools.ts             existing Pi tools registered as native durable tasks
    message-text.ts              text-only native response projection
  execution/
    index.ts                     supplied backend public boundary
    contracts.ts                 one bounded effect/resource port and profile identity
    profile.ts                   actual Linux isolation and mount provenance validation
    protocol.ts                  bounded hostile request/result codecs
    docker-backend.ts            exclusive namespace lease, live authority and joined cancellation
    docker-engine.ts             explicit local Unix-socket Engine HTTP/exec control
    warm-channel.ts              authenticated resident RPC and serial parent operations
    hands-entry.ts               retained installed Pi body dispatch inside hands
    hands-resident.ts            resident frames and operation-local effect acknowledgements
    hands-processes.ts           guarded attachments and exact namespace lifetime
    hands-process-owner.ts       fixed command UID and bounded descendant joins
    hands-native-child.ts        minimal native search child streams/events over that owner
    hands-selected-inputs.ts     opening image/sealed-host checks and exact image aliases
    hands-resources.ts           protected authorized resource epoch view
    native-env.ts                minimum native environment with typed unsupported operations
  runtime/
    index.ts                     runtime public surface
    controller.ts               durable cycling and Pi-native cancellation state machine
    worker.ts                   single resident slot, drain, controller ownership
```

The dependency direction is:

```text
cli -> ingress -> runtime -> pi-integration -> model-access
 |        |                         |               |
 +--------+-------------------------+---------------+-> durable
          +-------------------------+-----------------> observability contract
```

`model-access` is normalization and control around the installed Pi `ModelRuntime`, not another provider layer. Pi owns provider/model discovery, auth, credential storage/refresh, availability, compatible endpoint execution, and model requests. SEPT exposes only approved metadata, reads the atomic credential-free Pod default for every admission, and preflights the final pair before `RunStore.create()`. Direct and webhook tasks use the same admission function and service. Login remains UI-neutral in the service; only the installed CLI supplies an interaction adapter. Plain HTTP exposes authenticated read/selection routes but no secret mutation.

`durable` has no dependency on higher mechanisms. Existing format-2 manifests with fixed rollover options remain readable and normalize to format 3; all new manifests contain the resolved provider/model and no rollover knobs or credentials. The state-root `worker-state.json` remains authoritative for accepting/draining/drained readiness. Each run's bounded `conversation.jsonl` remains the sole client-facing event contract, separate from internal lifecycle events, logs, Pi sessions, rollover evidence, and checkpoint/handover controls.

`pi-integration` receives the selected Pi model from the manifest, verifies context/output metadata again, and opens the run's native Durable Harness with SQLite FULL and compaction disabled. Native conversation IDs are numeric; SEPT exposes their string form and bounded versioned locators. `rollover.json` remains scoped to provider, model, conversation identity and context window. Native finalized-response hooks supply usage; a stable steering submission is reused after restart or resumed with a distinct interrupted-handover recovery input. Handover JSON, Markdown, event and state commit before a fresh native conversation and provider UUID are created. Exact captured operator IDs accompany admission, so later queue arrivals cannot be marked in an earlier prompt.

Trusted agent-directory modules register native declarative extensions, including supported tools, sections, hooks, wrappers and tasks. Project trust remains false; repository instructions do not execute plugins. The existing Pi tools are adapted into native Durable tasks with explicit replay safety and cancellation. Both their complete existing bodies and the minimum native environment operations use the consumer-supplied `execution` backend. The backend enforces effects separately from brain; Pi remains the scheduler, replay and provider owner. New runs have one engine, with no coding-agent production host or historical transcript converter.

`runtime` retains execution, cancellation, wait/wake, shutdown, limits, restart adoption, and slot ownership without knowing HTTP. `ingress` translates the authenticated API and webhook contract onto runtime and model-access services. `observability` imports no business mechanisms and receives only bounded classifications/numbers; model identifiers, credentials, auth interactions, prompts, and provider errors are not telemetry fields.

The architecture suite enforces index-only cross-mechanism imports. `npm run build` cleans `dist`, so deleted or moved modules cannot survive as stale executable output. SEPT does not add ACP, a second agent loop, provider client, tokenizer, compactor, dashboard, cloud service, or model server.

`cli` composes the single consumer-supplied Docker Linux hands container into both installed callers. Brain retains credentials, Models/Harness and SEPT control state; hands gets namespace aliases, a clean environment and exact bounded read-only resource projections. Missing/unsupported enforcement refuses without a local fallback. The `docker-linux-warm-v1` profile uses the same finite private `/workspace` tmpfs with default file rights and explicitly granted commands. Consumers seed/export it and preserve bytes before stopping. Selected data/code may be baked read-only image trees, with genuinely `FS_IMMUTABLE`-sealed Linux host inputs retained as optional compatibility. Ordinary RO binds and private-domain RW host binds refuse. The file-only `mutable-file-bind` alternative omits command/discovery traversal and image aliases. Completed commands join namespace descendants; normal close retains the consumer-owned idle namespace. Cancellation/loss stops and verifies it before settlement, and unverified cleanup durably blocks instead of publishing cancellation. Projection refresh relies on private bounded ownership receipts; consumer markers grant no deletion authority. See [the profile contract](pi-contract.md#supplied-hands-reference-profile) and [consumer image recipe](../README.md#selected-image-data-and-code).

The bounded channel carries version/generation/configuration/session/sequence-correlated operation, effect check/ack and command frames. Authentication grants no rights: the live parent rechecks policy, roots, task identity, pins, expiry and cancellation at admission, immediately before effects/command start and at result acceptance. Opening qualifies immutable source/image/kernel facts; live checks retain bounded generation/mount/topology and anchored inode ownership without scanning the workspace on each call. Limits remain 512 KiB request, 4 MiB result and FIFO eight. Ordinary body errors preserve a healthy resident; broken framing/identity/cleanup seals admission and stops the exact generation before truthful settlement.

## Capability policy ownership

`durable/capability-policy.ts` owns the bounded private record, exact codec, fsync and revision CAS; it imports no lifecycle or execution behavior. `cli/permissions.ts` is the local operator writer and installed worker/direct composition. `execution/capability-admission.ts` maps validated rights onto the supplied namespace and effective registrations. `DockerExecutionBackend` owns live revision/generation checks, queued/active ownership, policy-change shutdown and run binding reconciliation. `docker-control.ts` owns kernel qualification, bound lifetime receipts and exact-generation stop verification through the explicit `DockerEngineControl` Unix-socket HTTP client; `profile-configuration.ts` decodes trusted configuration while `profile.ts` validates actual kernel containment. `hands-files.ts` supplies complete supported Pi file operation seams within hands, with retained directory descriptors, independent rights and bounded regular single-link inode access.

`hands-selected-inputs.ts` parses optional `imageSelected` exact `{ alias }` objects, normalizes absence to `[]` and runs opening selected-tree/image qualification from `docker-control.qualifyKernelProfile`. Image aliases use `[A-Za-z0-9_-]{1,64}`; existing host aliases retain `[A-Za-z0-9_-]+`, including longer aliases. All image/RO/RW aliases share the existing eight-unique-alias bound and policy grants. Image roots have no host source/stat/seed path. The C checker retains one descriptor-anchored bounded type/link/device/depth/count/path walk, requiring per-inode immutable flags only for the sealed-host mode. Exact image/read-only-rootfs and live image/generation/mount receipts protect baked roots; equal, ancestor and subtree mounts refuse. Configuration/data/code changes require fresh image where applicable, fresh generation and authority after quiescence. Literal `uid-dac-fixed-helper-v1` in the kernel receipt prevents old authority being silently reused; incompatible history remains intact.

Policy authority never enters HTTP task/webhook/model input. Nonempty old state without policy remains dormant; malformed present state fails closed. Native Harness still owns scheduling, safe/unsafe replay and task identity; the worker still owns its single slot, drain, exact queues and budgets. Live denial wins before any queued/replayed effect, while already accepted durable inputs remain recoverable. Supported uniform-read policy retains whole native search/resource bodies. Partial-read namespaces omit search/list and workspace resource discovery; they keep independent anchored file tools and trusted global sections. There is no alternate scheduler, policy editor, provisioner or new operation journal.

`hands-guard.c` is the fixed Linux constructor for trusted entry process protection. The build stage alone compiles its shared library; the runtime image contains the fixed library under its read-only root. `hands-guarded-command.ts` composes the cleared offline environment, fixed preload and disabled SIGUSR1 inspection; a fixed Node prelude verifies version-2 constructor acknowledgement before the resident starts. The resident UID10002 retains imports, private resource epoch and a correlated non-TTY RPC attachment. Commands run UID10003:GID10002 without the brain group; `/app` is UID10002:GID10001 mode 0750 and resident HOME/epoch/MIME captures are private 0700 with files 0600. Root-owned0555 command/rg/fd executables live in `/usr/local/libexec/sept`; private HOME contains matching supplied discovery aliases. The command entry establishes a separate session for the SIGCONT boundary. Fixed command/join helpers retain sole execution/descendant ownership. DAC/nondumpability/guards protect resident bytes, memory, signals, imports and control descriptors. Some public proc metadata and resident command-line correlation remain visible; correlation and command stdout cannot acknowledge or dispatch authority.

Pi still owns the full grep/find bodies. The image patch adds their optional native spawn callback, bound only during the current admitted operation. `hands-command-authority.ts` reconstructs exact native argv for the matching grep→rg/find→fd parent, requires current READ authority/uniform readability, rejects private roots and supplies network:false without a new helper timer. These children consume no Bash execute grant. Fixed `/tmp` capture-name exclusions remain. `hands-native-child.ts` adapts separate bounded stdout/stderr, kill/error/close and drain behavior to the existing command owner; it is not another scheduler or process owner. Per-stream UTF-8/order survives the transport; Bash alone combines chunks in arrival order. Custom results use only stdout (4096-byte bound), with stderr drained within the shared 4 MiB output budget. Helper loss/overflow/cancellation cannot yield partial normal success; close/settlement waits for exact joins and native limit/abort conventions remain Pi-owned.

Image delivery uses exactly four assets in `image/pi-native-search`: overlay, patch, provenance and README. Revision `sept-native-search-v1` overlays only `dist/core/tools/{find,grep}.{js,d.ts}` after unchanged locked `npm ci`; root manifests/graph and host Pi 1.1.0 remain stock. Docker verifies upstream/overlay and effective bytes before compile, after prune and after final COPY; opening qualification rechecks pinned private provenance and effective installed hashes. The pinned registry archive omits LICENSE; the existing README retains the exact upstream MIT notice and is privately copied with provenance. See [reproduction/provenance](../image/pi-native-search/README.md).


`durable/capability-request-codec.ts` validates exact bounded operation/content and decision facts; `capability-requests.ts` persists at most32 immutable original denials and one matching retry claim through the existing policy lease/atomic helpers. `execution/capability-requests.ts` connects those facts to live run/policy/generation checks; the Docker backend retains effect ownership, expiry timers, cancellation and namespace joins. `cli/permission-decisions.ts` owns local inspection/decision/direct retry only. Native Pi remains the sole task journal/scheduler/provider loop. Pending wait is typed by `permissionRequestId`, published after closure and cleared only by the shared explicit accepted-message wake. Recovery of an interrupted request closes the captured namespace before checkpointing input without dispatching native work. One optional operator-registered hand uses anchored hash-verified code in `execution/custom-hand.ts`, outside the protected entry and brain API.

The single custom tool pins its operator path/hash/replay in native task memo evidence before execution intent. Recovery requires that original pin to be present and unchanged before effects; replacement code needs a new native task. This memo grants no permission and never resumes a denied original call.

Custom code must be below an admitted RO image or genuinely sealed host alias and satisfy the existing bounded arbitrary-execution profile. Anchored code is read/hash-checked once (64 KiB maximum), then the exact bytes/input are checked again by the parent and passed to the clean Node child. Native input has text `maxLength: 256` plus a 1024-byte transport bound, optional boolean network intent, stdout-only 4096-byte/64-line native output limits and the existing 5-second timeout. SAFE replay rechecks current pin/authority; UNSAFE interrupted effects retain uncertainty without replay. No native API object or credentials cross into the child.

Hands networking has two enforced layers: the consumer owns an exact IPv4/IPv6 kernel filter excluding special/metadata and all reachable public/private brain endpoints, and the resident remains socket denied while each actual command installs inherited seccomp socket denial unless explicit policy/exact approval and call intent permit network. Explicit grants include legitimate private/CGNAT/ULA peers and private DNS. Shared protected/gateway resolvers permit only UDP/TCP destination53 with complete nonconflicting protected endpoint facts. SEPT validates current brain interfaces, runtime-derived topology, DNS and actual filter tables before effects through its trusted control client; configuration fingerprints bind the complete portable consumer inventory. It does not provision a namespace or run a network broker. Native Bash/custom schemas preserve bounded network intent in operator request/retry identities; network expansion uses the existing quiescent fresh-generation rule. Credentials and Models remain brain-owned.

Support is bound to the exact qualified source/image/host combination. Native Windows worker operation remains unsupported because Unix control/POSIX leases remain; Intel Mac and Windows Docker Linux/WSL recipes remain unqualified. [The as-built record](as-built/capability-confinement.md) retains source/image evidence and publicIPv6/UFW/provider-outage/OAuth and unknown original stream-loss qualifications.

This contract reaches the existing installed runtime. See [README's later packaging scope](../README.md#portability-evidence-and-scope) for the separate future Node/TypeScript embedding and documentation programme.
