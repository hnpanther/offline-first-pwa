import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ThemeProvider, CssBaseline } from '@mui/material'
import { CacheProvider } from '@emotion/react'
import createCache from '@emotion/cache'
import { prefixer } from 'stylis'
import rtlPlugin from 'stylis-plugin-rtl'
import { theme } from '@/theme'
import { AppLayout } from '@/components/layout/AppLayout'
import { Dashboard } from '@/pages/Dashboard'
import { SettingsPage } from '@/pages/SettingsPage'
import { AdminPage } from '@/pages/AdminPage'
import { LogSheetListPage } from '@/pages/LogSheetListPage'
import { LogSheetFillPage } from '@/pages/LogSheetFillPage'
import { LogSheetTemplatePage } from '@/pages/LogSheetTemplatePage'

const rtlCache = createCache({
  key: 'muirtl',
  stylisPlugins: [prefixer, rtlPlugin]
})

export function App() {
  return (
    <CacheProvider value={rtlCache}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <BrowserRouter>
          <Routes>
            <Route element={<AppLayout />}>
              <Route index element={<Dashboard />} />
              <Route path="logsheets">
                <Route index element={<Navigate to="active" replace />} />
                <Route path="active" element={<LogSheetListPage mode="active" />} />
                <Route path="history" element={<LogSheetListPage mode="history" />} />
                <Route path=":localId" element={<LogSheetFillPage />} />
              </Route>
              <Route path="logsheet-templates" element={<LogSheetTemplatePage />} />
              <Route path="master-data">
                <Route index element={<Navigate to="locations" replace />} />
                <Route path="templates" element={<Navigate to="/logsheet-templates" replace />} />
                <Route path=":section" element={<AdminPage />} />
              </Route>
              <Route path="admin" element={<Navigate to="/master-data/locations" replace />} />
              <Route path="records" element={<Navigate to="/" replace />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ThemeProvider>
    </CacheProvider>
  )
}
