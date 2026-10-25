# Pi 1.1.0's tools-manager selects this official musl release; Debian bookworm fd 8.6
# lacks --no-require-git. Pin bytes at build time so denied-network runtime never installs tools.
FROM node:22-bookworm-slim AS fd-tools
ADD --checksum=sha256:d76c4317f7d5dba69f8a2a15856c90c777e7f0dd4e85f0de8c76de6992c374d4 https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-aarch64-unknown-linux-musl.tar.gz /tmp/fd-arm64.tar.gz
ADD --checksum=sha256:761c72dc8e120d85b22292063be8a796e2eeb20eb3e4f38b8fa2343ccf3514a7 https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-x86_64-unknown-linux-musl.tar.gz /tmp/fd-amd64.tar.gz
RUN case "$(uname -m)" in \
      aarch64) archive=/tmp/fd-arm64.tar.gz ;; \
      x86_64) archive=/tmp/fd-amd64.tar.gz ;; \
      *) exit 1 ;; \
    esac \
    && mkdir /tmp/fd \
    && tar -xzf "$archive" -C /tmp/fd --strip-components=1 \
    && cp /tmp/fd/fd /usr/local/bin/fd \
    && /usr/local/bin/fd --version

FROM node:22-bookworm-slim AS build

# Build only the narrow Linux process-control guard; compiler never enters the runtime image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY vendor ./vendor
RUN npm ci
COPY image/pi-native-search /tmp/pi-native-search
# The security distribution changes only undici metadata; this overlay changes four tool files.
RUN node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const directory = "/tmp/pi-native-search";
const p = JSON.parse(readFileSync(`${directory}/provenance.json`, "utf8"));
const hash = (path, algorithm) => createHash(algorithm).update(readFileSync(path)).digest("hex");
const expected = ["dist/core/tools/find.d.ts", "dist/core/tools/find.js", "dist/core/tools/grep.d.ts", "dist/core/tools/grep.js"];
assert.deepEqual(Object.keys(p.files).sort(), expected);
assert.equal(hash(`${directory}/native-search.patch`, "sha256"), p.patch.sha256);
for (const algorithm of ["sha256", "sha512"]) assert.equal(hash(`${directory}/overlay.tgz`, algorithm), p.overlay[algorithm]);
const names = execFileSync("tar", ["-tzf", `${directory}/overlay.tgz`], { encoding: "utf8" }).trim().split("\n");
const entries = execFileSync("tar", ["-tvzf", `${directory}/overlay.tgz`], { encoding: "utf8" }).trim().split("\n");
assert.deepEqual(names.sort(), expected);
assert.equal(entries.length, expected.length);
assert.ok(entries.every((entry) => entry.startsWith("-")));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8")).packages["node_modules/@earendil-works/pi-coding-agent"];
const distribution = JSON.parse(readFileSync("vendor/pi-coding-agent-provenance.json", "utf8"));
for (const [key, value] of Object.entries(distribution.upstream)) assert.equal(p.upstream[key], value);
assert.equal(p.upstream.version, lock.version);
assert.equal(lock.resolved, `file:${distribution.distribution.path}`);
assert.equal(lock.integrity, distribution.distribution.integrity);
assert.equal(lock.dependencies.undici, distribution.change.to);
assert.equal(hash(distribution.distribution.path, "sha256"), distribution.distribution.sha256);
for (const [path, hashes] of Object.entries(p.files)) assert.equal(hash(`node_modules/@earendil-works/pi-coding-agent/${path}`, "sha256"), hashes.originalSha256);
JS
RUN tar -xzf /tmp/pi-native-search/overlay.tgz -C node_modules/@earendil-works/pi-coding-agent \
    && rm node_modules/@earendil-works/pi-coding-agent/dist/core/tools/find.js.map \
       node_modules/@earendil-works/pi-coding-agent/dist/core/tools/find.d.ts.map \
       node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.js.map \
       node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.d.ts.map
