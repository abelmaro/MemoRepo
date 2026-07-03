FROM node:22-bookworm-slim AS base

ARG CODEBASE_MEMORY_MCP_VERSION=v0.8.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git tar gzip \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) cbm_arch="amd64" ;; \
    arm64) cbm_arch="arm64" ;; \
    *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/DeusData/codebase-memory-mcp/releases/download/${CODEBASE_MEMORY_MCP_VERSION}/codebase-memory-mcp-linux-${cbm_arch}-portable.tar.gz" -o /tmp/cbm.tar.gz; \
  mkdir -p /tmp/cbm; \
  tar -xzf /tmp/cbm.tar.gz -C /tmp/cbm; \
  find /tmp/cbm -type f -name codebase-memory-mcp -exec cp {} /usr/local/bin/codebase-memory-mcp \; ; \
  chmod +x /usr/local/bin/codebase-memory-mcp; \
  rm -rf /tmp/cbm /tmp/cbm.tar.gz

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json

RUN pnpm install --filter @memorepo/api... --frozen-lockfile

COPY apps/api apps/api

RUN pnpm --filter @memorepo/api build

RUN mkdir -p /var/lib/memorepo && chown node:node /var/lib/memorepo

ENV MEMOREPO_HOME=/var/lib/memorepo
EXPOSE 8787

USER node

RUN git config --global --add safe.directory '*'

CMD ["node", "apps/api/dist/index.js"]
