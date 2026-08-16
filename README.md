# Field Data Collection System — Offline-First PWA

Copyright (C) 2026 hadi_hnp

A progressive web application (PWA) for industrial field data collection. Operators use tablets on the plant floor, scan NFC tags on equipment, fill dynamic forms, and sync data to a Spring Boot backend when the network is available.

This repository is the **mobile / frontend** companion to the Java backend:

`backend-offline-first` (default port **8081**)

The UI is **Persian (RTL)**. This document is in English for developers and operators setting up the system.

**AI coding agents:** start with [`CLAUDE.md`](CLAUDE.md), then [`AGENTS.md`](AGENTS.md) for architecture, invariants, and commands; use this README for full deployment and troubleshooting.

---

## Documentation map

This README is the tour — setup, deployment, troubleshooting. When you need the detail, these
are the references, and a change to behaviour is expected to update the matching file in the
same commit.

| Document | What it answers |
|---|---|
| **[docs/sync.md](docs/sync.md)** | How data moves to and from the server: the push sequence, every submission outcome, the separate attachment queue, and the conflict rules. |
| **[docs/storage.md](docs/storage.md)** | The Dexie/IndexedDB schema, every store and index, what survives what, and the rules for changing it. |
| **[docs/device-features.md](docs/device-features.md)** | NFC, camera/microphone, GPS and screen orientation — what each requires, and how each degrades. |
| **[AGENTS.md](AGENTS.md)** | Conventions and the traps found the hard way. |
| **[CLAUDE.md](CLAUDE.md)** | Entry point for AI agents working in this repository. |

The backend has the same arrangement — see its `README.md`, `AGENTS.md` and `docs/`.

---

## Table of Contents

