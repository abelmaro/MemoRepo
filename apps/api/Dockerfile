ARG NODE_IMAGE=node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf

FROM ${NODE_IMAGE} AS cbm

ARG CODEBASE_MEMORY_MCP_VERSION=v0.9.0
ARG CODEBASE_MEMORY_MCP_SHA256_AMD64=8459d5c9d1457f2c82de3de307ffc7641ecbba2dde893427be1e62eca8ef9b25
ARG CODEBASE_MEMORY_MCP_SHA256_ARM64=b0a43fdaf534073c16707d72726b73b149d4c1212034b281ee8b7b2dac755107

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tar gzip \
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
  find /tmp/cbm -type f -name codebase-memory-mcp -exec cp {} /codebase-memory-mcp \; ; \
  chmod 0755 /codebase-memory-mcp

FROM ${NODE_IMAGE} AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/agent-runtime/package.json packages/agent-runtime/package.json

RUN pnpm install --filter @memorepo/agent-runtime --filter @memorepo/api... --frozen-lockfile

COPY packages/agent-runtime/tsconfig.json packages/agent-runtime/tsconfig.json
COPY packages/agent-runtime/src packages/agent-runtime/src
COPY apps/api apps/api

RUN pnpm --filter @memorepo/agent-runtime build \
  && pnpm --filter @memorepo/api build \
  && pnpm --filter @memorepo/api deploy --prod --legacy /opt/memorepo-api

# Development-only target for contract and benchmark runs against the exact CBM
# binary pinned above. It retains the workspace tests and development dependencies;
# the production runtime remains unchanged.
FROM build AS cbm-test

COPY --from=cbm /codebase-memory-mcp /usr/local/bin/codebase-memory-mcp

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=test
ENV MEMOREPO_HOME=/tmp/memorepo-test

USER node

FROM ${NODE_IMAGE} AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/* \
    /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /opt/yarn-* \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/corepack \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg

COPY --from=cbm /codebase-memory-mcp /usr/local/bin/codebase-memory-mcp
COPY --from=build --chown=node:node /opt/memorepo-api /app

RUN mkdir -p /var/lib/memorepo /var/lib/memorepo-secrets \
  && chown node:node /var/lib/memorepo /var/lib/memorepo-secrets \
  && git config --system --add safe.directory '/var/lib/memorepo/spaces/*'

WORKDIR /app

ENV NODE_ENV=production
ENV MEMOREPO_HOME=/var/lib/memorepo
ENV MEMOREPO_SECRETS_DIR=/var/lib/memorepo-secrets

EXPOSE 8787

USER node

CMD ["node", "dist/index.js"]
