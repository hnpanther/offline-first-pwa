# Deploying the PWA with Docker

This folder packages the **browser delivery** of MFDCS — the built PWA in `dist/` — behind
nginx, in one container: TLS, the static app with the right caching, security headers, and the
`/api/` reverse proxy to Spring Boot.

It does **not** contain the backend or PostgreSQL. They run where they run today; this container
only needs to reach the backend's port (§5).

| File | What it is |
|---|---|
| `Dockerfile` | `nginx:1.30.6-alpine3.24` (pinned) + Alpine's newer security fixes + your `dist/` + the config below, running as uid 101 rather than root (§7). Builds nothing itself (§1) |
| `Dockerfile.dockerignore` | Keeps everything but `dist/` and `docker/nginx/` out of the build context — `certs/` holds the CA's private key and must never reach a layer |
| `docker-compose.yml` | The service, its volumes and its hardening |
| `.env.example` | Every setting. Copy to `.env` (gitignored) |
| `nginx/nginx.conf` | Process-wide nginx settings |
| `nginx/templates/default.conf.template` | The site: HTTP→HTTPS, TLS, static app, `/api/` proxy. `PWA_*` variables are filled in at start |
| `nginx/snippets/security-headers.conf` | CSP and the other security headers |

Not in git, created by you on the server: `ssl/` (certificate and key), `.env`, and optionally
`overrides/`.

The reasoning behind every nginx block is in [docs/deployment.md](../docs/deployment.md); this
file is the procedure.

---

## 1. Why the image does not build the app

`npm run build:apk` produces both deliveries from **one** build: `dist/` for nginx and the APK
for the tablets. The image copies that `dist/` rather than running its own `npm run build`,
because a second build would be a second version — the browsers and the tablets would then run
different code, which `CLAUDE.md` forbids ("One codebase, two deliveries").

So the order is always: build both, **then** build the image from the `dist/` that build left.

---

## 2. Before you build the image

On the build machine, from the repository root:

```bash
npm run build:apk          # or npm run build:mobile if only the browser build changed
```

Check three things — each one has already shipped wrong once in this project:

1. **`.env.mobile` holds the production address**, `https://`, the address tablets type (the
   build refuses a missing or `http://` value). It is the address a fresh **APK** install starts
   with, so it must appear in the certificate's subjectAltName. The browser delivery does not read
   it — a browser always talks to the origin it was opened from — so the same image serves any
   name or IP the certificate and DNS cover.
2. **`certs/rootCA.crt` is the plant's CA**, not this machine's own mkcert CA. Its subject must
   match the issuer of the certificate you will put in `ssl/` (§4). See
   [docs/apk.md §5](../docs/apk.md), *"Which CA ends up in the APK"*. Never run
   `setup:mkcert` on a build machine to "fix" a missing `certs/`.
3. **`dist/` is fresh**: `dist/sw.js` exists and its timestamp is from this build. The image build
   fails on purpose if `index.html`, `sw.js` or `manifest.webmanifest` is missing.

---

## 3. Build the image

Pick a version tag for every release; rollback is "run the previous tag" (§8).

### On the server, with the repository checked out

```bash
cd docker
cp .env.example .env                 # first time only; then edit it (§5)
docker compose build                 # tag comes from PWA_IMAGE_TAG in .env
```

### On another machine, for a server with no internet (the usual case in a plant)

Build where Docker Hub is reachable, then carry the image across:

```bash
# build machine, repository root
docker build --no-cache -f docker/Dockerfile --build-arg APP_VERSION=1.0.3 -t mfdcs-pwa:1.0.3 .
docker save mfdcs-pwa:1.0.3 | gzip > mfdcs-pwa-1.0.3.tar.gz
```

```bash
# server
gunzip -c mfdcs-pwa-1.0.3.tar.gz | docker load
```

