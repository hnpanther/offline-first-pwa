import {
  Box,
  Card,
  CardContent,
  CardActionArea,
  Typography,
  Button,
  Chip
} from '@mui/material'
import FactCheckIcon from '@mui/icons-material/FactCheck'
import HistoryIcon from '@mui/icons-material/History'
import SyncIcon from '@mui/icons-material/Sync'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import PendingIcon from '@mui/icons-material/Pending'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '@/store'
import { useLogSheets } from '@/hooks/useLogSheets'
import { useManualSync } from '@/hooks/useSync'
import { computeDashboardStats } from '@/utils/dashboardStats'
import { isAdminRole } from '@/types/auth'
import { t } from '@/i18n'

function StatCard({
  title,
  value,
  icon,
  color = 'primary',
  onClick
}: {
  title: string
  value: number | string
  icon: React.ReactNode
  color?: 'primary' | 'success' | 'warning' | 'error'
  onClick?: () => void
}) {
  const content = (
    <CardContent>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h4" fontWeight={700} color={`${color}.main`}>
            {value}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {title}
          </Typography>
        </Box>
        <Box
          sx={{
            p: 1.5,
            borderRadius: 2,
            bgcolor: `${color}.light`,
            color: `${color}.contrastText`,
            display: 'flex',
            opacity: 0.85
          }}
        >
          {icon}
        </Box>
      </Box>
    </CardContent>
  )

  return (
    <Card sx={{ height: '100%', minWidth: 0 }}>
      {onClick ? (
        <CardActionArea onClick={onClick} sx={{ height: '100%' }}>
          {content}
        </CardActionArea>
      ) : (
        content
      )}
    </Card>
  )
}

export function Dashboard() {
  const navigate = useNavigate()
  const authSession = useAppStore(s => s.authSession)
  const isOnline = useAppStore(s => s.isOnline)
  const isSyncing = useAppStore(s => s.isSyncing)
  const sessionUserId = useAppStore(s => s.sessionUserId)
  const pendingCount = useAppStore(s => s.pendingCount)
  const failedCount = useAppStore(s => s.failedCount)
  const lastSyncAt = useAppStore(s => s.lastSyncAt)
  const { logs: logSheets } = useLogSheets()
  const manualSync = useManualSync()

  // Log sheets are the only work unit this app tracks. The device's table is
  // shared between everyone who signs in, so the counters are scoped to the
  // viewer — see utils/dashboardStats.ts for the exact rule.
  const isAdmin = isAdminRole(authSession?.roles ?? [])
  const { open: openCount, submittedToday: todayCount, synced: syncedCount } =
    computeDashboardStats(logSheets, { sessionUserId, isAdmin })

  const formatTime = (ts: number | null) => {
    if (!ts) return '—'
    return new Date(ts).toLocaleTimeString('fa-IR')
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {/* Page title + status */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Box>
          <Typography variant="h5" fontWeight={700}>
            {t.dashboard.title}
          </Typography>
          {authSession && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {t.dashboard.username}: <Box component="span" dir="ltr" sx={{ fontWeight: 600 }}>{authSession.username}</Box>
              {' · '}
              {t.dashboard.fullName}: <strong>{authSession.fullName || '—'}</strong>
            </Typography>
          )}
        </Box>
        <Chip
          label={isOnline ? t.sync.online : t.sync.offline}
          color={isOnline ? 'success' : 'default'}
          size="small"
          variant="filled"
        />
      </Box>

      {/*
        Stat cards. Plain CSS grid rather than MUI's <Grid container>: that one
        lays out with negative margins, which on a wide tablet pushed the last
        card past the right edge of the content box with nothing to scroll it
        back into view. `gap` needs no negative margins, and `minmax(0, 1fr)`
        lets a track shrink below its content instead of forcing the row wider.
      */}
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: {
            xs: 'repeat(2, minmax(0, 1fr))',
            sm: 'repeat(4, minmax(0, 1fr))'
          }
        }}
      >
        <StatCard
          title={t.dashboard.openLogSheets}
          value={openCount}
          icon={<FactCheckIcon />}
          color="primary"
          onClick={() => navigate('/logsheets/active')}
        />
        <StatCard
          title={t.dashboard.todaySubmitted}
          value={todayCount}
          icon={<CheckCircleIcon />}
          color="success"
        />
        <StatCard
          title={t.dashboard.pendingSync}
          value={pendingCount}
          icon={<PendingIcon />}
          color={pendingCount > 0 ? 'warning' : 'success'}
        />
        <StatCard
          title={t.dashboard.syncedCount}
          value={syncedCount}
          icon={<SyncIcon />}
          color={failedCount > 0 ? 'error' : 'success'}
        />
      </Box>
      {!isAdmin && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: -2 }}>
          {t.dashboard.ownStatsHint}
        </Typography>
      )}

      {/* Quick actions */}
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            عملیات سریع
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            <Button
              variant="contained"
              size="large"
              startIcon={<FactCheckIcon />}
              onClick={() => navigate('/logsheets/active')}
              sx={{ flex: 1, minWidth: 160 }}
            >
              {t.nav.logSheetActive}
            </Button>
            <Button
              variant="outlined"
              size="large"
              startIcon={<HistoryIcon />}
              onClick={() => navigate('/logsheets/history')}
              sx={{ flex: 1, minWidth: 160 }}
            >
              {t.nav.logSheetHistory}
            </Button>
          </Box>
        </CardContent>
      </Card>

      {/* Sync status card */}
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            وضعیت همگام‌سازی
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="body2" color="text.secondary">
                {t.sync.lastSync}
              </Typography>
              <Typography variant="body2" fontWeight={500}>
                {formatTime(lastSyncAt)}
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="body2" color="text.secondary">
                در انتظار ارسال
              </Typography>
              <Chip
                label={pendingCount}
                size="small"
                color={pendingCount > 0 ? 'warning' : 'success'}
              />
            </Box>
            {failedCount > 0 && (
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="body2" color="error">
                  خطادار
                </Typography>
                <Chip label={failedCount} size="small" color="error" icon={<ErrorOutlineIcon />} />
              </Box>
            )}
            {isOnline && pendingCount > 0 && (
              <Button
                variant="outlined"
                startIcon={isSyncing ? undefined : <SyncIcon />}
                onClick={manualSync}
                disabled={isSyncing}
                size="small"
                sx={{ mt: 1, alignSelf: 'flex-start' }}
              >
                {isSyncing ? t.sync.syncing : t.sync.manualSync}
              </Button>
            )}
          </Box>
        </CardContent>
      </Card>
    </Box>
  )
}
