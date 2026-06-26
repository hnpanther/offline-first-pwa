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
  IconButton
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import DeleteIcon from '@mui/icons-material/Delete'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLogSheetTemplates, useLogSheets } from '@/hooks/useLogSheets'
import { getAssetsInScope, getAllSubFunctions, getSettings } from '@/services/storage'
import { t } from '@/i18n'
import type { LogSheetTemplate, LogSheetEntryData, LogSheet } from '@/types'

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
      TransitionProps={{
        onExited: () => { setSelectedTemplateId(''); setError(null) }
      }}
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

export function LogSheetListPage() {
  const navigate = useNavigate()
  const { templates, loading: templatesLoading } = useLogSheetTemplates()
  const { logs, loading: logsLoading, addLogSheet, removeLogSheet } = useLogSheets()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LogSheet | undefined>()

  const createLogSheetFromTemplate = async (template: LogSheetTemplate) => {
    // 1. Get assets in scope
    const assets = await getAssetsInScope(template.scopeType, template.scopeId)

    if (assets.length === 0) {
      throw new Error(t.logSheet.noAssets)
    }

    // 2. Load all subFunctions for lookup
    const allSubFunctions = await getAllSubFunctions()
    const sfMap = new Map(allSubFunctions.map(sf => [sf.id, sf]))

    // 3. Build entries — use classId (from AssetEntry.classId)
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

    // 4. Get operator name from settings
    const settings = await getSettings()

    // 5. Build scope summary
    const scopeSummary = template.name

    // 6. Save log sheet
    const newLogSheet = await addLogSheet({
      templateId: template.id,
      templateName: template.name,
      scopeSummary,
      operatorName: settings.operatorName || undefined,
      status: 'draft',
      entries
    })

    // 7. Navigate to fill page
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

  const statusLabel = (status: 'draft' | 'submitted') =>
    status === 'submitted' ? t.logSheet.submitted : t.logSheet.draft

  const statusColor = (status: 'draft' | 'submitted') =>
    status === 'submitted' ? 'success' : 'warning'

  const loading = templatesLoading || logsLoading

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Typography variant="h5" fontWeight={700}>
          {t.logSheet.list}
        </Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setCreateDialogOpen(true)}
          disabled={templates.length === 0}
        >
          {t.logSheet.createFromTemplate}
        </Button>
      </Box>

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      )}

      {createError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setCreateError(null)}>
          {createError}
        </Alert>
      )}

      {/* Templates section */}
      {!loading && templates.length > 0 && (
        <Box sx={{ mb: 4 }}>
          <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1.5 }}>
            {t.logSheet.templates}
          </Typography>
          <Stack spacing={1}>
            {templates.map(tmpl => (
              <Card key={tmpl.id} variant="outlined">
                <CardContent sx={{ pb: '8px !important' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="body1" fontWeight={600}>{tmpl.name}</Typography>
                      {tmpl.description && (
                        <Typography variant="body2" color="text.secondary">{tmpl.description}</Typography>
                      )}
                    </Box>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<AddIcon />}
                      onClick={() => void handleCreateFromTemplate(tmpl)}
                    >
                      ایجاد
                    </Button>
                  </Box>
                </CardContent>
              </Card>
            ))}
          </Stack>
        </Box>
      )}

      {!loading && templates.length === 0 && (
        <Alert severity="info" sx={{ mb: 3 }}>
          {t.logSheet.noTemplates} — ابتدا یک قالب در بخش مدیریت تعریف کنید.
        </Alert>
      )}

      {/* Log Sheets section */}
      <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1.5 }}>
        {t.logSheet.list}
      </Typography>

      {!loading && logs.length === 0 ? (
        <Alert severity="info">{t.logSheet.noLogSheets}</Alert>
      ) : (
        <Stack spacing={1.5}>
          {logs.map(log => (
            <Card
              key={log.localId}
              variant="outlined"
              sx={{ borderRight: '4px solid', borderRightColor: log.status === 'submitted' ? 'success.main' : 'warning.main' }}
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
                  <Chip
                    label={statusLabel(log.status)}
                    size="small"
                    color={statusColor(log.status)}
                    variant="outlined"
                  />
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
                    onClick={e => {
                      e.stopPropagation()
                      setDeleteTarget(log)
                    }}
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
                </Box>
              </CardContent>
            </Card>
          ))}
        </Stack>
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
            {deleteTarget && (
              <> ({deleteTarget.templateName})</>
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(undefined)}>{t.common.cancel}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              void removeLogSheet(deleteTarget!.localId)
              setDeleteTarget(undefined)
            }}
          >
            {t.common.delete}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
