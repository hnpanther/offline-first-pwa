import {
  Box,
  Typography,
  Button,
  Card,
  CardContent,
  Stack,
  Chip,
  Alert,
  CircularProgress,
  Divider,
  IconButton,
  TextField,
  Pagination,
  Tooltip
} from '@mui/material'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import SearchIcon from '@mui/icons-material/Search'
import SyncIcon from '@mui/icons-material/Sync'
import BackHandIcon from '@mui/icons-material/BackHand'
import CloudOffIcon from '@mui/icons-material/CloudOff'
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLogSheets } from '@/hooks/useLogSheets'
import { useInboxSync } from '@/hooks/useInboxSync'
import { useAppStore } from '@/store'
import { claimLogSheet } from '@/services/api'
import { ensureLocalLogSheet } from '@/services/sync/logSheetSync'
import { getLogSheetByServerId } from '@/services/storage'
import { t } from '@/i18n'
import type { LogSheet } from '@/types'
import type { ServerLogSheet } from '@/services/api'
import { toIdString } from '@/utils/ids'
import { ScopeLabel } from '@/components/common/ScopeLabel'
import { LogSheetIdentityMeta } from '@/components/common/LogSheetIdentityMeta'

const PAGE_SIZE = 20

const formatDate = (ts: number) =>
  new Date(ts).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' })

interface LogSheetListPageProps {
  mode: 'active' | 'history'
}

function serverStatusLabel(status?: string | null): string {
  switch (status) {
    case 'ASSIGNED': return 'اختصاص یافته'
    case 'IN_PROGRESS': return 'در حال انجام'
    case 'PENDING': return 'در انتظار پیک‌آپ'
    case 'SUBMITTED': return 'ارسال شده'
    case 'EXPIRED': return 'منقضی'
    default: return status ?? '—'
  }
}

