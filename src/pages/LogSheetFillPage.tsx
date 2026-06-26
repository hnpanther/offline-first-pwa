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
  IconButton,
  TextField,
  LinearProgress,
  Snackbar,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Divider
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import NfcIcon from '@mui/icons-material/Nfc'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked'
import SendIcon from '@mui/icons-material/Send'
import SaveIcon from '@mui/icons-material/Save'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import {
  getLogSheet,
  updateLogSheet,
  getAllAssetClasses,
  getAssetEntryByTagId
} from '@/services/storage'
import { DynamicClassForm } from '@/components/forms/DynamicClassForm'
import { useFieldDefinitions } from '@/hooks/useFieldDefinitions'
import { useNFC } from '@/hooks/useNFC'
import type { LogSheet, AssetClass, LogSheetEntryData } from '@/types'

const formatDate = (ts: number) =>
  new Date(ts).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' })

// ---------------------------------------------------------------------------
// Asset fill dialog — single asset, its own form, opened by NFC or tap
// ---------------------------------------------------------------------------

interface AssetFillDialogProps {
  entry: LogSheetEntryData | null
  assetClass: AssetClass | undefined
  open: boolean
  readOnly: boolean
  onClose: () => void
  onSave: (assetId: string, formData: Record<string, unknown>) => Promise<void>
}

