import { Box, Chip, CircularProgress, Tooltip, IconButton } from '@mui/material'
import SyncIcon from '@mui/icons-material/Sync'
import CloudDoneIcon from '@mui/icons-material/CloudDone'
import CloudOffIcon from '@mui/icons-material/CloudOff'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import { useAppStore } from '@/store'
import { useManualSync } from '@/hooks/useSync'
import { canReachServer } from '@/utils/connectivity'
import { t } from '@/i18n'

/**
 * The chip sits on the primary-blue app bar, so it brings its own background.
 *
 * It used to be an outlined chip, which draws the status colour straight onto that blue: green
 * measured 1.12:1 against it, red 1.02:1, orange 1.52:1. Unreadable on a tablet in a plant. A
 * darker green does not help (1.37:1), because both colours are dark. White text on a dark shade
 * of each status colour does: success.dark 8.5:1, warning.dark 6.8:1, error.main 5.6:1,
 * grey.800 10:1. The white border is what separates the pill from the bar, since the fills
 * themselves are close to the blue in lightness.
 *
 * Syncing is transient and left unfilled: white on the bar itself is 5.75:1.
 */
type StatusFill = 'success.dark' | 'warning.dark' | 'error.main' | 'grey.800' | 'transparent'

export function SyncStatusBar() {
  const isOnline = useAppStore(s => s.isOnline)
  const serverReachable = useAppStore(s => s.serverReachable)
  const isSyncing = useAppStore(s => s.isSyncing)
  const pendingCount = useAppStore(s => s.pendingCount)
  const syncError = useAppStore(s => s.syncError)
  const manualSync = useManualSync()

  const getStatus = (): { label: string; fill: StatusFill; icon: JSX.Element } => {
    if (!isOnline) return { label: t.sync.offline, fill: 'grey.800', icon: <CloudOffIcon fontSize="small" /> }
    if (isSyncing) return { label: t.sync.syncing, fill: 'transparent', icon: <CircularProgress size={14} color="inherit" /> }
    if (serverReachable === false) {
      return {
        label: t.sync.serverUnreachable,
        fill: 'warning.dark',
        icon: <WarningAmberIcon fontSize="small" />
      }
    }
    if (syncError) return { label: t.sync.failed, fill: 'error.main', icon: <ErrorOutlineIcon fontSize="small" /> }
    if (pendingCount > 0) return {
      label: t.sync.pendingCount.replace('{{count}}', String(pendingCount)),
      fill: 'warning.dark',
      icon: <SyncIcon fontSize="small" />
    }
    return { label: t.sync.synced, fill: 'success.dark', icon: <CloudDoneIcon fontSize="small" /> }
  }

  const { label, fill, icon } = getStatus()

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
      <Chip
        icon={icon}
        label={label}
        size="small"
        sx={{
          fontSize: '0.75rem',
          fontWeight: 600,
          minWidth: 148,
          bgcolor: fill,
          color: 'common.white',
          border: '1px solid rgba(255, 255, 255, 0.85)',
          '& .MuiChip-icon': { width: 18, height: 18, flexShrink: 0, color: 'inherit' }
        }}
      />
      {canReachServer(isOnline, serverReachable) && pendingCount > 0 && !isSyncing && (
        <Tooltip title={t.sync.manualSync}>
          <IconButton size="small" color="inherit" onClick={manualSync}>
            <SyncIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  )
}
