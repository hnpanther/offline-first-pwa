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
#
# nginx runs as the image's own `nginx` user (uid 101) from the first instruction to the last — no
# root master process — so it listens on 8080/8443 inside the container and compose publishes
# those as the host's 80/443. Nothing changes for a tablet or a browser. What the host has to do
# about it is in docker/DEPLOY.md § "Running as a non-root user": the TLS key must be readable by
# uid 101, and nothing else.

# Pinned to the exact nginx build and Alpine release, not `1.30-alpine`, which moves with every
# upstream release: this line is the answer to "which nginx is in production". 1.30 is nginx's
# STABLE branch; mainline (1.31) gets new code every few weeks and this site uses none of it.
ARG NGINX_IMAGE=nginx:1.30.6-alpine3.24
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

# Alpine security fixes published since the base image was built (an image scan lists every one
# of them as this image's). It cannot swap nginx: the official image pins nginx and each of its
# modules to an exact version in /etc/apk/world, and Alpine's own `nginx` package — a different
# build, with a different configuration layout — would otherwise replace it the day Alpine ships
# a newer one. The comparison fails the build if the version moves anyway.
RUN set -eux; \
    before="$(nginx -v 2>&1)"; \
    apk upgrade --no-cache; \
    [ "$(nginx -v 2>&1)" = "$before" ]

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

# The two places nginx writes, handed to uid 101: the rendered site (the entrypoint's envsubst
# step writes conf.d/default.conf at every start) and the temp-file directories. The pid file
# goes to /tmp (nginx.conf). Everything else — the app, the configuration, the templates — stays
# owned by root and is only read. docker-compose.yml mounts tmpfs over these two with the same
# owner, for the read-only root filesystem; this line is what makes a plain `docker run` work too.
RUN chown -R 101:101 /var/cache/nginx /etc/nginx/conf.d

USER 101:101

# Unprivileged ports, because a non-root process cannot bind below 1024. The base image's own
# EXPOSE 80 is inherited metadata and cannot be removed; nothing listens there.
EXPOSE 8080 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
