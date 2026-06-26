# سیستم جمع‌آوری اطلاعات — Offline PWA

اپلیکیشن وب پیشرفته (PWA) برای جمع‌آوری اطلاعات میدانی با پشتیبانی آفلاین، اسکن NFC، و همگام‌سازی خودکار با سرور.

---

## ساختار پروژه

```
src/
├── components/
│   ├── common/           SyncStatusBar
│   ├── forms/            DataEntryForm, DynamicFormField, DynamicClassForm
│   ├── layout/           AppLayout, Header, Sidebar
│   └── nfc/              NFCReader
├── hooks/
│   ├── useNFC.ts         اسکن NFC و بارگذاری AssetEntry
│   ├── useSync.ts        وصل کردن SyncManager به Store
│   ├── useMasterDataSync.ts  pull پیکربندی از سرور
│   ├── useRecords.ts     CRUD رکوردهای DataRecord
│   ├── useAssets.ts      CRUD AssetClass و AssetEntry
│   ├── useHierarchy.ts   CRUD ساختار سلسله‌مراتبی
│   ├── useLogSheets.ts   CRUD Log Sheet ها
│   └── useSettings.ts    خواندن/نوشتن تنظیمات
├── pages/
│   ├── Dashboard.tsx
│   ├── RecordsPage.tsx
│   ├── LogSheetListPage.tsx
│   ├── LogSheetFillPage.tsx
│   ├── AdminPage.tsx
│   └── SettingsPage.tsx
├── services/
│   ├── api/
│   │   ├── client.ts     HTTP client (base URL از تنظیمات می‌آید)
│   │   └── index.ts      ← همه endpoint های سرور اینجا تعریف می‌شوند
│   ├── nfc/index.ts      لایه NFC (Web NFC API)
│   ├── storage/
│   │   ├── db.ts         Dexie schema (v1→v6)
│   │   ├── index.ts      CRUD توابع برای همه entity ها
│   │   ├── repository.ts Generic sync-aware Repository با outbox
│   │   └── fieldDefinitions.ts  CRUD برای FieldDefinition
│   └── sync/
│       ├── index.ts      SyncManager (push DataRecord + LogSheet)
│       └── pullMasterData.ts  pull پیکربندی از سرور
├── store/index.ts        Zustand store
├── theme/index.ts        MUI RTL theme
├── i18n/fa.ts            همه متن‌های فارسی
└── types/
    ├── index.ts          همه domain types
    └── sync.ts           SyncableRecord, FieldDefinition, OutboxEntry
```

---

## راه‌اندازی محلی

```bash
# نصب وابستگی‌ها (Node.js >=20 نیاز است)
npm install

# توسعه (با hot reload)
npm run dev       # http://0.0.0.0:5173

# ساخت production
npm run build

# پیش‌نمایش build
npm run preview   # http://0.0.0.0:4173
```

> **نکته Windows:** اگر `node` در PATH نیست، در PowerShell بنویسید:
> ```powershell
> $env:PATH = "C:\Program Files\nodejs;$env:PATH"
> npm run dev
> ```

---

## قرارداد API سرور

همه endpoint ها در `src/services/api/index.ts` تعریف شده‌اند.
آدرس base URL را در صفحه تنظیمات اپ وارد کنید (مثال: `http://192.168.1.100:3000`).

---

### ۱. Health Check

```
GET /api/health
```

**Response:**
```json
{ "status": "ok", "version": "1.0.0", "serverTime": 1700000000000 }
```

---

### ۲. Master Data — دریافت پیکربندی از سرور

**این مهم‌ترین endpoint است.** دستگاه هنگام اتصال به شبکه این را صدا می‌زند تا ساختار Asset ها، فرم‌ها، سلسله‌مراتب، و قالب‌های Log Sheet را دانلود کند.

```
GET /api/master-data
GET /api/master-data?since=1700000000000
```

- بدون `since`: سرور **همه** داده‌ها را برمی‌گرداند (اولین اجرا)
- با `since` (Unix timestamp به میلی‌ثانیه): سرور فقط رکوردهایی که **بعد از آن زمان** تغییر کرده‌اند را برمی‌گرداند (pull افزایشی)

