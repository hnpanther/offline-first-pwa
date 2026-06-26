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
  Stack,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  List,
  ListItem,
  ListItemText,
  Radio,
  RadioGroup,
  FormLabel
} from '@mui/material'
import Autocomplete from '@mui/material/Autocomplete'
import AddIcon from '@mui/icons-material/Add'
import EditIcon from '@mui/icons-material/Edit'
import DeleteIcon from '@mui/icons-material/Delete'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import LocationOnIcon from '@mui/icons-material/LocationOn'
import SettingsIcon from '@mui/icons-material/Settings'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import LabelIcon from '@mui/icons-material/Label'
import AssignmentIcon from '@mui/icons-material/Assignment'
import SearchIcon from '@mui/icons-material/Search'
import { useState, useEffect } from 'react'
import { useAssetClasses, useAssetEntries } from '@/hooks/useAssets'
import { useLocations, usePlantSystems, useMainFunctions, useSubFunctions } from '@/hooks/useHierarchy'
import { useLogSheetTemplates } from '@/hooks/useLogSheets'
import { getAssetsInScope } from '@/services/storage'
import { t } from '@/i18n'
import type {
  AssetClass,
  AssetEntry,
  FormField,
  FormFieldType,
  Location,
  PlantSystem,
  MainFunction,
  SubFunction,
  LogSheetTemplate
} from '@/types'

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
// Asset Class dialog (was AssetTypeDialog)
// ---------------------------------------------------------------------------

interface AssetClassDialogProps {
  open: boolean
  initial?: AssetClass
  onSave: (data: { name: string; fields: FormField[] }) => Promise<void>
  onClose: () => void
}

