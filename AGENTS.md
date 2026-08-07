# AGENTS.md — AI agent guide (offline-first-pwa)

This file orients coding agents on **this repository only**: the **offline-first PWA** (React + Vite + Dexie). Human-oriented setup and deployment details live in **`README.md`**.

| Item | Value |
|------|--------|
| License | GPL-3.0-or-later — Copyright (C) 2026 hadi_hnp |
| UI language | Persian (RTL); agent docs in English |
| Backend (separate repo) | `backend-offline-first` — Spring Boot, default **8081** |
| Typical backend path (local) | `D:\LocalStorage\Project\JavaProject\backend-offline-first` |
| Primary user journey | Log sheets (inbox → fill → local submit → batch sync) — the only journey; the legacy DataRecord stack was deleted |

---

## Commands (run from repo root)

```powershell
# Windows: if node missing from PATH
$env:PATH = "C:\Program Files\nodejs;$env:PATH"

npm install
npm run dev                    # desktop dev :5173, no HTTPS
npm run dev:mobile             # :5173 HTTPS — do NOT install PWA from here
npm run build:mobile           # production tablet/nginx — uses .env.mobile
npm run preview:mobile         # :4173 HTTPS — real PWA + offline test
npm test                       # vitest run (src/**/*.test.ts)
npm run lint
npx tsc --noEmit               # same as build typecheck (tests excluded)
```

| Goal | Command |
|------|---------|
| Tablet / nginx deploy | `npm run build:mobile` → copy `dist/` |
| Typecheck app only | `tsc` via build scripts; tests use `tsconfig.vitest.json` |
| Trusted HTTPS dev | `npm run setup:mkcert` then `preview:mobile` |

**Do not** use plain `npm run build` for plant tablets unless you intentionally use `.env.production`.

---

## Architecture (must internalize)

```
React pages/hooks
  → Zustand (src/store) for session, inbox snapshot, sync UI state
  → src/services/storage/*  (IndexedDB / Dexie — local source of truth)
  → src/services/api/*      (REST; base URL from settings + origin rules)
  → src/services/sync/*     (bootstrap, inbox, merge bundles, SyncManager push)
Service Worker (Workbox) precaches dist/ — offline shell only after build + install from :4173 or production URL
```

### Data sync model (no full master pull)

1. **`GET /api/bootstrap`** — lightweight; client **persists only** `operationalUnits` + `syncMeta.lastBootstrapAt`. Scope enforcement is server-side (JWT).
2. **`GET /api/log-sheets/inbox`** — `assigned[]` are full **`LogSheetBundleDto`**; merge with **server-wins** into IndexedDB.
3. **`GET /api/log-sheets/{id}/bundle`** / **`POST .../claim`** — same bundle shape for one sheet.
4. **Push** — `SyncManager`: `POST /api/log-sheets/batch` for submitted sheets owned by current user, plus `POST /api/nfc-fault-reports/batch` for locally-filed fault reports when the session holds that permission.

There is **no** `pullMasterData` / full plant dump in the current design. Do not reintroduce without explicit product approval.

### Layering rules

- **Prefer** adding API calls in `src/services/api/index.ts` and DB access in `src/services/storage/index.ts`.
- **Hooks** (`useInboxSync`, `useSync`, `useLogSheets`, …) orchestrate services.
- **Exceptions today:** `LogSheetListPage.tsx` and `LogSheetFillPage.tsx` call API directly for claim/release/assign and online bundle refresh — follow existing pattern if extending those flows.

---

## Critical invariants (do not break)

### Shared tablets (`src/services/auth/sessionContext.ts`)

- Outbound sync sends **only** log sheets where `assigneeUserId` matches **logged-in** user (`isLogSheetOutboundOwnedByUser`).
- Outbound sync sends **only** NFC fault reports whose `createdByUserId` matches **logged-in** user (`isNfcFaultReportOutboundOwnedByUser` in `services/storage/nfcFaultReports.ts`).
- **Never** sync another user’s pending submissions when someone else is logged in (audit + server rejection).
- User switch: clear inbox snapshot, isolate/archive other users’ local rows, mark others’ unsynced submitted as `REVOKED` locally until assignee returns.
- Do not “helpfully” push all pending rows on any login.
- **This invariant has to be applied to every new outbound-syncable local table separately** — it is not automatic. The NFC fault report feature initially missed it entirely: `getPendingNfcFaultReports()` had no per-user filter, so a report an operator filed offline and never synced before logging out would get silently uploaded — and attributed on the server to whoever logged in next on the same device — the moment that next operator's own sync ran. Found via a real browser repro (operator1 offline → fault report → logout without syncing → operator2 logs in same device → automatic sync attributes the report to operator2). Fixed by stamping `createdByUserId` at creation time (`createNfcFaultReport`) and filtering the outbound query by it, mirroring `isLogSheetOutboundOwnedByUser`. Reports with no `createdByUserId` (pre-fix legacy rows) are treated as syncable by whoever is currently logged in. Regression tests: `nfcFaultReports.test.ts`.