**Response:**
```json
{
  "serverTime": 1700000000000,
  "locations": [
    { "id": "loc-1", "code": "U01", "name": "واحد ۰۱", "parentId": null, "createdAt": 1700000000000, "updatedAt": 1700000000000 }
  ],
  "plantSystems": [
    { "id": "sys-1", "code": "SYS-GAS", "name": "سیستم گاز", "locationId": "loc-1", "createdAt": 1700000000000, "updatedAt": 1700000000000 }
  ],
  "mainFunctions": [
    { "id": "mf-1", "code": "MF-001", "name": "فانکشن اصلی ۱", "systemId": "sys-1", "locationId": null, "createdAt": 1700000000000, "updatedAt": 1700000000000 }
  ],
  "subFunctions": [
    { "id": "sf-1", "code": "SF-001", "name": "SubFunction ۱", "tag": "TAG-001", "mainFunctionId": "mf-1", "systemId": null, "locationId": null, "createdAt": 1700000000000, "updatedAt": 1700000000000 }
  ],
  "assetClasses": [
    {
      "id": "cls-1",
      "name": "پمپ سانتریفیوژ",
      "fields": [
        { "name": "pressure", "label": "فشار خروجی (bar)", "type": "number", "required": true, "min": 0, "max": 50 },
        { "name": "status", "label": "وضعیت", "type": "select", "required": true, "options": [{ "value": "ok", "label": "سالم" }, { "value": "fault", "label": "معیوب" }] }
      ],
      "createdAt": 1700000000000,
      "updatedAt": 1700000000000
    }
  ],
  "fieldDefinitions": [
    {
      "id": "fd-uuid-1", "classId": "cls-1", "key": "pressure", "label": "فشار خروجی (bar)",
      "dataType": "number", "unit": "bar", "required": true,
      "validation": { "min": 0, "max": 50 },
      "order": 0, "version": 1, "deleted": false, "synced": true,
      "createdAt": 1700000000000, "updatedAt": 1700000000000
    }
  ],
  "assetEntries": [
    {
      "id": "ae-1", "nfcTagId": "04:AB:CD:EF:01:02:03", "classId": "cls-1",
      "assetName": "پمپ P-101", "subFunctionId": "sf-1", "location": "سالن A",
      "createdAt": 1700000000000, "updatedAt": 1700000000000
    }
  ],
  "logSheetTemplates": [
    {
      "id": "tmpl-1", "name": "بازرسی روزانه واحد ۰۱",
      "description": "قالب چک‌لیست صبحگاهی",
      "scopeType": "location", "scopeId": "loc-1",
      "createdAt": 1700000000000, "updatedAt": 1700000000000
    }
  ]
}
```

---

### ۳. Asset Lookup — جستجوی Asset بر اساس NFC

هنگامی که کاربر NFC تگ را اسکن می‌کند و اتصال شبکه دارد، دستگاه این endpoint را می‌زند.

```
GET /api/asset-entries/nfc/:tagId
```

مثال: `GET /api/asset-entries/nfc/04%3AAB%3ACD%3AEF%3A01%3A02%3A03`

**Response 200:**
```json
{
  "entry": {
    "id": "ae-1", "nfcTagId": "04:AB:CD:EF:01:02:03", "classId": "cls-1",
    "assetName": "پمپ P-101", "subFunctionId": "sf-1", "location": "سالن A",
    "createdAt": 1700000000000, "updatedAt": 1700000000000
  },
  "assetClass": {
    "id": "cls-1", "name": "پمپ سانتریفیوژ",
    "fields": [ ... ],
    "createdAt": 1700000000000, "updatedAt": 1700000000000
  }
}
```

**Response 404:**
```json
{ "error": "tag not registered" }
```

> اگر دستگاه آفلاین است، اطلاعات از IndexedDB محلی خوانده می‌شود.

---

### ۴. ارسال DataRecord ها (push)

فقط رکوردهایی که `recordStatus === 'approved'` دارند ارسال می‌شوند.

```
POST /api/records/batch
Content-Type: application/json
```

