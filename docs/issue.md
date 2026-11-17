# Open issues — review of 2026-11-16

A read-only review of this PWA and its backend
(`H:\Project\offline-first-project\backend-offline-first`) for **offline sync, data loss,
security, bugs and performance**, plus the production container image. The backend's half is in
that repository's `docs/issue.md`; the two files cross-reference each other by id (`P-nn` here,
`B-nn` there).

**How it was done, and what that means for trusting it.** By reading the code. Nothing was run:
no Vitest suite, no device, no build, no `npm audit`. Every entry names the file and line it was
read from. An entry that could not be confirmed from code alone says so.

**Nothing here has been fixed.** Each entry carries a proposed fix; none is applied. When one is,
`docs/sync.md`, `docs/storage.md` and `AGENTS.md` change in the same commit and the entry is
marked `Fixed` with the commit, not deleted.

## Summary

| Id | Severity | Kind | Title | Status |
|---|---|---|---|---|
| [P-01](#p-01) | High | Data loss | An expired draft's readings are never sent, and are deleted 24 h after the deadline | Open |
| [P-02](#p-02) | High | Data loss | A round completed after its deadline is never sent, and is deleted after 7 days | Open |
| [P-03](#p-03) | Medium | Data loss | `DUPLICATE` is trusted as "delivered" even when the server voided the work | Open |
| [P-04](#p-04) | Medium | Bug | Every failure of the submit batch is treated as a network blip, silently, forever | Open |
| [P-05](#p-05) | Medium | Data loss | A failed row is purged after 7 days whether or not the server holds its readings | Open |
| [P-06](#p-06) | Low | Bug | An upload answered 403 because its id is taken retries forever | Open |
| [P-07](#p-07) | Low | Bug | `toBatchPayload` invents an idempotency key it does not store | Open |
| [P-08](#p-08) | Low | Performance | The whole `logSheets` table is read several times per 30 s tick | Open |
| [P-09](#p-09) | Info | Security | What the device holds, and what protects it | Accepted, restated |
| [D-01](#d-01--nothing-limits-the-rate-of-login-attempts-medium) | Medium | Deployment | Nothing limits the rate of sign-in attempts | **Fixed in 1.0.2** |
| [D-02](#d-02--no-hsts-lowmedium) | Low–Medium | Deployment | No HSTS | **Fixed in 1.0.2** |
| [D-03](#d-03--the-cipher-list-is-nginxs-default-low) | Low | Deployment | Default cipher list (CBC on TLS 1.2) | **Fixed in 1.0.2** |
| [D-04](#d-04--the-upstream-is-clear-text-when-the-hosts-differ-medium-conditional) | Medium (conditional) | Deployment | nginx → backend is clear text across hosts | Open — a firewall rule on the backend host |
| [D-05](#d-05--body-size-disagrees-with-the-backend-low) | Low | Deployment | Body size disagrees with the backend | Open (needs P-04) |
| [D-06](#d-06--pinned-by-tag-default-tag-latest-low) | Low | Deployment | Base pinned by tag; compose defaults to `latest` | **Fixed in 1.0.2** |
| [D-07](#d-07--the-cas-private-key-is-the-root-of-trust-for-every-tablet-info) | Info → **High on the server** | Deployment | The CA's private key | **Open — found on the PWA server** by the security unit (report 6-4) |
| [D-08](#d-08--modules-and-packages-the-site-never-uses-low) | Low | Deployment | nginx modules and packages the site never uses | **Fixed in 1.0.2** |
| [D-09](#d-09--nginx-logs-are-lost-whenever-the-container-is-re-created-medium) | Medium | Deployment | nginx logs are lost whenever the container is re-created | **Fixed in 1.0.3** |

**Status on 2026-11-17.** `mfdcs-pwa:1.0.2` is built and verified (`docker/DEPLOY.md` § "Verified
on 2026-11-17"). It closes D-01, D-02, D-03, D-06 and D-08. **No application code changed** — the
image serves the same `dist/` as 1.0.1 — so P-01 … P-08 are all still open.

**P-01, P-02 and P-03 are one change across both repositories** with backend B-01, B-02 and
B-03. Do not ship the device half first: a device that starts sending late work to a server that
still discards it has gained nothing.

---

## P-01

**An expired draft's readings are never sent, and are deleted 24 hours after the deadline.**

*Where.*
- `src/services/sync/progressSync.ts:87` — `if (isLogSheetExpired(sheet)) return false`: an
  expired draft is not pushed.
- `src/services/sync/logSheetSync.ts` `expireStaleLocalDrafts` — marks an open draft `EXPIRED`
  on the device's own clock, with no server involved.
- `src/services/sync/cleanupLogSheets.ts:54` — an expired draft is deleted once
  `now − dueAt > 24h` (`EXPIRED_DRAFT_RETENTION_MS`); `deleteLogSheet` is a plain row delete,
  with no archive copy.
- Backend: a progress push after `due_at` is refused on the server clock (B-02).

*What.* An operator walks thirty of forty assets with no signal and reconnects after the
deadline. Every route is closed at once: the device will not push progress, the server would
refuse it, completion is impossible because the round is not complete, and a day later the row
— readings included — is gone. The only rescue is a supervisor extending the deadline *and*
this tablet pulling its inbox inside that day.

`docs/roadmap.md` §7 records the wrong-clock variant of this (a clock that is ahead deletes a
round the server still has open) and notes that it "breaks the first non-negotiable in
`CLAUDE.md`". It needs no wrong clock. A correct clock and a dead zone are enough.

*Fix.* In this order; each step is safe to ship without the next.

1. **Never hard-delete a row that still holds undelivered answers.** In
   `cleanupLocalLogSheets`, a sheet with any entry carrying `locallyEditedAt`, or with
   `sheetFormLocallyEditedAt`, is not eligible — whatever its age. That one condition removes
   the loss; everything below is about getting the data to the server.
2. **Send it once, late.** Let the progress lane push an expired draft whose markers are set.
   The server (B-02) answers `EXPIRED` with `kept: true` after storing the payload as a void row
   for the supervisor. On `kept`, clear the markers; the row then ages out under the ordinary
   rule. On `EXPIRED` without `kept` (an older server) keep the row and keep the markers.
3. **Archive before any delete that discards answers** — `archiveLocalWorkBeforeClear`, the
   function the takeover path already uses, so "بازیابی کارهای بایگانی‌شده" can show it.
4. **Use the server's clock for every deadline decision.** `serverTime` already arrives on
   `/api/bootstrap` and `/api/log-sheets/inbox` and "drives no decision" (roadmap §7). Store
   `offset = serverTime − Date.now()` at each pull and make `isLogSheetExpired`,
   `expireStaleLocalDrafts`, the `extended` test in `mergeInboxIntoLocalSheets` and the cleanup
   anchors read `Date.now() + offset`. Between pulls the offset is as good as the device's
   monotonic clock, which is what a battery-drained tablet still has.
5. **Say it on screen.** An expired round with undelivered readings shows "N قرائت به سرور
   نرسیده است" until step 2 clears it, not the same chip as an untouched expired round.

*Verify.* Vitest: a draft with marked entries and `dueAt` three days ago survives
`cleanupLocalLogSheets`; after a `kept` outcome it does not; a clock ten days ahead with a
stored offset does not expire an open round.

*Docs.* `docs/sync.md` (expiry, retention table), `docs/storage.md`, `AGENTS.md` retention
table (:437), `docs/roadmap.md` §7.

## P-02

**A round completed after its deadline is never sent, and is deleted after seven days.**

*Where.* `src/services/sync/index.ts:391`–405 (`markExpiredSheets` marks it `failed` /
`EXPIRED` locally), :432–440 (`getPendingLiveLogSheets` filters out
`isLogSheetExpiredForSync`), `cleanupLogSheets.ts` (`FAILED_RETENTION_MS`, seven days from
`submittedAt`).

*What.* The device mirrors the server's deadline rule "so it does not queue work the server is
certain to refuse". But the server's documented behaviour for that refusal is to **keep** the
payload as a void submission (backend `log-sheets.md` §6). By not sending, the device removes
the one chance the work had of being kept — and then deletes it. (The backend does not in fact
keep it today either; that is B-01.)

*Fix.*
1. Send a locally-expired completed round **once**. Outcome `EXPIRED` with `kept: true` → mark
   `failed` with the expiry message exactly as now, plus a stored `serverKeptAt`.
2. `markExpiredSheets` keeps marking the row for the UI, but no longer stands in for the
   server's answer: a row with no `serverKeptAt` stays in the outbound queue.
3. Retention follows P-05: only a row the server has confirmed it holds may be purged.

*Verify.* Vitest on `SyncManager`: a submitted sheet with `completedAt > dueAt` is in the batch
on the first pass and not on the second after a `kept` outcome.

## P-03

**`DUPLICATE` is trusted as "delivered" even when the server voided the work.**

*Where.* `src/services/sync/index.ts:226`–244.

*What.* The server answers `DUPLICATE` for any `clientActionId` it has seen — including one it
recorded while *voiding* the submission (B-03). So when the first attempt is voided and its
response is lost on a weak link, the retry is told `DUPLICATE`, and this branch marks the sheet
`synced`, sets `serverStatus: 'SUBMITTED'`, clears the edit markers and lets the 24-hour purge
take it. The operator sees a delivered round. The server holds a refused one.

*Fix.* The correction is the server's (B-03 makes the replay answer `SUPERSEDED`), and this
branch then does the right thing unchanged. Two things to do here anyway:

1. Do not write `serverStatus: 'SUBMITTED'` from a `DUPLICATE`. Leave `serverStatus` as it was
   and let the next bundle say what the sheet is — the bundle is the authority, and
   `applyLogSheetBundle` already reconciles it.
2. Until B-03 is deployed everywhere, treat a `DUPLICATE` for a sheet this device had marked
   `failed` with an ownership error as *unknown* rather than success: refresh the bundle before
   clearing anything.

## P-04

**Every failure of the submit batch is treated as a network blip, silently, forever.**

*Where.* `src/services/sync/index.ts:317`–325 — one `catch` for the whole pass, emitting
`{ type: 'error', failedCount: 0, transient: true }`.

*What.* A dropped connection and a `400`, a `413` or a persistent `500` all take the same path:
nothing is marked, nothing is shown, and the same body is sent again in thirty seconds. Three
ways to reach it:

- more than 500 pending items → the server's `400` for the whole batch;
- a body over nginx's `client_max_body_size` (32 MB; the backend allows 64 MB — D-05, backend B-16) →
  `413`;
- any server fault that is deterministic for this payload.

The backend already isolates each *item* in its own transaction so one bad sheet cannot fail the
others. This catch undoes that at the transport level: all pending work is sent in one request
with no chunking, so one oversized body blocks every sheet behind it.

*Fix.*
1. **Chunk.** Send at most N sheets per request (20 is plenty) *and* stop adding to a chunk past
   a byte budget (say 8 MB of serialised JSON). Results are already keyed by `localId`, so the
   loop over chunks needs no other change. This also removes the 500-item ceiling as something
   that can be hit.
2. **Classify.** `ApiError.status === 0`, `408`, `429`, `502`–`504` → transient, as now.
   `413` → halve the chunk and retry; a single sheet that is still too large is marked `failed`
   with a message that names it. Any other `4xx` / `500` → emit a non-transient error with the
   server's message, so the operator and the supervisor can see that sync is stuck and why.
3. Count consecutive non-transient failures and surface them on the sync indicator after three.

*Verify.* Vitest with a mocked `submitLogSheetsBatch`: 45 pending sheets → three calls; a `413`
on a chunk of 20 → retried as two of 10; a `400` → a visible error, rows left `pending`.

## P-05

**A failed row is purged after seven days whether or not the server holds its readings.**

*Where.* `src/services/sync/cleanupLogSheets.ts` — `FAILED_RETENTION_MS`, anchored on
`submittedAt`.

*What.* `failed` covers outcomes with very different meanings:

| Outcome | Does the server hold the readings? |
|---|---|
| `SUPERSEDED`, `CANCELLED` | Yes — a void row |
| `EXPIRED` | No (B-01), and with P-02 it was never sent |
| `VALIDATION_ERROR` | No — refused, awaiting the operator's correction |
| `ERROR` ("not found": the sheet was deleted on the server) | No, and it never can |

Seven days after `submittedAt` all of them are deleted alike. For the last three that is the
only copy.

*Fix.* Purge a `failed` row only when the server has said it holds the work (`kept`, or the
outcome is `SUPERSEDED` / `CANCELLED`). Everything else stays until the operator dismisses it
explicitly, after being offered the archive (`archiveLocalWorkBeforeClear`). Add the count of
such rows to `DeviceCheckPage` so a tablet being retired is checked for them.

## P-06

**An upload answered 403 because its id is taken retries forever.**

*Where.* `src/services/sync/attachmentSync.ts` — `isPermanentFailure` excludes 403 on purpose
(a shared tablet with the wrong person signed in). Backend B-10. *Read from code; not
reproduced.*

*What.* If another user has already uploaded a file under this attachment's id, the server's
idempotent branch answers 403 to the real owner on every pass. The row is neither delivered nor
parked.

*Fix.* Once B-10 answers a distinct `409` (`ATTACHMENT_ID_TAKEN`): mint a new id, rewrite the
reference in the entry's `formData` (and mark the entry edited so the next progress push carries
it), and retry. One retry per file; a second collision is parked with its reason.

## P-07

**`toBatchPayload` invents an idempotency key it does not store.**

*Where.* `src/services/sync/logSheetSync.ts:591` — `sheet.clientActionId ?? uuidv4()`.

*What.* The fill page sets the key at completion (`LogSheetFillPage.tsx:1044`), so this
fallback is rarely reached. When it is, each pass sends a fresh key, and the server's replay
check can never match — every retry of a voided submission writes another void row.

*Fix.* Persist it: if the sheet has none, `updateLogSheet(localId, { clientActionId })` before
building the payload (in `getPendingLiveLogSheets`, which is already async), and make
`toBatchPayload` throw on a missing key the way it does on a missing `serverId`.

## P-08

**The whole `logSheets` table is read several times per tick.**

*Where.* `src/services/sync/index.ts` — `markExpiredSheets`, `getPendingLiveLogSheets`,
`getPendingCount` (twice a pass), plus `cleanupLocalLogSheets` and the progress lane each call
`getAllLogSheets()`.

*What.* Each call deserialises every sheet with its full `entries` array — up to 300 assets a
sheet — on the main thread of a tablet that is also rendering a form. Five or six times every
thirty seconds. Fine for a dozen sheets; it is the first thing to feel slow on a tablet that
has been collecting for a week.

*Fix.* Read once per pass and hand the array down; for the queue, query the existing `status`
index (`db.logSheets.where('status').equals('submitted')`) instead of filtering in memory. If
`syncStatus` joins the index that is a Dexie version bump — do it together with another schema
change rather than alone.

## P-09

**Restated, not new: what the device holds, and what protects it.**

- The bearer token, the readings, captured media and (for a leased round) reference lists live
  in IndexedDB, unencrypted by the app. Protection is Android's storage encryption, the screen
  lock, `allowBackup="false"`, device enrolment and the CSP that keeps foreign script out.
- Nothing is in `localStorage` or `sessionStorage` (checked).
- The device key for enrolment is a non-extractable WebCrypto key, protected by the browser and
  not by hardware (backend roadmap §30).
- `navigator.storage.persist()` is requested at start-up (`main.tsx`); a `false` there means the
  browser may evict the database under pressure. **Worth surfacing on `DeviceCheckPage` as a
  warning rather than a fact** — on a tablet that is collecting video, eviction is a data-loss
  path this app cannot see coming.

---

# Container image

`docker/Dockerfile`, `docker/docker-compose.yml` and `docker/nginx/`. Verdict first: **this is a
well-hardened image** — an exact nginx-stable/Alpine pin, security upgrades at build with a
guard that fails the build if nginx itself moves, a non-root user from the first instruction,
unprivileged ports, an allow-list `.dockerignore` that keeps `certs/` (the CA's private key) and
`.env` files out of the build context, certificates mounted at run time rather than baked in,
and a compose file with a read-only root, tmpfs, `cap_drop: ALL` and `no-new-privileges`. What
follows is what is left.

## What is already right

| | |
|---|---|
| Base | `nginx:1.30.6-alpine3.24`, stable branch |
| User | `101:101` throughout; listens on 8080/8443 |
| Context | `*` then `!dist/`, `!docker/nginx/` |
| Secrets | none in any layer; `./ssl` mounted read-only |
| Runtime | `read_only`, tmpfs for the two paths nginx writes, `cap_drop: ALL`, `no-new-privileges`, memory and CPU limits |
| TLS | 1.2 and 1.3 only, session tickets off, HTTP redirects to HTTPS |
| Headers | CSP with `script-src 'self'`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, a `Permissions-Policy`; re-included in every location that sets a header of its own |
| Proxy | `/api/` only — the panel, `/integration/`, `/actuator` and Swagger are not reachable through it; `X-Forwarded-For` **overwritten**, not appended |
| Build guard | the build fails if `dist/` has no `index.html`, `sw.js` or manifest |
| Source maps | none in `dist/` |

## D-01 — nothing limits the rate of login attempts (Medium)

This proxy is the only place request volume can be bounded, and it is not. The backend locks a
username after five failures, which an attacker can use to keep any account locked (backend
B-06). **Fix**, in `nginx.conf` (`http {}`):

```nginx
limit_req_zone $binary_remote_addr zone=auth:10m   rate=20r/m;
limit_req_zone $binary_remote_addr zone=enrol:10m  rate=6r/m;
limit_req_status 429;
```

and in the template, above the general `/api/` location (each needs the same `proxy_*` lines —
put them in a snippet and include it in all three):

```nginx
location = /api/auth/login                           { limit_req zone=auth  burst=10 nodelay; include snippets/api-proxy.conf; }
location = /api/auth/challenge                       { limit_req zone=auth  burst=10 nodelay; include snippets/api-proxy.conf; }
location ^~ /api/devices/enrollment-requests         { limit_req zone=enrol burst=5  nodelay; include snippets/api-proxy.conf; }
```

Size the rate for the site: tablets behind one NAT share an address, so a shift change of thirty
operators must fit inside it. The login page must show a 429 as "too many attempts, wait" and
not as a wrong password.

**Fixed in 1.0.2**, as proposed with three refinements: one zone for all four endpoints (sign-in,
challenge, both enrolment calls), rate and burst configurable (`PWA_AUTH_RATE` 60/min,
`PWA_AUTH_BURST` 30), and the `429` returned as the backend's own JSON shape with a Persian
message — the app shows the server's `message`, so no client change was needed. The four
locations carry `proxy_pass` with **no URI** (AGENTS.md: an exact location with a URI rewrites the
whole path) and share `snippets/api-proxy.conf`. Measured: 45 rapid sign-ins → 33 answered, 12
refused; `/api/health` and signed-in calls unaffected throughout.

## D-02 — no HSTS (Low–Medium)

`security-headers.conf` has no `Strict-Transport-Security`. The HTTP listener redirects, but the
first request of every session can still be answered by whoever is on the path. **Fix:**

```nginx
add_header Strict-Transport-Security "max-age=31536000" always;
```

in the snippet (HTTPS server only). No `includeSubDomains` unless every host under the name
serves HTTPS; no `preload` for an internal name.

**Fixed in 1.0.2**, with the lifetime in `PWA_HSTS_MAX_AGE` (rendered from
`templates/hsts.inc.template`, pulled in by the snippet through a glob so a site that mounts its
own templates does not fail at start). `docker/DEPLOY.md` § "HSTS" records the two limits — no
effect for an IP address or the APK — and the cost: an expired certificate becomes a hard stop.

## D-03 — the cipher list is nginx's default (Low)

`ssl_protocols` is set and `ssl_ciphers` is not, so TLS 1.2 still offers CBC suites. **Fix:**
Mozilla's "intermediate" list (AEAD suites only), or drop TLS 1.2 altogether if every tablet's
WebView is recent — TLS 1.3 has no weak suite to configure.

**Fixed in 1.0.2** with the ECDHE-AEAD half of that list (the DHE suites would need a dhparam
file). Probed with `openssl s_client`: TLS 1.0, 1.1, `AES128-SHA`, `ECDHE-RSA-AES128-SHA` and
`ECDHE-RSA-AES256-SHA384` refused — 1.0.1 accepted the last three on 1.2; ECDHE-GCM, ChaCha20 and
TLS 1.3 accepted.

## D-04 — the upstream is clear text when the hosts differ (Medium, conditional)

`PWA_BACKEND_UPSTREAM` defaults to `http://host.docker.internal:8081`, which never leaves the
machine. Point it at another host and every password and token crosses the LAN unencrypted
between nginx and Spring. **Fix:** keep them on one host, or put that hop on a dedicated
interface / firewall rule that admits only the nginx host to 8081 (backend B-08). State the
condition in `docker/DEPLOY.md`.

## D-05 — body size disagrees with the backend (Low)

`PWA_MAX_BODY_SIZE=32m`; the backend parses JSON up to 64 MB. See P-04 / B-16. **Fix:** chunk
the batch; until then set both to the same number and document them as a pair.

## D-06 — pinned by tag, default tag `latest` (Low)

`nginx:1.30.6-alpine3.24` can be re-pushed; append `@sha256:…`. And `docker-compose.yml` falls
back to `mfdcs-pwa:latest` when `PWA_IMAGE_TAG` is unset, which makes "which build is running" a
question with no answer. **Fix:** `${PWA_IMAGE_TAG:?set PWA_IMAGE_TAG}` so compose refuses to
start without one. Scan the image on the build machine before it leaves
(`trivy image --severity HIGH,CRITICAL`) — `apk upgrade` means two builds of one commit can
differ.

**Fixed in 1.0.2:** `nginx:1.30.6-alpine3.24@sha256:901e593c…` (recorded 2026-11-16; a base that
arrived by `docker load` must be built with the tag alone, `docker/DEPLOY.md` §3), and
`PWA_IMAGE_TAG` is required — verified, compose stops with the message. The scan is still to do:
the security unit's reports contain no vulnerability scan of this image.

## D-07 — the CA's private key is the root of trust for every tablet (Info)

`certs/` is git-ignored and excluded from the build context — good. But the APK trusts the CA
whose key sits in that directory on a developer's machine
(`network_security_config.xml`, `@raw/plant_ca`). Whoever has that key can impersonate the server
to every tablet. **Fix:** keep the CA key offline (a removable medium, or the plant's own PKI),
issue the server certificate from it, and keep only `cert.pem` / `key.pem` for the server name
on the nginx host, readable by uid 101 and nobody else.

**The security unit found exactly this on the PWA server (report 6-4, 2026-11-17)**, which makes
it High rather than Info: `tempssl-gen/localCA.key` (the CA key) and `tempssl-gen/nginx.key` (a
second copy of a server key) sit on the host beside `mfdcs/ssl/key.pem`. **What to do, on the
server:** move `localCA.key` to offline storage (encrypted removable media, kept with whoever
issues certificates) and delete it from the host; delete the whole `tempssl-gen/` directory with
`shred -u`; keep `mfdcs/ssl/key.pem` — it is nginx's own TLS key and must be there — owned by
uid 101 with mode `0400`, and report it to the security unit as the one key that has to exist.
None of the three is inside the image (verified: no `.key`, `.pem`, `.env` or source map in it).

## D-08 — modules and packages the site never uses (Low)

The official image is nginx for every purpose: five dynamic modules (xslt, image-filter, geoip,
njs, acme) installed but never loaded — there is no `load_module` anywhere in `docker/nginx` —
which pull in libxml2, libxslt, libgd, libpng, libjpeg-turbo, libtiff, libwebp, libavif, GeoIP, a
JavaScript engine and the X11 client libraries; plus `curl` and the package manager.

**Fixed in 1.0.2**: all removed, 71 packages → 19. The health check is busybox's own `wget`;
`envsubst`, which the entrypoint needs to render the templates, stays; nginx's version is checked
unchanged. The build fails if anything removed is still present. No setuid file before or after.

## D-09 — nginx logs are lost whenever the container is re-created (Medium)

nginx logged only to the container's stdout, which Docker keeps **with the container** (5 × 20 MB):
every `docker compose up -d` with a new image re-created it and took the previous version's access
log with it, and a busy week overflowed the cap anyway. Nothing could be handed to Logstash later
because nothing was kept. The text format also lacked what an investigation needs — which request
reached the backend, how long the backend took, which TLS was used, whether a sign-in was
rate-limited — and had no way to find the same request in the backend's log.

**Fixed in 1.0.3** (`docker/DEPLOY.md` §7a): files on the host (`docker/logs/`, a bind mount),
`PWA_LOG_FORMAT=json|main`, 22 fields including the upstream, TLS and rate-limit status, nginx's
`request_id` sent to the backend as `X-Correlation-Id` so one id finds the request in both logs, a
start-up check with a precise message for every wrong owner or mode, and `docker/logrotate/mfdcs-pwa`
(USR1 reopen, no `copytruncate`). Every owner/mode row in `docker-compose.yml` and the rotation were
tested against the running image. The backend image is unchanged: it already accepted
`X-Correlation-Id`.

---

# Not reviewed

- `LogSheetFillPage.tsx` and the form components beyond the lines cited;
- `mergeLogSheetBundle.ts` and `logSheetWorkflow.ts` in detail — the merge rules were read at
  the level of `applyLogSheetBundle`, not proved;
- restore of archived work, the lookup lease, NFC and QR scanning, media capture;
- the Android project beyond the manifest and the network security config;
- dependency advisories — run `npm audit --omit=dev` on a machine with internet;
- anything that needs a device: storage eviction, behaviour under a real weak link, timings.
