import { Box, Chip, CircularProgress, Tooltip, IconButton } from '@mui/material'
import SyncIcon from '@mui/icons-material/Sync'
import CloudDoneIcon from '@mui/icons-material/CloudDone'
import CloudOffIcon from '@mui/icons-material/CloudOff'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import { useAppStore } from '@/store'
import { useManualSync } from '@/hooks/useSync'
import { t } from '@/i18n'

export function SyncStatusBar() {
  const isOnline = useAppStore(s => s.isOnline)
  const isSyncing = useAppStore(s => s.isSyncing)
  const pendingCount = useAppStore(s => s.pendingCount)
  const syncError = useAppStore(s => s.syncError)
  const manualSync = useManualSync()

  const getStatus = () => {
    if (!isOnline) return { label: t.sync.offline, color: 'default' as const, icon: <CloudOffIcon fontSize="small" /> }
    if (isSyncing) return { label: t.sync.syncing, color: 'info' as const, icon: <CircularProgress size={14} color="inherit" /> }
    if (syncError) return { label: t.sync.failed, color: 'error' as const, icon: <ErrorOutlineIcon fontSize="small" /> }
    if (pendingCount > 0) return {
      label: t.sync.pendingCount.replace('{{count}}', String(pendingCount)),
      color: 'warning' as const,
      icon: <SyncIcon fontSize="small" />
    }
    return { label: t.sync.synced, color: 'success' as const, icon: <CloudDoneIcon fontSize="small" /> }
  }

  const { label, color, icon } = getStatus()

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
      <Chip
        icon={icon}
        label={label}
        color={color}
        size="small"
        variant="outlined"
        sx={{
          fontSize: '0.75rem',
          minWidth: 148,
          '& .MuiChip-icon': { width: 18, height: 18, flexShrink: 0 }
        }}
      />
      {isOnline && pendingCount > 0 && !isSyncing && (
        <Tooltip title={t.sync.manualSync}>
          <IconButton size="small" onClick={manualSync}>
            <SyncIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  )
}