1. [Documentation map](#documentation-map)
1. [Features](#features)
2. [Prerequisites](#prerequisites)
3. [Technology Stack](#technology-stack)
4. [Offline-First Architecture](#offline-first-architecture)
5. [Project Structure](#project-structure)
6. [npm Scripts](#npm-scripts)
7. [Local Development (PC)](#local-development-pc)
8. [Mobile & PWA Testing (Full Guide)](#mobile--pwa-testing-full-guide)
9. [HTTPS and mkcert (Development Only)](#https-and-mkcert-development-only)
10. [Installing the PWA on a Phone](#installing-the-pwa-on-a-phone)
11. [Authentication and Roles](#authentication-and-roles)
12. [Navigation and Permissions](#navigation-and-permissions)
13. [Device Configuration (Settings)](#device-configuration-settings)
14. [App Icon](#app-icon)
15. [Dashboard](#dashboard)
16. [Log Sheet Workflow](#log-sheet-workflow)
17. [Offline Behavior](#offline-behavior)
18. [Shared Tablets and Enterprise Sync Policy](#shared-tablets-and-enterprise-sync-policy)
19. [NFC](#nfc)
20. [Field Validation (Warning / Danger Ranges)](#field-validation-warning--danger-ranges)
21. [Photo, Voice Note and Video Fields](#photo-voice-note-and-video-fields)
22. [When the Server Rejects a Submission](#when-the-server-rejects-a-submission)
23. [Synchronization](#synchronization)
24. [IndexedDB Schema](#indexeddb-schema)
25. [API Contract](#api-contract)
26. [Production Deployment](#production-deployment)
27. [Troubleshooting](#troubleshooting)

---

## Features

- **Offline-first** — work continues without network; data lives in IndexedDB on the device
- **PWA** — installable on Android tablets; app shell cached by Workbox
- **NFC tag scanning** — Web NFC on Android Chrome; manual tag entry for supervisors / senior operators
- **Log sheet inbox (kartabl)** — assigned work, pickup pool, supervisor team view
- **Selective reference data** — only per-log-sheet bundles (~open assigned work), not full plant master data
- **Automatic pre-provisioning** — assigned bundles (entries + assets + hierarchy slice) stored on inbox sync
- **Background sync** — submitted log sheets, plus locally-filed NFC fault reports when the role permits, push when online
- **History & archives** — completed work plus per-user snapshots on shared tablets
- **Shared tablet isolation** — per-user inbox and outbound sync queue on shared devices (`sessionContext.ts`)
- **Dynamic forms** — field definitions pulled from the server; warning/danger numeric ranges
- **Role-based UI** — admin settings and NFC tag inspector; supervisor assign/release/reassign

---

## Prerequisites

| Tool | Version / Notes |
|------|-----------------|
| Node.js | 20+ |
| npm | Bundled with Node.js |
| Backend | `backend-offline-first` running on port **8081** |
| Network (mobile testing) | PC and phone on the **same Wi‑Fi** |
| Mobile browser | **Chrome on Android** (NFC + PWA). iOS Safari supports PWA install but not Web NFC |

**Windows — if `node` is not in PATH:**

```powershell
$env:PATH = "C:\Program Files\nodejs;$env:PATH"
```

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| UI | React 18 + TypeScript |
| Build | Vite 5 + `vite-plugin-pwa` (Workbox `generateSW`) |
| Components | MUI v5, full RTL via `@emotion/cache` + `stylis-plugin-rtl` |
| Local storage | Dexie 4 (IndexedDB), schema version **1** (single version) |
| Global state | Zustand |
| Forms | React Hook Form |
| Routing | React Router v6 |
| Font | Vazirmatn (self-hosted) |
| i18n | Custom module `src/i18n/` + `fa.ts` (`i18next` is listed in `package.json` but not used in app code) |
| Dev HTTPS | mkcert (`certs/`) or `@vitejs/plugin-basic-ssl` fallback |

---

## Offline-First Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  React UI                                                    │
│    ↕ Zustand store                                           │
│  IndexedDB (Dexie)  ← local source of truth                  │
│    • authSession, settings, per-sheet bundles, log sheets, …  │
│  Service Worker (Workbox)  ← precached app shell (dist/)     │
└─────────────────────────────────────────────────────────────┘
         │ online                              │ offline
         ▼                                     ▼
   Spring Backend (:8081)              IndexedDB + SW cache only
   /api/bootstrap, inbox bundles, batch
```

**Layering (target):** Prefer `src/services/api/index.ts` for REST and `src/services/storage/index.ts` for IndexedDB. Hooks and most UI follow this; a few pages call the API module directly for operational actions (claim, bundle refresh on fill page).

```
Server REST API
  ↕ src/services/api/index.ts
IndexedDB (Dexie)
  ↕ src/services/storage/index.ts
Hooks (useLogSheets, useFieldDefinitions, …)
  ↕
React components
```

---

## Project Structure

```
src/
├── components/
│   ├── auth/           ProtectedRoute, PermissionRoute
│   ├── common/         SyncStatusBar, InstallPwaPrompt, LogSheetIdentityMeta, ScopeLabel
│   ├── forms/          DynamicClassForm, DynamicFormField
│   ├── layout/         AppLayout, Header, Sidebar
│   └── logsheet/       AssignOperatorDialog, EntryTimestampsMeta
├── hooks/
│   ├── useAuth.ts              Session restore, login/logout
│   ├── useInboxSync.ts         Inbox pull + offline snapshot + pre-provision
│   ├── useMasterDataSync.ts    Bootstrap pull on start / online (operational units only; name is legacy)
│   ├── useSync.ts              SyncManager lifecycle
│   ├── useLogSheets.ts         Local log sheet list
│   ├── useFieldDefinitions.ts  Field definitions per asset class
│   ├── useNFC.ts               Web NFC reader lifecycle
│   ├── useSettings.ts          Device settings read/write
│   └── useOnlineStatus.ts      navigator.onLine → store
├── pages/
│   ├── LoginPage.tsx
│   ├── Dashboard.tsx
│   ├── LogSheetListPage.tsx    Inbox (active) + history
│   ├── LogSheetFillPage.tsx    Fill log sheet + NFC
│   ├── NfcInspectPage.tsx      Admin + online only — raw tag JSON, asset lookup,
│   │                           bind the scanned chip UID to the asset
│   └── SettingsPage.tsx        Admin only
├── services/
│   ├── api/            client.ts + all endpoints (index.ts)
│   ├── auth/           Session in IndexedDB + sessionContext (shared tablet isolation)
│   ├── nfc/            Web NFC abstraction
│   ├── storage/        Dexie db (single version 1), repository, fieldDefinitions,
│   │                   inboxCache, logSheetArchive, nfcFaultReports
│   └── sync/           SyncManager, pullBootstrap, pullInbox, mergeLogSheetBundle, logSheetSync, cleanup
├── store/              Zustand
├── types/              Domain types + auth + sync
├── utils/              logSheetStatus, fieldValidation, ids, scopeLabels, fieldOptions
└── i18n/fa.ts          Persian UI strings

certs/                  mkcert output (gitignored): cert.pem, key.pem, rootCA.crt
tsconfig.vitest.json    TypeScript project for unit tests (vitest imports)
scripts/
  setup-mkcert.ps1      Generate trusted LAN certificates + phone instructions
  generate-icons.js     PWA icons
```

---

## npm Scripts

| Command | Port | HTTPS | Purpose | Offline PWA |
|---------|------|-------|---------|-------------|
| `npm run dev` | 5173 | No | Desktop development | No |
| `npm run dev:mobile` | 5173 | Yes (mkcert or self-signed) | Mobile dev with hot reload | **Do not install PWA from this** |
| `npm run build` | — | — | Production build → `dist/` (uses `.env.production`) | — |
| `npm run build:mobile` | — | — | **Tablet / nginx deploy** → `dist/` (uses `.env.mobile`) | **Yes** |
| `npm run preview` | 4173 | No | Preview production build locally | Partial |
| `npm run preview:mobile` | **4173** | Yes (mkcert) | **Real PWA test and install** | **Yes** |
| `npm run setup:mkcert` | — | — | Create trusted dev certificates | — |
| `npm run icons` | — | — | Regenerate every icon PNG from the SVG sources (see [App Icon](#app-icon)) | — |
| `npm run lint` | — | — | ESLint | — |
| `npm test` | — | — | Vitest unit tests (`src/**/*.test.ts`; TypeScript via `tsconfig.vitest.json`) | — |

**Typecheck:** `build` / `build:mobile` run `tsc` with test files excluded from `tsconfig.json`.

### Why two ports (5173 vs 4173)?

| | `:5173` dev | `:4173` preview |
|--|-------------|-----------------|
| **Served content** | Live Vite source (`/src/...`) | Built files in `dist/` |
| **Service Worker** | Dev SW — incomplete precache | Full precache (~30+ JS/CSS/font files) |
| **Wi‑Fi off** | Phone cannot reach PC → **white screen** | Shell from cache → **UI loads** |
| **Use for** | Code debugging | PWA install + offline testing |

> **Golden rule:** Install the PWA only from `https://<PC-IP>:4173`, never from `:5173`.

---

## Local Development (PC)

```bash
npm install

# Terminal 1 — backend
cd ../backend-offline-first
./mvnw spring-boot:run   # Windows: .\mvnw.cmd spring-boot:run

# Terminal 2 — frontend
cd offline-first-pwa
npm run dev              # http://localhost:5173
```

API calls use `serverUrl` from IndexedDB settings (initialized from `VITE_SERVER_URL` on first run). **Settings** is admin-only; for production tablets, set the correct URL at **build time** in `.env.mobile` (or have an admin save Settings once on each device). For local desktop dev, an admin can set `http://localhost:8081` in Settings after login, or use `dev:mobile` / `preview:mobile` so the app origin matches the configured URL and `/api` is proxied.

```bash
npm run build
npm run preview          # http://localhost:4173 — no HTTPS, limited mobile testing
```

For NFC, trusted HTTPS, and real offline PWA behavior, follow [Mobile & PWA Testing](#mobile--pwa-testing-full-guide).

---

## Mobile & PWA Testing (Full Guide)

### Step 0 — Install dependencies

```powershell
cd offline-first-pwa
npm install
```

### Step 1 — Start the backend

```powershell
cd ..\backend-offline-first
.\mvnw.cmd spring-boot:run
```

The API listens on `http://127.0.0.1:8081`. In **mobile mode**, Vite proxies `/api` to the backend so the phone uses a single HTTPS origin.

### Step 2 — Find your PC LAN IP

```powershell
ipconfig
```

Example: `192.168.1.101`. PC and phone must be on the same subnet.

### Step 3 — Mobile environment file

```powershell
copy .env.mobile.example .env.mobile
```

Edit `.env.mobile`:

```env
VITE_SERVER_URL=https://192.168.1.101:4173
```

- Use your real PC IP.
- Port **4173** is for the installed offline PWA (`preview:mobile`).
- This becomes the default `serverUrl` in IndexedDB. When the app origin matches this URL, the API client uses relative paths `/api/...` (proxied by Vite in dev/preview mobile mode).

### Step 4 — mkcert (trusted HTTPS)

```powershell
npm run setup:mkcert
# or with explicit IP:
.\scripts\setup-mkcert.ps1 -Ip 192.168.1.101
```

Expected output in `certs/`:

```
certs/cert.pem      ← server certificate (PC only)
certs/key.pem       ← private key (PC only)
certs/rootCA.crt    ← install on phone
```

When `certs/cert.pem` exists, Vite uses mkcert automatically. Terminal shows:

```
[mobile] HTTPS: mkcert (certs/cert.pem)
```

If you see `WARNING: No certs/cert.pem`, Vite falls back to self-signed `basic-ssl` (red lock, no install prompt).

Configuration is in `vite.config.ts` — `loadMkcertHttps()` reads `certs/cert.pem` and `certs/key.pem` when `--mode mobile` is active.

### Step 5 — Install CA on the phone

**Android:**

1. Copy **`certs/rootCA.crt`** to the phone (not `cert.pem`).
2. Settings → Security → Encryption & credentials → Install a certificate → **CA certificate**
3. Select `rootCA.crt` and confirm.
4. Force-stop Chrome and reopen.

Use **CA certificate**, not Wi‑Fi/VPN user certificate (wrong type → lock stays red).

**iOS:** Install the profile → Settings → General → About → Certificate Trust Settings → enable full trust for mkcert.

### Step 6 — Build and preview

```powershell
npm run build:mobile
npm run preview:mobile
```

The Service Worker only precaches production files in `dist/`.

### Step 7 — Open on the phone

```
https://192.168.1.101:4173
```

- SSL lock should be green/trusted.
- Log in once.
- Browse a few pages so caches warm up.
- Wait for inbox sync (assigned work appears under **My Work**).

### Step 8 — Install the PWA

**Android Chrome:** Install banner in the app, or menu ⋮ → **Install app**.

**iOS Safari:** Share → **Add to Home Screen** (no `beforeinstallprompt`).

### Step 9 — Test offline

1. Turn off Wi‑Fi on the phone.
2. Open the **installed PWA** (not a Chrome tab).
3. UI should load from cache; data from IndexedDB.
4. Continue assigned log sheets, scan NFC, save forms.
5. Inbox refresh, claim, assign — require network again.

---

## HTTPS and mkcert (Development Only)

| Requirement | Why HTTPS |
|-------------|-----------|
| Web NFC | Secure context only |
| PWA install | Chrome installability criteria |
| Service Worker | Required on non-localhost origins |

| Certificate type | Lock | Auto install |
|------------------|------|--------------|
| Self-signed (basic-ssl) | Warning / red | No |
| mkcert + CA on phone | Trusted | Yes (Android) |
| Real SSL (production nginx) | Trusted | Yes |

**Production does not use mkcert.** Copy `dist/` to nginx and configure real SSL there (see [Production Deployment](#production-deployment)).

Install mkcert on Windows if needed:

```powershell
winget install FiloSottile.mkcert
npm run setup:mkcert
```

---

## Installing the PWA on a Phone

### Android auto-install requirements

1. Trusted HTTPS (mkcert CA on device, or production cert)
2. Valid `manifest.webmanifest` + 192/512 icons
3. Registered Service Worker
4. User engagement on the site
5. Install from **port 4173**, not 5173

---

## Authentication and Roles

### Session storage

Login returns JWT + roles + permissions + `expiresAt`. Stored in IndexedDB `syncMeta` key `authSession`.

### App startup

1. `useAuthInit` reads session from IndexedDB.
2. Valid session → dashboard (no login screen).
3. **Online** + expired JWT → session cleared, redirect to login.
4. **Offline** + expired JWT → session still accepted (offline-first).
5. **Login** always redirects to `/` (never restores a previous user’s deep link).
6. **User switch** on a shared tablet clears inbox cache and isolates other users’ local work (`sessionContext.ts`). See [Shared Tablets and Enterprise Sync Policy](#shared-tablets-and-enterprise-sync-policy).

### Roles (frontend checks)

| Role | Code | Typical access |
|------|------|----------------|
| Admin | `ADMIN`, `HIGH_USER` | **Settings** and the **NFC tag inspector**. Master data, the asset registry and log sheet templates are managed in the web admin panel, not in the PWA. |
| Supervisor | `SUPERVISOR` (+ admin roles) | Team inbox, release, assign/reassign; manual NFC; pickup pool visibility per backend rules |
| Senior operator | `SENIOR_OPERATOR` | Manual NFC tag entry (always); web fill permission |
| Operator | `OPERATOR` | Dashboard, log sheets, NFC scan only (manual tag only if admin enabled **Allow manual tag entry** on the tablet) |

Helpers in `src/types/auth.ts`: `hasPlantWideScope()`, `canManageNfcSerial()`, `canAssignWork()`, `canEnterTagManually()`, `hasPermission()`.

> **These read permissions, never role names.** A role duplicated from `ADMIN` copies its
> permissions but gets a new code, so a `roles.includes('ADMIN')` check turned the copy away from
> screens the server would have served it. Each helper uses a permission whose grant set is
> identical to the role test it replaced, so the table above is unchanged in practice. Route
> guarding is `PermissionRoute` (formerly `AdminRoute`), which takes a predicate.

**Note:** `ADMIN` / `HIGH_USER` also get manual entry via permission `GET:/log-sheets/{id}/fill` if they use the mobile fill UI.

**Note:** Filing an NFC fault report (the "اعلام خرابی NFC" icon, distinct from manual tag entry) requires its own permission, `POST:/api/nfc-fault-reports/batch` — see [NFC fault reports](#nfc-fault-reports-per-asset-unlock). It is not implied by any role above; check role-permission assignments in the web admin panel.

---

## Navigation and Permissions

| Route | Who |
|-------|-----|
| `/` | All authenticated users |
| `/logsheets/active` | All — inbox + my work |
| `/logsheets/history` | All — completed / failed / archived snapshots (see below) |
| `/logsheets/:localId` | All — fill page |
| `/nfc-inspect` | Gated on `POST:/api/asset-entries/{id}/nfc-serial` (`PermissionRoute` + sidebar) — online-only NFC tag inspector |
| `/settings` | Gated on `CAP:SCOPE_PLANT_WIDE` (`PermissionRoute` + sidebar) — server URL, sync interval, **Allow manual tag entry** and **chip-serial scan check** (both apply to all users on that device) |

Operators see Dashboard and Log Sheets only.

The removed admin routes `/master-data/*`, `/logsheet-templates`, `/admin` and `/records` all redirect to `/`, so old bookmarks and PWA shortcuts land somewhere sensible instead of a blank screen. Those surfaces live in the web admin panel; the PWA only ever consumes reference data through log-sheet bundles.

---

## Device Configuration (Settings)

**Who:** `ADMIN` / `HIGH_USER` only (`/settings`).

Settings are stored in IndexedDB (`settings` table, single row). They apply to **every user** on that tablet after save (not per login).

| Field | Purpose |
|-------|---------|
| **Server URL** (`serverUrl`) | Base URL for API resolution. Must match how tablets reach the app (see below). |
| **Sync interval** | Outbound sync timer in seconds (stored as ms; default 30 s from `DEFAULT_SETTINGS`). |

| **Screen orientation** (`screenOrientation`, admin-only) | `auto` (default), `portrait` or `landscape`. Stored **on the device** and never synced — it depends on how that particular tablet is mounted, so a shared account must not drag one device's choice onto another. Re-applied on every launch, because an orientation lock does not survive the app closing. Locking generally works only in the **installed** PWA on Android; where the browser cannot lock (desktop, iOS Safari) the app simply rotates freely and the Settings screen says so once. |

> There is no operator-name or location field any more. The signed-in user's own name is used wherever a name is needed (log-sheet operator label, NFC fault-report reporter) — on a shared tablet a device-wide typed name attributed everyone's work to whoever the admin entered once.

### What this screen no longer decides

Two switches were removed from it, and neither moved somewhere else on the device.

| Was a device switch | Now |
|---|---|
| **Allow manual tag entry** | **A permission.** The manual-entry box appears for whoever holds `GET:/log-sheets/{id}/fill` (supervisor / senior operator) and for nobody else. As a switch it granted the ability to *everyone* on that tablet, so anyone who could open Settings could let a whole shift type tags instead of scanning them — which is the entire point of the NFC step. Who may skip a scan is an access-control question, so access control answers it. Unrelated to the NFC-fault fallback, which unlocks one asset after a report is filed. |
| **Chip-serial scan check** (`nfcStrictSerialMatch`) | **A plant-wide rule set in the web panel** (Settings → اسکن NFC, on by default), shipped on `/api/bootstrap` and applied without a restart. Record 1 can be copied onto any blank tag, so the serial is the only part of a scan that means "I stood in front of this equipment" — one plant, one answer, rather than each tablet deciding for itself. |

The Settings screen now **shows** both, read-only and admin-only, alongside the attachment
ceilings, so an admin can see which rules a device is running under. Also listed there:
**علامت‌گذاری روی عکس** — the annotate-before-save step, likewise set in the web panel.

### Server URL rules (`src/services/api/client.ts`)

1. On first launch, settings are seeded from **`VITE_SERVER_URL`** in the build (`.env.mobile` for `build:mobile`).
2. At request time, if `new URL(serverUrl).origin === window.location.origin`, the client uses **relative** paths (`/api/...`).
3. Otherwise the client calls the configured absolute URL (e.g. direct `http://192.168.1.2:8081` — rare; bypasses nginx same-origin).

| Deployment | Set `VITE_SERVER_URL` / Settings to |
|------------|--------------------------------------|
| nginx PWA + proxy | `https://192.168.1.4` (PWA origin only) |
| Local `preview:mobile` | `https://<PC-LAN-IP>:4173` |
| Local desktop dev (no proxy) | `http://localhost:8081` (only if API is on another origin than the Vite page) |

**Production checklist:** build with `.env.mobile`, copy `dist/` to nginx, install CA on tablets, open PWA URL once as admin and confirm Settings → server URL matches that origin (or rely on build default if unchanged).

---

## App Icon

One artwork, two SVG sources, and a script that rasterises both. **Everything is
committed** — the build never runs the script, so a plain `npm run build` cannot
fail because of it.

| File | Role |
|------|------|
| `public/icons/icon.svg` | The artwork. Full-bleed with rounded corners; used wherever the icon is shown **unmasked** (browser tab, iOS home screen, backend favicon). |
| `public/icons/icon-maskable.svg` | The same artwork scaled into Android's safe zone, brand colour bleeding to all four edges. Used for `purpose: "maskable"`. |
| `public/icons/*.png` | Generated. Do not hand-edit — they are overwritten. |
| `scripts/generate-icons.mjs` | The rasteriser (uses `sharp`). |

### To change the icon

1. Replace **`public/icons/icon.svg`** with your artwork on a 512×512 `viewBox`.
2. Update **`public/icons/icon-maskable.svg`** to match. Keep the pattern already
   in that file: a full-bleed background rectangle, then the artwork wrapped in a
   `transform` that centres it and scales it down.
3. Run the generator, **before** building:

   ```bash
   npm run icons
   ```

4. Commit the regenerated PNGs together with the SVGs, then build as usual
   (`npm run build:mobile` for tablets).

The script writes `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` and
`icon-maskable-512.png` into `public/icons/`, and also copies a 180×180
`favicon.png` into the backend repo's `src/main/resources/static/` so both apps
carry the same mark. If the backend lives somewhere other than
`../../JavaProject/backend-offline-first`, point the script at it:

```bash
BACKEND_STATIC_DIR=/path/to/backend/src/main/resources/static npm run icons
```

### Why the maskable variant is a separate file

Android does not draw the icon as given: the launcher applies its own mask —
circle, squircle, teardrop, depending on the device — and **crops everything
outside it**. Only the central circle of 80% diameter is guaranteed to survive.
An icon whose artwork reaches the edges therefore comes out with its corners and
edges shaved off after install. That is why `icon-512.png` (`purpose: "any"`) and
`icon-maskable-512.png` (`purpose: "maskable"`) are two different images rather
than one file declared `"any maskable"` — a single file cannot satisfy both, and
declaring it for both is what produced the clipped icon.

After changing the icon, reinstall the PWA on a test device: Android caches the
launcher icon from install time and will not pick up a new one on refresh alone.

---

## Dashboard

Route: `/` (all authenticated users).

| UI block | Behavior |
|----------|----------|
| Welcome | `username` and `fullName` from JWT session |
| Stat cards | **Open log sheets** and **submitted today**, counted from local log sheets (cards link to **Active log sheets**) |
| Whose numbers | **Only the signed-in user's own work** — supervisors included; their team's work lives in the inbox's team tab. `ADMIN` / `HIGH_USER` see the device-wide totals instead. The rule is in `src/utils/dashboardStats.ts`. |
| Pending sync | From `SyncManager.getPendingCount()` — submitted log sheets owned by the current user **plus** pending NFC fault reports if the role has `POST:/api/nfc-fault-reports/batch` |
| Quick actions | Jump to `/logsheets/active` and `/logsheets/history` |
| Sync card | Last sync time, pending/failed counts, manual sync button when online |

Primary operator workflow is **Log sheets → Active**, not the dashboard stats.

---

## Log Sheet Workflow

### 1. Inbox sync (online)

`useInboxSync` runs when the app goes online and when the user taps **Refresh inbox**.

```
GET /api/log-sheets/inbox
  → assigned[]     — full bundles (sheet + entries + scoped context) for my work
  → available[]    — pickup pool (metadata only)
  → teamOpen[]     — supervisor: in-progress work in the unit (metadata only)
```

Snapshot saved to IndexedDB (`inboxSnapshot`) for offline inbox display.

### 2. Pre-provisioning (online, automatic)

For every sheet in **assigned** (each item is a `LogSheetBundleDto`):

```
mergeInboxIntoLocalSheets(assigned[])
  → mergeBundleContextToDb()   — locations…assets for this sheet only (server wins)
  → applyLogSheetBundle()      — entries[] + local logSheets row
  → merge inbox metadata (dueAt, serverStatus, operatorName, assigneeUserId, …)
```

The user does **not** need to open the sheet first. After one successful inbox sync while online, assets, NFC tag IDs, and field definitions for that work are on the device for offline use.

**Note:** Pre-provision applies to **assigned** work only, not the pickup pool until claimed.

### 3. Opening a sheet

- **My Work → Start:** `ensureLocalLogSheet()` with optional online bundle refresh.
- **Never synced locally + offline:** blocked with “online required” message.
- **Shared tablet:** after login, user always lands on dashboard; only sheets assigned to the current user are shown.

### 4. Filling

- Tap asset card → view-only dialog.
- Scan NFC or manual tag (if allowed) → edit dialog for matching asset.
- Save entry → `formData` stored in local log sheet entries.
- Numeric fields show warning/danger range hints and live feedback.

### 5. Submit (local)

**Confirm submit** on fill page:

- `status: 'submitted'`
- `completedAt` / `submittedAt` = device timestamp
- `clientActionId` = UUID (idempotency)
- `syncStatus: 'pending'`

Submit is local only until sync succeeds.

**Revert to draft (offline only):** If the sheet is locally submitted but not yet synced (`syncStatus: pending`), still before deadline, and the device is **effectively offline**, the operator may undo completion and return to editable draft (`revertLogSheetToDraft`). Not available after successful sync or while online.

**Recheck assignment:** When sync failed with ownership/revoked errors, **Recheck assignment** refreshes inbox, retries outbound sync if needed, and updates local state (e.g. work returned to assignee after supervisor reassignment).

**Continue after a supervisor reopen (online only):** Once a completion has synced, the device
can no longer undo it — the server owns it. If it has to be corrected, a supervisor **reopens**
it from the web panel (`POST /log-sheets/{id}/reopen`, with a new deadline), which returns the
sheet to `IN_PROGRESS` and keeps the readings. Note this is *reopen*, not *extend*: the backend
refuses to extend a sheet that is already `SUBMITTED`.

The next inbox sync brings the sheet back to the operator's assigned bucket, so the local row
picks up the new `serverStatus` and `dueAt` while staying `submitted`/`synced` — that
combination is what [`isReopenedAfterSync`](src/utils/logSheetStatus.ts) recognises. The
History card then reads **بازگشایی شده — قابل ادامه**, and opening it shows a **«ادامه‌ی کار»**
button on the fill page.

Pressing it re-fetches the sheet's bundle and re-checks it live
([`canContinueReopenedLogSheet`](src/utils/logSheetWorkflow.ts)) before anything local changes:
the sheet must still be `ASSIGNED`/`IN_PROGRESS`, assigned to this user, with a deadline still
ahead. Only then does the row go back to an editable draft, keeping every reading and dropping
the delivered submission's `clientActionId` so the corrected resubmission is a new action rather
than a replay. Every refusal names its own reason (already submitted, cancelled, expired, now
someone else's, back in the pool).

The live re-check is not ceremony. The inbox response that flagged the sheet may have been read
from the server *moments before* this device's own submission landed, which would make a
just-completed sheet look reopened; a fetch issued once the row is already `synced` cannot see
that state, because the `synced` stamp only exists after the server committed the completion.

> **A reopened sheet that is never resubmitted expires.** Reopening clears the server's
> `submitted_at` / `draft_saved_at`, so if the new deadline passes untouched the scheduler marks
> the sheet `EXPIRED` rather than restoring `SUBMITTED` — a completed round becomes a missed one
> in the compliance report. Reopen only when the correction will actually be made.

### 6. Status in My Work

| Local state | Chip in inbox list |
|-------------|-------------------|
| Draft, in progress | Server status (e.g. In progress) |
| Submitted, not synced | **Completed — pending sync** |
| Submitted, synced | **Sent** |
| Submitted, synced, server reopened it with a future deadline | **بازگشایی شده — قابل ادامه** |

### 7. Active inbox UI (`LogSheetListPage` — mode `active`)

| Section | Source | Actions (online) |
|---------|--------|------------------|
| **My assigned** | `inbox.assigned[]` + local merge | Open / continue; status chips from local + server |
| **Pickup pool** | `inbox.available[]` | **Claim** → `POST /api/log-sheets/{id}/claim` → bundle merged locally → fill page |
| **Team open** | `inbox.teamOpen[]` (supervisor roles) | Open read-only context; **Release**, **Assign**, **Reassign** where permitted |

Offline: last **inbox snapshot** still lists assigned/available/team metadata; claim/release/assign require network. Local drafts not in the current inbox snapshot may appear as extra cards when offline.

**Refresh inbox** triggers `pullAndMergeInbox()` then optional outbound sync (unless skipped).

### 8. History (`/logsheets/history`)

List is built with `loadLogSheetsForSessionUser()` — live rows the current user may access **plus** archived copies from `logSheetUserArchives` on shared tablets.

A sheet appears in **History** when `isHistoryLogSheet()` is true:

| Condition | Meaning |
|-----------|---------|
| `status: submitted` and `syncStatus: synced` or `failed` | Finished or failed upload |
| Revoked / reassigned away | Supervisor took work back or another user logged in |
| Expired local draft | Missed deadline locally |
| Archived snapshot | User B logged in while User A had work on device — A’s copy moved to archive |

A sheet a supervisor **reopened** stays in History too, deliberately: it is still a delivered
completion until the operator resumes it, and the «ادامه‌ی کار» button lives on the fill page,
which is opened from that History card. It carries its own chip so it is not lost among the
sent ones, and it moves back to **My Work** by itself the moment it becomes a draft again.

Opening a history item:

- Normal `localId` → fill page in read-only or limited edit (submitted / archived).
- Archived view id (`archivedLogSheetViewId`) → load from `logSheetUserArchives`; **view-only**; cannot edit or re-submit — including one that looks reopened, since an archive is another login's record, not this user's work.

When the original assignee returns and sync succeeds, stale archive rows for synced work are removed automatically.

---

## Offline Behavior

### What works offline

| Capability | Offline |
|------------|---------|
| PWA UI (installed from :4173) | Yes |
| Session (even expired JWT) | Yes |
| Cached per-sheet reference data (from bundles) | Yes |
| Assigned log sheets pre-provisioned earlier | Yes |
| Open / fill / save log sheets | Yes |
| NFC scan against current log sheet entries | Yes |
| Field definitions from IndexedDB | Yes |
| Local submit (queue for sync) | Yes |
| View last inbox snapshot | Yes |
| Open **History** (including archived snapshots) | Yes (view-only for archives) |

### Online only

| Capability | Offline |
|------------|---------|
| Login (first time) | No |
| Inbox refresh | No |
| Claim / release / assign / reassign | No |
| Bootstrap pull (operational units) | No |
| Push sync to server | No |
| First open of never-provisioned work | No |

### Sync conflict outcomes (after coming online)

| Scenario | Device result |
|----------|---------------|
| Operator worked offline; supervisor revoked/reassigned | Draft marked `REVOKED` — cannot continue |
| Operator submitted offline; assignee changed on server | Sync `SUPERSEDED` |
| Completed before deadline offline; sync after deadline online | Accepted — deadline checked against device `completedAt` |
| Completion synced, then supervisor **reopened** the sheet | History card reads **بازگشایی شده — قابل ادامه**; «ادامه‌ی کار» on the fill page verifies with the server and returns it to an editable draft with the readings intact |

### Stale data limitations

- Inbox snapshot may show revoked work until next online sync.
- Extended deadlines from supervisor apply after inbox sync.
- A supervisor reopening a synced completion likewise reaches the device only on the next inbox sync, and resuming it requires the server (the device never un-sends an accepted completion on its own).
- Updated asset metadata (e.g. NFC tag change) applies on the next inbox bundle or online bundle refresh (server wins).
- Shared tablet: logging in as a different user clears the previous inbox cache and isolates other users’ local work. Archived snapshots for each user are kept in `logSheetUserArchives` and appear under **History** (view-only). See [Shared Tablets and Enterprise Sync Policy](#shared-tablets-and-enterprise-sync-policy).

---

## Shared Tablets and Enterprise Sync Policy

This section documents the **intentional** sync and session model for shared tablets in enterprise field operations. It explains why only the **assignee** can push their own submitted work, and what organizations should expect in production.

### Design principles

| Layer | Responsibility |
|-------|------------------|
| **IndexedDB** | Temporary offline store for all users who have used the device |
| **Session / isolate** | Separate visibility and outbound queue per user on user switch |
| **Outbound sync** | Only sheets where `assigneeUserId` matches the logged-in user |
| **Revival** | When the owner logs back in, their blocked queue is restored |
| **Server** | Final ownership validation via JWT + server-side assignment |

**Core rule:**

```
Device     = staging area (not the legal submit identity)
Logged-in user = legal identity for API calls (JWT)
assigneeUserId = who is allowed to submit that log sheet
```

The backend validates ownership on `POST /api/log-sheets/batch` using the **current JWT**, not “whatever is pending on this device”. The batch payload does not carry `assigneeUserId`; the server checks assignment against the authenticated user.

### Intended flow (shared tablet)

```
Operator A: final submit offline → submitted + pending (assigneeUserId = A)
Operator A: logout
Operator B: login
  → inbox cache cleared
  → A’s submitted queue marked REVOKED locally (not visible, not synced)
  → only B’s pending work enters the outbound queue
Operator A: logs back in
  → revival clears REVOKED, restores pending + new clientActionId
  → sync runs under A’s JWT → SUBMITTED
```

Implementation: `src/services/auth/sessionContext.ts`, `src/services/sync/index.ts`, `src/services/sync/logSheetSync.ts`.

### Why cross-user sync is not supported

**Do not** push another user’s submitted sheets when a different user is logged in. That pattern was the root cause of shared-tablet bugs (ownership errors, false “sent” UI, empty server records).

| If user B tries to sync user A’s work | Typical result |
|---------------------------------------|----------------|
| Server still assigns sheet to A | Ownership error — rejected |
| Supervisor reassigned sheet to B | `SUPERSEDED` — A’s payload rejected |
| B picked up the same sheet | Stale local completion reset to draft on inbox merge |

Additional risks of “sync all pending on any login”:

- **Audit / non-repudiation** — server logs would show the wrong actor
- **Security** — violates least-privilege on shared devices
- **Data integrity** — `DUPLICATE`, false `synced` state, corrupted local workflow

### Enterprise acceptability

For industrial field apps with **shared tablets**, this model is **acceptable and preferred** when auditability and data correctness matter more than automatic proxy upload.

| Criterion | Current model |
|-----------|---------------|
| Data correctness / ownership | Strong |
| Security on shared devices | Strong |
| Audit trail (actor = assignee) | Strong |
| Offline capability | Strong |
| Guaranteed delivery SLA without owner login | Limited — by design |
| Management visibility into device pending queue | Limited — local only |
| Shift handover without operator returning | Requires operational policy |

**Verdict:** Enterprise-grade for **correctness, security, and audit**. For **shift-based operations with strict delivery SLAs**, complement with operational policy and (optionally) server-side tooling — not client-side cross-user sync.

### Operational requirements (recommended for production)

Document these in your SOP / rollout materials:

1. **Final submit always uses the assignee’s identity** — non-negotiable for audit.
2. **The shared tablet is a staging device**, not a proxy submitter.
3. **Operator responsibility:** before leaving shift, go online and confirm pending work has synced.
4. **Organization responsibility:** shift handover SOP + pending-work warnings before logout.

### UX expectations

| Local state | Meaning for operators |
|-------------|----------------------|
| Submitted, pending sync | Work is complete on device; waiting for **this user** to be online and synced |
| Submitted, synced | Successfully recorded on server |
| Failed + REVOKED (after user switch) | Blocked until the **original assignee** logs back in |

Pending count and sync status are shown in the app shell (`useSyncManager`). After online final submit, sync and inbox refresh run automatically when possible.

### What we deliberately do not do

| Anti-pattern | Why |
|--------------|-----|
| Sync all device pending sheets on any login | Fails server ownership checks; corrupts local state |
| Delete pending work on logout | Violates offline-first — data loss |
| Show another user’s submitted queue in the UI | Privacy and confusion on shared tablets |
| Mark `synced` on `DUPLICATE` without `serverId` | False “sent” state |

### If the business requires delivery without owner re-login

That is a **server-side enterprise feature**, not a client workaround:

| Approach | Notes |
|----------|-------|
| Device-bound outbox | Server attributes submission to the original assignee |
| Delegated submit API | Explicit “submit on behalf” with audit |
| Supervisor push | Role-gated retry/approve for blocked device queues |
| Ops alerting | Device online but old pending — notify supervisor |

Do not bypass ownership in the PWA; negotiate these capabilities with the backend team.

### Stakeholder summary (one paragraph)

> The app intentionally prevents one operator from submitting another operator’s work under the wrong identity. In exchange, final delivery requires the assignee to be logged in (or a formal server-side delegation mechanism). This is a deliberate trade-off for data integrity and audit compliance in industrial environments.

---

## NFC

### Browser support

- **Android Chrome** — full Web NFC
- Requires **trusted HTTPS** (or localhost)
- **iOS** — no Web NFC; use manual tag entry if enabled

### Tag ID source

The app reads the **NDEF text payload** (e.g. `E-0110CM2`), not the hardware UID. See `resolveNfcTagId()` in `src/services/nfc/index.ts`.

### Lookup (log sheet fill page)

When a tag is scanned on the fill page:

1. Resolve tag ID from NDEF content.
2. Find matching entry in **`logSheet.entries`** by `nfcTagId` (current sheet only).
3. If found → open edit dialog for that asset.
4. If not found → error: asset not in this log sheet.

No network call. Works offline if entries were pre-provisioned or built when the sheet was opened.

### Manual entry

Who can type a tag ID instead of scanning (see `canEnterTagManually()` in `src/types/auth.ts`):

| Condition | Effect |
|-----------|--------|
| Settings **Allow manual tag entry** = on (admin saves in Settings) | **All** roles, including `OPERATOR` |
| Role `SUPERVISOR` or `SENIOR_OPERATOR` | Allowed even when the setting is off |
| Permission `GET:/log-sheets/{id}/fill` in JWT | Allowed (e.g. `ADMIN`, `HIGH_USER`, senior/supervisor roles) |

Plain operators on a shared tablet need the admin toggle **or** NFC. iOS has no Web NFC — enable manual entry or use Android for scanning.

### NFC fault reports (per-asset unlock)

Not the same thing as manual tag entry above — different mechanism, different gate.

If an asset's NFC tag is broken, missing, or was never installed — or the device's own NFC hardware doesn't work — an operator can tap **"اعلام خرابی NFC"** on that entry's card to file a fault report. This unlocks a manual-entry fallback for **that one asset, in that one log sheet only** (not the whole sheet, not other sheets). The report is synced to the server (`POST /api/nfc-fault-reports/batch`) and kept as a permanent, immutable record — it's never edited, and only `ADMIN` can delete one (from the web admin panel).

| Who sees the "report fault" icon | Condition |
|---|---|
| Shown | User's JWT includes permission `POST:/api/nfc-fault-reports/batch` |
| Hidden | Permission missing — no icon, no way to create a new report from that device |

This permission is checked client-side in `LogSheetFillPage.tsx` (`canReportNfcFault`) and mirrors a server-side check in the sync layer: even if a report were created locally without this permission, the outbound sync would silently exclude it from every batch, so it would never leave the device. Revoking the permission from a role takes effect the next time that user logs in (or on the next permission refresh) — they simply stop seeing the icon.

**Already-unlocked assets stay unlocked** even if the permission is later revoked — an existing fault report is data, not a live permission check. Revoking the permission only stops that user from filing *new* reports; it does not re-lock assets that already have one.

---

## Field Validation (Warning / Danger Ranges)

Field definitions from the server may include JSON validation:

```json
{
  "warning": { "min": 20, "max": 80 },
  "danger": { "min": 10, "max": 90 }
}
```

Legacy flat `{ "min": n, "max": m }` is treated as warning range (same as backend).

On numeric fields in `DynamicFormField`:

- Static hint under field: `Warning: 20–80 · Danger: 10–90`
- Live feedback when value is out of range (yellow warning / red danger)
- Submit is **not** blocked by soft limits (matches backend web UI)

Logic mirrors backend `FieldValidationSupport` in `src/utils/fieldValidation.ts`.

---

## Photo, Voice Note and Video Fields

When an asset class has a field of type **`image`**, **`audio`** or **`video`**, that field
renders as a capture control instead of a text box: a camera button, or a record/stop pair with
a live elapsed-time readout (and a live preview while filming). Everything works offline —
capture, review and delete need no connection at all.

### Limits come from the server

How many files a field accepts and how long a clip may run are set by an administrator in the
**web panel**, not here. They arrive with `/api/bootstrap`.

**When a change reaches a device:** immediately at the next **sign-in**, and otherwise within an
hour — bootstrap is throttled to one pull per hour so a running app does not re-fetch constantly.
If a change needs to apply right away on a tablet already in use, have the operator sign out and
back in. The lag is harmless in the meantime because **the server enforces the limits regardless**;
a stale device merely shows the wrong number, it cannot store more than the server allows.

| | Default |
|---|---|
| Images per field | 3 |
| Voice notes per field | 1 |
| Videos per field | 1 |
| Max audio duration | 120 s |
| Max video duration | 120 s |

Counts are **per field per asset**. The capture button disables at the ceiling and the header
shows `2 / 3`. The Settings screen shows the current values **read-only, to admins only** —
they are not editable on the device, and the settings form deliberately never writes them back,
so a stale form cannot overwrite ceilings a bootstrap refreshed in the meantime.

If the server is older than this feature, or a pull fails, the app keeps whatever it last
stored — offline capture has to keep working against the last known rules.

### Marking up a photo before it is saved

**Setting:** «علامت‌گذاری روی عکس» in the web panel's Settings page (`attachments.image_annotation_enabled`), **on by default**, carried to the device on the same
bootstrap as the ceilings.

With it on, a photo is **not stored the moment it is taken**. The operator gets a full-screen
review of the shot with:

| Tool | |
|---|---|
| Freehand pen | drawing directly on the photo |
| Arrow | for pointing at one fitting among twenty |
| Box | for framing an area |
| Text | typed in a normal field, then placed on the image |
| Colours | six, including white and black — plant surfaces are neither |
| Widths | three, scaled to the image so a mark reads the same on any photo |
| Undo / redo / clear | clear is undoable too |

Then **ذخیره**, **گرفتن دوباره** (throw the shot away and reopen the camera), or **انصراف**
(keep nothing). Nothing reaches IndexedDB until one of those is chosen, so a cancelled capture
leaves no orphan row and no orphan blob.

The marks are **burned into the image** before it is stored. The attachment that syncs, the one
the upload queue carries and the one a reviewer opens in the web panel are all the same
annotated file — there is no overlay to render separately and nothing extra crosses the wire.
Confirming without drawing anything stores the original bytes with no second encode at all.

Two implementation details that are load-bearing rather than incidental:

- **The annotation is applied to the compressed capture, not to the camera's original file.**
  The compressed bitmap is what gets stored either way, so drawing on it guarantees a mark lands
  in the saved file exactly where the operator put it. On the raw file, EXIF orientation can
  differ between what a preview shows and what a later decode produces — every mark would be
  rotated off its target.
- **Marks are stored as shapes and re-rendered, not painted onto a canvas as you go.** That is
  what makes undo, redo and clear cheap; the alternative is a full-canvas bitmap snapshot per
  step, several megabytes each on a 1600 px photo.

With the setting off, the capture path is exactly what it was before this existed: compress,
store, done, no extra step.

### Capture and compression

Compression is not an optimisation here, it is what makes the feature viable. A tablet camera
produces 8–12 MP frames of several megabytes each; at the target load of a daily sheet that
would be tens of gigabytes a year moving over a plant network. `src/utils/mediaCapture.ts`
compresses **before** anything is stored, and the original is discarded rather than kept "just
in case":

| Media | What happens | Result |
|-------|--------------|--------|
| Photo | Drawn to a canvas, capped at **1600 px** on the long edge, re-encoded as WebP at quality 0.8 (JPEG fallback) | ~200–400 KB, still ample to read a gauge face or see a leak |
| Audio | `MediaRecorder`, Opus in WebM, **mono at 24 kbps** | ~150 KB per minute of speech |
| Video | **480p (854 px), 700 kbps video + 24 kbps mono audio**, VP8/Opus in WebM | ~88 KB/s, so two minutes ≈ **10.5 MB** |

Video needed a real decision because, unlike a photo, it **cannot be cheaply re-encoded on the
device afterwards** — the constraints given to `getUserMedia` and `MediaRecorder` at capture
time are the only lever. 480p rather than 720p is deliberate: a leak, a flame or a gauge
sweeping is entirely legible at that size, and 720p would roughly double the bytes for no
diagnostic gain.

A bitrate is a **hint, not a promise**. A high-motion scene makes the encoder overshoot, so
recording also stops at a hard **15 MB** ceiling — below the server's 20 MB, so the device cuts
the clip rather than having the server refuse the whole thing after the operator already filmed
it. When that happens the app says so explicitly instead of leaving a mysteriously short clip.

The `capture="environment"` attribute is what makes Android open the camera directly rather
than the photo gallery. The microphone track is released on every exit path — stop, cancel, or
error — so the browser's recording indicator never stays on after the operator is done.

### What is stored where

The log sheet's `formData` holds **ids only**:

```json
{ "pump_photo": { "type": "attachment", "ids": ["a7f3…"] } }
```

The media itself lives in its own Dexie table as a native `Blob`. That separation is what keeps
a sheet's form data small enough to sync as ordinary JSON no matter how many photos hang off
it, and it is mirrored exactly on the server (see the backend README's *Attachments* chapter).

### Upload: a separate queue

Attachments **do not** travel inside the log-sheet submission. That payload has to stay small
and atomic — a 400 KB photo in the middle of it would mean every dropped connection retried the
whole shift's readings. Instead:

1. The sheet submits with attachment ids only, through the unchanged batch path.
2. Once the server accepts it, the new sheet id is stamped onto that sheet's attachment rows.
   Until then the queue skips them on purpose: the server keys an attachment to a log sheet, so
   uploading earlier is impossible.
3. `syncPendingAttachments` then uploads the files **one at a time**. Sequential is deliberate —
   on a weak field link three concurrent uploads are slower than one and far likelier to time
   out, and it bounds memory to a single blob at a time.

A dropped connection therefore costs exactly one file, and the next pass resumes where this one
stopped. The attachment pass runs in its own error boundary: a photo that will not upload never
fails a submission that already succeeded.

Each attachment shows its own state — «در انتظار ارسال» / «ارسال شد» / the failure reason — and
the field header shows the count («۱ از ۲ پیوست ارسال شد»). Pending attachments are also
included in the sync bar's count, because the badge means "work not yet on the server" and a
submitted sheet whose photos are still queued is exactly that.

**Retries are safe.** Each file carries a UUID minted on the device, so a retry the server has
already processed returns the existing record instead of creating a second copy.

Failures are classified rather than lumped together:

| Failure | What happens |
|---|---|
| Server unreachable (no HTTP response) | Row left **completely untouched** and the pass stops — a tunnel is not a rejection |
| `4xx` other than 401/408 | **Parked.** The server examined the file and refused it, so identical bytes get an identical refusal. It stops being retried, keeps its reason on screen, and offers a manual «تلاش مجدد» button |
| `401` | Retryable — an expired session is not a bad payload |
| `5xx` or anything unclassified | Retryable, with the reason recorded |

Parking matters: without it a permanently refused file would be re-sent on every sync pass for
the rest of the tablet's life. The bytes are kept either way, so nothing is lost — the operator
can look at the photo, fix whatever the server objected to, and re-queue it.

### Device storage

Once a file has been safely on the server for **7 days** its bytes are dropped from the device
while the metadata row stays. The attachment still appears in the form; opening it re-fetches
from the server. Without this a tablet would accumulate every photo ever taken on it.

At startup the app requests **persistent storage** (`navigator.storage.persist()`), which
exempts the origin from routine eviction. Chrome grants it silently to an installed PWA and
refuses it for a casual tab, so a refusal is normal and is only logged. Before opening the
camera the app checks free space and refuses the capture if the device is nearly full — checking
first means the operator is told to sync while they can still act on it, rather than losing the
shot to a failed write after taking it.

### Microphone permission

Photos and voice notes need **different** permissions, which surprises people: taking a photo
goes through a file input with `capture`, which hands off to the OS camera app and needs no
site permission at all, while recording audio goes through `getUserMedia`, which does. So a
tablet can happily take photos and then refuse to record.

The awkward part is that once microphone access has been denied for the origin, Chrome **never
prompts again** — every later attempt fails instantly with nothing to click. The app detects
that state up front via the Permissions API and, instead of showing the browser's raw
"Permission denied", spells out where the setting lives:

1. The 🔒 icon beside the address bar (or *Site settings* in the browser menu) → **Microphone**
   → *Allow*.
2. For an installed PWA: Android *Settings → Apps → this app → Permissions → Microphone*.
3. Reopen the page and press «ضبط صدا» again.

Other failures are separated out rather than lumped together, because the fixes differ: no
microphone on the device, the microphone held by another app (a call, a voice recorder), or a
page served over plain HTTP.

### Notes

- **HTTPS is required** for camera and microphone access. The mkcert setup described above
  already provides it; over plain HTTP `navigator.mediaDevices` is not merely restricted, it is
  *undefined* — the app checks for this explicitly so the operator gets a sentence rather than
  a `TypeError`.
- Deleting an attachment on the device is **local only**. A copy already on the server stays
  there deliberately — a submitted sheet's evidence should not vanish because someone tidied up
  their tablet.
- Video is not offered in the app. The backend understands the type end to end, so adding it
  later is a UI change rather than a redesign.

---

## When the Server Rejects a Submission

Most sync trouble never reaches this state. A dropped link, a server restart or a 5xx leaves the
sheet **pending** and the sync timer retries it automatically — nothing for the operator to do.

A sheet only becomes **failed** when the server answered and said no, for one of four reasons.
Three are not the operator's to fix (a missing server id, a sheet deleted server-side, an asset
that is not part of the sheet) and need a supervisor to reopen or extend it.

The fourth — **a required field left empty** — is different, and is handled in two places:

**Before submitting.** The app now checks required fields itself and refuses a final submit the
server would certainly reject, naming the asset and the field: «فیلدهای الزامی تکمیل نشده‌اند —
پمپ ۱: دما». The operator sees this while still standing at the form, instead of discovering it
after the work is already stuck.

The check mirrors the server's own rules exactly, including the awkward ones — an unchecked
required checkbox and a photo field whose only image was deleted both count as empty. It is
deliberately cautious: anything it cannot judge (an asset the device has no schema for, an
untouched asset on a multi-asset round) is allowed through, because blocking a submission the
server would have accepted would be a worse trap than the one it prevents.

**After a rejection.** A sheet rejected for field values shows «اصلاح مقادیر و ارسال مجدد».
That returns it to an editable draft — available **online**, unlike the ordinary offline-only
undo, because the fix requires editing and there is no sense waiting to lose signal. The entered
readings are kept; only the failure state is cleared.

There is deliberately **no "retry" button.** Re-sending the identical payload would earn the
identical refusal while displaying "trying again…", and reusing the old submission id could make
the server treat the retry as already processed — reporting success while storing nothing. A
resubmission is only legitimate once the data has actually changed, which is why the path runs
through editing.

---

## Synchronization

Three separate paths:

### A. Bootstrap pull (lightweight app context)

**When:** App start (if stale > 1 hour), coming online, before inbox merge.

```
GET /api/bootstrap
  → Response includes serverTime, userId, operationalUnits, accessibleUnitIds, supervisorScopeUnitIds, primaryUnitId
  → Client persists: operationalUnits (bulkPut) + syncMeta.lastBootstrapAt = serverTime
  → Unit scope for inbox/API is enforced on the server via JWT; scope ids in bootstrap are not stored locally today
```

**No full plant hierarchy or assets** are downloaded. Reference data arrives per log sheet bundle only.

### B. Inbox pull (kartabl)

**When:** Online + authenticated; auto on connect; manual refresh.

```
GET /api/log-sheets/inbox
  → assigned[] as LogSheetBundleDto (sheet + entries + scoped context)
  → pullBootstrapIfStale
  → mergeInboxIntoLocalSheets(assigned)   — server-wins merge for each bundle
  → reconcile revocations + save inbox snapshot
```

Opening a draft sheet online also refreshes via `GET /api/log-sheets/{id}/bundle`.

### C. Push (outbound data)

**When:** Online; every ~30 s; on `window.online` event.

```
SyncManager.sync()
  → mark expired submitted sheets
  → getPendingLogSheets()  — submitted + pending where assigneeUserId = session user,
                             PLUS this user's archived completions the server never saw
                             (see "Archived completions still reach the server" below)
  → POST /api/log-sheets/batch  (owner queue only)
  → POST /api/nfc-fault-reports/batch  (only reports this user filed, if permission)
  → cleanupLocalLogSheets()
  → on success: refresh inbox (remove submitted work from assigned list)
```

On user switch, `activateUserSession()` marks another user’s submitted (unsynced) sheets as `failed` + `REVOKED` locally. They re-enter the outbound queue only when that assignee logs back in and inbox revival runs. See [Shared Tablets and Enterprise Sync Policy](#shared-tablets-and-enterprise-sync-policy).

Log sheet batch payload includes `completedAt` (device completion time) and `clientActionId` for idempotency.

### Archived completions still reach the server

Work an operator completed offline can end up **detached** from the live `logSheets` row —
for example they logged out while still offline, another operator logged in on the same
tablet and the sheet was reassigned to them. In that case the original operator's
completion is moved into `logSheetUserArchives`, and the live row is handed to the new
user.

Those archived completions are **not** a dead end: the outbound queue drains them too, so
the server always learns the work happened and records it as a void submission
(`log_sheet_void_submissions` + a `SUPERSEDE` action) instead of the readings silently
disappearing. Rules that keep this safe:

- Only archives belonging to the **currently logged-in user** are pushed — never another
  operator's, which would attribute their work to the wrong person.
- A live row for the same sheet always wins, so nothing is submitted twice.
- `syncedAt` on the archive marks it resolved as soon as the server answers, so a
  permanently-rejected push is not retried on every sync forever.

### Local cleanup / history retention (`cleanupLocalLogSheets`)

Runs after every successful sync pass. It only deletes rows from the local `logSheets`
table — **nothing is ever deleted on the server**, and rows are only removed once they
are in a terminal state.

| State | Retention | Counted from |
|-------|-----------|--------------|
| Synced (sent successfully) | **24 hours**, then deleted locally | `syncedAt` → `submittedAt` → `updatedAt` → `createdAt` |
| Failed (server rejected: superseded / revoked / cancelled) | **7 days**, then deleted | `submittedAt` → `updatedAt` → `createdAt` |
| Expired draft (deadline passed, never submitted) | **24 hours**, then deleted | `dueAt` → `updatedAt` → `createdAt` |
| Active draft (in progress, not expired) | **Never** auto-deleted | — |
| Submitted, pending sync | **Never** auto-deleted — kept until the server answers | — |
| Synced, then **reopened** by a supervisor | **Never** while the new deadline stands; purged on the ordinary rules once it passes | `dueAt` decides whether the reopen is still live |
| **Archived snapshots** (`logSheetUserArchives`) | **Never** auto-deleted | — |

**What this means for operators:** a completed log sheet stays visible under **History**
on the device for roughly one day after it syncs; a rejected one for a week. After that
the local copy is purged to keep the tablet small — the record itself still lives on the
server and remains visible in the web admin panel. Only the **device-local** history is
time-limited.

**A reopened completion is held back from the purge on purpose.** It is live work again, and
the local row is where the continue action lives — but it is also the only place `filledVia`
survives, since the server never returns it. Re-downloading a purged copy would lose which
assets were filled manually, and editing one of those after the reopen would then re-stamp its
`entry_source` as `PWA_NFC` despite no scan ever happening.

**Archived snapshots are the exception and are kept indefinitely.** They are the only
copy of work that never reached the server (another user took the sheet over on the same
device, or a supervisor completed it while the operator still had unsent readings), so
they are deliberately excluded from every retention rule. A stale archive is removed only
when it becomes redundant — when the same user's own work for that sheet is confirmed
synced (`removeArchivedLogSheet`).

---

## IndexedDB Schema

Dexie version **2** — main tables:

| Table | Purpose |
|-------|---------|
| `assetClasses` | Asset class templates (per-sheet bundles only) |
| `assetEntries` | NFC tag → asset mapping (per-sheet bundles only) |
| `fieldDefinitions` | Normalized form fields per class |
| `locations`, `plantSystems`, `mainFunctions`, `subFunctions` | Hierarchy slice per active work |
| `logSheetTemplates` | Log sheet template slices carried by bundles |
| `logSheets` | Local log sheets + entries + sync state + `assigneeUserId` |
| `logSheetUserArchives` | Per-user archived snapshots on shared tablets (history / view-only; never auto-purged) |
| `attachments` | Captured photos / voice notes as native `Blob`s + upload state (added in version 2) |
| `nfcFaultReports` | Locally-filed NFC fault reports (unlock manual entry per asset; `createdByUserId` scopes outbound sync) |
| `operationalUnits` | From bootstrap |
| `settings` | App settings (server URL, operator name, manual-entry and chip-serial policies, …) |
| `syncMeta` | Key/value store (see below) |
| `outbox` | Future bidirectional sync infrastructure |

**`syncMeta` keys:**

| Key | Content |
|-----|---------|
| `authSession` | JWT session object |
| `sessionUserId` | Backend user id for shared-tablet isolation |
| `lastSessionUsername` | Previous login username (user switch detection) |
| `lastBootstrapAt` | Timestamp of last successful bootstrap pull |
| `inboxSnapshot` | Cached assigned / available / teamOpen lists |
| `lastSeq` | Reserved for future incremental sync engine |

`db.ts` declared a **single** `this.version(1)` block: the app has never shipped, so the
historical versions that only ever built up to that shape were collapsed into it — there was
no upgrade path to keep because there was no production data to upgrade. `this.version(2)`
was then added on top for the `attachments` table, repeating every version-1 store verbatim,
which is the pattern to follow from here on.

A development device that ran the app **before** the collapse holds an IndexedDB at version
110, and IndexedDB refuses to open a database at a lower version than it was created with.
`openDatabase()` catches exactly that `VersionError`, deletes the database and recreates it;
this is safe here because every table is either server-owned reference data that the next
sync refetches, or local work a pre-production device can afford to lose. Any other failure
is rethrown untouched.

When the schema next changes, **add** `this.version(3).stores({...})` with the full store
list rather than editing an existing version block. Note that adding a plain, non-indexed
property to a stored object needs no version bump at all — only new stores and new indexes do.

---

## API Contract

Full TypeScript definitions: **`src/services/api/index.ts`**

Backend: `backend-offline-first`, default port **8081**.

### Main endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Health check |
| POST | `/api/auth/login` | Login → JWT |
| GET | `/api/bootstrap` | Operational units + user context JSON (client stores units only; see [Synchronization](#synchronization)) |
| GET | `/api/log-sheets/inbox` | Inbox (`assigned` = full bundles) |
| GET | `/api/log-sheets/{id}/bundle` | Single sheet bundle (entries + scoped context) |
| POST | `/api/log-sheets/{id}/claim` | Pick up work → returns bundle |
| POST | `/api/log-sheets/{id}/release` | Return to pool (supervisor) |
| POST | `/api/log-sheets/{id}/assign` | Assign to operator |
| POST | `/api/log-sheets/{id}/reassign` | Reassign |
| GET | `/api/operational-units/{id}/operators` | Operator list for assign dialog |
| GET | `/api/asset-entries/nfc/{tagId}` | Global NFC lookup — used by the admin NFC inspector; the fill page matches against local entries |
| POST | `/api/asset-entries/{id}/nfc-serial` | Bind a scanned chip UID to an asset (admin NFC inspector) |
| POST | `/api/log-sheets/batch` | Push submitted log sheets |
| POST | `/api/nfc-fault-reports/batch` | Push locally-filed NFC fault reports |

### Inbox bundle shape (`LogSheetBundleDto`)

Each assigned item (and claim/bundle responses) contains:

| Part | Contents |
|------|----------|
| `sheet` | Server log sheet metadata (`ServerLogSheet`) — status, dueAt, assignee, template, scope, … |
| `entries` | Rows to fill (`ServerLogSheetEntry`) — assetId, assetName, nfcTagId, classId, formData, … |
| `context` | Scoped reference slice for **this sheet only** — locations, systems, functions, subFunctions, assetEntries, assetClasses, fieldDefinitions, optional `scopeDisplayLabel` |

Client merge: `mergeLogSheetBundle.ts` applies **server-wins** `bulkPut` for context tables and updates the local `logSheets` row + entries.

### Log sheet batch — important fields

```json
{
  "logSheets": [{
    "serverId": 42,
    "localId": "uuid",
    "completedAt": 1700000000000,
    "clientActionId": "uuid",
    "entries": [
      {
        "assetId": 1,
        "assetName": "Pump A",
        "nfcTagId": "E-0110CM2",
        "classId": 3,
        "formData": { "temperature": 85.5 }
      }
    ]
  }]
}
```

`completedAt` is the **device** completion time. The server evaluates deadlines against this value, not the sync time.

### API base URL

Stored in Settings (`serverUrl` in IndexedDB). If configured origin equals `window.location.origin`, requests use relative `/api/...` (same-origin nginx or Vite proxy).

**You do not put the data-server IP in the app when using nginx proxy.** The PWA always calls its own origin; nginx forwards `/api` to Spring.

---

## Production Deployment

### Reference architecture (split hosts)

Typical plant setup:

| Role | Host | Example |
|------|------|---------|
| **PWA** (nginx + static `dist/`) | `192.168.1.4` | `https://192.168.1.4` |
| **API** (Spring Boot) | `192.168.1.2:8081` | `http://192.168.1.2:8081` (not exposed to tablets directly) |

The tablet browser talks only to the **PWA origin**. nginx proxies `/api/` to Spring on the data server.

```
Tablet
    │
    ▼
https://192.168.1.4/api/log-sheets/inbox   ← same origin as the PWA
    │
    ▼
nginx (192.168.1.4:443)
    ├── /           → /var/www/html/offline-first-pwa/dist
    └── /api/*      → proxy → http://192.168.1.2:8081/api/
```

| What | Where to configure | Example |
|------|-------------------|---------|
| PWA URL (open / install) | nginx `listen` + SSL | `https://192.168.1.4` |
| Data server (Spring) | **nginx `proxy_pass` only** | `http://192.168.1.2:8081` |
| Build-time default `serverUrl` | `.env.mobile` → `VITE_SERVER_URL` | `https://192.168.1.4` |
| Settings → server URL in app | Same as PWA origin | `https://192.168.1.4` |

When `serverUrl` matches `window.location.origin`, the API client uses relative paths (`/api/...`).

> **Dev / preview:** Vite on `:4173` plays the same role as nginx — serves the PWA and proxies `/api` to `127.0.0.1:8081`.

---

### Step 1 — Build on a dev machine

```powershell
cd offline-first-pwa
copy .env.mobile.example .env.mobile
```

Edit `.env.mobile` — use the **PWA public URL**, not the Spring host:

```env
VITE_SERVER_URL=https://192.168.1.4
```

```powershell
$env:PATH = "C:\Program Files\nodejs;$env:PATH"
npm install
npm run build:mobile
```

Output: `dist/`. Copy the entire folder to the nginx server:

```bash
# example
scp -r dist/* root@192.168.1.4:/var/www/html/offline-first-pwa/dist/
```

**Use `build:mobile`**, not plain `npm run build` — it reads `.env.mobile` and embeds the correct default `serverUrl`.

Node.js is **not** required on the production PWA server after build.

---

### Step 2 — Self-signed SSL with internal CA (LAN / intranet)

For plant-floor tablets without public DNS, create a local CA and a server cert for the PWA IP. Install **`localCA.crt`** on each Android tablet (CA certificate) so Web NFC and PWA install work with a trusted lock.

On the **nginx server** (`192.168.1.4`):

```bash
sudo mkdir -p /etc/nginx/ssl/local
cd /etc/nginx/ssl/local

# 1) Root CA (keep localCA.key private — do not deploy to tablets)
sudo openssl genrsa -out localCA.key 4096
sudo openssl req -x509 -new -nodes \
  -key localCA.key -sha256 -days 3650 \
  -out localCA.crt \
  -subj "/C=IR/ST=Local/L=Local/O=Local Dev/CN=Local Dev Root CA"

# 2) Server key
sudo openssl genrsa -out nginx.key 2048

# 3) CSR config — set your PWA server IP in CN and alt_names
sudo nano server-cert.cnf
```

`server-cert.cnf`:

```ini
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = req_ext

[dn]
CN = 192.168.1.4

[req_ext]
subjectAltName = @alt_names

[v3_ext]
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
IP.1 = 192.168.1.4
DNS.1 = localhost
```

```bash
# 4) CSR + signed server cert
sudo openssl req -new -key nginx.key -out nginx.csr -config server-cert.cnf
sudo openssl x509 -req -in nginx.csr \
  -CA localCA.crt -CAkey localCA.key -CAcreateserial \
  -out nginx.crt -days 825 -sha256 \
  -extfile server-cert.cnf -extensions v3_ext

sudo chmod 600 localCA.key nginx.key
sudo chmod 644 localCA.crt nginx.crt
```

**On each Android tablet:**

1. Copy **`localCA.crt`** to the device (not `nginx.crt`).
2. Settings → Security → Encryption & credentials → Install a certificate → **CA certificate**
3. Select `localCA.crt`.
4. Force-stop Chrome and reopen.

**Do not copy `certs/` from mkcert dev setup to production nginx** — production uses `/etc/nginx/ssl/local/` above.

#### Easier alternative — mkcert

If you would rather not hand-write the OpenSSL config, **mkcert** does the same two jobs (a root CA + a server certificate carrying the IP in `subjectAltName`) in a couple of commands. Install it with `winget install FiloSottile.mkcert`, or download `mkcert-v1.4.4-windows-amd64.exe` from the mkcert releases page.

**1) Create the local CA and trust it on this machine:**

```powershell
mkcert.exe -install
```

**2) Find where the CA files live:**

```powershell
mkcert.exe -CAROOT
```

That folder holds `rootCA.pem` (the public CA — this is what goes on the tablets) and `rootCA-key.pem` (private — keep it on this machine only, and back it up; without it you cannot issue more certificates).

**3) Issue the server certificate for the PWA IP:**

```powershell
mkcert-v1.4.4-windows-amd64.exe 192.168.1.101
```

This writes `192.168.1.101.pem` (certificate) and `192.168.1.101-key.pem` (key) into the current directory — the same pair referenced in the Windows nginx comments of [Step 3](#step-3--nginx-site-config). Copy them next to your nginx config and point `ssl_certificate` / `ssl_certificate_key` at them.

Re-run this command for every extra name or address the server answers on, listing them together, e.g. `mkcert.exe 192.168.1.101 localhost 127.0.0.1`.

**4) Then copy `rootCA.pem` to each Android tablet** and install it exactly as in the list above (Settings → Security → Encryption & credentials → Install a certificate → **CA certificate**), then force-stop Chrome and reopen. If the Android file picker refuses the file, rename it to `rootCA.crt` — Android matches on the extension, the content is unchanged.

Equivalence with the OpenSSL steps:

| OpenSSL above | mkcert |
|---|---|
| `localCA.key` + `localCA.crt` | `rootCA-key.pem` + `rootCA.pem` (in `-CAROOT`) |
| `nginx.key` | `192.168.1.101-key.pem` |
| `nginx.crt` | `192.168.1.101.pem` |
| `server-cert.cnf` (`alt_names`) | implicit — the arguments become the SANs |
| Install `localCA.crt` on tablets | install `rootCA.pem` on tablets |

Two caveats: mkcert leaf certificates are valid for **825 days**, so re-issue and redeploy before they expire; and `mkcert -install` only trusts the CA on the machine that ran it — every other device (tablets, other PCs) still needs `rootCA.pem` installed manually.

---

### Step 3 — nginx site config

File: `/etc/nginx/sites-available/default` (or a dedicated site under `sites-available/offline-pwa`).

```nginx
worker_processes  1;

events {
    worker_connections 1024;
}

http {

    include       mime.types;
    default_type  application/octet-stream;

    server {
        listen 80;
        server_name 192.168.1.4;

        return 301 https://$host$request_uri;
    }

    server {
        listen 443 ssl;
        server_name 192.168.1.4;

        ssl_certificate     /etc/nginx/ssl/local/nginx.crt #D:/MyApp/nginx/ssl/192.168.1.101.pem;
        ssl_certificate_key /etc/nginx/ssl/local/nginx.key #D:/MyApp/nginx/ssl/192.168.1.101-key.pem;

        root /var/www/html/offline-first-pwa/dist #D:/MyApp/nginx/html/offline-first-pwa/dist;
        index index.html;

        location / {
            try_files $uri $uri/ /index.html;
        }

        location /api/ {
            proxy_pass http://192.168.1.4:8081/api/;

            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        location ~* (sw\.js|workbox-.*\.js)$ {
            add_header Cache-Control "no-cache";
        }
    }
}
```

Enable and reload:

```bash
sudo ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Verify from a PC on the LAN:

```bash
curl -k https://192.168.1.4/api/health
# better: curl https://192.168.1.4/api/health  (after trusting localCA on that PC)
```

---

### Step 4 — Tablet install

1. Open `https://192.168.1.4` in Chrome (trusted lock after CA install).
2. Log in as **admin** once per device (recommended):
   - **Settings** → confirm **Server URL** matches the PWA origin (`https://192.168.1.4`).
   - Enable **Allow manual tag entry** if operators need typed NFC IDs (iOS or damaged tags).
   - Optional: enable the **chip-serial scan check** if every asset has its NFC serial recorded.
3. Log in as field users; wait for inbox sync (assigned work appears).
4. Chrome menu → **Install app** (or use the in-app install prompt).

### Step 5 — Subsequent deploys

```powershell
npm run build:mobile
# copy dist/ to /var/www/html/offline-first-pwa/dist/
```

```bash
sudo systemctl reload nginx
```

Service Worker uses `autoUpdate` — tablets pick up the new build on next app open.

**Differences from dev (`preview:mobile`):**

| | Dev (`preview:mobile`) | Production (nginx) |
|--|------------------------|---------------------|
| HTTPS | mkcert in `certs/` | `/etc/nginx/ssl/local/` |
| Port | 4173 | 443 (or your choice) |
| API proxy | Vite → `127.0.0.1:8081` | nginx → `192.168.1.2:8081` |
| Build command | `build:mobile` | `build:mobile` |

---

## Troubleshooting

### Empty log sheet / no assets

- Inbox sync not run yet — open app online, wait for assigned bundles (or tap **Refresh inbox**)
- Work not in **assigned** (still in pickup pool) — claim first while online
- Offline before first bundle sync for that sheet — open once online
- Wrong `serverUrl` in Settings / build — must match PWA origin when using nginx or Vite proxy (see [Production Deployment](#production-deployment))

### Red SSL lock on phone (production)

| Cause | Fix |
|-------|-----|
| `localCA.crt` not installed on tablet | Install as **CA certificate** on Android |
| Wrong cert type (Wi‑Fi user cert) | Remove → install CA cert |
| IP in browser ≠ IP in cert SAN | Regenerate cert with correct `IP.1` in `server-cert.cnf` |

### Red SSL lock on phone (dev only)

| Cause | Fix |
|-------|-----|
| Empty `certs/` | `npm run setup:mkcert` |
| Wrong cert type (Wi‑Fi user cert) | Remove → install **CA certificate** |
| Browser IP ≠ IP in mkcert | Re-run setup with correct IP |
| Using port 5173 | Use **4173** |

### Install prompt does not appear

1. Trusted HTTPS (green lock)
2. **Production:** install from `https://192.168.1.4` (or your PWA URL)
3. **Dev:** install from `https://<PC-IP>:4173`, not `:5173`
4. Force-stop Chrome, reopen
5. iOS: Add to Home Screen manually

### White screen offline after install

PWA was installed from **5173** (dev server). Uninstall → `build:mobile` + `preview:mobile` → reinstall from **4173**.

### Login required every time

- Did you log out?
- Online + expired JWT → expected redirect to login
- Offline should keep session — check IndexedDB not cleared

### NFC does not work

- Trusted HTTPS
- Android Chrome
- Tag NDEF contains text matching `nfcTagId` on the asset
- Asset must be in **current log sheet entries** (pre-provisioned or sheet opened once)
- Log sheet fill page, not dashboard

### API errors

- Backend running on 8081?
- `serverUrl` in Settings matches app origin
- Phone and server reachable on same network (dev) or DNS (production)

### Terminal: `WARNING: No certs/cert.pem`

```powershell
npm run setup:mkcert
```

### Work shows “In progress” after local submit

Should show **Completed — pending sync** if local `status: submitted`. Refresh inbox list; check local log sheet exists for that `serverId`.

---

## Related Documentation

- **[`CLAUDE.md`](CLAUDE.md)** — entry point for AI agents, and the rule that these files are updated with the code
- **[`AGENTS.md`](AGENTS.md)** — architecture, invariants, commands, and the traps found the hard way
- **[`docs/sync.md`](docs/sync.md)** — synchronisation in full
- **[`docs/storage.md`](docs/storage.md)** — the local database
- **[`docs/device-features.md`](docs/device-features.md)** — NFC, camera, GPS, orientation
- **Backend** — `backend-offline-first`, whose `docs/` covers the schema, the log-sheet lifecycle, the background jobs and the reports

---

## License

Copyright (C) 2026 **hadi_hnp**

This project is free software: you can redistribute it and/or modify it under the terms of the [GNU General Public License v3.0 or later](https://www.gnu.org/licenses/gpl-3.0.html) (GPL-3.0-or-later).

See the [LICENSE](LICENSE) file for the full license text.
