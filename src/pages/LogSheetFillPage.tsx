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
  Tooltip
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import NfcIcon from '@mui/icons-material/Nfc'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked'
import SendIcon from '@mui/icons-material/Send'
import SaveIcon from '@mui/icons-material/Save'
import UndoIcon from '@mui/icons-material/Undo'
import SyncIcon from '@mui/icons-material/Sync'
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined'
import EditIcon from '@mui/icons-material/Edit'
import { useState, useEffect, useCallback, useRef, useMemo, type FormEvent, type MouseEvent } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { v4 as uuidv4 } from 'uuid'
import {
  getLogSheet,
  updateLogSheet,
  revertLogSheetToDraft,
  resetLogSheetToOpenDraft,
  getAssetClass,
  getAllAssetEntries
} from '@/services/storage'
import {
  getArchivedLogSheetByViewId,
  parseArchivedLogSheetViewId
} from '@/services/storage/logSheetArchive'
import {
  createNfcFaultReport,
  getNfcFaultReportsForSheet
} from '@/services/storage/nfcFaultReports'
import { DynamicClassForm } from '@/components/forms/DynamicClassForm'
import { useFieldDefinitions } from '@/hooks/useFieldDefinitions'
import { sheetFieldDefinitions } from '@/utils/sheetFieldDefinitions'
import {
  createFormDraftCache,
  formInitialValues,
  needsFormInitialisation,
  type FormDraftCache
} from '@/utils/formDraftCache'
import { shouldShowFullPageLoader } from '@/utils/pageLoadState'
import { useNFC } from '@/hooks/useNFC'
import { resolveNfcTagId } from '@/services/nfc'
import { matchLogSheetEntryByTag } from '@/services/nfc/matchLogSheetEntry'
import { useSettings } from '@/hooks/useSettings'
import { useAppStore } from '@/store'
import { hasPermission, isManualTagEntryAllowed, PERM_NFC_FAULT_REPORT } from '@/types/auth'
import { ScopeLabel } from '@/components/common/ScopeLabel'
import { LogSheetIdentityMeta } from '@/components/common/LogSheetIdentityMeta'
import {
  canSubmitLogSheet,
  canRevertSubmittedLogSheetToDraft,
  failedOnFieldValidation,
  isLogSheetExpired,
  isExpiredDraft,
  isLogSheetCancelled,
  isCancelledDraft,
  shouldShowLogSheetExpiryAlert,
  isSupersededSyncError,
  isOwnershipReassignError,
  isRevokedAssignment,
  isReopenedAfterSync,
  resolveLocalLogSheetStatusChip,
  SYNC_OUTCOME_MESSAGES
} from '@/utils/logSheetStatus'
import { canContinueReopenedLogSheet } from '@/utils/logSheetWorkflow'
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
import type { LogSheet, AssetClass, LogSheetEntryData, NfcFaultReport } from '@/types'

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
): Promise<{ entries: LogSheetEntryData[]; nfcBackfilled: boolean }> {
  const assets = await getAllAssetEntries()
  const byId = new Map(assets.map(a => [a.id, a]))
  let nfcBackfilled = false

  const enriched = entries.map(e => {
    const asset = byId.get(e.assetId)
    const nfcTagId = (e.nfcTagId || asset?.nfcTagId)?.trim() || undefined
    if (!e.nfcTagId?.trim() && nfcTagId) nfcBackfilled = true
    // Same backfill for the chip serial: a bundle taken before the serial was
    // recorded would otherwise leave strict scan mode with nothing to verify.
    const nfcSerial = (e.nfcSerial || asset?.nfcSerial)?.trim() || undefined
    if (!e.nfcSerial?.trim() && nfcSerial) nfcBackfilled = true
    return {
      ...e,
      classId: asset ? toIdString(asset.classId) : toIdString(e.classId),
      nfcTagId,
      nfcSerial
    }
  })

  return { entries: enriched, nfcBackfilled }
}

// ---------------------------------------------------------------------------
// Asset fill dialog — view on tap, edit only via NFC / tag ID
// ---------------------------------------------------------------------------

