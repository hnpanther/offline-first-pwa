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
import UndoIcon from '@mui/icons-material/Undo'
import SyncIcon from '@mui/icons-material/Sync'
import { useState, useEffect, useCallback, useRef, useMemo, type FormEvent, type MouseEvent } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { v4 as uuidv4 } from 'uuid'
import {
  getLogSheet,
  updateLogSheet,
  revertLogSheetToDraft,
  getAssetClass,
  getAllAssetEntries
} from '@/services/storage'
import { DynamicClassForm } from '@/components/forms/DynamicClassForm'
import { useFieldDefinitions } from '@/hooks/useFieldDefinitions'
import { useNFC } from '@/hooks/useNFC'
import { resolveNfcTagId } from '@/services/nfc'
import { useSettings } from '@/hooks/useSettings'
import { useAppStore } from '@/store'
import { canEnterTagManually } from '@/types/auth'
import { ScopeLabel } from '@/components/common/ScopeLabel'
import { LogSheetIdentityMeta } from '@/components/common/LogSheetIdentityMeta'
import {
  canSubmitLogSheet,
  canRevertSubmittedLogSheetToDraft,
  isLogSheetExpired,
  isExpiredDraft,
  shouldShowLogSheetExpiryAlert,
  isSupersededSyncError,
  isOwnershipReassignError,
  isRevokedAssignment,
  resolveLocalLogSheetStatusChip,
  SYNC_OUTCOME_MESSAGES
} from '@/utils/logSheetStatus'
import { evaluateEntryCompletion } from '@/utils/entryCompletion'
import { applyEntrySaveTimestamps } from '@/utils/entryTimestamps'
import { formatJalaliDateTime } from '@/utils/formatDate'
import { EntryTimestampsMeta } from '@/components/logsheet/EntryTimestampsMeta'
import { getFieldsForClass } from '@/services/storage/fieldDefinitions'
import type { FieldDefinition } from '@/types/sync'
import { t } from '@/i18n'
import { applyLogSheetBundle } from '@/services/sync/logSheetSync'
import { fetchLogSheetBundle } from '@/services/api'
import { syncManager } from '@/services/sync'
import { isEffectivelyOffline, canReachServer } from '@/utils/connectivity'
import { useInboxSync } from '@/hooks/useInboxSync'
import { isLogSheetAccessibleToUser } from '@/services/auth/sessionContext'
import { toIdString } from '@/utils/ids'
import type { LogSheet, AssetClass, LogSheetEntryData } from '@/types'

const formatDate = formatJalaliDateTime

async function loadAssetClassesForEntries(
  entries: LogSheetEntryData[]
): Promise<AssetClass[]> {
  const classIds = [...new Set(entries.map(e => toIdString(e.classId)))]
  const classes = await Promise.all(classIds.map(id => getAssetClass(id)))
  return classes.filter((c): c is AssetClass => c != null)
}

async function enrichEntriesWithNfc(
  entries: LogSheetEntryData[]
): Promise<{ entries: LogSheetEntryData[]; nfcTagsBackfilled: boolean }> {
  const assets = await getAllAssetEntries()
  const byId = new Map(assets.map(a => [a.id, a]))
  let nfcTagsBackfilled = false

  const enriched = entries.map(e => {
    const asset = byId.get(e.assetId)
    const nfcTagId = (e.nfcTagId || asset?.nfcTagId)?.trim() || undefined
    if (!e.nfcTagId?.trim() && nfcTagId) nfcTagsBackfilled = true
    return {
      ...e,
      classId: asset ? toIdString(asset.classId) : toIdString(e.classId),
      nfcTagId
    }
  })

  return { entries: enriched, nfcTagsBackfilled }
}