RUN node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync("/tmp/pi-native-search/provenance.json", "utf8"));
for (const [path, hashes] of Object.entries(p.files)) assert.equal(createHash("sha256").update(readFileSync(`node_modules/@earendil-works/pi-coding-agent/${path}`)).digest("hex"), hashes.effectiveSha256);
JS
COPY src ./src
COPY test ./test
COPY scripts ./scripts
RUN cc -shared -fPIC -O2 -Wall -Wextra -Werror -o /app/hands-guard.so src/execution/hands-guard.c \
    && cc -DHANDS_GUARD_CHECK -O2 -Wall -Wextra -Werror -o /app/hands-guard-check src/execution/hands-guard.c \
    && cc -O2 -Wall -Wextra -Werror -o /app/hands-command src/execution/hands-command.c src/execution/hands-guard.c \
    && cc -O2 -Wall -Wextra -Werror -o /app/hands-process-control src/execution/hands-process-control.c src/execution/hands-guard.c \
    && npm run build && npm prune --omit=dev
# Pruning cannot silently restore the registry bodies after compilation.
RUN node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync("/tmp/pi-native-search/provenance.json", "utf8"));
for (const [path, hashes] of Object.entries(p.files)) assert.equal(createHash("sha256").update(readFileSync(`node_modules/@earendil-works/pi-coding-agent/${path}`)).digest("hex"), hashes.effectiveSha256);
JS

FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep iptables \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 sept \
    && useradd --uid 10001 --gid 10001 --create-home sept \
    && groupadd --gid 10002 sept-workspace \
    && useradd --uid 10002 --gid 10002 --create-home --home-dir /home/sept-hands sept-hands \
    && useradd --uid 10003 --gid 10002 --no-create-home sept-command \
    && chmod 0700 /home/sept-hands \
    && mkdir -p /home/sept-hands/.pi/agent/bin \
    && mkdir -p /app /pi-agent /state /workspace /usr/local/libexec/sept \
    && chown -R 10001:10001 /pi-agent /state /workspace

WORKDIR /app
COPY LICENSE NOTICE ./
COPY --from=fd-tools /usr/local/bin/fd /usr/local/libexec/sept/fd
COPY --chown=10001:10001 sept ./sept
COPY --from=build --chown=10001:10001 /app/package.json /app/package-lock.json ./
COPY --from=build --chown=10001:10001 /app/vendor ./vendor
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build /app/hands-guard.so /app/hands-guard.so
COPY --from=build /app/hands-guard-check /app/hands-guard-check
COPY --from=build /app/hands-command /usr/local/libexec/sept/hands-command
COPY --from=build /app/hands-process-control /app/hands-process-control
COPY --from=build /tmp/pi-native-search/provenance.json /app/pi-native-search-provenance.json
COPY --from=build /tmp/pi-native-search/README.md /app/pi-native-search-README.md
RUN cp /usr/bin/rg /usr/local/libexec/sept/rg \
    && cp /usr/local/libexec/sept/rg /home/sept-hands/.pi/agent/bin/rg \
    && cp /usr/local/libexec/sept/fd /home/sept-hands/.pi/agent/bin/fd \
    && chown 10002:10001 /app \
    && chmod 0750 /app \
    && chmod 0444 /app/pi-native-search-provenance.json /app/pi-native-search-README.md \
    && chown -R 0:0 /usr/local/libexec/sept /home/sept-hands/.pi/agent/bin \
    && chmod 0555 /usr/local/libexec/sept /usr/local/libexec/sept/* /home/sept-hands/.pi/agent/bin /home/sept-hands/.pi/agent/bin/*
# Verify the exact dependency bytes that the installed entry will import in this final stage.
RUN node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync("/app/pi-native-search-provenance.json", "utf8"));
for (const [path, hashes] of Object.entries(p.files)) assert.equal(createHash("sha256").update(readFileSync(`node_modules/@earendil-works/pi-coding-agent/${path}`)).digest("hex"), hashes.effectiveSha256);
JS

ENV NODE_ENV=production \
    HOME=/home/sept \
    PI_CODING_AGENT_DIR=/pi-agent \
    SEPT_STATE_DIR=/state/runs \
    SEPT_WORKSPACE_ROOT=/workspace \
    TMPDIR=/tmp

USER 10001:10001
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["./sept", "health", "--url", "http://127.0.0.1:8090/health"]

ENTRYPOINT []
CMD ["./sept", "worker", "--host", "0.0.0.0", "--port", "8090", "--state-dir", "/state/runs", "--agent-dir", "/pi-agent", "--workspace-root", "/workspace"]
