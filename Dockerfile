# syntax=docker/dockerfile:1.7

ARG COSHEAF_RUNTIME_BASE=node:24-bookworm-slim

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build-base

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

FROM build-base AS build

ARG COSHEAF_BUILD_DEPS=full
RUN --mount=type=cache,id=cosheaf-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=cosheaf-apt-lib,target=/var/lib/apt,sharing=locked \
  rm -f /etc/apt/apt.conf.d/docker-clean \
  && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache \
  && if [ "$COSHEAF_BUILD_DEPS" = "full" ]; then \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ pkg-config rsync; \
  elif [ "$COSHEAF_BUILD_DEPS" = "rsync" ]; then \
    apt-get update \
    && apt-get install -y --no-install-recommends rsync; \
  elif [ "$COSHEAF_BUILD_DEPS" = "none" ]; then \
    true; \
  else \
    echo "invalid COSHEAF_BUILD_DEPS=$COSHEAF_BUILD_DEPS" >&2; \
    exit 2; \
  fi

# Coflat is sourced from the lab Gitea at the same pinned ref used by local
# setup/CI. Override COFLAT_GIT_REF explicitly for a deliberate Coflat bump.
# gitea.lab uses the lab internal CA, so the fetch skips TLS verification.
ARG COFLAT_GIT_REPO=https://gitea.lab/chaoxu/coflat.git
ARG COFLAT_GIT_REF=95df1488ea6a56bef0524530ca98f37ac7e7ea54

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
RUN pnpm --dir cosheaf rebuild esbuild

COPY vite.config.ts tsconfig.json ./cosheaf/
COPY src ./cosheaf/src
COPY shared ./cosheaf/shared
COPY public ./cosheaf/public
RUN pnpm --dir cosheaf build

COPY server ./cosheaf/server
COPY scripts/check-server-build-output.mjs ./cosheaf/scripts/
RUN pnpm --dir cosheaf build:server
ARG COSHEAF_GIT_SHA=unknown
RUN echo "cosheaf ${COSHEAF_GIT_SHA}"

FROM --platform=$TARGETPLATFORM node:24-bookworm-slim AS deps-base

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

FROM deps-base AS prod-deps

COPY --from=build /workspace/coflat/package.json ./coflat/package.json
COPY --from=build /workspace/coflat/dist ./coflat/dist
COPY --from=build /workspace/coflat/patches ./coflat/patches
COPY package.json pnpm-lock.yaml ./cosheaf/
RUN --mount=type=cache,id=cosheaf-pnpm-store-prod,target=/pnpm/store,sharing=locked \
  pnpm --dir cosheaf install --prod --frozen-lockfile --ignore-scripts
RUN pnpm --dir cosheaf rebuild better-sqlite3

FROM ${COSHEAF_RUNTIME_BASE} AS runtime

ARG COSHEAF_RUNTIME_DEPS=install

ENV NODE_ENV=production
ENV COSHEAF_PORT=3030
ENV COSHEAF_DATA_DIR=/var/lib/cosheaf

USER root
WORKDIR /app

# Cross-architecture builds on jupiter use QEMU for Pluto's amd64 image.
# Keep the heavy apt phases serial; concurrent emulated dpkg runs have failed
# with transient shared-library mapping errors.
COPY --from=build /workspace/cosheaf/package.json /tmp/.cosheaf-build-complete

RUN --mount=type=cache,id=cosheaf-runtime-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=cosheaf-runtime-apt-lib,target=/var/lib/apt,sharing=locked \
  if [ "$COSHEAF_RUNTIME_DEPS" = "install" ]; then \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache \
    && apt-get update \
    && apt-get install -y --no-install-recommends pandoc texlive-xetex texlive-latex-extra texlive-publishers texlive-science texlive-plain-generic lmodern \
    && rm -rf /var/lib/apt/lists/*; \
  elif [ "$COSHEAF_RUNTIME_DEPS" = "skip" ]; then \
    true; \
  else \
    echo "invalid COSHEAF_RUNTIME_DEPS=$COSHEAF_RUNTIME_DEPS" >&2; \
    exit 2; \
  fi

RUN rm -rf /app/* /app/.[!.]* /app/..?* \
  && mkdir -p /var/lib/cosheaf \
  && chown -R node:node /var/lib/cosheaf /app

COPY --from=prod-deps --chown=node:node /workspace/cosheaf/package.json ./package.json
COPY --from=prod-deps --chown=node:node /workspace/cosheaf/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/cosheaf/dist ./dist
COPY --from=build --chown=node:node /workspace/cosheaf/dist-server ./dist-server

ARG COSHEAF_GIT_SHA=unknown
ARG COFLAT_GIT_REF=unknown
ENV COSHEAF_GIT_SHA=${COSHEAF_GIT_SHA}
ENV COFLAT_GIT_REF=${COFLAT_GIT_REF}

USER node

EXPOSE 3030
VOLUME ["/var/lib/cosheaf"]

CMD ["node", "dist-server/server/index.js"]
