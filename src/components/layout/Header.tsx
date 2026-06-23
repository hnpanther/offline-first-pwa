import {
  AppBar,
  Toolbar,
  Typography,
  IconButton,
  useTheme
} from '@mui/material'
import MenuIcon from '@mui/icons-material/Menu'
import { SyncStatusBar } from '@/components/common/SyncStatusBar'
import { t } from '@/i18n'

interface HeaderProps {
  onMenuToggle: () => void
  title?: string
}

export function Header({ onMenuToggle, title }: HeaderProps) {
  const theme = useTheme()

  return (
    <AppBar
      position="fixed"
      elevation={1}
      sx={{
        zIndex: theme.zIndex.drawer + 1,
        bgcolor: 'primary.main'
      }}
    >
      <Toolbar sx={{ gap: 1 }}>
        <IconButton
          color="inherit"
          edge="start"
          onClick={onMenuToggle}
          sx={{ mr: 0, ml: 0 }}
          aria-label="منو"
        >
          <MenuIcon />
        </IconButton>

        <Typography
          variant="h6"
          component="div"
          sx={{ flexGrow: 1, fontWeight: 600, fontSize: '1rem' }}
        >
          {title ?? t.app.name}
        </Typography>

        <SyncStatusBar />
      </Toolbar>
    </AppBar>
  )
}