function AssetClassDialog({ open, initial, onSave, onClose }: AssetClassDialogProps) {
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
                پارامترها ({fields.length} {t.admin.fieldsCount})
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
              <Typography variant="body2" color="text.secondary">هیچ پارامتری تعریف نشده</Typography>
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
// Asset Classes tab (was AssetTypesTab)
// ---------------------------------------------------------------------------

function AssetClassesTab() {
  const { assetClasses, addAssetClass, editAssetClass, removeAssetClass } = useAssetClasses()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AssetClass | undefined>()
  const [deleteTarget, setDeleteTarget] = useState<AssetClass | undefined>()

  const handleSave = async (data: { name: string; fields: FormField[] }) => {
    if (editing) {
      await editAssetClass(editing.id, data)
    } else {
      await addAssetClass(data)
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

      {assetClasses.length === 0 ? (
        <Alert severity="info">{t.admin.noAssetTypes}</Alert>
      ) : (
        <Stack spacing={1.5}>
          {assetClasses.map(cls => (
            <Card
              key={cls.id}
              variant="outlined"
              sx={{ borderRight: '4px solid', borderRightColor: 'primary.main' }}
            >
              <CardContent sx={{ pb: '8px !important' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                  <Typography variant="subtitle1" fontWeight={700} sx={{ flex: 1 }}>
                    {cls.name}
                  </Typography>
                  <Chip
                    label={`${cls.fields.length} ${t.admin.fieldsCount}`}
                    size="small"
                    color="primary"
                    variant="outlined"
                  />
                  <Tooltip title={t.common.edit}>
                    <IconButton size="small" onClick={() => { setEditing(cls); setDialogOpen(true) }}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={t.common.delete}>
                    <IconButton size="small" color="error" onClick={() => setDeleteTarget(cls)}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>

                {cls.fields.length > 0 && (
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
                    {cls.fields.map(f => (
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

                <Divider sx={{ my: 0.75 }} />
                <Box sx={{ display: 'flex', gap: 3 }}>
                  <Typography variant="caption" color="text.disabled">
                    ثبت: {formatDate(cls.createdAt)}
                  </Typography>
                  <Typography variant="caption" color="text.disabled">
                    ویرایش: {formatDate(cls.updatedAt)}
                  </Typography>
                </Box>
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}

      <AssetClassDialog
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
            onClick={() => { void removeAssetClass(deleteTarget!.id); setDeleteTarget(undefined) }}
          >
            {t.common.delete}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

// ---------------------------------------------------------------------------
// Asset Entry dialog (with SubFunction and AssetClass selectors — Autocomplete)
// ---------------------------------------------------------------------------

interface AssetEntryDialogProps {
  open: boolean
  initial?: AssetEntry
  assetClasses: AssetClass[]
  subFunctions: SubFunction[]
  onSave: (data: Omit<AssetEntry, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  onClose: () => void
}

function AssetEntryDialog({ open, initial, assetClasses, subFunctions, onSave, onClose }: AssetEntryDialogProps) {
  const [tagId, setTagId] = useState(initial?.nfcTagId ?? '')
  const [assetName, setAssetName] = useState(initial?.assetName ?? '')
  const [classId, setClassId] = useState(initial?.classId ?? '')
  const [location, setLocation] = useState(initial?.location ?? '')
  const [subFunctionId, setSubFunctionId] = useState(initial?.subFunctionId ?? '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    setTagId(initial?.nfcTagId ?? '')
    setAssetName(initial?.assetName ?? '')
    setClassId(initial?.classId ?? '')
    setLocation(initial?.location ?? '')
    setSubFunctionId(initial?.subFunctionId ?? '')
    setSaveError(null)
  }, [open, initial])

  const canSave = tagId.trim() !== '' && assetName.trim() !== '' && classId !== '' && subFunctionId !== ''

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setSaveError(null)
    try {
      await onSave({
        nfcTagId: tagId.trim(),
        assetName: assetName.trim(),
        classId,
        subFunctionId,
        location: location.trim() || undefined
      })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'خطا در ذخیره اطلاعات')
    } finally {
      setSaving(false)
    }
  }

  const selectedClass = assetClasses.find(c => c.id === classId) ?? null
  const selectedSf = subFunctions.find(sf => sf.id === subFunctionId) ?? null

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
          helperText={!initial ? 'از کد SubFunction پر می‌شود — قابل ویرایش' : t.admin.tagIdHelper}
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

        <Autocomplete
          options={assetClasses}
          getOptionLabel={c => c.name}
          value={selectedClass}
          onChange={(_, v) => setClassId(v?.id ?? '')}
          disabled={saving}
          renderInput={(params) => (
            <TextField {...params} label={t.admin.classId} />
          )}
          noOptionsText="موردی یافت نشد"
          clearText="پاک کردن"
        />

        <Autocomplete
          options={subFunctions}
          getOptionLabel={sf => `[${sf.code}] ${sf.name} — Tag: ${sf.tag}`}
          value={selectedSf}
          onChange={(_, v) => {
            setSubFunctionId(v?.id ?? '')
            // Auto-fill NFC tag ID from SubFunction code (only when creating, not editing)
            if (!initial) setTagId(v?.code ?? '')
          }}
          disabled={saving}
          renderInput={(params) => (
            <TextField {...params} label={t.admin.subFunctionId} required />
          )}
          noOptionsText="موردی یافت نشد"
          clearText="پاک کردن"
        />

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
  const { assetClasses } = useAssetClasses()
  const { assetEntries, addAssetEntry, editAssetEntry, removeAssetEntry } = useAssetEntries()
  const { subFunctions } = useSubFunctions()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AssetEntry | undefined>()
  const [deleteTarget, setDeleteTarget] = useState<AssetEntry | undefined>()

  const findClassName = (id: string) => assetClasses.find(c => c.id === id)?.name ?? t.common.unknown
  const findSubFunction = (id: string) => subFunctions.find(sf => sf.id === id)

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
          disabled={assetClasses.length === 0 || subFunctions.length === 0}
        >
          {t.admin.addAssetEntry}
        </Button>
      </Box>

      {assetClasses.length === 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          ابتدا یک کلاس در تب «کلاس‌ها» تعریف کنید.
        </Alert>
      )}
      {subFunctions.length === 0 && assetClasses.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          ابتدا یک SubFunction در ساختار سلسله‌مراتبی تعریف کنید.
        </Alert>
      )}

      {assetEntries.length === 0 ? (
        <Alert severity="info">{t.admin.noAssetEntries}</Alert>
      ) : (
        <Stack spacing={1.5}>
          {assetEntries.map(entry => {
            const sf = findSubFunction(entry.subFunctionId)
            return (
              <Card
                key={entry.id}
                variant="outlined"
                sx={{ borderRight: '4px solid', borderRightColor: 'secondary.main' }}
              >
                <CardContent sx={{ pb: '8px !important' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
                    <Typography variant="subtitle1" fontWeight={700} sx={{ flex: 1 }}>
                      {entry.assetName}
                    </Typography>
                    <Chip
                      label={findClassName(entry.classId)}
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

                  {sf && (
                    <Box sx={{ mb: 0.75 }}>
                      <Chip
                        size="small"
                        label={`${t.hierarchy.subFunction}: [${sf.code}] ${sf.name} — Tag: ${sf.tag}`}
                        variant="outlined"
                        color="secondary"
                        sx={{ fontSize: '0.72rem' }}
                      />
                    </Box>
                  )}

                  <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 0.5 }}>
                    {entry.location && (
                      <Typography variant="body2" color="text.secondary">
                        مکان: {entry.location}
                      </Typography>
                    )}
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ direction: 'ltr', fontFamily: 'monospace' }}
                    >
                      NFC: {entry.nfcTagId}
                    </Typography>
                  </Box>

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
            )
          })}
        </Stack>
      )}

      <AssetEntryDialog
        open={dialogOpen}
        initial={editing}
        assetClasses={assetClasses}
        subFunctions={subFunctions}
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
// Hierarchy — Location dialog
// ---------------------------------------------------------------------------

interface LocationDialogProps {
  open: boolean
  initial?: Location
  locations: Location[]
  onSave: (data: Omit<Location, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  onClose: () => void
}

function LocationDialog({ open, initial, locations, onSave, onClose }: LocationDialogProps) {
  const [code, setCode] = useState(initial?.code ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [parentId, setParentId] = useState(initial?.parentId ?? '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    setCode(initial?.code ?? '')
    setName(initial?.name ?? '')
    setParentId(initial?.parentId ?? '')
    setSaveError(null)
  }, [open, initial])

  const canSave = code.trim() !== '' && name.trim() !== ''

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setSaveError(null)
    try {
      await onSave({ code: code.trim(), name: name.trim(), parentId: parentId || undefined })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'خطا در ذخیره اطلاعات')
    } finally {
      setSaving(false)
    }
  }

  const otherLocations = locations.filter(l => l.id !== initial?.id)
  const selectedParent = otherLocations.find(l => l.id === parentId) ?? null

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} dir="rtl" fullWidth maxWidth="xs">
      <DialogTitle>{initial ? 'ویرایش مکان' : t.hierarchy.addLocation}</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 3 }}>
        <TextField
          label={t.hierarchy.code}
          value={code}
          onChange={e => setCode(e.target.value)}
          fullWidth
          autoFocus={!initial}
          dir="ltr"
        />
        <TextField
          label={t.hierarchy.location}
          value={name}
          onChange={e => setName(e.target.value)}
          fullWidth
        />
        <Autocomplete
          options={otherLocations}
          getOptionLabel={l => `[${l.code}] ${l.name}`}
          value={selectedParent}
          onChange={(_, v) => setParentId(v?.id ?? '')}
          renderInput={(params) => (
            <TextField {...params} label={t.hierarchy.parent} />
          )}
          noOptionsText="موردی یافت نشد"
          clearText="پاک کردن"
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
// Hierarchy — PlantSystem dialog
// ---------------------------------------------------------------------------

interface PlantSystemDialogProps {
  open: boolean
  initial?: PlantSystem
  locations: Location[]
  onSave: (data: Omit<PlantSystem, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  onClose: () => void
}

function PlantSystemDialog({ open, initial, locations, onSave, onClose }: PlantSystemDialogProps) {
  const [code, setCode] = useState(initial?.code ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [locationId, setLocationId] = useState(initial?.locationId ?? '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    setCode(initial?.code ?? '')
    setName(initial?.name ?? '')
    setLocationId(initial?.locationId ?? '')
    setSaveError(null)
  }, [open, initial])

  const canSave = code.trim() !== '' && name.trim() !== '' && locationId !== ''

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setSaveError(null)
    try {
      await onSave({ code: code.trim(), name: name.trim(), locationId })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'خطا در ذخیره اطلاعات')
    } finally {
      setSaving(false)
    }
  }

  const selectedLocation = locations.find(l => l.id === locationId) ?? null

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} dir="rtl" fullWidth maxWidth="xs">
      <DialogTitle>{initial ? 'ویرایش سیستم' : t.hierarchy.addSystem}</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 3 }}>
        <TextField
          label={t.hierarchy.code}
          value={code}
          onChange={e => setCode(e.target.value)}
          fullWidth
          autoFocus={!initial}
          dir="ltr"
        />
        <TextField
          label={t.hierarchy.system}
          value={name}
          onChange={e => setName(e.target.value)}
          fullWidth
        />
        <Autocomplete
          options={locations}
          getOptionLabel={l => `[${l.code}] ${l.name}`}
          value={selectedLocation}
          onChange={(_, v) => setLocationId(v?.id ?? '')}
          renderInput={(params) => (
            <TextField {...params} label={t.hierarchy.parentLocation} required />
          )}
          noOptionsText="موردی یافت نشد"
          clearText="پاک کردن"
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
// Hierarchy — MainFunction dialog
// ---------------------------------------------------------------------------

type MainFunctionParentType = 'system' | 'location'

interface MainFunctionDialogProps {
  open: boolean
  initial?: MainFunction
  locations: Location[]
  systems: PlantSystem[]
  onSave: (data: Omit<MainFunction, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  onClose: () => void
}

function MainFunctionDialog({ open, initial, locations, systems, onSave, onClose }: MainFunctionDialogProps) {
  const [code, setCode] = useState(initial?.code ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [parentType, setParentType] = useState<MainFunctionParentType>(
    initial?.systemId ? 'system' : 'location'
  )
  const [systemId, setSystemId] = useState(initial?.systemId ?? '')
  const [locationId, setLocationId] = useState(initial?.locationId ?? '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    setCode(initial?.code ?? '')
    setName(initial?.name ?? '')
    setParentType(initial?.systemId ? 'system' : 'location')
    setSystemId(initial?.systemId ?? '')
    setLocationId(initial?.locationId ?? '')
    setSaveError(null)
  }, [open, initial])

  const parentSelected = parentType === 'system' ? systemId !== '' : locationId !== ''
  const canSave = code.trim() !== '' && name.trim() !== '' && parentSelected

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setSaveError(null)
    try {
      await onSave({
        code: code.trim(),
        name: name.trim(),
        systemId: parentType === 'system' ? systemId : undefined,
        locationId: parentType === 'location' ? locationId : undefined
      })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'خطا در ذخیره اطلاعات')
    } finally {
      setSaving(false)
    }
  }

  const selectedSystem = systems.find(s => s.id === systemId) ?? null
  const selectedLocation = locations.find(l => l.id === locationId) ?? null

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} dir="rtl" fullWidth maxWidth="xs">
      <DialogTitle>{initial ? 'ویرایش فانکشن اصلی' : t.hierarchy.addMainFunction}</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 3 }}>
        <TextField
          label={t.hierarchy.code}
          value={code}
          onChange={e => setCode(e.target.value)}
          fullWidth
          autoFocus={!initial}
          dir="ltr"
        />
        <TextField
          label={t.hierarchy.mainFunction}
          value={name}
          onChange={e => setName(e.target.value)}
          fullWidth
        />
        <Box>
          <FormLabel component="legend" sx={{ mb: 1, fontSize: '0.85rem' }}>نوع والد</FormLabel>
          <RadioGroup
            row
            value={parentType}
            onChange={e => setParentType(e.target.value as MainFunctionParentType)}
          >
            <FormControlLabel value="system" control={<Radio size="small" />} label={t.hierarchy.system} />
            <FormControlLabel value="location" control={<Radio size="small" />} label={t.hierarchy.location} />
          </RadioGroup>
        </Box>
        {parentType === 'system' ? (
          <Autocomplete
            options={systems}
            getOptionLabel={s => `[${s.code}] ${s.name}`}
            value={selectedSystem}
            onChange={(_, v) => setSystemId(v?.id ?? '')}
            renderInput={(params) => (
              <TextField {...params} label={t.hierarchy.parentSystem} required />
            )}
            noOptionsText="موردی یافت نشد"
            clearText="پاک کردن"
          />
        ) : (
          <Autocomplete
            options={locations}
            getOptionLabel={l => `[${l.code}] ${l.name}`}
            value={selectedLocation}
            onChange={(_, v) => setLocationId(v?.id ?? '')}
            renderInput={(params) => (
              <TextField {...params} label={t.hierarchy.parentLocation} required />
            )}
            noOptionsText="موردی یافت نشد"
            clearText="پاک کردن"
          />
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
// Hierarchy — SubFunction dialog (now has 3 fields: code, name, tag)
// ---------------------------------------------------------------------------

type SubFunctionParentType = 'mainFunction' | 'system' | 'location'

interface SubFunctionDialogProps {
  open: boolean
  initial?: SubFunction
  locations: Location[]
  systems: PlantSystem[]
  mainFunctions: MainFunction[]
  onSave: (data: Omit<SubFunction, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  onClose: () => void
}

function SubFunctionDialog({ open, initial, locations, systems, mainFunctions, onSave, onClose }: SubFunctionDialogProps) {
  const [code, setCode] = useState(initial?.code ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [tag, setTag] = useState(initial?.tag ?? '')
  const [parentType, setParentType] = useState<SubFunctionParentType>(
    initial?.mainFunctionId ? 'mainFunction' : initial?.systemId ? 'system' : 'location'
  )
  const [mainFunctionId, setMainFunctionId] = useState(initial?.mainFunctionId ?? '')
  const [systemId, setSystemId] = useState(initial?.systemId ?? '')
  const [locationId, setLocationId] = useState(initial?.locationId ?? '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    setCode(initial?.code ?? '')
    setName(initial?.name ?? '')
    setTag(initial?.tag ?? '')
    setParentType(initial?.mainFunctionId ? 'mainFunction' : initial?.systemId ? 'system' : 'location')
    setMainFunctionId(initial?.mainFunctionId ?? '')
    setSystemId(initial?.systemId ?? '')
    setLocationId(initial?.locationId ?? '')
    setSaveError(null)
  }, [open, initial])

  const parentSelected =
    parentType === 'mainFunction' ? mainFunctionId !== '' :
    parentType === 'system' ? systemId !== '' :
    locationId !== ''

  const canSave = code.trim() !== '' && name.trim() !== '' && tag.trim() !== '' && parentSelected

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setSaveError(null)
    try {
      await onSave({
        code: code.trim(),
        name: name.trim(),
        tag: tag.trim(),
        mainFunctionId: parentType === 'mainFunction' ? mainFunctionId : undefined,
        systemId: parentType === 'system' ? systemId : undefined,
        locationId: parentType === 'location' ? locationId : undefined
      })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'خطا در ذخیره اطلاعات')
    } finally {
      setSaving(false)
    }
  }

  const selectedMainFunction = mainFunctions.find(mf => mf.id === mainFunctionId) ?? null
  const selectedSystem = systems.find(s => s.id === systemId) ?? null
  const selectedLocation = locations.find(l => l.id === locationId) ?? null

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} dir="rtl" fullWidth maxWidth="xs">
      <DialogTitle>{initial ? `ویرایش ${t.hierarchy.subFunction}` : t.hierarchy.addSubFunction}</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 3 }}>
        <TextField
          label={t.hierarchy.code}
          value={code}
          onChange={e => setCode(e.target.value)}
          fullWidth
          autoFocus={!initial}
          dir="ltr"
          helperText="کد فانکشنال — مثال: SF-001"
        />
        <TextField
          label={t.hierarchy.subFunction}
          value={name}
          onChange={e => setName(e.target.value)}
          fullWidth
          helperText="عنوان توصیفی"
        />
        <TextField
          label={t.hierarchy.tagNumber}
          value={tag}
          onChange={e => setTag(e.target.value)}
          fullWidth
          dir="ltr"
          helperText="شماره تگ فیزیکی — باید منحصربه‌فرد باشد"
        />
        <Box>
          <FormLabel component="legend" sx={{ mb: 1, fontSize: '0.85rem' }}>نوع والد</FormLabel>
          <RadioGroup
            row
            value={parentType}
            onChange={e => setParentType(e.target.value as SubFunctionParentType)}
          >
            <FormControlLabel value="mainFunction" control={<Radio size="small" />} label={t.hierarchy.mainFunction} />
            <FormControlLabel value="system" control={<Radio size="small" />} label={t.hierarchy.system} />
            <FormControlLabel value="location" control={<Radio size="small" />} label={t.hierarchy.location} />
          </RadioGroup>
        </Box>
        {parentType === 'mainFunction' && (
          <Autocomplete
            options={mainFunctions}
            getOptionLabel={mf => `[${mf.code}] ${mf.name}`}
            value={selectedMainFunction}
            onChange={(_, v) => setMainFunctionId(v?.id ?? '')}
            renderInput={(params) => (
              <TextField {...params} label={t.hierarchy.parentMainFunction} required />
            )}
            noOptionsText="موردی یافت نشد"
            clearText="پاک کردن"
          />
        )}
        {parentType === 'system' && (
          <Autocomplete
            options={systems}
            getOptionLabel={s => `[${s.code}] ${s.name}`}
            value={selectedSystem}
            onChange={(_, v) => setSystemId(v?.id ?? '')}
            renderInput={(params) => (
              <TextField {...params} label={t.hierarchy.parentSystem} required />
            )}
            noOptionsText="موردی یافت نشد"
            clearText="پاک کردن"
          />
        )}
        {parentType === 'location' && (
          <Autocomplete
            options={locations}
            getOptionLabel={l => `[${l.code}] ${l.name}`}
            value={selectedLocation}
            onChange={(_, v) => setLocationId(v?.id ?? '')}
            renderInput={(params) => (
              <TextField {...params} label={t.hierarchy.parentLocation} required />
            )}
            noOptionsText="موردی یافت نشد"
            clearText="پاک کردن"
          />
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
// Hierarchy tab — Accordion structure with search/filter
// ---------------------------------------------------------------------------

function HierarchyTab() {
  const { locations, addLocation, editLocation, removeLocation } = useLocations()
  const { systems, addSystem, editSystem, removeSystem } = usePlantSystems()
  const { mainFunctions, addMainFunction, editMainFunction, removeMainFunction } = useMainFunctions()
  const { subFunctions, addSubFunction, editSubFunction, removeSubFunction } = useSubFunctions()

  // Search state for each accordion section
  const [locSearch, setLocSearch] = useState('')
  const [sysSearch, setSysSearch] = useState('')
  const [mfSearch, setMfSearch] = useState('')
  const [sfSearch, setSfSearch] = useState('')

  // Location panel state
  const [locDialog, setLocDialog] = useState(false)
  const [editingLoc, setEditingLoc] = useState<Location | undefined>()
  const [deleteLocTarget, setDeleteLocTarget] = useState<Location | undefined>()

  // System panel state
  const [sysDialog, setSysDialog] = useState(false)
  const [editingSys, setEditingSys] = useState<PlantSystem | undefined>()
  const [deleteSysTarget, setDeleteSysTarget] = useState<PlantSystem | undefined>()

  // Main function panel state
  const [mfDialog, setMfDialog] = useState(false)
  const [editingMf, setEditingMf] = useState<MainFunction | undefined>()
  const [deleteMfTarget, setDeleteMfTarget] = useState<MainFunction | undefined>()

  // Sub function panel state
  const [sfDialog, setSfDialog] = useState(false)
  const [editingSf, setEditingSf] = useState<SubFunction | undefined>()
  const [deleteSfTarget, setDeleteSfTarget] = useState<SubFunction | undefined>()

  // Filtered lists
  const filteredLocations = locations.filter(loc =>
    loc.code.toLowerCase().includes(locSearch.toLowerCase()) ||
    loc.name.toLowerCase().includes(locSearch.toLowerCase())
  )
  const filteredSystems = systems.filter(sys =>
    sys.code.toLowerCase().includes(sysSearch.toLowerCase()) ||
    sys.name.toLowerCase().includes(sysSearch.toLowerCase())
  )
  const filteredMainFunctions = mainFunctions.filter(mf =>
    mf.code.toLowerCase().includes(mfSearch.toLowerCase()) ||
    mf.name.toLowerCase().includes(mfSearch.toLowerCase())
  )
  const filteredSubFunctions = subFunctions.filter(sf =>
    sf.code.toLowerCase().includes(sfSearch.toLowerCase()) ||
    sf.name.toLowerCase().includes(sfSearch.toLowerCase()) ||
    sf.tag.toLowerCase().includes(sfSearch.toLowerCase())
  )

  // Helpers to resolve parent names
  const resolveLocParent = (loc: Location) => {
    if (!loc.parentId) return null
    return locations.find(l => l.id === loc.parentId)?.name ?? null
  }
  const resolveSysLoc = (sys: PlantSystem) =>
    locations.find(l => l.id === sys.locationId)?.name ?? t.common.unknown
  const resolveMfParent = (mf: MainFunction) => {
    if (mf.systemId) return systems.find(s => s.id === mf.systemId)?.name ?? t.common.unknown
    if (mf.locationId) return locations.find(l => l.id === mf.locationId)?.name ?? t.common.unknown
    return t.common.unknown
  }
  const resolveSfParent = (sf: SubFunction) => {
    if (sf.mainFunctionId) return mainFunctions.find(mf => mf.id === sf.mainFunctionId)?.name ?? t.common.unknown
    if (sf.systemId) return systems.find(s => s.id === sf.systemId)?.name ?? t.common.unknown
    if (sf.locationId) return locations.find(l => l.id === sf.locationId)?.name ?? t.common.unknown
    return t.common.unknown
  }

  return (
    <Box>
      {/* ---------- Locations ---------- */}
      <Accordion defaultExpanded>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1 }}>
            <LocationOnIcon color="primary" fontSize="small" />
            <Typography fontWeight={600}>{t.hierarchy.locations}</Typography>
            <Chip size="small" label={locations.length} sx={{ ml: 0.5 }} />
          </Box>
          <Button
            size="small"
            startIcon={<AddIcon />}
            onClick={e => { e.stopPropagation(); setEditingLoc(undefined); setLocDialog(true) }}
            sx={{ mr: 1 }}
          >
            {t.hierarchy.addLocation}
          </Button>
        </AccordionSummary>
        <AccordionDetails sx={{ pt: 0 }}>
          <TextField
            size="small"
            placeholder="جستجو..."
            value={locSearch}
            onChange={e => setLocSearch(e.target.value)}
            fullWidth
            sx={{ mb: 1 }}
            InputProps={{
              startAdornment: <SearchIcon fontSize="small" sx={{ ml: 0.5, color: 'text.disabled', mr: 0.5 }} />
            }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
            {filteredLocations.length} مورد{locSearch ? ` از ${locations.length}` : ''}
          </Typography>
          {locations.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>{t.hierarchy.noLocations}</Typography>
          ) : filteredLocations.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>موردی یافت نشد</Typography>
          ) : (
            <List dense disablePadding>
              {filteredLocations.map(loc => {
                const parentName = resolveLocParent(loc)
                return (
                  <ListItem
                    key={loc.id}
                    disableGutters
                    sx={{ borderBottom: '1px solid', borderColor: 'divider', '&:last-child': { borderBottom: 0 } }}
                    secondaryAction={
                      <Box sx={{ display: 'flex', gap: 0.5 }}>
                        <IconButton size="small" onClick={() => { setEditingLoc(loc); setLocDialog(true) }}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                        <IconButton size="small" color="error" onClick={() => setDeleteLocTarget(loc)}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Box>
                    }
                  >
                    <ListItemText
                      primary={
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Chip size="small" label={loc.code} variant="outlined" sx={{ fontFamily: 'monospace' }} />
                          <Typography variant="body2" fontWeight={500}>{loc.name}</Typography>
                        </Box>
                      }
                      secondary={parentName ? `زیر: ${parentName}` : undefined}
                    />
                  </ListItem>
                )
              })}
            </List>
          )}
        </AccordionDetails>
      </Accordion>

      {/* ---------- Systems ---------- */}
      <Accordion>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1 }}>
            <SettingsIcon color="secondary" fontSize="small" />
            <Typography fontWeight={600}>{t.hierarchy.systems}</Typography>
            <Chip size="small" label={systems.length} sx={{ ml: 0.5 }} />
          </Box>
          <Button
            size="small"
            startIcon={<AddIcon />}
            onClick={e => { e.stopPropagation(); setEditingSys(undefined); setSysDialog(true) }}
            sx={{ mr: 1 }}
            disabled={locations.length === 0}
          >
            {t.hierarchy.addSystem}
          </Button>
        </AccordionSummary>
        <AccordionDetails sx={{ pt: 0 }}>
          {locations.length === 0 && (
            <Alert severity="info" sx={{ mb: 1 }}>ابتدا یک مکان تعریف کنید.</Alert>
          )}
          <TextField
            size="small"
            placeholder="جستجو..."
            value={sysSearch}
            onChange={e => setSysSearch(e.target.value)}
            fullWidth
            sx={{ mb: 1 }}
            InputProps={{
              startAdornment: <SearchIcon fontSize="small" sx={{ ml: 0.5, color: 'text.disabled', mr: 0.5 }} />
            }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
            {filteredSystems.length} مورد{sysSearch ? ` از ${systems.length}` : ''}
          </Typography>
          {systems.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>{t.hierarchy.noSystems}</Typography>
          ) : filteredSystems.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>موردی یافت نشد</Typography>
          ) : (
            <List dense disablePadding>
              {filteredSystems.map(sys => (
                <ListItem
                  key={sys.id}
                  disableGutters
                  sx={{ borderBottom: '1px solid', borderColor: 'divider', '&:last-child': { borderBottom: 0 } }}
                  secondaryAction={
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      <IconButton size="small" onClick={() => { setEditingSys(sys); setSysDialog(true) }}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" color="error" onClick={() => setDeleteSysTarget(sys)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Box>
                  }
                >
                  <ListItemText
                    primary={
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Chip size="small" label={sys.code} variant="outlined" sx={{ fontFamily: 'monospace' }} />
                        <Typography variant="body2" fontWeight={500}>{sys.name}</Typography>
                      </Box>
                    }
                    secondary={`مکان: ${resolveSysLoc(sys)}`}
                  />
                </ListItem>
              ))}
            </List>
          )}
        </AccordionDetails>
      </Accordion>

      {/* ---------- Main Functions ---------- */}
      <Accordion>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1 }}>
            <AccountTreeIcon color="action" fontSize="small" />
            <Typography fontWeight={600}>{t.hierarchy.mainFunctions}</Typography>
            <Chip size="small" label={mainFunctions.length} sx={{ ml: 0.5 }} />
          </Box>
          <Button
            size="small"
            startIcon={<AddIcon />}
            onClick={e => { e.stopPropagation(); setEditingMf(undefined); setMfDialog(true) }}
            sx={{ mr: 1 }}
            disabled={systems.length === 0 && locations.length === 0}
          >
            {t.hierarchy.addMainFunction}
          </Button>
        </AccordionSummary>
        <AccordionDetails sx={{ pt: 0 }}>
          <TextField
            size="small"
            placeholder="جستجو..."
            value={mfSearch}
            onChange={e => setMfSearch(e.target.value)}
            fullWidth
            sx={{ mb: 1 }}
            InputProps={{
              startAdornment: <SearchIcon fontSize="small" sx={{ ml: 0.5, color: 'text.disabled', mr: 0.5 }} />
            }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
            {filteredMainFunctions.length} مورد{mfSearch ? ` از ${mainFunctions.length}` : ''}
          </Typography>
          {mainFunctions.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>{t.hierarchy.noMainFunctions}</Typography>
          ) : filteredMainFunctions.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>موردی یافت نشد</Typography>
          ) : (
            <List dense disablePadding>
              {filteredMainFunctions.map(mf => (
                <ListItem
                  key={mf.id}
                  disableGutters
                  sx={{ borderBottom: '1px solid', borderColor: 'divider', '&:last-child': { borderBottom: 0 } }}
                  secondaryAction={
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      <IconButton size="small" onClick={() => { setEditingMf(mf); setMfDialog(true) }}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" color="error" onClick={() => setDeleteMfTarget(mf)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Box>
                  }
                >
                  <ListItemText
                    primary={
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Chip size="small" label={mf.code} variant="outlined" sx={{ fontFamily: 'monospace' }} />
                        <Typography variant="body2" fontWeight={500}>{mf.name}</Typography>
                      </Box>
                    }
                    secondary={`زیر: ${resolveMfParent(mf)}`}
                  />
                </ListItem>
              ))}
            </List>
          )}
        </AccordionDetails>
      </Accordion>

      {/* ---------- Sub Functions ---------- */}
      <Accordion>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1 }}>
            <LabelIcon color="action" fontSize="small" />
            <Typography fontWeight={600}>{t.hierarchy.subFunctions}</Typography>
            <Chip size="small" label={subFunctions.length} sx={{ ml: 0.5 }} />
          </Box>
          <Button
            size="small"
            startIcon={<AddIcon />}
            onClick={e => { e.stopPropagation(); setEditingSf(undefined); setSfDialog(true) }}
            sx={{ mr: 1 }}
          >
            {t.hierarchy.addSubFunction}
          </Button>
        </AccordionSummary>
        <AccordionDetails sx={{ pt: 0 }}>
          <TextField
            size="small"
            placeholder="جستجو..."
            value={sfSearch}
            onChange={e => setSfSearch(e.target.value)}
            fullWidth
            sx={{ mb: 1 }}
            InputProps={{
              startAdornment: <SearchIcon fontSize="small" sx={{ ml: 0.5, color: 'text.disabled', mr: 0.5 }} />
            }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
            {filteredSubFunctions.length} مورد{sfSearch ? ` از ${subFunctions.length}` : ''}
          </Typography>
          {subFunctions.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>{t.hierarchy.noSubFunctions}</Typography>
          ) : filteredSubFunctions.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>موردی یافت نشد</Typography>
          ) : (
            <List dense disablePadding>
              {filteredSubFunctions.map(sf => (
                <ListItem
                  key={sf.id}
                  disableGutters
                  sx={{ borderBottom: '1px solid', borderColor: 'divider', '&:last-child': { borderBottom: 0 } }}
                  secondaryAction={
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      <IconButton size="small" onClick={() => { setEditingSf(sf); setSfDialog(true) }}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" color="error" onClick={() => setDeleteSfTarget(sf)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Box>
                  }
                >
                  <ListItemText
                    primary={
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                        <Chip size="small" label={sf.code} variant="outlined" sx={{ fontFamily: 'monospace' }} color="primary" />
                        <Typography variant="body2" fontWeight={500}>{sf.name}</Typography>
                        <Typography variant="caption" color="text.secondary">— Tag: {sf.tag}</Typography>
                      </Box>
                    }
                    secondary={`زیر: ${resolveSfParent(sf)}`}
                  />
                </ListItem>
              ))}
            </List>
          )}
        </AccordionDetails>
      </Accordion>

      {/* ---- Dialogs ---- */}
      <LocationDialog
        open={locDialog}
        initial={editingLoc}
        locations={locations}
        onSave={async data => {
          if (editingLoc) await editLocation(editingLoc.id, data)
          else await addLocation(data)
          setLocDialog(false)
          setEditingLoc(undefined)
        }}
        onClose={() => { setLocDialog(false); setEditingLoc(undefined) }}
      />

      <PlantSystemDialog
        open={sysDialog}
        initial={editingSys}
        locations={locations}
        onSave={async data => {
          if (editingSys) await editSystem(editingSys.id, data)
          else await addSystem(data)
          setSysDialog(false)
          setEditingSys(undefined)
        }}
        onClose={() => { setSysDialog(false); setEditingSys(undefined) }}
      />

      <MainFunctionDialog
        open={mfDialog}
        initial={editingMf}
        locations={locations}
        systems={systems}
        onSave={async data => {
          if (editingMf) await editMainFunction(editingMf.id, data)
          else await addMainFunction(data)
          setMfDialog(false)
          setEditingMf(undefined)
        }}
        onClose={() => { setMfDialog(false); setEditingMf(undefined) }}
      />

      <SubFunctionDialog
        open={sfDialog}
        initial={editingSf}
        locations={locations}
        systems={systems}
        mainFunctions={mainFunctions}
        onSave={async data => {
          if (editingSf) await editSubFunction(editingSf.id, data)
          else await addSubFunction(data)
          setSfDialog(false)
          setEditingSf(undefined)
        }}
        onClose={() => { setSfDialog(false); setEditingSf(undefined) }}
      />

      {/* Delete confirm dialogs */}
      <Dialog open={!!deleteLocTarget} onClose={() => setDeleteLocTarget(undefined)} dir="rtl">
        <DialogTitle>{t.common.delete}</DialogTitle>
        <DialogContent><DialogContentText>{t.admin.deleteConfirm}</DialogContentText></DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteLocTarget(undefined)}>{t.common.cancel}</Button>
          <Button color="error" variant="contained" onClick={() => { void removeLocation(deleteLocTarget!.id); setDeleteLocTarget(undefined) }}>
            {t.common.delete}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!deleteSysTarget} onClose={() => setDeleteSysTarget(undefined)} dir="rtl">
        <DialogTitle>{t.common.delete}</DialogTitle>
        <DialogContent><DialogContentText>{t.admin.deleteConfirm}</DialogContentText></DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteSysTarget(undefined)}>{t.common.cancel}</Button>
          <Button color="error" variant="contained" onClick={() => { void removeSystem(deleteSysTarget!.id); setDeleteSysTarget(undefined) }}>
            {t.common.delete}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!deleteMfTarget} onClose={() => setDeleteMfTarget(undefined)} dir="rtl">
        <DialogTitle>{t.common.delete}</DialogTitle>
        <DialogContent><DialogContentText>{t.admin.deleteConfirm}</DialogContentText></DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteMfTarget(undefined)}>{t.common.cancel}</Button>
          <Button color="error" variant="contained" onClick={() => { void removeMainFunction(deleteMfTarget!.id); setDeleteMfTarget(undefined) }}>
            {t.common.delete}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!deleteSfTarget} onClose={() => setDeleteSfTarget(undefined)} dir="rtl">
        <DialogTitle>{t.common.delete}</DialogTitle>
        <DialogContent><DialogContentText>{t.admin.deleteConfirm}</DialogContentText></DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteSfTarget(undefined)}>{t.common.cancel}</Button>
          <Button color="error" variant="contained" onClick={() => { void removeSubFunction(deleteSfTarget!.id); setDeleteSfTarget(undefined) }}>
            {t.common.delete}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Log Sheet Template dialog
