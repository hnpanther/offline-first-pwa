# syntax=docker/dockerfile:1
#
# The MFDCS PWA served by nginx: the static app, TLS, and the /api reverse proxy to Spring Boot.
#
# Packages the dist/ that `npm run build:apk` (or `npm run build:mobile`) already produced. It does
# not build the app itself, on purpose: the APK and dist/ must come from the same build, or the
# browsers and the tablets run different versions (CLAUDE.md, "One codebase, two deliveries").
#
# Build from the repository root (the context has to reach dist/):
#   docker build -f docker/Dockerfile -t mfdcs-pwa:<version> .
# or: docker compose -f docker/docker-compose.yml build
#
# Certificates and site overrides are NOT baked in. They are mounted at run time (docker/DEPLOY.md).

ARG NGINX_IMAGE=nginx:1.30-alpine
FROM ${NGINX_IMAGE}

ARG APP_VERSION=unknown
LABEL org.opencontainers.image.title="mfdcs-pwa" \
      org.opencontainers.image.description="MFDCS offline-first PWA behind nginx" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"

# Substitute only our own variables into the templates. Without the filter, any environment
# variable that happens to share a name with an nginx variable would be expanded too.
ENV NGINX_ENVSUBST_FILTER="^PWA_" \
    PWA_SERVER_NAME="_" \
    PWA_BACKEND_UPSTREAM="http://host.docker.internal:8081" \
    PWA_MAX_BODY_SIZE="32m"

# The stock site would answer on port 80 beside ours, and its sample pages would ship with the app.
RUN rm -f /etc/nginx/conf.d/default.conf /usr/share/nginx/html/*

COPY docker/nginx/nginx.conf                     /etc/nginx/nginx.conf
COPY docker/nginx/snippets/                      /etc/nginx/snippets/
COPY docker/nginx/templates/                     /etc/nginx/templates/
COPY dist/                                       /usr/share/nginx/html/

# Fail the build, not the deployment, when dist/ is not a production PWA build: a missing
# service worker means no offline mode, which is the reason this app exists.
RUN test -f /usr/share/nginx/html/index.html \
 && test -f /usr/share/nginx/html/sw.js \
 && test -f /usr/share/nginx/html/manifest.webmanifest \
 || (echo "dist/ is missing index.html, sw.js or manifest.webmanifest - run npm run build:apk (or build:mobile) first" >&2 && exit 1)

EXPOSE 80 443

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
