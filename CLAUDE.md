# CLAUDE.md — راهنمای جامع پروژه offline-pwa

## هدف پروژه

اپلیکیشن جمع‌آوری اطلاعات میدانی برای محیط‌های صنعتی. کاربر (اپراتور) با تبلت به محل تجهیزات می‌رود، تگ NFC را اسکن می‌کند، فرم مربوط به آن تجهیز پر می‌کند، و داده‌ها هنگام اتصال به شبکه محلی به سرور ارسال می‌شوند. پروژه **offline-first** است — بدون اینترنت کار می‌کند.

---

## Stack فناوری

| لایه | ابزار |
|------|-------|
| UI Framework | React 18 + TypeScript |
| Build Tool | Vite |
| Component Library | MUI v5 (با RTL کامل) |
| RTL Engine | `@emotion/cache` + `stylis-plugin-rtl` |
| Local Storage | Dexie (IndexedDB wrapper) |
| Global State | Zustand (با `subscribeWithSelector`) |
| Form Handling | React Hook Form |
| Routing | React Router v6 |
| PWA | `vite-plugin-pwa` (Workbox generateSW) |
| Fonts | Vazirmatn (فونت فارسی، self-hosted) |

---

## ساختار پوشه‌ها

```
src/
├── components/
│   ├── common/        # SyncStatusBar (نوار وضعیت همگام‌سازی)
│   ├── forms/         # DynamicFormField, DynamicClassForm, DataEntryForm
│   ├── layout/        # AppLayout, Header, Sidebar
│   └── nfc/           # NFCReader
├── hooks/             # تمام React Hooks سفارشی
├── i18n/
│   └── fa.ts          # ترجمه‌های فارسی (typed object، بدون i18next)
├── pages/             # صفحات اصلی
├── services/
│   ├── api/           # client.ts + index.ts (تمام API callها اینجاست)
│   ├── nfc/           # لایه abstraction برای NFC
│   ├── storage/       # db.ts (Dexie schema) + repository.ts + index.ts
│   └── sync/          # SyncManager + pullMasterData
├── store/             # Zustand store (index.ts)
├── theme/             # MUI theme (RTL، رنگ‌ها، typography)
└── types/             # index.ts + sync.ts
```

---

## معماری کلی — چگونه کار می‌کند

### ۱. لایه‌بندی داده

```
سرور (REST API)
    ↕ فقط از طریق src/services/api/index.ts
Dexie (IndexedDB) — ذخیره‌سازی محلی
    ↕ فقط از طریق src/services/storage/index.ts
React Hooks (useAssets, useHierarchy, ...)
    ↕
کامپوننت‌های React (UI)
```

**قانون مهم:** هیچ کامپوننتی مستقیماً با `apiClient` یا `db` صحبت نمی‌کند. باید از service layer عبور کند.

### ۲. جریان داده برای اسکن NFC

```
کاربر NFC تگ را اسکن می‌کند
    → src/services/nfc/index.ts (NDEFReader API)
    → useNFC hook → serialNumber تگ
    → جستجوی AssetEntry در IndexedDB بر اساس nfcTagId
    → پیدا کردن AssetClass متناظر (فیلدهای فرم)
    → نمایش DynamicClassForm با فیلدهای تعریف‌شده در AssetClass
    → ذخیره DataRecord (با syncStatus='pending') در IndexedDB
    → SyncManager در پس‌زمینه به سرور ارسال می‌کند
```

### ۳. جریان همگام‌سازی — دو مسیر مجزا

**مسیر Push (ارسال داده به سرور):**
```
SyncManager.sync() — هر 30 ثانیه یا هنگام آنلاین شدن
    → getPendingRecords() از IndexedDB
    → POST /api/records/batch
    → به‌روزرسانی syncStatus در IndexedDB (synced/failed)
    → همچنین LogSheet های submitted را ارسال می‌کند
```

**مسیر Pull (دریافت master data از سرور):**
```
useMasterDataSync hook — هنگام start اپ، اگر داده‌ها stale باشند (>1 ساعت)
    → pullMasterData.ts
    → GET /api/master-data?since=<lastPullAt>
    → bulkPut تمام جداول IndexedDB (locations, systems, assetClasses, ...)
    → ذخیره serverTime به عنوان lastPullAt در syncMeta
```

### ۴. ساختار IndexedDB (Dexie v6)

```
records           — داده‌های جمع‌آوری‌شده میدانی
assetClasses      — کلاس‌های تجهیزات (با فیلدها)
assetEntries      — تجهیزات ثبت‌شده (NFC tag → class + SubFunction)
locations         — مکان‌های سلسله‌مراتبی
plantSystems      — سیستم‌های گیاه/واحد
mainFunctions     — فانکشن‌های اصلی
subFunctions      — SubFunction ها (دارای code + tag)
logSheetTemplates — قالب‌های Log Sheet (بر اساس scope)
logSheets         — Log Sheet های پر شده
fieldDefinitions  — فیلدهای نرمال‌شده (جدا از AssetClass.fields[])
outbox            — صف تغییرات برای sync engine آینده
syncMeta          — متادیتای sync (lastSeq, lastPullAt)
settings          — تنظیمات برنامه (URL سرور، نام اپراتور، ...)
```

**نکته migration:** هر نسخه Dexie schema با `.upgrade()` کامل است. نسخه ۵ جدول `assetTypes` را به `assetClasses` تبدیل کرد. نسخه ۶ جدول `fieldDefinitions` را اضافه کرد و فیلدها را از `AssetClass.fields[]` مهاجرت داد.

---

## مدل داده اصلی

### سلسله‌مراتب (Hierarchy)

