# AGENTS.md — AI agent guide (offline-first-pwa)

This file orients coding agents on **this repository only**: the **offline-first PWA** (React + Vite + Dexie). Human-oriented setup and deployment details live in **`README.md`**.

| Item | Value |
|------|--------|
| License | GPL-3.0-or-later — Copyright (C) 2026 hadi_hnp |
| UI language | Persian (RTL); agent docs in English |
| Backend (separate repo) | `backend-offline-first` — Spring Boot, default **8081** |
| Typical backend path (local) | `D:\LocalStorage\Project\JavaProject\backend-offline-first` |
| Primary user journey | Log sheets (inbox → fill → local submit → batch sync), **not** legacy DataRecords |

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
4. **Push** — `SyncManager`: `POST /api/log-sheets/batch` for submitted sheets owned by current user; optional `POST /api/records/batch` if permission.

There is **no** `pullMasterData` / full plant dump in the current design. Do not reintroduce without explicit product approval.

### Layering rules

- **Prefer** adding API calls in `src/services/api/index.ts` and DB access in `src/services/storage/index.ts`.
- **Hooks** (`useInboxSync`, `useSync`, `useLogSheets`, …) orchestrate services.
- **Exceptions today:** `LogSheetListPage.tsx` and `LogSheetFillPage.tsx` call API directly for claim/release/assign and online bundle refresh — follow existing pattern if extending those flows.

---

## Critical invariants (do not break)

### Shared tablets (`src/services/auth/sessionContext.ts`)

- Outbound sync sends **only** log sheets where `assigneeUserId` matches **logged-in** user (`isLogSheetOutboundOwnedByUser`).
- **Never** sync another user’s pending submissions when someone else is logged in (audit + server rejection).
- User switch: clear inbox snapshot, isolate/archive other users’ local rows, mark others’ unsynced submitted as `REVOKED` locally until assignee returns.
- Do not “helpfully” push all pending rows on any login.

### Log sheet merge

- Bundle context merge: **server wins** (`mergeLogSheetBundle.ts` / `mergeBundleContextToDb`).
- Inbox assigned bundles **pre-provision** assets, NFC ids, field defs — operators should fill offline after one online inbox sync.
- `operatorName` / `assigneeUserId` on local sheets come from **server** inbox/bundle metadata, not stale local guesses.
- **`mapServerEntryToLocal` (in `mergeLogSheetBundle.ts`) rebuilds each `LogSheetEntryData` from an explicit field list** — it does not spread `...existing`. Any **local-only** field on `LogSheetEntryData` (one the server DTO doesn't carry, e.g. `filledVia`) must be explicitly threaded through here (`preserveLocal ? existing?.field : undefined`, matching the `createdAt`/`updatedAt` pattern) or it is silently dropped on every bundle refresh — not just cross-device sync, but simply **reopening a draft sheet while online** (`LogSheetFillPage`'s `canRefreshBundle` load-effect calls `applyLogSheetBundle` unconditionally for online draft sheets). Found the hard way: an entry manually completed via an NFC fault report lost its `filledVia: 'manual'` marker the next time the operator reopened the sheet before final submit, so the server received no `manualEntry` flag and defaulted `entry_source` to `PWA_NFC` despite no scan ever happening. Regression tests: `mergeLogSheetBundle.test.ts`.

### NFC fill page

- Tag id = **NDEF text payload** (`resolveNfcTagId`), not hardware UID.
- Lookup is **within current log sheet entries** only (offline-safe).
- Edit dialog: NFC or allowed manual entry; tap card = **view-only**.
- Manual entry: `canEnterTagManually()` in `src/types/auth.ts` (settings flag, SUPERVISOR, SENIOR_OPERATOR, or `GET:/log-sheets/{id}/fill` permission).
- **NFC fault reports** (`services/storage/nfcFaultReports.ts`): a per-entry, always-visible "اعلام خرابی NFC" report (works even when the asset never had a tag, not just after a failed scan) unlocks a manual-entry fallback for that one `(logSheetServerId, assetId)` pair, tracked locally in `LogSheetEntryData.filledVia` (`'nfc' | 'manual'`) and synced up via `POST /api/nfc-fault-reports/batch`. Only same-device self-filed reports unlock the button today — reports arriving from elsewhere (web-filed, other devices) are **not yet consumed** for auto-unlock by design (server already returns them in the bundle's `nfcFaultReports` field as groundwork; the PWA client type/parsing for that field doesn't exist yet — deliberate, not an oversight).

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
  App.tsx                 Routes; AdminRoute for /settings
  pages/
    LogSheetListPage.tsx    active | history inbox
    LogSheetFillPage.tsx    NFC, fill, submit, revert/recheck
    Dashboard.tsx           stats (legacy DataRecord counts); links to logsheets
    AdminPage.tsx           master-data CRUD (admin only; operators use bundles)
    SettingsPage.tsx        admin only — serverUrl, sync interval, allowManualEntry
    RecordsPage.tsx         legacy — NOT routed (/records → /)
  services/
    api/index.ts            all REST types + endpoints
    api/client.ts           serverUrl vs window.origin → relative /api
    storage/db.ts           Dexie v9 schema
    storage/index.ts        records, log sheets, settings, …
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

## IndexedDB (Dexie v10)

| Table | Role |
|-------|------|
| `logSheets` | Local work + entries + sync fields + `assigneeUserId` |
| `logSheetUserArchives` | Per-user archived snapshots (shared tablet history) |
| `nfcFaultReports` | Locally-filed NFC fault reports (`logSheetServerId`, `assetId`, sync fields) — v10 |
| `operationalUnits` | From bootstrap |
| `assetClasses`, `assetEntries`, `fieldDefinitions`, hierarchy tables | **Per-sheet bundle slices**, not full plant |
| `settings` | `serverUrl`, `syncIntervalMs`, `allowManualEntry`, … |
| `syncMeta` | `authSession`, `sessionUserId`, `inboxSnapshot`, `lastBootstrapAt`, … |
| `records` | Legacy DataRecords (dashboard stats; optional batch sync) |

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
| `POST /api/records/batch` | Legacy records (permission-gated) |

**`LogSheetBundleDto`:** `{ sheet, entries, context }` — context holds scoped locations…fieldDefinitions.

**Production URL model:** `VITE_SERVER_URL` / Settings should match **PWA origin** (e.g. `https://192.168.1.4`); nginx proxies `/api` to Spring. See README Production Deployment.

---

## Roles (frontend checks)

| Role | Mobile UI |
|------|-----------|
| `OPERATOR` | Log sheets, NFC; manual tag only if Settings allow |
| `SENIOR_OPERATOR` | + manual tag always; web fill permission |
| `SUPERVISOR` | + team inbox, assign/release/reassign |
| `ADMIN`, `HIGH_USER` | + master-data, templates, Settings |

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