**Request Body:**
```json
{
  "records": [
    {
      "localId": "550e8400-e29b-41d4-a716-446655440000",
      "nfcTagId": "04:AB:CD:EF:01:02:03",
      "assetEntryId": "ae-1",
      "assetName": "پمپ P-101",
      "assetTypeId": "cls-1",
      "recordStatus": "approved",
      "formData": { "pressure": 3.5, "status": "ok" },
      "operatorName": "علی احمدی",
      "location": "سالن A",
      "notes": null,
      "createdAt": 1700000000000,
      "updatedAt": 1700000000000,
      "syncStatus": "pending"
    }
  ]
}
```

**Response 200:**
```json
[
  { "localId": "550e8400-...", "serverId": "REC-2024-001" },
  { "localId": "660e8400-...", "error": "asset not found" }
]
```

- **serverId**: شناسه‌ای که سرور به رکورد می‌دهد — در IndexedDB ذخیره می‌شود
- **error**: اگر وجود دارد، رکورد با `syncStatus='failed'` نگه داشته می‌شود و مجدداً تلاش می‌شود

---

### ۵. ارسال Log Sheet ها (push)

فقط Log Sheet هایی که `status === 'submitted'` دارند ارسال می‌شوند.

```
POST /api/log-sheets/batch
Content-Type: application/json
```

**Request Body:**
```json
{
  "logSheets": [
    {
      "id": "uuid-ls-1",
      "localId": "uuid-ls-local-1",
      "templateId": "tmpl-1",
      "templateName": "بازرسی روزانه واحد ۰۱",
      "scopeSummary": "بازرسی روزانه واحد ۰۱",
      "operatorName": "علی احمدی",
      "status": "submitted",
      "submittedAt": 1700000000000,
      "createdAt": 1700000000000,
      "updatedAt": 1700000000000,
      "entries": [
        {
          "assetId": "ae-1",
          "assetName": "پمپ P-101",
          "subFunctionCode": "SF-001",
          "subFunctionTag": "TAG-001",
          "classId": "cls-1",
          "formData": { "pressure": 3.5, "status": "ok" }
        }
      ]
    }
  ]
}
```

**Response 200:**
```json
[
  { "localId": "uuid-ls-local-1", "serverId": "LS-2024-001" },
  { "localId": "uuid-ls-local-2", "error": "template not found" }
]
```

---

### ۶. Outbox Push — ارسال تغییرات پیکربندی (آینده)

این endpoint برای زمانی است که adminهای محلی تغییراتی در Asset Class ها، ساختار سلسله‌مراتبی، یا قالب‌ها ایجاد کنند و بخواهند آن را به سرور ارسال کنند.

```
POST /api/sync/push
Content-Type: application/json
```

**Request Body:**
```json
{
  "entries": [
    {
      "id": "outbox-uuid-1",
      "entityType": "asset_class",
      "entityId": "cls-new",
      "operation": "create",
      "payload": { "id": "cls-new", "name": "کمپرسور", "fields": [...], ... },
      "createdAt": 1700000000000,
      "synced": false
    }
  ]
}
```

**entityType مقادیر معتبر:**
- `asset_class`
- `field_definition`
- `asset_entry`
- `location`
- `plant_system`
- `main_function`
- `sub_function`
- `log_sheet_template`

**Response 200:**
```json
[
  { "id": "outbox-uuid-1", "accepted": true },
  { "id": "outbox-uuid-2", "accepted": false, "error": "conflict: newer version on server" }
]
```

---

### ۷. Incremental Pull — دریافت تغییرات افزایشی (آینده)

برای sync دو طرفه‌ای که تغییرات سرور را به دستگاه می‌آورد.

```
GET /api/sync/changes?since=<seq>
```

**Response 200:**
```json
{
  "latestSeq": 1042,
  "changes": [
    {
      "seq": 1040,
      "entityType": "asset_entry",
      "entityId": "ae-5",
      "operation": "update",
      "payload": { "id": "ae-5", "assetName": "پمپ P-105 (ویرایش)", ... }
    },
    {
      "seq": 1041,
      "entityType": "sub_function",
      "entityId": "sf-3",
      "operation": "delete",
      "payload": { "id": "sf-3", "deleted": true, ... }
    }
  ]
}
```

