# Deploying the PWA with Docker

This folder packages the **browser delivery** of MFDCS — the built PWA in `dist/` — behind
nginx, in one container: TLS, the static app with the right caching, security headers, and the
`/api/` reverse proxy to Spring Boot.

It does **not** contain the backend or PostgreSQL. They run where they run today; this container
only needs to reach the backend's port (§5).

| File | What it is |
|---|---|
| `Dockerfile` | `nginx:1.30-alpine` + your `dist/` + the config below. Builds nothing itself (§1) |
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
   build refuses a missing or `http://` value). It must equal `PWA_SERVER_NAME` below and appear
   in the certificate's subjectAltName.
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
docker build -f docker/Dockerfile --build-arg APP_VERSION=1.0.0 -t mfdcs-pwa:1.0.0 .
docker save mfdcs-pwa:1.0.0 | gzip > mfdcs-pwa-1.0.0.tar.gz
```

```bash
# server
gunzip -c mfdcs-pwa-1.0.0.tar.gz | docker load
```

Copy the `docker/` folder to the server as well (without `ssl/` and `.env` from the build
machine). Then set `PWA_IMAGE_TAG=1.0.0` in `.env` and start with `docker compose up -d`
(no `--build`: the image is already loaded, and compose uses it by name).

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

- **File permissions (Linux).** The container drops every capability except the few nginx needs,
  so its root user can no longer read a file it does not own. Give the key to root:

  ```bash
  sudo chown root:root ssl/key.pem ssl/cert.pem
  sudo chmod 600 ssl/key.pem && sudo chmod 644 ssl/cert.pem
  ```

  A key owned by your own user with mode 600 makes nginx exit with `Permission denied` on
  `key.pem`.
- **The CA's private key never goes in `ssl/`.** Only the server certificate and its key.

mkcert names its output `<name>+N.pem` and `<name>+N-key.pem`; rename or copy them to
`cert.pem` / `key.pem`.

---

## 5. Configure — `.env`

| Variable | Default | Meaning |
|---|---|---|
| `PWA_IMAGE_TAG` | `latest` | Image version to run. Set it to the release |
| `PWA_HTTP_PORT` | `80` | Host port for HTTP. Only redirects to HTTPS and answers `/healthz` |
| `PWA_HTTPS_PORT` | `443` | Host port for HTTPS. **Keep 443**: the HTTP→HTTPS redirect assumes it |
| `PWA_SERVER_NAME` | `_` | The name or IP tablets type; `_` accepts any |
| `PWA_BACKEND_UPSTREAM` | `http://host.docker.internal:8081` | Spring Boot, as seen **from inside the container**. Scheme, host, port; no `/api`, no trailing slash |
| `PWA_MAX_BODY_SIZE` | `32m` | Largest request forwarded. Must stay above the backend's 25 MB attachment limit |

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
| Security headers | CSP, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`. On **every** response — including locations that set their own caching, which nginx would otherwise strip |
| Client address | `X-Forwarded-For` is **overwritten** with the real peer, never appended. The backend records the first entry; appending would let any client choose the address the audit trail shows |
| Hardening | Read-only root filesystem, scratch paths on tmpfs, all capabilities dropped except `CHOWN`, `SETUID`, `SETGID`, `NET_BIND_SERVICE`, `no-new-privileges`, no server version in headers |
| Logs | Container stdout/stderr, rotated at 5 × 20 MB. `docker compose logs -f` |
| Health | `/healthz` on port 80, checked every 30 s; `restart: unless-stopped` |

### What the CSP changes

`connect-src 'self'` means the **browser** delivery can only talk to its own origin. That is the
point — an injected script cannot send readings elsewhere — and it has one visible consequence:
pointing Settings → Server URL at a **different** origin stops working in a browser tablet.
Production already uses the same origin (`VITE_SERVER_URL` = the nginx address), so nothing
changes there. The APK is not affected by anything in this file: it never loads a page from nginx.

**HSTS is deliberately not sent** — with a private CA and IP addresses it can strand a site that
has to fall back ([docs/roadmap.md](../docs/roadmap.md) §1).

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
| Log: `Permission denied` on `key.pem` | Key not readable by root without capabilities | `chown root:root`, §4 |
| Log: `host not found in upstream` | `PWA_BACKEND_UPSTREAM` unresolvable | §5 |
| `502 Bad Gateway` on `/api/` | Backend down or wrong port | `curl` the upstream from the host; check the WinSW service |
| `413 Request Entity Too Large` on an upload | Above `PWA_MAX_BODY_SIZE` | Raise it (and the backend's limit) |
| Tablets: «ارتباط با سرور برقرار نشد», browser shows a certificate error | Certificate not from the plant CA, expired, or address missing from SAN | §4 checks |
| APK fails, Chrome on the same tablet works | APK bundles a different CA | [docs/apk.md §5](../docs/apk.md) |
| Browser tablets still run the old version | A cached `sw.js` somewhere in between | `curl -sI …/sw.js` must say `no-cache`; check no other proxy caches it |
| Something blocked, console says "Content Security Policy" | A new resource origin | Report-only override (§10), then extend the snippet |
