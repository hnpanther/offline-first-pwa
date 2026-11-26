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
#
# The digest as well as the tag: a tag can be pushed again, a digest cannot. Docker resolves by
# the digest and ignores the tag when both are given, so the tag is there for the reader. It
# needs the image to have been PULLED on the build machine; a base that arrived by `docker load`
# carries no registry digest, and that build must pass the tag alone:
#   --build-arg NGINX_IMAGE=nginx:1.30.6-alpine3.24
# Recorded 2026-11-16. When the base is moved to a newer build, change both halves together.
ARG NGINX_IMAGE=nginx:1.30.8-alpine3.24@sha256:8eb04fe3b385090e9aa02961f77398ad09b6bf33ab07f6669a5bb7acce22c0d3
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
    PWA_MAX_BODY_SIZE="64m" \
    PWA_LOGIN_RATE="60r/m" \
    PWA_LOGIN_BURST="30" \
    PWA_HSTS_MAX_AGE="31536000" \
    PWA_LOG_FORMAT="json" \
    PWA_ERROR_LOG_LEVEL="notice"

# Alpine security fixes published since the base image was built (an image scan lists every one
# of them as this image's). It cannot swap nginx: the official image pins nginx and each of its
# modules to an exact version in /etc/apk/world, and Alpine's own `nginx` package — a different
# build, with a different configuration layout — would otherwise replace it the day Alpine ships
# a newer one. The comparison fails the build if the version moves anyway.
#
# Then everything this site does not use is taken OUT. The official image is nginx for every
# purpose; this is a static site and one reverse proxy. Its five dynamic modules are installed
# but never loaded (there is no load_module anywhere in docker/nginx), and they are what pulls
# in libxml2, libxslt, libgd, libpng, libjpeg-turbo, libtiff, libwebp, libavif, the X11 client
# libraries, GeoIP and a JavaScript engine. curl is not used either: the HEALTHCHECK below is
# busybox's own wget. A package that is not installed cannot be vulnerable and cannot be listed
# by a scan — 71 packages become 20.
#
#   xslt, image-filter, geoip, njs, acme   the dynamic modules (and, with them, 43 libraries)
#   curl                                   + libcurl, c-ares, nghttp2, libidn2, libpsl
#   apk-tools                              the package manager itself, last: nothing is ever
#                                          installed into a running container, whose root
#                                          filesystem is read-only anyway. /lib/apk/db/installed
#                                          stays, so a scanner still sees exactly what is here.
#
# The checks fail the BUILD if nginx changed, if a removed piece is still present, or if the one
# tool the entrypoint needs to render the templates went with them.
RUN set -eux; \
    before="$(nginx -v 2>&1)"; \
    apk upgrade --no-cache; \
    apk del --no-cache \
        nginx-module-xslt nginx-module-image-filter nginx-module-geoip \
        nginx-module-njs nginx-module-acme curl; \
    apk del --no-cache apk-tools; \
    [ "$(nginx -v 2>&1)" = "$before" ]; \
    command -v envsubst; \
    # Tested as files, not with `command -v`: busybox ash remembers where it last found a
    # command, and answers "found" for apk in the very script that has just deleted it. And as
    # `[ ! -e … ]` rather than `! command`, because under `set -e` a command negated with `!`
    # never stops the script — the shorter spelling would be a check that cannot fail.
    [ ! -e /usr/bin/curl ]; \
    [ ! -e /sbin/apk ]; \
    [ -z "$(ls /usr/lib/nginx/modules/ 2>/dev/null)" ]; \
    [ -z "$(find / -xdev -perm /6000 -type f)" ]

# The stock site would answer on port 80 beside ours, and its sample pages would ship with the app.
RUN rm -f /etc/nginx/conf.d/default.conf /usr/share/nginx/html/*

COPY docker/nginx/nginx.conf                     /etc/nginx/nginx.conf
COPY docker/nginx/snippets/                      /etc/nginx/snippets/
COPY docker/nginx/templates/                     /etc/nginx/templates/
COPY dist/                                       /usr/share/nginx/html/

# Checks PWA_LOG_FORMAT and the log directory before nginx starts (the script says what and why).
# Into the official entrypoint's own hook directory, so nothing about the entrypoint changes.
# `sed` strips carriage returns: a Windows checkout with core.autocrlf would otherwise give the
# script a `#!/bin/sh\r` line, which does not run.
COPY --chmod=0755 docker/nginx/entrypoint.d/05-pwa-logs.sh /docker-entrypoint.d/05-pwa-logs.sh
RUN sed -i 's/\r$//' /docker-entrypoint.d/05-pwa-logs.sh

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
