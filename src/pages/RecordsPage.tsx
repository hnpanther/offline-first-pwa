import {
  Box,
  Typography,
  Card,
  CardContent,
  Chip,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  CircularProgress,
  Alert,
  Tooltip,
  Tabs,
  Tab,
  Divider
} from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import VisibilityIcon from '@mui/icons-material/Visibility'
import EditIcon from '@mui/icons-material/Edit'
import SaveIcon from '@mui/icons-material/Save'
import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useRecords } from '@/hooks/useRecords'
import { useAssetClasses } from '@/hooks/useAssets'
import { DynamicFormField } from '@/components/forms/DynamicFormField'
import { t } from '@/i18n'
import type { DataRecord, SyncStatus, RecordStatus, FormField, AssetClass } from '@/types'

const formatDate = (ts: number) =>
  new Date(ts).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' })

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

function SyncChip({ status }: { status: SyncStatus }) {
  const map: Record<SyncStatus, { label: string; color: 'success' | 'warning' | 'error' | 'info' }> = {
    synced: { label: t.sync.synced, color: 'success' },
    pending: { label: t.sync.pending, color: 'warning' },
    syncing: { label: t.sync.syncing, color: 'info' },
    failed: { label: t.sync.failed, color: 'error' }
  }
  const { label, color } = map[status]
  return <Chip label={label} color={color} size="small" variant="outlined" />
}

function RecordStatusChip({ status }: { status: RecordStatus }) {
  return status === 'draft'
    ? <Chip label={t.record.draft} color="default" size="small" />
    : <Chip label={t.record.approved} color="success" size="small" icon={<CheckCircleIcon />} />
}

// ---------------------------------------------------------------------------
// Draft edit dialog
// ---------------------------------------------------------------------------

interface DraftEditDialogProps {
  record: DataRecord
  assetClass: AssetClass | undefined
  open: boolean
  onClose: () => void
  editRecord: (localId: string, updates: Partial<DataRecord>) => Promise<void>
  refresh: () => Promise<void>
}

function DraftEditDialog({ record, assetClass, open, onClose, editRecord, refresh }: DraftEditDialogProps) {
  const { control, handleSubmit, formState: { errors }, reset } = useForm({
    defaultValues: (record.formData ?? {}) as Record<string, unknown>
  })
  const [saving, setSaving] = useState<'draft' | 'approved' | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      reset((record.formData ?? {}) as Record<string, unknown>)
      setSaveError(null)
    }
  }, [open, record, reset])

  const submit = async (data: Record<string, unknown>, mode: 'draft' | 'approved') => {
    setSaving(mode)
    setSaveError(null)
    try {
      await editRecord(record.localId, {
        formData: data,
        recordStatus: mode,
        ...(mode === 'approved' ? { syncStatus: 'pending' } : {})
      })
      await refresh()
      onClose()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t.form.error)
    } finally {
      setSaving(null)
    }
  }

  const onSaveDraft = handleSubmit(data => void submit(data as Record<string, unknown>, 'draft'))
  const onApprove = handleSubmit(data => void submit(data as Record<string, unknown>, 'approved'))

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} dir="rtl" fullWidth maxWidth="sm">
      <DialogTitle>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="h6">{record.assetName ?? t.common.unknown}</Typography>
          <Chip label={t.record.draft} size="small" />
        </Box>
      </DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pt: 3 }}>
        {!assetClass ? (
          <Alert severity="warning">تعریف کلاس Asset یافت نشد</Alert>
        ) : assetClass.fields.length === 0 ? (
          <Alert severity="info">این کلاس Asset پارامتری ندارد</Alert>
        ) : (
          assetClass.fields.map(field => (
            <DynamicFormField
              key={field.name}
              field={field}
              control={control}
              error={errors[field.name]?.message as string | undefined}
            />
          ))
        )}
        {saveError && <Alert severity="error">{saveError}</Alert>}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5, gap: 1 }}>
        <Button onClick={onClose} disabled={!!saving}>{t.common.cancel}</Button>
        <Button
          variant="outlined"
          startIcon={saving === 'draft' ? <CircularProgress size={18} /> : <SaveIcon />}
          onClick={() => void onSaveDraft()}
          disabled={!!saving}
        >
          {saving === 'draft' ? t.form.saving : t.record.saveDraft}
        </Button>
        <Button
          variant="contained"
          color="success"
          startIcon={saving === 'approved' ? <CircularProgress size={18} color="inherit" /> : <CheckCircleIcon />}
          onClick={() => void onApprove()}
          disabled={!!saving}
        >
          {saving === 'approved' ? t.form.saving : t.record.approveAndSend}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Detail dialog
