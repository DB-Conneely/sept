# Publishing SEPT

`npm install --save-exact sept-agent` adds SEPT to an application's dependencies. The installed command is `sept`; the imports are `sept-agent`, `sept-agent/client` and `sept-agent/hands`. Publishing makes the package available to consumers; it does not run a SEPT service.

## What each push does

Branch pushes and pull requests run `SEPT checks`. A push to `main` runs the same checks, then `SEPT publish` publishes the verified package to npm, the verified Linux/amd64 image to `ghcr.io/db-conneely/sept`, and a GitHub release containing the tarball and `release.json` checksums/identities. There is no deployment job.

The single native Ubuntu/amd64 job runs under nice 10: exact Node 22.23.3/npm 11.21.0, `npm ci`, fresh no-cache Docker build, unchanged `npm run gate` (test concurrency four, zero skipped tests), full dependency audit, and `npm pack --ignore-scripts` using the already tested build. It cold-installs that tarball outside repository module lookup, checks all three public imports with strict Node-only TypeScript, runs the installed public worker and CLI, verifies authenticated health/client error behavior, and runs the actual image's worker/CLI and shutdown. The saved tested image is round-tripped through Docker load and loaded again for publication; it is never rebuilt in the publish job. A fresh owned local tag and the archive config digest identify it across Docker stores that expose different index/config IDs. OCI indexes may contain only the one amd64 image and its bound BuildKit attestation.

No local model is installed or downloaded. No provider credential, live model call or paid-provider verification is required. Existing bounded deterministic protocol tests remain part of the normal gate. Readiness smoke tests certify packaging/wiring and lifecycle, not a successful model invocation. This workflow publishes only Linux/amd64 images; it does not claim an ARM image release or a full Darwin/Windows gate.

## One-time npm configuration

1. Create/sign into your npm account, enable two-factor authentication, and confirm you can own the unscoped name `sept-agent`. A registry 404 does not reserve the name.
2. Bootstrap the existing assessed `0.1.0` tarball from your own terminal: `npm login`, then `npm publish /absolute/path/sept-agent-0.1.0.tgz --access public --ignore-scripts`. The retained qualified artifact is in the workspace delivery evidence under `.sept-package-delivery-20261016/roles/b3_t2_implementor/remote-evidence-exact/artifact-01/`; its SHA256 is `ce791bcaeb8e112d3b2bf11fe4c5644d8e81ea608bf4555db4d7a7a1227ce7bb`. Check it before publishing. npm needs an existing package before you can configure its trusted publisher.
3. On npm, open `sept-agent` → Settings → Trusted Publisher → GitHub Actions. Set repository owner **DB-Conneely**, repository **sept**, workflow filename **publish.yml**, and leave environment blank. Allow direct publishing, rather than stage-only publishing. Configure this shortly before the first main push: npm requires a newly configured publisher to be used within two days.
4. Prefer trusted publishing with 2FA and disallowed traditional tokens. This workflow uses GitHub OIDC; do not create an `NPM_TOKEN` repository secret.

Official reference: [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/). Registry ownership, account policy and the first publication must be completed by you; they cannot be proved by local tests.

## One-time GitHub configuration

1. Use the existing `DB-Conneely/sept` repository and make it public yourself when ready. npm's automatic provenance requires public source and a public npm package.
2. In Settings → Actions → General, enable Actions and allow the pinned official `actions/checkout`, `actions/setup-node`, `actions/upload-artifact` and `actions/download-artifact` actions. Keep the default token read-only; only the publish job requests `contents: write`, `packages: write`, and `id-token: write`. Organisation policy must permit these requested permissions.
3. Use disposable GitHub-hosted `ubuntu-24.04` runners. Enable available Actions minutes/budget and allow access to npm, GitHub and GHCR. Do not run public PR code on your long-lived host or supply provider credentials.
4. Protect `main` with required status check **All checks** after its first run establishes the check name. Prefer PRs before main pushes; the main push still repeats the release gate before publication. If GitHub presents a reusable-workflow-prefixed version of that check, select the actual check emitted by this repository.
5. The first GHCR publication uses `GITHUB_TOKEN` automatically. After it exists, set the `sept` container package visibility to **Public** if anonymous Docker pulls should work; GHCR package visibility can remain private even when source is public. Do not create a personal access token for this workflow.
6. Push the prepared commits yourself. Watch **SEPT publish** through its final successful job. Confirm `npm view sept-agent version`, `npm install sept-agent` in an external app, the GitHub release and `docker pull ghcr.io/db-conneely/sept:<version>`. The first actual Actions/OIDC/GHCR run is required to qualify the account-side path.

