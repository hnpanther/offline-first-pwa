import {
  Box,
  Typography,
  Tabs,
  Tab,
  Card,
  CardContent,
  Button,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  TextField,
  FormControlLabel,
  Checkbox,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Chip,
  Alert,
  CircularProgress,
  Tooltip,
  Divider,
  Stack
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import EditIcon from '@mui/icons-material/Edit'
import DeleteIcon from '@mui/icons-material/Delete'
import { useState, useEffect } from 'react'
import { useAssetTypes, useAssetEntries } from '@/hooks/useAssets'
import { t } from '@/i18n'
import type { AssetType, AssetEntry, FormField, FormFieldType } from '@/types'

const FIELD_TYPES: { value: FormFieldType; label: string }[] = [
  { value: 'number', label: t.admin.fieldTypes.number },
  { value: 'text', label: t.admin.fieldTypes.text },
  { value: 'select', label: t.admin.fieldTypes.select },
  { value: 'multiselect', label: t.admin.fieldTypes.multiselect },
  { value: 'checkbox', label: t.admin.fieldTypes.checkbox },
  { value: 'textarea', label: t.admin.fieldTypes.textarea }
]

const formatDate = (ts: number) =>
  new Date(ts).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' })

// ---------------------------------------------------------------------------
// Field editor dialog
// ---------------------------------------------------------------------------

const EMPTY_FIELD: FormField = { name: '', label: '', type: 'text', required: false }

interface FieldDialogProps {
  open: boolean
  initial?: FormField
  existingKeys: string[]
  onSave: (field: FormField) => void
  onClose: () => void
}

function FieldDialog({ open, initial, existingKeys, onSave, onClose }: FieldDialogProps) {
  const [field, setField] = useState<FormField>(initial ?? { ...EMPTY_FIELD })
  const [optionText, setOptionText] = useState('')

  useEffect(() => {
    setField(initial ?? { ...EMPTY_FIELD })
    setOptionText('')
  }, [open, initial])

  const set = <K extends keyof FormField>(key: K, value: FormField[K]) =>
    setField(prev => ({ ...prev, [key]: value }))

  const addOption = () => {
    const v = optionText.trim()
    if (!v) return
    set('options', [...(field.options ?? []), { value: v, label: v }])
    setOptionText('')
  }

  const removeOption = (idx: number) =>
    set('options', (field.options ?? []).filter((_, i) => i !== idx))

  const keyConflict = !initial && existingKeys.includes(field.name)
  const canSave = !!(field.name.trim() && field.label.trim() && !keyConflict)

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" fullWidth maxWidth="sm">
      <DialogTitle>{initial ? t.admin.editField : t.admin.addField}</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 3 }}>
        <TextField
          label={t.admin.fieldKey}
          value={field.name}
          onChange={e => set('name', e.target.value.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase())}
          dir="ltr"
          helperText={keyConflict ? 'این کلید قبلاً استفاده شده' : 'حروف انگلیسی و زیرخط — مثال: temperature'}
          error={keyConflict}
          disabled={!!initial}
          fullWidth
        />
        <TextField
          label={t.admin.fieldLabel}
          value={field.label}
          onChange={e => set('label', e.target.value)}
          fullWidth
        />
        <FormControl fullWidth>
          <InputLabel>{t.admin.fieldType}</InputLabel>
          <Select
            value={field.type}
            label={t.admin.fieldType}
            onChange={e => set('type', e.target.value as FormFieldType)}
          >
            {FIELD_TYPES.map(ft => (
              <MenuItem key={ft.value} value={ft.value}>{ft.label}</MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControlLabel
          control={<Checkbox checked={!!field.required} onChange={e => set('required', e.target.checked)} />}
          label={t.admin.fieldRequired}
        />

        {field.type === 'number' && (
          <Box sx={{ display: 'flex', gap: 2 }}>
            <TextField
              label={t.admin.fieldUnit}
              value={field.unit ?? ''}
              onChange={e => set('unit', e.target.value || undefined)}
              size="small"
              sx={{ flex: 1 }}
            />
            <TextField
              label={t.admin.fieldMin}
              value={field.min ?? ''}
              onChange={e => set('min', e.target.value ? Number(e.target.value) : undefined)}
              type="number"
              size="small"
              dir="ltr"
              sx={{ flex: 1 }}
            />
            <TextField
              label={t.admin.fieldMax}
              value={field.max ?? ''}
              onChange={e => set('max', e.target.value ? Number(e.target.value) : undefined)}
              type="number"
              size="small"
              dir="ltr"
              sx={{ flex: 1 }}
            />
          </Box>
        )}

        {(field.type === 'select' || field.type === 'multiselect') && (
          <Box>
            <Typography variant="subtitle2" gutterBottom>{t.admin.fieldOptions}</Typography>
            <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
              <TextField
                size="small"
                fullWidth
                placeholder="نام گزینه..."
                value={optionText}
                onChange={e => setOptionText(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addOption()}
              />
              <Button variant="outlined" size="small" onClick={addOption} disabled={!optionText.trim()}>
                {t.common.add}
              </Button>
            </Box>
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              {(field.options ?? []).map((opt, i) => (
                <Chip key={i} label={opt.label} onDelete={() => removeOption(i)} size="small" />
              ))}
            </Box>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t.common.cancel}</Button>
        <Button variant="contained" onClick={() => canSave && onSave(field)} disabled={!canSave}>
          {t.common.save}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Asset Type dialog
// ---------------------------------------------------------------------------

interface AssetTypeDialogProps {
  open: boolean
  initial?: AssetType
  onSave: (data: { name: string; fields: FormField[] }) => Promise<void>
  onClose: () => void
}

function AssetTypeDialog({ open, initial, onSave, onClose }: AssetTypeDialogProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [fields, setFields] = useState<FormField[]>(initial?.fields ?? [])
  const [fieldDialogOpen, setFieldDialogOpen] = useState(false)
  const [editingField, setEditingField] = useState<FormField | undefined>()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    setName(initial?.name ?? '')
    setFields(initial?.fields ?? [])
    setSaveError(null)
  }, [open, initial])

  const handleSaveField = (field: FormField) => {
    setFields(prev =>
      editingField
        ? prev.map(f => f.name === editingField.name ? field : f)
        : [...prev, field]
    )
    setFieldDialogOpen(false)
    setEditingField(undefined)
  }

  const removeField = (fieldName: string) =>
    setFields(prev => prev.filter(f => f.name !== fieldName))

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    setSaveError(null)
    try {
      await onSave({ name: name.trim(), fields })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'خطا در ذخیره اطلاعات')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Dialog open={open} onClose={saving ? undefined : onClose} dir="rtl" fullWidth maxWidth="sm">
        <DialogTitle>{initial ? t.admin.editAssetType : t.admin.addAssetType}</DialogTitle>
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
            label={t.admin.assetTypeName}
            value={name}
            onChange={e => setName(e.target.value)}
            fullWidth
            autoFocus={!initial}
          />

          <Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="subtitle2">
                فیلدها ({fields.length} {t.admin.fieldsCount})
              </Typography>
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={() => { setEditingField(undefined); setFieldDialogOpen(true) }}
              >
                {t.admin.addField}
              </Button>
            </Box>
            {fields.length === 0 ? (
              <Typography variant="body2" color="text.secondary">هیچ فیلدی تعریف نشده</Typography>
            ) : (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {fields.map(f => (
                  <Box
                    key={f.name}
                    sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1, bgcolor: 'grey.50', borderRadius: 1 }}
                  >
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="body2" fontWeight={600}>{f.label}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {f.name} · {FIELD_TYPES.find(x => x.value === f.type)?.label}
                        {f.required && ' · اجباری'}
                        {f.unit && ` · ${f.unit}`}
                      </Typography>
                    </Box>
                    <IconButton size="small" onClick={() => { setEditingField(f); setFieldDialogOpen(true) }}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                    <IconButton size="small" color="error" onClick={() => removeField(f.name)}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Box>
                ))}
              </Box>
            )}
          </Box>

          {saveError && <Alert severity="error">{saveError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={saving}>{t.common.cancel}</Button>
          <Button
            variant="contained"
            onClick={() => void handleSave()}
            disabled={!name.trim() || saving}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {saving ? 'در حال ذخیره...' : t.common.save}
          </Button>
        </DialogActions>
      </Dialog>

      <FieldDialog
        open={fieldDialogOpen}
        initial={editingField}
        existingKeys={fields.filter(f => f.name !== editingField?.name).map(f => f.name)}
        onSave={handleSaveField}
        onClose={() => setFieldDialogOpen(false)}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Asset Types tab
// ---------------------------------------------------------------------------

function AssetTypesTab() {
  const { assetTypes, addAssetType, editAssetType, removeAssetType } = useAssetTypes()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AssetType | undefined>()
  const [deleteTarget, setDeleteTarget] = useState<AssetType | undefined>()

  const handleSave = async (data: { name: string; fields: FormField[] }) => {
    if (editing) {
      await editAssetType(editing.id, data)
    } else {
      await addAssetType(data)
    }
    setDialogOpen(false)
    setEditing(undefined)
  }

  return (
    <>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => { setEditing(undefined); setDialogOpen(true) }}
        >
          {t.admin.addAssetType}
        </Button>
      </Box>

      {assetTypes.length === 0 ? (
        <Alert severity="info">{t.admin.noAssetTypes}</Alert>
      ) : (
        <Stack spacing={1.5}>
          {assetTypes.map(at => (
            <Card
              key={at.id}
              variant="outlined"
              sx={{ borderRight: '4px solid', borderRightColor: 'primary.main' }}
            >
              <CardContent sx={{ pb: '8px !important' }}>
                {/* Header row: name + actions */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                  <Typography variant="subtitle1" fontWeight={700} sx={{ flex: 1 }}>
                    {at.name}
                  </Typography>
                  <Chip
                    label={`${at.fields.length} ${t.admin.fieldsCount}`}
                    size="small"
                    color="primary"
                    variant="outlined"
                  />
                  <Tooltip title={t.common.edit}>
                    <IconButton size="small" onClick={() => { setEditing(at); setDialogOpen(true) }}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={t.common.delete}>
                    <IconButton size="small" color="error" onClick={() => setDeleteTarget(at)}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>

                {/* Fields */}
                {at.fields.length > 0 && (
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
                    {at.fields.map(f => (
                      <Chip
                        key={f.name}
                        label={`${f.label}${f.required ? ' *' : ''}${f.unit ? ` (${f.unit})` : ''}`}
                        size="small"
                        variant="outlined"
                        sx={{ fontSize: '0.7rem' }}
                      />
                    ))}
                  </Box>
                )}

                {/* Dates */}
                <Divider sx={{ my: 0.75 }} />
                <Box sx={{ display: 'flex', gap: 3 }}>
                  <Typography variant="caption" color="text.disabled">
                    ثبت: {formatDate(at.createdAt)}
                  </Typography>
                  <Typography variant="caption" color="text.disabled">
                    ویرایش: {formatDate(at.updatedAt)}
                  </Typography>
                </Box>
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}

      <AssetTypeDialog
        open={dialogOpen}
        initial={editing}
        onSave={handleSave}
        onClose={() => { setDialogOpen(false); setEditing(undefined) }}
      />

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(undefined)} dir="rtl">
        <DialogTitle>{t.admin.deleteAssetType}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t.admin.deleteConfirm}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(undefined)}>{t.common.cancel}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => { void removeAssetType(deleteTarget!.id); setDeleteTarget(undefined) }}
          >
            {t.common.delete}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

// ---------------------------------------------------------------------------
// Asset Entry dialog
// ---------------------------------------------------------------------------

interface AssetEntryDialogProps {
  open: boolean
  initial?: AssetEntry
  assetTypes: AssetType[]
  onSave: (data: Omit<AssetEntry, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  onClose: () => void
}

function AssetEntryDialog({ open, initial, assetTypes, onSave, onClose }: AssetEntryDialogProps) {
  const [tagId, setTagId] = useState(initial?.nfcTagId ?? '')
  const [assetName, setAssetName] = useState(initial?.assetName ?? '')
  const [assetTypeId, setAssetTypeId] = useState(initial?.assetTypeId ?? '')
  const [location, setLocation] = useState(initial?.location ?? '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    setTagId(initial?.nfcTagId ?? '')
    setAssetName(initial?.assetName ?? '')
    setAssetTypeId(initial?.assetTypeId ?? '')
    setLocation(initial?.location ?? '')
    setSaveError(null)
  }, [open, initial])

  const canSave = tagId.trim() !== '' && assetName.trim() !== '' && assetTypeId !== ''

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setSaveError(null)
    try {
      await onSave({
        nfcTagId: tagId.trim(),
        assetName: assetName.trim(),
        assetTypeId,
        location: location.trim() || undefined
      })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'خطا در ذخیره اطلاعات')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} dir="rtl" fullWidth maxWidth="sm">
      <DialogTitle>{initial ? t.admin.editAssetEntry : t.admin.addAssetEntry}</DialogTitle>
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
          label={t.admin.tagId}
          value={tagId}
          onChange={e => setTagId(e.target.value)}
          helperText={t.admin.tagIdHelper}
          dir="ltr"
          disabled={!!initial || saving}
          fullWidth
        />
        <TextField
          label={t.admin.assetName}
          value={assetName}
          onChange={e => setAssetName(e.target.value)}
          disabled={saving}
          fullWidth
        />
        <FormControl fullWidth>
          <InputLabel>{t.admin.assetType}</InputLabel>
          <Select
            value={assetTypeId}
            label={t.admin.assetType}
            onChange={e => setAssetTypeId(e.target.value)}
            disabled={saving}
          >
            {assetTypes.map(at => (
              <MenuItem key={at.id} value={at.id}>{at.name}</MenuItem>
            ))}
          </Select>
        </FormControl>
        <TextField
          label={t.admin.location}
          value={location}
          onChange={e => setLocation(e.target.value)}
          disabled={saving}
          fullWidth
        />

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
// Asset Registry tab
// ---------------------------------------------------------------------------

function AssetRegistryTab() {
  const { assetTypes } = useAssetTypes()
  const { assetEntries, addAssetEntry, editAssetEntry, removeAssetEntry } = useAssetEntries()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AssetEntry | undefined>()
  const [deleteTarget, setDeleteTarget] = useState<AssetEntry | undefined>()

  const findTypeName = (id: string) => assetTypes.find(type => type.id === id)?.name ?? t.common.unknown

  const handleSave = async (data: Omit<AssetEntry, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (editing) {
      await editAssetEntry(editing.id, data)
    } else {
      await addAssetEntry(data)
    }
    setDialogOpen(false)
    setEditing(undefined)
  }

  return (
    <>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => { setEditing(undefined); setDialogOpen(true) }}
          disabled={assetTypes.length === 0}
        >
          {t.admin.addAssetEntry}
        </Button>
      </Box>

      {assetTypes.length === 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          ابتدا یک نوع دستگاه در تب «انواع دستگاه» تعریف کنید.
        </Alert>
      )}

      {assetEntries.length === 0 ? (
        <Alert severity="info">{t.admin.noAssetEntries}</Alert>
      ) : (
        <Stack spacing={1.5}>
          {assetEntries.map(entry => (
            <Card
              key={entry.id}
              variant="outlined"
              sx={{ borderRight: '4px solid', borderRightColor: 'secondary.main' }}
            >
              <CardContent sx={{ pb: '8px !important' }}>
                {/* Header row: name + type chip + actions */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
                  <Typography variant="subtitle1" fontWeight={700} sx={{ flex: 1 }}>
                    {entry.assetName}
                  </Typography>
                  <Chip
                    label={findTypeName(entry.assetTypeId)}
                    size="small"
                    color="primary"
                    variant="outlined"
                  />
                  <Tooltip title={t.common.edit}>
                    <IconButton size="small" onClick={() => { setEditing(entry); setDialogOpen(true) }}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={t.common.delete}>
                    <IconButton size="small" color="error" onClick={() => setDeleteTarget(entry)}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>

                {/* Location + Tag */}
                <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 0.5 }}>
                  {entry.location && (
                    <Typography variant="body2" color="text.secondary">
                      📍 {entry.location}
                    </Typography>
                  )}
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ direction: 'ltr', fontFamily: 'monospace' }}
                  >
                    🏷 {entry.nfcTagId}
                  </Typography>
                </Box>

                {/* Dates */}
                <Divider sx={{ my: 0.75 }} />
                <Box sx={{ display: 'flex', gap: 3 }}>
                  <Typography variant="caption" color="text.disabled">
                    ثبت: {formatDate(entry.createdAt)}
                  </Typography>
                  <Typography variant="caption" color="text.disabled">
                    آخرین ویرایش: {formatDate(entry.updatedAt)}
                  </Typography>
                </Box>
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}

      <AssetEntryDialog
        open={dialogOpen}
        initial={editing}
        assetTypes={assetTypes}
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
            onClick={() => { void removeAssetEntry(deleteTarget!.id); setDeleteTarget(undefined) }}
          >
            {t.common.delete}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AdminPage() {
  const [tab, setTab] = useState(0)

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto' }}>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 2 }}>
        {t.admin.title}
      </Typography>

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v as number)}
        sx={{ mb: 3, borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab label={t.admin.assetTypes} />
        <Tab label={t.admin.assetRegistry} />
      </Tabs>

      {tab === 0 && <AssetTypesTab />}
      {tab === 1 && <AssetRegistryTab />}
    </Box>
  )
}
