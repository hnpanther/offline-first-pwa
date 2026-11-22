import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Typography
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import DescriptionIcon from '@mui/icons-material/Description'
import SyncIcon from '@mui/icons-material/Sync'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { t } from '@/i18n'
import { useAppStore } from '@/store'
import { getAllFormDefinitions } from '@/services/storage/formDefinitions'
import { getFormSubmissionsForUser } from '@/services/storage/formSubmissions'
import { getSessionUserId } from '@/services/auth/sessionContext'
import { loadAccessibleUnitIds } from '@/services/forms/formLookups'
import { pullFillableForms } from '@/services/sync/formCatalogSync'
import { pullOwnFormHistory } from '@/services/sync/formHistorySync'
import { isActiveFormSubmission, isHistoryFormSubmission } from '@/utils/formHistory'
import { persianFormDescription, persianFormTitle } from '@/utils/persianFormTitle'
import { canReachServer } from '@/utils/connectivity'
import { syncManager } from '@/services/sync'
import { hasPlantWideScope } from '@/types/auth'
import type { CachedFormDefinition, LocalFormSubmission } from '@/types'

function statusChip(row: LocalFormSubmission): { label: string; color: 'default' | 'warning' | 'success' | 'error' | 'primary' } {
  if (row.serverStatus === 'APPROVED') return { label: t.forms.statusApproved, color: 'success' }
  if (row.serverStatus === 'VOIDED') return { label: t.forms.statusVoided, color: 'default' }
  if (row.status === 'draft') return { label: t.forms.statusDraft, color: 'warning' }
  if (row.syncStatus === 'synced') return { label: t.forms.statusSubmitted, color: 'success' }
  if (row.syncStatus === 'failed') return { label: t.forms.statusFailed, color: 'error' }
  return { label: t.forms.statusPending, color: 'primary' }
}

function cardTitle(title?: string | null): string {
  return persianFormTitle(title) || t.forms.title
}

const titleSx = { whiteSpace: 'normal', overflowWrap: 'anywhere' } as const

