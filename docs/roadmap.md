# Roadmap — decisions deferred, with the facts they rest on

> **Nothing in this file is implemented.** Every other document under `docs/` describes the system
> as it is; this one describes work that has been thought through and not done. Keep the
> separation — a reader who cannot tell the two apart will trust a design as if it were behaviour,
> which is exactly the failure the documentation rule in `CLAUDE.md` exists to prevent.
>
> When one of these is built, move the content into the reference document it belongs to
> (`deployment.md`, `apk.md`, `sync.md`) and delete the section here.

Each section records the **facts about the current system** that the decision depends on. Those
facts are the part most worth keeping: a design can be re-argued cheaply, a constraint established
by reading five files and a built APK cannot.

The backend keeps its own, with the same convention:
[`backend-offline-first/docs/roadmap.md`](../../JavaProject/backend-offline-first/docs/roadmap.md).

---

# 1. Hardening what nginx serves

*Raised as: "someone could break into the nginx server and change the files it serves — can the
backend check they are intact?"*

The concern is sound, and unlike §3 it is **tractable**, because here the device is honest and the
server is the problem.

## What is true today

| Fact | Where |
|---|---|
| The **systemd and WinSW** nginx configs set **no security headers at all**: every `add_header` in them is `Cache-Control`. The **Docker** deployment does set them, built and verified on 2026-10-21 (CSP with `connect-src 'self'`, `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`). The service worker installs under that CSP and the app opens offline | [deployment.md](deployment.md), [docker/DEPLOY.md §7](../docker/DEPLOY.md) |
| `dist/index.html` carries **no `integrity` attributes** — Vite does not emit SRI by default | verified against a real build |
| The service worker is `registerType: 'autoUpdate'` with `skipWaiting: true` and `clientsClaim: true` | `vite.config.ts` |
| Therefore a deploy reaches the whole browser fleet **within minutes, with no user action** | [deployment.md § Publishing a new build](deployment.md#publishing-a-new-build) |
| The APK **bundles** its web assets and fetches none of them | [apk.md §4](apk.md) |
| The API client sends a bearer token explicitly; CORS runs with `allowCredentials: false` | `services/api/client.ts`, backend `CorsConfig` |

## The amplification worth stating plainly

The same mechanism that makes deployment painless makes a compromise automatic: **modify
`dist/` on nginx and every browser-based tablet is running that code within minutes**, with no
prompt and nothing for an operator to notice. `deployment.md` already names this as the reason to
check one tablet before walking away; it is also the reason this section exists.

**It does not reach the APK.** Packaged assets are not fetched, so a compromised nginx can alter
what the browsers run and not what the app runs. That asymmetry is worth holding on to when
choosing which delivery a given tablet gets.

## Why the client cannot be the one to check

A page that has already loaded possibly-tampered JavaScript cannot be trusted to report on it —
tampered code answers "intact". **Any integrity check has to run somewhere the attacker has not
already reached**: on the nginx host, on the backend, or from a third machine.

## The options, cheapest first

1. **Security headers, starting with CSP.** A `connect-src` restricted to the app's own origin
   stops an injected script exfiltrating readings to a second destination — the browser refuses
   the request. It does nothing against a rooted device (§3), which controls the browser itself,
   but it is the cheapest real control here. **Built for the Docker deployment**
   (`docker/nginx/snippets/security-headers.conf`); still open for the systemd and WinSW configs,
   which can include the same snippet.
   Add `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY` in the same pass.
   **HSTS deliberately excluded**: with a private CA and IP-based URLs it buys little and can
   strand a site that has to fall back, so it needs its own decision rather than riding along.
2. **File integrity monitoring on the nginx host.** Hash the `dist/` tree at build time, store the
   manifest, re-hash on a timer on the host and alert on drift. This is the honest version of
   "can the backend check the files are intact" — the backend can *hold* the expected hashes;
   something outside the browser has to *do* the comparison.
3. **A read-only web root**, with the deploy identity separate from the nginx runtime identity.
   Removes the easiest path from "a process was compromised" to "the served files changed".
4. **Subresource Integrity on the build output.** Makes a modified JS chunk fail to execute. Narrow
   but real: an attacker who can also rewrite `index.html` simply rewrites the hashes, so this
   shrinks the attack surface to `index.html` and `sw.js` rather than closing it.

## What would make it urgent

Any of: the nginx host becoming reachable from a wider network than the plant floor; the web root
becoming writable by a process that also handles untrusted input; or the fleet growing past the
point where "check one tablet after deploying" is a real check rather than a habit.

---

# 2. Noticing a session that is behaving oddly

*The detection half of §3 — and the only part of that problem with a cheap answer.*

## What is true today

| Fact | Where |
|---|---|
| `api_sessions` already records `ip_address`, `user_agent`, `device_label` and `last_seen_at` per session | backend `ApiSession` |
| JWTs are **stateful**: the `jti` must match a live row **belonging to the `uid` in the token** | backend [security.md §8](../../JavaProject/backend-offline-first/docs/security.md) |
| The token carries **no roles or permissions** — authorities are read from the database on every request | same |
| **One device per user**; a new login supersedes the previous session, with the reason recorded | same |
| Deactivating or deleting a user closes live sessions immediately | same |
| `api_key_usage` logs one row per request on the **integration** chain, including refusals | same |

## What is missing

Nothing *records* less than it should — the columns above are populated. What does not exist is
anything that **reads them and complains**: one user seen from two addresses, a session whose IP
changes mid-shift, a `last_seen_at` pattern that does not look like a person walking a round.

This is worth separating from §1 and §3 because it is the only one of the three that needs no new
trust machinery, no device support and no change to how the app is delivered — only a query and
somewhere to send the result.

## Where it would go

The backend, beside the existing session registry — not here. Recorded in this file because it is
the mitigation the PWA and APK threat discussion lands on, and because the facts above were
established while answering that question.

---

# 3. Proving a tablet is running the real app

*Raised as: "someone could root a tablet, change the app so data is also sent somewhere else —
can the device prove it has the version that matches the server?"*

**Recorded largely so that it is not re-attempted.** The direct form of this request cannot be
satisfied, and the reason is structural rather than a gap in this codebase.

## Why the client cannot answer it

A device under an attacker's control cannot attest to its own integrity: whatever check the app
performs, the attacker patches out or feeds a false answer to. Verification has to rest on
something the device's operator does not control, which means hardware.

| Mechanism | Viability here |
|---|---|
| **Play Integrity API** | **Unavailable.** It verifies against Google's servers at call time, and these tablets have no route off the plant network |
| **Hardware key attestation** (Android Keystore) | **Technically possible offline** — the certificate chain validates locally against a bundled Google root, and the attestation record carries `verifiedBootState` and `deviceLocked`, which a rooted device fails |

## Why even the viable one is not obviously worth it

- It covers the **APK only**. The browser-delivered PWA has no equivalent, so a mixed fleet is only
  half covered.
- Attestation quality on low-cost industrial tablets is uneven, and some ship with an unlocked
  bootloader, which fails the check from day one for reasons that have nothing to do with an
  attacker.
- It is a native plugin plus server-side chain validation — a large piece of work against a threat
  whose blast radius is already bounded (below).

## What bounds the damage today, and is the actual defence

| Fact | Where |
|---|---|
| There is **no full master-data pull** — a device holds only the bundles for its own sheets | [sync.md](sync.md), `AGENTS.md` |
| Scope is enforced **server-side** from the database, never from a claim in the token | backend [security.md](../../JavaProject/backend-offline-first/docs/security.md) |
| Outbound sync carries **only the signed-in operator's own work**, on every queue | `AGENTS.md` § Critical invariants |
| A forged token cannot grant authority, impersonate another user, or outlive its session row | backend [security.md §8](../../JavaProject/backend-offline-first/docs/security.md) |

So the reachable loss from one rooted tablet is **that operator's own scope** — which is what the
architecture was built to guarantee, and it holds.

## Where this belongs instead

With device management, not application code: MDM and kiosk mode, a locked bootloader, OEM
unlocking disabled. Those are the controls that make rooting hard; an app cannot make it
detectable from the inside.

Two refinements that *would* add a property, and what each is actually worth:

- **Token binding** (a key in the device's hardware keystore, each request signed with it) closes
  **token theft** — an exfiltrated JWT is useless on another device. It does **not** close a rooted
  device, which can ask its own keystore to sign. Worth knowing the distinction before anybody
  buys the work expecting more.
- **§2's anomaly detection**, which is cheaper than either and is the part that would actually
  surface an incident.

## One idea that was considered and does not work

*"nginx issues an id when it serves the app, tells the backend that id is authorised, and rotates
it periodically."*

Four reasons it adds no security property:

1. **It binds to nothing.** Whatever nginx hands the page, the page's JavaScript can read — and so
   can anyone who controls the device (§3) or nginx (§1). It is a bearer token with exactly the
   properties the JWT already has.
2. **The APK never receives a served page at all** — its assets are bundled, and nginx only
   proxies its API calls. There is nothing for the mechanism to attach to.
3. **It breaks offline-first.** A credential that rotates on a timer expires mid-shift on a tablet
   that is deliberately out of contact for hours, and the queued readings then cannot be delivered.
   That contradicts the first invariant in `CLAUDE.md`.
4. **It duplicates `api_sessions`**, which already does stateful sessions with revocation, expiry
   and per-session IP and user-agent recording.

The existing JWT *is* "an id the backend recognises, which expires and can be revoked". A second
issuer in front of it adds moving parts without adding an answer.

---

# 4. User-visible text that does not live in `fa.ts`

*Found in a full review on 2026-10-15. Nothing has been moved yet.*

`CLAUDE.md` makes it a non-negotiable that all UI text is Persian and lives in `src/i18n/fa.ts`.
The code does not fully keep that rule.

## What is true today

| Fact | Where |
|---|---|
| About **145** Persian string literals sit outside `fa.ts` and outside comments and tests, in **29** files | `grep -P` for Arabic-script literals over `src/`, excluding `i18n/fa.ts`, `*.test.ts` and comment lines |
| The worst files are `utils/logSheetStatus.ts` (26), `pages/LogSheetFillPage.tsx` (24), `pages/LogSheetListPage.tsx` (11), `components/forms/DynamicClassForm.tsx` (9), `utils/mediaPermissions.ts` (8), `services/api/client.ts` (8), `utils/mediaCapture.ts` (7) | same scan |
| Some messages mix English nouns into the Persian text: «Log Sheet یافت نشد», «Asset مربوط به تگ … وجود ندارد» | `LogSheetFillPage.tsx` |
| `SYNC_OUTCOME_MESSAGES` is **stored**, not only displayed. It is written into `logSheets.syncError` and later **compared by value**: `local.syncError === SYNC_OUTCOME_MESSAGES.EXPIRED` in `mergeInboxIntoLocalSheets` | `utils/logSheetStatus.ts`, `services/sync/logSheetSync.ts` |
| The one in `main.tsx` is deliberate: the database-failure screen is plain DOM and must not depend on anything that could itself be broken | `main.tsx`, AGENTS.md |

## The trap in moving them

Moving a string into `fa.ts` is mechanical. **Changing its wording is not**, for any message that is
persisted. Rows already on tablets hold the old text. A comparison against new text then fails, so a
sheet rejected as `EXPIRED` stops being recognised and is no longer re-queued when the device can
prove it finished in time. Any such move must keep the text byte-identical, or it must also move the
comparison onto `serverStatus` / `lastSubmitOutcome`. `mergeInboxIntoLocalSheets` already prefers
`serverStatus`.

## Suggested order

1. Components and pages first. They are display-only and carry no stored-text risk.
2. Then `utils/` and `services/`, checking each message for a stored-and-compared use first.
3. Last, a test like `noSystemFonts.test.ts` that fails when a new Arabic-script literal appears
   outside `fa.ts`. It needs an allow-list for `main.tsx`. Without the test the count drifts back.

---

# 5. Dependencies — where they stand on 2026-10-15

*Recorded so the next upgrade starts from facts rather than from a bare `npm audit` count.*

## What is true today

| Fact | Where |
|---|---|
| `npm audit` reports **16** findings: 3 critical, 4 high, 9 moderate | `npm audit`, 2026-10-15 |
| Every one is **build tooling** (`vite`, `esbuild`, `vitest`, `tar` via `@capacitor/cli`, `sharp` via `@capacitor/assets`, `uuid` via `xcode`). The shipped bundle is clean | backend `docs/roadmap.md` §16 has the per-advisory analysis |
| The two `react-router` advisories are unreachable here | AGENTS.md, the `npm audit` entry |
| `npm audit fix --force` would install `vitest@5` and other breaking majors | `npm audit` |
| These updates are **inside the declared ranges**: `@capacitor/android` and `@capacitor/core` 8.5.1 → 8.5.3, `dexie` 4.4.4 → 4.4.6, `react-hook-form` 7.80 → 7.90, `zustand` 5.0.14 → 5.0.15, `@typescript-eslint/*` 8.62 → 8.71 | `npm outdated` |
| The main stack is one or more majors behind: React 18 (19), MUI 5 (9), Vite 5 (8), react-router 6 (7), vitest 2 (5), TypeScript 5 (7), vite-plugin-pwa 0.20 (2.0), zod 3 (4) | `npm outdated` |

## The options, cheapest first

1. **The in-range updates.** No API change. A Capacitor bump still means rebuilding the APK
   (`docs/apk.md` §10), because the native side ships inside it.
2. **The test and build toolchain** (`vitest`, `vite`, `vite-plugin-pwa`). This closes the build-machine
   advisories. Risk: the service-worker output changes, so offline install must be re-verified on a
   tablet from `preview:mobile`, not only by the test suite.
3. **The UI stack** (React 19, MUI 9, router 7). This is its own project: RTL via `stylis-plugin-rtl`,
   MUI's theme API, and every page.

## What would make it urgent

A runtime advisory in something that reaches a tablet: `dexie`, `react`, `@mui/*`, `zustand`,
`react-hook-form` or `@capacitor/core`. Also anyone running `npm run dev` on a network they do not
control, because the `esbuild` advisory exposes the dev server's responses.

---

# 6. Open items already recorded elsewhere

*An index, so a reader looking for "what is left" finds all of it from here. Each fact lives in the
linked document. Do not copy it here.*

| Item | Recorded in |
|---|---|
| APK fleet decisions: release keystore, moving `versionCode`, a meaningful `versionName`, user-store CA, iOS. Each is cheapest before tablets carry real work | [apk.md §13](apk.md) |
| A changed sync interval only takes effect on the next app launch | AGENTS.md, common pitfalls |
| NFC fault reports filed elsewhere arrive in the bundle but do not unlock manual entry on this device | AGENTS.md, NFC fill page |
| `ensureLocalLogSheet`'s offline fallback does not have the submitted-pending guard (not reachable from any current caller) | AGENTS.md, log sheet merge |
| Showing the last recorded value while a reading is taken, which needs the value in the bundle | backend `docs/roadmap.md` §9 |
| The cost of rebuilding the inbox on every sync tick | backend `docs/roadmap.md` §3 |
| `CLAUDE.md`, `AGENTS.md` and this file point to the backend at `D:\LocalStorage\Project\JavaProject\backend-offline-first` and link to it as `../../JavaProject/...`. On the current development machine the backend is the sibling directory `../backend-offline-first`, so those links do not resolve there | this file's header, `CLAUDE.md`, AGENTS.md |

---

# 7. A tablet whose clock is wrong

*Found in a production-risk review on 2026-10-15. Nothing is built yet.*

Every deadline and retention decision on the device is taken against the **device's** clock. The
server already sends its own time, and the client stores it and uses it for nothing. On a plant
network with no internet route, NTP cannot correct a tablet. After a full battery drain, the clock
can be arbitrarily wrong.

## What is true today

| Fact | Where |
|---|---|
| `isLogSheetExpired` returns true once `dueAt <= now`, where `now` defaults to `Date.now()` | `utils/logSheetStatus.ts` |
| `expireStaleLocalDrafts` uses that to mark an open draft `EXPIRED` locally, with no server involved | `services/sync/logSheetSync.ts` |
| `cleanupLocalLogSheets` **deletes** an expired draft once `now − dueAt > 24h`, readings included, with no archive copy | `services/sync/cleanupLogSheets.ts` |
| The inbox merge decides "extended" with `dueAt > Date.now()`, so a clock that is ahead also blocks the recovery path | `mergeInboxIntoLocalSheets` |
| `isSessionValid` compares `now < expiresAt − 60s` while the server is reachable | `types/auth.ts` |
| `completedAt` is the device's `Date.now()` at submit | `LogSheetFillPage.tsx` |
| The server judges the deadline on that `completedAt` (`completedAt > dueAt` → expired), and nothing checks that it is not in the future or implausibly old | backend `LogSheetService` |
| `serverTime` (epoch ms) arrives on `GET /api/bootstrap` and `GET /api/log-sheets/inbox`, is stored in the inbox snapshot and `lastBootstrapAt`, and drives no decision | `services/api/index.ts`, `pullInbox.ts`, `pullBootstrap.ts` |

## What a wrong clock does

| Clock | Effect |
|---|---|
| **Ahead by more than a day past a sheet's `dueAt`** | An open draft is marked `EXPIRED` here, then **deleted with its readings** while the server still has it open. This breaks the first non-negotiable in `CLAUDE.md`. |
| Ahead by more than the token's remaining life | A fresh session is dropped the moment the server is reachable: an apparent sign-out loop |
| **Behind** | `completedAt` is early, so late work is accepted as on time. This is an integrity problem rather than data loss. |

## The design worked out

1. **A server-clock offset.** Measure `offset = serverTime − (sentAt + receivedAt) / 2` on every
   bootstrap and inbox pull. Persist it in `syncMeta`, so it survives going offline. Expose one
   `serverNow() = Date.now() + offset`, with offset 0 until the first measurement, which is
   exactly today's behaviour.
2. **Absolute-time decisions use `serverNow()`:** expiry, extension, retention, the session
   check, the "due in" display and `completedAt`. Durations (recording length, timers) stay on the
   device clock, where only a difference matters.
3. **A destructive guard that does not depend on any clock.** Cleanup never deletes a draft that
   holds readings this device has not delivered (any entry with `locallyEditedAt`). It keeps the
   draft instead. The offset can be stale after a clock jump while offline, so the guard is what
   actually upholds "never discard local work".
4. **Say so.** When `|offset|` exceeds a few minutes, show a Persian banner telling the operator
   the tablet's clock is wrong. The root cause is fixed on the device, and today nothing reveals
   it.
5. **Backend, separately:** refuse or flag a `completedAt` later than server time plus a tolerance.
   This belongs in the backend's roadmap, not here.

## When someone changes the clock on purpose

Everything above assumes a clock that is wrong by accident. An operator holding the tablet can
also move it on purpose. The offset does not survive that. It was measured when the clock was
right, so after a deliberate change made while offline, `serverNow()` moves with the clock.

| Deliberate change | Today | With the design above |
|---|---|---|
| **Forward, offline** | An open draft is marked `EXPIRED` and later **deleted with its readings** | Not deleted. The cleanup guard (item 3) depends on no clock |
| **Forward, online** | The session may be dropped locally | The offset is re-measured on the next pull and the banner shows (item 4). See also "Sessions" below |
| **Back, offline, after the deadline passed** | Late work is submitted with an early `completedAt` and **accepted as on time** | **Still accepted.** This is the case the offset cannot help with |

### The limit, stated plainly

**A device that is offline and entirely in its holder's hands cannot prove that something happened
*before* a given moment.** This is the same conclusion §3 reaches for "is the tablet running the
real app", for the same reason: whatever the device reports, the person controlling it can make it
report. On the device the change can only be **detected**. It can only be **refused** on the
server, and only for times the server itself witnessed.

### Detection on the device

1. **The clock must not run backwards.** Persist the latest time the app has seen. A
   `Date.now()` below it means the clock was moved back.
2. **Within one run of the app,** compare elapsed `Date.now()` against elapsed `performance.now()`,
   which is monotonic and ignores clock changes. A divergence beyond a few seconds is a change.
3. **In the APK, across restarts:** the native plugin can also return Android's
   `SystemClock.elapsedRealtime()`. That counter runs from boot, and no user setting changes it.
   Store the pair `(Date.now(), elapsedRealtime)` with each offset measurement. Later, the two
   deltas must agree. If they do not, the wall clock was moved. A reboot resets the counter, and
   the reset is itself visible, because the value is smaller than the stored one. The browser
   build has no equivalent, so it gets rules 1 and 2 only.

### Evidence with every submission

Send, with each completion, the offset in force at `completedAt` and whether a clock change was
detected since the last server contact. The server stores both and **flags** the round for the
supervisor. It does not reject the round. Refusing on the device's own word would also refuse
genuine work from a tablet whose clock merely drifted, and work lost is worse than work
questioned.

### Bounds on the server — the only part that cannot be bypassed

- **`completedAt` must not be later than the time the server received it**, plus a small
  tolerance. This catches a clock moved forward.
- **`completedAt` must not be earlier than times the server itself recorded for that sheet:** when
  it was claimed or assigned to this operator, and the server's `savedAt` of the latest progress
  report. This catches part of a clock moved back. The device cannot claim to have finished before
  the server saw it still working.
- **Between the last time the server saw the device and the moment of receipt, the claim is
  unverifiable.** There the server can only flag it, using the evidence above. These bounds belong
  in the backend's roadmap (`backend-offline-first/docs/roadmap.md`).

### Sessions

While the server is reachable, the device should not end a session on its own clock at all. The
server checks the token's expiry on its own clock and answers `401`, which already signs the
operator out. Leaving the decision to the server removes every clock effect on sessions,
accidental or deliberate. Offline, the session is already accepted regardless of expiry, by design.

### Net result

With the design and these additions, a deliberate clock change **loses no data and breaks no
session**. Back-dating late work to make it look on time becomes **detectable and flagged**. It
does not become impossible, and no client-side change can make it impossible.

## What would make it urgent

Any report of a draft vanishing from a tablet. Any dispute about whether a round was really
completed on time. Also tablets kept on Wi-Fi with no internet route
and no SIM, which is exactly the setup in which nothing corrects the clock.

---

# 8. A deploy reloads every browser tablet, mid-form

*Found in the same review. Nothing is built yet. The APK is not affected: it fetches none of its
assets.*

## What is true today

| Fact | Where |
|---|---|
| `registerType: 'autoUpdate'` with `skipWaiting` and `clientsClaim` | `vite.config.ts` |
| In that mode, `vite-plugin-pwa`'s register code calls `window.location.reload()` on the workbox `controlling` event, **without asking** | `node_modules/vite-plugin-pwa/dist/client/build/register.js` |
| `main.tsx` passes an `onNeedRefresh` that only logs | `main.tsx` |
| Unsaved values in an open asset form live in memory: React state plus the page-owned `FormDraftCache`. A reload discards both | `LogSheetFillPage.tsx`, `utils/formDraftCache.ts` |
| An update is noticed on the next full page load: opening the app, Android restoring a killed tab, any navigation that reloads. It is then applied seconds later | service worker lifecycle |

So the first time each browser tablet opens the app after a deploy, it reloads a few seconds
later. Anything typed into an open form in that window and not yet saved is lost, with nothing on
screen to say why. Saved entries are safe.

## The options, cheapest first

1. **Operational rule, no code:** deploy outside shift hours, and say so in
   `deployment.md § Publishing a new build`.
2. **Prompt mode:** `registerType: 'prompt'`. Apply the waiting worker when no asset form is open,
   or from a small "new version" chip the operator taps. The cost is that a tablet can run an old
   build for longer, so `deployment.md`'s "the fleet updates within minutes" stops being true and
   must be rewritten in the same change.
3. **Persist the draft cache** to IndexedDB, so any reload, not only this one, restores what was
   typed. The broadest fix, and the most work.

## What would make it urgent

Deploying during shifts, or a report of "the screen refreshed and my numbers disappeared".

---

# 9. Nothing tells anyone when a tablet stops working

## What is true today

| Fact | Where |
|---|---|
| Sync failures, attachment parking and database refusals are logged to the console only | `services/sync/*`, `main.tsx` |
| `debuggable` is off, so the console of an APK is unreachable in service | `docs/apk.md` §3 |
| The server records `last_seen_at` per session, which is the only remote signal | backend `api_sessions` |

A tablet that silently stops delivering (unbound session, parked uploads, a stale CA in the APK)
is discovered when an operator mentions it.

## The options, cheapest first

1. **A query, server-side**: sessions whose `last_seen_at` is old while their user has open
   rounds. This overlaps §2.
2. **A small client report**: on each sync pass, the counts the device already computes (pending,
   parked attachments, unbound session, app version) sent with the next request, and shown in the
   web panel per device.

## What would make it urgent

A fleet large enough that "an operator will mention it" stops being a monitoring strategy.

---

# 10. Changing the server address without rebuilding

*Raised as: "every time the domain or IP changes we edit `.env.mobile` and rebuild — can we put
something in `dist/` and change it on nginx instead?"*

The request is reasonable and the facts below are worth having before anybody builds it, because
**three of them say the file would not do what it looks like it does.**

## What is true today

| Fact | Where |
|---|---|
| `VITE_SERVER_URL` is read once, at build, into `DEFAULT_SETTINGS.serverUrl` | `services/storage/db.ts` |
| `getSettings()` returns `{ ...DEFAULT_SETTINGS, ...stored }` — **the stored row is spread second and wins** | `services/storage/index.ts` |
| So the build value applies only to a device with no settings row: a genuinely fresh install. Rebuilding moves no tablet already in the field | [apk.md § The server address changed](apk.md) |
| `getBaseUrl()` returns `''` — a **relative** `/api` — whenever the stored origin equals `window.location.origin` | `services/api/client.ts` |
| In the APK the document origin is `https://localhost` (Capacitor's `androidScheme` + `hostname` defaults, no `server.url` set), so it can **never** match and the APK always needs an absolute address | `capacitor.config.ts`, Capacitor `CapConfig` |
| The supported way to repoint one device is the Settings page, through `applyServerUrlChange` — which tears the session down *before* writing the new address, so no token is ever sent to the new host | `services/settings/applyServerUrlChange.ts` |
| Workbox's `globPatterns` covers `js,css,html,ico,png,svg,woff,woff2,webmanifest` — **`json` is not in it** | `vite.config.ts` |
| The served CSP sets `connect-src 'self'` | `docker/nginx/snippets/security-headers.conf` |
| `index.html` and `sw.js` are served `no-cache`; `/assets/` is `immutable` | `docker/nginx/templates/default.conf.template` |

## The three things that decide this

**1. For the browser there is no address to change.** When the stored origin matches the page's
own, the app already calls `/api` relative to wherever it was served — the address is whatever
host answered. And `connect-src 'self'` means the browser **cannot** be pointed at a different
origin even if a config file said so; the request is refused before it leaves. A runtime config
for the browser delivery would therefore either do nothing, or require widening the CSP that §1
exists to add.

**2. For the APK — the case that actually needs it — the file cannot be fetched without already
knowing an address.** Its assets are bundled, so `dist/config.json` inside the APK is the
build-time copy; reaching nginx's copy needs the address the file is supposed to supply.

There is one shape that does work, and it is worth separating from the request: the APK keeps its
bundled address for bootstrap, and treats a config fetched **from that address** as a *redirect*
to a new one. That is a migration path — "this server has moved" — not initial configuration, and
it only helps while the old address still answers.

**3. The stored row still wins.** A runtime config changes where the *default* comes from, not
which value is used. To actually move a configured tablet the file would have to take precedence
over the stored settings, which overrides the per-device choice an admin made deliberately in
Settings. That is a real conflict to resolve, not a detail.

## Two facts that would make it cheap, if it is built anyway

- `json` is outside `globPatterns`, so a `dist/config.json` is **not precached** — an edit on
  nginx takes effect without waiting for a service-worker update. The same fact means it is **not
  available offline**, so the app must fall back to the last known value and must never block
  startup on it. For an app whose first requirement is opening with no network, that fallback is
  the design, not an edge case.
- It would need its own `no-cache` location in the nginx template, beside `index.html` and
  `sw.js`, or the immutable rules elsewhere will outlive the edit.

## The security cost, which belongs with §1

§1 records that a compromised nginx cannot change what the **APK** runs, because the APK fetches
none of its assets — the one asymmetry that delivery has. A config file the APK fetches *and
obeys* hands that back: an attacker holding nginx could repoint every tablet at a server of their
own, and the session token and every reading would follow. If this is built for the APK, the
payload has to be signed and the signature checked against a key shipped in the APK — which is
most of the work, and is the part that would get dropped under time pressure.

## The options, cheapest first

1. **Use an internal DNS name instead of an IP** — `https://mfdcs.plant.local`. This removes the
   problem rather than solving it: the IP moves, one DNS record changes, and **the certificate
   does not need re-issuing either**, because it is issued for the name. Today the cert is issued
   for the IP (`setup-mkcert.ps1 -Ip …`), so an address change means a new certificate *and* a new
   build *and* a visit to every tablet. See [deployment.md § Internal DNS](deployment.md).
2. **Make the browser delivery relative by default** — in a browser, always resolve `/api`
   against the serving origin rather than a stored absolute URL. Correct by construction for
   production and for `preview:mobile`, both of which proxy `/api`. The exception to handle is
   plain `npm run dev`, which does **not** proxy (`vite.config.ts` adds the proxy only in mobile
   mode) and so still needs an absolute address.
3. **A first-run setup screen in the APK** — the address entered once per install. Fits the
   uninstall-and-reinstall update procedure (§[apk.md](apk.md) §10) and needs no rebuild ever.
4. **`dist/config.json` as a signed redirect for the APK only**, with the browser left on
   relative. The narrowest version of the original request, and the only one that both works and
   does not undo §1.

## What would make it urgent

The address changing often enough that visiting each tablet's Settings page is the bottleneck —
or a move that has to happen while tablets are out in the plant and cannot be visited at all.

---

# 11. Sheet-level fields, and a round with no assets — **built**

*The device half of the backend's [roadmap §24](../../JavaProject/backend-offline-first/docs/roadmap.md).
Raised as: "a log sheet should be able to carry a few fields of its own beside the assets — and a
sheet may have no asset at all, just a few questions."*

> **Status. Built, both halves.** The round's own questions arrive with the bundle,
> `SheetQuestionsCard` renders them at the top of the round with a save of its own, and both the
> submit payload and the progress push carry the answers. The backend has since shipped its phase
> D, so **a round with no assets** is real: the three guards below read `hasAnythingToAnswer`
> rather than `entries.length`, and such a round is claimed, walked, answered and submitted like
> any other. The behaviour is in [sync.md](sync.md#the-rounds-own-questions).
>
> Four things the build corrected in this section:
>
> - **No Dexie version bump was needed** — not for the three question fields, and not for
>   round-level media either. All of them are plain, non-indexed properties (and an index simply
>   does not list a row whose property is undefined), exactly like `fieldDefinitions` and
>   `fieldOverridesSnapshot`.
> - **The merge rule did have an existing answer**, and it is the entry rule one level up:
>   `sheetFormLocallyEditedAt`, stamped by the save itself. The "device wins while a draft,
>   server wins afterwards" shape sketched below would have been a third predicate over the
>   data, which is the family of answer `mapServerEntryToLocal` rejects.
> - **A round-level question can carry media**, which this section assumed it could not. The
>   server made `attachments.asset_id` nullable, so `LocalAttachment.assetId` became optional and
>   absence is the owner — the round rather than an asset. `uploadAttachment` omits the field
>   instead of sending `"undefined"`, which would have parked an operator's photograph as a
>   permanent failure.
> - **`required` is enforced in exactly one place**, `SheetQuestionsCard`'s own `handleSubmit`,
>   and nowhere near the submit. The section below expected it to wait for every tablet to carry
>   the field; moving the enforcement point removed that constraint rather than scheduling around
>   it. See [sync.md](sync.md#where-a-required-question-is-enforced).
>

**Read the backend's §24 first.** It owns the model, the migration and the decisions; this section
is only what has to change here, and the two places where this repository is the harder half.

Two other backend changes in the same batch need **nothing on the device**, and it is worth saying
so rather than leaving somebody to check: §26 (filtering the panel's log-sheet list) is a web-panel
list the app does not have, and §27 (withdrawing an approval becomes admin-only) touches no mobile
endpoint — approve and unapprove have never existed in `/api`.

## The one piece of luck, and the two that are not

**Downward there is nothing to do.** The backend serialises the whole `LogSheet` entity into
`bundle.sheet`, so `sheetFieldDefinitionsSnapshot` and `sheetFormData` arrive on the device with no
contract change and no new endpoint. Whatever this app does with them, it does not have to be told
about them.

What is not lucky:

**1. The round screen refuses to submit a sheet with no entries, and blames the network.** Three
conditions in `src/pages/LogSheetFillPage.tsx`:

| Line | Today | On a questions-only round |
|---|---|---|
| 1477 | `entries.length === 0` renders «هیچ Asset ای برای این کار یافت نشد… باید آنلاین باشید» | **untrue** — nothing failed to load, and the operator is sent to look for signal |
| 1327 | the submit button renders only when `entries.length > 0` | **the round cannot be submitted at all** |
| 1316 | the progress line, same condition | merely absent |

The condition all three want is "is there anything on this round to answer" —
`entries.length > 0 || sheetFields.length > 0`. The «not found» alert has to keep its present
meaning and fire only when the sheet is *supposed* to have assets, which the device can now tell:
a sheet with no entries **and** no sheet-level fields really is a sheet that failed to load.

`canSubmitLogSheet` itself has no asset-count condition, so this is three JSX conditions — not a
lifecycle change.

**2. The round's own counters are per entry.** `LogSheetFillPage` derives `totalCount` and
`filledCount` from `entries` (lines 1150–1151) and `getEntryCompletion` per row. A questions-only
round reads «۰ از ۰». The sheet-level form has to count as one more item in that pair, or the
header contradicts a screen that visibly has something to fill in.

## What changes, file by file

| | Change |
|---|---|
`src/types` | `sheetFieldDefinitionsSnapshot?: FieldDefinition[]` and `sheetFormData?: Record<string, unknown>` on `LogSheet` |
`services/storage/db.ts` | a Dexie version bump. Purely additive — no index on either field, no data transform, and an older row simply has neither |
a resolver beside the per-asset one | `resolveSheetFields(sheet)`, which **prefers the sheet's own snapshot and never today's definitions**. The same rule the per-asset resolution already follows, and for the same reason: a question edited on the template next month must not re-describe a round already walked |
`LogSheetFillPage.tsx` | one `DynamicClassForm` at the **end** of the round, after the asset list — "were all the pipes checked" is answerable only once they have been. The component itself does not change; it already takes a definition list and a value map |
the three guards above | `entries.length > 0 \|\| sheetFields.length > 0` |
the counters above | the sheet-level form as one more item |
`utils/formDataValidation.ts` | `findSubmitBlockingIssues` must look at the sheet-level required fields too |
the submit payload | `sheetFormData` on the sheet object the outbox sends |
the progress push | `sheetFormData` as well — a partial round reports partial answers, and the server deliberately does **not** apply the required check to a progress push |

## The two rules this feature must not break

**Blankness is judged by `isFieldValueBlank`, never by key presence.** `formDataValidation.ts`
already carries the whole argument — its rules are transcribed from the server's
`FormDataValidationSupport.isBlank` precisely because `evaluateEntryCompletion` disagrees in ways
that matter. The sheet-level form is a second caller of the same question, and the first instinct
(`Object.keys(sheetFormData).length > 0`) is the exact test that once let a device's blank copy win
a merge and overwrite the server's values. Use the existing helper; add no second definition of
"answered".

**The local gate stays conservative.** That file's governing rule is *"this must never block a
submission the server would have accepted"* — a false block strands the operator with no error
from anyone. So a required sheet-level field blocks the submit **only when the device actually
holds the sheet's field snapshot**. A sheet synced by an older build carries none, and that case
must fall through to allow and let the server answer. This is also what makes the backend's
phase-1 choice (nothing required at first) safe to ship in either order.

## Two things the device does not get, and one it decides

**Revisions are web-only, deliberately.** The backend keeps what a correction replaced
(`log_sheet_revisions`, §24), and `LogSheetBundleDto` carries `sheet`, `entries`, `context`,
`nfcFaultReports` and `attachments` — **no revisions**, for entries today and for the sheet-level
answers tomorrow. So there is nothing to render here and nothing to store. An operator sees the
current answers; a supervisor reads the history in the panel.

**There is no save button to add.** The panel needs one because its fill page posts to the server;
this app writes to Dexie as the operator works and reports through the progress push. Nothing in
§24's save-button half reaches the device.

**But the push cadence now decides how the history reads.** `LogSheetProgressItem` carries *only
what changed since the last accepted push*, and the server writes one revision row per push that
genuinely replaces a stored value. So an operator who corrects a round-level answer across three
pushes leaves three history rows, and one who corrects it three times between two pushes leaves
one. Both are honest. What would not be honest is pushing on every keystroke: the history would
fill with rows nobody made a decision in. Keep the sheet-level form on the same
confirm-or-debounce rhythm the asset forms already use, and treat "how many revisions did this
round produce" as a thing worth looking at once after the first week in service.

## Merging, which has no existing answer

Every conflict rule in `services/sync` operates on `entries`. `sheetFormData` is a field of the
*sheet*, so none of them covers it, and the sheet record is the one the server rewrites wholesale
on every bundle fetch.

The narrow rule that matches what the rest of the app already does: **the device's answers win
while the round is still a local draft, and the server's copy wins once the sheet is no longer
editable here** — with blankness decided by `isFieldValueBlank`, so an empty local map never
overwrites stored answers. Write it as its own small function with the reasoning next to it, next
to the entry merge rather than inside it; a flag threaded through the entry merge would be read as
applying per asset.

## What this does not need

No new store, no new queue, no new endpoint, no service-worker change, and no change to
`DynamicClassForm`, `DynamicFormField` or any field control. That is the whole point of the
backend building the questions as `field_definitions` in a different owner rather than as a new
kind of thing.

## What would make it urgent

A round that exists only to ask questions — a shift handover, a security patrol's closing
checklist, an area inspection with no equipment in it. Until the backend ships §24 there is nothing
to render; once it does, the device is the half that decides whether the feature is usable in the
field.

---

# 12. QR beside NFC on the device — **built**

*The device half of the backend's [roadmap §25](../../JavaProject/backend-offline-first/docs/roadmap.md).
Raised as: "a template should be able to allow NFC, or QR, or either of the two — with NFC the
default."*

> **Status. Built.** `scanMode` arrives on the sheet, the fill page offers the button(s) that
> round allows, `QrScanDialog` drives the camera, and a QR reading is labelled `PWA_QR` all the
> way to the server. Four things differ from the plan below, and each is worth reading before
> acting on the rest of this section:
>
> - **There is a fourth mode: `NONE`.** Not in the original sketch, and it turned out to be the
>   one a plant asks for first — a position nobody will ever label, or a questions-only round
>   with no asset to scan at all. On such a round the asset row opens the form directly and the
>   reading is recorded as manual, which is what it is. A round with no assets is forced to it
>   by the server, whatever the form said.
> - **No site-wide `qrEnabled`, and none is planned.** The sketch wanted one AND-ed with the
>   sheet's value so a site with no printed labels could switch the control off everywhere. The
>   per-round setting already is that switch, at the resolution the decision is actually made:
>   labels are printed per area, not per plant. A second global flag would be a second place to
>   look when a button fails to appear.
> - **Both decoders ship, and the reason is a measurement.** This first went out on
>   `BarcodeDetector` alone, on the argument below that the platform API wins on size and on
>   speed with a live camera. It does — but it is **not present everywhere**: a current Chromium
>   browser on Windows reports `window.BarcodeDetector === undefined`, because Shape Detection
>   ships on Android and macOS rather than on every Chromium platform. Betting the feature on it
>   meant QR silently not working on whatever the plant buys. `jsqr` is now the fallback, a
>   **dynamic import in its own 130 KB / 47 KB-gzipped chunk**, so a device with the platform API
>   never downloads it and a device without one still has it offline (workbox precaches every
>   chunk). The argument below was right about cost and wrong about availability.
> - **The native door is open and unused.** `startQrScan` prefers a Capacitor plugin named `Qr`
>   if a build registers one, exactly as `nativeNfc` does. None is written: a native decoder
>   means an ML Kit or ZXing Gradle dependency, and adding one that cannot be fetched, built or
>   tested here would be shipping an unverified APK path. It is the packaged app's fallback if
>   the WebView turns out to lack `BarcodeDetector`.
>

**Read the backend's §25 first** for the model (`scan_methods` on the template, frozen onto the
sheet) and for the one fact that governs everything: **a QR code has no hardware serial**, so
`nfcStrictSerialMatch` has nothing to check and a printed label is clonable by photocopier. The
device must not present a QR scan as if it were a verified one.

## What arrives, and what has to be built

`scanMethods` (`NFC` | `QR` | `NFC_OR_QR`) reaches the device inside `bundle.sheet` with no
contract change, exactly as §11's two fields do. A site-wide `qrEnabled` belongs on
`mobilePolicy` beside `nfcStrictSerialMatch` and `nfcManualEntryEnabled`, mirrored into `settings`
so it still answers offline — and **AND-ed** with the sheet's own value, never OR-ed, so a site
that has printed no labels can turn the control off for every tablet at once.

The payload is **the same `tag` string** an NDEF record 1 carries. So `matchLogSheetEntryByTag` is
reused **verbatim**, and the whole of `matchLogSheetEntry.ts` — including the one outcome that
stays specific, *a valid tag that is simply not on this sheet* — keeps working unchanged. Anything
richer in the QR payload would create a second identifier space to keep in step, which is the
mistake the single `decodeRecordData` exists to prevent.

## The decoder — and `BarcodeDetector` is `NDEFReader` all over again

| Where | Web NFC | `BarcodeDetector` |
|---|---|---|
| Chrome on Android | available | available |
| **Android's WebView — i.e. inside the APK** | **absent** | **present, and may not work** |
| Everywhere else | absent | absent |

> **Corrected after the first live Android run — and the original wrong row is why the bug
> happened.** This table said `BarcodeDetector` was *absent* in the WebView. If that were true,
> `typeof window.BarcodeDetector` would be a sufficient support check, and that is exactly what
> the code did. It is not true: the API is exposed in Android WebView (Chrome 83+), but it is
> backed by a Play Services module fetched on demand — Chrome has it, a plain WebView host does
> not. So the constructor succeeded, `getSupportedFormats()` resolved with an **empty list**
> (which the spec defines as "cannot decode", and nothing read), and every `detect()` call
> rejected into a frame loop that swallowed errors forever. The camera opened and nothing ever
> happened. **Present-but-broken is a worse failure mode than absent, because every cheap
> feature check says yes.** See `device-features.md` for the two gates now required, and
> AGENTS.md #172 in the backend repo.

`device-features.md` records the first row of that trap already: *"not iOS, not desktop, and — the
one that catches people — not Android's WebView"*. `BarcodeDetector` is a Chrome API with exactly
the same shape of availability, so building on it would make QR scanning vanish inside the
packaged app with no error anywhere — the same failure NFC needed a native plugin
(`android/app/src/main/java/com/hnp/mfdcs/NfcPlugin.java`) to escape.

> **What was actually built, and it is not "no second path".** Both decoders ship. The platform
> one is kept because it is faster on a live stream and because it is the **only** one that reads
> a linear barcode — `jsqr` decodes QR and no 1-D symbology at all. What the recommendation below
> got right is that a bundled decoder must exist; what it got wrong is that one is enough. The
> cost of two is paid in a selection rule, not in a second permission story: the platform decoder
> is used only after `getSupportedFormats()` lists a wanted format **and** a trial `detect()`
> completes, and a failure on a real frame fails over to `jsqr` once, mid-session.
>
> **The consequence to keep in mind: in the APK a `BARCODE`-only field may be unfillable by
> camera.** It is refused in words rather than silently, and the device-check page answers it per
> tablet — but the only real fixes are a native plugin (ML Kit / ZXing) or getting the WebView's
> own binding a model to load.

**Recommended: one bundled JavaScript decoder fed by `getUserMedia`, and no second path.** It
works in Chrome and in the WebView alike, which is strictly better than the position NFC is in —
there, two readers answer one `isNFCSupported()` and the project has to keep them decoding
identically on purpose. A camera decoder has no such obligation if there is only one of it.

Three facts make that concrete:

- **`getUserMedia` is already used here**, for audio and video capture (`utils/mediaCapture.ts`),
  and `utils/mediaPermissions.ts` already maps a rejection to a Persian sentence and says whether
  it is recoverable in-app. Reuse both; do not write a second permission story. Photo capture is
  **not** a precedent — it uses `<input accept="image/*" capture="environment">` and never opens a
  stream, so a live preview is genuinely new UI.
- **`getUserMedia` needs a secure context.** `mediaPermissions.ts` notes that over plain HTTP
  `navigator.mediaDevices` is not merely empty, it is undefined. Production is TLS and the APK's
  origin is `https://localhost`, so both are fine — but a developer on `http://…:5173` will see
  the feature simply not exist, and the message should say why.
- **Workbox would not precache a `.wasm` decoder.** `globPatterns` in `vite.config.ts` covers
  `js,css,html,ico,png,svg,woff,woff2,webmanifest` — **no `wasm`** (the same gap §10 found for
  `json`). A wasm-based decoder would therefore work online and fail offline, which for this app
  is the only mode that matters. Either choose a **pure-JS** decoder, or add `wasm` to
  `globPatterns` in the same commit and verify it with the network off. Nothing about this is
  discoverable later: it fails exactly once, in the field, in a basement.

## The scan control, per `scanMethods`

| Sheet value | What the operator sees |
|---|---|
| `NFC` | today's «اسکن NFC», unchanged |
| `QR` | a camera scan action, and no NFC affordance |
| `NFC_OR_QR` | **both offered, NFC first** — the default stays visually the default |

`isNFCSupported()` gains a sibling `isQRSupported()`, and the control shows what the sheet allows
**intersected with what the device can do**: a `QR`-only round on a tablet whose camera is refused
has to fall back the way an unreadable chip already does — the **NFC fault report**, which unlocks
manual entry for that one asset and leaves a maintenance ticket behind. Do not invent a second
bypass; the existing one is what turns "the scan was skipped" from a hole in the data into
somebody's job.

## What the device sends back

`captureMethod` (`'NFC'` | `'QR'` | `'MANUAL'`) on the submitted entry, beside the existing
`manualEntry` boolean rather than instead of it: the server reads `captureMethod` when present and
falls back to `manualEntry` otherwise, so an older server and a newer device still agree about a
manual entry. The backend stamps `entry_source = PWA_QR` from it.

**The device must not claim verification it did not perform.** Strict serial matching governs NFC
and says nothing about QR; a QR scan is never "strict". Whatever the round summary says about a
scanned position must not say the same thing for both carriers — the data-quality report splits
them on the server (§25 point 7), and a screen that calls them both «تأییدشده» would make that
split pointless.

## Documentation to update when it is built

| | |
|---|---|
[device-features.md](device-features.md) | a QR section beside the NFC one: availability, the payload, why there is no strict mode, and the fallback |
[apk.md](apk.md) | §7 holds the NFC plugin contract; if a native decoder is ever chosen over the bundled one, its contract belongs beside it. If the bundled decoder is used, say **that** — "no plugin, deliberately" is the fact a future reader needs |
[storage.md](storage.md) | only if `qrEnabled` lands in the settings mirror, which it should |

## What would make it urgent

Positions that cannot take a chip — too hot, too small, outdoors, behind glass — or tablets
without NFC hardware. Both are facts about equipment rather than preferences, and either one makes
this the difference between a round that can be walked and one that cannot.

---

# 13. A page where an administrator can test the device's hardware

*Raised as: "a page in the PWA, admin only, to test the camera, NFC and GPS."*

## What happens today

Nothing — and the gap shows up at the worst moment. An operator says «اسکن کار نمی‌کند» and
there is no way to tell, on that tablet, whether NFC is switched off in Android settings, the
WebView lacks Web NFC, camera permission was denied six months ago, or location is off. Every
one of those produces the same thing in the field: a button that does nothing useful, and a
support call that begins by guessing.

The pieces are all already written and already feature-detect: `useNFC` and `nativeNfc`,
`qrScanSupport()` plus `startQrScan`, `geolocation.ts`, and `mediaPermissions.ts`. What is
missing is one screen that *asks all of them at once* and shows the answers side by side.

## The shape

A route under the existing settings area, gated the way the rest of the admin-only UI is gated —
a permission the session carries, not a role code (the backend's `security.md` is explicit about
why). Four rows, each with a live state and a «تست» button:

| Row | Checks | Reports |
|---|---|---|
| NFC | `NDEFReader` present / native plugin present / neither | available, and the first tag it reads with its record-1 payload and hardware serial |
| Camera + QR | `qrScanSupport()`, then an actual scan | `noDecoder` vs `noCamera` vs a decoded payload |
| GPS | permission state, then one fix | accuracy in metres and how long the fix took |
| Storage | the quota helpers that already exist | used / available, and whether the browser is in the «low» state the attachment capture refuses in |

**It must report rather than fix.** A page that quietly asks for every permission on load teaches
an operator to press «رد». Each row asks only when its own button is pressed.

**Show the raw answer, not a verdict.** «NFC در دسترس نیست» sends somebody to the wrong place
half the time; «`NDEFReader` تعریف نشده — این WebView از Web NFC پشتیبانی نمی‌کند» names what to
do about it. The reader of this page is an administrator standing next to the tablet.

## What would make it urgent

A fleet large enough that a support call costs a site visit, or the first time a model of tablet
turns out to differ from the ones the system was built on — which is exactly when nobody can
tell whether the problem is the hardware, the build, or a setting somebody changed.

---

# 14. The round's own answers say, in the form, that they are not saved yet

*Raised as: "above the save button write that these will not be sent unless saved, and when
they are unsaved say so — in orange."*

## What happens today

`SheetQuestionsCard` has its own save button, deliberately: one small save per section means a
closed app costs a field rather than an afternoon. But the consequence of **not** pressing it is
invisible. The answers sit in a `react-hook-form` state that nothing persists, so closing the
round — or letting the tablet sleep until the app is evicted — loses them silently. The operator
has no reason to suspect it: every other field on the page belongs to a dialog that saves when
it closes.

This is the one place in the app where typing into a visible form and walking away loses the
typing.

## The shape

Two additions, both inside that card:

- **A line above the button**, always: «تا وقتی ذخیره نکنید، این پاسخ‌ها به سرور ارسال نمی‌شوند.»
- **A warning while the form is dirty**, in `warning.main`: «این پاسخ‌ها هنوز ذخیره نشده‌اند.»
  `useForm` already tracks `formState.isDirty`, so this is a read of state that exists, not a
  second source of truth about whether there is unsaved work.

**Dirty, not "different from the server".** Comparing against `values` would call a re-typed
identical answer clean, and the operator who retyped it would be told there is nothing to save
while the button still has something to do.

**A `beforeunload` / navigation guard is NOT part of this**, and that is a decision rather than
an omission: a tablet navigating away mid-round is ordinary (an NFC scan opens a dialog; the
operator checks the asset list), and a confirm dialog on each of those trains people to dismiss
it. The warning is the honest version — it says what is true, and leaves the operator to act.

## What would make it urgent

The first report of a round whose questions came back blank on the panel while the operator is
certain they answered them. By then the data is gone and nobody can prove what happened, which
is the shape of bug this warning exists to make impossible to have.