interface AssetFillDialogProps {
  entry: LogSheetEntryData | null
  assetClass: AssetClass | undefined
  /** The sheet being filled — supplies the schema it was raised with. */
  logSheet: LogSheet | null
  open: boolean
  readOnly: boolean
  onClose: () => void
  onSave: (assetId: string, formData: Record<string, unknown>) => Promise<void>
  /**
   * Where in-progress values are kept, owned by the page rather than by this dialog.
   *
   * This dialog can be unmounted without being closed — anything that makes the page render a
   * blocking state takes its whole subtree, and react-hook-form's values go with it. Handing
   * the draft up to something that stays mounted is what lets a remount restore the operator's
   * work instead of silently rebuilding the form from stored data.
   */
  draftCache: FormDraftCache
}

function AssetFillDialog({
  entry,
  assetClass,
  logSheet,
  open,
  readOnly,
  onClose,
  onSave,
  draftCache
}: AssetFillDialogProps) {
  // The shared per-class table is only the fallback: it holds whichever bundle merged last,
  // which for a device holding two sheets of the same class may not be this sheet's schema.
  const { fields: fallbackFields, loading: fieldsLoading, refresh: refreshFields } =
    useFieldDefinitions(entry ? toIdString(entry.classId) : undefined)
  const fields = useMemo(
    () => sheetFieldDefinitions(logSheet, entry?.classId, fallbackFields),
    [logSheet, entry?.classId, fallbackFields]
  )
  const {
    control,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting }
  } = useForm<Record<string, unknown>>({ defaultValues: {} })

  useEffect(() => {
    if (open && entry) void refreshFields()
  }, [open, entry?.assetId, entry?.classId, refreshFields])

  /** What the form is currently showing: one asset while open, nothing while closed. */
  const draftKey = open && entry ? entry.assetId : null

  // Which asset this form instance has been filled in for. A **ref**, so it dies with the
  // component: after an unmount it is null again, which is exactly the signal that the form
  // needs re-filling — this time from the draft the page kept, not from stored data.
  const initialisedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!draftKey || !entry) {
      // Closed. Arm the next open so re-opening the same asset starts from stored data rather
      // than from whatever this instance happened to be showing.
      initialisedFor.current = null
      return
    }
    // Already filled in for this asset, and still mounted: leave it alone. Re-running here is
    // what would throw away edits every time an unrelated prop changed.
    if (!needsFormInitialisation(initialisedFor.current, draftKey)) return
    initialisedFor.current = draftKey
    reset(formInitialValues(draftCache.read(draftKey), entry.formData))
  }, [draftKey, entry, reset, draftCache])

  // Mirror every change into the page-held cache, so an unmount at any moment is recoverable.
  // `watch`'s subscription form does not re-render this component — it only writes to a Map.
  useEffect(() => {
    if (!draftKey || readOnly) return
    const subscription = watch(values => {
      draftCache.remember(draftKey, values as Record<string, unknown>)
    })
    return () => subscription.unsubscribe()
  }, [draftKey, readOnly, watch, draftCache])

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
                attachmentContext={
                  logSheet
                    ? {
                        logSheetLocalId: logSheet.localId,
                        // May be absent for a sheet raised offline; the upload queue skips
                        // those rows until the sheet itself has synced and been given an id.
                        logSheetServerId: logSheet.serverId,
                        assetId: toIdString(entry.assetId)
                      }
                    : undefined
                }
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
// NFC fault report dialog — quick, context-prefilled, no NFC required
// ---------------------------------------------------------------------------

interface NfcFaultReportDialogProps {
  entry: LogSheetEntryData | null
  open: boolean
  submitting: boolean
  onClose: () => void
  onSubmit: (reason: string) => void
}