// ---------------------------------------------------------------------------

interface DetailDialogProps {
  record: DataRecord
  fields: FormField[]
  open: boolean
  onClose: () => void
  onApprove: () => void
  onDelete: () => void
  onEdit: () => void
}

function RecordDetailDialog({ record, fields, open, onClose, onApprove, onDelete, onEdit }: DetailDialogProps) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmApprove, setConfirmApprove] = useState(false)
  const isDraft = !record.recordStatus || record.recordStatus === 'draft'

  const renderValue = (field: FormField, value: unknown): string => {
    if (value === undefined || value === null || value === '') return '—'
    if (Array.isArray(value)) return value.join('، ')
    if (field.unit) return `${String(value)} ${field.unit}`
    return String(value)
  }

  return (
    <>
      <Dialog open={open} onClose={onClose} dir="rtl" fullWidth maxWidth="sm">
        <DialogTitle>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="h6">{record.assetName ?? t.common.unknown}</Typography>
            <RecordStatusChip status={record.recordStatus ?? 'draft'} />
          </Box>
        </DialogTitle>
        <DialogContent dividers>
          {/* Metadata */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mb: 2 }}>
            <Typography variant="caption" color="text.secondary">
              تگ: <strong style={{ direction: 'ltr', display: 'inline-block' }}>{record.nfcTagId}</strong>
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t.records.createdAt}: <strong>{formatDate(record.createdAt)}</strong>
            </Typography>
            {record.updatedAt !== record.createdAt && (
              <Typography variant="caption" color="text.secondary">
                {t.records.updatedAt}: <strong>{formatDate(record.updatedAt)}</strong>
              </Typography>
            )}
            {record.operatorName && (
              <Typography variant="caption" color="text.secondary">اپراتور: {record.operatorName}</Typography>
            )}
            {record.location && (
              <Typography variant="caption" color="text.secondary">محل: {record.location}</Typography>
            )}
            <Box sx={{ mt: 0.5 }}>
              <SyncChip status={record.syncStatus} />
            </Box>
          </Box>

          <Divider sx={{ mb: 2 }} />

          {/* Field values */}
          <Typography variant="subtitle2" fontWeight={600} gutterBottom>
            {t.record.fieldValues}
          </Typography>
          {fields.length === 0 ? (
            <Typography variant="body2" color="text.secondary">اطلاعاتی ثبت نشده</Typography>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              {fields.map(field => (
                <Box key={field.name} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
                  <Typography variant="body2" color="text.secondary" sx={{ minWidth: 120 }}>
                    {field.label}
                  </Typography>
                  <Typography variant="body2" fontWeight={500}>
                    {renderValue(field, record.formData[field.name])}
                  </Typography>
                </Box>
              ))}
            </Box>
          )}

          {record.syncError && (
            <Alert severity="error" sx={{ mt: 2 }}>خطا: {record.syncError}</Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ gap: 1, px: 3, py: 1.5 }}>
          <Tooltip title={t.records.delete}>
            <IconButton
              color="error"
              size="small"
              onClick={() => setConfirmDelete(true)}
              disabled={record.syncStatus === 'syncing'}
            >
              <DeleteIcon />
            </IconButton>
          </Tooltip>
          <Box sx={{ flex: 1 }} />
          <Button onClick={onClose}>{t.common.close}</Button>
          {isDraft && (
            <Button
              variant="outlined"
              startIcon={<EditIcon />}
              onClick={() => { onClose(); onEdit() }}
            >
              {t.common.edit}
            </Button>
          )}
          {isDraft && (
            <Button
              variant="contained"
              color="success"
              startIcon={<CheckCircleIcon />}
              onClick={() => setConfirmApprove(true)}
            >
              {t.record.approve}
            </Button>
          )}
        </DialogActions>
      </Dialog>

      <Dialog open={confirmApprove} onClose={() => setConfirmApprove(false)} dir="rtl">
        <DialogTitle>{t.record.approve}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t.record.approveConfirm}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmApprove(false)}>{t.common.no}</Button>
          <Button variant="contained" color="success" onClick={() => { setConfirmApprove(false); onApprove(); onClose() }}>
            {t.common.yes}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} dir="rtl">
        <DialogTitle>{t.records.delete}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t.records.deleteConfirm}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(false)}>{t.records.no}</Button>
          <Button color="error" variant="contained" onClick={() => { setConfirmDelete(false); onDelete(); onClose() }}>
            {t.records.yes}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

