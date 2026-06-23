import {
  Box,
  Card,
  CardContent,
  CardActionArea,
  Typography,
  Grid,
  Button,
  Chip
} from '@mui/material'
import NfcIcon from '@mui/icons-material/Nfc'
import ListAltIcon from '@mui/icons-material/ListAlt'
import SyncIcon from '@mui/icons-material/Sync'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import PendingIcon from '@mui/icons-material/Pending'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '@/store'
import { useRecords } from '@/hooks/useRecords'
import { useManualSync } from '@/hooks/useSync'
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
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <Box>
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
    <Card>
      {onClick ? (
        <CardActionArea onClick={onClick}>{content}</CardActionArea>
      ) : (
        content
      )}
    </Card>
  )
}

export function Dashboard() {
  const navigate = useNavigate()
  const isOnline = useAppStore(s => s.isOnline)
  const isSyncing = useAppStore(s => s.isSyncing)
  const pendingCount = useAppStore(s => s.pendingCount)
  const failedCount = useAppStore(s => s.failedCount)
  const lastSyncAt = useAppStore(s => s.lastSyncAt)
  const { records } = useRecords()
  const manualSync = useManualSync()

  // Count today's records
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayCount = records.filter(r => r.createdAt >= todayStart.getTime()).length

  const syncedCount = records.filter(r => r.syncStatus === 'synced').length

  const formatTime = (ts: number | null) => {
    if (!ts) return '—'
    return new Date(ts).toLocaleTimeString('fa-IR')
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {/* Page title + status */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h5" fontWeight={700}>
          {t.dashboard.title}
        </Typography>
        <Chip
          label={isOnline ? t.sync.online : t.sync.offline}
          color={isOnline ? 'success' : 'default'}
          size="small"
          variant="filled"
        />
      </Box>

      {/* Stat cards */}
      <Grid container spacing={2}>
        <Grid item xs={6} sm={3}>
          <StatCard
            title={t.dashboard.totalRecords}
            value={records.length}
            icon={<ListAltIcon />}
            color="primary"
            onClick={() => navigate('/records')}
          />
        </Grid>
        <Grid item xs={6} sm={3}>
          <StatCard
            title={t.dashboard.todayRecords}
            value={todayCount}
            icon={<CheckCircleIcon />}
            color="success"
          />
        </Grid>
        <Grid item xs={6} sm={3}>
          <StatCard
            title={t.dashboard.pendingSync}
            value={pendingCount}
            icon={<PendingIcon />}
            color={pendingCount > 0 ? 'warning' : 'success'}
          />
        </Grid>
        <Grid item xs={6} sm={3}>
          <StatCard
            title="همگام‌سازی‌شده"
            value={syncedCount}
            icon={<SyncIcon />}
            color={failedCount > 0 ? 'error' : 'success'}
          />
        </Grid>
      </Grid>

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
              startIcon={<NfcIcon />}
              onClick={() => navigate('/collect')}
              sx={{ flex: 1, minWidth: 160 }}
            >
              {t.dashboard.quickCollect}
            </Button>
            <Button
              variant="outlined"
              size="large"
              startIcon={<ListAltIcon />}
              onClick={() => navigate('/records')}
              sx={{ flex: 1, minWidth: 160 }}
            >
              {t.nav.records}
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