Copy the `docker/` folder to the server as well (without `ssl/` and `.env` from the build
machine). Then set `PWA_IMAGE_TAG=1.0.3` in `.env` and start with `docker compose up -d`
(no `--build`: the image is already loaded, and compose uses it by name). **`PWA_IMAGE_TAG` is
required** since 1.0.2: compose refuses to start without it rather than running `latest`.

**The base image is pinned by digest** (`ARG NGINX_IMAGE` in the Dockerfile), so the build machine
must have **pulled** `nginx:1.30.6-alpine3.24`; a base that arrived by `docker load` has no
registry digest — build with `--build-arg NGINX_IMAGE=nginx:1.30.6-alpine3.24` then. `--no-cache`
is what makes a rebuild pick up Alpine's security updates; without it the `apk upgrade` layer comes
from the cache.

---

## 4. Certificates — the `ssl/` volume

nginx reads exactly two files, mounted read-only:

```text
docker/ssl/cert.pem   the server certificate (append intermediates, if any, below it)
docker/ssl/key.pem    its private key
```

Rules:

- **Issued by the plant's CA** — the CA bundled into the APK and installed on browser tablets.
  A certificate from any other CA is perfectly valid and trusted by nothing in the fleet; every
  tablet then fails with «ارتباط با سرور برقرار نشد», exactly like a dead network.
- **subjectAltName lists every name or IP tablets type.** Browsers ignore CN.
- **Check before you start nginx**:

  ```bash
  openssl x509 -in ssl/cert.pem -noout -subject -issuer -enddate -ext subjectAltName
  openssl x509 -in /path/to/plant/rootCA.pem -noout -subject      # must equal the issuer above
  ```

- **File permissions (Linux).** nginx runs as uid **101** — the image's own `nginx` user — and
  never as root, so the key must be readable by uid 101. The complete table, for `ssl/` and for
  `logs/` (§7a), is at the top of `docker-compose.yml`'s `volumes:`:

  ```bash
  sudo chown root:root ssl ssl/cert.pem && sudo chmod 0755 ssl && sudo chmod 0644 ssl/cert.pem
  sudo chown 101:101 ssl/key.pem && sudo chmod 0400 ssl/key.pem
  ```

  `0400` rather than the `0600` this guide used to give: nothing needs to write the key, and both
  work. Tested on 2026-11-17 against `mfdcs-pwa:1.0.3`, each with the image's own user:

  | `ssl/` | `cert.pem` | `key.pem` | Result |
  |---|---|---|---|
  | `root:root 0755` | `root:root 0644` | `101:101 0400` | starts — **the recommended setup** |
  | `root:root 0755` | `root:root 0644` | `101:101 0600` | starts |
  | `root:root 0755` | `root:root 0644` | `root:101 0440` | starts (read through the group) — equally good |
  | `root:101 0750` | `root:root 0644` | `101:101 0400` | starts |
  | `root:root 0755` | `root:root 0644` | `root:root 0600` | **exits**: `[emerg] cannot load certificate key … Permission denied` |
  | `root:root 0700` | `root:root 0644` | `101:101 0400` | **exits**: `[emerg] cannot load certificate … Permission denied` |
  | `root:root 0755` | `root:root 0600` | `101:101 0400` | **exits**: `[emerg] cannot load certificate … Permission denied` |

  A key left as `root:root 0600` — what most tools produce, and what this guide asked for before
  the image stopped running as root — makes nginx exit at start:
  `[emerg] cannot load certificate key "/etc/nginx/ssl/key.pem" … Permission denied`. The number is
  what counts; on the host, uid 101 may belong to an account with some other name. Nothing is
  given away by it: the worker processes that serve traffic hold the key in memory under any
  setup, root master or not.
- **The CA's private key never goes in `ssl/`.** Only the server certificate and its key.

mkcert names its output `<name>+N.pem` and `<name>+N-key.pem`; rename or copy them to
`cert.pem` / `key.pem`.

---