// ---------------------------------------------------------------------------
// Record card
// ---------------------------------------------------------------------------

function RecordCard({
  record,
  fields,
  assetClass,
  onDelete,
  onApprove,
  editRecord,
  refresh
}: {
  record: DataRecord
  fields: FormField[]
  assetClass: AssetClass | undefined
  onDelete: () => void
  onApprove: () => void
  editRecord: (localId: string, updates: Partial<DataRecord>) => Promise<void>
  refresh: () => Promise<void>
}) {
  const [detailOpen, setDetailOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const isDraft = !record.recordStatus || record.recordStatus === 'draft'
  const wasEdited = record.updatedAt !== record.createdAt

  return (
    <>
      <Card variant="outlined" sx={{ cursor: 'pointer' }} onClick={() => setDetailOpen(true)}>
        <CardContent sx={{ pb: '12px !important' }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 1 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mb: 0.5 }}>
                <Typography variant="subtitle2" fontWeight={600} noWrap>
                  {record.assetName ?? t.common.unknown}
                </Typography>
                <RecordStatusChip status={record.recordStatus ?? 'approved'} />
                {record.recordStatus !== 'draft' && <SyncChip status={record.syncStatus} />}
              </Box>
              <Typography variant="body2" color="text.secondary">
                تگ: <strong>{record.nfcTagId}</strong>
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t.records.createdAt}: {formatDate(record.createdAt)}
              </Typography>
              {wasEdited && (
                <Typography variant="body2" color="text.secondary">
                  {t.records.updatedAt}: {formatDate(record.updatedAt)}
                </Typography>
              )}
              {record.operatorName && (
                <Typography variant="body2" color="text.secondary">اپراتور: {record.operatorName}</Typography>
              )}
            </Box>
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              {isDraft && (
                <Tooltip title={t.common.edit}>
                  <IconButton
                    size="small"
                    onClick={e => { e.stopPropagation(); setEditOpen(true) }}
                  >
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
              <Tooltip title={t.record.viewRecord}>
                <IconButton size="small" onClick={e => { e.stopPropagation(); setDetailOpen(true) }}>
                  <VisibilityIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          </Box>
        </CardContent>
      </Card>

      <RecordDetailDialog
        record={record}
        fields={fields}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        onApprove={onApprove}
        onDelete={onDelete}
        onEdit={() => setEditOpen(true)}
      />

      <DraftEditDialog
        record={record}
        assetClass={assetClass}
        open={editOpen}
        onClose={() => setEditOpen(false)}
        editRecord={editRecord}
        refresh={refresh}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function RecordsPage() {
  const { records, isLoading, refresh, removeRecord, confirmRecord, editRecord } = useRecords()
  const { findAssetClass } = useAssetClasses()
  const [tab, setTab] = useState(0)

  const drafts = records.filter(r => r.recordStatus === 'draft')
  const approved = records.filter(r => r.recordStatus === 'approved' || !r.recordStatus)

  const displayRecords = tab === 0 ? records : tab === 1 ? drafts : approved

  const getFields = (record: DataRecord): FormField[] => {
    // Use assetTypeId (legacy field on DataRecord) to look up the class
    if (!record.assetTypeId) return []
    return findAssetClass(record.assetTypeId)?.fields ?? []
  }

  const emptyMessage =
    tab === 1 ? t.records.emptyDrafts :
    tab === 2 ? t.records.emptyApproved :
    t.records.empty

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    )
  }

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h5" fontWeight={700}>{t.records.title}</Typography>
        <Chip label={records.length} color="primary" size="small" />
      </Box>

      <Tabs value={tab} onChange={(_, v) => setTab(v as number)} sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Tab label={`${t.record.all} (${records.length})`} />
        <Tab label={`${t.record.drafts} (${drafts.length})`} />
        <Tab label={`${t.record.approved_pl} (${approved.length})`} />
      </Tabs>

      {displayRecords.length === 0 ? (
        <Alert severity="info">{emptyMessage}</Alert>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {displayRecords.map(record => (
            <RecordCard
              key={record.localId}
              record={record}
              fields={getFields(record)}
              assetClass={record.assetTypeId ? findAssetClass(record.assetTypeId) : undefined}
              onDelete={() => void removeRecord(record.localId)}
              onApprove={() => void confirmRecord(record.localId)}
              editRecord={editRecord}
              refresh={refresh}
            />
          ))}
        </Box>
      )}
    </Box>
  )
}
