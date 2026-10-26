FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY docker/certs/ /usr/local/share/ca-certificates/memorepo/
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/agent-runtime/package.json packages/agent-runtime/package.json

RUN pnpm install --filter @memorepo/web... --frozen-lockfile

COPY apps/web apps/web

ARG VITE_API_URL=http://127.0.0.1:8787
ENV VITE_API_URL=${VITE_API_URL}

RUN pnpm --filter @memorepo/web build

FROM nginxinc/nginx-unprivileged:1.31.7-alpine@sha256:378d0c32f6562f7fd9629170797f57d2b953aa09be983b3daaf4809bb039ca00

USER root
COPY docker/certs/ /usr/local/share/ca-certificates/memorepo/
RUN update-ca-certificates && apk upgrade --no-cache
USER 101

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 5173