```
Location (مکان — می‌تواند زیرمکان داشته باشد)
    └── PlantSystem (سیستم — وابسته به Location)
            └── MainFunction (فانکشن اصلی — وابسته به System یا Location)
                    └── SubFunction (وابسته به MainFunction، System، یا Location)
                            └── AssetEntry (تجهیز — وابسته به SubFunction + AssetClass)
```

هر سطح می‌تواند مستقیماً به سطوح بالاتر وصل باشد (flexibility برای ساختارهای مختلف کارخانه).

### تجهیزات (Assets)

- **AssetClass**: قالب تجهیز — نام کلاس + لیست `FormField[]`. مثال: «پمپ سانتریفیوژ» با فیلدهای دما، فشار، دور.
- **AssetEntry**: نمونه فیزیکی — یک NFC tag شناخته‌شده که به یک AssetClass و یک SubFunction وصل است.

### رکوردها

- **DataRecord**: یک بار اسکن + فرم پر شده. `recordStatus: 'draft' | 'approved'` — فقط approved ها ارسال می‌شوند.
- **LogSheet**: مجموعه‌ای از قرائت‌ها برای یک scope (مکان/سیستم/فانکشن) در یک نوبت. ساخته می‌شود از `LogSheetTemplate`.

---

## ساختار Navigation (سمت راست — RTL)

```
داشبورد          /
سوابق            /records
Log Sheet ها      /logsheets
اطلاعات پایه ▾   (expandable)
  مکان‌ها         /master-data/locations
  سیستم‌ها        /master-data/systems
  فانکشن‌های اصلی /master-data/functions
  SubFunction ها  /master-data/subfunctions
  کلاس‌ها         /master-data/classes
  Asset ها        /master-data/assets
  قالب‌های Log Sheet /master-data/templates
تنظیمات          /settings
```

`/admin` ریدایرکت به `/master-data/locations` می‌کند (backward compat).

---

## تصمیمات معماری مهم

### RTL
تمام برنامه RTL است. `stylis-plugin-rtl` روی emotion cache اعمال می‌شود و تمام `padding-left`/`margin-left` را به طور خودکار flip می‌کند. این یعنی در CSS باید از `pl`/`pr` به جای hard-coded استفاده شود تا MUI آن‌ها را درست flip کند.

### ترجمه بدون i18next
پروژه تک‌زبانه (فارسی) است. به جای i18next از یک typed object در `src/i18n/fa.ts` استفاده می‌شود. TypeScript‌ compile-time validation برای key های ترجمه فراهم می‌کند.

### NFC Abstraction
`src/services/nfc/index.ts` یک لایه swappable است. اگر در آینده از Web NFC به bridge بومی تبدیل شود، فقط این فایل تغییر می‌کند.

### API Client یکپارچه
`src/services/api/client.ts` یک HTTP client ساده است. `src/services/api/index.ts` تنها فایلی است که API endpoint ها را تعریف می‌کند. هیچ component یا hook دیگری مستقیماً `fetch` نمی‌زند.

### SyncManager Singleton
`syncManager` یک singleton است که در `AppLayout` از طریق `useSyncManager` hook راه‌اندازی می‌شود. هر 30 ثانیه و هنگام `window.online` sync می‌کند.

### آدرس سرور runtime-configurable
URL سرور در Settings ذخیره می‌شود (IndexedDB). `apiClient.getBaseUrl()` هر بار آن را از DB می‌خواند — کاربر می‌تواند بدون rebuild برنامه آدرس را عوض کند.

### Sync Engine آینده (Infrastructure آماده)
جداول `outbox` و `syncMeta` در DB هستند. `src/types/sync.ts` تعریف‌های `SyncableRecord`، `OutboxEntry`، `FieldDefinition` را دارد. API endpoint های `/api/sync/push` و `/api/sync/changes` تعریف شده‌اند. کد `push.ts` و `pull.ts` (bidirectional sync) هنوز پیاده‌سازی نشده اما infrastructure آماده است.

---

## صفحات اصلی

| صفحه | مسیر | توضیح |
|------|------|-------|
| Dashboard | `/` | آمار رکوردها، وضعیت sync، دکمه سریع جمع‌آوری |
| RecordsPage | `/records` | لیست DataRecord ها با filter draft/approved |
| LogSheetListPage | `/logsheets` | ایجاد و مدیریت Log Sheet ها |
| LogSheetFillPage | `/logsheets/:localId` | پر کردن Log Sheet (یک Asset در هر کارت) |
| AdminPage | `/master-data/:section` | اطلاعات پایه — section-based rendering |
| SettingsPage | `/settings` | URL سرور، نام اپراتور، تنظیمات NFC |

---

## نحوه Build و اجرا

```powershell
# Node.js در PATH نیست — باید اضافه شود
$env:PATH = "C:\Program Files\nodejs;$env:PATH"

# نصب dependencies
npm install

# اجرای dev server
npm run dev

# Build تولید
npm run build

# Type check بدون build
npx tsc --noEmit
```

---

## نکات مهم برای توسعه

1. **هرگز** مستقیماً `db.*` یا `fetch()` در کامپوننت‌ها نزنید. از service layer عبور کنید.
2. **هرگز** `apiClient` را خارج از `src/services/api/index.ts` import نکنید.
3. تمام entity های جدید باید `id: string` (UUID) داشته باشند، نه `++id` auto-increment.
4. برای field های جدید در IndexedDB باید یک نسخه جدید Dexie با `.upgrade()` اضافه شود.
5. اگر تجهیزی NFC tag ندارد، `allowManualEntry: true` در Settings باید فعال باشد.
6. Log Sheet ها فقط `submitted` را ارسال می‌کند — `draft` محلی می‌ماند.
7. `DataRecord` با `recordStatus: 'approved'` ارسال می‌شود — `draft` ارسال نمی‌شود.