function NfcFaultReportDialog({
  entry,
  open,
  submitting,
  onClose,
  onSubmit
}: NfcFaultReportDialogProps) {
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (open) setReason('')
  }, [open])

  return (
    <Dialog open={open} onClose={submitting ? undefined : onClose} fullWidth maxWidth="xs" dir="rtl">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <ReportProblemOutlinedIcon color="warning" />
        {t.logSheet.reportNfcFault}
      </DialogTitle>
      <DialogContent>
        {entry && (
          <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>
            {entry.assetName}
          </Typography>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t.logSheet.reportNfcFaultHint}
        </Typography>
        <TextField
          fullWidth
          multiline
          minRows={2}
          maxRows={5}
          label={t.logSheet.nfcFaultReasonLabel}
          value={reason}
          onChange={e => setReason(e.target.value)}
          disabled={submitting}
          inputProps={{ maxLength: 2000 }}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button type="button" onClick={onClose} disabled={submitting}>
          انصراف
        </Button>
        <Button
          type="button"
          variant="contained"
          color="warning"
          disabled={submitting}
          startIcon={
            submitting ? <CircularProgress size={16} color="inherit" /> : <ReportProblemOutlinedIcon />
          }
          onClick={() => onSubmit(reason)}
        >
          {t.logSheet.nfcFaultSubmit}
        </Button>
      </DialogActions>
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
  // The load effect only ever asks *whether* there is a session, so it depends on the boolean
  // rather than the object: a session re-published with identical contents must not be a reason
  // to reload the page underneath an operator who is filling a form.
  const hasAuthSession = !!authSession
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

  /**
   * The same check, reachable from an effect without becoming one of its triggers.
   *
   * `redirectIfNotAccessible` closes over `inboxAssignedIds`, which is rebuilt from a **new
   * array** on every inbox pull, so the callback gets a new identity on every sync pass. Listing
   * it as a dependency of the load effect therefore re-ran a full sheet load — bundle fetch
   * included — every time the inbox refreshed, purely because a function's identity changed.
   * That is what put the page into its loading state mid-round and unmounted an open asset
   * form. Read through a ref, the check is always current and never a reason to reload.
   */
  const redirectIfNotAccessibleRef = useRef(redirectIfNotAccessible)
  useEffect(() => {
    redirectIfNotAccessibleRef.current = redirectIfNotAccessible
  }, [redirectIfNotAccessible])

  // Permission AND site policy. The policy arrives from the server on every bootstrap, so an
  // administrator turning manual entry off reaches every tablet on its next reconnect — and the
  // device mirror keeps the answer correct while offline.
  const allowManualEntry = isManualTagEntryAllowed(
    authSession ?? null,
    settings.nfcManualEntryEnabled
  )
  // Must mirror the sync layer's own gate (services/sync/index.ts `canSyncFaultReports`) —
  // filing a report the user can't sync would just strand it locally forever, unsynced,
  // with no visible error.
  const canReportNfcFault = hasPermission(authSession, PERM_NFC_FAULT_REPORT)

  const [logSheet, setLogSheet] = useState<LogSheet | null>(null)
  const [assetClasses, setAssetClasses] = useState<AssetClass[]>([])
  const [fieldDefsByClass, setFieldDefsByClass] = useState<Map<string, FieldDefinition[]>>(new Map())
  const [loading, setLoading] = useState(true)
  // Which route id the sheet on screen was loaded for. Stored rather than inferred because a
  // sheet's own `localId` is not the route id in the archived view, and the loader has to be
  // able to tell "refreshing what is already here" from "showing a different sheet".
  const [loadedLocalId, setLoadedLocalId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // In-progress asset-form values, kept here because this component survives what the dialog
  // does not. See utils/formDraftCache.ts. `useMemo` with no dependencies rather than a ref, so
  // it is an ordinary stable value that effects can depend on.
  const draftCache = useMemo(() => createFormDraftCache(), [])

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
  const [activeEntryFilledVia, setActiveEntryFilledVia] = useState<'nfc' | 'manual' | undefined>(undefined)

  // NFC fault reports — filed on this device, unlock manual entry per asset
  const [nfcFaultReports, setNfcFaultReports] = useState<NfcFaultReport[]>([])
  const [faultReportEntry, setFaultReportEntry] = useState<LogSheetEntryData | null>(null)
  const [faultReportSubmitting, setFaultReportSubmitting] = useState(false)

  // Save / submit
  const [saving, setSaving] = useState(false)
  const [savedMessage, setSavedMessage] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmSubmitOpen, setConfirmSubmitOpen] = useState(false)
  const [confirmRevertOpen, setConfirmRevertOpen] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const [isArchivedView, setIsArchivedView] = useState(false)

  const loadFieldDefsForEntries = useCallback(
    async (entries: LogSheetEntryData[], sheet?: LogSheet | null) => {
      const classIds = [...new Set(entries.map(e => toIdString(e.classId)))]
      const pairs = await Promise.all(
        classIds.map(async classId => {
          // Same precedence as the fill dialog, so the completion badge can never disagree
          // with the form the operator actually sees.
          const fallback = await getFieldsForClass(classId)
          return [classId, sheetFieldDefinitions(sheet, classId, fallback)] as const
        })
      )
      setFieldDefsByClass(new Map(pairs))
    },
    []
  )

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
    // A different sheet means the previous sheet's unsaved asset values can never be restored
    // into it — the keys are asset ids, which are not unique across sheets.
    draftCache.clear()
    const load = async () => {
      setLoading(true)
      setLoadError(null)
      setIsArchivedView(false)
      try {
        const archivedRef = localId ? parseArchivedLogSheetViewId(localId) : null
        if (archivedRef) {
          if (!sessionUserId || archivedRef.userId !== sessionUserId) {
            navigate('/logsheets/active', { replace: true })
            return
          }
          const archived = await getArchivedLogSheetByViewId(localId!)
          if (!archived) {
            setLoadError('Log Sheet یافت نشد')
            return
          }
          const { entries } = await enrichEntriesWithNfc(archived.entries ?? [])
          const classes = await loadAssetClassesForEntries(entries)
          await loadFieldDefsForEntries(entries, archived)
          setLogSheet({ ...archived, entries })
          setLoadedLocalId(localId)
          setAssetClasses(classes)
          setIsArchivedView(true)
          return
        }

        let sheet = await getLogSheet(localId)
        if (!sheet) {
          setLoadError('Log Sheet یافت نشد')
          return
        }

        if (redirectIfNotAccessibleRef.current(sheet)) return

        // Submitted sheets are deliberately excluded — a bundle refresh must never resolve a
        // completion (see AGENTS.md § Log sheet merge). The one exception is a row the inbox
        // merge has already flagged as reopened by a supervisor: it is `submitted`+`synced`, so
        // there is no unsent work a refresh could destroy, and the refresh is what keeps the
        // new deadline and server status current on the screen the operator acts from.
        const canRefreshBundle =
          navigator.onLine &&
          hasAuthSession &&
          sheet.serverId &&
          (sheet.status === 'draft' || isReopenedAfterSync(sheet))
        if (canRefreshBundle) {
          try {
            const bundle = await fetchLogSheetBundle(sheet.serverId!)
            sheet = await applyLogSheetBundle(bundle)
          } catch {
            // Offline / server down — use cached bundle data.
          }
        }

        if (redirectIfNotAccessibleRef.current(sheet)) return

        const { entries, nfcBackfilled } = await enrichEntriesWithNfc(sheet.entries ?? [])
        const classes = await loadAssetClassesForEntries(entries)
        await loadFieldDefsForEntries(entries, sheet)
        setLogSheet({ ...sheet, entries })
        setLoadedLocalId(localId)
        setAssetClasses(classes)
        setNfcFaultReports(sheet.serverId ? await getNfcFaultReportsForSheet(sheet.serverId) : [])
        if (nfcBackfilled && localId) {
          await updateLogSheet(localId, { entries })
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'خطا در بارگذاری')
      } finally {
        setLoading(false)
      }
    }
    void load()
    // Deliberately narrow. This effect puts the page into its blocking loading state, so
    // anything listed here can take an open asset form down with it. `sessionUserId` and
    // `hasAuthSession` are session identity — a change there genuinely means "load something
    // else". The accessibility check is read through a ref for the same reason (above), and
    // routine server updates are the business of the inbox effect below, which never touches
    // `loading`.
  }, [localId, hasAuthSession, sessionUserId, navigate, loadFieldDefsForEntries, draftCache])

  // Refresh local sheet when inbox sync updates dueAt / status from server.
  //
  // This is the effect that is *supposed* to run on every sync pass, and it can: it re-reads the
  // row and re-renders, without ever setting `loading`, so nothing on screen is unmounted and an
  // open form keeps what the operator has typed. Its trigger is `inboxLastSyncAt` alone — the
  // accessibility check goes through the ref so that a rebuilt callback is not a second trigger.
  useEffect(() => {
    if (!localId || !inboxLastSyncAt) return
    void getLogSheet(localId).then(async sheet => {
      if (!sheet) return
      if (redirectIfNotAccessibleRef.current(sheet)) return
      const { entries, nfcBackfilled } = await enrichEntriesWithNfc(sheet.entries ?? [])
      await loadFieldDefsForEntries(entries, sheet)
      setLogSheet({ ...sheet, entries })
      if (nfcBackfilled) {
        await updateLogSheet(localId, { entries })
      }
    })
  }, [inboxLastSyncAt, localId, loadFieldDefsForEntries])

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
    (tagId: string, source: 'nfc' | 'manual' = 'manual', scannedSerial?: string | null) => {
      if (!logSheet) return
      setNfcError(null)

      // Strict serial verification only makes sense for a real chip read. Manual
      // tag entry and the NFC-fault fallback have no hardware serial to compare.
      const result = matchLogSheetEntryByTag(logSheet.entries ?? [], tagId, {
        strictSerial: source === 'nfc' && settings.nfcStrictSerialMatch,
        scannedSerial
      })

      if (result.kind === 'notInSheet') {
        setNfcError(`Asset مربوط به تگ "${tagId.trim()}" در این Log Sheet وجود ندارد`)
        return
      }
      // Both verification failures give the same opaque answer on purpose — naming which
      // check failed would hand the holder of the tag a map of how verification works.
      if (result.kind === 'serialMissing' || result.kind === 'serialMismatch') {
        setNfcError(t.logSheet.nfcVerificationFailed)
        return
      }

      setActiveEntry(result.entry)
      setActiveEntryFilledVia(source)
      setDialogEditable(true)
      setDialogOpen(true)
    },
    [logSheet, settings.nfcStrictSerialMatch]
  )

  const openEntryForView = (entry: LogSheetEntryData) => {
    setActiveEntry(entry)
    setActiveEntryFilledVia(undefined)
    setDialogEditable(false)
    setDialogOpen(true)
  }

  /** Manual-entry fallback for an asset with an approved NFC fault report — no tag involved. */
  const handleOpenManualEntry = (entry: LogSheetEntryData) => {
    setNfcError(null)
    setActiveEntry(entry)
    setActiveEntryFilledVia('manual')
    setDialogEditable(true)
    setDialogOpen(true)
  }

  const closeDialog = () => {
    // The operator closed the form without saving, so the in-progress values are discarded on
    // purpose. Keeping them would restore an abandoned edit the next time this asset is opened,
    // which reads as the app ignoring a cancel.
    if (activeEntry) draftCache.forget(activeEntry.assetId)
    setDialogOpen(false)
    setDialogEditable(false)
    setActiveEntryFilledVia(undefined)
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
    void handleTagId(trimmed, 'manual')
    setManualTagId('')
  }

  // Fill tag ID from NDEF record payload (not hardware UID), then open asset for edit
  useEffect(() => {
    if (!lastTag || !isScanning) return

    const tagId = resolveNfcTagId(lastTag)
    if (!tagId) {
      stopScan()
      // Same opaque message as a failed serial check: "Record 1 could not be read, the tag
      // must be text/plain" told the operator exactly how the tag is meant to be written.
      setNfcError(t.logSheet.nfcVerificationFailed)
      return
    }

    if (tagId === lastProcessedTag.current) return
    lastProcessedTag.current = tagId

    setManualTagId(tagId)
    stopScan()
    setLastScannedTag(null)
    // `serialNumber` is the chip's hardware UID, distinct from the Record 1 payload.
    void handleTagId(tagId, 'nfc', lastTag.serialNumber)
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
      // The values are about to be in IndexedDB, so the in-memory draft has done its job. Dropped
      // before the write rather than after: if the write throws, the dialog stays open holding
      // the same values, and a stale draft underneath it would only be able to disagree.
      draftCache.forget(assetId)
      const filledVia = activeEntryFilledVia ?? 'nfc'
      const updatedEntries = logSheet.entries.map(e =>
        e.assetId === assetId ? { ...applyEntrySaveTimestamps(e, formData), filledVia } : e
      )
      await updateLogSheet(localId, {
        entries: updatedEntries,
        ...(sessionUserId ? { localOwnerUserId: sessionUserId } : {})
      })
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
  // NFC fault reports
  // -------------------------------------------------------------------------

  const hasFaultReportFor = useCallback(
    (assetId: string) => nfcFaultReports.some(r => r.assetId === assetId),
    [nfcFaultReports]
  )

  const handleCreateFaultReport = async (reason: string) => {
    if (!faultReportEntry || !logSheet?.serverId) return
    setFaultReportSubmitting(true)
    try {
      const created = await createNfcFaultReport({
        logSheetServerId: logSheet.serverId,
        assetId: faultReportEntry.assetId,
        reason: reason.trim() || undefined,
        reportedByName: authSession?.fullName || authSession?.username || undefined
      })
      setNfcFaultReports(prev => [...prev, created])
      setFaultReportEntry(null)
      setSavedMessage(t.logSheet.nfcFaultSubmitted)
      if (canUseServer) void syncManager.sync()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'خطا در ثبت گزارش خرابی NFC')
    } finally {
      setFaultReportSubmitting(false)
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
        ...(sessionUserId
          ? { assigneeUserId: sessionUserId, localOwnerUserId: sessionUserId }
          : {})
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

  /**
   * Resume a completion the supervisor reopened.
   *
   * The local row says `submitted`+`synced` and the inbox merge has flagged it as reopened, but
   * that flag came from an inbox response that may have been read *before* this device's own
   * submission landed. So the server is asked again, right now, and only its live answer decides:
   * a fetch issued while the row is already `synced` cannot see a pre-submit state, because that
   * stamp only exists once the server committed the completion.
   *
   * Order matters below. `resetLogSheetToOpenDraft` runs first so the row is an ordinary draft by
   * the time the bundle is applied — `alignLocalWorkflowWithServer` then takes its plain path and
   * merges the server's metadata while `shouldPreserveLocalFormData` keeps the operator's own
   * readings. Applying the bundle first would hit the `synced` short-circuit and change nothing.
   * The reset also drops `clientActionId`, so the corrected resubmission is a new action rather
   * than a replay the server would answer "already processed".
   */
  const handleContinueReopened = async () => {
    if (!logSheet || !localId) return
    if (!logSheet.serverId) {
      setSaveError('این کار از سرور دریافت نشده است.')
      return
    }
    if (!canUseServer) {
      setSaveError(t.logSheet.continueReopenedRequiresOnline)
      return
    }
    setContinuing(true)
    setSaveError(null)
    try {
      const bundle = await fetchLogSheetBundle(logSheet.serverId)
      const check = canContinueReopenedLogSheet(bundle.sheet, sessionUserId)

      if (!check.ok) {
        // Refused — but the bundle still carries the truth, and leaving the screen showing a
        // reopen that is not there any more would send the operator back to the same button.
        const applied = await applyLogSheetBundle(bundle)
        const { entries } = await enrichEntriesWithNfc(applied.entries ?? [])
        await loadFieldDefsForEntries(entries, applied)
        setLogSheet({ ...applied, entries })
        setSaveError(check.reason ?? t.logSheet.continueReopenedFailed)
        return
      }

      await resetLogSheetToOpenDraft(localId)
      const reopened = await applyLogSheetBundle(bundle)
      const { entries } = await enrichEntriesWithNfc(reopened.entries ?? [])
      await loadFieldDefsForEntries(entries, reopened)
      setLogSheet({ ...reopened, entries })
      setNfcFaultReports(await getNfcFaultReportsForSheet(toIdString(logSheet.serverId)))
      setSavedMessage(t.logSheet.continueReopenedSuccess)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t.logSheet.continueReopenedFailed)
    } finally {
      setContinuing(false)
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

  // Only when there is nothing else to show. A blocking loader takes the whole subtree with it,
  // including an open asset form and every unsaved value in it — see utils/pageLoadState.ts.
  if (shouldShowFullPageLoader(loading, loadedLocalId, localId)) {
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
  const isCancelled = isLogSheetCancelled(logSheet) || isCancelledDraft(logSheet)
  const statusChip = resolveLocalLogSheetStatusChip(logSheet)
  const isSuperseded = isSupersededSyncError(logSheet)
  const isRevoked = isRevokedAssignment(logSheet)
  const backInMyInbox =
    !!logSheet.serverId && inboxAssignedIds.has(toIdString(logSheet.serverId))
  // Completed, delivered, and since reopened by a supervisor with a new deadline. Only a
  // candidate flag — pressing the button re-verifies against a live bundle before anything
  // local changes.
  const isReopened = isReopenedAfterSync(logSheet)
  const canRevertToDraft = canRevertSubmittedLogSheetToDraft(logSheet, effectivelyOffline).ok
  // The server rejected the values. Same control, different framing: this is not "undo an
  // unsent completion", it is "the readings need fixing", and saying so is the difference
  // between an operator who knows what to do and one staring at a dead end.
  const needsCorrection = failedOnFieldValidation(logSheet)
  // Also offered for SUPERSEDED (already completed by someone else / taken over) and CANCELLED:
  // both are reported as terminal at the time of the failed sync, but a supervisor can still
  // reassign/reopen the sheet back to this operator afterwards — recheck picks that up the same
  // way it already does for a revoked assignment (refreshInbox re-applies the fresh bundle if
  // the sheet reappears in this operator's inbox, and retries the queued submit if it does).
  const canRecheckAssignment =
    canUseServer && (isOwnershipReassignError(logSheet.syncError) || isRevoked || isSuperseded || isCancelled)
  const canEdit =
    !isArchivedView &&
    !isSubmitted &&
    !isExpired &&
    !isCancelled &&
    !isSuperseded &&
    (!isRevoked || backInMyInbox)
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

      {!showExpiryAlert && isCancelled && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {SYNC_OUTCOME_MESSAGES.CANCELLED}
          {!isOnline && ' پس از آنلاین شدن، در صورت بازگشایی مجدد توسط سرپرست، وضعیت به‌روز می‌شود.'}
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

      {isReopened && (
        <Box sx={{ mb: 2 }}>
          <Alert severity="info" sx={{ mb: 1.5 }}>
            {t.logSheet.continueReopenedHint}
          </Alert>
          <Button
            type="button"
            variant="outlined"
            color="warning"
            size="large"
            fullWidth
            startIcon={continuing ? <CircularProgress size={18} color="inherit" /> : <UndoIcon />}
            onClick={() => void handleContinueReopened()}
            disabled={continuing || saving || rechecking || !canUseServer}
          >
            {t.logSheet.continueReopened}
          </Button>
          {!canUseServer && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: 'block' }}>
              {t.logSheet.continueReopenedRequiresOnline}
            </Typography>
          )}
        </Box>
      )}

      {isSuperseded && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {SYNC_OUTCOME_MESSAGES.SUPERSEDED}
        </Alert>
      )}

      {logSheet.syncStatus === 'failed' && logSheet.syncError && !isSuperseded && !isExpired && !isCancelled && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {logSheet.syncError}
        </Alert>
      )}

      {canRevertToDraft && (
        <Box sx={{ mb: 2 }}>
          <Alert severity={needsCorrection ? 'warning' : 'info'} sx={{ mb: 1.5 }}>
            {needsCorrection ? t.logSheet.correctAndResubmitHint : t.logSheet.revertToDraftHint}
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
            {needsCorrection ? t.logSheet.correctAndResubmit : t.logSheet.revertToDraft}
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
            : 'برای مشاهده روی Asset کلیک کنید. برای ویرایش، تگ NFC را اسکن کنید. اگر تگ خراب است، با «اعلام خرابی NFC» ثبت دستی همان Asset باز می‌شود.'}
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

                  {/* NFC fault report / manual-entry unlock */}
                  {canEdit &&
                    (hasFaultReportFor(entry.assetId) ? (
                      <Tooltip title={t.logSheet.manualEntryUnlockedHint}>
                        <Button
                          size="small"
                          variant="outlined"
                          color="warning"
                          onClick={e => {
                            e.stopPropagation()
                            handleOpenManualEntry(entry)
                          }}
                          startIcon={<EditIcon fontSize="small" />}
                          sx={{ flexShrink: 0, minWidth: 0, px: 1, fontSize: '0.7rem', height: 30 }}
                        >
                          {t.logSheet.manualEntryUnlocked}
                        </Button>
                      </Tooltip>
                    ) : (
                      canReportNfcFault && (
                        <Tooltip title={t.logSheet.reportNfcFault}>
                          <IconButton
                            size="small"
                            onClick={e => {
                              e.stopPropagation()
                              setFaultReportEntry(entry)
                            }}
                            sx={{ flexShrink: 0 }}
                          >
                            <ReportProblemOutlinedIcon fontSize="small" color="action" />
                          </IconButton>
                        </Tooltip>
                      )
                    ))}
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
        logSheet={logSheet}
        open={dialogOpen}
        readOnly={isSubmitted || !dialogEditable}
        onClose={closeDialog}
        onSave={handleSaveEntry}
        draftCache={draftCache}
      />

      {/* NFC fault report dialog */}
      <NfcFaultReportDialog
        entry={faultReportEntry}
        open={!!faultReportEntry}
        submitting={faultReportSubmitting}
        onClose={() => setFaultReportEntry(null)}
        onSubmit={reason => void handleCreateFaultReport(reason)}
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
