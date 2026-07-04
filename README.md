# سیستم جمع‌آوری اطلاعات — Offline PWA

اپلیکیشن وب پیشرفته (PWA) برای جمع‌آوری اطلاعات میدانی با پشتیبانی **آفلاین‌اول**، اسکن **NFC**، کارتابل **لاگ‌شیت**، و همگام‌سازی خودکار با backend Spring.

این سند راهنمای کامل راه‌اندازی، تست روی موبایل، نصب PWA، HTTPS با mkcert، و رفتار آنلاین/آفلاین است — **با توضیح علت هر مرحله**.

---

## فهرست

1. [پیش‌نیازها](#پیش‌نیازها)
2. [معماری آفلاین‌اول](#معماری-آفلاین‌اول)
3. [اسکریپت‌ها و حالت‌های اجرا](#اسکریپت‌ها-و-حالت‌های-اجرا)
4. [راه‌اندازی کامل تست موبایل (گام‌به‌گام)](#راه‌اندازی-کامل-تست-موبایل-گام‌به‌گام)
5. [HTTPS و mkcert — چرا و چگونه](#https-و-mkcert--چرا-و-چگونه)
6. [نصب PWA روی گوشی](#نصب-pwa-روی-گوشی)
7. [تست آفلاین](#تست-آفلاین)
8. [سناریوی آنلاین/آفلاین (اپراتور و سرپرست)](#سناریوی-آفلاینآنلاین-اپراتور-و-سرپرست)
9. [احراز هویت و لاگین خودکار](#احراز-هویت-و-لاگین-خودکار)
10. [NFC](#nfc)
11. [جریان همگام‌سازی](#جریان-همگام‌سازی)
12. [ساختار پروژه](#ساختار-پروژه)
13. [قرارداد API](#قرارداد-api)
14. [استقرار production](#استقرار-production)
15. [عیب‌یابی](#عیب‌یابی)

---

## پیش‌نیازها

| ابزار | نسخه / توضیح |
|--------|----------------|
| Node.js | 20+ |
| npm | همراه Node |
| Backend | پروژه `backend-offline-first` روی پورت **8081** |
| شبکه | PC و گوشی روی **همان Wi‑Fi** (برای sync و API) |
| مرورگر موبایل | Chrome Android (NFC + PWA) یا Safari iOS (بدون NFC، نصب دستی) |

**Windows — اگر `node` در PATH نیست:**

```powershell
$env:PATH = "C:\Program Files\nodejs;$env:PATH"
```

---

## معماری آفلاین‌اول

```
┌─────────────────────────────────────────────────────────────┐
│  UI (React)                                                  │
│    ↕ Zustand store                                           │
│  IndexedDB (Dexie)  ← منبع حقیقت محلی                        │
│    • authSession, settings, master data, log sheets, ...       │
│  Service Worker (Workbox)  ← shell اپ + فایل‌های build       │
└─────────────────────────────────────────────────────────────┘
         │ آنلاین                          │ آفلاین
         ▼                                 ▼
   Spring Backend (:8081)            فقط IndexedDB + SW cache
   /api/master-data, inbox, batch
```

**اصل مهم:** داده‌های کاری (لاگ‌شیت، فرم‌ها، تنظیمات) روی دستگاه در IndexedDB ذخیره می‌شوند. API فقط برای pull/push و عملیات کارتابل **آنلاین** است.

---

## اسکریپت‌ها و حالت‌های اجرا

| دستور | پورت | HTTPS | کاربرد | آفلاین PWA |
|--------|------|-------|--------|------------|
| `npm run dev` | 5173 | خیر | توسعه روی PC | ❌ |
| `npm run dev:mobile` | 5173 | بله (mkcert یا self-signed) | توسعه با hot reload روی موبایل | ❌ **نصب نکنید** |
| `npm run build:mobile` | — | — | ساخت production در `dist/` | — |
| `npm run preview:mobile` | **4173** | بله (mkcert) | **تست و نصب PWA واقعی** | ✅ |
| `npm run setup:mkcert` | — | — | ساخت گواهی trusted | — |

### چرا دو پورت؟

| | `:5173` dev | `:4173` preview |
|--|-------------|-----------------|
| **چی سرو می‌شود** | سورس زنده Vite (`/src/...`) | فایل‌های build شده در `dist/` |
| **Service Worker** | dev SW — precache ناقص | ~۳۰ فایل precache (JS, CSS, فونت, …) |
| **Wi‑Fi خاموش** | گوشی به PC وصل نیست → JS لود نمی‌شود → **صفحه سفید** | shell از cache → **UI باز می‌شود** |
| **کی استفاده کنیم** | دیباگ و تغییر کد | نصب PWA و تست آفلاین |

> **قانون طلایی:** PWA را **فقط از `https://IP-PC:4173`** نصب کنید، نه از 5173.

---

## راه‌اندازی کامل تست موبایل (گام‌به‌گام)

### مرحله ۰ — نصب وابستگی‌ها

```powershell
cd offline-first-pwa
npm install
```

---

### مرحله ۱ — Backend

```powershell
cd ..\backend-offline-first
.\mvnw.cmd spring-boot:run
```

**علت:** API روی `http://127.0.0.1:8081` است. در حالت mobile، Vite درخواست‌های `/api` را به این آدرس proxy می‌کند تا گوشی فقط با یک origin (HTTPS frontend) کار کند.

---

### مرحله ۲ — پیدا کردن IP کامپیوتر

```powershell
ipconfig
```

مثال: `192.168.1.101` — PC و گوشی باید در یک subnet باشند.

---

### مرحله ۳ — فایل محیط موبایل

```powershell
cd offline-first-pwa
copy .env.mobile.example .env.mobile
```

فایل `.env.mobile` را ویرایش کنید:

```env
VITE_SERVER_URL=https://192.168.1.101:4173
```

**علت:**
- IP باید IP واقعی PC شما باشد.
- پورت **4173** برای PWA نصب‌شده (preview).
- این مقدار پیش‌فرض `serverUrl` در IndexedDB است؛ API وقتی origin اپ با این URL یکی باشد از **مسیر نسبی** `/api` استفاده می‌کند (همان proxy).

---

### مرحله ۴ — mkcert (گواهی trusted)

```powershell
npm run setup:mkcert
# یا با IP مشخص:
.\scripts\setup-mkcert.ps1 -Ip 192.168.1.101
```

**خروجی مورد انتظار در `certs/`:**

```
certs/cert.pem      ← گواهی سرور (روی PC)
certs/key.pem       ← کلید خصوصی (روی PC)
certs/rootCA.crt    ← برای نصب روی گوشی
```

**علت:** NFC و PWA Install روی موبایل به **HTTPS مورد اعتماد** نیاز دارند. گواهی self-signed خود Vite (`basic-ssl`) trusted نیست → قفل قرمز، بدون Install.

وقتی `certs/cert.pem` وجود داشته باشد، Vite خودکار از mkcert استفاده می‌کند. در ترمینال می‌بینید:

```
[mobile] HTTPS: mkcert (certs/cert.pem)
```

اگر ببینید `WARNING: No certs/cert.pem` هنوز از self-signed استفاده می‌شود.

---

### مرحله ۵ — نصب CA روی گوشی (Android)

1. فایل **`certs/rootCA.crt`** را به گوشی بفرستید (نه `cert.pem`).
2. **Settings → Security → More security settings**
3. **Encryption & credentials → Install a certificate**
4. **CA certificate** ← فقط این گزینه (نه WiFi/VPN / user certificate)
5. فایل `rootCA.crt` را انتخاب و تأیید کنید.
6. Chrome را **Force stop** کنید.

**علت گزینه اشتباه WiFi/VPN:** آن گواهی **کاربر** است برای شبکه سازمانی، نه اعتماد به HTTPS سایت. با نصب اشتباه، قفل همچنان قرمز می‌ماند.

**iOS:** فایل را نصب کنید → **Settings → General → About → Certificate Trust Settings** → Full Trust برای mkcert.

---

### مرحله ۶ — Build و Preview

```powershell
npm run build:mobile
npm run preview:mobile
```

**علت build:** Service Worker فقط روی فایل‌های `dist/` precache کامل دارد.

---

### مرحله ۷ — باز کردن در گوشی

```
https://192.168.1.101:4173
```

- قفل SSL باید **بدون قرمز** باشد.
- یک‌بار **login** کنید.
- چند صفحه باز کنید (داشبورد، لاگ‌شیت‌ها) تا cache پر شود.

---

### مرحله ۸ — نصب PWA

**Android Chrome:**
- بنر «نصب» در اپ، یا
- منو ⋮ → **Install app** / نصب برنامه

**iOS Safari:**
- `beforeinstallprompt` وجود ندارد → **Share → Add to Home Screen**

---

### مرحله ۹ — تست آفلاین

1. Wi‑Fi را خاموش کنید.
2. اپ **نصب‌شده** را باز کنید (نه تب Chrome).
3. UI باید باز شود؛ داده از IndexedDB خوانده می‌شود.
4. sync / کارتابل جدید فقط بعد از روشن شدن Wi‑Fi (و دسترسی به PC در شبکه).

---

## HTTPS و mkcert — چرا و چگونه

| نیاز | چرا HTTPS |
|------|-----------|
| Web NFC | API مرورگر فقط روی secure context |
| PWA Install | Chrome installability criteria |
| Service Worker | روی non-localhost فقط با HTTPS |

| نوع گواهی | قفل | Install خودکار |
|-----------|-----|----------------|
| self-signed (Accept warning) | قرمز یا هشدار | ❌ |
| mkcert + CA روی گوشی | سبز | ✅ Android |
| SSL واقعی (production) | سبز | ✅ |

### نصب mkcert روی Windows (اگر `setup:mkcert` خطا داد)

```powershell
winget install FiloSottile.mkcert
# یا: choco install mkcert
```

سپس دوباره `npm run setup:mkcert`.

---

## نصب PWA روی گوشی

### شرایط Install خودکار (Android)

1. HTTPS **trusted** (mkcert روی گوشی)
2. `manifest.webmanifest` + آیکون ۱۹۲/۵۱۲
3. Service Worker ثبت‌شده
4. چند ثانیه تعامل با سایت
5. نصب از **`4173`** نه `5173`

### اگر Install نمی‌آید

→ بخش [عیب‌یابی](#عیب‌یابی)

---

## تست آفلاین

### چه چیزی آفلاین کار می‌کند

| قابلیت | آفلاین |
|--------|--------|
| باز شدن UI (PWA از 4173) | ✅ |
| ادامه لاگ‌شیت ذخیره‌شده | ✅ |
| خواندن master data کش‌شده | ✅ |
| لاگین با session ذخیره‌شده | ✅ (حتی اگر JWT منقضی شده باشد) |
| NFC (با داده محلی) | ✅ |
| پیک‌آپ / کارتابل / انتساب | ❌ فقط آنلاین |
| sync به سرور | ❌ تا Wi‑Fi و backend |

### چرا بعد از نصب از 5173 صفحه سفید می‌شد؟

PWA نصب‌شده هنوز به dev server اشاره می‌کرد. dev فایل‌های JS را در SW cache نمی‌گذارد → آفلاین = صفحه سفید.

**راه‌حل:** حذف PWA قدیمی → نصب مجدد از **4173**.

---

## سناریوی آنلاین/آفلاین (اپراتور و سرپرست)

### اپراتور

| حالت | مجاز |
|------|------|
| **آنلاین** | دیدن کارتابل، پیک‌آپ کار |
| **آفلاین** | فقط ادامه کارهای قبلاً باز/ذخیره‌شده روی دستگاه |

### سرپرست

| حالت | مجاز |
|------|------|
| **آنلاین** | کارتابل + پیک‌آپ + **برگرداندن** + **انتساب/بازانتساب** |
| **آفلاین** | مثل اپراتور — بدون عملیات کارتابل |

### تعارض sync (مهم)

| سناریو | نتیجه روی دستگاه |
|--------|------------------|
| اپراتور آفلاین کار کرد، سرپرست کار را پس گرفت/داد به دیگری | پیش‌نویس: `REVOKED` — قابل ادامه نیست |
| اپراتور آفلاین submit کرد، assignee عوض شده | sync: `SUPERSEDED` |
| تکمیل **قبل از مهلت** آفلاین، sync **بعد از مهلت** آنلاین | ✅ قبول — مهلت با `completedAt` دستگاه سنجیده می‌شود |

---

## احراز هویت و لاگین خودکار

### ذخیره‌سازی

Session (JWT + roles + permissions + `expiresAt`) در IndexedDB جدول `syncMeta` با کلید `authSession` ذخیره می‌شود.

### باز شدن اپ

1. `useAuthInit` session را از IndexedDB می‌خواند.
2. اگر معتبر باشد → مستقیم داشبورد (بدون login).
3. اگر آنلاین و JWT منقضی → پاک و redirect به login.
4. اگر **آفلاین** و JWT منقضی → همچنان ورود (offline-first).

### خروج

دکمه خروج → پاک شدن session از IndexedDB.

---

## NFC

### محدودیت مرورگر

- فقط **HTTPS trusted** یا localhost
- عمدتاً **Android Chrome**
- iOS: Web NFC محدود — ورود دستی در صورت فعال بودن در تنظیمات

### شناسه تگ

مقدار **`nfcTagId`** از محتوای Record متنی تگ خوانده می‌شود (مثل `E-0110CM2`)، نه UID سخت‌افزاری.

آفلاین: lookup از `assetEntries` در IndexedDB.

---

## جریان همگام‌سازی

```
Pull (آنلاین)
  App start / online
    → GET /api/master-data[?since=]
    → IndexedDB: locations, assets, templates, ...
    → GET /api/log-sheets/inbox
    → کش کارتابل + merge به لاگ‌شیت‌های محلی

Push (آنلاین، هر ~۳۰ ثانیه)
    → POST /api/log-sheets/batch  (submitted, not synced)
    → POST /api/records/batch     (approved, if permitted)
    ← outcome: SUBMITTED | SUPERSEDED | EXPIRED | DUPLICATE

پاک‌سازی محلی
    → synced: بعد از ۱ روز
    → failed: بعد از ۷ روز
```

---

## ساختار پروژه

```
src/
├── components/
│   ├── auth/           ProtectedRoute
│   ├── common/         SyncStatusBar, InstallPwaPrompt, LogSheetIdentityMeta
│   ├── forms/          DynamicClassForm, DynamicFormField
│   ├── layout/         AppLayout, Header, Sidebar
│   ├── logsheet/       AssignOperatorDialog
│   └── nfc/            NFCReader
├── hooks/
│   ├── useAuth.ts      session از IndexedDB، login/logout
│   ├── useInboxSync.ts کارتابل + کش آفلاین
│   ├── useSync.ts      SyncManager
│   ├── useMasterDataSync.ts
│   ├── useLogSheets.ts
│   └── useOnlineStatus.ts
├── pages/
│   ├── LoginPage.tsx
│   ├── Dashboard.tsx
│   ├── LogSheetListPage.tsx   کارتابل (active/history)
│   ├── LogSheetFillPage.tsx   پر کردن + NFC
│   ├── AdminPage.tsx
│   └── SettingsPage.tsx
├── services/
│   ├── api/            client.ts + endpoints
│   ├── auth/           IndexedDB session
│   ├── nfc/
│   ├── storage/        Dexie (db v7), inboxCache
│   └── sync/           SyncManager, logSheetSync, pullInbox, cleanup
├── store/              Zustand
├── utils/              logSheetStatus, ids, scopeLabels
└── i18n/fa.ts

certs/                  mkcert (gitignore) — cert.pem, key.pem, rootCA.crt
scripts/
  setup-mkcert.ps1      ساخت گواهی + راهنمای گوشی
  generate-icons.js     آیکون PWA
```

---

## قرارداد API

مرجع کامل typeها و endpointها: **`src/services/api/index.ts`**

Backend: پروژه `backend-offline-first` — پورت پیش‌فرض **8081**.

### Endpointهای اصلی

| Method | Path | کاربرد |
|--------|------|--------|
| GET | `/api/health` | سلامت سرور |
| POST | `/api/auth/login` | ورود → JWT |
| GET | `/api/master-data[?since=]` | پیکربندی (pull) |
| GET | `/api/log-sheets/inbox` | کارتابل (assigned, available, teamOpen) |
| POST | `/api/log-sheets/{id}/claim` | پیک‌آپ (آنلاین) |
| POST | `/api/log-sheets/{id}/release` | برگرداندن |
| POST | `/api/log-sheets/{id}/assign` | انتساب (سرپرست) |
| POST | `/api/log-sheets/{id}/reassign` | بازانتساب |
| GET | `/api/operational-units/{id}/operators` | لیست اپراتورها |
| GET | `/api/asset-entries/nfc/{tagId}` | lookup NFC |
| POST | `/api/log-sheets/batch` | ارسال لاگ‌شیت‌های تکمیل‌شده |
| POST | `/api/records/batch` | ارسال DataRecord |

### لاگ‌شیت batch — فیلد مهم

```json
{
  "logSheets": [{
    "serverId": 42,
    "localId": "uuid",
    "completedAt": 1700000000000,
    "clientActionId": "uuid",
    "entries": [ ... ]
  }]
}
```

`completedAt` زمان تکمیل روی **دستگاه** است؛ سرور مهلت را با این مقدار می‌سنجد، نه زمان sync.

---

## استقرار production

```bash
npm run build
# خروجی: dist/
```

### nginx (HTTPS واقعی)

```nginx
server {
    listen 443 ssl;
    server_name your-domain.local;
    ssl_certificate     /path/fullchain.pem;
    ssl_certificate_key /path/privkey.pem;

    root /var/www/offline-pwa/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host $host;
    }

    location /sw.js {
        add_header Cache-Control "no-cache";
    }
}
```

**تفاوت با dev:** یک origin برای UI + API؛ نیازی به proxy جدا روی Vite نیست.

---

## عیب‌یابی

### قفل SSL قرمز روی گوشی

| علت | راه‌حل |
|-----|--------|
| `certs/` خالی | `npm run setup:mkcert` |
| CA اشتباه نصب شده (WiFi/VPN user cert) | حذف از User credentials → نصب **CA certificate** |
| IP در مرورگر ≠ IP در mkcert | دوباره setup با IP درست |
| هنوز 5173 باز می‌کنید | بروید به **4173** |

### Install نمی‌آید

1. قفل سبز باشد
2. از **4173** نصب کنید
3. Chrome force stop + دوباره باز
4. iOS: فقط Add to Home Screen دستی

### PWA نصب شد ولی آفلاین صفحه سفید

→ از **5173** نصب شده. حذف PWA → `build:mobile` + `preview:mobile` → نصب از **4173**.

### هر بار login می‌خواهد

- logout کرده‌اید؟
- آنلاین + JWT منقضی → طبیعی است
- آفلاین باید با session قبلی باز شود

### NFC کار نمی‌کند

- HTTPS trusted
- Android Chrome
- `nfcTagId` در asset روی سرور درست است

### API خطا می‌دهد

- Backend روی 8081 در حال اجرا؟
- `serverUrl` در تنظیمات = origin اپ (مثلاً `https://192.168.1.101:4173`)
- PC و گوشی همان Wi‑Fi

### ترمینال: `WARNING: No certs/cert.pem`

```powershell
npm run setup:mkcert
```

---

## تکنولوژی‌ها

| ابزار | نقش |
|-------|-----|
| React 18 + TypeScript | UI |
| Vite + vite-plugin-pwa | Build + Workbox SW |
| MUI v5 + RTL | رابط فارسی |
| Dexie (IndexedDB) | ذخیره آفلاین |
| Zustand | State |
| Web NFC API | اسکن تگ |
| mkcert | HTTPS dev روی LAN |

---

## توسعه روی PC (بدون موبایل)

```bash
npm run dev          # http://localhost:5173
npm run build
npm run preview      # http://localhost:4173
```

برای موبایل و NFC و PWA همیشه مسیر [راه‌اندازی کامل تست موبایل](#راه‌اندازی-کامل-تست-موبایل-گام‌به‌گام) را دنبال کنید.
