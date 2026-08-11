import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ThemeProvider, CssBaseline } from '@mui/material'
import { CacheProvider } from '@emotion/react'
import createCache from '@emotion/cache'
import { prefixer } from 'stylis'
import rtlPlugin from 'stylis-plugin-rtl'
import { theme } from '@/theme'
import { AppLayout } from '@/components/layout/AppLayout'
import { ProtectedRoute } from '@/components/auth/ProtectedRoute'
import { AdminRoute } from '@/components/auth/AdminRoute'
import { Dashboard } from '@/pages/Dashboard'
import { SettingsPage } from '@/pages/SettingsPage'
import { LogSheetListPage } from '@/pages/LogSheetListPage'
import { LogSheetFillPage } from '@/pages/LogSheetFillPage'
import { NfcInspectPage } from '@/pages/NfcInspectPage'
import { LoginPage } from '@/pages/LoginPage'
import { useAuthInit } from '@/hooks/useAuth'

const rtlCache = createCache({
  key: 'muirtl',
  stylisPlugins: [prefixer, rtlPlugin]
})

function AuthBootstrap({ children }: { children: React.ReactNode }) {
  useAuthInit()
  return <>{children}</>
}

import { useScreenOrientation } from '@/hooks/useScreenOrientation'

export function App() {
  // Re-applied on every launch: an orientation lock does not survive the app being closed,
  // so the stored preference has to be put back each time rather than only when it changes.
  useScreenOrientation()

  return (
    <CacheProvider value={rtlCache}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <BrowserRouter>
          <AuthBootstrap>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route
                element={
                  <ProtectedRoute>
                    <AppLayout />
                  </ProtectedRoute>
                }
              >
                <Route index element={<Dashboard />} />
                <Route path="logsheets">
                  <Route index element={<Navigate to="active" replace />} />
                  <Route path="active" element={<LogSheetListPage mode="active" />} />
                  <Route path="history" element={<LogSheetListPage mode="history" />} />
                  <Route path=":localId" element={<LogSheetFillPage />} />
                </Route>
                <Route path="nfc-inspect" element={<AdminRoute><NfcInspectPage /></AdminRoute>} />
                <Route path="settings" element={<AdminRoute><SettingsPage /></AdminRoute>} />
                {/*
                  Master data, asset registry and log-sheet templates are managed in the web
                  admin panel, not here — the PWA only ever consumes them through log-sheet
                  bundles. The old routes redirect so existing bookmarks/PWA shortcuts land
                  somewhere sensible instead of a blank screen.
                */}
                <Route path="master-data/*" element={<Navigate to="/" replace />} />
                <Route path="logsheet-templates" element={<Navigate to="/" replace />} />
                <Route path="admin" element={<Navigate to="/" replace />} />
                <Route path="records" element={<Navigate to="/" replace />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </AuthBootstrap>
        </BrowserRouter>
      </ThemeProvider>
    </CacheProvider>
  )
}
