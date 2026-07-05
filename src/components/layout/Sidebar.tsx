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
import StorageIcon from '@mui/icons-material/Storage'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import LocationOnIcon from '@mui/icons-material/LocationOn'
import TuneIcon from '@mui/icons-material/Tune'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import LabelIcon from '@mui/icons-material/Label'
import CategoryIcon from '@mui/icons-material/Category'
import InventoryIcon from '@mui/icons-material/Inventory'
import FactCheckIcon from '@mui/icons-material/FactCheck'
import AssignmentIcon from '@mui/icons-material/Assignment'
import HistoryIcon from '@mui/icons-material/History'
import ArticleIcon from '@mui/icons-material/Article'
import LogoutIcon from '@mui/icons-material/Logout'
import { useNavigate, useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { t } from '@/i18n'
import { useAuth } from '@/hooks/useAuth'
import { isAdminRole } from '@/types/auth'

const DRAWER_WIDTH = 240

const logSheetSubItems = [
  { path: '/logsheets/active', label: t.nav.logSheetActive, icon: <AssignmentIcon fontSize="small" /> },
  { path: '/logsheets/history', label: t.nav.logSheetHistory, icon: <HistoryIcon fontSize="small" /> },
]

const masterDataItems = [
  { path: '/master-data/locations', label: t.hierarchy.locations, icon: <LocationOnIcon fontSize="small" /> },
  { path: '/master-data/systems', label: t.hierarchy.systems, icon: <TuneIcon fontSize="small" /> },
  { path: '/master-data/functions', label: t.hierarchy.mainFunctions, icon: <AccountTreeIcon fontSize="small" /> },
  { path: '/master-data/subfunctions', label: t.hierarchy.subFunctions, icon: <LabelIcon fontSize="small" /> },
  { path: '/master-data/classes', label: t.admin.assetTypes, icon: <CategoryIcon fontSize="small" /> },
  { path: '/master-data/assets', label: t.admin.assetRegistry, icon: <InventoryIcon fontSize="small" /> },
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
  const showAdmin = authSession ? isAdminRole(authSession.roles) : false

  const isLogSheetRoute = location.pathname.startsWith('/logsheets')
  const isMasterDataRoute = location.pathname.startsWith('/master-data')

  const [logSheetOpen, setLogSheetOpen] = useState(isLogSheetRoute)
  const [masterDataOpen, setMasterDataOpen] = useState(isMasterDataRoute)

  useEffect(() => {
    if (isLogSheetRoute) setLogSheetOpen(true)
  }, [isLogSheetRoute])

  useEffect(() => {
    if (isMasterDataRoute) setMasterDataOpen(true)
  }, [isMasterDataRoute])

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
            <ListItemButton
              selected={isSelected('/logsheet-templates')}
              onClick={() => handleNav('/logsheet-templates')}
              sx={groupItemSx(isSelected('/logsheet-templates'))}
            >
              <ListItemIcon sx={{ minWidth: 40 }}>
                <ArticleIcon color={isSelected('/logsheet-templates') ? 'inherit' : 'action'} />
              </ListItemIcon>
              <ListItemText
                primary={t.nav.logSheetTemplates}
                primaryTypographyProps={{ fontSize: '0.9rem', fontWeight: isSelected('/logsheet-templates') ? 600 : 400 }}
              />
            </ListItemButton>

            <Divider sx={{ my: 1 }} />

            <ListItemButton
              onClick={() => setMasterDataOpen(v => !v)}
              selected={isMasterDataRoute}
              sx={groupItemSx(isMasterDataRoute)}
            >
              <ListItemIcon sx={{ minWidth: 40 }}>
                <StorageIcon color={isMasterDataRoute ? 'inherit' : 'action'} />
              </ListItemIcon>
              <ListItemText
                primary={t.nav.masterData}
                primaryTypographyProps={{ fontSize: '0.95rem', fontWeight: isMasterDataRoute ? 600 : 400 }}
              />
              {masterDataOpen ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
            </ListItemButton>

            <Collapse in={masterDataOpen} timeout="auto" unmountOnExit>
              <List disablePadding sx={{ pr: 1 }}>
                {masterDataItems.map(item => (
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

            <Divider sx={{ my: 1 }} />
          </>
        )}

        {showAdmin && (
          <>
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