## 5. Configure — `.env`

| Variable | Default | Meaning |
|---|---|---|
| `PWA_IMAGE_TAG` | **none — required** | Image version to run, e.g. `1.0.3`. Compose refuses to start without it (it used to fall back to `latest`, which made "which build is running" unanswerable) |
| `PWA_HTTP_PORT` | `80` | Host port for HTTP. Only redirects to HTTPS and answers `/healthz` |
| `PWA_HTTPS_PORT` | `443` | Host port for HTTPS. **Keep 443**: the HTTP→HTTPS redirect assumes it |
| `PWA_SERVER_NAME` | `_` | The name(s) or IP tablets type, space-separated; `_` accepts any. Informational with the shipped template: it has one `server` block per port, and nginx hands a request whose name matches none to that block anyway, so this restricts nothing |
| `PWA_BACKEND_UPSTREAM` | `http://host.docker.internal:8081` | Spring Boot, as seen **from inside the container**. Scheme, host, port; no `/api`, no trailing slash |
| `PWA_MAX_BODY_SIZE` | `32m` | Largest request forwarded. Must stay above the backend's 25 MB attachment limit |
| `PWA_AUTH_RATE` | `60r/m` | How often **one client address** may call the four endpoints that need no session — sign-in, the device challenge, both enrolment calls. nginx syntax (`r/m`, `r/s`) |
| `PWA_AUTH_BURST` | `30` | How many of those may arrive at once before the rate applies. A sign-in is 2 requests from a browser, 4 from the APK (each call has a CORS preflight) |
| `PWA_HSTS_MAX_AGE` | `31536000` | Seconds a browser remembers "HTTPS only" for this name. `0` tells browsers that remember it to forget |
| `PWA_LOG_FORMAT` | `json` | Access log format: `json` (one object per line, for Filebeat → Logstash) or `main` (one line of text). Anything else stops the container at start, with a message. §7a |
| `PWA_TZ` | `Asia/Tehran` | Time zone of the log timestamps. They carry their offset either way (`+03:30`) |

**If every tablet reaches this server through one NAT address**, they share one rate-limit
bucket: a shift of thirty signing in within the same minute needs about 60–120 requests. Read the
access log at a shift change before trusting the defaults, and raise `PWA_AUTH_RATE` /
`PWA_AUTH_BURST` until it fits. A refused request gets `429` and the app shows «تعداد درخواست‌های
ورود از این دستگاه بیش از حد مجاز است…»; nothing else under `/api/` is limited.

Where the backend runs decides `PWA_BACKEND_UPSTREAM`:

| Backend | Value |
|---|---|
| On the Docker host (WinSW service or `java -jar`) | `http://host.docker.internal:8081` (compose maps the name to the host) |
| In a container on the same compose network | `http://<service-name>:8081` |
| On another machine | `http://<its-ip>:8081` |

nginx resolves this name **once, at start**. If it cannot be resolved, the container exits and
`docker compose logs` says `host not found in upstream`.

**Close 8081 to the network** once nginx fronts it: tablets and browsers only ever need 443. A
reachable 8081 bypasses TLS, the body-size limit and the address nginx records (backend
`docs/roadmap.md` §17).

---

## 6. Start and verify

```bash
cd docker
docker compose up -d
docker compose ps                     # STATUS must become "healthy" within ~30 s
docker compose logs --tail=50
```

Then, from a machine on the plant network:

```bash
curl -s  http://<server>/healthz                          # ok
curl -sI http://<server>/                                 # 301 → https://
curl -sI --cacert rootCA.pem https://<server>/            # 200, Content-Security-Policy present
curl -sI --cacert rootCA.pem https://<server>/sw.js       # Cache-Control: no-cache
curl -s  --cacert rootCA.pem https://<server>/api/health  # the backend answers through nginx
```

And on **one real tablet**, before walking away:

