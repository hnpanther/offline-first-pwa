# AGENTS.md — AI agent guide (offline-first-pwa)

This file orients coding agents on **this repository only**: the **offline-first PWA** (React + Vite + Dexie). Human-oriented setup and deployment details live in **`README.md`**.

## Where the detail lives

This file is conventions and traps. The references below are kept current with the code:

| Document | What it answers |
|---|---|
| **[docs/sync.md](docs/sync.md)** | The push sequence, every submission outcome, the separate attachment queue, conflict rules. |
| **[docs/storage.md](docs/storage.md)** | The Dexie schema, every store and index, and the rules for changing it. |
| **[docs/deployment.md](docs/deployment.md)** | nginx as a service (WinSW / systemd), TLS with mkcert or openssl, tablet CA install, and why TLS is not optional here. |
| **[docs/device-features.md](docs/device-features.md)** | NFC, camera, GPS, screen orientation — requirements and fallbacks. |
| **[README.md](README.md)** | Setup, mobile testing, deployment, troubleshooting. |
| **[CLAUDE.md](CLAUDE.md)** | The short entry point, and the rule below. |

> **Any change to sync, storage, a device feature or a user-visible behaviour updates the
> matching document in the same commit.** Documentation that lags the code is worse than none —
> it is confidently wrong, and the next reader will trust it. When you learn a trap by
> debugging, add it here with the *why*, not just the *what*.

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

