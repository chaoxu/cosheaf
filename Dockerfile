# syntax=docker/dockerfile:1.7

FROM node:25-bookworm-slim AS base

ARG PNPM_VERSION=10.33.0
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /workspace

RUN npm install -g "pnpm@${PNPM_VERSION}"

FROM base AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ pkg-config rsync \
  && rm -rf /var/lib/apt/lists/*

COPY coflat-editor ./coflat-editor
COPY cosheaf ./cosheaf

RUN pnpm --dir coflat-editor install --frozen-lockfile
RUN pnpm --dir coflat-editor build

RUN pnpm --dir cosheaf install --frozen-lockfile --ignore-scripts
RUN pnpm --dir cosheaf rebuild better-sqlite3 esbuild
RUN pnpm --dir cosheaf build
RUN pnpm --dir cosheaf build:server
RUN cp cosheaf/server/schema.sql cosheaf/dist-server/server/schema.sql
RUN pnpm --dir cosheaf prune --prod --ignore-scripts

FROM node:25-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV COSHEAF_PORT=3030
ENV COSHEAF_DATA_DIR=/var/lib/cosheaf

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