function AssetFillDialog({
  entry,
  assetClass,
  open,
  readOnly,
  onClose,
  onSave
}: AssetFillDialogProps) {
  const { fields, loading: fieldsLoading } = useFieldDefinitions(entry?.classId)
  const {
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<Record<string, unknown>>({ defaultValues: {} })

  // Reset form each time a different entry is opened
  const entryId = entry?.assetId
  useEffect(() => {
    if (entry) reset(entry.formData ?? {})
  }, [entryId, reset]) // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmit = async (values: Record<string, unknown>) => {
    if (!entry) return
    await onSave(entry.assetId, values)
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" scroll="paper">
      {entry && (
        <>
          <DialogTitle
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              pb: 1,
              borderBottom: 1,
              borderColor: 'divider'
            }}
          >
            <IconButton edge="start" onClick={onClose} size="small">
              <ArrowBackIcon />
            </IconButton>
            <Box sx={{ flex: 1, overflow: 'hidden' }}>
              <Typography variant="subtitle1" fontWeight={700} noWrap>
                {entry.assetName}
              </Typography>
              {entry.subFunctionCode && (
                <Typography variant="caption" color="text.secondary">
                  کد: {entry.subFunctionCode}
                </Typography>
              )}
            </Box>
            {assetClass && (
              <Chip label={assetClass.name} size="small" color="secondary" />
            )}
          </DialogTitle>

          <DialogContent sx={{ pt: 2.5 }}>
            {fieldsLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                <CircularProgress />
              </Box>
            ) : (
              <DynamicClassForm
                fields={fields}
                control={control}
                errors={errors}
                readOnly={readOnly}
                readOnlyValues={readOnly ? entry.formData : undefined}
              />
            )}
          </DialogContent>

          {!readOnly && (
            <DialogActions sx={{ px: 3, pb: 2.5, gap: 1 }}>
              <Button variant="outlined" color="inherit" onClick={onClose}>
                انصراف
              </Button>
              <Button
                variant="contained"
                onClick={() => void handleSubmit(onSubmit)()}
                disabled={isSubmitting || fieldsLoading}
                startIcon={
                  isSubmitting ? (
                    <CircularProgress size={16} color="inherit" />
                  ) : (
                    <SaveIcon />
                  )
                }
              >
                ذخیره
              </Button>
            </DialogActions>
          )}
        </>
      )}
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function LogSheetFillPage() {
  const { localId } = useParams<{ localId: string }>()
  const navigate = useNavigate()

  const [logSheet, setLogSheet] = useState<LogSheet | null>(null)
  const [assetClasses, setAssetClasses] = useState<AssetClass[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // NFC
  const { isScanning, isSupported, lastTag, startScan, stopScan } = useNFC()
  const [manualTagId, setManualTagId] = useState('')
  const [nfcError, setNfcError] = useState<string | null>(null)
  const lastProcessedTag = useRef<string | null>(null)

  // Dialog
  const [activeEntry, setActiveEntry] = useState<LogSheetEntryData | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  // Save / submit
  const [saving, setSaving] = useState(false)
  const [savedMessage, setSavedMessage] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  // -------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!localId) return
    const load = async () => {
      setLoading(true)
      setLoadError(null)
      try {
        const [sheet, classes] = await Promise.all([
          getLogSheet(localId),
          getAllAssetClasses()
        ])
        if (!sheet) {
          setLoadError('Log Sheet یافت نشد')
          return
        }
        setLogSheet(sheet)
        setAssetClasses(classes)
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'خطا در بارگذاری')
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [localId])

  // -------------------------------------------------------------------------
  // NFC tag lookup
  // -------------------------------------------------------------------------

  const handleTagId = useCallback(
    async (tagId: string) => {
      if (!logSheet) return
      setNfcError(null)

      const assetEntry = await getAssetEntryByTagId(tagId)
      if (!assetEntry) {
        setNfcError(`تگ "${tagId}" در سیستم ثبت نشده است`)
        return
      }

      const entry = logSheet.entries.find(e => e.assetId === assetEntry.id)
      if (!entry) {
        setNfcError(`Asset مربوط به تگ "${tagId}" در این Log Sheet وجود ندارد`)
        return
      }

      setActiveEntry(entry)
      setDialogOpen(true)
    },
    [logSheet]
  )

  // Auto-open when NFC tag is detected
  const lastTagSerial = lastTag?.serialNumber
  useEffect(() => {
    if (!lastTagSerial) return
    if (lastTagSerial === lastProcessedTag.current) return
    lastProcessedTag.current = lastTagSerial
    void handleTagId(lastTagSerial)
    stopScan()
  }, [lastTagSerial, handleTagId, stopScan])

  const handleManualSubmit = () => {
    const trimmed = manualTagId.trim()
    if (!trimmed) return
    void handleTagId(trimmed)
    setManualTagId('')
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const getAssetClass = useCallback(
    (classId: string) => assetClasses.find(c => c.id === classId),
    [assetClasses]
  )

  const countFilledFields = (entry: LogSheetEntryData) =>
    Object.values(entry.formData).filter(
      v => v !== undefined && v !== null && v !== '' &&
        !(Array.isArray(v) && v.length === 0)
    ).length

  // -------------------------------------------------------------------------
  // Save single entry
  // -------------------------------------------------------------------------

  const handleSaveEntry = async (
    assetId: string,
    formData: Record<string, unknown>
  ) => {
    if (!logSheet || !localId) return
    setSaveError(null)
    try {
      const updatedEntries = logSheet.entries.map(e =>
        e.assetId === assetId ? { ...e, formData } : e
      )
      await updateLogSheet(localId, { entries: updatedEntries })
      const refreshed = await getLogSheet(localId)
      if (refreshed) setLogSheet(refreshed)
      setDialogOpen(false)
      setSavedMessage('اطلاعات ذخیره شد')
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'خطا در ذخیره')
    }
  }

  // -------------------------------------------------------------------------
  // Submit log sheet
  // -------------------------------------------------------------------------

  const handleSubmitLogSheet = async () => {
    if (!logSheet || !localId) return
    setSaving(true)
    setSaveError(null)
    try {
      await updateLogSheet(localId, {
        status: 'submitted',
        submittedAt: Date.now()
      })
      const refreshed = await getLogSheet(localId)
      if (refreshed) setLogSheet(refreshed)
      setSavedMessage('Log Sheet با موفقیت ارسال شد')
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'خطا در ارسال')
    } finally {
      setSaving(false)
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (loadError || !logSheet) {
    return (
      <Box sx={{ maxWidth: 720, mx: 'auto' }}>
        <Alert severity="error">{loadError ?? 'Log Sheet یافت نشد'}</Alert>
        <Button sx={{ mt: 2 }} onClick={() => navigate('/logsheets')}>
          بازگشت
        </Button>
      </Box>
    )
  }

  const isSubmitted = logSheet.status === 'submitted'
  const totalCount = logSheet.entries.length
  const filledCount = logSheet.entries.filter(
    e => countFilledFields(e) > 0
  ).length

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto' }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
        <IconButton onClick={() => navigate('/logsheets')} size="small">
          <ArrowBackIcon />
        </IconButton>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" fontWeight={700}>
            {logSheet.templateName}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {logSheet.scopeSummary}
          </Typography>
        </Box>
        <Chip
          label={isSubmitted ? 'ارسال شده' : 'پیش‌نویس'}
          color={isSubmitted ? 'success' : 'warning'}
          size="small"
        />
      </Box>

      {/* Meta + progress */}
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardContent sx={{ pb: '10px !important' }}>
          <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', mb: 1.5 }}>
            {logSheet.operatorName && (
              <Typography variant="body2" color="text.secondary">
                اپراتور: <strong>{logSheet.operatorName}</strong>
              </Typography>
            )}
            <Typography variant="body2" color="text.secondary">
              ثبت: <strong>{formatDate(logSheet.createdAt)}</strong>
            </Typography>
            {logSheet.submittedAt && (
              <Typography variant="body2" color="text.secondary">
                ارسال: <strong>{formatDate(logSheet.submittedAt)}</strong>
              </Typography>
            )}
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <LinearProgress
              variant="determinate"
              value={totalCount > 0 ? (filledCount / totalCount) * 100 : 0}
              sx={{ flex: 1, height: 8, borderRadius: 4 }}
              color={filledCount === totalCount && totalCount > 0 ? 'success' : 'primary'}
            />
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
              {filledCount} / {totalCount} Asset پر شده
            </Typography>
          </Box>
        </CardContent>
      </Card>

      {/* NFC scan bar */}
      {!isSubmitted && (
        <Card
          variant="outlined"
          sx={{
            mb: 2,
            borderColor: isScanning ? 'primary.main' : 'divider',
            transition: 'border-color 0.2s'
          }}
        >
          <CardContent sx={{ pb: '12px !important' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
              <NfcIcon
                fontSize="small"
                color={isScanning ? 'primary' : 'action'}
              />
              <Typography
                variant="body2"
                color={isScanning ? 'primary' : 'text.secondary'}
                fontWeight={isScanning ? 600 : 400}
              >
                {isScanning
                  ? 'در حال اسکن... تگ NFC را به دستگاه نزدیک کنید'
                  : 'تگ NFC Asset را اسکن کنید یا شناسه را وارد کنید'}
              </Typography>
              {isScanning && (
                <CircularProgress size={14} sx={{ ml: 'auto' }} />
              )}
            </Box>

            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <TextField
                size="small"
                placeholder="شناسه تگ..."
                value={manualTagId}
                onChange={e => setManualTagId(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleManualSubmit()}
                dir="ltr"
                sx={{ flex: 1 }}
                inputProps={{ style: { fontFamily: 'monospace' } }}
              />
              <Button
                variant="outlined"
                size="small"
                onClick={handleManualSubmit}
                disabled={!manualTagId.trim()}
                sx={{ height: 40, minWidth: 60 }}
              >
                تأیید
              </Button>
              {isSupported && (
                <Button
                  variant={isScanning ? 'contained' : 'outlined'}
                  color={isScanning ? 'error' : 'primary'}
                  size="small"
                  startIcon={<NfcIcon />}
                  onClick={isScanning ? stopScan : () => void startScan()}
                  sx={{ height: 40, whiteSpace: 'nowrap' }}
                >
                  {isScanning ? 'توقف' : 'اسکن NFC'}
                </Button>
              )}
            </Box>

            {nfcError && (
              <Alert
                severity="warning"
                sx={{ mt: 1.5 }}
                onClose={() => setNfcError(null)}
              >
                {nfcError}
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      {isSubmitted && (
        <Alert severity="success" sx={{ mb: 2 }}>
          این Log Sheet ارسال شده است. برای مشاهده اطلاعات روی هر Asset کلیک کنید.
        </Alert>
      )}

      {saveError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setSaveError(null)}>
          {saveError}
        </Alert>
      )}

      {/* Asset status list */}
      <Stack spacing={1}>
        {logSheet.entries.map(entry => {
          const assetClass = getAssetClass(entry.classId)
          const totalFields = assetClass?.fields.length ?? 0
          const filledFields = countFilledFields(entry)
          const isFilled = totalFields > 0 && filledFields >= totalFields
          const isPartial = filledFields > 0 && !isFilled

          return (
            <Card
              key={entry.assetId}
              variant="outlined"
              onClick={() => {
                setActiveEntry(entry)
                setDialogOpen(true)
              }}
              sx={{
                cursor: 'pointer',
                transition: 'box-shadow 0.15s',
                '&:hover': { boxShadow: 2 },
                borderColor: isFilled
                  ? 'success.light'
                  : isPartial
                  ? 'warning.light'
                  : 'divider'
              }}
            >
              <CardContent sx={{ py: '10px !important', px: 2 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  {/* Status icon */}
                  {isFilled ? (
                    <CheckCircleIcon color="success" sx={{ flexShrink: 0 }} />
                  ) : (
                    <RadioButtonUncheckedIcon
                      color={isPartial ? 'warning' : 'disabled'}
                      sx={{ flexShrink: 0 }}
                    />
                  )}

                  {/* Asset info */}
                  <Box sx={{ flex: 1, overflow: 'hidden' }}>
                    <Typography variant="body2" fontWeight={600} noWrap>
                      {entry.assetName}
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5, flexWrap: 'wrap' }}>
                      {entry.subFunctionCode && (
                        <Chip
                          label={entry.subFunctionCode}
                          size="small"
                          variant="outlined"
                          color="primary"
                          sx={{
                            fontSize: '0.65rem',
                            height: 18,
                            fontFamily: 'monospace'
                          }}
                        />
                      )}
                      {assetClass && (
                        <Chip
                          label={assetClass.name}
                          size="small"
                          variant="outlined"
                          color="secondary"
                          sx={{ fontSize: '0.65rem', height: 18 }}
                        />
                      )}
                    </Box>
                  </Box>

                  {/* Field fill count */}
                  <Typography
                    variant="caption"
                    sx={{
                      whiteSpace: 'nowrap',
                      minWidth: 52,
                      textAlign: 'center',
                      fontWeight: 600,
                      color: isFilled
                        ? 'success.main'
                        : isPartial
                        ? 'warning.main'
                        : 'text.disabled'
                    }}
                  >
                    {totalFields > 0 ? `${filledFields}/${totalFields}` : '—'}
                  </Typography>
                </Box>
              </CardContent>
            </Card>
          )
        })}
      </Stack>

      {/* Divider + submit */}
      {!isSubmitted && (
        <>
          <Divider sx={{ my: 3 }} />
          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="contained"
              color="success"
              size="large"
              startIcon={
                saving ? (
                  <CircularProgress size={18} color="inherit" />
                ) : (
                  <SendIcon />
                )
              }
              onClick={() => void handleSubmitLogSheet()}
              disabled={saving}
            >
              ارسال Log Sheet
            </Button>
          </Box>
        </>
      )}

      {/* Asset fill dialog */}
      <AssetFillDialog
        entry={activeEntry}
        assetClass={activeEntry ? getAssetClass(activeEntry.classId) : undefined}
        open={dialogOpen}
        readOnly={isSubmitted}
        onClose={() => setDialogOpen(false)}
        onSave={handleSaveEntry}
      />

      {/* Success toast */}
      <Snackbar
        open={!!savedMessage}
        autoHideDuration={3000}
        onClose={() => setSavedMessage(null)}
        message={savedMessage}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  )
}