- the browser opens the app with no certificate warning, and it still opens with Wi-Fi off;
- the APK signs in (it trusts the CA bundled at build time, not the one installed on the device).

---

## 7. What the container does for you

| Concern | How |
|---|---|
| Offline after first load | `index.html`, `sw.js`, `workbox-*.js` and the manifest are `no-cache`; `/assets/` is cached a year (content-hashed names). Verified: the service worker installs and the app opens on a deep link with the network off |
| Unknown deep links | Fall back to `index.html` (client-side routes). A missing file under `/assets/` is a real 404, never HTML pretending to be JavaScript |
| Large media | 32 MB bodies; uploads and downloads stream through without temp files; 300 s proxy timeouts (the client allows 120 s) |
| Security headers | CSP, `Strict-Transport-Security` (since 1.0.2), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`. On **every** HTTPS response — including locations that set their own caching, which nginx would otherwise strip |
| TLS | 1.2 and 1.3 only. Since 1.0.2 TLS 1.2 offers only forward-secret AEAD suites (ECDHE with AES-GCM or ChaCha20-Poly1305); CBC-mode and static-RSA suites are refused |
| Sign-in rate limit | Since 1.0.2, per client address on the four endpoints that need no session (`PWA_AUTH_RATE`, `PWA_AUTH_BURST`); `429` with a Persian JSON message. The backend's own lockout stops guessing a password, not asking |
| What is in the image | Since 1.0.2, 19 Alpine packages (71 before): nginx's five dynamic modules (xslt, image-filter, geoip, njs, acme — none ever loaded), `curl` and the package manager are removed, and with them libxml2, libxslt, the image libraries and the X11 client libraries. The build fails if nginx's version moved or a removed piece is still there |
| Client address | `X-Forwarded-For` is **overwritten** with the real peer, never appended. The backend records the first entry; appending would let any client choose the address the audit trail shows |
| Hardening | Runs as uid 101 from start to finish — no root master process — and listens on 8080/8443 inside the container, published as the host's 80/443. No capabilities at all, read-only root filesystem, scratch paths on tmpfs owned by 101, `no-new-privileges`, no server version in headers |
| Resources | Sized for a 2 vCPU / 16 GB host: a 1 GB memory ceiling and 1.75 CPUs. nginx itself uses tens of megabytes, so the ceiling stops a leak rather than budgeting anything; the reasoning is beside the limits in `docker-compose.yml` |
| Logs | Since 1.0.3, **files on the host** in `docker/logs/` — `access.log` (`json` or `main`) and `error.log` — kept across container re-creation and rotated by the host's logrotate. Without that mount, container stdout/stderr as before. §7a |
| Health | `/healthz` on port 8080 inside the container (the host's port 80), checked every 30 s; `restart: unless-stopped` |

### Running as a non-root user

The image declares `USER 101:101`, so nothing in the container ever runs as root — the CIS Docker
Benchmark's check 4.1, which the earlier image failed because nginx's master process started as
root to bind ports 80 and 443. What follows from it:

| | Before | Now |
|---|---|---|
| Ports inside the container | 80, 443 | **8080, 8443** — a non-root process cannot bind below 1024 |
| Ports on the host | 80, 443 | 80, 443 — unchanged; compose publishes `80:8080` and `443:8443` |
| Capabilities | `CHOWN`, `SETUID`, `SETGID`, `NET_BIND_SERVICE` | **none** |
| `ssl/key.pem` | readable by root | **readable by uid 101** (§4) |
| Redirects nginx makes itself | absolute | **relative** (`absolute_redirect off`): an absolute one would name the port nginx listens on, 8443, not the 443 the client used |

**The one host step** is the key's ownership (§4). The tmpfs mounts are given to uid 101 by the
compose file itself.

**Upgrading a server from an image that ran as root:** `chown` the key first, and deploy the
`docker-compose.yml` from the same release as the image. The old file publishes the container's
port 80 and 443, where nothing listens any more — the container is healthy and the host port
refuses connections.

Verified on 2026-11-15 with the compose file's own settings: the master and every worker run as
`nginx`; PID 1's effective capabilities are `0000000000000000`; the image's healthcheck reports
healthy; the log has no permission, read-only, `emerg`, `crit` or `warn` line; envsubst renders the
site into the uid-101 tmpfs; HTTP redirects to `https://<host>/…` with no port; a directory
redirect is `Location: /assets/`; every security header is present; the manifest's type, the
service worker's `no-cache`, the deep-link fallback and the `/assets/` 404 behave as in the table
above; `docker stop` exits 0. End to end, `POST /api/auth/login` through this nginx to the
backend and its database answered 200.

