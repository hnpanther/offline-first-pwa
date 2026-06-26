import {
  Box,
  Typography,
  Button,
  Card,
  CardContent,
  IconButton,
  Chip,
  Alert,
  CircularProgress,
  Tooltip,
  Divider,
  Stack,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  TextField,
  FormLabel,
  Radio,
  RadioGroup,
  FormControlLabel,
  Pagination
} from '@mui/material'
import Autocomplete from '@mui/material/Autocomplete'
import AddIcon from '@mui/icons-material/Add'
import EditIcon from '@mui/icons-material/Edit'
import DeleteIcon from '@mui/icons-material/Delete'
import SearchIcon from '@mui/icons-material/Search'
import { useState, useEffect } from 'react'
import { useLogSheetTemplates } from '@/hooks/useLogSheets'
import { useLocations, usePlantSystems, useMainFunctions } from '@/hooks/useHierarchy'
import { getAssetsInScope } from '@/services/storage'
import { t } from '@/i18n'
import type { LogSheetTemplate, Location, PlantSystem, MainFunction } from '@/types'

const PAGE_SIZE = 20

const formatDate = (ts: number) =>
  new Date(ts).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' })

// ---------------------------------------------------------------------------
// Template dialog
// ---------------------------------------------------------------------------

interface TemplateDialogProps {
  open: boolean
  initial?: LogSheetTemplate
  locations: Location[]
  systems: PlantSystem[]
  mainFunctions: MainFunction[]
  onSave: (data: Omit<LogSheetTemplate, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  onClose: () => void
}

function TemplateDialog({ open, initial, locations, systems, mainFunctions, onSave, onClose }: TemplateDialogProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [scopeType, setScopeType] = useState<'location' | 'system' | 'mainFunction'>(initial?.scopeType ?? 'location')
  const [scopeId, setScopeId] = useState(initial?.scopeId ?? '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [assetCount, setAssetCount] = useState<number | null>(null)
  const [loadingAssets, setLoadingAssets] = useState(false)

  useEffect(() => {
    setName(initial?.name ?? '')
    setDescription(initial?.description ?? '')
    setScopeType(initial?.scopeType ?? 'location')
    setScopeId(initial?.scopeId ?? '')
    setSaveError(null)
    setAssetCount(null)
  }, [open, initial])

  const handleScopeTypeChange = (newType: 'location' | 'system' | 'mainFunction') => {
    setScopeType(newType)
    setScopeId('')
    setAssetCount(null)
  }

  useEffect(() => {
    if (!scopeId) { setAssetCount(null); return }
    setLoadingAssets(true)
    getAssetsInScope(scopeType, scopeId)
      .then(assets => setAssetCount(assets.length))
      .catch(() => setAssetCount(null))
      .finally(() => setLoadingAssets(false))
  }, [scopeType, scopeId])

  const scopeItems =
    scopeType === 'location' ? locations :
    scopeType === 'system' ? systems :
    mainFunctions

  const selectedScopeItem = scopeItems.find(item => item.id === scopeId) ?? null
  const canSave = name.trim() !== '' && scopeId !== ''

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setSaveError(null)
    try {
      await onSave({ name: name.trim(), description: description.trim() || undefined, scopeType, scopeId })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'خطا در ذخیره اطلاعات')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} dir="rtl" fullWidth maxWidth="sm">
      <DialogTitle>{initial ? t.logSheet.editTemplate : t.logSheet.addTemplate}</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 3 }}>
        {initial && (
          <Box sx={{ display: 'flex', gap: 3, p: 1.5, bgcolor: 'grey.50', borderRadius: 1 }}>
            <Typography variant="caption" color="text.secondary">
              ثبت: <strong>{formatDate(initial.createdAt)}</strong>
            </Typography>
            <Typography variant="caption" color="text.secondary">
              آخرین ویرایش: <strong>{formatDate(initial.updatedAt)}</strong>
            </Typography>
          </Box>
        )}
        <TextField
          label={t.logSheet.templateName}
          value={name}
          onChange={e => setName(e.target.value)}
          fullWidth
          autoFocus={!initial}
          required
        />
        <TextField
          label={t.logSheet.templateDesc}
          value={description}
          onChange={e => setDescription(e.target.value)}
          fullWidth
          multiline
          rows={2}
        />
        <Box>
          <FormLabel component="legend" sx={{ mb: 1, fontSize: '0.85rem' }}>{t.logSheet.scopeType}</FormLabel>
          <RadioGroup
            row
            value={scopeType}
            onChange={e => handleScopeTypeChange(e.target.value as 'location' | 'system' | 'mainFunction')}
          >
            <FormControlLabel value="location" control={<Radio size="small" />} label={t.logSheet.scopeLocation} />
            <FormControlLabel value="system" control={<Radio size="small" />} label={t.logSheet.scopeSystem} />
            <FormControlLabel value="mainFunction" control={<Radio size="small" />} label={t.logSheet.scopeMainFunction} />
          </RadioGroup>
        </Box>
        <Autocomplete
          options={scopeItems}
          getOptionLabel={item => `[${item.code}] ${item.name}`}
          value={selectedScopeItem}
          onChange={(_, v) => setScopeId(v?.id ?? '')}
          renderInput={params => <TextField {...params} label={t.logSheet.selectScope} required />}
          noOptionsText="موردی یافت نشد"
          clearText="پاک کردن"
        />
        {scopeId && (
          <Box sx={{ p: 1.5, bgcolor: 'info.50', borderRadius: 1, border: '1px solid', borderColor: 'info.200' }}>
            {loadingAssets ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <CircularProgress size={14} />
                <Typography variant="caption">در حال شمارش Asset ها...</Typography>
              </Box>
            ) : (
              <Typography variant="body2" color="info.main">
                تعداد Asset ها: <strong>{assetCount ?? 0}</strong>
              </Typography>
            )}
          </Box>
        )}
        {saveError && <Alert severity="error">{saveError}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>{t.common.cancel}</Button>
        <Button
          variant="contained"
          onClick={() => void handleSave()}
          disabled={!canSave || saving}
          startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {saving ? 'در حال ذخیره...' : t.common.save}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function LogSheetTemplatePage() {
  const { templates, loading, addTemplate, editTemplate, removeTemplate } = useLogSheetTemplates()
  const { locations } = useLocations()
  const { systems } = usePlantSystems()
  const { mainFunctions } = useMainFunctions()

  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<LogSheetTemplate | undefined>()
  const [deleteTarget, setDeleteTarget] = useState<LogSheetTemplate | undefined>()

  useEffect(() => setPage(1), [search])

  const filtered = templates.filter(tmpl => {
    const q = search.toLowerCase()
    if (!q) return true
    return (
      tmpl.name.toLowerCase().includes(q) ||
      (tmpl.description ?? '').toLowerCase().includes(q)
    )
  })

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const resolveScopeName = (tmpl: LogSheetTemplate) => {
    if (tmpl.scopeType === 'location') {
      const loc = locations.find(l => l.id === tmpl.scopeId)
      return loc ? `مکان: [${loc.code}] ${loc.name}` : `مکان: ${tmpl.scopeId}`
    }
    if (tmpl.scopeType === 'system') {
      const sys = systems.find(s => s.id === tmpl.scopeId)
      return sys ? `سیستم: [${sys.code}] ${sys.name}` : `سیستم: ${tmpl.scopeId}`
    }
    const mf = mainFunctions.find(m => m.id === tmpl.scopeId)
    return mf ? `فانکشن: [${mf.code}] ${mf.name}` : `فانکشن: ${tmpl.scopeId}`
  }

  const handleSave = async (data: Omit<LogSheetTemplate, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (editing) {
      await editTemplate(editing.id, data)
    } else {
      await addTemplate(data)
    }
    setDialogOpen(false)
    setEditing(undefined)
  }

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Typography variant="h5" fontWeight={700}>
          {t.nav.logSheetTemplates}
        </Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => { setEditing(undefined); setDialogOpen(true) }}
        >
          {t.logSheet.addTemplate}
        </Button>
      </Box>

      {/* Search */}
      <TextField
        size="small"
        placeholder="جستجو در نام یا توضیحات..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        fullWidth
        sx={{ mb: 1 }}
        InputProps={{
          startAdornment: <SearchIcon fontSize="small" sx={{ ml: 0.5, color: 'text.disabled', mr: 0.5 }} />
        }}
      />
      <Typography variant="caption" color="text.secondary" sx={{ mb: 2, display: 'block' }}>
        {filtered.length} مورد{search ? ` از ${templates.length}` : ''}
      </Typography>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : filtered.length === 0 ? (
        <Alert severity="info">
          {search ? 'نتیجه‌ای یافت نشد' : t.logSheet.noTemplates}
        </Alert>
      ) : (
        <>
          <Stack spacing={1.5}>
            {paginated.map(tmpl => (
              <Card
                key={tmpl.id}
                variant="outlined"
                sx={{ borderRight: '4px solid', borderRightColor: 'info.main' }}
              >
                <CardContent sx={{ pb: '8px !important' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
                    <Typography variant="subtitle1" fontWeight={700} sx={{ flex: 1 }}>
                      {tmpl.name}
                    </Typography>
                    <Tooltip title={t.common.edit}>
                      <IconButton size="small" onClick={() => { setEditing(tmpl); setDialogOpen(true) }}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={t.common.delete}>
                      <IconButton size="small" color="error" onClick={() => setDeleteTarget(tmpl)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Box>

                  {tmpl.description && (
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 0.75 }}>
                      {tmpl.description}
                    </Typography>
                  )}

                  <Chip
                    size="small"
                    label={resolveScopeName(tmpl)}
                    variant="outlined"
                    color="info"
                    sx={{ fontSize: '0.72rem', mb: 0.75 }}
                  />

                  <Divider sx={{ my: 0.75 }} />
                  <Box sx={{ display: 'flex', gap: 3 }}>
                    <Typography variant="caption" color="text.disabled">
                      ثبت: {formatDate(tmpl.createdAt)}
                    </Typography>
                    <Typography variant="caption" color="text.disabled">
                      ویرایش: {formatDate(tmpl.updatedAt)}
                    </Typography>
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

      <TemplateDialog
        open={dialogOpen}
        initial={editing}
        locations={locations}
        systems={systems}
        mainFunctions={mainFunctions}
        onSave={handleSave}
        onClose={() => { setDialogOpen(false); setEditing(undefined) }}
      />

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(undefined)} dir="rtl">
        <DialogTitle>{t.common.delete}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t.admin.deleteConfirm}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(undefined)}>{t.common.cancel}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => { void removeTemplate(deleteTarget!.id); setDeleteTarget(undefined) }}
          >
            {t.common.delete}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