export function FormListPage({ mode = 'active' }: { mode?: 'active' | 'history' }) {
  const navigate = useNavigate()
  const isOnline = useAppStore(s => s.isOnline)
  const serverReachable = useAppStore(s => s.serverReachable)
  const authSession = useAppStore(s => s.authSession)
  const canUseServer = canReachServer(isOnline, serverReachable)
  const plantWide = hasPlantWideScope(authSession)

  const [loading, setLoading] = useState(true)
  const [forms, setForms] = useState<CachedFormDefinition[]>([])
  const [mine, setMine] = useState<LocalFormSubmission[]>([])
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (canUseServer) {
        await pullFillableForms()
        await pullOwnFormHistory()
      }
      const [userId, accessibleUnitIds] = await Promise.all([
        getSessionUserId(),
        loadAccessibleUnitIds()
      ])
      const [catalog, rows] = await Promise.all([
        getAllFormDefinitions(),
        getFormSubmissionsForUser(userId, { accessibleUnitIds, plantWide })
      ])
      setForms(catalog.filter(f => f.active))
      setMine(rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در بارگذاری فرم‌ها')
    } finally {
      setLoading(false)
    }
  }, [canUseServer, plantWide])

  useEffect(() => {
    void reload()
  }, [reload])

  const drafts = mine.filter(r => isActiveFormSubmission(r) && r.status === 'draft')
  const pendingFinals = mine.filter(r => isActiveFormSubmission(r) && r.status === 'submitted')
  const history = mine.filter(r => isHistoryFormSubmission(r))

  return (
    <Box sx={{ p: 2, maxWidth: 900, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Typography variant="h5" fontWeight={700} sx={titleSx}>
          {mode === 'history' ? t.forms.historyTitle : t.forms.title}
        </Typography>
        <Button
          size="small"
          startIcon={<SyncIcon />}
          onClick={() => {
            void reload()
            void syncManager.sync()
          }}
          disabled={!canUseServer}
        >
          به‌روزرسانی
        </Button>
      </Stack>

      {!canUseServer && (
        <Alert severity="info" sx={{ mb: 2 }}>
          آفلاین — فهرست کش‌شده و پیش‌نویس‌های محلی در دسترس‌اند.
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Stack spacing={3}>
          {mode === 'active' && (
            <>
              <Box>
                <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
                  {t.forms.fillable}
                </Typography>
                {forms.length === 0 ? (
                  <Alert severity="info">{t.forms.emptyCatalog}</Alert>
                ) : (
                  <Stack spacing={1}>
                    {forms.map(form => {
                      const description = persianFormDescription(form.description)
                      return (
                        <Card key={form.id} variant="outlined">
                          <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1.5, '&:last-child': { pb: 1.5 } }}>
                            <DescriptionIcon color="action" />
                            <Box sx={{ flex: 1, minWidth: 0 }}>
                              <Typography fontWeight={600} sx={titleSx}>
                                {cardTitle(form.title)}
                              </Typography>
                              {description && (
                                <Typography variant="body2" color="text.secondary" sx={titleSx}>
                                  {description}
                                </Typography>
                              )}
                            </Box>
                            <Button
                              variant="contained"
                              size="small"
                              startIcon={<AddIcon />}
                              onClick={() => navigate(`/forms/new/${form.id}`)}
                            >
                              {t.forms.newDraft}
                            </Button>
                          </CardContent>
                        </Card>
                      )
                    })}
                  </Stack>
                )}
              </Box>

              <Divider />

              <Box>
                <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
                  {t.forms.myDrafts}
                </Typography>
                {drafts.length === 0 && pendingFinals.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    {t.forms.emptyDrafts}
                  </Typography>
                ) : (
                  <Stack spacing={1}>
                    {[...drafts, ...pendingFinals].map(row => {
                      const chip = statusChip(row)
                      return (
                        <Card key={row.localId} variant="outlined">
                          <CardActionArea onClick={() => navigate(`/forms/${row.localId}`)}>
                            <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                              <Stack direction="row" alignItems="center" spacing={1}>
                                <Box sx={{ flex: 1, minWidth: 0 }}>
                                  <Typography fontWeight={600} sx={titleSx}>
                                    {cardTitle(row.formTitle)}
                                  </Typography>
                                  <Typography variant="caption" color="text.secondary">
                                    {new Date(row.updatedAt).toLocaleString('fa-IR')}
                                  </Typography>
                                </Box>
                                <Chip size="small" label={chip.label} color={chip.color} />
                              </Stack>
                            </CardContent>
                          </CardActionArea>
                        </Card>
                      )
                    })}
                  </Stack>
                )}
              </Box>
            </>
          )}

          {mode === 'history' && (
            <Box>
              <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
                {t.forms.mySubmitted}
              </Typography>
              {history.length === 0 ? (
                <Alert severity="info">{t.forms.historyEmpty}</Alert>
              ) : (
                <Stack spacing={1}>
                  {history.map(row => {
                    const chip = statusChip(row)
                    return (
                      <Card key={row.localId} variant="outlined">
                        <CardActionArea onClick={() => navigate(`/forms/${row.localId}`)}>
                          <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                            <Stack direction="row" alignItems="center" spacing={1}>
                              <Box sx={{ flex: 1, minWidth: 0 }}>
                                <Typography fontWeight={600} sx={titleSx}>
                                  {cardTitle(row.formTitle)}
                                </Typography>
                                <Typography variant="caption" color="text.secondary">
                                  {new Date(row.submittedAt ?? row.updatedAt).toLocaleString('fa-IR')}
                                </Typography>
                                {row.syncError && (
                                  <Typography variant="caption" color="error" display="block" sx={titleSx}>
                                    {row.syncError}
                                  </Typography>
                                )}
                              </Box>
                              <Chip size="small" label={chip.label} color={chip.color} />
                            </Stack>
                          </CardContent>
                        </CardActionArea>
                      </Card>
                    )
                  })}
                </Stack>
              )}
            </Box>
          )}
        </Stack>
      )}
    </Box>
  )
}
