import {
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Box,
  Typography,
  Divider,
  Collapse,
  useMediaQuery,
  useTheme
} from '@mui/material'
import DashboardIcon from '@mui/icons-material/Dashboard'
import SettingsIcon from '@mui/icons-material/Settings'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import FactCheckIcon from '@mui/icons-material/FactCheck'
import AssignmentIcon from '@mui/icons-material/Assignment'
import HistoryIcon from '@mui/icons-material/History'
import NfcIcon from '@mui/icons-material/Nfc'
import LogoutIcon from '@mui/icons-material/Logout'
import { useNavigate, useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { t } from '@/i18n'
import { useAuth } from '@/hooks/useAuth'
import { canManageNfcSerial, hasPlantWideScope } from '@/types/auth'

const DRAWER_WIDTH = 240

const logSheetSubItems = [
  { path: '/logsheets/active', label: t.nav.logSheetActive, icon: <AssignmentIcon fontSize="small" /> },
  { path: '/logsheets/history', label: t.nav.logSheetHistory, icon: <HistoryIcon fontSize="small" /> },
]

interface SidebarProps {
  open: boolean
  onClose: () => void
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const theme = useTheme()
  const isMobile = useMediaQuery(theme.breakpoints.down('md'))
  const navigate = useNavigate()
  const location = useLocation()
  const { authSession, signOut } = useAuth()
  // Two separate questions that happened to have the same answer for the seeded roles.
  const showNfcInspect = canManageNfcSerial(authSession)
  const showSettings = hasPlantWideScope(authSession)
  const showAdmin = showNfcInspect || showSettings

  const isLogSheetRoute = location.pathname.startsWith('/logsheets')

  const [logSheetOpen, setLogSheetOpen] = useState(isLogSheetRoute)

  useEffect(() => {
    if (isLogSheetRoute) setLogSheetOpen(true)
  }, [isLogSheetRoute])

  const handleNav = (path: string) => {
    navigate(path)
    if (isMobile) onClose()
  }

  const isSelected = (path: string) =>
    path === '/' ? location.pathname === '/' : location.pathname === path

  const subItemSx = (selected: boolean) => ({
    mb: 0.25,
    borderRadius: 1,
    pl: 3,
    py: 0.5,
    '&.Mui-selected': {
      bgcolor: 'primary.main',
      color: 'primary.contrastText',
      '& .MuiListItemIcon-root': { color: 'primary.contrastText' },
      '&:hover': { bgcolor: 'primary.main' }
    },
    fontWeight: selected ? 600 : 400
  })

  const groupItemSx = (_active: boolean) => ({
    mb: 0.5,
    borderRadius: 1,
    '&.Mui-selected': {
      bgcolor: 'primary.light',
      color: 'primary.contrastText',
      '& .MuiListItemIcon-root': { color: 'primary.contrastText' },
      '&:hover': { bgcolor: 'primary.light' }
    }
  })

  const drawerContent = (
    <Box sx={{ width: DRAWER_WIDTH, display: 'flex', flexDirection: 'column', height: '100%' }} role="navigation">
      <Box
        sx={{
          p: 2,
          bgcolor: 'primary.main',
          color: 'primary.contrastText',
          minHeight: 64,
          display: 'flex',
          alignItems: 'center'
        }}
      >
        <Typography variant="h6" fontWeight={700} fontSize="0.95rem">
          {t.app.name}
        </Typography>
      </Box>
      <Divider />

      <List sx={{ p: 1, flexGrow: 1 }}>
        {/* داشبورد */}
        <ListItemButton
          selected={isSelected('/')}
          onClick={() => handleNav('/')}
          sx={groupItemSx(isSelected('/'))}
        >
          <ListItemIcon sx={{ minWidth: 40 }}><DashboardIcon /></ListItemIcon>
          <ListItemText
            primary={t.nav.dashboard}
            primaryTypographyProps={{ fontSize: '0.95rem', fontWeight: isSelected('/') ? 600 : 400 }}
          />
        </ListItemButton>

        <Divider sx={{ my: 1 }} />

        {/* Log Sheet ها — expandable */}
        <ListItemButton
          onClick={() => setLogSheetOpen(v => !v)}
          selected={isLogSheetRoute}
          sx={groupItemSx(isLogSheetRoute)}
        >
          <ListItemIcon sx={{ minWidth: 40 }}>
            <FactCheckIcon color={isLogSheetRoute ? 'inherit' : 'action'} />
          </ListItemIcon>
          <ListItemText
            primary={t.nav.logSheets}
            primaryTypographyProps={{ fontSize: '0.95rem', fontWeight: isLogSheetRoute ? 600 : 400 }}
          />
          {logSheetOpen ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </ListItemButton>

        <Collapse in={logSheetOpen} timeout="auto" unmountOnExit>
          <List disablePadding sx={{ pr: 1 }}>
            {logSheetSubItems.map(item => (
              <ListItemButton
                key={item.path}
                selected={isSelected(item.path)}
                onClick={() => handleNav(item.path)}
                sx={subItemSx(isSelected(item.path))}
              >
                <ListItemIcon sx={{ minWidth: 34 }}>{item.icon}</ListItemIcon>
                <ListItemText
                  primary={item.label}
                  primaryTypographyProps={{
                    fontSize: '0.82rem',
                    fontWeight: isSelected(item.path) ? 600 : 400,
                    noWrap: true
                  }}
                />
              </ListItemButton>
            ))}
          </List>
        </Collapse>

        {showAdmin && (
          <>
            <Divider sx={{ my: 1 }} />

            {/* بازرسی تگ NFC — فقط ادمین و فقط آنلاین */}
            <ListItemButton
              selected={isSelected('/nfc-inspect')}
              onClick={() => handleNav('/nfc-inspect')}
              sx={groupItemSx(isSelected('/nfc-inspect'))}
            >
              <ListItemIcon sx={{ minWidth: 40 }}>
                <NfcIcon color={isSelected('/nfc-inspect') ? 'inherit' : 'action'} />
              </ListItemIcon>
              <ListItemText
                primary={t.nav.nfcInspect}
                primaryTypographyProps={{ fontSize: '0.95rem', fontWeight: isSelected('/nfc-inspect') ? 600 : 400 }}
              />
            </ListItemButton>

            <Divider sx={{ my: 1 }} />

            {/* تنظیمات — فقط ادمین */}
            <ListItemButton
              selected={isSelected('/settings')}
              onClick={() => handleNav('/settings')}
              sx={groupItemSx(isSelected('/settings'))}
            >
              <ListItemIcon sx={{ minWidth: 40 }}><SettingsIcon /></ListItemIcon>
              <ListItemText
                primary={t.nav.settings}
                primaryTypographyProps={{ fontSize: '0.95rem', fontWeight: isSelected('/settings') ? 600 : 400 }}
              />
            </ListItemButton>
          </>
        )}

        {authSession && (
          <>
            <Divider sx={{ my: 1 }} />
            <Box sx={{ px: 2, py: 1 }}>
              <Typography variant="caption" color="text.secondary" display="block">
                {authSession.fullName || authSession.username}
              </Typography>
            </Box>
            <ListItemButton onClick={() => void signOut()} sx={{ borderRadius: 1 }}>
              <ListItemIcon sx={{ minWidth: 40 }}><LogoutIcon color="error" /></ListItemIcon>
              <ListItemText
                primary={t.auth.logout}
                primaryTypographyProps={{ fontSize: '0.9rem', color: 'error.main' }}
              />
            </ListItemButton>
          </>
        )}
      </List>
    </Box>
  )

  return (
    <>
      <Drawer
        variant="temporary"
        anchor="left"
        open={open}
        onClose={onClose}
        ModalProps={{ keepMounted: true }}
        sx={{
          display: { xs: 'block', md: 'none' },
          '& .MuiDrawer-paper': { width: DRAWER_WIDTH }
        }}
      >
        {drawerContent}
      </Drawer>

      <Drawer
        variant="permanent"
        anchor="left"
        sx={{
          display: { xs: 'none', md: 'block' },
          '& .MuiDrawer-paper': {
            width: DRAWER_WIDTH,
            boxSizing: 'border-box',
            borderRight: '1px solid rgba(0,0,0,0.12)',
            borderLeft: 'none'
          }
        }}
        open
      >
        {drawerContent}
      </Drawer>
    </>
  )
}