### What the CSP changes

`connect-src 'self'` means the **browser** delivery can only talk to its own origin. That is the
point — an injected script cannot send readings elsewhere — and it has one visible consequence:
a browser tablet can never use a server on a **different** origin. The app is built around that:
a production bundle in a browser always calls its own origin, whatever `VITE_SERVER_URL` says, and
shows Settings → Server URL read-only. The same rule is why a **moved** site must keep serving its
old name until every browser tablet has synced there, rather than redirecting it: a redirected
`/api/` request is cross-origin, and this header refuses it. The APK is not affected by anything
in this file: it never loads a page from nginx.

### HSTS (since 1.0.2)

`Strict-Transport-Security: max-age=31536000` on every HTTPS response. After one visit the
browser rewrites `http://` to `https://` for this name before sending anything, and a certificate
error no longer has a "proceed anyway" button. Until 1.0.2 it was deliberately left out pending a
decision ([docs/roadmap.md](../docs/roadmap.md) §1); the site has taken it. What to know:

- **It does nothing for an IP address.** Browsers ignore the header when the address typed is an IP
  literal (RFC 6797 §8.1.1). Tablets that open `https://192.168.x.x` are unaffected either way.
- **It does nothing for the APK**, which never loads a page from nginx and already refuses
  cleartext.
- **The one way it hurts: an expired certificate becomes a hard stop** for every browser tablet
  that has seen the header, until the certificate is renewed (§9). Watch the expiry date.
- **To switch it off** for a fleet that has already seen it, set `PWA_HSTS_MAX_AGE=0` and keep it
  for a while: that tells each browser to forget. Removing the header alone does not.

### Verified on 2026-11-17 (1.0.2)

In front of a `logsheet-backend:1.0.2` container, with the compose file's hardening flags:
`/healthz` 200; HTTP → HTTPS 301 and no HSTS on plain HTTP; on HTTPS every security header
including HSTS, on `/`, `index.html`, `/assets/` (immutable), `sw.js` (no-cache), the manifest
(`application/manifest+json`) and the `429`; the deep-link fallback; sign-in, bootstrap and inbox
through nginx; `/api/auth/challenge` and the enrolment call reaching their handlers;
`X-Forwarded-For: 6.6.6.6` sent by the client recorded as the real peer; a photo uploaded and read
back byte for byte through nginx; **45 rapid sign-ins → 33 answered, 12 refused with the JSON 429**,
while `/api/health` and signed-in calls kept answering; TLS 1.0, 1.1, CBC and static-RSA suites
**refused** (1.0.1 accepted the last two), ECDHE-GCM, ChaCha20 and TLS 1.3 accepted; the CORS
preflight of the APK's sign-in answered with its `Access-Control-Allow-Origin`; `nginx -t` clean
and no warning in the log; compose refuses to start without `PWA_IMAGE_TAG`.

---

## 7a. Logs (since 1.0.3)

### Where they are

`docker-compose.yml` bind-mounts `docker/logs/` at `/var/log/nginx`, so nginx writes two ordinary
files on the host:

