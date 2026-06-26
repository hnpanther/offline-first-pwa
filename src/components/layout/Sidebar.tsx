import {
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Box,
  Typography,
  Divider,
  useMediaQuery,
  useTheme
} from '@mui/material'
import DashboardIcon from '@mui/icons-material/Dashboard'
import ListAltIcon from '@mui/icons-material/ListAlt'
import SettingsIcon from '@mui/icons-material/Settings'
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings'
import FactCheckIcon from '@mui/icons-material/FactCheck'
import { useNavigate, useLocation } from 'react-router-dom'
import { t } from '@/i18n'

const DRAWER_WIDTH = 240

const navItems = [
  { path: '/', label: t.nav.dashboard, icon: <DashboardIcon /> },
  { path: '/records', label: t.nav.records, icon: <ListAltIcon /> },
  { path: '/logsheets', label: t.nav.logSheets, icon: <FactCheckIcon /> },
  { path: '/admin', label: t.nav.admin, icon: <AdminPanelSettingsIcon /> },
  { path: '/settings', label: t.nav.settings, icon: <SettingsIcon /> }
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

  const handleNav = (path: string) => {
    navigate(path)
    if (isMobile) onClose()
  }

  const isSelected = (path: string) =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path)

  const drawerContent = (
    <Box sx={{ width: DRAWER_WIDTH }} role="navigation">
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
      <List sx={{ p: 1 }}>
        {navItems.map(item => (
          <ListItemButton
            key={item.path}
            selected={isSelected(item.path)}
            onClick={() => handleNav(item.path)}
            sx={{
              mb: 0.5,
              '&.Mui-selected': {
                bgcolor: 'primary.light',
                color: 'primary.contrastText',
                '& .MuiListItemIcon-root': { color: 'primary.contrastText' },
                '&:hover': { bgcolor: 'primary.light' }
              }
            }}
          >
            <ListItemIcon sx={{ minWidth: 40 }}>{item.icon}</ListItemIcon>
            <ListItemText
              primary={item.label}
              primaryTypographyProps={{ fontSize: '0.95rem', fontWeight: isSelected(item.path) ? 600 : 400 }}
            />
          </ListItemButton>
        ))}
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
