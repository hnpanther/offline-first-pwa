import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { registerSW } from 'virtual:pwa-register'
import { openDatabase, DatabaseVersionMismatchError } from '@/services/storage/db'
import { getSettings, saveSettings } from '@/services/storage'
import { loadServerClock } from '@/services/clock/serverClockStore'
import { loadSessionContact } from '@/services/auth/offlineSession'
import {
  WIPE_BROADCAST_CHANNEL,
  confirmPendingWipe,
  restoreServerUrlAfterWipe,
  resumeDeviceWipe
} from '@/services/device/deviceWipe'
import { requestPersistentStorage } from '@/utils/storageQuota'
import { FONT_SANS } from '@/theme'
import { t } from '@/i18n'
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

/**
 * Backend V28 — a wipe the server ordered could not finish because another open copy of the app
 * holds the database. The app must not open over data an administrator ordered removed; plain DOM,
 * for the same reason as above. The next start tries again.
 */
function renderWipeBlocked() {
  const root = document.getElementById('root')
  if (!root) return
  root.setAttribute('dir', 'rtl')
  root.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
                font-family:${FONT_SANS};background:#fffbeb;color:#78350f;">
      <div style="max-width:520px;text-align:center;">
        <div style="font-size:48px;line-height:1;margin-bottom:16px;">&#9888;</div>
        <p style="font-size:15px;line-height:2;margin:0;">${t.auth.deviceWipeBlocked}</p>
      </div>
    </div>`
}

// Another open copy of this app carried out a wipe order: reload, so this one lets go of the
// database too and starts over on the empty one.
try {
  const channel = new BroadcastChannel(WIPE_BROADCAST_CHANNEL)
  channel.onmessage = () => window.location.replace('/login')
} catch {
  /* no BroadcastChannel — the deletion closes this copy's database anyway */
}

/**
 * Start-up, in an order that matters:
 *
 *  1. **A wipe the server ordered is finished first** (backend V28) — before the database is opened
 *     and before anything renders, so no screen, sync tick or live query can hold the database or
 *     write into it halfway. See `services/device/deviceWipe.ts`.
 *  2. The database opens — or the app stops on a version it must not open through.
 *  3. The server clock and the last server contact are read into memory before the first render,
 *     because deadlines are decided synchronously during rendering (PWA roadmap §7).
 */
async function start(): Promise<void> {
  const wipe = await resumeDeviceWipe()
  if (wipe === 'blocked') {
    renderWipeBlocked()
    return
  }

  try {
    await openDatabase()
  } catch (err) {
    console.error('[DB] open failed', err)
    if (err instanceof DatabaseVersionMismatchError) {
      renderDatabaseVersionMismatch(err)
      return
    }
    renderApp()
    return
  }

  if (wipe === 'wiped') {
    // The fresh database gets the server address back, so the tablet can reach the server to
    // confirm the wipe and be enrolled again.
    await restoreServerUrlAfterWipe(async serverUrl => {
      await saveSettings({ ...(await getSettings()), serverUrl })
    }).catch(err => console.warn('[wipe] could not restore the server address', err))
  }

  await loadServerClock().catch(() => undefined)
  await loadSessionContact().catch(() => undefined)

  // Persistent storage is requested once the database exists. Now that captured photos and audio
  // live in IndexedDB this origin is a plausible eviction target, and eviction would take the
  // unsynced log sheets with it. A refusal is normal (browsers only grant it to installed apps),
  // so it is logged and ignored rather than surfaced.
  void requestPersistentStorage().then(granted => {
    if (!granted) console.info('[Storage] persistent storage not granted')
  })
  renderApp()

  // A carried-out wipe still owes the server its signed confirmation; harmless when it does not.
  void confirmPendingWipe()
}

void start()
