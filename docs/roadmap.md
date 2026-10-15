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
| The nginx config sets **no security headers at all** — every `add_header` in the documented config is `Cache-Control` | [deployment.md § The whole `nginx.conf`](deployment.md) |
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
   but it is the cheapest real control here and today there is none.
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
