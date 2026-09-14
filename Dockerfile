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

CMD ["./sept", "worker", "--host", "0.0.0.0", "--port", "8090", "--state-dir", "/state/runs", "--agent-dir", "/pi-agent", "--workspace-root", "/workspace"]
