FROM node:22-bookworm-slim AS base

ARG CODEBASE_MEMORY_MCP_VERSION=v0.8.1
ARG CODEBASE_MEMORY_MCP_SHA256_AMD64=6ab87a6c05d049dde57700803ca0ab4199fcf25973a0606618af0fcee73f5abd
ARG CODEBASE_MEMORY_MCP_SHA256_ARM64=13526acc2a6a0697dff3c763fb443a416589bc10ad8b12015b63d87e515dd72b

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git tar gzip \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) cbm_arch="amd64"; cbm_sha256="$CODEBASE_MEMORY_MCP_SHA256_AMD64" ;; \
    arm64) cbm_arch="arm64"; cbm_sha256="$CODEBASE_MEMORY_MCP_SHA256_ARM64" ;; \
    *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL --proto '=https' --proto-redir '=https' "https://github.com/DeusData/codebase-memory-mcp/releases/download/${CODEBASE_MEMORY_MCP_VERSION}/codebase-memory-mcp-linux-${cbm_arch}-portable.tar.gz" -o /tmp/cbm.tar.gz; \
  printf '%s  %s\n' "$cbm_sha256" /tmp/cbm.tar.gz | sha256sum -c -; \
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
