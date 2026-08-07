import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { registerSW } from 'virtual:pwa-register'
import { openDatabase } from '@/services/storage/db'
import { requestPersistentStorage } from '@/utils/storageQuota'
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

// Open IndexedDB before the first render so a stale pre-renumber database is recreated
// up front rather than surfacing as a VersionError inside random screens. Rendering
// proceeds either way — a failure here must not leave the user staring at a blank page.
// Ask for persistent storage once the database exists. Now that captured photos and audio
// live in IndexedDB this origin is a plausible eviction target, and eviction would take the
// unsynced log sheets with it. A refusal is normal (browsers only grant it to installed
// apps), so it is logged and ignored rather than surfaced.
openDatabase()
  .catch(err => console.error('[DB] open failed', err))
  .finally(() => {
    void requestPersistentStorage().then(granted => {
      if (!granted) console.info('[Storage] persistent storage not granted')
    })
    renderApp()
  })
