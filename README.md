# سیستم جمع‌آوری اطلاعات — Offline PWA

یک اپلیکیشن وب پیشرفته (PWA) برای جمع‌آوری اطلاعات با پشتیبانی آفلاین، اسکن NFC، و همگام‌سازی خودکار با سرور.

---

## ویژگی‌ها

- **آفلاین-فرست**: ذخیره محلی با IndexedDB (Dexie)؛ بدون اینترنت هم کار می‌کند
- **اسکن NFC**: پشتیبانی از Web NFC API در Chrome Android؛ fallback دستی
- **RTL کامل**: رابط کاربری فارسی و راست-به-چپ با MUI v5
- **همگام‌سازی خودکار**: ارسال رکوردهای pending وقتی اتصال برقرار شود
- **PWA**: قابل نصب روی تبلت و موبایل، از صفحه Home Screen قابل اجراست

---

## پیش‌نیازها

- Node.js ≥ 20
- npm ≥ 10

---

## راه‌اندازی محلی

```bash
# نصب وابستگی‌ها
npm install

# اجرا در حالت توسعه
npm run dev

# ساخت برای محیط تولید
npm run build

# پیش‌نمایش نسخه ساخته‌شده
npm run preview
```

سرور روی `http://0.0.0.0:5173` اجرا می‌شود — از طریق IP شبکه محلی هم قابل دسترس است.

---

## ساختار پروژه

```
src/
├── components/
│   ├── common/          # SyncStatusBar و کامپوننت‌های مشترک
│   ├── forms/           # DynamicFormField, DataEntryForm
│   ├── layout/          # AppLayout, Header, Sidebar
│   └── nfc/             # NFCReader
├── hooks/               # useNFC, useSync, useRecords, useSettings, useOnlineStatus
├── i18n/                # ترجمه‌های فارسی (fa.ts)
├── pages/               # Dashboard, ScanPage, RecordsPage, SettingsPage
├── services/
│   ├── api/             # apiClient + همه endpoint‌ها (index.ts)
│   ├── nfc/             # NFC abstraction layer
│   ├── storage/         # Dexie IndexedDB (db.ts + index.ts)
│   └── sync/            # SyncManager
├── store/               # Zustand store
├── theme/               # MUI RTL theme
└── types/               # TypeScript types
```

---

## پیکربندی سرور

در صفحه **تنظیمات** اپ، آدرس سرور را وارد کنید:

```
http://192.168.x.x:3000
```

### Endpoint‌هایی که باید سرور پیاده‌سازی کند

| متد | مسیر | توضیح |
|-----|------|-------|
| GET | `/api/health` | بررسی در دسترس بودن سرور |
| GET | `/api/assets/nfc/:tagId` | اطلاعات دارایی بر اساس NFC tag |
| GET | `/api/assets` | لیست همه دارایی‌ها |
| GET | `/api/forms/:type` | schema فرم |
| POST | `/api/records` | ثبت یک رکورد |
| POST | `/api/records/batch` | ثبت دسته‌ای رکوردها |

### نمونه payload برای `POST /api/records/batch`

```json
{
  "records": [
    {
      "localId": "uuid-v4",
      "nfcTagId": "04:AB:CD:EF",
      "assetId": "asset-123",
      "formType": "default-inspection",
      "formData": { "condition": "good", "temperature": 25 },
      "operatorName": "علی احمدی",
      "createdAt": 1700000000000
    }
  ]
}
```

### نمونه response

```json
[
  { "localId": "uuid-v4", "serverId": "server-generated-id" },
  { "localId": "uuid-v4-2", "error": "اطلاعات ناقص" }
]
```

---

## استقرار در شبکه خصوصی

### با nginx

```nginx
server {
    listen 80;
    root /var/www/offline-pwa/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # کش‌گذاری asset‌های static
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

```bash
# ساخت
npm run build

# کپی به سرور
scp -r dist/ user@192.168.x.x:/var/www/offline-pwa/
```

### با Node.js/Express (برای سرو همزمان API و frontend)

```js
import express from 'express'
const app = express()
app.use(express.static('dist'))
app.get('*', (_, res) => res.sendFile('dist/index.html'))
app.listen(80)
```

---

## NFC

Web NFC API فقط در Chrome for Android (نسخه 89+) روی HTTPS یا localhost کار می‌کند.

برای محیط توسعه روی شبکه محلی، باید HTTPS فعال شود یا از یک reverse proxy با SSL استفاده کنید. همچنین می‌توانید از `npm run dev -- --host` برای دسترسی از تبلت استفاده کنید ولی NFC نیاز به HTTPS دارد.

اگر NFC پشتیبانی نشود، کاربر می‌تواند شناسه تگ را به صورت دستی وارد کند.

---

## اضافه کردن احراز هویت در آینده

معماری آماده پذیرش auth است:

1. توکن را در `AppSettings` ذخیره کنید
2. در `src/services/api/client.ts` هدر `Authorization` اضافه کنید:
   ```ts
   headers: { 'Authorization': `Bearer ${token}` }
   ```
3. یک صفحه Login اضافه کنید و route‌های protected تعریف کنید

---

## فناوری‌های استفاده‌شده

| ابزار | نقش |
|-------|-----|
| React 18 + TypeScript | فریمورک اصلی |
| Vite + vite-plugin-pwa | Build + Service Worker |
| MUI v5 (RTL) | رابط کاربری |
| Dexie (IndexedDB) | ذخیره‌سازی آفلاین |
| Zustand | مدیریت State |
| React Hook Form + Zod | فرم‌ها |
| Web NFC API | اسکن تگ |
