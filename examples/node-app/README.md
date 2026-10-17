# External Node application

This ESM application embeds the complete worker, calls it through the public task client, and loads a trusted native Pi marker tool and prompt section. Tested authoring runtime: Node **22.22.1**, TypeScript **5.9.2**, Node types **24.3.1**, Pi Durable/AI **1.1.0**. The host npm Pi packages stay stock. Use a separately qualified Docker Linux hands image; npm installation does not build the image or provision an Engine/model server.

## Copy and install

Start outside the SEPT repository and its ancestor module lookup. Set `SEPT_EXAMPLE_SOURCE` to this directory in an unpacked exact tarball, `SEPT_TARBALL` to that tarball's absolute path and `SEPT_APP` to a new external app directory. Retain the tar hash and production dependency tree.

```sh
cp -R "$SEPT_EXAMPLE_SOURCE" "$SEPT_APP"
cd "$SEPT_APP"
npm install --omit=dev --save-exact "$SEPT_TARBALL"
npm ls --omit=dev --json > production-dependencies.json
npm install --save-dev --save-exact typescript@5.9.2 @types/node@24.3.1 @modelcontextprotocol/sdk@1.32.1
npm run build:client
```

`build:client` is an ordinary strict NodeNext/ES2023 compile with normal Node types and `skipLibCheck:false`. It checks the real public SEPT declarations. It uses no aliases, repository imports, DOM library, header edits or symlinked dependencies. Examples intentionally sit outside the root compiler: root lint checks their syntax, while copied external compilation and type-aware structural/documentation lint must use the real installed dependency graph. The repository gate cannot substitute for those external checks.

## Separate native authoring project

The stock Pi native root imports reach `@google/genai@2.21.0` declarations. Its Node header imports the optional MCP Client peer (`@modelcontextprotocol/sdk`, declared compatible range `^1.25.2`) and uses the standard web types `RequestInfo`, `HeadersInit` and `ErrorEvent` in fetch/websocket contracts. A Node-only native check fails on those five header diagnostics. The authoring-only exact SDK **1.32.1** pin supplies that real peer; `extensions/tsconfig.json` supplies TypeScript's standard **DOM** declarations for that upstream contract. No MCP connection, browser runtime or second compiler is added.

This native project inherits strict NodeNext, normal Node types, `skipLibCheck:false` and `noEmitOnError:true`. The independent client project retains only ES2023/Node and no DOM library. Both commands must succeed before copying code:

```sh
npm run build:client
npm run build:extension
```

No installed header, ambient shim, alias or skipped declaration check is used. This configuration resolves the declarations actually reached by the extension; it does not repair Pi AI's separate model-catalog JSON imports without NodeNext attributes. Importing that broader catalog still needs upstream repair. SEPT's public package declarations remain independently checked with Node-only types.

Follow the [fresh-instance setup](../../README.md#install-and-prepare) with `--root "$SEPT_APP/instance" --access files`, choosing the actual local Engine socket and locally available image. Use a fresh separate instance for this example. The helper activates workspace read/write before worker initialization and leaves selected mounts, shell and networking disabled. Never widen the incident app's policy for this example.

Set `PI_CODING_AGENT_DIR`, `SEPT_STATE_DIR`, `SEPT_WORKSPACE_ROOT`, `SEPT_HANDS_CONFIGURATION` to the setup's absolute `agentDir`, `stateRoot`, `workspaceRoot`, `handsConfigurationPath` fields, and supply `SEPT_TOKEN` privately. Configure the desired provider/model through [model authentication](../../README.md#model-authentication) in that agent directory. The physical agent directory must be below this external app, so normal ancestor lookup finds its matching `node_modules`.

```sh
test -f extension-dist/example.js
mkdir -p "$PI_CODING_AGENT_DIR/extensions"
cp extension-dist/example.js "$PI_CODING_AGENT_DIR/extensions/example.js"
node --input-type=module -e 'console.log(import.meta.resolve("@earendil-works/pi-durable")); console.log(import.meta.resolve("@earendil-works/pi-ai"))'
node worker.mjs
```

No symlink escape, deep native-dist import or CWD fixture import is involved. The named `extension` exports `example-marker`, `write_marker` and section marker `SEPT_NATIVE_EXAMPLE_SECTION_V1`. It checks `api.env` and writes bounded text to `/workspace/native-marker.txt` through the supported native environment. Trusted extension JS is full-authority application brain code; only env-routed effects use hands policy. Task text, instructions/skills and selected mounts never install code or grant rights.

## Submit and close

The host prints one JSON `baseUrl`; use it in another terminal with the same explicit token/workspace/provider/model. Choose a stable new `SEPT_EVENT_ID` for one logical task; keep it on an ambiguous-acceptance retry. The client owns a finite 240-read/250ms poll budget and cancels an unfinished admitted task in `finally`.

```sh
export SEPT_BASE_URL=http://127.0.0.1:the-printed-port
export SEPT_PROVIDER=your-configured-provider
export SEPT_MODEL=your-configured-model
export SEPT_EVENT_ID=node-marker-001
node dist/client.js
```

The client requires authoritative complete state and prints its bounded public conversation. Actual acceptance additionally requires the section in the real provider request, Harness selecting `write_marker`, and exported hands bytes exactly `SEPT_NATIVE_EXAMPLE` plus newline. Compilation or directly calling the extension object cannot establish this.

Send SIGINT/SIGTERM to the worker host; it awaits `worker.stop()` and removes its handlers. Readiness covers listener/router and durable adoption admission; native execution may still fail afterward and is observed through the task API. Normal stop retains idle hands. After the host has joined, run `sept hands finish --root "$SEPT_APP/instance"` to retain the private workspace archive and verify the exact owned generation stopped/PID0. Preserve its receipts and archive. Cancel/loss can stop hands earlier, so later export is not guaranteed.

After editing an extension, stop/join the host and start a **fresh Node process**. Stable canonical module-URL caching survives Pi host replacement and same-process stop/reopen; reopening resumes durable state without promising edited-code reload. There is no hot reload.

The native authoring project requires those explicit upstream web/optional-peer declaration inputs. Its strict success does not qualify the separate raw model-catalog graph. Runtime demonstration, Node-only public client checks, module gates and final package/image/platform qualification remain separate obligations; this example does not certify provider outage/OAuth refresh or arbitrary host support.
