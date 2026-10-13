FROM docker:29.1.3-cli AS docker-cli

# Pi 1.1.0's tools-manager selects this official musl release; Debian bookworm fd 8.6
# lacks --no-require-git. Pin bytes at build time so denied-network runtime never installs tools.
FROM docker-cli AS fd-tools
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

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 sept \
    && useradd --uid 10001 --gid 10001 --create-home sept \
    && mkdir -p /app /pi-agent /state /workspace \
    && chown -R 10001:10001 /pi-agent /state /workspace

WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=fd-tools /usr/local/bin/fd /usr/local/bin/fd
COPY --chown=10001:10001 sept ./sept
COPY --from=build --chown=10001:10001 /app/package.json /app/package-lock.json ./
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist

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
