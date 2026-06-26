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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogContentText,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  IconButton,
  TextField,
  Pagination
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import DeleteIcon from '@mui/icons-material/Delete'
import SearchIcon from '@mui/icons-material/Search'
import SyncIcon from '@mui/icons-material/Sync'
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLogSheetTemplates, useLogSheets } from '@/hooks/useLogSheets'
import { getAssetsInScope, getAllSubFunctions, getSettings } from '@/services/storage'
import { t } from '@/i18n'
import type { LogSheetTemplate, LogSheetEntryData, LogSheet } from '@/types'

const PAGE_SIZE = 20

const formatDate = (ts: number) =>
  new Date(ts).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' })

// ---------------------------------------------------------------------------
// Create from template dialog
// ---------------------------------------------------------------------------

interface CreateLogSheetDialogProps {
  open: boolean
  templates: LogSheetTemplate[]
  onClose: () => void
  onCreate: (template: LogSheetTemplate) => Promise<void>
}

function CreateLogSheetDialog({ open, templates, onClose, onCreate }: CreateLogSheetDialogProps) {
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = async () => {
    const template = templates.find(t => t.id === selectedTemplateId)
    if (!template) return
    setCreating(true)
    setError(null)
    try {
      await onCreate(template)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در ایجاد Log Sheet')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={creating ? undefined : onClose}
      dir="rtl"
      fullWidth
      maxWidth="xs"
      TransitionProps={{ onExited: () => { setSelectedTemplateId(''); setError(null) } }}
    >
      <DialogTitle>ایجاد Log Sheet از قالب</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 3 }}>
        <FormControl fullWidth required>
          <InputLabel>انتخاب قالب</InputLabel>
          <Select
            value={selectedTemplateId}
            label="انتخاب قالب"
            onChange={e => setSelectedTemplateId(e.target.value)}
            disabled={creating}
          >
            <MenuItem value=""><em>— انتخاب کنید —</em></MenuItem>
            {templates.map(tmpl => (
              <MenuItem key={tmpl.id} value={tmpl.id}>{tmpl.name}</MenuItem>
            ))}
          </Select>
        </FormControl>
        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={creating}>{t.common.cancel}</Button>
        <Button
          variant="contained"
          onClick={() => void handleCreate()}
          disabled={!selectedTemplateId || creating}
          startIcon={creating ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {creating ? 'در حال ایجاد...' : 'ایجاد'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface LogSheetListPageProps {
  mode: 'active' | 'history'
}

export function LogSheetListPage({ mode }: LogSheetListPageProps) {
  const navigate = useNavigate()
  const { templates } = useLogSheetTemplates()
  const { logs, loading, addLogSheet, removeLogSheet } = useLogSheets()

  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LogSheet | undefined>()

  // Reset page when search or mode changes
  useEffect(() => setPage(1), [search, mode])

  // Filter by mode then by search
  const modeFiltered = logs.filter(log =>
    mode === 'active' ? log.status === 'draft' : log.status === 'submitted'
  )

  const filtered = modeFiltered.filter(log => {
    const q = search.toLowerCase()
    if (!q) return true
    return (
      log.templateName.toLowerCase().includes(q) ||
      log.scopeSummary.toLowerCase().includes(q) ||
      (log.operatorName ?? '').toLowerCase().includes(q)
    )
  })

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const createLogSheetFromTemplate = async (template: LogSheetTemplate) => {
    const assets = await getAssetsInScope(template.scopeType, template.scopeId)
    if (assets.length === 0) throw new Error(t.logSheet.noAssets)

    const allSubFunctions = await getAllSubFunctions()
    const sfMap = new Map(allSubFunctions.map(sf => [sf.id, sf]))

    const entries: LogSheetEntryData[] = assets.map(asset => {
      const sf = sfMap.get(asset.subFunctionId)
      return {
        assetId: asset.id,
        assetName: asset.assetName,
        subFunctionCode: sf?.code ?? '',
        subFunctionTag: sf?.tag ?? '',
        classId: asset.classId,
        formData: {}
      }
    })

    const settings = await getSettings()
    const newLogSheet = await addLogSheet({
      templateId: template.id,
      templateName: template.name,
      scopeSummary: template.name,
      operatorName: settings.operatorName || undefined,
      status: 'draft',
      entries
    })
    navigate(`/logsheets/${newLogSheet.localId}`)
  }

  const handleCreateFromTemplate = async (template: LogSheetTemplate) => {
    setCreateError(null)
    try {
      await createLogSheetFromTemplate(template)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'خطا در ایجاد Log Sheet')
      throw err
    }
  }

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

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Typography variant="h5" fontWeight={700}>
          {mode === 'active' ? t.nav.logSheetActive : t.nav.logSheetHistory}
        </Typography>
        {mode === 'active' && (
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setCreateDialogOpen(true)}
            disabled={templates.length === 0}
          >
            {t.logSheet.createFromTemplate}
          </Button>
        )}
      </Box>

      {mode === 'active' && templates.length === 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          ابتدا یک قالب در بخش «قالب‌های Log Sheet» تعریف کنید.
        </Alert>
      )}

      {createError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setCreateError(null)}>
          {createError}
        </Alert>
      )}

      {/* Search */}
      <TextField
        size="small"
        placeholder="جستجو در نام قالب، محدوده یا اپراتور..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        fullWidth
        sx={{ mb: 1 }}
        InputProps={{
          startAdornment: <SearchIcon fontSize="small" sx={{ ml: 0.5, color: 'text.disabled', mr: 0.5 }} />
        }}
      />
      <Typography variant="caption" color="text.secondary" sx={{ mb: 2, display: 'block' }}>
        {filtered.length} مورد{search ? ` از ${modeFiltered.length}` : ''}
      </Typography>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : filtered.length === 0 ? (
        <Alert severity="info">
          {search ? 'نتیجه‌ای یافت نشد' : t.logSheet.noLogSheets}
        </Alert>
      ) : (
        <>
          <Stack spacing={1.5}>
            {paginated.map(log => (
              <Card
                key={log.localId}
                variant="outlined"
                sx={{
                  borderRight: '4px solid',
                  borderRightColor: mode === 'active' ? 'warning.main' : 'success.main'
                }}
              >
                <CardContent sx={{ pb: '8px !important' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="subtitle1" fontWeight={700}>
                        {log.templateName}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {log.scopeSummary}
                      </Typography>
                    </Box>
                    {mode === 'history' && (
                      <Chip
                        label={syncStatusLabel(log)}
                        size="small"
                        color={syncStatusColor(log)}
                        variant="outlined"
                        icon={log.syncStatus === 'syncing' ? <SyncIcon fontSize="small" /> : undefined}
                      />
                    )}
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<OpenInNewIcon />}
                      onClick={() => navigate(`/logsheets/${log.localId}`)}
                    >
                      باز کردن
                    </Button>
                    <IconButton
                      size="small"
                      color="error"
                      aria-label={t.common.delete}
                      onClick={() => setDeleteTarget(log)}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Box>

                  <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 0.5 }}>
                    {log.operatorName && (
                      <Typography variant="body2" color="text.secondary">
                        اپراتور: {log.operatorName}
                      </Typography>
                    )}
                    <Typography variant="body2" color="text.secondary">
                      {log.entries.length} Asset
                    </Typography>
                  </Box>

                  <Divider sx={{ my: 0.75 }} />
                  <Box sx={{ display: 'flex', gap: 3 }}>
                    <Typography variant="caption" color="text.disabled">
                      ثبت: {formatDate(log.createdAt)}
                    </Typography>
                    {log.submittedAt && (
                      <Typography variant="caption" color="text.disabled">
                        ارسال: {formatDate(log.submittedAt)}
                      </Typography>
                    )}
                    {log.syncedAt && (
                      <Typography variant="caption" color="text.disabled">
                        همگام‌سازی: {formatDate(log.syncedAt)}
                      </Typography>
                    )}
                  </Box>
                </CardContent>
              </Card>
            ))}
          </Stack>

          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
            <Pagination
              count={totalPages}
              page={page}
              onChange={(_, p) => setPage(p)}
              size="small"
              color="primary"
            />
          </Box>
        </>
      )}

      <CreateLogSheetDialog
        open={createDialogOpen}
        templates={templates}
        onClose={() => setCreateDialogOpen(false)}
        onCreate={handleCreateFromTemplate}
      />

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(undefined)} dir="rtl">
        <DialogTitle>{t.common.delete}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t.logSheet.deleteConfirm}
            {deleteTarget && <> ({deleteTarget.templateName})</>}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(undefined)}>{t.common.cancel}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => { void removeLogSheet(deleteTarget!.localId); setDeleteTarget(undefined) }}
          >
            {t.common.delete}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