### Log sheet merge

- Bundle context merge: **server wins** (`mergeLogSheetBundle.ts` / `mergeBundleContextToDb`).
- Inbox assigned bundles **pre-provision** assets, NFC ids, field defs — operators should fill offline after one online inbox sync.
- `operatorName` / `assigneeUserId` on local sheets come from **server** inbox/bundle metadata, not stale local guesses.
- **`mapServerEntryToLocal` (in `mergeLogSheetBundle.ts`) rebuilds each `LogSheetEntryData` from an explicit field list** — it does not spread `...existing`. Any **local-only** field on `LogSheetEntryData` (one the server DTO doesn't carry, e.g. `filledVia`) must be explicitly threaded through here (`preserveLocal ? existing?.field : undefined`, matching the `createdAt`/`updatedAt` pattern) or it is silently dropped on every bundle refresh — not just cross-device sync, but simply **reopening a draft sheet while online** (`LogSheetFillPage`'s `canRefreshBundle` load-effect calls `applyLogSheetBundle` unconditionally for online draft sheets). Found the hard way: an entry manually completed via an NFC fault report lost its `filledVia: 'manual'` marker the next time the operator reopened the sheet before final submit, so the server received no `manualEntry` flag and defaulted `entry_source` to `PWA_NFC` despite no scan ever happening. Regression tests: `mergeLogSheetBundle.test.ts`.
- **A locally pending, unsynced completion (`status:'submitted', syncStatus:'pending'`) must never be resolved by a bundle refresh — only the batch-submit outcome may resolve it.** `applyLogSheetBundle` (`services/sync/logSheetSync.ts`) now returns such a sheet completely untouched, before even calling `alignLocalWorkflowWithServer`. The bug: any code path that fetches a fresh bundle for that specific sheet (`ensureLocalLogSheet({refreshBundleOnline:true})`, used when opening a sheet from the list, or claim/release refreshes) would call `alignLocalWorkflowWithServer`, which — for this exact local state — returned `'reset-draft'` (server still open, reassigned to someone else: archives + wipes local entries, sets a fake local `REASSIGNED` error) or `'mark-synced'` (server already `SUBMITTED` by someone else: blindly marks the local pending submission `synced`, discarding it with **no error at all**). Neither path ever contacts the actual submit endpoint, so the server's `voidSubmission()` never runs — the operator's completed work vanishes with no `log_sheet_void_submissions` row and no `SUPERSEDE` action logged, even though the PWA shows a "این کار به اپراتور دیگری واگذار شده است" message that looks like a real server response. Confirmed against a real user report (log sheet id 23: `a.saljooghi`'s NFC fault report synced fine — that path has no such gate — but their actual completion left zero trace server-side). Fixed by short-circuiting `applyLogSheetBundle` before any bundle-driven mutation of a submitted-pending sheet, and simplifying `alignLocalWorkflowWithServer` to return `null` immediately for that state — deferring entirely to the outbound sync queue (`syncManager.sync()` → `LogSheetService.submitOne()`), which already correctly resolves SUBMITTED/DUPLICATE/SUPERSEDED-with-void. Verified live twice: (1) replaying the exact sequence (claim → offline completion pending sync → supervisor takeover+reassign while still open → bundle refresh) leaves the local sheet's status, entries, and `assigneeUserId` completely unchanged, and the next outbound sync attempt then correctly reaches the server and produces a `SUPERSEDE` action + `log_sheet_void_submissions` row with the operator's real payload intact; (2) the NFC fault-report leak fix above was independently re-verified with a cleaner methodology (genuinely offline creation, explicit session switch, then explicit online sync — no reliance on an ambient background sync interval that can otherwise race a naive repro into a false negative). Regression tests: `logSheetWorkflow.test.ts`.
  - **Second, independent root cause for the same "no void record" symptom — the archive dead end.** The guard above only protects a completion still reachable from the live `logSheets` row. It does nothing once the row has been handed to a different user, which is exactly what happens when the operator **logs out while still offline**: (1) `signOut` → `clearUserSessionContext()`; (2) operator2 logs in → `activateUserSession` → `isolateSheetsNotOwnedBy` → `archiveLogSheetForUser` copies operator1's completed work into `logSheetUserArchives` and marks the live row `failed`/`REVOKED`; (3) operator2 opens the sheet → `applyLogSheetBundle` → `alignLocalWorkflowWithServer` returns `'reset-draft'` (syncStatus is now `'failed'`, not `'pending'`, so the guard above does not fire) → `resetLogSheetToOpenDraft({clearEntryFormData:true})` **wipes the live row's entries and `clientActionId`**; (4) operator2 completes and syncs. Operator1's work now exists **only** in the archive — and `getPendingLogSheets()` read exclusively from `getAllLogSheets()`, so archives were never sync-eligible. On operator1's next login `reviveOwnedSubmittedQueueOnLogin` also only scans live rows, finds nothing owned by them, and the work dies on the device: no `log_sheet_void_submissions` row, no `SUPERSEDE` action, while the PWA still shows a plausible-looking "واگذار شده به اپراتور دیگر" from the archive display. Confirmed on log sheet id 1 (`a.saljooghi` claimed → offline completion → offline logout → supervisor takeover+reassign → `a.mahmoodi` completed on the same device: zero server trace of operator1). **Fix:** the outbound queue now also drains owned archived completions — `getArchivedSubmissionsPendingServerOutcome` (`services/storage/logSheetArchive.ts`) + `SyncManager.getPendingArchivedLogSheets`. Two details that matter: (a) the archived snapshot keeps the *original* `localId`, which after a takeover collides with the live row now owned by someone else, so archived entries are submitted under `archivedLogSheetViewId(serverId, userId)` and their results routed back via `parseArchivedLogSheetViewId` → `updateArchivedLogSheetSnapshot`, never `updateLogSheet`; (b) `syncedAt` is the resolution marker (set on **any** definitive server outcome) so a permanently-rejected push is not retried on every sync forever — `syncStatus`/`serverStatus` are only rewritten when the work was actually *accepted*, because `loadLogSheetsForSessionUser` treats `serverStatus === 'SUBMITTED'` on an archive as "this user's own completed work" and would otherwise show a voided submission as successful. A live row for the same sheet always wins, so nothing is submitted twice. Verified live end-to-end (void row created with operator1's real payload + `SUPERSEDE` logged under operator1, and repeated syncs produce exactly one void row). Regression tests: `logSheetArchive.test.ts`.
- **A `mark-synced` bundle refresh must archive local work before overwriting it, or a half-filled draft is destroyed the moment the operator reopens it.** Separate symptom, separate trigger from the two above — here the operator never hit final submit at all. Sequence: operator fills a few assets (draft with `localOwnerUserId` set by `handleSaveEntry`, no submit) → supervisor takes the sheet over and it gets completed by someone else → operator returns. `reconcileInboxRevocations` correctly marks the draft `failed`/`REVOKED`, and at that point History shows it properly with the operator's values intact. **Then they open it** — and `LogSheetFillPage`'s `canRefreshBundle` fires an `applyLogSheetBundle` for *any* `status === 'draft'` row, so `alignLocalWorkflowWithServer` sees `serverSheet.status === 'SUBMITTED'` and returns `'mark-synced'`. That branch used to: (a) replace the entries with the server's — `shouldPreserveLocalFormData` returns false because the server assignee is now someone else, so **their readings are overwritten by the other operator's**; (b) flip the row to `submitted`/`synced`, making the History chip read "ارسال شده" as if they had submitted it (false attribution); (c) take **no** archive, unlike the `reset-draft` branch — and even delete an existing one via `removeArchivedLogSheet`. Because the row is then `synced`, `cleanupLocalLogSheets` deletes it entirely 24h later, so the work is gone with no copy anywhere. Reproduced live end-to-end (`DATA-OF-OPERATOR-1`/`61` → `DATA-OF-OPERATOR-2`/`12` on reopen; row absent from History after the 24h purge). **Fix:** `shouldArchiveBeforeServerOverwrite(existing, preserveLocal)` (`utils/logSheetWorkflow.ts`) gates an `archiveLocalWorkBeforeClear(existing)` call at the top of the `mark-synced` branch. Three subtleties, each of which broke a first attempt: (1) it returns false once the row is already `submitted`+`synced`, otherwise a **second** pass (StrictMode double-effect, a concurrent inbox refresh, or simply reopening later) re-archives the row and **overwrites the good snapshot with the other operator's data** — this actually happened in testing and is easy to miss; (2) the live row must have `localOwnerUserId` cleared when archiving, because `loadLogSheetsForSessionUser` deletes any archive whose live row is owned-by-this-user *and* `submitted`+`synced` as a "stale duplicate" — without clearing it, the snapshot is silently purged the next time History renders; (3) `removeArchivedLogSheet` stays gated on `preserveLocal` (their own confirmed submission), **not** on `!discardsLocalWork` — the latter looks equivalent but still deletes the snapshot on the next pass, once the row is reconciled and there is nothing left to archive. Net result: the operator keeps a permanent, view-only History entry with their own values (archives are exempt from all retention rules), and the live row correctly mirrors the other operator's completion.
  - **Known minor residual gap (not fixed, low severity):** `ensureLocalLogSheet`'s non-bundle-refresh fallback branch (taken when `refreshBundleOnline` is false, i.e. the caller believes it's offline) calls `serverSheetMetadataPatch` directly on the existing local sheet, bypassing the guard above — `applyLogSheetBundle` is never reached on this branch. In practice this is a no-op: the `serverSheet` it patches from is the *stale* cached inbox entry from before any reassignment reached this device, so it just reassigns the same values back. Only becomes a real risk if a genuinely fresher (but still locally-cached, not server-fetched) `ServerLogSheet` reflecting a reassignment is ever passed into `ensureLocalLogSheet` while offline — not currently reachable from any caller. If a new caller starts passing fresher inbox data through this path, add the same `status==='submitted' && syncStatus==='pending'` early-return here too.

### NFC fill page

- Tag id = **NDEF text payload** (`resolveNfcTagId`), not hardware UID.
- Lookup is **within current log sheet entries** only (offline-safe), through the single matcher `services/nfc/matchLogSheetEntry.ts`.
- **Strict serial mode** (`nfcStrictSerialMatch` setting, **default off**, admin-only toggle in Settings → NFC): off = Record 1 only, identical to the behaviour that predates the setting. On = Record 1 **and** the chip UID (`serialNumber`) must both match the entry's stored `nfcSerial` (AND, not OR); an asset with no stored serial is **rejected**, never waved through. Applies to real NFC scans only — manual tag entry and the fault-report fallback pass no serial and are deliberately unaffected. Serial comparison is case-insensitive with `:`/`-`/space stripped. `enrichEntriesWithNfc` backfills `nfcSerial` from the local asset table alongside `nfcTagId`.
- Edit dialog: NFC or allowed manual entry; tap card = **view-only**.
- **Manual tag entry** (type the tag instead of scanning): `canEnterTagManually()` in `src/types/auth.ts`. Unlocked by any of: the `allowManualEntry` app setting (applies to all roles), role `SUPERVISOR`/`SENIOR_OPERATOR` (**hardcoded**, not a revocable permission row), or the `GET:/log-sheets/{id}/fill` permission. Distinct from the fault-report unlock below: this still requires the typed value to match a real tag on the sheet; a fault report unlocks the form with no tag at all. Revoking `POST:/api/nfc-fault-reports/batch` from SENIOR_OPERATOR does **not** affect this — it comes from the role check, not that permission.
- **NFC fault reports** (`services/storage/nfcFaultReports.ts`): a per-entry, always-visible "اعلام خرابی NFC" report (works even when the asset never had a tag, not just after a failed scan) unlocks a manual-entry fallback for that one `(logSheetServerId, assetId)` pair, tracked locally in `LogSheetEntryData.filledVia` (`'nfc' | 'manual'`) and synced up via `POST /api/nfc-fault-reports/batch`. Only same-device self-filed reports unlock the button today — reports arriving from elsewhere (web-filed, other devices) are **not yet consumed** for auto-unlock by design (server already returns them in the bundle's `nfcFaultReports` field as groundwork; the PWA client type/parsing for that field doesn't exist yet — deliberate, not an oversight).
- **The "report NFC fault" icon itself is gated by `hasPermission(authSession, 'POST:/api/nfc-fault-reports/batch')`** (`LogSheetFillPage.tsx`'s `canReportNfcFault`) — a role/user without this permission never sees the icon at all, mirroring the sync layer's own `canSyncFaultReports` gate in `services/sync/index.ts`. This mirroring matters: without the UI-level gate, a user lacking the permission could still fill out and "submit" a report that gets saved locally and then sits forever with `syncStatus: 'pending'`, since the sync layer silently excludes it from every outbound batch — no error, just a report that never leaves the device. The already-unlocked "manual entry" button for an asset that already has a fault report is **not** gated by this permission (an existing unlock is data, not a new create action) — only the icon that opens the *create* dialog is.

### Session

- Offline: expired JWT still allowed locally (`isSessionValid`).
- Online + expired JWT → logout.
- Login always lands on `/` (no deep-link restore across users on shared devices).

### PWA / offline testing

- Install from **`preview:mobile` (:4173)** or production nginx — **not** from `dev:mobile` (:5173).

---

## Repository map (high signal)

```
src/
  App.tsx                 Routes; AdminRoute for /settings and /nfc-inspect.
                          /master-data/*, /logsheet-templates, /admin and /records
                          redirect to / (managed in the web panel, not here)
  pages/
    LogSheetListPage.tsx    active | history inbox
    LogSheetFillPage.tsx    NFC, fill, submit, revert/recheck
    Dashboard.tsx           open sheets / submitted today / pending sync;
                            links to logsheets
    LoginPage.tsx           username + password → JWT session
    SettingsPage.tsx        admin only — serverUrl, sync interval, allowManualEntry,
                            nfcStrictSerialMatch (admin-only switch)
    NfcInspectPage.tsx      admin + online only — raw tag JSON, asset lookup,
                            bind scanned chip UID to the asset's nfcSerial
  services/
    api/index.ts            all REST types + endpoints
    api/client.ts           serverUrl vs window.origin → relative /api
    storage/db.ts           Dexie v1 schema (single version) + openDatabase()
    storage/index.ts        log sheets, settings, reference-data slices, …
    storage/inboxCache.ts   syncMeta inboxSnapshot
    storage/logSheetArchive.ts  logSheetUserArchives
    storage/nfcFaultReports.ts  NFC fault report create/query/sync-status
    sync/
      pullBootstrap.ts
      pullInbox.ts
      mergeLogSheetBundle.ts
      logSheetSync.ts       ensureLocalLogSheet, applyLogSheetBundle, batch payload
      index.ts              SyncManager singleton
    auth/sessionContext.ts  shared tablet isolation
  hooks/
    useInboxSync.ts         pullAndMergeInbox + auto refresh
    useMasterDataSync.ts    bootstrap pull (legacy name; bootstrap only)
    useSync.ts              SyncManager lifecycle
  types/auth.ts             roles, permissions, canEnterTagManually
  utils/logSheetStatus.ts   history/active chips, revert rules, expiry
  i18n/fa.ts                UI strings (import { t } from '@/i18n')
```

Path alias: `@/*` → `src/*`.

---

## IndexedDB (Dexie v1)

`services/storage/db.ts` declares **one** `this.version(1)` block. The app has never shipped, so the historical versions were collapsed into it — there is no upgrade path because there is no production data. A dev device still holding the pre-collapse database (IndexedDB version 110) cannot open a `version(1)` declaration; `openDatabase()` catches that `VersionError` and recreates the database. When the schema next changes, **add** `this.version(2).stores({...})` with the full store list rather than editing the version(1) block.

| Table | Role |
|-------|------|
| `logSheets` | Local work + entries + sync fields + `assigneeUserId` |
| `logSheetUserArchives` | Per-user archived snapshots (shared tablet history) |
| `nfcFaultReports` | Locally-filed NFC fault reports (`logSheetServerId`, `assetId`, sync fields, `createdByUserId` for shared-tablet outbound scoping) |
| `operationalUnits` | From bootstrap |
| `assetClasses`, `assetEntries`, `fieldDefinitions`, hierarchy tables | **Per-sheet bundle slices**, not full plant |
| `settings` | `serverUrl`, `syncIntervalMs`, `allowManualEntry`, `nfcStrictSerialMatch` |
| `syncMeta` | `authSession`, `sessionUserId`, `inboxSnapshot`, `lastBootstrapAt`, … |
| `outbox` | Generic pending-write queue |

### Local retention (`services/sync/cleanupLogSheets.ts`)

Runs after every successful sync pass; deletes from `logSheets` only, never from the
server. Constants live at the top of that file — check them there before quoting numbers.

| Local state | Retention | Anchor (first non-null) |
|---|---|---|
| Synced | **24h** (`SYNCED_RETENTION_MS`) | `syncedAt` → `submittedAt` → `updatedAt` → `createdAt` |
| Failed | **7d** (`FAILED_RETENTION_MS`) | `submittedAt` → `updatedAt` → `createdAt` |
| Expired draft | **24h** (`EXPIRED_DRAFT_RETENTION_MS`) | `dueAt` → `updatedAt` → `createdAt` |
| Active draft | never | — |
| Submitted + pending sync | never (waits for a server outcome) | — |
| `logSheetUserArchives` | **never** — not touched by cleanup at all | — |

Two consequences worth internalizing before changing any of this: (1) flipping a row to
`synced` silently shortens its life to 24h, which is why the `mark-synced` gotcha above
had to take an archive copy — the archive is the only storage exempt from retention;
(2) an archive is removed **only** by `removeArchivedLogSheet` (when that user's own work
for the sheet is confirmed synced), so anything parked there is effectively permanent —
do not use it as a scratch buffer.

---

## API surface (client)

Types and functions: **`src/services/api/index.ts`**.

| Endpoint | Use |
|----------|-----|
| `POST /api/auth/login` | JWT + roles + permissions |
| `GET /api/bootstrap` | Units (+ JSON context not all stored client-side) |
| `GET /api/log-sheets/inbox` | Kartabl |
| `GET /api/log-sheets/{id}/bundle` | Refresh one sheet |
| `POST /api/log-sheets/{id}/claim` | Pickup → bundle |
| `POST /api/log-sheets/batch` | Push completed sheets |
| `POST /api/nfc-fault-reports/batch` | Push locally-filed NFC fault reports |
| `GET /api/asset-entries/nfc/{nfcTagId}` | Admin NFC inspect page — online asset lookup |
| `POST /api/asset-entries/{id}/nfc-serial` | Admin NFC inspect page — bind scanned chip UID to an asset |

**`LogSheetBundleDto`:** `{ sheet, entries, context }` — context holds scoped locations…fieldDefinitions.

**Production URL model:** `VITE_SERVER_URL` / Settings should match **PWA origin** (e.g. `https://192.168.1.4`); nginx proxies `/api` to Spring. See README Production Deployment.

---

## Roles (frontend checks)

| Role | Mobile UI |
|------|-----------|
| `OPERATOR` | Log sheets, NFC; manual tag only if Settings allow |
| `SENIOR_OPERATOR` | + manual tag always; web fill permission |
| `SUPERVISOR` | + team inbox, assign/release/reassign |
| `ADMIN`, `HIGH_USER` | + Settings and the NFC inspect page. Master data, the asset registry and log-sheet templates are **not** managed in the PWA — those live in the web admin panel. |

Helpers: `isAdminRole`, `isSupervisorRole`, `hasPermission`, `canEnterTagManually` in `src/types/auth.ts`.

---

## Coding conventions for agents

1. **Minimal diffs** — match surrounding style; no drive-by refactors.
2. **RTL** — UI is Persian; use MUI + existing `t` keys in `fa.ts` for new user-visible strings.
3. **IDs** — use `toIdString()` from `src/utils/ids.ts` when comparing server/local ids.
4. **Log sheet status** — use `src/utils/logSheetStatus.ts` for chips, history vs active, expiry, revert eligibility.
5. **Field validation** — warning/danger JSON mirrors backend; soft limits in `src/utils/fieldValidation.ts`.
6. **Tests** — colocate `*.test.ts`; run `npm test`. App build excludes tests from `tsconfig.json`.
7. **No commits** unless the user explicitly asks.
8. **Backend changes** — belong in `backend-offline-first`; keep API contract in sync with `src/services/api/index.ts`.

### Common pitfalls

| Mistake | Why it hurts |
|---------|----------------|
| Full master-data sync on login | Breaks selective bundle architecture, storage, performance |
| Cross-user batch sync on shared tablet | Ownership errors, false synced state, audit failure |
| Using Spring URL in `VITE_SERVER_URL` on nginx deploy | CORS/origin mismatch; tablets should hit PWA origin + proxy |
| Installing PWA from :5173 | Offline white screen (no full precache) |
| NFC lookup via global API on fill page | Design is local entry match; offline requirement |
| Assuming `useMasterDataSync` pulls assets | It only triggers bootstrap staleness pull |
| Counting `useLogSheets()` directly for per-user stats | The device's table holds **every** signed-in user's work — scope it with `utils/dashboardStats.ts` |
| Putting a sign-out reason in router location state | `ProtectedRoute`'s own `<Navigate>` overwrites it; use the `sessionEnded` store flag |
| Declaring one PNG `purpose: "any maskable"` | Android crops it to its own mask — ship a separate maskable file, see README **App Icon** |

---

## When you change…

| Change | Also verify |
|--------|-------------|
| Dexie schema | Bump version in `db.ts`, migration, README + this file |
| New API endpoint | `api/index.ts`, backend permission codes, README API table |
| Inbox/bundle merge | `mergeLogSheetBundle.ts`, `logSheetSync.ts`, integration behavior offline |
| New field on `LogSheetEntryData` | Check whether it must survive `mapServerEntryToLocal` (see "Log sheet merge" gotcha above) — local-only fields need an explicit `preserveLocal ?` line or they vanish on the next bundle refresh |
| Auth/session | `sessionContext.ts`, `useAuth.ts`, shared tablet tests |
| Manual NFC policy | `auth.ts`, `LogSheetFillPage.tsx`, Settings + `fa.ts` |
| Production deploy | `.env.mobile.example`, README nginx section |

---

## Related documentation

| Doc | Audience |
|-----|----------|
| **`README.md`** | Full setup, mkcert, nginx, troubleshooting, workflow narrative |
| **`backend-offline-first`** | Server validation, RBAC, bundle generation, batch ownership |

If README and code disagree, **trust the code** and fix README in the same task.

---

## Behaviour notes worth knowing

**Field definitions belong to a sheet, not to a class.** The server derives a bundle's
`context.fieldDefinitions` from that sheet's own `log_sheets.field_definitions_snapshot` —
frozen at generation time — not from the live class schema. Two sheets of the same asset class
therefore *can* carry different field sets, and will as soon as anyone edits that class while
an older sheet is still open. The client used to store them in one shared table keyed by
`classId` and **delete every row for a class before writing the bundle's rows**, so merging
sheet B could thin the schema sheet A was being filled with (A loses a field it legitimately
has; its stored `formData` survives, but the operator can no longer see or edit that value).

The fix has two halves. `LogSheet.fieldDefinitions` carries the bundle's definitions on the
sheet record — a plain property, **no Dexie schema change**, cleaned up with the sheet, and
mirroring the server's own per-sheet freeze. And `upsertFieldDefinitionsForBundle` no longer
deletes: the shared table is now a best-effort fallback for sheets stored before that field
existed, where a lingering stale row is harmless but a deleted row another sheet needs is not.

Read through `sheetFieldDefinitions(sheet, classId, fallback)` — never `getFieldsForClass`
directly — anywhere a sheet is in scope; both the fill dialog and the completion badge use it,
so the badge can never disagree with the form. One rule inside is easy to get backwards: when a
sheet has definitions but **none for the requested class**, return empty rather than the
fallback. "This class is not part of this sheet" is a real answer, and falling back there would
show another sheet's schema — the exact bug. Tests: `utils/sheetFieldDefinitions.test.ts`.


**`sessionUserId` may be unresolved, and everything user-scoped must cope.** Login binds it from
`GET /api/bootstrap`, but that call can fail on its own — a server restart in the window right
after the token was issued, a network blip, or the session being superseded from another device.
Login still succeeds (this is an offline-first app; refusing entry because one call failed would
lock an operator out of work already on the device), so the session can be **authenticated but
unbound**, and `ensureSessionUserId()` in `services/auth/sessionContext.ts` is what heals it.

Why it matters: `isLogSheetOutboundOwnedByUser` and `shouldPreserveLocalFormData` both return
false for a null id — correctly, since an unnamed session owns nothing. The first is harmless
(sync pushes nothing) but *silent*; the second is destructive (inbox merge treats the operator's
own typed values as somebody else's and lets the server overwrite them). So while unbound:

- `SyncManager.executeSync` calls `ensureSessionUserId()` and **returns early** if still null.
- `pullAndMergeInbox` calls it and **skips `mergeInboxIntoLocalSheets`** — the lists still render,
  because they are read-only.
- `sessionBindingPending` in the store drives a banner, so a device that is sending nothing never
  looks healthy again.

`ensureSessionUserId()` is idempotent and one IndexedDB read once bound, which is why it is safe
to call on every sync tick and inbox refresh — that repetition *is* the recovery mechanism.
**Never run `isolateSheetsNotOwnedBy` with a null id**: every owned sheet matches
`owner !== userId`, so it would archive the whole device's work and fail its drafts on the
strength of a bootstrap hiccup. `activateUserSession` now guards that, and the isolation is
deferred into `ensureSessionUserId()` where the identity is actually known. Tests:
`services/auth/ensureSessionUserId.test.ts` and `utils/unboundSessionGuards.test.ts` (the latter
is the tripwire — if either predicate ever returns true for a null id, the gating above becomes
wrong).


**Dashboard counters are per-viewer.** `utils/dashboardStats.ts` is the single rule:
your own work only — *including for supervisors*, whose team's work belongs in the
inbox's team tab — with ADMIN / HIGH_USER alone seeing the device-wide totals. A
non-admin with no resolved `sessionUserId` sees zeros rather than the device's
numbers, which is the honest answer since local sheets arrive already attributed.
`SyncManager.getPendingCount()` was already user-scoped and is reused as-is. The
stat row uses a plain CSS grid, not `<Grid container>`: MUI's negative margins
pushed the last card past the content box on a wide tablet with no way to scroll
it back.

**Involuntary sign-out is signalled through the store, not the router.** Two
navigations race to `/login` — the unauthorized handler's imperative
`navigate(..., { state: { sessionEnded: true } })` and `ProtectedRoute`'s
`<Navigate to="/login" state={{ from }} />`, which fires the moment the session is
cleared and clobbers the reason. The `sessionEnded` flag in the auth store survives
either ordering. Two things feed it: a 401 from the server, and
`client.ts`'s `sessionSilentlyExpired()` — `getAuthSession()` deletes an expired
session as a side effect of *reading* it, leaving a UI that still believes it is
signed in, so the client checks for that and reports it without a pointless round
trip. **Backend counterpart:** the API security chain must keep
`.cors(Customizer.withDefaults())`; CORS used to be configured through
`WebMvcConfigurer.addCorsMappings`, which Spring MVC applies and therefore never
runs for a 401 written by the security filter — the browser blocked the response
and an expired session surfaced as "could not reach the server".

**There is no operator-name setting any more.** `operatorName` / `locationName`
were removed: `locationName` was referenced nowhere, and `operatorName` fed two
fallbacks that are now taken from the authenticated session instead — the fault
report's `reportedByName` and `logSheetSync`'s `operatorName` fallback. On a shared
tablet the old behaviour attributed every operator's work to whatever name an admin
typed once.

---

## Known issue (not fixed yet): failed submissions have no correction path

**The earlier issue asked for a retry button. That is the wrong fix — do not build it.**

A retry would re-send the identical payload and get the identical rejection, while telling the
operator "trying again…". That is worse than the current dead end: it manufactures false hope,
hides the real problem, and risks a false success if the stale `clientActionId` is reused (the
server's replay guard would report the submission as already processed).

Two findings that reframe the problem:

1. **Transient failures never reach `syncStatus = 'failed'`.** Network drops, server down and
   5xx all throw before any per-sheet outcome is read, leaving sheets `pending`; the sync timer
   already retries them. Automatic retry exists.

2. **`failed` only means the server answered and said no.** All four `ERROR` branches in
   `LogSheetService.submitBatch` are deterministic and payload-based:
   - `serverId == null` (client bug)
   - `Log sheet not found on server` (deleted server-side)
   - `Asset(s) not part of this log sheet` (stale bundle / data mismatch)
   - **field validation failed against the sheet's frozen `field_definitions_snapshot`**

Only the fourth is operator-fixable — and not by retrying, but by **editing the values**. It is
also reachable in normal use, because `canSubmitLogSheet` on the client checks lifecycle state
only (cancelled / expired / already submitted) and never validates field values before final
submit. So an operator can submit a sheet the server will reject, then stand at the equipment
reading the exact Persian validation error with no available action.

**Proposed fix**

- *Prevention (primary):* gate final submit on client-side field validation. The pieces already
  exist — `sheetFieldDefinitions` and `evaluateEntryCompletion` — they are just not wired into
  `canSubmitLogSheet`. This removes the case almost entirely and surfaces the problem before the
  work gets stuck.
- *Cure (safety net):* allow "revert to draft and correct" for a sheet that failed validation,
  i.e. relax the `offline-only` and `syncStatus === 'pending'` conditions in
  `canRevertSubmittedLogSheetToDraft` for that case only. Resubmitting after an edit is
  legitimate because the data actually changed. **Must mint a fresh `clientActionId`** — see
  `resolveReopenedSheetUpdates` for why.
- The other three outcomes stay supervisor/admin territory (reopen or extend). An operator
  cannot fix a deleted sheet or an asset mismatch and should not be given a control implying
  they can.

Keep `SUPERSEDED` / `EXPIRED` / `CANCELLED` / `REVOKED` / `REASSIGNED` non-recoverable as today.
