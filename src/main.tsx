import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { registerSW } from 'virtual:pwa-register'
import 'vazirmatn/Vazirmatn-font-face.css'

// Register the Vite PWA service worker with auto-update
registerSW({
  onNeedRefresh() {
    // In a real app you could show a toast here
    console.info('[PWA] New content available, refreshing...')
  },
  onOfflineReady() {
    console.info('[PWA] App ready to work offline.')
  }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