| File | What | Format |
|---|---|---|
| `logs/access.log` | one line per request (not `/healthz`) | `PWA_LOG_FORMAT`: `json` (default) or `main` |
| `logs/error.log` | start-up, warnings, rate-limit refusals, `reopening logs` | nginx's own text |

**Why files, not `docker logs`:** Docker keeps a container's output **with the container**, and
every `docker compose up -d` with a new image re-creates it — the previous version's logs went with
it. Files on the host survive that, are rotated by your own policy, and are what Filebeat follows.
`docker compose logs` now shows only the start-up lines, including one that says where the logs
are going:

```text
logs: files in /var/log/nginx — access.log (json), error.log (text).
```

**It must be a bind mount (a host path).** A *named* volume is filled from the image on first use,
and in this image `/var/log/nginx` holds two links — `access.log → /dev/stdout`,
`error.log → /dev/stderr` — so a named volume keeps sending everything to `docker logs` and never
writes a file. The start-up line says so when it happens. Remove the mount to go back to the
pre-1.0.3 behaviour.

### Owner and mode

```bash
cd docker
sudo mkdir -p logs && sudo chown 101:101 logs && sudo chmod 0750 logs
```

nginx creates the files itself (`101:101 0644`). Tested on 2026-11-17 against `mfdcs-pwa:1.0.3`:

| `logs/` | Result |
|---|---|
| `101:101 0750` | starts — **the recommended setup** |
| `101:101 0700` | starts (but Filebeat, if it runs as a non-root user, cannot enter) |
| `root:root 0755` | **exits before nginx starts**: `FATAL: /var/log/nginx is not writable by uid 101. On the host: chown 101:101 <logs directory> && chmod 750 <logs directory>` |
| `root:101 0770` | starts — **but logrotate refuses the directory** (`parent directory has insecure permissions`) and the logs then grow without limit. Keep `0750` |
| `0750`, with an `access.log` owned by `root` | **exits**: `FATAL: /var/log/nginx/access.log exists and is not writable by uid 101` |
| `0750`, `access.log` `101:101 0640` (what logrotate creates) | starts |

### The two formats

Both carry the same facts; switching changes the shape only.

`json` — one object per line, every value escaped (`escape=json`), so a User-Agent containing
quotes, backslashes or a tab stays on its own line and cannot forge another. Fields:

| Field | |
|---|---|
| `time` | ISO 8601 with offset, e.g. `2026-11-17T12:11:27+03:30` |
| `request_id` | nginx's 32-hex-digit id for the request — **also in the backend's log** (below) |
| `remote_addr`, `xff_in` | the real peer; and what the client *claimed* in `X-Forwarded-For` (never trusted — a non-empty value from a tablet is worth a look) |
| `host`, `server_port`, `method`, `uri`, `protocol` | `uri` includes the query string |
| `status`, `bytes_sent`, `body_bytes_sent`, `request_length`, `request_time` | numbers |
| `upstream_addr`, `upstream_status`, `upstream_response_time` | empty for a static file; for `/api/` they say whether a slow or failed request was the backend's |
| `limit_req_status` | `REJECTED` on a rate-limited sign-in, `PASSED` otherwise, empty where no limit applies |
| `ssl_protocol`, `ssl_cipher` | empty on plain HTTP — the evidence that only strong TLS is in use |
| `http_referer`, `http_user_agent` | |

`main` — one line of text with the same facts, for `tail -f`:

```text
172.18.0.1 - - [2026-11-17T12:11:57+03:30] "POST /api/auth/login HTTP/1.1" 200 5935 "-" "okhttp/4" rid=6609b8d9… host=pwa.example rt=0.220 ua=10.0.0.12:8081 us=200 urt=0.214 lim=PASSED tls=TLSv1.3/TLS_AES_256_GCM_SHA384
```

**Not in either, on purpose:** request bodies (the sign-in password) and the `Authorization` header
(the bearer token). Verified: neither appeared in a log that contained a sign-in.