// ---------------------------------------------------------------------------

interface LogSheetTemplateDialogProps {
  open: boolean
  initial?: LogSheetTemplate
  locations: Location[]
  systems: PlantSystem[]
  mainFunctions: MainFunction[]
  onSave: (data: Omit<LogSheetTemplate, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  onClose: () => void
}

function LogSheetTemplateDialog({
  open, initial, locations, systems, mainFunctions, onSave, onClose
}: LogSheetTemplateDialogProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [scopeType, setScopeType] = useState<'location' | 'system' | 'mainFunction'>(
    initial?.scopeType ?? 'location'
  )
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

  // When scopeType changes, reset scopeId
  const handleScopeTypeChange = (newType: 'location' | 'system' | 'mainFunction') => {
    setScopeType(newType)
    setScopeId('')
    setAssetCount(null)
  }

  // When scopeId changes, load asset count
  useEffect(() => {
    if (!scopeId) {
      setAssetCount(null)
      return
    }
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
      await onSave({
        name: name.trim(),
        description: description.trim() || undefined,
        scopeType,
        scopeId
      })
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
          renderInput={(params) => (
            <TextField {...params} label={t.logSheet.selectScope} required />
          )}
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
// Log Sheet Templates tab (4th tab)
// ---------------------------------------------------------------------------

function LogSheetTemplatesTab() {
  const { templates, addTemplate, editTemplate, removeTemplate } = useLogSheetTemplates()
  const { locations } = useLocations()
  const { systems } = usePlantSystems()
  const { mainFunctions } = useMainFunctions()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<LogSheetTemplate | undefined>()
  const [deleteTarget, setDeleteTarget] = useState<LogSheetTemplate | undefined>()

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
    <>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => { setEditing(undefined); setDialogOpen(true) }}
        >
          {t.logSheet.addTemplate}
        </Button>
      </Box>

      {templates.length === 0 ? (
        <Alert severity="info">{t.logSheet.noTemplates}</Alert>
      ) : (
        <Stack spacing={1.5}>
          {templates.map(tmpl => (
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
      )}

      <LogSheetTemplateDialog
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
        <Tab label={t.hierarchy.title} />
        <Tab label={t.admin.assetTypes} />
        <Tab label={t.admin.assetRegistry} />
        <Tab label={t.logSheet.templates} icon={<AssignmentIcon fontSize="small" />} iconPosition="start" />
      </Tabs>

      {tab === 0 && <HierarchyTab />}
      {tab === 1 && <AssetClassesTab />}
      {tab === 2 && <AssetRegistryTab />}
      {tab === 3 && <LogSheetTemplatesTab />}
    </Box>
  )
}
