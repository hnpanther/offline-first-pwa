# Read this first

React + TypeScript + Vite offline-first PWA for industrial field data collection. Persian (RTL),
MUI, Dexie/IndexedDB. Its backend lives at
`H:\Project\offline-first-project\backend-offline-first` — the sibling directory
`../backend-offline-first`.

The operators using this app are standing in a plant, often with **no network**, holding a
tablet against a pipe. Every design decision here follows from that.

## Before you change anything

Read, in this order:

1. **[AGENTS.md](AGENTS.md)** — the conventions of this codebase and the traps found the hard
   way. Several are not guessable: an attachment field's value is an object and therefore truthy
   even when empty; the sync interval is stored in ms and displayed in seconds and must be
   converted on exactly one side; NFC scan failures are deliberately opaque.
2. **[README.md](README.md)** — what the app does, how to run it, how to test it on a phone,
   and how to deploy it.
3. **[docs/](docs/)** — the deep references:

| File | When you need it |
|---|---|
| [docs/sync.md](docs/sync.md) | How data moves to and from the server, in what order, and what each failure means. **The most delicate code in the app.** Since backend V28 also: **the server's clock on this device** (which decisions use `serverNow()` and which must not), **wipe on revoke** (the one deliberate deletion of unsent work, carried out before the database opens), and **the offline-session lock**. |
| [docs/storage.md](docs/storage.md) | The Dexie schema, every store, and the rules for changing it |
| [docs/device-features.md](docs/device-features.md) | NFC, camera, GPS, screen orientation — support and fallbacks |
| [docs/apk.md](docs/apk.md) | **The packaged Android app.** Building it without Android Studio, the native NFC plugin and the payload contract it keeps with the web decoder, manifest permissions, why the app cannot use a hand-installed CA, and exactly what to rebuild when what changes. |
| [docker/DEPLOY.md](docker/DEPLOY.md) | **Running the browser delivery in Docker.** nginx + the built `dist/`, TLS and config on volumes, security headers, the `/api/` proxy. |
| [docs/roadmap.md](docs/roadmap.md) | **Some entries are built and say so (§15, §17). The rest are decisions deferred** — hardening what nginx serves, session anomaly detection, device attestation — each with the facts it rests on. Read it before designing any of them again; one idea is recorded there specifically because it does not work. §11 and §12 are the device halves of two backend features — **sheet-level fields and a round with no assets** (three `entries.length` guards in `LogSheetFillPage` that today refuse such a round and blame the network) and **QR beside NFC** (where `BarcodeDetector` is absent from Android's WebView exactly as `NDEFReader` is, and a `.wasm` decoder would not be precached because `globPatterns` has no `wasm`). §15 is the device half of the backend's §31–§32 — **built**: a searchable choice with free entry only when the field says `allowCustom`, lookup lists in Dexie `version(4)`, and a signature pad that writes into the existing attachment queue. The lists downloaded are the assigned rounds' `requiredLookups` **union** bootstrap `requiredFormLookups` (lists FILL-able forms use) — not every catalog. §16 is **a voided round's photos retried forever and holding the pending badge up** — the defect is in the code: an ownership void stores the server's translated text as `syncError` and leaves `serverStatus` alone, so neither `isRevokedAssignment` nor `isSupersededSyncError` recognises it, every pass uploads into a 403 that is deliberately retryable, and the badge counts each photo; the fix keys off `lastSubmitOutcome`, parks the files without purging them, and later delivers them through backend §35. §7 is **a tablet whose clock is wrong** — the offset, the floor and the server's upper bound are built (2026-11-18, backend V28; behaviour in `docs/sync.md` «The server's clock, on this device»), in-run/APK clock-change detection and the server's lower bound are not. §17 is **ad-hoc field forms (carrier 3), built** (Dexie `version(5)`): draft upsert, then that form's media including a signature while the server row is still a draft, then final submit. Sign-out runs `clearAllLookups` (form lists and round lists are the same stores) and drops the lease key; drafts, queued finals and signature blobs stay. History is `/forms/history`; the title on screen is the Persian segment only. The fill page scrolls the window, so the end-of-form jump is suppressed. List rows are the signed-in author and an accessible unit; retention uses the same `deviceRetention` windows as rounds. Log-sheet sync order is unchanged. |

## The rule that keeps this useful

**Any change to sync, storage, a device feature or a user-visible behaviour must update the
matching document in the same commit.** Not afterwards, not in a follow-up.

Documentation that lags the code is worse than none: it is confidently wrong, and the next
person — or the next agent — will trust it.

| You change | Also update |
|---|---|
| The Dexie schema or a store | [docs/storage.md](docs/storage.md) |
| Sync order, an outcome, or the attachment queue | [docs/sync.md](docs/sync.md) |
| NFC, camera, GPS or orientation | [docs/device-features.md](docs/device-features.md) — and check it still works **inside the APK**: a browser API is not a WebView API, and a permission absent from `AndroidManifest.xml` is denied with no prompt |
| Anything under `android/`, or the native NFC contract | [docs/apk.md](docs/apk.md) |
| A trap you only found by debugging | **[AGENTS.md](AGENTS.md)** — add an entry with the *why* |
| The nginx site, headers or proxy | [docker/](docker/) **and** [docs/deployment.md](docs/deployment.md): the same site is described in both |
| A user-visible feature or setting | [README.md](README.md) |
| Anything touching the API contract | the backend's `README.md`, `AGENTS.md` and `docs/` too |

## Non-negotiables

- **Never discard local work.** A reading taken in the field exists whether or not the server
  has accepted it. A refused submission is kept, surfaced and recoverable — never dropped.
  **The one exception is an explicit order** (backend V28, *wipe on revoke*): an administrator
  revokes this device and orders it emptied, on a page that showed how many undelivered rounds it
  last reported; `services/device/deviceWipe.ts` then deletes everything. Nothing on the device
  decides it, and nothing else may borrow its path. The offline-session lock (also V28) is **not**
  an exception: it signs out and keeps every round, every form draft, every queued final and every
  signature blob. Lookup lists are cleared, the same as any other sign-out.
- **Never edit an applied Dexie `version(n)` block.** Add a new one with the full store list.
  Rewriting a shipped version makes a device's database un-openable.
- **Assume no network.** Code that requires a `serverId` to exist will break on exactly the path
  this app is built for.
- **All UI text is Persian and lives in `src/i18n/fa.ts`.** No hardcoded strings in components.
- **Every UI change stays inside the CSP** in `docker/nginx/snippets/security-headers.conf` (`script-src 'self' 'wasm-unsafe-eval'`). No inline script, no `eval`, no asset or request to another origin. Styles may be inline. Do not widen `script-src` to accommodate a library.
- **One codebase, two deliveries.** `dist/` for nginx and the APK are the same app. A change ships
  to both or the tablets and the browsers are running different versions.
- **One NFC decoder.** The native plugin normalises a tag's payload exactly as Web NFC does and
  stops there; every heuristic stays in `decodeRecordData`. Two decoders would drift, and a tag
  would read differently in Chrome than in the app.

## Verifying

```bash
npm run test && npx tsc --noEmit && npm run build
```

A device feature cannot be proven in a unit test. NFC, camera and orientation need a real
Android device, and the orientation lock needs the app **installed**, not a browser tab.

For the packaged app, `npm run build:apk` and install the result — a green suite says nothing
about whether the WebView has the API, whether the permission was declared, or whether the app
trusts the certificate. Each of those has already shipped as a silent failure once.
