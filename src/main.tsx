import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { registerSW } from 'virtual:pwa-register'
import { openDatabase } from '@/services/storage/db'
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
openDatabase()
  .catch(err => console.error('[DB] open failed', err))
  .finally(renderApp)