/** Match scanned tag against assets in the current log sheet only. */
function findLogSheetEntryByNfcTag(
  entries: LogSheetEntryData[],
  tagId: string
): LogSheetEntryData | undefined {
  const needle = tagId.trim()
  if (!needle) return undefined
  return entries.find(e => e.nfcTagId?.trim() === needle)
}

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
  const { fields, loading: fieldsLoading, refresh: refreshFields } = useFieldDefinitions(
    entry ? toIdString(entry.classId) : undefined
  )
  const {
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<Record<string, unknown>>({ defaultValues: {} })

  useEffect(() => {
    if (open && entry) void refreshFields()
  }, [open, entry?.assetId, entry?.classId, refreshFields])

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
              {entry.nfcTagId && (
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', direction: 'ltr' }}>
                  {t.logSheet.nfcTag}: {entry.nfcTagId}
                </Typography>
              )}
              <EntryTimestampsMeta
                createdAt={entry.createdAt}
                updatedAt={entry.updatedAt}
              />
            </Box>
            {assetClass && (
              <Chip label={assetClass.name} size="small" color="secondary" />
            )}
          </DialogTitle>

          <DialogContent sx={{ pt: 2.5, px: 2, pb: 2, overflow: 'auto' }}>
            <Box
              component="form"
              onSubmit={e => {
                e.preventDefault()
                void handleSubmit(onSubmit)()
              }}
            >
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
            {!readOnly && (
              <DialogActions sx={{ px: 0, pb: 0, pt: 2, gap: 1 }}>
                <Button variant="outlined" color="inherit" onClick={onClose} type="button">
                  انصراف
                </Button>
                <Button
                  type="submit"
                  variant="contained"
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
            </Box>
          </DialogContent>

          {readOnly && (
            <DialogActions sx={{ px: 3, pb: 2.5 }}>
              <Button variant="outlined" onClick={onClose} type="button">
                بستن
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
  const sessionUserId = useAppStore(s => s.sessionUserId)
  const inboxAssigned = useAppStore(s => s.inboxAssigned)
  const inboxLastSyncAt = useAppStore(s => s.inboxLastSyncAt)
  const isOnline = useAppStore(s => s.isOnline)
  const serverReachable = useAppStore(s => s.serverReachable)
  const effectivelyOffline = isEffectivelyOffline(isOnline, serverReachable)
  const canUseServer = canReachServer(isOnline, serverReachable)
  const { refreshInbox } = useInboxSync()

  const inboxAssignedIds = useMemo(
    () => new Set(inboxAssigned.map(s => toIdString(s.id))),
    [inboxAssigned]
  )

  const redirectIfNotAccessible = useCallback(
    (sheet: LogSheet | null) => {
      if (!sheet || !sessionUserId) return false
      if (isLogSheetAccessibleToUser(sheet, sessionUserId, inboxAssignedIds)) return false
      navigate('/logsheets/active', { replace: true })
      return true
    },
    [sessionUserId, inboxAssignedIds, navigate]
  )

  const allowManualEntry = canEnterTagManually(
    authSession?.roles ?? [],
    settings.allowManualEntry,
    authSession?.permissions ?? []
  )

  const [logSheet, setLogSheet] = useState<LogSheet | null>(null)
  const [assetClasses, setAssetClasses] = useState<AssetClass[]>([])
  const [fieldDefsByClass, setFieldDefsByClass] = useState<Map<string, FieldDefinition[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // NFC
  const { isScanning, isSupported, lastTag, error: nfcScanError, startScan, stopScan } = useNFC()
  const setNFCError = useAppStore(s => s.setNFCError)
  const setLastScannedTag = useAppStore(s => s.setLastScannedTag)
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
  const [confirmSubmitOpen, setConfirmSubmitOpen] = useState(false)
  const [confirmRevertOpen, setConfirmRevertOpen] = useState(false)
  const [rechecking, setRechecking] = useState(false)

  const loadFieldDefsForEntries = useCallback(async (entries: LogSheetEntryData[]) => {
    const classIds = [...new Set(entries.map(e => toIdString(e.classId)))]
    const pairs = await Promise.all(
      classIds.map(async classId => [classId, await getFieldsForClass(classId)] as const)
    )
    setFieldDefsByClass(new Map(pairs))
  }, [])

  const getEntryCompletion = useCallback(
    (entry: LogSheetEntryData) => {
      const defs = fieldDefsByClass.get(toIdString(entry.classId)) ?? []
      return evaluateEntryCompletion(entry, defs)
    },
    [fieldDefsByClass]
  )

  // -------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!localId) return
    const load = async () => {
      setLoading(true)
      setLoadError(null)
      try {
        let sheet = await getLogSheet(localId)
        if (!sheet) {
          setLoadError('Log Sheet یافت نشد')
          return
        }

        if (redirectIfNotAccessible(sheet)) return

        const canRefreshBundle =
          navigator.onLine && authSession && sheet.serverId && sheet.status === 'draft'
        if (canRefreshBundle) {
          try {
            const bundle = await fetchLogSheetBundle(sheet.serverId!)
            sheet = await applyLogSheetBundle(bundle)
          } catch {
            // Offline / server down — use cached bundle data.
          }
        }

        if (redirectIfNotAccessible(sheet)) return

        const { entries, nfcTagsBackfilled } = await enrichEntriesWithNfc(sheet.entries ?? [])
        const classes = await loadAssetClassesForEntries(entries)
        await loadFieldDefsForEntries(entries)
        setLogSheet({ ...sheet, entries })
        setAssetClasses(classes)
        if (nfcTagsBackfilled && localId) {
          await updateLogSheet(localId, { entries })
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'خطا در بارگذاری')
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [localId, authSession, sessionUserId, redirectIfNotAccessible, loadFieldDefsForEntries])

  // Refresh local sheet when inbox sync updates dueAt / status from server
  useEffect(() => {
    if (!localId || !inboxLastSyncAt) return
    void getLogSheet(localId).then(async sheet => {
      if (!sheet) return
      if (redirectIfNotAccessible(sheet)) return
      const { entries, nfcTagsBackfilled } = await enrichEntriesWithNfc(sheet.entries ?? [])
      await loadFieldDefsForEntries(entries)
      setLogSheet({ ...sheet, entries })
      if (nfcTagsBackfilled) {
        await updateLogSheet(localId, { entries })
      }
    })
  }, [inboxLastSyncAt, localId, redirectIfNotAccessible, loadFieldDefsForEntries])

  // Clear stale NFC tag when entering / leaving this page
  useEffect(() => {
    setLastScannedTag(null)
    setNFCError(null)
    lastProcessedTag.current = null
    stopScan()
    return () => {
      setLastScannedTag(null)
      stopScan()
    }
  }, [localId, setLastScannedTag, setNFCError, stopScan])

  // -------------------------------------------------------------------------
  // NFC tag lookup
  // -------------------------------------------------------------------------

  const handleTagId = useCallback(
    (tagId: string) => {
      if (!logSheet) return
      setNfcError(null)

      const entry = findLogSheetEntryByNfcTag(logSheet.entries ?? [], tagId)
      if (!entry) {
        setNfcError(`Asset مربوط به تگ "${tagId.trim()}" در این Log Sheet وجود ندارد`)
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

  const handleStartNfcScan = (e?: MouseEvent) => {
    e?.preventDefault()
    e?.stopPropagation()
    lastProcessedTag.current = null
    setNfcError(null)
    setNFCError(null)
    void startScan()
  }

  const handleManualSubmit = (e?: FormEvent | MouseEvent) => {
    e?.preventDefault()
    if (!allowManualEntry) return
    const trimmed = manualTagId.trim()
    if (!trimmed) return
    void handleTagId(trimmed)
    setManualTagId('')
  }

  // Fill tag ID from NDEF record payload (not hardware UID), then open asset for edit
  useEffect(() => {
    if (!lastTag || !isScanning) return

    const tagId = resolveNfcTagId(lastTag)
    if (!tagId) {
      stopScan()
      setNfcError('محتوای Record 1 خوانده نشد — تگ باید text/plain با شناسه Asset باشد')
      return
    }

    if (tagId === lastProcessedTag.current) return
    lastProcessedTag.current = tagId

    setManualTagId(tagId)
    stopScan()
    setLastScannedTag(null)
    void handleTagId(tagId)
  }, [lastTag, isScanning, handleTagId, stopScan, setLastScannedTag])

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const getAssetClass = useCallback(
    (classId: string) => assetClasses.find(c => c.id === classId),
    [assetClasses]
  )

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
        e.assetId === assetId ? applyEntrySaveTimestamps(e, formData) : e
      )
      await updateLogSheet(localId, { entries: updatedEntries })
      const refreshed = await getLogSheet(localId)
      if (refreshed) {
        const { entries } = await enrichEntriesWithNfc(refreshed.entries ?? [])
        setLogSheet({ ...refreshed, entries })
      }
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
        syncStatus: 'pending',
        submittedAt: completedAt,
        completedAt,
        clientActionId,
        ...(sessionUserId ? { assigneeUserId: sessionUserId } : {})
      })
      const refreshed = await getLogSheet(localId)
      if (refreshed) {
        const { entries } = await enrichEntriesWithNfc(refreshed.entries ?? [])
        setLogSheet({ ...refreshed, entries })
      }

      if (canUseServer) {
        await syncManager.sync()
        const afterSync = await getLogSheet(localId)
        if (afterSync) {
          const { entries } = await enrichEntriesWithNfc(afterSync.entries ?? [])
          setLogSheet({ ...afterSync, entries })
        }
        if (afterSync?.syncStatus === 'synced') {
          await refreshInbox(false, true)
          setSavedMessage('Log Sheet با موفقیت ثبت و ارسال شد')
        } else if (afterSync?.syncStatus === 'failed') {
          setSaveError(afterSync.syncError ?? 'خطا در ارسال به سرور')
        } else {
          setSavedMessage('Log Sheet در صف ارسال قرار گرفت')
        }
      } else {
        setSavedMessage('Log Sheet با موفقیت ارسال شد و در صف همگام‌سازی قرار گرفت')
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'خطا در ارسال')
    } finally {
      setSaving(false)
    }
  }

  const handleRevertToDraft = async () => {
    if (!logSheet || !localId) return
    const check = canRevertSubmittedLogSheetToDraft(logSheet, effectivelyOffline)
    if (!check.ok) {
      setSaveError(check.reason ?? 'امکان بازگشت به پیش‌نویس وجود ندارد.')
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      await revertLogSheetToDraft(localId)
      const refreshed = await getLogSheet(localId)
      if (refreshed) {
        const { entries } = await enrichEntriesWithNfc(refreshed.entries ?? [])
        setLogSheet({ ...refreshed, entries })
      }
      setConfirmRevertOpen(false)
      setSavedMessage(t.logSheet.revertToDraftSuccess)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'خطا در بازگشت به پیش‌نویس')
    } finally {
      setSaving(false)
    }
  }

  const handleRecheckAssignment = async () => {
    if (!logSheet || !localId) return
    setRechecking(true)
    setSaveError(null)
    try {
      await refreshInbox(true)
      let refreshed = await getLogSheet(localId)
      if (!refreshed) return

      if (isOwnershipReassignError(refreshed.syncError)) {
        const { entries } = await enrichEntriesWithNfc(refreshed.entries ?? [])
        setLogSheet({ ...refreshed, entries })
        setSaveError(t.logSheet.recheckAssignmentStillRevoked)
        return
      }

      const needsOutboundSync =
        refreshed.status === 'submitted' && refreshed.syncStatus === 'pending'
      if (needsOutboundSync) {
        await syncManager.sync()
        refreshed = (await getLogSheet(localId)) ?? refreshed
      }

      const { entries } = await enrichEntriesWithNfc(refreshed.entries ?? [])
      setLogSheet({ ...refreshed, entries })

      if (refreshed.status === 'submitted' && refreshed.syncStatus === 'synced') {
        setSavedMessage(t.logSheet.recheckAssignmentSynced)
      } else if (refreshed.status === 'submitted' && refreshed.syncStatus === 'failed') {
        setSaveError(refreshed.syncError ?? t.logSheet.recheckAssignmentSyncFailed)
      } else if (needsOutboundSync && refreshed.syncStatus === 'pending') {
        setSaveError(t.logSheet.recheckAssignmentSyncFailed)
      } else {
        setSavedMessage(t.logSheet.recheckAssignmentRestored)
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'خطا در بررسی انتساب')
    } finally {
      setRechecking(false)
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
  const isSynced = isSubmitted && logSheet.syncStatus === 'synced'
  const isExpired = isLogSheetExpired(logSheet) || isExpiredDraft(logSheet)
  const showExpiryAlert = shouldShowLogSheetExpiryAlert(logSheet)
  const statusChip = resolveLocalLogSheetStatusChip(logSheet)
  const isSuperseded = logSheet.syncStatus === 'failed' && isSupersededSyncError(logSheet.syncError)
  const isRevoked = isRevokedAssignment(logSheet)
  const backInMyInbox =
    !!logSheet.serverId && inboxAssignedIds.has(toIdString(logSheet.serverId))
  const canRevertToDraft = canRevertSubmittedLogSheetToDraft(logSheet, effectivelyOffline).ok
  const canRecheckAssignment =
    canUseServer && (isOwnershipReassignError(logSheet.syncError) || isRevoked)
  const canEdit =
    !isSubmitted && !isExpired && !isSuperseded && (!isRevoked || backInMyInbox)
  const entries = logSheet.entries ?? []
  const totalCount = entries.length
  const filledCount = entries.filter(e => getEntryCompletion(e).isComplete).length

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
          <ScopeLabel
            scopeSummary={logSheet.scopeSummary}
            templateId={logSheet.templateId}
            scopeDisplayLabel={logSheet.scopeDisplayLabel}
          />
        </Box>
        <Chip
          label={statusChip.label}
          color={statusChip.color}
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

      {showExpiryAlert && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {SYNC_OUTCOME_MESSAGES.EXPIRED}
          {!isOnline && ' پس از آنلاین شدن، در صورت تمدید مهلت توسط سرپرست، وضعیت به‌روز می‌شود.'}
        </Alert>
      )}

      {isRevoked && !backInMyInbox && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {t.logSheet.revokedAssignmentHint}
        </Alert>
      )}

      {canRecheckAssignment && (
        <Box sx={{ mb: 2 }}>
          <Button
            type="button"
            variant="outlined"
            color="primary"
            size="large"
            fullWidth
            startIcon={rechecking ? <CircularProgress size={18} color="inherit" /> : <SyncIcon />}
            onClick={() => void handleRecheckAssignment()}
            disabled={rechecking || saving}
          >
            {t.logSheet.recheckAssignment}
          </Button>
        </Box>
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

      {canRevertToDraft && (
        <Box sx={{ mb: 2 }}>
          <Alert severity="info" sx={{ mb: 1.5 }}>
            {t.logSheet.revertToDraftHint}
          </Alert>
          <Button
            type="button"
            variant="outlined"
            color="warning"
            size="large"
            fullWidth
            startIcon={saving ? <CircularProgress size={18} color="inherit" /> : <UndoIcon />}
            onClick={() => setConfirmRevertOpen(true)}
            disabled={saving || isScanning || dialogOpen}
          >
            {t.logSheet.revertToDraft}
          </Button>
        </Box>
      )}

      {/* Submit — top */}
      {canEdit && entries.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Button
            type="button"
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
            onClick={() => setConfirmSubmitOpen(true)}
            disabled={saving || isScanning || dialogOpen}
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
                type="button"
                variant={isScanning ? 'contained' : 'outlined'}
                color={isScanning ? 'error' : 'primary'}
                fullWidth
                startIcon={isScanning ? <CircularProgress size={16} color="inherit" /> : <NfcIcon />}
                onClick={e => (isScanning ? stopScan() : handleStartNfcScan(e))}
                sx={{ mb: 1.5, height: 44 }}
              >
                {isScanning ? t.nfc.stopScan : t.nfc.startScan}
              </Button>
            )}

            {allowManualEntry ? (
              <Box
                component="form"
                onSubmit={e => handleManualSubmit(e)}
                sx={{ display: 'flex', gap: 1, alignItems: 'center' }}
              >
                <TextField
                  size="small"
                  label={t.nfc.serialNumber}
                  placeholder="شناسه تگ..."
                  value={manualTagId}
                  onChange={e => setManualTagId(e.target.value)}
                  dir="ltr"
                  sx={{ flex: 1 }}
                  inputProps={{ style: { fontFamily: 'monospace' }, readOnly: isScanning }}
                />
                <Button
                  type="submit"
                  variant="contained"
                  size="small"
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

      {isSynced && (
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
          هیچ Asset ای برای این کار یافت نشد. برای دریافت لیست تجهیزات باید آنلاین باشید یا با سرپرست تماس بگیرید.
        </Alert>
      ) : (
      <Stack spacing={1}>
        {entries.map(entry => {
          const assetClass = getAssetClass(entry.classId)
          const completion = getEntryCompletion(entry)
          const { filledCount: filledFields, totalCount: totalFields, isComplete: isFilled, hasData } =
            completion
          const isPartial = hasData && !isFilled

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
                      {entry.nfcTagId && (
                        <Chip
                          label={entry.nfcTagId}
                          size="small"
                          variant="outlined"
                          sx={{
                            fontSize: '0.65rem',
                            height: 18,
                            fontFamily: 'monospace',
                            direction: 'ltr'
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
                    <EntryTimestampsMeta
                      createdAt={entry.createdAt}
                      updatedAt={entry.updatedAt}
                    />
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

      {/* Confirm final submit */}
      <Dialog open={confirmSubmitOpen} onClose={() => setConfirmSubmitOpen(false)} dir="rtl">
        <DialogTitle>ثبت نهایی Log Sheet</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            آیا از ثبت نهایی و ارسال این Log Sheet به سرور مطمئن هستید؟
            این عمل فقط با دکمه تأیید انجام می‌شود و اسکن NFC ارتباطی ندارد.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button type="button" onClick={() => setConfirmSubmitOpen(false)}>
            انصراف
          </Button>
          <Button
            type="button"
            variant="contained"
            color="success"
            disabled={saving}
            onClick={() => {
              setConfirmSubmitOpen(false)
              void handleSubmitLogSheet()
            }}
          >
            تأیید ثبت نهایی
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={confirmRevertOpen} onClose={() => !saving && setConfirmRevertOpen(false)} dir="rtl">
        <DialogTitle>{t.logSheet.revertToDraft}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">{t.logSheet.revertToDraftHint}</Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button type="button" onClick={() => setConfirmRevertOpen(false)} disabled={saving}>
            انصراف
          </Button>
          <Button
            type="button"
            variant="contained"
            color="warning"
            disabled={saving}
            onClick={() => void handleRevertToDraft()}
          >
            تأیید بازگشت
          </Button>
        </DialogActions>
      </Dialog>

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
