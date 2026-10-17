# Contributing to SEPT

Use a complete source checkout and Node.js >=22.19.0. Read the repository-only [AGENTS.md](https://github.com/DB-Conneely/sept/blob/main/AGENTS.md) and [TypeScript rules](https://github.com/DB-Conneely/sept/blob/main/.codex/rules/typescript.md) before changing source/tests. They are intentionally not shipped as npm build inputs. Keep the thin Pi-owned architecture and preserve user work and meaningful history. Deployment is performed manually by the user through GitHub CI/CD.

## Setup and gates

```sh
npm ci
npm run check
```

Dependencies are exact pins: Pi Durable/coding-agent/AI/Chord/codemode1.1.0, TypeScript 5.9.2 and Node types 24.3.1. Keep the lockfile, strict compiler, architecture rules, exported-behavior checks and test concurrency 4. Do not substitute a compiler, hide declaration failures with broader skips, or patch host npm Pi headers. The image-only native-search overlay is separately pinned and verified.

For Docker-dependent gates, select one trusted canonical local Unix socket and clear ambient Docker selection. Run from the pinned full checkout; building is local verification, not deployment:

```sh
export SEPT_ENGINE_SOCKET=/run/docker.sock  # choose the actual trusted local socket
export SEPT_ENGINE_SOCKET="$(node -e 'console.log(require("node:fs").realpathSync(process.env.SEPT_ENGINE_SOCKET))')"
export SEPT_ENGINE_HOST="unix://$SEPT_ENGINE_SOCKET"
env -u DOCKER_HOST -u DOCKER_CONTEXT docker --host "$SEPT_ENGINE_HOST" \
  build --no-cache --iidfile /absolute/private/evidence/sept.iid -t sept:local .
SEPT_HANDS_TEST_IMAGE="$(cat /absolute/private/evidence/sept.iid)" npm run gate
npm audit
```

Create the evidence directory first; keep build/image receipts. Check the actual actor traversal, cgroup v2 and memory/PID/disk headroom. Gate fixture Engine selection follows the test host's configuration; the supplied-hands consumer recipe uses its explicit socket. Full native Linux/amd64 is the gate target; the bounded native Mac ARM Docker Linux smoke is separate. A full Darwin suite is not a release gate.

After each coherent module: `npm run check`, directly affected tests, structural/TSDoc review, then unchanged `npm run gate`. The gate includes build, all compiled tests, meta-tests and `npm audit --omit=dev`. Before handoff also run `git diff --check` and full audit. A red/unrun gate is incomplete. Serialize independently launched heavy build/gate/provider work under nice 10; retain unchanged test concurrency 4. Join every job and independent finalizer. `npm run build` and `prepack` clean `dist`; wait for all dist consumers before running them.

## Ownership and change expectations

Cross-mechanism imports use intentional indexes. Pi alone owns providers/authentication, generation/tool tasks, native scheduling/replay and context accounting. SEPT owns durable task/lifecycle/evidence, bounded authenticated transport and explicitly supplied execution authority. Do not add another provider SDK, model loop, tokenizer, compactor, scheduler, extension ABI or provisioner.

Keep functions/files cohesive and documented; validate hostile input once at its owning boundary, use typed domain errors, preserve first-cause cancellation and independent cleanup, bound resources before buffering, and preserve fsync-before-transition ordering. Credentials never enter prompts, durable/public state, telemetry, logs or images. Trusted extensions are full-authority brain code; workspace instructions/skills and mounts never grant executable authority. Hands checks live policy beside effects and fails closed.

A focused PR should explain the concrete trigger and resulting behavior, exact owner/callers and relevant validation. Update public contracts/docs/examples together. Add meaningful focused regression coverage for behavior, important errors and both race orderings; avoid tests that merely mirror trivial implementation. Preserve exact dependency/security/limit/meta gates.

Only root, client and hands are public npm entries. Public API changes need strict external NodeNext compilation with normal Node types and `skipLibCheck=false`, a real production-only cold install outside repository module lookup, and actual behavioral callers. Native Pi extension authoring is a separate declaration/tooling concern; describe any upstream limits honestly. The copied [Node application](examples/node-app/README.md) and [incident investigator](examples/incident-investigator/README.md) must compile/copy/run explicitly because root tsconfig does not include them.

## Installed evidence and cleanup

Compilation and isolated tests support delivery; the actual installed runtime path is the completion criterion. Exercise the changed installed CLI/public import through production Pi and supplied hands. Container input changes require a fresh no-cache image and affected installed proof. The npm tarball excludes the Docker build context; build from full source and inspect final package inventory, source maps, legal/provenance files and allowed imports.

Record exact source/tar/image/dependency identity, cwd/commands, actual child exit/signal/join, original failures and separately observed finalizers. Do not turn wrapper exit0 into a product verdict. Export needed tmpfs data before stopping the exact owned generation; independently close worker, provider/listener, attachments/leases and namespace even if one cleanup fails. Preserve stopped-generation proof, mutex inodes, evidence, recovery and unrelated resources. Never prune/delete them as incidental cleanup. For helper-created instances, join the worker before `sept hands finish --root <instance>` exports and stops the owned generation.

## Automated package releases

Branch pushes and pull requests run `SEPT checks`. An authorized push to `main` runs `SEPT publish`: select the next patch version, run the Linux AMD64/ARM64 package and image gates and macOS installed-package lifecycle checks, then publish the exact tested artifacts to npm, GHCR and a GitHub release. There is no service deployment job and no live-provider/local-model prerequisite.

Keep the source version baseline unchanged; CI allocates the next patch from completed publications. Monitor the exact pushed SHA until **Publish verified artifacts** succeeds, then verify npm, the versioned multi-architecture GHCR image and GitHub release. A green check alone is not completed publication. Preserve artifact hashes and publication receipts.

On partial publication or npm scanning delay, inspect and retry the original run's failed jobs with its retained artifacts. Never submit an accepted or uncertain npm version again, overwrite immutable images, or use a new push to bypass an incomplete publication. An incomplete release blocks allocating another version. Main publications queue without cancelling older runs. Repository/npm trusted-publisher access remains an operator prerequisite.
