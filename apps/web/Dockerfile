FROM node:26-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS build

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

FROM nginxinc/nginx-unprivileged:1.30.5-alpine@sha256:daa17b944bac2b578e962da4c61ad72a59233b3c63abea17113acaf4e6b9aea4

USER root
COPY docker/certs/ /usr/local/share/ca-certificates/memorepo/
RUN update-ca-certificates && apk upgrade --no-cache
USER 101

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 5173
