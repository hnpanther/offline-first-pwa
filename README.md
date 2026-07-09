# Field Data Collection System — Offline-First PWA

A progressive web application (PWA) for industrial field data collection. Operators use tablets on the plant floor, scan NFC tags on equipment, fill dynamic forms, and sync data to a Spring Boot backend when the network is available.

This repository is the **mobile / frontend** companion to the Java backend:

`backend-offline-first` (default port **8081**)

The UI is **Persian (RTL)**. This document is in English for developers and operators setting up the system.

---

## Table of Contents

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
13. [Log Sheet Workflow](#log-sheet-workflow)
14. [Offline Behavior](#offline-behavior)
15. [NFC](#nfc)
16. [Field Validation (Warning / Danger Ranges)](#field-validation-warning--danger-ranges)
17. [Synchronization](#synchronization)
18. [IndexedDB Schema](#indexeddb-schema)
19. [API Contract](#api-contract)
20. [Production Deployment](#production-deployment)
21. [Troubleshooting](#troubleshooting)

---

## Features

- **Offline-first** — work continues without network; data lives in IndexedDB on the device
- **PWA** — installable on Android tablets; app shell cached by Workbox
- **NFC tag scanning** — Web NFC on Android Chrome; manual tag entry for supervisors / senior operators
- **Log sheet inbox (kartabl)** — assigned work, pickup pool, supervisor team view
- **Selective reference data** — only per-log-sheet bundles (~open assigned work), not full plant master data
- **Automatic pre-provisioning** — assigned bundles (entries + assets + hierarchy slice) stored on inbox sync
- **Background sync** — submitted log sheets and approved records push to the server when online
- **Dynamic forms** — field definitions pulled from the server; warning/danger numeric ranges
- **Role-based UI** — admin master data and settings; supervisor assign/release/reassign

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
| Local storage | Dexie 4 (IndexedDB), schema version **8** |
| Global state | Zustand |
| Forms | React Hook Form |
| Routing | React Router v6 |
| Font | Vazirmatn (self-hosted) |
| i18n | Typed object in `src/i18n/fa.ts` (no i18next runtime) |
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

**Core rule:** UI and hooks never call `fetch()` or `db` directly. All server access goes through `src/services/api/index.ts`. All IndexedDB access goes through `src/services/storage/index.ts`.

**Layering:**

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
│   ├── auth/           ProtectedRoute, AdminRoute
│   ├── common/         SyncStatusBar, InstallPwaPrompt, LogSheetIdentityMeta, ScopeLabel
│   ├── forms/          DynamicClassForm, DynamicFormField, DataEntryForm
│   ├── layout/         AppLayout, Header, Sidebar
│   ├── logsheet/       AssignOperatorDialog
│   └── nfc/            NFCReader
├── hooks/
│   ├── useAuth.ts              Session restore, login/logout
│   ├── useInboxSync.ts         Inbox pull + offline snapshot + pre-provision
│   ├── useMasterDataSync.ts    Bootstrap pull on start / online (operational units only)
│   ├── useSync.ts              SyncManager lifecycle
│   ├── useLogSheets.ts         Local log sheet list
│   ├── useFieldDefinitions.ts  Field definitions per asset class
│   └── useOnlineStatus.ts      navigator.onLine → store
├── pages/
│   ├── LoginPage.tsx
│   ├── Dashboard.tsx
│   ├── LogSheetListPage.tsx    Inbox (active) + history
│   ├── LogSheetFillPage.tsx    Fill log sheet + NFC
│   ├── LogSheetTemplatePage.tsx
│   ├── AdminPage.tsx           Master data CRUD
│   └── SettingsPage.tsx          Admin only
├── services/
│   ├── api/            client.ts + all endpoints (index.ts)
│   ├── auth/           Session in IndexedDB
│   ├── nfc/            Web NFC abstraction
│   ├── storage/        Dexie db, repository, fieldDefinitions, inboxCache
│   └── sync/           SyncManager, pullBootstrap, pullInbox, mergeLogSheetBundle, logSheetSync, cleanup
├── store/              Zustand
├── types/              Domain types + auth + sync
├── utils/              logSheetStatus, fieldValidation, ids, scopeLabels, fieldOptions
└── i18n/fa.ts          Persian UI strings

certs/                  mkcert output (gitignored): cert.pem, key.pem, rootCA.crt
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
| `npm run lint` | — | — | ESLint | — |

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

API calls use the server URL from **Settings** (stored in IndexedDB). For local dev you can set `http://localhost:8081` in Settings after login (admin account).

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
6. **User switch** on a shared tablet clears inbox cache and hides other users’ local drafts (`sessionContext.ts`).

### Roles (frontend checks)

| Role | Code | Typical access |
|------|------|----------------|
| Admin | `ADMIN`, `HIGH_USER` | Master data, log sheet templates, **Settings** |
| Supervisor | `SUPERVISOR` (+ admin roles) | Team inbox, release, assign/reassign |
| Senior operator | `SENIOR_OPERATOR` | Manual NFC tag entry (when setting off) |
| Operator | default | Dashboard, log sheets, NFC |

Helpers in `src/types/auth.ts`: `isAdminRole()`, `isSupervisorRole()`, `canEnterTagManually()`.

---

## Navigation and Permissions

| Route | Who |
|-------|-----|
| `/` | All authenticated users |
| `/logsheets/active` | All — inbox + my work |
| `/logsheets/history` | All — submitted local history |
| `/logsheets/:localId` | All — fill page |
| `/logsheet-templates` | Admin only (sidebar) |
| `/master-data/*` | Admin only (sidebar) |
| `/settings` | Admin only (`AdminRoute` + sidebar) |

Operators see Dashboard and Log Sheets only.

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

### 6. Status in My Work

| Local state | Chip in inbox list |
|-------------|-------------------|
| Draft, in progress | Server status (e.g. In progress) |
| Submitted, not synced | **Completed — pending sync** |
| Submitted, synced | **Sent** |

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

### Stale data limitations

- Inbox snapshot may show revoked work until next online sync.
- Extended deadlines from supervisor apply after inbox sync.
- Updated asset metadata (e.g. NFC tag change) applies on the next inbox bundle or online bundle refresh (server wins).
- Shared tablet: logging in as a different user clears the previous inbox cache and hides other users’ local drafts.

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

Controlled by Settings **Allow manual tag entry** (admin) and roles `SUPERVISOR` / `SENIOR_OPERATOR` (always allowed when setting is off).

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

## Synchronization

Three separate paths:

### A. Bootstrap pull (lightweight app context)

**When:** App start (if stale > 1 hour), coming online, before inbox merge.

```
GET /api/bootstrap
  → operationalUnits, userId, accessibleUnitIds, supervisorScopeUnitIds
  → bulkPut operationalUnits in IndexedDB
  → syncMeta.lastBootstrapAt = serverTime
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
  → POST /api/log-sheets/batch  (submitted, pending, not failed)
  → POST /api/records/batch     (approved records, if permission)
  → cleanupLocalLogSheets()
```

Log sheet batch payload includes `completedAt` (device completion time) and `clientActionId` for idempotency.

### Local cleanup (after successful sync)

| State | Retention |
|-------|-----------|
| Synced | 1 day, then deleted locally |
| Failed | 7 days, then deleted |
| Draft | Never auto-deleted |
| Submitted, pending sync | Kept until synced or failed |

---

## IndexedDB Schema

Dexie version **8** — main tables:

| Table | Purpose |
|-------|---------|
| `records` | Legacy field DataRecords |
| `assetClasses` | Asset class templates (per-sheet bundles only) |
| `assetEntries` | NFC tag → asset mapping (per-sheet bundles only) |
| `fieldDefinitions` | Normalized form fields per class |
| `locations`, `plantSystems`, `mainFunctions`, `subFunctions` | Hierarchy slice per active work |
| `logSheetTemplates` | Log sheet templates (legacy / admin) |
| `logSheets` | Local log sheets + entries + sync state + `assigneeUserId` |
| `operationalUnits` | From bootstrap |
| `settings` | App settings (server URL, operator name, …) |
| `syncMeta` | `authSession`, `lastBootstrapAt`, `inboxSnapshot`, `sessionUserId`, … |
| `outbox` | Future bidirectional sync infrastructure |

---

## API Contract

Full TypeScript definitions: **`src/services/api/index.ts`**

Backend: `backend-offline-first`, default port **8081**.

### Main endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Health check |
| POST | `/api/auth/login` | Login → JWT |
| GET | `/api/bootstrap` | Operational units + user context (no full master dump) |
| GET | `/api/master-data` | Backward-compat alias → same as bootstrap |
| GET | `/api/log-sheets/inbox` | Inbox (`assigned` = full bundles) |
| GET | `/api/log-sheets/{id}/bundle` | Single sheet bundle (entries + scoped context) |
| POST | `/api/log-sheets/{id}/claim` | Pick up work → returns bundle |
| POST | `/api/log-sheets/{id}/release` | Return to pool (supervisor) |
| POST | `/api/log-sheets/{id}/assign` | Assign to operator |
| POST | `/api/log-sheets/{id}/reassign` | Reassign |
| GET | `/api/operational-units/{id}/operators` | Operator list for assign dialog |
| GET | `/api/asset-entries/nfc/{tagId}` | Global NFC lookup (optional; fill page uses local entries) |
| POST | `/api/log-sheets/batch` | Push submitted log sheets |
| POST | `/api/records/batch` | Push approved DataRecords |

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

---

### Step 3 — nginx site config

File: `/etc/nginx/sites-available/default` (or a dedicated site under `sites-available/offline-pwa`).

```nginx
server {
    listen 80;
    server_name 192.168.1.4;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name 192.168.1.4;

    ssl_certificate     /etc/nginx/ssl/local/nginx.crt;
    ssl_certificate_key /etc/nginx/ssl/local/nginx.key;

    root /var/www/html/offline-first-pwa/dist;
    index index.html;

    # PWA + SPA routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API → Spring Boot on data server (different host is fine)
    location /api/ {
        proxy_pass http://192.168.1.2:8081/api/;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Service Worker — avoid aggressive caching
    location ~* (sw\.js|workbox-.*\.js)$ {
        add_header Cache-Control "no-cache";
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
2. Log in.
3. Wait for inbox sync (assigned work appears).
4. Chrome menu → **Install app** (or use the in-app install prompt).

---

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

- Inbox sync not run yet — open app online, wait for assigned bundles
- Work not in **assigned** (still in pickup pool) — claim first while online
- Offline before first bundle sync for that sheet — open once online

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

### Empty log sheet / no assets

- Master data not pulled — go online, wait for sync or admin Settings sync
- Template scope has no assets in local `assetEntries`
- Inbox sync not run yet — open app online, refresh inbox

### Terminal: `WARNING: No certs/cert.pem`

```powershell
npm run setup:mkcert
```

### Work shows “In progress” after local submit

Should show **Completed — pending sync** if local `status: submitted`. Refresh inbox list; check local log sheet exists for that `serverId`.

---

## Related Documentation

- **`CLAUDE.md`** — detailed architecture notes for AI assistants (Persian)
- **Backend** — `backend-offline-first` repository for server-side log sheet lifecycle, validation rules, and admin web UI

---

## License

Private / internal project. See repository owner for terms.
