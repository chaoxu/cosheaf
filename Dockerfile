# syntax=docker/dockerfile:1.7

FROM node:25-bookworm-slim AS base

ARG PNPM_VERSION=10.33.0
ARG NPM_CONFIG_REGISTRY=
ENV PNPM_HOME=/pnpm
ENV PNPM_STORE_DIR=/pnpm/store
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /workspace

RUN if [ -n "$NPM_CONFIG_REGISTRY" ]; then npm config set registry "$NPM_CONFIG_REGISTRY"; fi \
  && npm install -g "pnpm@${PNPM_VERSION}" \
  && pnpm config set store-dir "$PNPM_STORE_DIR" \
  && pnpm config set package-import-method copy \
  && if [ -n "$NPM_CONFIG_REGISTRY" ]; then pnpm config set registry "$NPM_CONFIG_REGISTRY"; fi

FROM base AS build

RUN --mount=type=cache,id=cosheaf-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=cosheaf-apt-lib,target=/var/lib/apt,sharing=locked \
  rm -f /etc/apt/apt.conf.d/docker-clean \
  && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ pkg-config rsync

COPY coflat/package.json coflat/pnpm-lock.yaml coflat/tsconfig*.json coflat/vite.editor.config.ts ./coflat/
COPY coflat/patches ./coflat/patches
COPY coflat/src ./coflat/src
COPY coflat/scripts ./coflat/scripts
COPY coflat/*.ts coflat/*.tsx ./coflat/
COPY cosheaf ./cosheaf

RUN --mount=type=cache,id=coflat-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm --dir coflat install --frozen-lockfile
RUN pnpm --dir coflat build
RUN --mount=type=cache,id=cosheaf-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm --dir cosheaf install --frozen-lockfile --ignore-scripts
RUN pnpm --dir cosheaf rebuild better-sqlite3 esbuild
RUN pnpm --dir cosheaf build
RUN pnpm --dir cosheaf build:server
RUN cp cosheaf/server/schema.sql cosheaf/dist-server/server/schema.sql
RUN --mount=type=cache,id=cosheaf-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm --dir cosheaf prune --prod --ignore-scripts

FROM node:25-bookworm-slim AS runtime

ARG COSHEAF_GIT_SHA=unknown
ENV NODE_ENV=production
ENV COSHEAF_PORT=3030
ENV COSHEAF_DATA_DIR=/var/lib/cosheaf
ENV COSHEAF_GIT_SHA=${COSHEAF_GIT_SHA}

WORKDIR /app

RUN mkdir -p /var/lib/cosheaf \
  && chown -R node:node /var/lib/cosheaf /app

COPY --from=build --chown=node:node /workspace/cosheaf/package.json ./package.json
COPY --from=build --chown=node:node /workspace/cosheaf/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/cosheaf/dist ./dist
COPY --from=build --chown=node:node /workspace/cosheaf/dist-server ./dist-server

USER node

EXPOSE 3030
VOLUME ["/var/lib/cosheaf"]

CMD ["node", "dist-server/server/index.js"]
