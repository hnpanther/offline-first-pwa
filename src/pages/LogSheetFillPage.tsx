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
  DialogActions
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
import { v4 as uuidv4 } from 'uuid'
import {
  getLogSheet,
  updateLogSheet,
  getAllAssetClasses,
  getAssetEntryByTagId
} from '@/services/storage'
import { DynamicClassForm } from '@/components/forms/DynamicClassForm'
import { useFieldDefinitions } from '@/hooks/useFieldDefinitions'
import { useNFC } from '@/hooks/useNFC'
import { useSettings } from '@/hooks/useSettings'
import { useAppStore } from '@/store'
import { canEnterTagManually } from '@/types/auth'
import { ScopeLabel } from '@/components/common/ScopeLabel'
import { LogSheetIdentityMeta } from '@/components/common/LogSheetIdentityMeta'
import {
  canSubmitLogSheet,
  isLogSheetExpired,
  isSupersededSyncError,
  SYNC_OUTCOME_MESSAGES
} from '@/utils/logSheetStatus'
import { t } from '@/i18n'
import type { LogSheet, AssetClass, LogSheetEntryData } from '@/types'

const formatDate = (ts: number) =>
  new Date(ts).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' })

// ---------------------------------------------------------------------------
// Asset fill dialog — view on tap, edit only via NFC / tag ID
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

          <DialogContent sx={{ pt: 2.5, px: 2, pb: 2, overflow: 'auto' }}>
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
  const { settings } = useSettings()
  const authSession = useAppStore(s => s.authSession)
  const inboxLastSyncAt = useAppStore(s => s.inboxLastSyncAt)
  const isOnline = useAppStore(s => s.isOnline)
  const allowManualEntry = canEnterTagManually(
    authSession?.roles ?? [],
    settings.allowManualEntry
  )

  const [logSheet, setLogSheet] = useState<LogSheet | null>(null)
  const [assetClasses, setAssetClasses] = useState<AssetClass[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // NFC
  const { isScanning, isSupported, lastTag, error: nfcScanError, startScan, stopScan } = useNFC()
  const setNFCError = useAppStore(s => s.setNFCError)
  const [manualTagId, setManualTagId] = useState('')
  const [nfcError, setNfcError] = useState<string | null>(null)
  const lastProcessedTag = useRef<string | null>(null)

  // Dialog — tap = view-only, NFC / tag ID = editable
  const [activeEntry, setActiveEntry] = useState<LogSheetEntryData | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogEditable, setDialogEditable] = useState(false)

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

  // Refresh local sheet when inbox sync updates dueAt / status from server
  useEffect(() => {
    if (!localId || !inboxLastSyncAt) return
    void getLogSheet(localId).then(sheet => {
      if (sheet) setLogSheet(sheet)
    })
  }, [inboxLastSyncAt, localId])

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
      setDialogEditable(true)
      setDialogOpen(true)
    },
    [logSheet]
  )

  const openEntryForView = (entry: LogSheetEntryData) => {
    setActiveEntry(entry)
    setDialogEditable(false)
    setDialogOpen(true)
  }

  const closeDialog = () => {
    setDialogOpen(false)
    setDialogEditable(false)
    lastProcessedTag.current = null
  }

  const handleStartNfcScan = () => {
    lastProcessedTag.current = null
    setNfcError(null)
    setNFCError(null)
    void startScan()
  }

  // Fill tag ID field when NFC tag is detected, then open asset for edit
  const lastTagSerial = lastTag?.serialNumber
  useEffect(() => {
    if (!lastTagSerial) return
    if (lastTagSerial === lastProcessedTag.current) return
    lastProcessedTag.current = lastTagSerial

    setManualTagId(lastTagSerial)
    stopScan()
    void handleTagId(lastTagSerial)
  }, [lastTagSerial, handleTagId, stopScan])

  const handleManualSubmit = () => {
    if (!allowManualEntry) return
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
      closeDialog()
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
    if (!logSheet.serverId) {
      setSaveError('این کار از سرور دریافت نشده و قابل ارسال نیست.')
      return
    }
    const check = canSubmitLogSheet(logSheet)
    if (!check.ok) {
      setSaveError(check.reason ?? SYNC_OUTCOME_MESSAGES.EXPIRED)
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const completedAt = Date.now()
      const clientActionId = logSheet.clientActionId ?? uuidv4()
      await updateLogSheet(localId, {
        status: 'submitted',
        submittedAt: completedAt,
        completedAt,
        clientActionId
      })
      const refreshed = await getLogSheet(localId)
      if (refreshed) setLogSheet(refreshed)
      setSavedMessage('Log Sheet با موفقیت ارسال شد و در صف همگام‌سازی قرار گرفت')
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
  const isExpired = isLogSheetExpired(logSheet)
  const isSuperseded = logSheet.syncStatus === 'failed' && isSupersededSyncError(logSheet.syncError)
  const canEdit = !isSubmitted && !isExpired
  const entries = logSheet.entries ?? []
  const totalCount = entries.length
  const filledCount = entries.filter(
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
          <ScopeLabel scopeSummary={logSheet.scopeSummary} templateId={logSheet.templateId} />
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
            <LogSheetIdentityMeta
              serverId={logSheet.serverId}
              createdAt={logSheet.createdAt}
              variant="body2"
              inline={false}
            />
            {logSheet.dueAt && (
              <Typography variant="body2" color="text.secondary">
                مهلت: <strong>{formatDate(logSheet.dueAt)}</strong>
              </Typography>
            )}
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

      {isExpired && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {SYNC_OUTCOME_MESSAGES.EXPIRED}
          {!isOnline && ' پس از آنلاین شدن، در صورت تمدید مهلت توسط سرپرست، وضعیت به‌روز می‌شود.'}
        </Alert>
      )}

      {isSuperseded && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {SYNC_OUTCOME_MESSAGES.SUPERSEDED}
        </Alert>
      )}

      {logSheet.syncStatus === 'failed' && logSheet.syncError && !isSuperseded && !isExpired && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {logSheet.syncError}
        </Alert>
      )}

      {/* Submit — top */}
      {canEdit && entries.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Button
            variant="contained"
            color="success"
            size="large"
            fullWidth
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
            {t.logSheet.submit}
          </Button>
        </Box>
      )}

      {/* NFC scan bar */}
      {canEdit && (
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
                  ? t.nfc.waitingForTag
                  : isSupported
                  ? 'برای ویرایش Asset، دکمه اسکن NFC را بزنید'
                  : t.nfc.notSupported}
              </Typography>
              {isScanning && (
                <CircularProgress size={14} sx={{ ml: 'auto' }} />
              )}
            </Box>

            {isSupported && (
              <Button
                variant={isScanning ? 'contained' : 'outlined'}
                color={isScanning ? 'error' : 'primary'}
                fullWidth
                startIcon={isScanning ? <CircularProgress size={16} color="inherit" /> : <NfcIcon />}
                onClick={isScanning ? stopScan : handleStartNfcScan}
                sx={{ mb: 1.5, height: 44 }}
              >
                {isScanning ? t.nfc.stopScan : t.nfc.startScan}
              </Button>
            )}

            {allowManualEntry ? (
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                <TextField
                  size="small"
                  label={t.nfc.serialNumber}
                  placeholder="شناسه تگ..."
                  value={manualTagId}
                  onChange={e => setManualTagId(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleManualSubmit()}
                  dir="ltr"
                  sx={{ flex: 1 }}
                  inputProps={{ style: { fontFamily: 'monospace' }, readOnly: isScanning }}
                />
                <Button
                  variant="contained"
                  size="small"
                  onClick={handleManualSubmit}
                  disabled={!manualTagId.trim() || isScanning}
                  sx={{ height: 40, minWidth: 72 }}
                >
                  تأیید
                </Button>
              </Box>
            ) : (
              <>
                {manualTagId && (
                  <Chip
                    label={`${t.nfc.serialNumber}: ${manualTagId}`}
                    variant="outlined"
                    color="success"
                    sx={{ mb: 1, fontFamily: 'monospace', direction: 'ltr' }}
                  />
                )}
                {!isSupported && (
                  <Alert severity="error" sx={{ mt: manualTagId ? 0 : undefined }}>
                    {t.nfc.manualEntryDisabled}
                  </Alert>
                )}
              </>
            )}

            {(nfcError || nfcScanError) && (
              <Alert
                severity="warning"
                sx={{ mt: 1.5 }}
                onClose={() => {
                  setNfcError(null)
                  setNFCError(null)
                }}
              >
                {nfcError ?? nfcScanError}
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      {canEdit && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {allowManualEntry
            ? 'برای مشاهده روی Asset کلیک کنید. برای ویرایش، تگ NFC را اسکن کنید یا شناسه را دستی وارد کنید.'
            : 'برای مشاهده روی Asset کلیک کنید. برای ویرایش، فقط از اسکن NFC استفاده کنید.'}
        </Alert>
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
      {entries.length === 0 ? (
        <Alert severity="warning">
          هیچ Asset ای برای این کار یافت نشد. ابتدا master-data را همگام‌سازی کنید یا با سرپرست تماس بگیرید.
        </Alert>
      ) : (
      <Stack spacing={1}>
        {entries.map(entry => {
          const assetClass = getAssetClass(entry.classId)
          const totalFields = assetClass?.fields?.length ?? 0
          const filledFields = countFilledFields(entry)
          const isFilled = totalFields > 0 && filledFields >= totalFields
          const isPartial = filledFields > 0 && !isFilled

          return (
            <Card
              key={entry.assetId}
              variant="outlined"
              onClick={() => openEntryForView(entry)}
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
      )}

      {/* Asset fill dialog */}
      <AssetFillDialog
        entry={activeEntry}
        assetClass={activeEntry ? getAssetClass(activeEntry.classId) : undefined}
        open={dialogOpen}
        readOnly={isSubmitted || !dialogEditable}
        onClose={closeDialog}
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