## Versions and retries

“Increment by .1” is implemented as a SemVer **patch** increment: `0.1.0` → `0.1.1` → `0.1.2`. The source baseline remains `0.1.0`; the main-push workflow's persistent `github.run_number` is added to its patch in the disposable checkout, package lock and shipped example dependency pins. No bot commit or recursive push occurs. Branch/PR checks do not consume this publication counter. Do not reset/recreate/rename `publish.yml` or manually lower/change the baseline without intentionally coordinating a new version sequence.

Every accepted main push reserves a number, including a failed check, so failures can leave version gaps. A rerun keeps the same version. Releases are queued without cancelling older jobs (GitHub's queue holds up to 100 pending runs); hitting that limit requires operator attention. A later version is never intentionally replaced by an older retry's `latest` tags.

For a failed publication, use **Re-run failed jobs** within the 30-day artifact retention period. This reuses the same verified tarball and image after a partial npm/GHCR/release success. Existing npm integrity, image config digest, tag commit and release asset digests must match; otherwise publication fails closed. Do not delete a published version or overwrite its evidence. Re-running all jobs builds a fresh candidate; floating base-image/OS updates may change image bytes, so it can correctly refuse to reuse an already published version. Push a new commit/version instead. Keep the immutable successful workflow artifacts for any release you need beyond GitHub's retention window.

After setup, a push to main is the release action. A green check alone is not publication: the **Publish verified artifacts** job and all three destinations must succeed. No cloud publication is claimed until that job has actually run.

## npm scanning and an accepted submission

npm can accept an upload before its version becomes publicly installable while publish-time scanning runs. The publish job waits up to **20 minutes**, polling every 15 seconds with finite 15-second registry commands, at most 81 reads. Only an explicit E404 is pending; malformed responses, authentication/registry errors and any integrity mismatch fail immediately. Every command/poll is retained. The publish job has a 90-minute outer timeout so scanning, existing bounded commands and artifact retention have headroom; this is an upper bound, not an expected duration.

A small submission receipt is written before invoking npm and updated after its actual result. On **Re-run failed jobs**, previous same-run publication artifacts are restored (both single-artifact and grouped download layouts are supported) and the receipt must match run ID, source commit, version and tar integrity. An accepted or uncertain submission is **never submitted again**: retry waits for its exact public integrity. A definite E401/ENEEDAUTH/EOTP before acceptance is recorded as rejected-auth and can be attempted after fixing authentication. Ambiguous failures, including E403, retain ownership instead of guessing. A retry without a submission receipt also stops if the version is still absent; inspect the previous run/npm status and use a new main push/version if necessary rather than risking a duplicate upload. If scanning remains unavailable after the bound, inspect the npm package/account/scanning status and retry the same failed job later; do not manually republish that version. If npm confirms a submission was definitively rejected for another reason, correct the cause and use a new main push/version. Nothing here qualifies an unrun OIDC publication.

Before the first main push, confirm bootstrap 0.1.0 is available with the qualified integrity and `latest=0.1.0`; the temporary `0.0.0-stage` placeholder is not a stable release. References: [npm scanning announcement](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/), [npm staged publishing](https://docs.npmjs.com/staged-publishing/).
