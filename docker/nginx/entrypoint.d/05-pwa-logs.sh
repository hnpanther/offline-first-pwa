#!/bin/sh
# Checks the logging setup before nginx starts, and says in one line where the logs are going.
#
# Run by the official image's /docker-entrypoint.sh (every executable *.sh in /docker-entrypoint.d,
# in order, before the templates are rendered at 20-…). A non-zero exit stops the container with
# the message below instead of letting nginx fail later with a less useful one.
#
# Three things are checked:
#   1. PWA_LOG_FORMAT is a format nginx.conf defines. Anything else would end in
#      `[emerg] unknown log format` after the templates were rendered.
#   2. If a directory is mounted at /var/log/nginx, uid 101 can write to it. Otherwise nginx stops
#      with `open() "/var/log/nginx/error.log" failed (13: Permission denied)`.
#   3. If log files already exist there, uid 101 can write to each one (a file left behind by an
#      earlier run as another user, or recreated by logrotate with the wrong owner).

set -eu

fmt="${PWA_LOG_FORMAT:-}"
case "$fmt" in
    main|json) ;;
    *)
        echo "FATAL: PWA_LOG_FORMAT must be 'main' or 'json', not '${fmt}'. Set it in docker/.env." >&2
        exit 1
        ;;
esac

dir=/var/log/nginx

# The image ships access.log and error.log as links to /dev/stdout and /dev/stderr. They are still
# there when nothing is mounted — and also when a NAMED volume was mounted, because Docker copies
# the image's contents into an empty named volume, links included. Both cases send the logs to
# `docker logs`, never to a file.
if [ -L "$dir/access.log" ]; then
    echo "logs: access log ($fmt) -> container stdout, error log -> stderr." \
         "To keep them as files, bind-mount a host directory at $dir (docker-compose.yml);" \
         "a named volume copies the image's links and changes nothing."
    exit 0
fi

me="$(id -u)"
if [ ! -w "$dir" ] || [ ! -x "$dir" ]; then
    echo "FATAL: $dir is not writable by uid $me." \
         "On the host: chown 101:101 <logs directory> && chmod 750 <logs directory>" >&2
    exit 1
fi
for f in "$dir/access.log" "$dir/error.log"; do
    if [ -e "$f" ] && [ ! -w "$f" ]; then
        echo "FATAL: $f exists and is not writable by uid $me." \
             "On the host: chown 101:101 $(basename "$f") in the logs directory (and fix" \
             "logrotate's 'create' line if it made it)." >&2
        exit 1
    fi
done

echo "logs: files in $dir — access.log ($fmt), error.log (text)."
