# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base

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
  && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ pkg-config rsync

# Coflat is sourced from the lab Gitea at the same pinned ref used by local
# setup/CI. Override COFLAT_GIT_REF explicitly for a deliberate Coflat bump.
# gitea.lab uses the lab internal CA, so the fetch skips TLS verification.
ARG COFLAT_GIT_REPO=https://gitea.lab/chaoxu/coflat.git
ARG COFLAT_GIT_REF=d913b1e7b1c71b6f3f94833f36eb7de2651dddc5

RUN echo "coflat ${COFLAT_GIT_REF}" \
  && git init coflat \
  && git -C coflat remote add origin "$COFLAT_GIT_REPO" \
  && git -C coflat -c http.sslVerify=false fetch --depth 1 origin "$COFLAT_GIT_REF" \
  && git -C coflat checkout --detach FETCH_HEAD

RUN --mount=type=cache,id=coflat-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm --dir coflat install --frozen-lockfile
RUN pnpm --dir coflat build

COPY package.json pnpm-lock.yaml ./cosheaf/
RUN --mount=type=cache,id=cosheaf-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm --dir cosheaf install --frozen-lockfile --ignore-scripts
RUN pnpm --dir cosheaf rebuild better-sqlite3 esbuild

COPY . ./cosheaf
ARG COSHEAF_GIT_SHA=unknown
RUN echo "cosheaf ${COSHEAF_GIT_SHA}"
RUN pnpm --dir cosheaf build
RUN pnpm --dir cosheaf build:server
RUN --mount=type=cache,id=cosheaf-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm --dir cosheaf prune --prod --ignore-scripts

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV COSHEAF_PORT=3030
ENV COSHEAF_DATA_DIR=/var/lib/cosheaf

WORKDIR /app

RUN --mount=type=cache,id=cosheaf-runtime-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=cosheaf-runtime-apt-lib,target=/var/lib/apt,sharing=locked \
  rm -f /etc/apt/apt.conf.d/docker-clean \
  && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache \
  && apt-get update \
  && apt-get install -y --no-install-recommends pandoc texlive-xetex texlive-latex-extra texlive-publishers texlive-science texlive-plain-generic lmodern \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /var/lib/cosheaf \
  && chown -R node:node /var/lib/cosheaf /app

COPY --from=build --chown=node:node /workspace/cosheaf/package.json ./package.json
COPY --from=build --chown=node:node /workspace/cosheaf/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/cosheaf/dist ./dist
COPY --from=build --chown=node:node /workspace/cosheaf/dist-server ./dist-server

ARG COSHEAF_GIT_SHA=unknown
ENV COSHEAF_GIT_SHA=${COSHEAF_GIT_SHA}

USER node

EXPOSE 3030
VOLUME ["/var/lib/cosheaf"]

CMD ["node", "dist-server/server/index.js"]