- **A deadline is judged on `completedAt`, not on when the sync happened — and `EXPIRED` is not final.** The device keeps an on-time offline completion queued however late the link returns (`isLogSheetExpiredForSync`), and the server accepts it even against an already-`EXPIRED` sheet (`submitIfStillCompletable`: `dueAt >= completedAt`, with `EXPIRED` in `COMPLETABLE_STATUSES`). Both halves are required — drop either and every round walked out of coverage is lost to the expiry scheduler, which is the exact scenario this app exists for. Two consequences that look like bugs and are not: a submission rejected as `EXPIRED` while the two sides disagreed is **re-queued** by the next inbox merge if the device can prove it finished in time, with a **fresh `clientActionId`** (the old one was already answered, so reusing it reads as a replay); and a genuinely late completion is deliberately **not** revived, because it would be pushed and refused on every pass forever. A draft has no completion to date it by, so it is judged on the wall clock. Regression tests: `logSheetLifecycle.test.ts` here, `completedBeforeDueAcceptedEvenWhenServerMarkedExpired` / `lateCompletionAfterExpiryStaysExpired` on the server.
- **`extend` un-expires *and* un-cancels; the merge is what applies that to the device.** A supervisor extending an `EXPIRED` or `CANCELLED` round returns it to the inbox with a future deadline, and `mergeInboxIntoLocalSheets` clears the failure and hands the sheet back **with the operator's readings still in it** — never wiped, because a cancel and an expiry are both reopenable. The gate is `dueAt > now` **and** `serverStatus !== 'EXPIRED'`: a future date alone is not an extension. And absence from the inbox carries no reason — released, reassigned and cancelled are indistinguishable — so `shouldMarkDraftRevokedForMissingInbox` blocks the draft either way but never overwrites a `CANCELLED` the row already knows about with the vaguer wording.
- Bundle context merge: **server wins** (`mergeLogSheetBundle.ts` / `mergeBundleContextToDb`).
- Inbox assigned bundles **pre-provision** assets, NFC ids, field defs — operators should fill offline after one online inbox sync.
- `operatorName` / `assigneeUserId` on local sheets come from **server** inbox/bundle metadata, not stale local guesses.
- **`mapServerEntryToLocal` (in `mergeLogSheetBundle.ts`) rebuilds each `LogSheetEntryData` from an explicit field list** — it does not spread `...existing`. Any **local-only** field on `LogSheetEntryData` (one the server DTO doesn't carry, e.g. `filledVia`) must be explicitly threaded through here (`preserveLocal ? existing?.field : undefined`, matching the `createdAt`/`updatedAt` pattern) or it is silently dropped on every bundle refresh — not just cross-device sync, but simply **reopening a draft sheet while online** (`LogSheetFillPage`'s `canRefreshBundle` load-effect calls `applyLogSheetBundle` unconditionally for online draft sheets). Found the hard way: an entry manually completed via an NFC fault report lost its `filledVia: 'manual'` marker the next time the operator reopened the sheet before final submit, so the server received no `manualEntry` flag and defaulted `entry_source` to `PWA_NFC` despite no scan ever happening. Regression tests: `mergeLogSheetBundle.test.ts`.
- **"Does this device hold work for this asset?" cannot be answered from `formData`, and both attempts to do so lost data — in opposite directions.** `mapServerEntryToLocal` decides `localWins`, and it has been wrong twice. **Key presence** (`Object.keys(localForm).length > 0`) counted a blank as work: the server's web fill form posts every field of **every entry** on every save, so one supervisor save turned all 40 entries of a sheet from `{}` into `{"Bar": "", "Status": ""}`, the device then won every asset in that sheet forever, an operator handed a reopened sheet could not see the readings a supervisor had just entered, and their next submit sent the blanks back and destroyed them (log sheet 85, whose wiped rows still carry `entry_source = WEB` and a `filled_by_user_id` over nothing). **Value presence** (`hasEntryFormData`) fixed that and failed twice more. A *deliberate clear* reads as no work, so the next periodic sync restored the value the operator had just removed, before they could submit. And — the failure that removed it from the expression entirely — **it cannot tell a value this device entered from a value this device was sent.** After any sync the local copy holds the server's own readings, so value presence is true for every filled entry on the device from then on, whoever filled it: a supervisor correcting a reading in the browser reached a device that had already decided it owned the entry, the correction never appeared, and the device's next submit wrote the stale value back over it. Neither predicate is faulty — both are the wrong question, because the data looks identical whichever way it arrived. The opinion is therefore **recorded when it is formed**: `locallyEditedAt`, stamped by `applyOperatorEntrySave` on every save including one that empties the entry, and set by nothing that receives from the server. `localWins` is now that single condition. Rows written by builds older than the marker are handled **once**, by the `version(2)` migration in `db.ts` — a bounded migration and deliberately not a permanent `|| hasEntryFormData(...)`, because an OR arm that only matters for old rows still runs on every merge forever and carries the correction-losing failure with it. Three things will break this if changed carelessly: (1) **never express the clear by bumping `updatedAt`** — `createdAt`/`updatedAt` are the base this device echoes to the server, and `wouldBlankUnseenAnswer` compares them for equality, so moving them makes the server refuse every deliberate clear; (2) the marker must be **threaded explicitly** through `mapServerEntryToLocal`, which rebuilds from a field list and does not spread `...existing` (same trap as `filledVia`); (3) `createdAt`/`updatedAt`/`filledByName` follow `localWins`, not `preserveLocal` — the side that won the values owns them, or the device tells the server it is working from a base it never held. Regression tests: `serverCorrectionWins.test.ts` (the whole sequence — sync, edit elsewhere, sync, submit — end to end, and the one that fails if the OR arm comes back), `mergeLogSheetBundle.test.ts`, `localEditMarker.test.ts`, `preMarkerEntryMigration.test.ts`, `entryTimestamps.test.ts`, and `ReopenedSheetSupervisorEntriesIntegrationTest` on the server.
- **A marker that outlives its submission is the first bug again.** `locallyEditedAt` is cleared when the server accepts the work (`SUBMITTED`/`DUPLICATE`) and whenever a row is reset — `clearLocalEditMarkers` in `utils/logSheetLocalData.ts` — **and** `applyLogSheetBundle` ignores markers on a row that is already `submitted` + `synced`. Two mechanisms on purpose, because the first has a hole that is easy to reintroduce: the fill page's «ادامه‌ی کار» calls `resetLogSheetToOpenDraft` **without** `clearEntryFormData` (correctly — the same operator is continuing their own work), and that turns a delivered row back into a draft, re-arming the gate for anything left behind. Regression: `localEditMarker.test.ts` exercises each mechanism separately so neither can quietly stop working behind the other.
- **A locally pending, unsynced completion (`status:'submitted', syncStatus:'pending'`) must never be resolved by a bundle refresh — only the batch-submit outcome may resolve it.** `applyLogSheetBundle` (`services/sync/logSheetSync.ts`) now returns such a sheet completely untouched, before even calling `alignLocalWorkflowWithServer`. The bug: any code path that fetches a fresh bundle for that specific sheet (`ensureLocalLogSheet({refreshBundleOnline:true})`, used when opening a sheet from the list, or claim/release refreshes) would call `alignLocalWorkflowWithServer`, which — for this exact local state — returned `'reset-draft'` (server still open, reassigned to someone else: archives + wipes local entries, sets a fake local `REASSIGNED` error) or `'mark-synced'` (server already `SUBMITTED` by someone else: blindly marks the local pending submission `synced`, discarding it with **no error at all**). Neither path ever contacts the actual submit endpoint, so the server's `voidSubmission()` never runs — the operator's completed work vanishes with no `log_sheet_void_submissions` row and no `SUPERSEDE` action logged, even though the PWA shows a "این کار به اپراتور دیگری واگذار شده است" message that looks like a real server response. Confirmed against a real user report (log sheet id 23: `a.saljooghi`'s NFC fault report synced fine — that path has no such gate — but their actual completion left zero trace server-side). Fixed by short-circuiting `applyLogSheetBundle` before any bundle-driven mutation of a submitted-pending sheet, and simplifying `alignLocalWorkflowWithServer` to return `null` immediately for that state — deferring entirely to the outbound sync queue (`syncManager.sync()` → `LogSheetService.submitOne()`), which already correctly resolves SUBMITTED/DUPLICATE/SUPERSEDED-with-void. Verified live twice: (1) replaying the exact sequence (claim → offline completion pending sync → supervisor takeover+reassign while still open → bundle refresh) leaves the local sheet's status, entries, and `assigneeUserId` completely unchanged, and the next outbound sync attempt then correctly reaches the server and produces a `SUPERSEDE` action + `log_sheet_void_submissions` row with the operator's real payload intact; (2) the NFC fault-report leak fix above was independently re-verified with a cleaner methodology (genuinely offline creation, explicit session switch, then explicit online sync — no reliance on an ambient background sync interval that can otherwise race a naive repro into a false negative). Regression tests: `logSheetWorkflow.test.ts`.
  - **Second, independent root cause for the same "no void record" symptom — the archive dead end.** The guard above only protects a completion still reachable from the live `logSheets` row. It does nothing once the row has been handed to a different user, which is exactly what happens when the operator **logs out while still offline**: (1) `signOut` → `clearUserSessionContext()`; (2) operator2 logs in → `activateUserSession` → `isolateSheetsNotOwnedBy` → `archiveLogSheetForUser` copies operator1's completed work into `logSheetUserArchives` and marks the live row `failed`/`REVOKED`; (3) operator2 opens the sheet → `applyLogSheetBundle` → `alignLocalWorkflowWithServer` returns `'reset-draft'` (syncStatus is now `'failed'`, not `'pending'`, so the guard above does not fire) → `resetLogSheetToOpenDraft({clearEntryFormData:true})` **wipes the live row's entries and `clientActionId`**; (4) operator2 completes and syncs. Operator1's work now exists **only** in the archive — and `getPendingLogSheets()` read exclusively from `getAllLogSheets()`, so archives were never sync-eligible. On operator1's next login `reviveOwnedSubmittedQueueOnLogin` also only scans live rows, finds nothing owned by them, and the work dies on the device: no `log_sheet_void_submissions` row, no `SUPERSEDE` action, while the PWA still shows a plausible-looking "واگذار شده به اپراتور دیگر" from the archive display. Confirmed on log sheet id 1 (`a.saljooghi` claimed → offline completion → offline logout → supervisor takeover+reassign → `a.mahmoodi` completed on the same device: zero server trace of operator1). **Fix:** the outbound queue now also drains owned archived completions — `getArchivedSubmissionsPendingServerOutcome` (`services/storage/logSheetArchive.ts`) + `SyncManager.getPendingArchivedLogSheets`. Two details that matter: (a) the archived snapshot keeps the *original* `localId`, which after a takeover collides with the live row now owned by someone else, so archived entries are submitted under `archivedLogSheetViewId(serverId, userId)` and their results routed back via `parseArchivedLogSheetViewId` → `updateArchivedLogSheetSnapshot`, never `updateLogSheet`; (b) `syncedAt` is the resolution marker (set on **any** definitive server outcome) so a permanently-rejected push is not retried on every sync forever — `syncStatus`/`serverStatus` are only rewritten when the work was actually *accepted*, because `loadLogSheetsForSessionUser` treats `serverStatus === 'SUBMITTED'` on an archive as "this user's own completed work" and would otherwise show a voided submission as successful. A live row for the same sheet always wins, so nothing is submitted twice. Verified live end-to-end (void row created with operator1's real payload + `SUPERSEDE` logged under operator1, and repeated syncs produce exactly one void row). Regression tests: `logSheetArchive.test.ts`.
- **A `mark-synced` bundle refresh must archive local work before overwriting it, or a half-filled draft is destroyed the moment the operator reopens it.** Separate symptom, separate trigger from the two above — here the operator never hit final submit at all. Sequence: operator fills a few assets (draft with `localOwnerUserId` set by `handleSaveEntry`, no submit) → supervisor takes the sheet over and it gets completed by someone else → operator returns. `reconcileInboxRevocations` correctly marks the draft `failed`/`REVOKED`, and at that point History shows it properly with the operator's values intact. **Then they open it** — and `LogSheetFillPage`'s `canRefreshBundle` fires an `applyLogSheetBundle` for *any* `status === 'draft'` row, so `alignLocalWorkflowWithServer` sees `serverSheet.status === 'SUBMITTED'` and returns `'mark-synced'`. That branch used to: (a) replace the entries with the server's — `shouldPreserveLocalFormData` returns false because the server assignee is now someone else, so **their readings are overwritten by the other operator's**; (b) flip the row to `submitted`/`synced`, making the History chip read "ارسال شده" as if they had submitted it (false attribution); (c) take **no** archive, unlike the `reset-draft` branch — and even delete an existing one via `removeArchivedLogSheet`. Because the row is then `synced`, `cleanupLocalLogSheets` deletes it entirely 24h later, so the work is gone with no copy anywhere. Reproduced live end-to-end (`DATA-OF-OPERATOR-1`/`61` → `DATA-OF-OPERATOR-2`/`12` on reopen; row absent from History after the 24h purge). **Fix:** `shouldArchiveBeforeServerOverwrite(existing, preserveLocal)` (`utils/logSheetWorkflow.ts`) gates an `archiveLocalWorkBeforeClear(existing)` call at the top of the `mark-synced` branch. Three subtleties, each of which broke a first attempt: (1) it returns false once the row is already `submitted`+`synced`, otherwise a **second** pass (StrictMode double-effect, a concurrent inbox refresh, or simply reopening later) re-archives the row and **overwrites the good snapshot with the other operator's data** — this actually happened in testing and is easy to miss; (2) the live row must have `localOwnerUserId` cleared when archiving, because `loadLogSheetsForSessionUser` deletes any archive whose live row is owned-by-this-user *and* `submitted`+`synced` as a "stale duplicate" — without clearing it, the snapshot is silently purged the next time History renders; (3) `removeArchivedLogSheet` stays gated on `preserveLocal` (their own confirmed submission), **not** on `!discardsLocalWork` — the latter looks equivalent but still deletes the snapshot on the next pass, once the row is reconciled and there is nothing left to archive. Net result: the operator keeps a permanent, view-only History entry with their own values (archives are exempt from all retention rules), and the live row correctly mirrors the other operator's completion.
  - **Known minor residual gap (not fixed, low severity):** `ensureLocalLogSheet`'s non-bundle-refresh fallback branch (taken when `refreshBundleOnline` is false, i.e. the caller believes it's offline) calls `serverSheetMetadataPatch` directly on the existing local sheet, bypassing the guard above — `applyLogSheetBundle` is never reached on this branch. In practice this is a no-op: the `serverSheet` it patches from is the *stale* cached inbox entry from before any reassignment reached this device, so it just reassigns the same values back. Only becomes a real risk if a genuinely fresher (but still locally-cached, not server-fetched) `ServerLogSheet` reflecting a reassignment is ever passed into `ensureLocalLogSheet` while offline — not currently reachable from any caller. If a new caller starts passing fresher inbox data through this path, add the same `status==='submitted' && syncStatus==='pending'` early-return here too.

- **A delivered completion the supervisor reopened is detected by the merge but only resumed by an explicit, server-verified action — never by the merge itself.** After `POST /log-sheets/{id}/reopen` the sheet is `IN_PROGRESS` again with a new deadline and its entries intact, so it returns to the operator's assigned inbox and the ordinary merge writes the fresh `serverStatus`/`dueAt` onto a row that stays `submitted`/`synced`. That otherwise-impossible combination *is* the flag (`isReopenedAfterSync` in `utils/logSheetStatus.ts`); `alignLocalWorkflowWithServer` was deliberately **not** touched and still returns `null` for a synced row whose assignee has not changed. The reason the merge must not act on it: the inbox response it is merging may have been read from the server *moments before this device's own submission landed*, so a sheet that was just completed can legitimately appear open in it — reopening on that basis would hand the operator an editable sheet the server had already closed, and the resubmit would come back `DUPLICATE`/`SUPERSEDED` (which `isInvalidLocalLogSheet` treats as terminal — "غیرقابل ادامه"). The fill page's «ادامه‌ی کار» therefore re-fetches the bundle and re-checks it with `canContinueReopenedLogSheet` (`utils/logSheetWorkflow.ts`) before anything local changes; a fetch issued while the row is already `synced` **cannot** see a pre-submit state, because that stamp is only written after the server committed the completion. Three details that will break it if changed carelessly: (1) the resume is `resetLogSheetToOpenDraft` **then** `applyLogSheetBundle` — reversed, the bundle apply hits the `synced` short-circuit and the button silently does nothing; (2) the reset must run **without** `clearEntryFormData` and without an archive — this is the same operator continuing their own work, not losing it, unlike the `reset-draft` branch; (3) `cleanupLogSheets` skips such a row while its new deadline stands, because the local row is both where the action lives and the only place `filledVia` survives (see the `mapServerEntryToLocal` bullet above — a re-downloaded copy would re-stamp a manually-filled asset as `PWA_NFC` on the next edit). Worth knowing operationally: reopening clears the server's `submitted_at`/`draft_saved_at`, so a reopened sheet nobody resubmits **expires** instead of reverting to `SUBMITTED`. Regression tests: `logSheetStatus.test.ts`, `logSheetWorkflow.test.ts`, `services/sync/reopenedLogSheet.test.ts`.

### NFC fill page

- Tag id = **NDEF text payload** (`resolveNfcTagId`), not hardware UID.
- Lookup is **within current log sheet entries** only (offline-safe), through the single matcher `services/nfc/matchLogSheetEntry.ts`.
- **The sync interval is stored in milliseconds and shown in seconds — convert on exactly one side.** The Settings field converted seconds→ms in its `onChange` *and* the submit handler converted again, so every save multiplied the stored interval by 1000, including a save where nobody touched the field: 30 seconds became 30,000 and grew from there until sync effectively stopped. Conversion now lives only in `services/settings/syncInterval.ts`, and `clampSyncInterval` runs on the way to storage — `<input type="number">` returns `''` for an empty box (`Number('') === 0`, a zero-delay sync loop) and the form carries `noValidate`, so `min`/`max` are never enforced by the browser.
- **`screen.orientation.lock()` failures are reported, not swallowed.** The app still degrades to free rotation in every case, but an administrator who picks Landscape and watches the tablet keep rotating cannot otherwise tell a browser that refuses from a setting that did not save. `applyScreenOrientation` returns an outcome and Settings states it. The reason worth separating is `notInstalled`: Chrome refuses to lock a page in a normal tab regardless of the manifest, and "Add to Home screen" can produce a shortcut that still opens a tab — which looks installed to whoever did it. The lock is also re-applied on `visibilitychange`, because Android drops it when a PWA is backgrounded and restored from the task switcher, which is how the app is used all shift.
- **Scan failures are deliberately opaque.** Missing Record 1, a serial mismatch and an asset with no recorded serial all show one message (`t.logSheet.nfcVerificationFailed`). Naming which check failed hands whoever is holding the tag a map of how verification works, and the operator's next step — tell an administrator — is the same in all three cases. Only "valid tag, not on this sheet" stays specific: that is a routing mistake the operator can fix and it reveals nothing. Keep that distinction if you add outcomes to `matchLogSheetEntryByTag`.
- **Strict serial mode** (`nfcStrictSerialMatch` setting, **default on**, admin-only toggle in Settings → NFC): off = Record 1 only, identical to the behaviour that predates the setting. The default is strict because Record 1 alone can be cloned onto any blank tag, so the serial is what makes "I scanned the right asset" mean something; an admin can relax it per device while serials are still being recorded. Changing the default affects **new installations only** — `getSettings()` spreads the stored row over `DEFAULT_SETTINGS`, so a device that already saved a choice keeps it and no tablet changes behaviour mid-shift. On = Record 1 **and** the chip UID (`serialNumber`) must both match the entry's stored `nfcSerial` (AND, not OR); an asset with no stored serial is **rejected**, never waved through. Applies to real NFC scans only — manual tag entry and the fault-report fallback pass no serial and are deliberately unaffected. Serial comparison is case-insensitive with `:`/`-`/space stripped. `enrichEntriesWithNfc` backfills `nfcSerial` from the local asset table alongside `nfcTagId`.
- Edit dialog: NFC or allowed manual entry; tap card = **view-only**.
- **A blocking loader unmounts everything below it, including an open asset form and every unsaved value in it.** `LogSheetFillPage` returned a full-page spinner for any `loading`, and `loading` was set by the load effect, which listed `redirectIfNotAccessible` among its dependencies. That callback closes over `inboxAssignedIds`, rebuilt from a **new array** on every inbox pull — so every sync pass that refreshed the inbox re-ran a full sheet load, bundle fetch included, purely because a function's identity changed. React then discarded the whole subtree: the dialog vanished and came back a moment later, still open, rebuilt from the `activeEntry` snapshot taken when it was first opened, with the operator's typed readings, selections and freshly captured photo references gone and nothing on screen to say so. Reproduced live on a reconnect: text field `77` → empty, two photo previews → zero, `formData.Pic.ids` saved as `[]` while the uploaded files sat on the server referenced by nothing. Four rules now hold, and all four are load-bearing: (a) `shouldShowFullPageLoader` blocks only when the sheet on screen is not the sheet being asked for, so a refresh never blanks the page — a plain "have I loaded once" boolean would wrongly keep the previous sheet visible when switching sheets; (b) the load effect reads the accessibility check through a **ref** and depends on `hasAuthSession` rather than the session object, so identity churn is never a reason to reload — routine server updates belong to the `inboxLastSyncAt` effect, which never touches `loading`; (c) the dialog re-initialises only when it opens or the asset changes (`needsFormInitialisation`), never because an unrelated prop changed; (d) in-progress values are mirrored into a `FormDraftCache` **owned by the page**, which survives what the dialog does not, so any future unmount restores instead of losing — dropped on save and on cancel, and cleared when the page moves to another sheet, since keys are asset ids and an asset appears in many sheets. Regression tests: `pageLoadState.test.ts`, `formDraftCache.test.ts`.
- **Manual tag entry** (type the tag instead of scanning): `isManualTagEntryAllowed()` in `src/types/auth.ts` — the server policy `nfcManualEntryEnabled` **AND** `canEnterTagManually()` (the `GET:/log-sheets/{id}/fill` permission). Never an OR: the policy only ever restricts, so off means nobody may type a tag. Both values, plus the effective answer for the signed-in user, are listed read-only on Settings → سیاست‌های سرور; showing only the policy there was misleading, because an admin whose own account lacks the permission would read «فعال» and go hunting for a bug in the fill screen. The hardcoded `SUPERVISOR`/`SENIOR_OPERATOR` role branch was removed: every role holding it also holds that permission, so the branch was redundant — and being keyed to a role name meant a duplicated role did not inherit it. Distinct from the fault-report unlock below: this still requires the typed value to match a real tag on the sheet; a fault report unlocks the form with no tag at all. Revoking `POST:/api/nfc-fault-reports/batch` from SENIOR_OPERATOR does **not** affect this — manual entry follows `GET:/log-sheets/{id}/fill`, a different permission.
- **NFC fault reports** (`services/storage/nfcFaultReports.ts`): a per-entry, always-visible "اعلام خرابی NFC" report (works even when the asset never had a tag, not just after a failed scan) unlocks a manual-entry fallback for that one `(logSheetServerId, assetId)` pair, tracked locally in `LogSheetEntryData.filledVia` (`'nfc' | 'manual'`) and synced up via `POST /api/nfc-fault-reports/batch`. Only same-device self-filed reports unlock the button today — reports arriving from elsewhere (web-filed, other devices) are **not yet consumed** for auto-unlock by design (server already returns them in the bundle's `nfcFaultReports` field as groundwork; the PWA client type/parsing for that field doesn't exist yet — deliberate, not an oversight).
- **The "report NFC fault" icon itself is gated by `hasPermission(authSession, 'POST:/api/nfc-fault-reports/batch')`** (`LogSheetFillPage.tsx`'s `canReportNfcFault`) — a role/user without this permission never sees the icon at all, mirroring the sync layer's own `canSyncFaultReports` gate in `services/sync/index.ts`. This mirroring matters: without the UI-level gate, a user lacking the permission could still fill out and "submit" a report that gets saved locally and then sits forever with `syncStatus: 'pending'`, since the sync layer silently excludes it from every outbound batch — no error, just a report that never leaves the device. The already-unlocked "manual entry" button for an asset that already has a fault report is **not** gated by this permission (an existing unlock is data, not a new create action) — only the icon that opens the *create* dialog is.

### Session

- Offline: expired JWT still allowed locally (`isSessionValid`).
- Online + expired JWT → logout.
- Login always lands on `/` (no deep-link restore across users on shared devices).

### Attachments (photo / audio fields)

- `formData` holds **ids only** — `{type:'attachment', ids:[…]}`. Never inline bytes; base64
  in a sheet’s form data would ride along on every read, sync and backup.
- Media **never** goes inside `POST /api/log-sheets/batch`. It has its own queue
  (`sync/attachmentSync.ts`), uploaded one file at a time, so a dropped connection costs one
  photo rather than the whole shift’s readings. The pass has its own try/catch: an attachment
  failure must never fail a submission that already succeeded.
- **The attachment queue sends only the signed-in operator's own work, and that filter is the whole defence on a shared tablet.** Signing out removes the session key and nothing else — every sheet, blob and queue row stays, deliberately, because it is the only copy of the work. The log-sheet queue has always filtered by owner (`isLogSheetOutboundOwnedByUser`); the attachment queue did not, and the gap was live: operator 1 worked offline, photographed the equipment, signed out still offline; operator 2 from another unit signed in and came online; the pass pushed operator 1's files under operator 2's token; the server refused each with **403**, which was then classified permanent — so the files were **parked**, and when operator 1 returned the queue no longer offered them at all. Evidence that cannot be re-recorded, lost because a colleague picked up the tablet. Four rules now hold: (a) `isAttachmentUploadableByUser` gates uploads *and* server-side deletions — unprovable ownership is a refusal, and a synced sheet is judged the same way (this is the case `isolateSheetsNotOwnedBy` leaves alone by design, and it is exactly what leaked); (b) **403 is excluded from `isPermanentFailure`** alongside 401/408/409 — it describes who was signed in, not the file, and stops being true when the owner returns; (c) the HTTP status is stored on the row (`failedStatus`), because `syncError` is the backend's own translated prose and cannot be classified afterwards; (d) sign-in revives the owner's parked rows whose status was 403 **or absent** — absent means parked by a build predating the field, which is precisely the stranded population, and a genuinely bad file re-parks at a cost of one request. The pending badge counts the filtered set too, or a shared tablet shows a number that can never reach zero. Regression tests: `attachmentOwnership.test.ts`.
- A row without `logSheetServerId` is **skipped, not failed** — the server keys an attachment
  to a log sheet, so there is nowhere to put it until the sheet syncs and
  `bindAttachmentsToServerSheet` stamps the id.
- `ApiError` status 0 (transport dead) leaves the row **untouched** and stops the pass. Marking
  it failed would make a tunnel look like a rejection.
- **Deleting an attachment has to reach the server, or the per-field ceiling drifts out of reach forever.** The server counts *its own* rows for `(logSheetId, assetId, fieldKey, kind)`; the device used to count only its own and delete only locally ("the server copy is left alone deliberately"). One delete was enough to make the two disagree permanently: the field showed a free slot, the server refused the next capture, and — because the refusal was a 4xx — the replacement was parked for good. With audio and video (ceiling **1**) a single retake locked the field. The fix has three parts and all three are load-bearing: (a) a delete on an **unsubmitted** sheet is carried to the server (`markAttachmentPendingDelete` → `drainPendingDeletes`), while on a **submitted** sheet it stays local — delivered evidence must survive someone tidying a tablet, and a sheet with no local row is treated as submitted; (b) the ceiling is counted from `getAttachmentsForEntry`, i.e. **every** row for that asset+field, not the ones the current form value happens to reference — a photo added from the web panel or another device counts on the server and must count here; (c) the server answers **409** (not 400) for "field is full", and `isPermanentFailure` excludes it, because that refusal stops being true the moment a slot frees. Deletions drain **before** uploads in the same pass, so a replacement taken after a delete is accepted immediately instead of waiting for the next tick. `pendingDelete` is a plain non-indexed property (no Dexie version bump) and every read path filters it out, so the file disappears for the operator the instant they tap delete even with no network. **The decision of which path a delete takes is read from IndexedDB, never from the component's `items`** — `removeAttachment(id)` in `storage/attachments.ts` re-reads the row itself, and that is the entire reason the function exists. The upload queue flips rows to `synced` in the background, so a photo taken a minute earlier is routinely already on the server while the last render still says `pending`; deciding from that snapshot took the local-only path and orphaned the server's copy — recreating the exact divergence this mechanism removes. The unit tests missed it because they called the marker directly; only a live run caught it. Never add a variant that accepts the row as an argument. Regression tests: `attachmentDelete.test.ts`, and `AttachmentApiIntegrationTest` on the server side.
- A **permanent** refusal (4xx other than 401/408) sets `permanentFailure` and the row leaves
  the queue for good — `getPendingAttachments` filters it out. Classifying a failure without
  parking it is pointless: the file would simply be re-sent on every pass forever. The bytes
  are kept and `retryFailedAttachment` is the manual way back in.
- Compress before storing (`utils/mediaCapture.ts`) and always `revokeObjectURL` — both are
  load-bearing on a tablet that sits on one screen for a whole shift.
- **Photo and audio need different permissions.** `<input capture>` needs none (it hands off to
  the OS camera app); `getUserMedia` needs the microphone permission. Once denied, Chrome never
  prompts again — so `utils/mediaPermissions.ts` checks the Permissions API *before* calling and
  shows how to re-enable it, instead of surfacing a raw `DOMException.message` with nothing to
  click. Never show `err.message` from a media call directly.
- `required` from react-hook-form cannot be used on a media field: its value is an object and
  every object is truthy. `buildValidationRules` counts ids instead.
- **Counts and durations are server-owned.** They arrive on `/api/bootstrap` and land in
  `settings.attachmentLimits`. The device must never write them: `SettingsPage` shows them
  read-only to admins and explicitly re-sends the stored value on submit, so a stale form cannot
  overwrite a ceiling a bootstrap just refreshed. A missing/failed bootstrap keeps the last
  known values — offline capture has to work against *some* rules.
- **`settings.nfcStrictSerialMatch` and `settings.imageAnnotationEnabled` are server-owned too, and arrive together in `mobilePolicy`.** Same rules as the ceilings: applied in the *same* `saveSettings` write as `attachmentLimits` (two read-modify-write passes would race and the second would win with its own stale snapshot), never written from `SettingsPage`, and left untouched when a server sends no `mobilePolicy` — resetting to defaults there would silently re-enable a step an admin switched off, or hand a device a scan rule nobody chose. Both are `app_settings` rows edited in the web panel's Settings page (`nfc.strict_serial_match`, `attachments.image_annotation_enabled`), **not properties** — a scan rule that needs a redeploy to change is useless to a site whose serials are not recorded yet and whose every scan is being rejected right now. Their **defaults are ON and the fallback on an unreadable row is ON**, deliberately: a garbled or missing value must never be the thing that quietly downgrades an integrity rule. `bootstrapLimits.test.ts` pins the client half, `AppSettingsServiceTest` the server half.
- **Manual tag entry is `canEnterTagManually(session)` — permission only, no second argument.** The `allowManualEntry` device switch that used to sit beside it granted the ability to *every* caller, so anyone who could open the tablet's Settings screen could let a whole shift type tags instead of scanning them. Do not reintroduce an override parameter; `auth.test.ts` has a regression case that calls it with a legacy truthy second argument and asserts it changes nothing. **A tablet provisioned before this change still has `allowManualEntry: true` sitting in its stored settings row** — `getSettings()` spreads the saved row over the defaults, so the dead key survives. It is inert because nothing reads it, and it is deliberately not migrated away (no Dexie version bump for a value with no readers) — but never reintroduce a read of that key, or those devices would silently come back with manual entry granted to everyone. Confirmed present on a real device during the live run of this change.
- **The annotation step runs on the output of `compressImage`, never on the camera's `File`.** This is the whole reason marks land where the operator drew them: the compressed bitmap is what gets stored either way, so preview and bake share one source. `createImageBitmap(file)` is called without `imageOrientation`, so EXIF handling can differ between what a preview shows and what a later decode produces — annotate the raw file and every mark is rotated off its target on exactly the devices whose cameras set the EXIF flag. Related invariants in `ImageAnnotationDialog`: the canvas needs `touch-action: none` or the first stroke of every session scrolls the dialog instead of drawing; `setPointerCapture` keeps a stroke alive when a finger leaves the canvas, which is routine on a phone; `ctx.direction = 'rtl'` is required before `fillText` or a mixed Persian/English label comes out reordered; and `await document.fonts.ready` before baking, because unlike the live preview the baked pixels cannot be repainted once the real font loads. Confirming with no marks must return the **original blob** — re-encoding an untouched photo costs a second lossy generation for nothing. Nothing is written to IndexedDB until the operator confirms, so cancelling leaves no orphan row and no orphan blob. Regression tests: `imageAnnotation.test.ts`.
- **Propagation is not instant, by design.** `useMasterDataSync` throttles bootstrap to once an
  hour, so an admin's change can lag that long on a running app. A **fresh sign-in forces a pull**
  (`pullBootstrapIfStale(0)`, keyed on the session) precisely so there is a reliable way to apply
  a change now. Do not lower the hourly throttle to "fix" this — the server enforces the limits
  anyway, so the lag costs a wrong number on screen, not wrong data. The staleness comparison is
  **`>=`, not `>`**, and that is load-bearing: `maxAgeMs = 0` means *force*, but with `>` the
  forced pull would decline to fetch whenever no measurable time had passed since the previous
  one, so the "force" silently did nothing on a fast path. `bootstrapLimits.test.ts` pins it.
- **Video size is set at capture time and nowhere else** (`startVideoRecording`): 480p, 700 kbps,
  plus a hard byte ceiling checked on every `ondataavailable`. `MediaRecorder` needs a timeslice
  (`start(1000)`) for that check to run at all — without one the event fires once at the end,
  far too late to stop anything. The client ceiling sits below the server's so the device
  truncates rather than the server rejecting the whole clip.

### PWA / offline testing

- Install from **`preview:mobile` (:4173)** or production nginx — **not** from `dev:mobile` (:5173).
- Camera and microphone need **HTTPS** — they silently fail over plain HTTP.

---

### Progress reporting is a queue of its own, and must stay one

An open round reports what it has recorded so a supervisor can see how far it has got
(`sync/progressSync.ts`, `POST /api/log-sheets/progress`). Three rules hold it together, and each
of them is the difference between a useful feature and a data-loss bug:

1. **It never writes the submit queue's fields.** `status`, `syncStatus` and `syncError` belong to
   the delivery of finished work. A progress report is best-effort — losing one costs nothing,
   because the readings are still on the device and still deliverable — so it records its outcome
   on `progressSyncStatus` / `progressError` and nowhere else. Writing the submit fields from here
   is how real, undelivered readings would end up marked failed by a server that merely said "you
   no longer hold this sheet".
2. **It sends only what changed**, filtered on `locallyEditedAt`, and **clears that marker
   conditionally**. Clearing every marker loses an edit made while the request was in flight;
   clearing none makes the device win those entries on every future merge, so a supervisor's
   correction never reaches the tablet — gotcha #87 by a third route. The payload build snapshots
   each marker; only entries still holding that exact value are cleared, and the row is re-read
   after the response rather than reused.
3. **Ownership is checked the same way the submit queue checks it.**
   `isLogSheetProgressOwnedByUser` mirrors `isLogSheetOutboundOwnedByUser` with `status` inverted.
   A tablet is shared and its rows outlive a sign-out; pushing a colleague's draft publishes one
   person's readings under another person's name.

It is deliberately **not** in the pending badge: that number means "work not yet on the server",
and a round being walked always has some, so counting it would show a badge that cannot reach zero
for the whole shift. Regression: `progressSync.test.ts`.

---

## Repository map (high signal)

```
src/
  App.tsx                 Routes; PermissionRoute for /settings and /nfc-inspect.
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
    storage/db.ts           Dexie v2 schema + openDatabase()
    storage/index.ts        log sheets, settings, reference-data slices, …
    storage/inboxCache.ts   syncMeta inboxSnapshot
    storage/logSheetArchive.ts  logSheetUserArchives
    storage/nfcFaultReports.ts  NFC fault report create/query/sync-status
    storage/attachments.ts  attachment CRUD, pending query, blob retention,
                            reference parsing (attachmentIdsOf / buildAttachmentRef)
    sync/
      pullBootstrap.ts
      pullInbox.ts
      mergeLogSheetBundle.ts
      logSheetSync.ts       ensureLocalLogSheet, applyLogSheetBundle, batch payload
      attachmentSync.ts     separate one-at-a-time media upload queue
      index.ts              SyncManager singleton
    auth/sessionContext.ts  shared tablet isolation
  hooks/
    useInboxSync.ts         pullAndMergeInbox + auto refresh
    useMasterDataSync.ts    bootstrap pull (legacy name; bootstrap only)
    useSync.ts              SyncManager lifecycle
  types/auth.ts             roles, permissions, canEnterTagManually
  utils/logSheetStatus.ts   history/active chips, revert rules, expiry
  utils/mediaCapture.ts     photo compression + audio recording (size limits live here)
  utils/storageQuota.ts     persist() request + free-space guard before capture
  i18n/fa.ts                UI strings (import { t } from '@/i18n')
```

Path alias: `@/*` → `src/*`.

---

## IndexedDB (Dexie)

**`this.version(1)` in `services/storage/db.ts` is the operational baseline and is CLOSED — same rule as the backend's `V1__initial_schema.sql`.** It is on tablets in the field. IndexedDB cannot open a database at a version below the one that created it, and Dexie compares declared stores against what is on disk, so editing that block does not migrate those devices — it makes their database unopenable, `openDatabase()` refuses to start rather than delete, and every tablet holding unsynced readings is stranded. Every change from here is a **new** `this.version(2).stores({...})` repeating the full store list verbatim (a store omitted from a later version is dropped). Purely additive versions need no `.upgrade()`; one that reshapes rows does, and it runs on a device holding real work. Adding a plain non-indexed property needs no bump at all. `dbSchema.test.ts` pins the store list, the sync-critical indexes, the primary keys **and the version number** — it is meant to fail when you add a version, so the decision is written down rather than shipped as a side effect.

| Table | Role |
|-------|------|
| `logSheets` | Local work + entries + sync fields + `assigneeUserId` |
| `logSheetUserArchives` | Per-user archived snapshots (shared tablet history) |
| `nfcFaultReports` | Locally-filed NFC fault reports (`logSheetServerId`, `assetId`, sync fields, `createdByUserId` for shared-tablet outbound scoping) |
| `attachments` | Captured photos / voice notes as native `Blob`s, plus upload state. The row **outlives the blob**: bytes are reclaimed 7 days after upload, metadata stays |
| `operationalUnits` | From bootstrap |
| `assetClasses`, `assetEntries`, `fieldDefinitions`, hierarchy tables | **Per-sheet bundle slices**, not full plant |
| `settings` | `serverUrl`, `syncIntervalMs`, `allowManualEntry`, `nfcStrictSerialMatch` |
| `syncMeta` | `authSession`, `sessionUserId`, `inboxSnapshot`, `lastBootstrapAt`, … |

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
| Synced, then reopened by a supervisor (`isReopenedAfterSync`) | never while `dueAt` is still ahead; the ordinary rules resume once it passes | — |
| `logSheetUserArchives` | **never** — not touched by cleanup at all | — |
| `attachments` (bytes) | **7d after upload** (`ATTACHMENT_RETENTION_MS`, in `storage/attachments.ts`); the row survives and the file re-fetches on demand | `uploadedAt` → `createdAt` |
| `attachments` (rows) | dropped with their sheet — but **only the synced ones** (`deleteSyncedAttachmentsForLogSheet`); anything still queued keeps its own `logSheetServerId` and is still delivered | — |

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
| `POST /api/log-sheets/progress` | Report what an **open** round has recorded so far — never completes anything |
| `POST /api/nfc-fault-reports/batch` | Push locally-filed NFC fault reports |
| `GET /api/asset-entries/nfc/{nfcTagId}` | Admin NFC inspect page — online asset lookup |
| `POST /api/asset-entries/{id}/nfc-serial` | Admin NFC inspect page — bind scanned chip UID to an asset |

**`LogSheetBundleDto`:** `{ sheet, entries, context }` — context holds scoped locations…fieldDefinitions.

**Production URL model:** `VITE_SERVER_URL` / Settings should match **PWA origin** (e.g. `https://192.168.1.4`); nginx proxies `/api` to Spring. See README Production Deployment.

---

## UI gates (frontend checks)

**Never gate on a role name.** `src/types/auth.ts` has no role checks left, on purpose: a role
duplicated from `ADMIN` copies its permissions but gets a **new code**, so `roles.includes('ADMIN')`
turned the copy away from screens the server would happily serve it. Every gate now reads a
permission or a capability the server ships in `session.permissions`.

| Helper | Reads | Effective for |
|---|---|---|
| `hasPlantWideScope` | `CAP:SCOPE_PLANT_WIDE` | ADMIN, HIGH_USER |
| `canManageNfcSerial` | `POST:/api/asset-entries/{id}/nfc-serial` | ADMIN, HIGH_USER |
| `canAssignWork` | `POST:/api/log-sheets/{id}/assign` | ADMIN, HIGH_USER, SUPERVISOR |
| `canEnterTagManually` | app setting **or** `GET:/log-sheets/{id}/fill` | + SENIOR_OPERATOR |
| `hasPermission(session, PERM_NFC_FAULT_REPORT)` | `POST:/api/nfc-fault-reports/batch` | every field role |

Each replaced a role test with an **identical** grant set, so no seeded role changed behaviour.
Capabilities need no API change: the login response is built from the full authority set, so
`CAP:*` codes simply appear in `permissions`. Route guarding is `PermissionRoute` (was
`AdminRoute`), which takes a predicate rather than assuming "admin".

By role, the resulting UI is unchanged:

| Role | Mobile UI |
|------|-----------|
| `OPERATOR` | Log sheets, NFC; manual tag only if Settings allow |
| `SENIOR_OPERATOR` | + manual tag always; web fill permission |
| `SUPERVISOR` | + team inbox, assign/release/reassign |
| `ADMIN`, `HIGH_USER` | + Settings and the NFC inspect page. Master data, the asset registry and log-sheet templates are **not** managed in the PWA — those live in the web admin panel. |

> These are UI gates only; the server is authoritative. Hiding a control the server would allow
> misleads the operator just as much as showing one it would refuse — which is why the sets must
> match. Backend model: [backend `docs/security.md`](../../JavaProject/backend-offline-first/docs/security.md).

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
| Gating what may be **typed** on a field's warning/danger range | Ranges decide severity, nothing else. Tying the minus sign to "does some range have a negative minimum" made sub-zero readings unrecordable unless a threshold happened to be configured. Every `type === 'number'` field is signed, full stop |
| Reintroducing `validation.allowNegative` | It cannot survive: `FieldValidationSupport.build(...)` rebuilds the validation object from scratch on every field save with only `options`, `warning` and `danger`, and the backend has no such concept. A field that must not go negative gets a danger range with `min: 0` |
| Widening a numeric field's `inputMode` to get a minus key | `decimal` is what keeps the on-screen keyboard numeric. The `±` adornment exists precisely because that layout has no minus |
| Writing `fontFamily: 'monospace'` (or any bare generic) | That keyword resolves to whatever the **browser** names as its fixed-width font — a per-device setting, not a constant. Use `FONT_MONO` from `@/theme`; a generic is legal only as the last entry behind a font we ship |
| Adding `"Tahoma"` / `"Arial"` / `"Segoe UI"` to a stack | Not a courtesy fallback. Stacks resolve **per glyph**, so anything Vazirmatn does not cover is drawn by the device — and on Android neither Tahoma nor Arial exists, so it falls through again to the vendor's font. `noSystemFonts.test.ts` fails the suite |
| Assuming a saved **sync interval** is live | `useSyncManager` reads it once when `AppLayout` mounts and builds the `setInterval` from it. Saving Settings writes IndexedDB and does not rebuild the running timer, and the screen does not say so — the new period starts on the next app launch. Documented, not fixed |
| Expecting **Server URL** to change anything on a same-origin deployment | `getBaseUrl()` returns `''` when the configured origin equals `window.location.origin`, so requests go out relative and the field is inert. It matters only when page and API are on different origins |
| Changing **Server URL** without signing out | The stored session is untouched, so a token minted by the old server is sent to the new one |

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
| New field data type | `DynamicClassForm.tsx` (editable **and** read-only branches), `buildValidationRules`, backend `FormDataValidationSupport` + the field-type dropdown in `field-definitions.html` |
| Attachment behaviour | `storage/attachments.ts`, `sync/attachmentSync.ts`, `utils/mediaCapture.ts`, and the mirror-image rules in the backend’s `AttachmentService` |
| Progress reporting | `sync/progressSync.ts`, the `progress*` fields on `LogSheet`, `LogSheetFillPage`'s save handler, and the backend's `LogSheetService.saveProgressBatch`. **Never write `status` / `syncStatus` / `syncError` from that path** |
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

## Rejected submissions: prevent, then cure (built)

**A retry button was deliberately not built, and must not be added.** It would re-send an
identical payload for an identical refusal while showing "trying again…", and if it reused the
stale `clientActionId` the server's replay guard would answer "already processed" — a false
success on top of false hope.

Two facts shape the design:

1. **Transient failures never reach `syncStatus = 'failed'`.** Dropped links, server down and
   5xx all throw before any per-sheet outcome is read, so the sheet stays `pending` and the sync
   timer retries it. Automatic retry already exists; nothing to add.
2. **`failed` means the server answered and said no**, for one of four deterministic,
   payload-based reasons. Only one is operator-fixable, and not by retrying — by editing values.

| Server outcome | Cause | Operator can fix? |
|---|---|---|
| `ERROR` | no `serverId` (client bug) | No |
| `ERROR` | sheet deleted server-side | No — supervisor |
| `ERROR` | asset not part of this sheet | No — supervisor |
| **`VALIDATION_ERROR`** | required field empty per the sheet's frozen snapshot | **Yes** |

The distinct `VALIDATION_ERROR` outcome exists precisely so the app can tell them apart. It is
stored on the sheet as `lastSubmitOutcome` and read by `failedOnFieldValidation`.

### Prevention (primary)

`canSubmitLogSheet` now runs `findSubmitBlockingIssues` and refuses a submit the server would
certainly reject, naming the asset and field. The operator sees it while still on the form.

`src/utils/formDataValidation.ts` is a **deliberate transcription of the server's
`FormDataValidationSupport`**, not a reuse of `evaluateEntryCompletion`. The two disagree where
it matters: `isValueFilled` treats `false` and an emptied attachment reference as *filled*, both
of which the server calls blank — so a required unchecked checkbox sailed past the old check and
was rejected on arrival. That was the trap.

**The governing rule: never block a submission the server would have accepted.** A false block
strands the operator with no error from anyone and no way forward — strictly worse than the bug
being fixed. So every uncertain case resolves to *allow*: no field definitions for a class,
untouched entries, unknown data types. The server stays the authority.

One quirk worth knowing before "fixing" it: `isBlank` on the server tests `instanceof String`
*before* the checkbox branch, so the string `"false"` is **not** blank there. The mirror
reproduces that on purpose — diverging would block submissions the server accepts.

### Cure (safety net)

`canRevertSubmittedLogSheetToDraft` opens for `failedOnFieldValidation` sheets **online and from
`failed`**, relaxing the offline-only and `pending` conditions for that case alone. Resubmitting
after an edit is legitimate because the data actually changed. Expiry and cancellation still
close it — editing a sheet nobody can submit is wasted work.

`resetLogSheetToOpenDraft` **deletes `clientActionId`**, so the corrected resubmission is a new
action rather than a replay; the submit path mints a fresh one. It also clears `syncError` and
`lastSubmitOutcome` so the operator is not fixing fields under a red banner. Entry data and
`serverId` are kept — they are correcting one field, not repeating the round.

The other three outcomes stay supervisor territory, and `SUPERSEDED` / `EXPIRED` / `CANCELLED` /
`REVOKED` / `REASSIGNED` remain non-recoverable exactly as before.

## Recently hardened (do not undo)

### Requests have timeouts; they did not
`apiClient` wraps every `fetch` — JSON, multipart and blob — in `AbortSignal.any([callerSignal,
timeout])`. `REQUEST_TIMEOUT_MS` is 20s for JSON, `UPLOAD_TIMEOUT_MS` 120s for media.

This is not tidiness. `SyncManager` keeps the in-flight sync in **one shared promise** and hands
that same promise to every later caller (`syncInFlight`). With no timeout, a half-open
connection — an access point that dropped, a NAT that forgot the flow — left `fetch` pending for
as long as the OS allowed and every subsequent sync attached itself to that dead promise: no
sheets, no attachments, no error shown. On a plant network that is an ordinary Tuesday.

`isSyncing` and `syncInFlight` both reset in `finally`, so with every network await now
guaranteed to settle the deadlock is closed at the root. **A watchdog that force-clears
`syncInFlight` was considered and rejected** — it could let two syncs run at once, which is worse
than the problem.

### `openDatabase` never deletes unsynced work
On `VersionError` it used to `Dexie.delete` unconditionally, justified by a comment saying the
case was reachable "only on a dev device" — which stops being true the moment a second schema
version ships. It now counts rows in `logSheets` / `logSheetUserArchives` / `nfcFaultReports` / `attachments`
first and refuses (`DatabaseVersionMismatchError`) if any exist; `main.tsx` renders a plain-DOM
Persian screen telling the operator **not** to reinstall.

Two things to know:
- **Measured, a plain rollback does not reach that branch under Dexie 4** — opening a database
  created at a higher version succeeds and the rows are readable. The guard is for the cases
  that do reach it (concurrent version-change transaction, a different Dexie major, a browser
  unlike fake-indexeddb), where deleting unsynced work is the wrong answer whatever caused it.
- **The count is read through a separate schema-less `new Dexie(DB_NAME)` handle**, not through
  `db`. A first attempt counted through `db` — which had just failed to open — hit the catch on
  every store and reported "4 unsynced rows" for an empty database, i.e. it would have refused to
  start every tablet it was meant to protect. A unit test caught it; nothing in normal use would
  have, because the refusal looks identical either way.

### Entries show who filled them
`LogSheetEntryData.filledByName` comes from the server (`ServerLogSheetEntry.filledByName`) and is
displayed on the fill dialog and in the asset list. It exists for reopen-and-reassign: operator 2
opens a form already full of operator 1's readings — intended, they need to see what is there —
and without a name cannot tell which rows are theirs to redo.

The server re-attributes an entry **only when its value actually changes**, so the label keeps
naming the original operator until this operator edits that asset.

Two things about this were wrong at first and are worth not repeating:

- **Do not decide "did the server win?" with `formData === serverForm`.** After the first sync the
  local row already holds the server's values, so identity fails on every later refresh and the
  label vanished with nobody having edited anything. `mergeLogSheetBundle` names the condition
  (`localWins`) and both `formData` and `filledByName` read it.
- **The save path must clear the label.** It spread the previous entry and set only `filledVia`,
  so `filledByName` survived and the screen went on crediting operator 1 after operator 2 had
  rewritten the reading. That rule now lives in `applyOperatorEntrySave` (`utils/entryTimestamps`)
  — lifted out of the component precisely so it could be tested; it was three lines inside a
  `.map()` in a page with no test harness.

An unsent local draft keeps the stored name: it is the *save* that clears it, at the moment the
values become this operator's.

### Timeouts must survive a missing `AbortSignal.any`
`withTimeout` merges the caller's signal with the timeout, falling back to a hand-rolled
`mergeAbortSignals` when `AbortSignal.any` is absent. The first fallback returned the caller's
signal *alone*, which detached the timeout entirely — and `SyncManager` passes a caller signal on
essentially every request, so on any runtime without `AbortSignal.any` the timeout did nothing and
the shared-promise deadlock came straight back. A feature detection that disables the feature it
is detecting is not a fallback.

`withTimeout` is exported and tested directly, including with `AbortSignal.any` stubbed out. The
first version of that test reconstructed the behaviour instead — it asserted that
`AbortSignal.any` composes two controllers, which was true while the function under test was not
reaching that branch.

### Changing the server URL logs you out — and the order of the two writes is the point
`apiClient` attaches the current JWT to whatever URL settings hold, so pointing it elsewhere hands
this plant's bearer token to that host on the next request. `services/settings/serverUrl.ts`
validates the address (scheme, host, no path/query/fragment) and `requiresReauthentication`
decides from the **origin** — scheme, host and port, so a trailing slash or a case change is not a
re-login.

**Clear the session first, then write the address.** The original version saved the new URL and
*then* called `clearAuthSession()`, which left a window — short, but real, and widest on the slow
tablet where it matters — in which the new server and the old token were both live. `SyncManager`
runs on its own timers and does not wait for a settings save, so a push landing inside that window
sends this plant's bearer token to whatever host was just typed in. The sequence now lives in
`services/settings/applyServerUrlChange.ts` — `stopSync()` → `clearSession()` → `save()` →
`reload()` — extracted from the page for one reason: **an order that is a security property and
that nothing tests is only a comment.** `applyServerUrlChange.test.ts` asserts the *sequence*, not
merely that each step ran, plus the two failure paths (a save that throws must not reload; a
clear that throws must not write the address).

`checkServerUrl()` also returns the address **normalised** to `URL.origin`, and it is the
normalised value that gets stored — a trailing slash, surrounding whitespace or odd casing is
resolved once at the boundary rather than being carried into every request URL. Keep the
normalised value: storing the raw input re-opens the string-comparison bugs `origin` exists to
end.

### Push matches by `Map`, not by `.find()` in a loop
`services/sync/index.ts` resolves pending sheets and reports against the server's response. Both
lookups were `array.find()` **inside** the loop over the response, so the work grew with pending ×
returned — quadratic in exactly the case that matters, a tablet coming back after a shift offline
with a large backlog, on the slowest hardware in the deployment. Both are now a `Map` built once
before the loop (`pendingByLocalId`, `pendingReportsById`). The keys are the **exact values the
old `===` compared** — `logSheet.localId` and `report.id` against `result.localId`, no coercion
added — because a `Map` key is compared by `SameValueZero`, so keying on anything else turns a
speed-up into a silently wrong match. `app.sync.batch-max-items` is 500, so the worst case was
250,000 comparisons on the main thread of a tablet that is also rendering.

### Lint
`eslint.config.js` is flat config (ESLint 9); the `lint` script no longer passes `--ext`, which
flat config rejects. The gate was previously failing to start at all, so it contributed nothing.

Three findings are silenced with a targeted `eslint-disable-next-line` and a written reason
rather than by weakening a rule — and note the placement trap: the directive must sit on the line
*immediately* before the reported line, so put the explanation above it, not after it on
continuation lines. The three are two `exhaustive-deps` cases where following the rule would
change behaviour (re-fetching field definitions mid-edit; dropping the deps that make the inbox
callback new on reconnect) and one reserved empty interface in the store.

- **"The live copy wins" is only true when the live copy still has the work — ownership comes back, values do not.** A tablet holds one row per server sheet, so reassigning a sheet away clears that row (`reset-draft`) after archiving the operator's readings into `logSheetUserArchives`. `loadLogSheetsForSessionUser` decided whether to show the archive by asking `resolveLocalWorkOwner(liveRow) === userId` — ownership alone. When a supervisor assigned the sheet **back**, the operator owned the emptied row again, the archive was skipped as stale, and their readings became unreachable: still on disk, rendered nowhere, with one blank card in their list. Reproduced end to end before fixing. The condition now also requires `sheetHasLocalEntryData(liveRow)`, which is the distinction it always meant — a false revoke during sync leaves the values on the live row, a clear does not.<br><br>**Do not "improve" this into an automatic restore.** The archived entries carry `locallyEditedAt`, so copying them back would make them beat the server in the next merge and could bury whatever the other operator entered while they held the sheet — gotcha #87's failure by another route. The restore is **explicit**, per asset, with both versions in front of the operator: `restoreArchivedWork.ts`. Regression: `reassignRoundTrip.test.ts`, plus `liveReassignRoundTrip.test.ts` for the same sequence over real server bundles.

- **Restoring archived media means re-deriving the references from the device, never trusting the archive's own id list.** Attachment bytes live in `db.attachments`; `formData` holds only `{type:'attachment', ids:[…]}`. Clearing a reassigned sheet drops the ids and leaves every file — so the field renders empty while the files sit there, unreachable, and unlike a reading no amount of retyping brings a photograph back. `restoreArchivedWork.ts` therefore ignores what the archive says the ids were and writes exactly the rows the device holds for that (sheet, asset, field), minus `pendingDelete`, deduplicated. Three ways to get it wrong, each already covered by a test: **writing the archive's ids** leaves dangling references (broken slot, wrong counter) and hides a file another operator captured on the same tablet; **writing an empty `ids: []`** creates a key that means "nothing", which is gotcha #87's contamination exactly; **restoring the archived `createdAt`/`updatedAt`** tells the server the device is working from a base version it no longer holds, and `wouldBlankUnseenAnswer` then does the wrong thing. Stamp `locallyEditedAt` at restore time, keep the live row's `(createdAt, updatedAt)`, and never touch a blob — `restoreRoundTrip.test.ts` asserts the attachment table is unchanged byte for byte.

- **"Does the live row hold work?" is the wrong question once work can be restored one asset at a time — ask it per asset.** `loadLogSheetsForSessionUser` hides an archive when the live row this user owns already holds the work (gotcha above). That is a *sheet-level* test, and it was right until the explicit restore shipped: restoring one of two archived assets makes `sheetHasLocalEntryData(liveRow)` true, so the archived card disappeared — and with it the button for the second asset, which was left on disk and reachable from nowhere. The original bug, reintroduced one restore later. The condition now also asks `archiveHoldsWorkTheLiveRowLacks(archived, liveRow)`: is there an answered asset in the archive that the live row has nothing for? A **complete** restore still drops the card, which is the counterweight and is tested — keeping it would show the operator a permanent duplicate of what is already in front of them.<br><br>Worth noting how this was found: the unit test *"keeps the archive reachable after a partial restore"* passed, because `buildRestorePlan` did keep offering the asset. The plan was fine; the card that hosts the button was gone. **A green plan-level test says nothing about whether the operator can reach it.** Reproduced in a browser against a real 47-asset sheet, on the second pass of a two-pass restore.

- **`FieldDataType` is the wire contract, not the set of types this app draws — keep it complete.** The union listed six types while real bundles carried ten: `image`, `audio`, `video` and `location` were missing, so the types asserted a media field was impossible while `AttachmentFieldInput` and `LocationFieldInput` were rendering them. It stayed harmless only because every media branch tests the value through a helper taking a `string` (`attachmentKindForDataType`, `isLocationDataType`); a `case 'image'` written against the union would have been rejected as unreachable, and a "dead branch" cleanup would have deleted working code. `FormFieldType` carries the same ten for the same reason — `toFormField` copies `dataType` straight into it, and `DynamicFormField`'s `default` branch is the correct handling for the ones it does not draw, because `DynamicClassForm` routes media and location fields elsewhere first. The server's `FieldDataTypes` is the source; its `FieldDataTypesTest` parses this union and fails if the two drift.