**Switching the format** takes effect at the next start, and new lines are appended to the same
file — so for a while `access.log` holds both shapes, and a JSON reader trips on the text lines.
Rotate first (`sudo logrotate --force /etc/logrotate.d/mfdcs-pwa`), then restart.

**One request, both logs.** nginx sends its `request_id` to the backend as `X-Correlation-Id`, which
the backend puts on every log line of that request. Search the backend's `app.log` for the
`request_id` of a failed request and you have its whole story. A client's own `X-Correlation-Id`
is overwritten, so a tablet cannot choose what the backend's log says. Verified: the id in the
access log, the id in the backend's lines and the one in the response header were the same.

**A byte that is not UTF-8**, if a client sends one in a header, reaches the line unchanged —
nginx escapes quotes and control characters, not invalid UTF-8. The line is still one line and
still JSON in shape; configure the reader to replace invalid sequences rather than drop the line.

### Rotation — `docker/logrotate/mfdcs-pwa`

```bash
sudo cp logrotate/mfdcs-pwa /etc/logrotate.d/mfdcs-pwa
sudo chown root:root /etc/logrotate.d/mfdcs-pwa && sudo chmod 0644 /etc/logrotate.d/mfdcs-pwa
sudoedit /etc/logrotate.d/mfdcs-pwa          # the path on its first line: where docker/ lives here
sudo logrotate --force --verbose /etc/logrotate.d/mfdcs-pwa     # once, to see it work
```

Daily (and earlier at 200 MB), 30 rotations kept, compressed a day late, new files created
`0640` with the old file's owner, then `docker kill --signal=USR1 mfdcs-pwa` so nginx reopens its
files — no restart, nothing lost. The file's own comments say why each line is there. Tested on
2026-11-17 with logrotate 3.22 against a running `mfdcs-pwa:1.0.3`: the rotated file held only the
lines before the rotation and the new one only those after; the next rotation compressed it
(`gzip -t` clean); nginx logged `reopening logs` and stayed healthy. **The test found one mistake
and it is fixed:** logrotate wants *names* in `create mode owner group`, and refused `101 101`
with `unknown group '101'` — so the file gives the mode alone and the owner is copied.

### Size

Roughly 600 bytes a line in `json`, 400 in `main`. Fifty tablets syncing every 30 s plus their
uploads is in the order of a few hundred MB a day uncompressed at the busiest, a tenth of that
compressed. This is an estimate, not a measurement; look at `du -sh docker/logs` after the first
busy week and adjust `rotate`.

### Shipping to Logstash later

Filebeat on this host, reading `<docker>/logs/access.log` with the `ndjson` parser (or `main` with
a grok pattern) and `error.log` as plain lines. Point it at `access.log` only, not `access.log-*`:
Filebeat follows a renamed file by its inode, so a rotation loses nothing and reads nothing twice.
Filebeat runs as root on the host, so the `0750` directory is no obstacle.

---

## 8. Releasing a new version, and rolling back

```bash
# new release
npm run build:apk                                   # both deliveries, one build
docker build -f docker/Dockerfile --build-arg APP_VERSION=1.1.0 -t mfdcs-pwa:1.1.0 .
# (transfer if needed, §3) — then on the server: set PWA_IMAGE_TAG=1.1.0 in .env
docker compose up -d
```

- **Deploy outside shift hours.** Every browser tablet reloads itself a few seconds after it next
  opens the app, and anything typed but not yet saved in an open form is lost
  ([docs/roadmap.md](../docs/roadmap.md) §8). Saved readings are safe. The APK is unaffected.
- **Ship the APK from the same build** to the tablets that use it, or the two deliveries diverge.
- **Rollback** is `PWA_IMAGE_TAG=<previous>` and `docker compose up -d`. But a rollback is not
  symmetric with a deploy: if the new build added a Dexie version, tablets that already opened it
  cannot open their database with the old one, and the app refuses to start rather than delete
  unsynced work ([docs/storage.md](../docs/storage.md)). Check before rolling back across a schema
  change.
