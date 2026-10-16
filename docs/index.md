# SEPT documentation

This is the canonical Markdown corpus for people and AI assistants. Read these same files from a checkout, the npm package or a website renderer. There is no separate AI contract.

## Version and support

This corpus describes `sept-agent@0.1.0`, ESM on Node.js >=22.19.0, with installed Pi 1.1.0. Only `sept-agent`, `sept-agent/client` and `sept-agent/hands` are npm APIs; internal source/mechanism barrels are not public entries. CommonJS, browser use and native Windows worker operation are unsupported.

Execution uses an explicitly supplied local Docker Linux Engine (API 1.44–1.52, cgroup v2) and the matching SEPT image. Installing npm does not compile the C helpers or apply the image-only overlay. Build from a pinned full source checkout; the tarball intentionally excludes the build/test context.

The prior portability qualification is historical: executable source `3bf4f560e4989005469431c16a67fd911398fa01`, confirmed at docs-only commit `d361123d7c242db5af3ae2d1cb4daea4a2acdeff`. Its [repository-only as-built record](https://github.com/DB-Conneely/sept/blob/d361123d7c242db5af3ae2d1cb4daea4a2acdeff/docs/as-built/capability-confinement.md) records native abyss Ubuntu26.04.1/x86_64, kernel7.0.0-38, Docker29.1.3/cgroup v2 and Node 22.22.1; native Mac ARM qualifies only its scoped Docker Linux path. This does not certify a later package/image. Full Darwin, Intel Mac, Windows/WSL and arbitrary combinations remain unqualified. The [Pi contract qualifications](pi-contract.md#portability-qualification) retain the exact network/provider/security/evidence limits.

## Developer reading order

1. [README](../README.md): install, worker and client entry points.
2. [Models](models.md): choose/authenticate a suitable model.
3. [Pi and supplied hands](pi-contract.md#executable-supplied-hands-setup): supply the execution namespace and first-boot policy.
4. [SDK](sdk.md): embed the worker and connect an existing service.
5. [Worker API](worker-api.md): complete HTTP/SSE routes and durable semantics.
6. [Architecture](architecture.md) and [observability](observability.md): ownership and operational evidence.
7. [Contributing](../CONTRIBUTING.md): exact setup/gates and change expectations.

The [Node app](../examples/node-app/README.md) hosts the worker and authors a trusted native extension. The [incident app](../examples/incident-investigator/README.md) integrates inline evidence, WAIT and later operator evidence through the public client. Use separate fresh authority roots for these different grants.

## AI task navigation

| Task | Read and preserve |
| --- | --- |
| Embed/start/stop/reopen a worker | [SDK worker lifecycle](sdk.md#worker-lifecycle); explicit roots/token and caller-owned signals/telemetry |
| Integrate an existing HTTP service | [Five client calls](sdk.md#five-client-calls); stable IDs, ambiguous acceptance and current state |
| Recover a conversation gap | [Finite 410 recovery](sdk.md#finite-410-recovery); report the missing evidence before choosing retained tail |
| Select/authenticate/configure a model | [Models](models.md); immutable pair, Pi-owned credentials and declared usage/context metadata |
| Supply hands or set rights | [Executable setup](pi-contract.md#executable-supplied-hands-setup) and [local permissions](pi-contract.md#local-hands-permissions); no task-text authority |
| Write or port a native extension | [Native authoring](pi-contract.md#author-build-and-load-a-native-extension); normal matching imports and full brain-code trust |
| Use SSE/drain/model routes absent from the client | [HTTP API](worker-api.md); retain all routes and bounds |
| Diagnose state versus telemetry | [Observability ownership](observability.md#library-and-cli-ownership); durable evidence is authority |
| Change source/API/examples | [Contribution rules](../CONTRIBUTING.md) and [architecture](architecture.md); exercise the installed production path |

## Website and raw Markdown mapping

A renderer can map routes directly to these source files. Links remain ordinary Markdown; publication and routing infrastructure are outside this package.

| Suggested website route | Canonical file in this package |
| --- | --- |
| `/` | [README.md](../README.md) |
| `/docs` | [docs/index.md](index.md) |
| `/docs/sdk` | [docs/sdk.md](sdk.md) |
| `/docs/models` | [docs/models.md](models.md) |
| `/docs/worker-api` | [docs/worker-api.md](worker-api.md) |
| `/docs/pi-contract` | [docs/pi-contract.md](pi-contract.md) |
| `/docs/architecture` | [docs/architecture.md](architecture.md) |
| `/docs/observability` | [docs/observability.md](observability.md) |
| `/contributing` | [CONTRIBUTING.md](../CONTRIBUTING.md) |

Repository-only rules, audits, specifications and historical as-built evidence are explicitly linked to the repository. Historical claims use pinned revisions. They are not additional files in the npm artifact.
