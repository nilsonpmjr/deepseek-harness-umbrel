# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim
ARG DSH_VERSION=0.2.2-rc.5

FROM ${NODE_IMAGE} AS builder

ARG DSH_VERSION

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    g++ \
    make \
    python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/dsh

RUN npm init -y >/dev/null 2>&1 \
  && npm install --omit=dev --no-audit --no-fund "@deepseek-ai/dsh@${DSH_VERSION}" \
  && npm cache clean --force \
  && /opt/dsh/node_modules/.bin/dsh --version

FROM ${NODE_IMAGE} AS runtime

ARG DSH_VERSION

LABEL org.opencontainers.image.title="DeepSeek Harness for Umbrel" \
      org.opencontainers.image.description="Self-contained multi-arch container running DeepSeek Harness Web UI behind Umbrel app_proxy" \
      org.opencontainers.image.source="https://github.com/nilsonpmjr/deepseek-harness-umbrel" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${DSH_VERSION}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    openssh-client \
    python3 \
    tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/dsh /opt/dsh
RUN ln -sf /opt/dsh/node_modules/.bin/dsh /usr/local/bin/dsh

COPY docker/entrypoint.mjs /app/entrypoint.mjs
COPY docker/umbrel-web.patch.yml /app/umbrel-web.patch.yml

RUN mkdir -p /data/dsh-home /data/workspace /data/home /data/shared \
  && chown -R 1000:1000 /data /app

ENV DSH_HOME=/data/dsh-home \
    HOME=/data/home \
    XDG_CONFIG_HOME=/data/home/.config \
    XDG_CACHE_HOME=/data/home/.cache \
    DSH_PROXY_HOST=0.0.0.0 \
    DSH_PROXY_PORT=3080 \
    DSH_BACKEND_PORT=3081 \
    DSH_UMBREL_APP_PROXY_AUTH=1 \
    DSH_WEB_PATCH_FILE=/app/umbrel-web.patch.yml \
    NODE_ENV=production

USER 1000:1000
WORKDIR /data/workspace

EXPOSE 3080

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3080/__health >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/entrypoint.mjs"]
