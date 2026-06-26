import { useState } from 'react'
import { Box, Toolbar } from '@mui/material'
import { Outlet } from 'react-router-dom'
import { Header } from './Header'
import { Sidebar } from './Sidebar'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { useSyncManager } from '@/hooks/useSync'
import { useMasterDataSync } from '@/hooks/useMasterDataSync'

const DRAWER_WIDTH = 240

export function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Global hooks — must run for the lifetime of the app
  useOnlineStatus()
  useSyncManager()
  useMasterDataSync() // pulls config from server when online / stale

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <Header onMenuToggle={() => setSidebarOpen(v => !v)} />

      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          // In RTL, stylis-plugin-rtl flips ml→margin-right, leaving room for the right-side drawer
          ml: { md: `${DRAWER_WIDTH}px` },
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        {/* Spacer so content starts below AppBar */}
        <Toolbar />

        <Box sx={{ flexGrow: 1, p: { xs: 1.5, sm: 2, md: 3 } }}>
          <Outlet />
        </Box>
      </Box>
    </Box>
  )
}