- Keep the last few image tags on the server (`docker image ls mfdcs-pwa`); prune older ones.

---

## 9. Renewing the certificate

The server certificate expires long before the CA (mkcert: about two years against ten).
Renewing it needs **no image rebuild and no APK rebuild**, provided it comes from the same CA:

```bash
# put the new cert.pem / key.pem in ssl/ (§4 rules, including the issuer check), then:
docker compose exec pwa nginx -t && docker compose exec pwa nginx -s reload
```

If the reload fails, the old certificate keeps serving. Fix and reload again. Write the next
expiry date in a calendar with months of warning — when it lapses, every tablet fails the same
morning. Issuing from the right CA: [docs/deployment.md § Renewal](../docs/deployment.md#renewal).

---

## 10. Changing the nginx configuration — the override volumes

Most needs are covered by `.env`. For anything else, mount your own copy instead of editing the
image, so the change survives the next release:

```bash
mkdir -p overrides/templates overrides/snippets
cp nginx/templates/default.conf.template overrides/templates/
cp nginx/snippets/security-headers.conf  overrides/snippets/
# edit them, then uncomment the matching lines under volumes: in docker-compose.yml
docker compose up -d
docker compose exec pwa nginx -t
```

- `overrides/templates/` replaces the site config. `PWA_*` variables are still substituted.
- `overrides/snippets/` replaces the headers. To diagnose a suspected CSP problem in the field,
  change `Content-Security-Policy` to `Content-Security-Policy-Report-Only` there: violations
  appear in the browser console and nothing is blocked. Put it back afterwards.
- `overrides/` is gitignored. When a release changes the shipped templates, compare your copy
  with the new one — an override freezes the old version of everything it replaces.

---

## 11. Notes for a Windows host

Docker Desktop runs Linux containers fine, with two differences worth knowing:

- **Client addresses are lost.** Docker Desktop's port forwarding presents every connection as
  coming from its own gateway, so the backend records the same IP for every tablet (sessions,
  audit). A Linux host keeps the real address. If per-device addresses matter (they feed
  [docs/roadmap.md](../docs/roadmap.md) §2), prefer Linux.
- Docker Desktop is licensed per company size, and it is not supported on Windows Server. The
  existing WinSW procedure in [docs/deployment.md](../docs/deployment.md) remains the supported
  way to run nginx on a Windows server.

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Container restarts, log: `cannot load certificate "/etc/nginx/ssl/cert.pem"` | `ssl/` empty or wrong names | §4 |
| Log: `Permission denied` on `key.pem` | Key not readable by uid 101 — nginx no longer runs as root | `chown 101:101 ssl/key.pem`, §4 |
| Container healthy, but the host's port 80/443 refuses connections | A `docker-compose.yml` older than the image, still publishing the container's 80/443 | Use the compose file from the same release: `80:8080`, `443:8443` (§7) |
| Log: `host not found in upstream` | `PWA_BACKEND_UPSTREAM` unresolvable | §5 |
| `502 Bad Gateway` on `/api/` | Backend down or wrong port | `curl` the upstream from the host; check the WinSW service |
| `413 Request Entity Too Large` on an upload | Above `PWA_MAX_BODY_SIZE` | Raise it (and the backend's limit) |
| Tablets: «ارتباط با سرور برقرار نشد», browser shows a certificate error | Certificate not from the plant CA, expired, or address missing from SAN | §4 checks |
| APK fails, Chrome on the same tablet works | APK bundles a different CA | [docs/apk.md §5](../docs/apk.md) |
| Browser tablets still run the old version | A cached `sw.js` somewhere in between | `curl -sI …/sw.js` must say `no-cache`; check no other proxy caches it |
| Something blocked, console says "Content Security Policy" | A new resource origin | Report-only override (§10), then extend the snippet |