export function LogSheetListPage({ mode }: LogSheetListPageProps) {
  const navigate = useNavigate()
  const isOnline = useAppStore(s => s.isOnline)
  const inboxAssigned = useAppStore(s => s.inboxAssigned)
  const inboxAvailable = useAppStore(s => s.inboxAvailable)
  const inboxLoading = useAppStore(s => s.inboxLoading)
  const inboxError = useAppStore(s => s.inboxError)
  const inboxLastSyncAt = useAppStore(s => s.inboxLastSyncAt)
  const { refreshInbox } = useInboxSync()
  const { logs, loading, refresh: refreshLocal } = useLogSheets()

  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [actionError, setActionError] = useState<string | null>(null)
  const [claimingId, setClaimingId] = useState<string | null>(null)

  useEffect(() => setPage(1), [search, mode])

  const openSheet = useCallback(
    async (serverSheet: ServerLogSheet) => {
      setActionError(null)
      try {
        const local = await ensureLocalLogSheet(serverSheet)
        await refreshLocal()
        navigate(`/logsheets/${local.localId}`)
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'خطا در باز کردن کار')
      }
    },
    [navigate, refreshLocal]
  )

  const handleClaim = async (sheet: ServerLogSheet) => {
    if (!isOnline) {
      setActionError(t.inbox.pickupRequiresOnline)
      return
    }
    setActionError(null)
    setClaimingId(toIdString(sheet.id))
    try {
      const claimed = await claimLogSheet(sheet.id)
      await refreshInbox()
      await openSheet(claimed)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t.inbox.claimFailed)
    } finally {
      setClaimingId(null)
    }
  }

  const handleOpenAssigned = async (sheet: ServerLogSheet) => {
    const serverId = toIdString(sheet.id)
    const existing = await getLogSheetByServerId(serverId)
    if (existing) {
      navigate(`/logsheets/${existing.localId}`)
      return
    }
    await openSheet(sheet)
  }

  // Active: assigned from server inbox + local drafts not yet in history
  // History: locally submitted sheets
  const historyLogs = logs.filter(log => log.status === 'submitted')

  const filteredHistory = historyLogs.filter(log => {
    const q = search.toLowerCase()
    if (!q) return true
    return (
      log.templateName.toLowerCase().includes(q) ||
      log.scopeSummary.toLowerCase().includes(q) ||
      (log.operatorName ?? '').toLowerCase().includes(q)
    )
  })

  const filteredAssigned = inboxAssigned.filter(s => {
    const q = search.toLowerCase()
    if (!q) return true
    return (
      (s.templateName ?? '').toLowerCase().includes(q) ||
      (s.scopeSummary ?? '').toLowerCase().includes(q)
    )
  })

  const filteredAvailable = inboxAvailable.filter(s => {
    const q = search.toLowerCase()
    if (!q) return true
    return (
      (s.templateName ?? '').toLowerCase().includes(q) ||
      (s.scopeSummary ?? '').toLowerCase().includes(q)
    )
  })

  const totalPages =
    mode === 'history'
      ? Math.ceil(filteredHistory.length / PAGE_SIZE)
      : Math.ceil((filteredAssigned.length + filteredAvailable.length) / PAGE_SIZE)

  const paginatedHistory = filteredHistory.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const syncStatusColor = (log: LogSheet) => {
    if (log.syncStatus === 'synced') return 'success'
    if (log.syncStatus === 'failed') return 'error'
    if (log.syncStatus === 'syncing') return 'info'
    return 'warning'
  }

  const syncStatusLabel = (log: LogSheet) => {
    if (log.syncStatus === 'synced') return 'ارسال شده'
    if (log.syncStatus === 'failed') return 'خطا در ارسال'
    if (log.syncStatus === 'syncing') return 'در حال ارسال'
    return 'در انتظار ارسال'
  }

  const renderServerCard = (
    sheet: ServerLogSheet,
    variant: 'assigned' | 'available'
  ) => {
    const serverId = toIdString(sheet.id)
    const isClaiming = claimingId === serverId

    return (
      <Card
        key={`${variant}-${serverId}`}
        variant="outlined"
        sx={{
          borderRight: '4px solid',
          borderRightColor: variant === 'assigned' ? 'primary.main' : 'info.main'
        }}
      >
        <CardContent sx={{ pb: '8px !important' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
            <Box sx={{ flex: 1 }}>
              <Typography variant="subtitle1" fontWeight={700}>
                {sheet.templateName}
              </Typography>
              <ScopeLabel
                scopeSummary={sheet.scopeSummary}
                templateId={sheet.templateId != null ? toIdString(sheet.templateId) : undefined}
              />
            </Box>
            <Chip
              label={serverStatusLabel(sheet.status)}
              size="small"
              color={variant === 'assigned' ? 'primary' : 'info'}
              variant="outlined"
            />
            {variant === 'assigned' ? (
              <Button
                size="small"
                variant="contained"
                startIcon={<OpenInNewIcon />}
                onClick={() => void handleOpenAssigned(sheet)}
              >
                {t.inbox.open}
              </Button>
            ) : (
              <Tooltip
                title={!isOnline ? t.inbox.pickupRequiresOnline : ''}
                arrow
              >
                <span>
                  <Button
                    size="small"
                    variant="contained"
                    color="info"
                    disabled={!isOnline || isClaiming}
                    startIcon={
                      isClaiming ? (
                        <CircularProgress size={14} color="inherit" />
                      ) : !isOnline ? (
                        <CloudOffIcon />
                      ) : (
                        <BackHandIcon />
                      )
                    }
                    onClick={() => void handleClaim(sheet)}
                  >
                    {isClaiming ? t.inbox.claiming : t.inbox.claim}
                  </Button>
                </span>
              </Tooltip>
            )}
          </Box>

          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', flexDirection: 'column' }}>
            <LogSheetIdentityMeta serverId={sheet.id} createdAt={sheet.createdAt} />
            {sheet.dueAt && (
              <Typography variant="caption" color="text.secondary">
                مهلت: {formatDate(sheet.dueAt)}
              </Typography>
            )}
            {sheet.assignmentType === 'SUPERVISOR_ASSIGNED' && (
              <Chip label="اختصاص سرپرست" size="small" variant="outlined" />
            )}
          </Box>
        </CardContent>
      </Card>
    )
  }

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h5" fontWeight={700}>
          {mode === 'active' ? t.nav.logSheetActive : t.nav.logSheetHistory}
        </Typography>
        {mode === 'active' && (
          <Button
            size="small"
            variant="outlined"
            startIcon={inboxLoading ? <CircularProgress size={14} /> : <SyncIcon />}
            onClick={() => void refreshInbox(true)}
            disabled={!isOnline || inboxLoading}
          >
            {t.inbox.refresh}
          </Button>
        )}
      </Box>

      {mode === 'active' && !isOnline && (
        <Alert severity="warning" sx={{ mb: 2 }} icon={<CloudOffIcon />}>
          {t.inbox.offlineHint}
        </Alert>
      )}

      {inboxError && mode === 'active' && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => useAppStore.getState().setInboxError(null)}>
          {inboxError}
        </Alert>
      )}

      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}

      {mode === 'active' && inboxLastSyncAt && (
        <Typography variant="caption" color="text.disabled" sx={{ mb: 1, display: 'block' }}>
          {t.inbox.lastSync}: {formatDate(inboxLastSyncAt)}
        </Typography>
      )}

      <TextField
        size="small"
        placeholder="جستجو..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        fullWidth
        sx={{ mb: 1 }}
        InputProps={{
          startAdornment: (
            <SearchIcon fontSize="small" sx={{ ml: 0.5, color: 'text.disabled', mr: 0.5 }} />
          )
        }}
      />

      {(loading || (mode === 'active' && inboxLoading && inboxAssigned.length === 0)) ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : mode === 'active' ? (
        <>
          <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1, mt: 1 }}>
            {t.inbox.myWork} ({filteredAssigned.length})
          </Typography>
          {filteredAssigned.length === 0 ? (
            <Alert severity="info" sx={{ mb: 2 }}>{t.inbox.noAssigned}</Alert>
          ) : (
            <Stack spacing={1.5} sx={{ mb: 3 }}>
              {filteredAssigned.map(s => renderServerCard(s, 'assigned'))}
            </Stack>
          )}

          <Divider sx={{ my: 2 }} />

          <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>
            {t.inbox.pickupPool} ({filteredAvailable.length})
          </Typography>
          {filteredAvailable.length === 0 ? (
            <Alert severity="info">{t.inbox.noAvailable}</Alert>
          ) : (
            <Stack spacing={1.5}>
              {filteredAvailable.map(s => renderServerCard(s, 'available'))}
            </Stack>
          )}
        </>
      ) : filteredHistory.length === 0 ? (
        <Alert severity="info">{search ? 'نتیجه‌ای یافت نشد' : t.logSheet.noLogSheets}</Alert>
      ) : (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ mb: 2, display: 'block' }}>
            {filteredHistory.length} مورد
          </Typography>
          <Stack spacing={1.5}>
            {paginatedHistory.map(log => (
              <Card
                key={log.localId}
                variant="outlined"
                sx={{ borderRight: '4px solid', borderRightColor: 'success.main' }}
              >
                <CardContent sx={{ pb: '8px !important' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="subtitle1" fontWeight={700}>
                        {log.templateName}
                      </Typography>
                      <ScopeLabel scopeSummary={log.scopeSummary} templateId={log.templateId} />
                    </Box>
                    <Chip
                      label={syncStatusLabel(log)}
                      size="small"
                      color={syncStatusColor(log)}
                      variant="outlined"
                    />
                    <IconButton
                      size="small"
                      color="primary"
                      onClick={() => navigate(`/logsheets/${log.localId}`)}
                    >
                      <OpenInNewIcon fontSize="small" />
                    </IconButton>
                  </Box>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                    <LogSheetIdentityMeta
                      serverId={log.serverId}
                      createdAt={log.createdAt}
                    />
                    <Typography variant="caption" color="text.disabled">
                      ارسال: {log.submittedAt ? formatDate(log.submittedAt) : '—'}
                    </Typography>
                  </Box>
                </CardContent>
              </Card>
            ))}
          </Stack>
          {totalPages > 1 && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
              <Pagination
                count={totalPages}
                page={page}
                onChange={(_, p) => setPage(p)}
                size="small"
                color="primary"
              />
            </Box>
          )}
        </>
      )}
    </Box>
  )
}
