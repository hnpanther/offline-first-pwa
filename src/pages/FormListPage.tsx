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
import { pullFillableForms } from '@/services/sync/formCatalogSync'
import { canReachServer } from '@/utils/connectivity'
import { syncManager } from '@/services/sync'
import type { CachedFormDefinition, LocalFormSubmission } from '@/types'

function statusChip(row: LocalFormSubmission): { label: string; color: 'default' | 'warning' | 'success' | 'error' | 'primary' } {
  if (row.status === 'draft') return { label: t.forms.statusDraft, color: 'warning' }
  if (row.syncStatus === 'synced') return { label: t.forms.statusSynced, color: 'success' }
  if (row.syncStatus === 'failed') return { label: t.forms.statusFailed, color: 'error' }
  return { label: t.forms.statusPending, color: 'primary' }
}

export function FormListPage() {
  const navigate = useNavigate()
  const isOnline = useAppStore(s => s.isOnline)
  const serverReachable = useAppStore(s => s.serverReachable)
  const canUseServer = canReachServer(isOnline, serverReachable)

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
      }
      const userId = await getSessionUserId()
      const [catalog, rows] = await Promise.all([
        getAllFormDefinitions(),
        getFormSubmissionsForUser(userId)
      ])
      setForms(catalog.filter(f => f.active))
      setMine(rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در بارگذاری فرم‌ها')
    } finally {
      setLoading(false)
    }
  }, [canUseServer])

  useEffect(() => {
    void reload()
  }, [reload])

  const drafts = mine.filter(r => r.status === 'draft')
  const submitted = mine.filter(r => r.status === 'submitted')

  return (
    <Box sx={{ p: 2, maxWidth: 900, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Typography variant="h5" fontWeight={700}>
          {t.forms.title}
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
          <Box>
            <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
              {t.forms.fillable}
            </Typography>
            {forms.length === 0 ? (
              <Alert severity="info">{t.forms.emptyCatalog}</Alert>
            ) : (
              <Stack spacing={1}>
                {forms.map(form => (
                  <Card key={form.id} variant="outlined">
                    <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1.5, '&:last-child': { pb: 1.5 } }}>
                      <DescriptionIcon color="action" />
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography fontWeight={600} noWrap>
                          {form.title}
                        </Typography>
                        {form.description && (
                          <Typography variant="body2" color="text.secondary" noWrap>
                            {form.description}
                          </Typography>
                        )}
                        <Typography variant="caption" color="text.secondary">
                          {form.code}
                        </Typography>
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
                ))}
              </Stack>
            )}
          </Box>

          <Divider />

          <Box>
            <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
              {t.forms.myDrafts}
            </Typography>
            {drafts.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {t.forms.emptyDrafts}
              </Typography>
            ) : (
              <Stack spacing={1}>
                {drafts.map(row => {
                  const chip = statusChip(row)
                  return (
                    <Card key={row.localId} variant="outlined">
                      <CardActionArea onClick={() => navigate(`/forms/${row.localId}`)}>
                        <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                          <Stack direction="row" alignItems="center" spacing={1}>
                            <Box sx={{ flex: 1, minWidth: 0 }}>
                              <Typography fontWeight={600} noWrap>
                                {row.formTitle ?? row.formCode ?? row.formDefinitionId}
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

          {submitted.length > 0 && (
            <Box>
              <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
                {t.forms.mySubmitted}
              </Typography>
              <Stack spacing={1}>
                {submitted.map(row => {
                  const chip = statusChip(row)
                  return (
                    <Card key={row.localId} variant="outlined">
                      <CardActionArea onClick={() => navigate(`/forms/${row.localId}`)}>
                        <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                          <Stack direction="row" alignItems="center" spacing={1}>
                            <Box sx={{ flex: 1, minWidth: 0 }}>
                              <Typography fontWeight={600} noWrap>
                                {row.formTitle ?? row.formCode ?? row.formDefinitionId}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                {new Date(row.submittedAt ?? row.updatedAt).toLocaleString('fa-IR')}
                              </Typography>
                              {row.syncError && (
                                <Typography variant="caption" color="error" display="block">
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
            </Box>
          )}
        </Stack>
      )}
    </Box>
  )
}