---

## جریان sync — خلاصه

```
┌─────────────────────────────────────────────────────────────────┐
│  Pull (پیکربندی از سرور → IndexedDB)                           │
│                                                                 │
│  App start / online event                                       │
│    → GET /api/master-data[?since=T]                            │
│    → bulkPut to: locations, systems, functions,                 │
│                  assetClasses, fieldDefinitions,                │
│                  assetEntries, logSheetTemplates                │
│    → update syncMeta.lastPullAt                                 │
└─────────────────────────────────────────────────────────────────┘
                          ↕ آفلاین: کار با IndexedDB

┌─────────────────────────────────────────────────────────────────┐
│  Push (داده‌های جمع‌آوری شده → سرور)                          │
│                                                                 │
│  هر 30 ثانیه (یا هنگام اتصال)                                 │
│    → POST /api/records/batch        (approved DataRecords)      │
│    → POST /api/log-sheets/batch     (submitted LogSheets)       │
│    ← { localId, serverId } per record                          │
│    → update syncStatus='synced' or 'failed' in IndexedDB       │
└─────────────────────────────────────────────────────────────────┘
```

---

## فایل‌های کلیدی برای توسعه سرور

| فایل frontend | توضیح |
|---|---|
| `src/services/api/index.ts` | **مرجع اصلی** — همه callها و type های request/response اینجاست |
| `src/services/api/client.ts` | HTTP client — base URL، error handling |
| `src/types/index.ts` | Domain types: AssetClass, AssetEntry, LogSheet, DataRecord، ... |
| `src/types/sync.ts` | Sync types: FieldDefinition, OutboxEntry، ... |
| `src/services/sync/index.ts` | SyncManager — منطق push |
| `src/services/sync/pullMasterData.ts` | منطق pull پیکربندی |

---

## استقرار در شبکه خصوصی

```bash
npm run build      # خروجی در dist/
```

### با nginx

```nginx
server {
    listen 80;
    root /var/www/offline-pwa/dist;
    index index.html;

    # همه routeها به index.html برگردانده می‌شوند (SPA)
    location / {
        try_files $uri $uri/ /index.html;
    }

    # کش طولانی برای asset های hashed
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Service worker نباید کش شود
    location /sw.js {
        add_header Cache-Control "no-cache";
    }
}
```

### با Node.js/Express

```js
import express from 'express'
const app = express()
app.use(express.static('dist'))
app.get('*', (_, res) => res.sendFile('dist/index.html', { root: '.' }))
app.listen(80)
```

---

## HTTPS و NFC

Web NFC API فقط روی **HTTPS** یا **localhost** کار می‌کند.

برای تبلت‌های متصل به شبکه محلی:
```bash
# گزینه ۱: self-signed cert با mkcert
mkcert -install
mkcert 192.168.1.100

# گزینه ۲: اجرای dev server با HTTPS
npm run dev -- --https

# گزینه ۳: nginx با SSL (توصیه شده برای production)
```

اگر NFC پشتیبانی نشود یا HTTPS نباشد، کاربر می‌تواند شناسه تگ را دستی وارد کند (اگر در تنظیمات فعال شده باشد).

---

## اضافه کردن احراز هویت (آینده)

معماری برای auth آماده است:

1. توکن را در `AppSettings` ذخیره کنید
2. در `src/services/api/client.ts` هدر اضافه کنید:
   ```ts
   headers: {
     'Authorization': `Bearer ${token}`,
     'Content-Type': 'application/json'
   }
   ```
3. صفحه Login و route های protected اضافه کنید

---

## تکنولوژی‌ها

| ابزار | نقش |
|-------|------|
| React 18 + TypeScript | فریمورک |
| Vite + vite-plugin-pwa | Build + Service Worker |
| MUI v5 + stylis-plugin-rtl | UI با پشتیبانی RTL |
| Dexie v4 (IndexedDB) | ذخیره‌سازی offline |
| Zustand | State management |
| React Hook Form | فرم‌ها |
| Web NFC API | اسکن تگ |
| Vazirmatn | فونت فارسی |
