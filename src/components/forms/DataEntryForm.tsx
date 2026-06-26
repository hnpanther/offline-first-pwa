import {
  Box,
  Button,
  Card,
  CardContent,
  Typography,
  Alert,
  CircularProgress,
  Divider,
  Chip
} from '@mui/material'
import SaveIcon from '@mui/icons-material/Save'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import LocationOnIcon from '@mui/icons-material/LocationOn'
import { useForm } from 'react-hook-form'
import { useState } from 'react'
import { DynamicFormField } from './DynamicFormField'
import { useRecords } from '@/hooks/useRecords'
import { useSettings } from '@/hooks/useSettings'
import { t } from '@/i18n'
import type { AssetClass, AssetEntry } from '@/types'

interface DataEntryFormProps {
  nfcTagId: string
  assetEntry: AssetEntry
  assetClass: AssetClass
  onSuccess?: (mode: 'draft' | 'approved') => void
  onCancel?: () => void
}

export function DataEntryForm({ nfcTagId, assetEntry, assetClass, onSuccess, onCancel }: DataEntryFormProps) {
  const { addRecord } = useRecords()
  const { settings } = useSettings()
  const [saving, setSaving] = useState<'draft' | 'approved' | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const { control, handleSubmit, formState: { errors }, reset } = useForm()

  const submit = async (data: Record<string, unknown>, mode: 'draft' | 'approved') => {
    setSaving(mode)
    setSaveError(null)
    try {
      await addRecord({
        nfcTagId,
        assetEntryId: assetEntry.id,
        assetName: assetEntry.assetName,
        assetTypeId: assetClass.id,   // stored in legacy field for DataRecord
        recordStatus: mode,
        formData: data,
        operatorName: settings.operatorName,
        location: assetEntry.location ?? settings.locationName
      })
      reset()
      setTimeout(() => onSuccess?.(mode), 800)
    } catch {
      setSaveError(t.form.error)
    } finally {
      setSaving(null)
    }
  }

  const onSaveDraft = handleSubmit(data => submit(data as Record<string, unknown>, 'draft'))
  const onApprove = handleSubmit(data => submit(data as Record<string, unknown>, 'approved'))

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Asset info header */}
      <Card variant="outlined">
        <CardContent sx={{ pb: '12px !important' }}>
          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
            {t.collect.assetInfo}
          </Typography>
          <Typography variant="h6" fontWeight={700}>{assetEntry.assetName}</Typography>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 0.5 }}>
            <Chip
              label={`${t.collect.assetType}: ${assetClass.name}`}
              size="small"
              color="primary"
              variant="outlined"
            />
            {assetEntry.location && (
              <Chip
                icon={<LocationOnIcon />}
                label={assetEntry.location}
                size="small"
                variant="outlined"
              />
            )}
            <Chip label={`تگ: ${nfcTagId}`} size="small" variant="outlined" sx={{ fontFamily: 'monospace', direction: 'ltr' }} />
          </Box>
        </CardContent>
      </Card>

      {/* Dynamic fields */}
      <Card>
        <CardContent>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>
            {assetClass.name}
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            {assetClass.fields.map(field => (
              <DynamicFormField
                key={field.name}
                field={field}
                control={control}
                error={errors[field.name]?.message as string | undefined}
              />
            ))}
          </Box>
        </CardContent>
      </Card>

      {/* Operator info */}
      {settings.operatorName && (
        <Card variant="outlined">
          <CardContent sx={{ pb: '12px !important' }}>
            <Typography variant="caption" color="text.secondary">
              اپراتور: <strong>{settings.operatorName}</strong>
              {(assetEntry.location ?? settings.locationName) && (
                <> &nbsp;—&nbsp; محل: <strong>{assetEntry.location ?? settings.locationName}</strong></>
              )}
            </Typography>
          </CardContent>
        </Card>
      )}

      {saveError && <Alert severity="error">{saveError}</Alert>}

      <Divider />

      {/* Action buttons */}
      <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {onCancel && (
          <Button variant="text" onClick={onCancel} disabled={!!saving}>
            {t.form.cancel}
          </Button>
        )}
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
      </Box>
    </Box>
  )
}
