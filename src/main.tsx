import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { registerSW } from 'virtual:pwa-register'
import { openDatabase, DatabaseVersionMismatchError } from '@/services/storage/db'
import { requestPersistentStorage } from '@/utils/storageQuota'
import { FONT_SANS } from '@/theme'
import 'vazirmatn/Vazirmatn-font-face.css'

// Register the Vite PWA service worker with auto-update
registerSW({
  immediate: true,
  onNeedRefresh() {
    console.info('[PWA] New content available, refreshing...')
  },
  onOfflineReady() {
    console.info('[PWA] App ready to work offline.')
  }
})

function renderApp() {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

/**
 * The one failure the app must NOT start through.
 *
 * `openDatabase` refuses to recreate a database that holds unsynced work — see its comment for
 * why a rollback would otherwise wipe completed rounds and captured photos off every tablet.
 * When it refuses, rendering the app anyway would give the operator a shell where every screen
 * fails for reasons none of them can explain, and where "just reinstall it" is the natural next
 * move — which is exactly the action that destroys the data.
 *
 * So this stops, in Persian, and says what to do. Deliberately plain DOM rather than React: the
 * database the app is built on is unavailable, and the failure screen must not depend on
 * anything that might itself need it.
 */
function renderDatabaseVersionMismatch(error: DatabaseVersionMismatchError) {
  const root = document.getElementById('root')
  if (!root) return
  root.setAttribute('dir', 'rtl')
  root.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
                font-family:${FONT_SANS};background:#fff8f8;color:#7f1d1d;">
      <div style="max-width:520px;text-align:center;">
        <div style="font-size:48px;line-height:1;margin-bottom:16px;">&#9888;</div>
        <h1 style="font-size:20px;margin:0 0 12px;">برنامه باز نشد</h1>
        <p style="font-size:15px;line-height:2;margin:0 0 16px;">${error.message}</p>
        <p style="font-size:14px;line-height:2;margin:0;background:#fee2e2;padding:12px;border-radius:8px;">
          <strong>${error.unsyncedCount}</strong> مورد ارسال‌نشده روی این دستگاه وجود دارد.
          برنامه را حذف یا داده‌های آن را پاک <strong>نکنید</strong> — این اطلاعات فقط روی همین
          دستگاه موجود است و با پاک کردن، برای همیشه از بین می‌رود.
        </p>
      </div>
    </div>`
}

// Open IndexedDB before the first render so a version problem surfaces here rather than inside
// random screens. Rendering proceeds for ordinary failures — one must not leave the user
// staring at a blank page — but NOT for a version mismatch holding unsynced work, which is the
// one case where carrying on invites the operator to destroy their own data.
//
// Persistent storage is requested once the database exists. Now that captured photos and audio
// live in IndexedDB this origin is a plausible eviction target, and eviction would take the
// unsynced log sheets with it. A refusal is normal (browsers only grant it to installed apps),
// so it is logged and ignored rather than surfaced.
openDatabase()
  .then(() => {
    void requestPersistentStorage().then(granted => {
      if (!granted) console.info('[Storage] persistent storage not granted')
    })
    renderApp()
  })
  .catch(err => {
    console.error('[DB] open failed', err)
    if (err instanceof DatabaseVersionMismatchError) {
      renderDatabaseVersionMismatch(err)
      return
    }
    renderApp()
  })
