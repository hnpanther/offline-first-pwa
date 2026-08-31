import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  Typography
} from '@mui/material'
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera'
import MicIcon from '@mui/icons-material/Mic'
import VideocamIcon from '@mui/icons-material/Videocam'
import StopIcon from '@mui/icons-material/Stop'
import DeleteIcon from '@mui/icons-material/Delete'
import RefreshIcon from '@mui/icons-material/Refresh'
import CloudDoneIcon from '@mui/icons-material/CloudDone'
import CloudQueueIcon from '@mui/icons-material/CloudQueue'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import { v4 as uuidv4 } from 'uuid'
import {
  attachmentIdsOf,
  buildAttachmentRef,
  getAttachmentsByIds,
  getAttachmentsForEntry,
  removeAttachment,
  retryFailedAttachment,
  saveAttachment
} from '@/services/storage/attachments'
import {
  compressImage,
  formatBytes,
  formatDuration,
  startAudioRecording,
  startVideoRecording,
  type AudioRecorderHandle,
  type VideoRecorderHandle,
  endReasonMessage
} from '@/utils/mediaCapture'
import { getSettings } from '@/services/storage'
import { getSessionUserId } from '@/services/auth/sessionContext'
import { DEFAULT_SETTINGS } from '@/services/storage/db'
import type { AttachmentLimits } from '@/types'
import { downloadAttachment } from '@/services/api'
import { getStorageStatus } from '@/utils/storageQuota'
import { ImageAnnotationDialog, type AnnotatedImage } from '@/components/forms/ImageAnnotationDialog'
import {
  describeMediaError,
  getMicrophonePermission
} from '@/utils/mediaPermissions'
import { t } from '@/i18n'
import type { AttachmentKind, LocalAttachment } from '@/types'


/**
 * One recording, one saved row.
 *
 * <p>Every ending — the operator pressing stop, the duration cap, the byte cap — resolves the
 * recorder's {@code finished} promise, and the component deliberately routes all three through
 * the same stop handler so anything added to saving applies to all of them. A **manual** stop,
 * though, resolves {@code finished} from inside that handler: the effect watching it then fired
 * again in the same tick, before {@code setRecorder(null)} had run the cleanup that sets
 * {@code cancelled}, and the handler's own {@code if (!recorder) return} read the non-null value
 * its closure had captured. The recorder was already finished, so the second {@code stop()}
 * returned the same blob and wrote a second identical row.
 *
 * <p>Measured in a browser before this existed: one tap on «پایان ضبط» produced two
 * 5757-byte rows and a counter reading 2 / 1 against a ceiling of 1. Combined with the reference
 * being rebuilt only from the closure's ids, one of the two rows ended up named by nothing:
 * counted against the ceiling, absent from the list, and so impossible to delete.
 *
 * <p>A closure rather than React state, because both calls happen in a single tick — which is
 * exactly what a state guard cannot see.
 */
export function createCaptureGuard() {
  let saving = false
  return {
    /** True when the caller owns this save; false when one is already in flight. */
    begin(): boolean {
      if (saving) return false
      saving = true
      return true
    },
    /** Releases the guard, whether the save succeeded or threw. */
    end(): void {
      saving = false
    }
  }
}

/**
 * The ids a media field should reference, given what this device actually holds for it.
 *
 * <p>Two things are wrong with building this from the component's {@code ids} closure, and both
 * were reached in the field:
 *
 * <ul>
 *   <li><b>Two captures in one tick read the same stale list</b>, so the second {@code onChange}
 *       overwrote the first and one row was left referenced by nothing.</li>
 *   <li><b>A row referenced by nothing is invisible but still counted.</b> The list is built from
 *       the reference; the ceiling is counted from the device. So the field read as full with no
 *       item on screen to delete — a dead end the operator could not escape.</li>
 * </ul>
 *
 * <p>Answering from the device settles both: the reference becomes what the counter has always
 * measured, and an orphan is **adopted** rather than dropped — which is the only route by which
 * a tablet already carrying one can be freed. Deliberately narrow: the rows passed in are those
 * for exactly this (sheet, asset, field), which are this field's own captures by definition.
 * Nothing is invented and nothing is deleted.
 *
 * @returns the ids to publish, and whether that differs from what the field names today
 */
export function fieldReferenceFor(
  deviceRows: Pick<LocalAttachment, 'id'>[],
  currentIds: string[]
): { ids: string[]; changed: boolean } {
  const ids = deviceRows.map(row => row.id)
  const changed =
    ids.length !== currentIds.length || ids.some((id, i) => id !== currentIds[i])
  return { ids, changed }
}

interface Props {
  kind: AttachmentKind
  label: string
  value: unknown
  readOnly?: boolean
  logSheetLocalId: string
  logSheetServerId?: string
  assetId: string
  fieldKey: string
  onChange: (value: ReturnType<typeof buildAttachmentRef>) => void
}

/**
 * Capture and review control for an image/audio field.
 *
 * The form value it produces holds **ids only** — the media itself lives in IndexedDB and, once
 * uploaded, on the server. That separation is what keeps a log sheet's `formData` small enough
 * to sync as JSON no matter how many photos are attached to it.
 *
 * Object URLs are created for previews and revoked on every change and on unmount. Leaking them
 * is a real problem here rather than a theoretical one: a tablet stays on one screen for a whole
 * shift, and each leaked URL pins its whole blob in memory.
 */
export function AttachmentFieldInput({
  kind,
  label,
  value,
  readOnly,
  logSheetLocalId,
  logSheetServerId,
  assetId,
  fieldKey,
  onChange
}: Props) {
  const [items, setItems] = useState<LocalAttachment[]>([])
  /** Everything the device knows this field holds — the number the ceiling is judged against. */
  const [fieldCount, setFieldCount] = useState(0)
  const [previews, setPreviews] = useState<Map<string, string>>(new Map())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recorder, setRecorder] = useState<AudioRecorderHandle | null>(null)
  const [videoRecorder, setVideoRecorder] = useState<VideoRecorderHandle | null>(null)
  const [limits, setLimits] = useState<AttachmentLimits>(DEFAULT_SETTINGS.attachmentLimits)
  // Server-owned, read alongside the ceilings. A capture already in the review step is not
  // interrupted if this flips mid-shift — the dialog is driven by pendingCapture, not by this.
  const [annotationEnabled, setAnnotationEnabled] = useState(
    DEFAULT_SETTINGS.imageAnnotationEnabled
  )
  const [pendingCapture, setPendingCapture] = useState<{
    blob: Blob
    width: number
    height: number
  } | null>(null)
  const previewRef = useRef<HTMLVideoElement>(null)
  // When set, the alert also shows how to re-enable the microphone. Kept separate from the
  // plain error string because the fix lives outside the app and needs real instructions.
  const [micBlocked, setMicBlocked] = useState(false)
  const [recordingMs, setRecordingMs] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const objectUrls = useRef<string[]>([])
  /** One recording, one saved row — see {@link createCaptureGuard}. */
  const captureGuard = useRef(createCaptureGuard())

  const ids = attachmentIdsOf(value)

  const releaseUrls = useCallback(() => {
    objectUrls.current.forEach(url => URL.revokeObjectURL(url))
    objectUrls.current = []
  }, [])

  const refresh = useCallback(async () => {
    const rows = await getAttachmentsByIds(ids)
    setItems(rows)

    // Counted separately from what is displayed, because the two answer different questions.
    // The list shows what this form value references; the ceiling is enforced by the server
    // over **every** attachment of this (sheet, asset, field) — including ones another device
    // or the web panel added, which this form value has never heard of. Counting the displayed
    // rows is what let the device believe a slot was free while the server refused it.
    const forField = await getAttachmentsForEntry(
      logSheetLocalId, assetId, fieldKey, await getSessionUserId())
    const counted = new Set(rows.map(r => r.id))
    forField.forEach(r => counted.add(r.id))
    setFieldCount(counted.size)

    // A row this device holds for this field that the form value does not name is **adopted**
    // rather than left out — see {@link fieldReferenceFor}. Repairing it here is the only route
    // by which a tablet already carrying an orphan can be freed, and it happens the moment the
    // field is opened.
    //
    // `forField` is scoped to the signed-in operator, and that scoping is what makes adoption
    // safe. Unscoped it adopted the *previous* operator's media after a reassignment — the local
    // sheet row is reused, so their rows were still keyed to this field — and wrote them into
    // this operator's reading as if they had taken them. An orphan is only ever adopted by the
    // person who captured it.
    const repaired = fieldReferenceFor(forField, ids)
    if (repaired.changed && !readOnly) {
      setItems(forField)
      onChange(buildAttachmentRef(repaired.ids))
    }

    releaseUrls()
    const next = new Map<string, string>()
    for (const row of rows) {
      // Only images get an inline preview; audio is played from its own element on demand.
      if (row.kind !== 'IMAGE') continue
      let blob = row.blob
      if (!blob) {
        // The bytes were reclaimed after sync — fetch them back rather than showing a gap.
        try {
          blob = await downloadAttachment(row.id)
        } catch {
          continue
        }
      }
      const url = URL.createObjectURL(blob)
      objectUrls.current.push(url)
      next.set(row.id, url)
    }
    setPreviews(next)
  }, [ids.join(','), logSheetLocalId, assetId, fieldKey, releaseUrls]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => releaseUrls, [releaseUrls])

  // Server-owned ceilings. Read once per mount from the copy the last bootstrap stored, so
  // capture still respects them with no connection at all.
  useEffect(() => {
    void getSettings().then(s => {
      if (s.attachmentLimits) setLimits(s.attachmentLimits)
      setAnnotationEnabled(s.imageAnnotationEnabled !== false)
    })
  }, [])

  // Attach the live camera feed to the preview element. Filming blind means re-filming.
  useEffect(() => {
    const el = previewRef.current
    if (!el || !videoRecorder) return
    el.srcObject = videoRecorder.stream
    void el.play().catch(() => undefined)
    return () => {
      el.srcObject = null
    }
  }, [videoRecorder])

  /** Ceiling for this field's kind, straight from the server's settings. */
  const maxCount =
    kind === 'IMAGE'
      ? limits.maxImagesPerField
      : kind === 'AUDIO'
        ? limits.maxAudiosPerField
        : limits.maxVideosPerField

  const maxDurationMs =
    kind === 'AUDIO' ? limits.maxAudioSeconds * 1000 : limits.maxVideoSeconds * 1000

  // Elapsed-time readout while recording, so the operator can see the cap approaching.
  //
  // Clamped to the ceiling. The recorder stops itself there, so a counter that kept climbing was
  // reporting how long the screen had been open rather than how much had been recorded — which
  // is exactly the misreading that let an operator stand there for five minutes believing a
  // two-minute clip was still growing.
  useEffect(() => {
    if (!recorder && !videoRecorder) return
    const started = Date.now()
    const id = setInterval(
      () => setRecordingMs(Math.min(Date.now() - started, maxDurationMs)),
      250
    )
    return () => clearInterval(id)
  }, [recorder, videoRecorder, maxDurationMs])

  // A ceiling ends the recording exactly as if the operator had pressed stop.
  //
  // `finished` resolves for every ending — the duration cap, the byte cap, the operator — and
  // the same save handler runs in all three cases. Deliberately the *same* handler rather than a
  // parallel path: anything added to saving later (a storage check, a compression step) then
  // applies to an automatic stop for free, which a duplicate would not.
  //
  // Before this, a cap stopped the `MediaRecorder` and nothing else. The clip sat unsaved, the
  // microphone stayed live, and the operator eventually pressed a button that recorded a wildly
  // wrong duration — which the server then refused and the upload queue parked for good.
  useEffect(() => {
    const active = recorder ?? videoRecorder
    if (!active) return
    let cancelled = false
    void active.finished.then(() => {
      if (cancelled) return
      void (recorder ? handleStopRecording() : handleStopVideo())
    })
    // Only stops *this* effect from acting; it never cancels the recording itself.
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder, videoRecorder])

  // Counted from every stored row for this (asset, field) rather than from `ids` or from the
  // displayed list: `ids` can hold a reference to a row that no longer exists, and the displayed
  // list omits attachments this form value never referenced. The server counts its own rows for
  // the same triple, and the number shown here has to be the one it will enforce.
  const atLimit = fieldCount >= maxCount

  /**
   * Stores one capture and republishes the field's reference.
   *
   * <p><b>The id list is rebuilt from the device, not from the {@code ids} this render closed
   * over.</b> Two captures completing in the same tick both read the same stale {@code ids}, so
   * the second {@code onChange} overwrote the first and one of the two rows was left referenced
   * by nothing — invisible in the list, which is built from {@code ids}, yet still counted by
   * {@code getAttachmentsForEntry}, which asks the device. That is what turned a duplicated clip
   * into a field that was permanently full with nothing the operator could delete.
   *
   * <p>Reading the rows back also makes the written reference agree with the number on screen by
   * construction: the counter has always been the device's answer, and now so is the value.
   */
  const persist = async (attachment: LocalAttachment) => {
    // Stamped here, in the one place every capture path funnels through, rather than in
    // `saveAttachment`: the storage layer would have to reach back into `sessionContext` for the
    // id, and `sessionContext` already imports this module's storage — a cycle for no gain.
    // A capture with no resolvable session is still stored: refusing would lose the shot, and an
    // unowned row is handled by `isAttachmentOwnedByUser`'s legacy fallback.
    const capturedBy = await getSessionUserId()
    await saveAttachment(capturedBy ? { ...attachment, createdByUserId: capturedBy } : attachment)
    const onDevice = await getAttachmentsForEntry(logSheetLocalId, assetId, fieldKey, capturedBy)
    onChange(buildAttachmentRef(fieldReferenceFor(onDevice, ids).ids))
  }

  /**
   * Refuses a capture when the device is nearly full.
   *
   * Checked *before* the camera or microphone is used rather than at write time: a failed
   * IndexedDB write after the operator has already taken the photo loses the shot, whereas a
   * refusal up front tells them to sync first while they can still act on it.
   */
  const blockedByStorage = async (): Promise<boolean> => {
    const status = await getStorageStatus()
    if (!status.low) return false
    setError(t.attachments.lowStorage)
    return true
  }

  const persistImage = async (blob: Blob, width: number, height: number) => {
    await persist({
      id: uuidv4(),
      logSheetLocalId,
      logSheetServerId,
      assetId,
      fieldKey,
      kind: 'IMAGE',
      mimeType: blob.type,
      sizeBytes: blob.size,
      width,
      height,
      blob,
      syncStatus: 'pending',
      createdAt: Date.now()
    })
  }

  const handlePhoto = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      if (atLimit) {
        setError(t.attachments.limitReached.replace('{{max}}', String(maxCount)))
        return
      }
      if (await blockedByStorage()) return
      const { blob, width, height } = await compressImage(file)

      // With annotation switched off this is the original path, unchanged: compress, store,
      // done. With it on, the same compressed blob goes to the review step instead — the photo
      // is not stored until the operator confirms it, so cancelling leaves nothing behind.
      if (annotationEnabled) {
        setPendingCapture({ blob, width, height })
        return
      }

      await persistImage(blob, width, height)
    } catch (err) {
      setError(err instanceof Error ? err.message : t.attachments.captureFailed)
    } finally {
      setBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleAnnotationConfirm = async (result: AnnotatedImage) => {
    setPendingCapture(null)
    setBusy(true)
    setError(null)
    try {
      await persistImage(result.blob, result.width, result.height)
    } catch (err) {
      setError(err instanceof Error ? err.message : t.attachments.captureFailed)
    } finally {
      setBusy(false)
    }
  }

  /** Discard the capture and reopen the camera — the operator judged the shot itself unusable. */
  const handleAnnotationRetake = () => {
    setPendingCapture(null)
    fileInputRef.current?.click()
  }

  const handleStartRecording = async () => {
    setError(null)
    setMicBlocked(false)
    try {
      if (atLimit) {
        setError(t.attachments.limitReached.replace('{{max}}', String(maxCount)))
        return
      }
      if (await blockedByStorage()) return

      // Asked up front so a browser that has already blocked this origin is reported as such
      // rather than as a mysterious instant failure. `getUserMedia` would reject without ever
      // showing a prompt, and the operator would have nothing to click.
      const permission = await getMicrophonePermission()
      if (permission === 'denied') {
        setMicBlocked(true)
        setError(t.attachments.micBlocked)
        return
      }

      captureGuard.current.end()
      setRecorder(await startAudioRecording(maxDurationMs))
    } catch (err) {
      const failure = describeMediaError(err, (await getMicrophonePermission()) === 'denied')
      setMicBlocked(failure.needsManualGrant)
      setError(failure.message)
    }
  }

  const handleStopRecording = async () => {
    if (!recorder || !captureGuard.current.begin()) return
    setBusy(true)
    try {
      const { blob, mimeType, durationMs, endedBy } = await recorder.stop()
      await persist({
        id: uuidv4(),
        logSheetLocalId,
        logSheetServerId,
        assetId,
        fieldKey,
        kind: 'AUDIO',
        mimeType,
        sizeBytes: blob.size,
        durationMs,
        blob,
        syncStatus: 'pending',
        createdAt: Date.now()
      })
      setError(endReasonMessage(endedBy, maxDurationMs))
    } catch (err) {
      setError(err instanceof Error ? err.message : t.attachments.captureFailed)
    } finally {
      setRecorder(null)
      setRecordingMs(0)
      setBusy(false)
      captureGuard.current.end()
    }
  }

  const handleStartVideo = async () => {
    setError(null)
    setMicBlocked(false)
    try {
      if (atLimit) {
        setError(t.attachments.limitReached.replace('{{max}}', String(maxCount)))
        return
      }
      if (await blockedByStorage()) return
      captureGuard.current.end()
      setVideoRecorder(await startVideoRecording(maxDurationMs))
    } catch (err) {
      const failure = describeMediaError(err, (await getMicrophonePermission()) === 'denied')
      setMicBlocked(failure.needsManualGrant)
      setError(failure.message)
    }
  }

  const handleStopVideo = async () => {
    if (!videoRecorder || !captureGuard.current.begin()) return
    setBusy(true)
    try {
      const { blob, mimeType, durationMs, width, height, endedBy } = await videoRecorder.stop()
      await persist({
        id: uuidv4(),
        logSheetLocalId,
        logSheetServerId,
        assetId,
        fieldKey,
        kind: 'VIDEO',
        mimeType,
        sizeBytes: blob.size,
        durationMs,
        width,
        height,
        blob,
        syncStatus: 'pending',
        createdAt: Date.now()
      })
      // Said out loud rather than hidden: the operator needs to know the clip is short because a
      // ceiling cut it, not because the camera failed — and *which* ceiling, because the two ask
      // for different things next.
      setError(endReasonMessage(endedBy, maxDurationMs))
    } catch (err) {
      setError(err instanceof Error ? err.message : t.attachments.captureFailed)
    } finally {
      setVideoRecorder(null)
      setRecordingMs(0)
      setBusy(false)
      captureGuard.current.end()
    }
  }

  const handleRetry = async (id: string) => {
    await retryFailedAttachment(id)
    await refresh()
  }

  const handleRemove = async (id: string) => {
    // `removeAttachment` re-reads the row from IndexedDB rather than trusting `items`, which is
    // a snapshot from the last render: the upload queue flips rows to `synced` in the
    // background, so the screen routinely still shows `pending` for a file the server already
    // has. It queues the deletion when the server holds a copy — the sync pass then decides
    // whether to carry it there (sheet not yet submitted) or keep the server's copy as
    // delivered evidence (sheet submitted).
    await removeAttachment(id)
    // Rebuilt from the device for the same reason as `persist`: subtracting from the id
    // list this render closed over means two deletes in quick succession disagree, and
    // the loser's list resurrects a reference to a row that is already gone.
    const onDevice = await getAttachmentsForEntry(
      logSheetLocalId, assetId, fieldKey, await getSessionUserId())
    onChange(buildAttachmentRef(fieldReferenceFor(onDevice, ids).ids))
    await refresh()
  }

  return (
    <Box sx={{ mb: 2 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <Typography variant="body2" fontWeight={600}>
          {label}
        </Typography>
        <Typography variant="caption" color={atLimit ? 'warning.main' : 'text.secondary'}>
          {fieldCount} / {maxCount}
        </Typography>
        {items.length > 0 && (
          <Typography variant="caption" color="text.secondary">
            {t.attachments.pendingCount
              .replace('{{done}}', String(items.filter(i => i.syncStatus === 'synced').length))
              .replace('{{total}}', String(items.length))}
          </Typography>
        )}
      </Stack>

      {error && (
        <Alert
          severity={micBlocked ? 'warning' : 'error'}
          sx={{ mb: 1 }}
          onClose={() => {
            setError(null)
            setMicBlocked(false)
          }}
        >
          {error}
          {micBlocked && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="caption" fontWeight={700} display="block" sx={{ mb: 0.5 }}>
                {t.attachments.micHowToFix}
              </Typography>
              <Box component="ol" sx={{ m: 0, pr: 2.5, '& li': { mb: 0.25 } }}>
                {t.attachments.micHowToFixSteps.map(step => (
                  <Typography component="li" variant="caption" key={step}>
                    {step}
                  </Typography>
                ))}
              </Box>
              <Typography
                variant="caption"
                color="text.secondary"
                display="block"
                sx={{ mt: 0.75 }}
              >
                {t.attachments.micNoteVsPhoto}
              </Typography>
            </Box>
          )}
        </Alert>
      )}

      {!readOnly && (
        <Stack direction="row" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
          {kind === 'IMAGE' && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                // `capture` asks Android to open the camera directly rather than the gallery.
                capture="environment"
                hidden
                onChange={e => {
                  const file = e.target.files?.[0]
                  if (file) void handlePhoto(file)
                }}
              />
              <Button
                variant="outlined"
                startIcon={busy ? <CircularProgress size={16} /> : <PhotoCameraIcon />}
                disabled={busy || atLimit}
                onClick={() => fileInputRef.current?.click()}
              >
                {t.attachments.takePhoto}
              </Button>
            </>
          )}

          {kind === 'AUDIO' && !recorder && (
            <Button
              variant="outlined"
              startIcon={busy ? <CircularProgress size={16} /> : <MicIcon />}
              disabled={busy || atLimit}
              onClick={() => void handleStartRecording()}
            >
              {t.attachments.recordAudio}
            </Button>
          )}

          {kind === 'VIDEO' && !videoRecorder && (
            <Button
              variant="outlined"
              startIcon={busy ? <CircularProgress size={16} /> : <VideocamIcon />}
              disabled={busy || atLimit}
              onClick={() => void handleStartVideo()}
            >
              {t.attachments.recordVideo}
            </Button>
          )}
          {kind === 'VIDEO' && videoRecorder && (
            <>
              <Button
                variant="contained"
                color="error"
                startIcon={<StopIcon />}
                onClick={() => void handleStopVideo()}
              >
                {t.attachments.stopVideo} ({formatDuration(recordingMs)})
              </Button>
              <Button
                variant="text"
                onClick={() => {
                  videoRecorder.cancel()
                  setVideoRecorder(null)
                  setRecordingMs(0)
                }}
              >
                {t.form.cancel}
              </Button>
            </>
          )}
          {kind === 'AUDIO' && recorder && (
            <>
              <Button
                variant="contained"
                color="error"
                startIcon={<StopIcon />}
                onClick={() => void handleStopRecording()}
              >
                {t.attachments.stopRecording} ({formatDuration(recordingMs)})
              </Button>
              <Button
                variant="text"
                onClick={() => {
                  recorder.cancel()
                  setRecorder(null)
                  setRecordingMs(0)
                }}
              >
                {t.form.cancel}
              </Button>
            </>
          )}
        </Stack>
      )}

      {videoRecorder && (
        <Box
          component="video"
          ref={previewRef}
          muted
          playsInline
          sx={{ width: '100%', maxWidth: 320, borderRadius: 1, mb: 1, bgcolor: 'common.black' }}
        />
      )}

      {items.length === 0 && (
        <Typography variant="caption" color="text.secondary">
          {t.attachments.none}
        </Typography>
      )}

      <Stack spacing={1}>
        {items.map(item => (
          <Box
            key={item.id}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              p: 1,
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1
            }}
          >
            {item.kind === 'IMAGE' && previews.get(item.id) && (
              <Box
                component="img"
                src={previews.get(item.id)}
                alt={label}
                sx={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 1 }}
              />
            )}
            {item.kind === 'VIDEO' && (
              <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                <Box
                  component="video"
                  controls
                  preload="metadata"
                  sx={{ width: '100%', maxWidth: 260, borderRadius: 1 }}
                  src={item.blob ? URL.createObjectURL(item.blob) : undefined}
                />
              </Box>
            )}
            {item.kind === 'AUDIO' && (
              <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                <audio
                  controls
                  style={{ width: '100%', maxWidth: 260 }}
                  src={item.blob ? URL.createObjectURL(item.blob) : undefined}
                />
              </Box>
            )}

            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography variant="caption" color="text.secondary" component="div">
                {formatBytes(item.sizeBytes)}
                {item.durationMs != null && ` · ${formatDuration(item.durationMs)}`}
              </Typography>
              <SyncChip
                status={item.syncStatus}
                error={item.syncError}
                parked={item.permanentFailure}
              />
            </Box>

            {/* A parked file is never picked up again on its own, so the operator needs a way
                to re-queue it once whatever the server objected to has been fixed. */}
            {!readOnly && item.permanentFailure && (
              <IconButton
                size="small"
                onClick={() => void handleRetry(item.id)}
                aria-label={t.attachments.retry}
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            )}

            {!readOnly && (
              <IconButton size="small" color="error" onClick={() => void handleRemove(item.id)}>
                <DeleteIcon fontSize="small" />
              </IconButton>
            )}
          </Box>
        ))}
      </Stack>

      <ImageAnnotationDialog
        open={pendingCapture != null}
        source={pendingCapture?.blob ?? null}
        onCancel={() => setPendingCapture(null)}
        onRetake={handleAnnotationRetake}
        onConfirm={result => void handleAnnotationConfirm(result)}
      />
    </Box>
  )
}

/**
 * Upload state for one file, and — when the server refused it — the reason **in full**.
 *
 * The reason used to be crammed into the chip's own label, where MUI truncates it to one line
 * with an ellipsis. The server's message is the only thing that says *why* a photo was refused
 * ("the attachment limit for this field has been reached", "asset is not part of this log
 * sheet", …) and it is exactly the part that got cut off — leaving an operator, and whoever
 * they call, staring at «رد شد توسط سرور …» with nothing to act on.
 *
 * So the chip stays short and fixed, and the message is rendered underneath as ordinary
 * wrapping text: selectable, copyable, and never clipped however long it is.
 */
function SyncChip({
  status,
  error,
  parked
}: {
  status: string
  error?: string
  parked?: boolean
}) {
  if (status === 'synced') {
    return <Chip size="small" color="success" variant="outlined" icon={<CloudDoneIcon />} label={t.attachments.synced} />
  }
  if (status === 'failed') {
    return (
      <Box>
        <Chip
          size="small"
          color="error"
          // A parked row reads differently from a retrying one: filled rather than outlined,
          // and labelled as a refusal, because nothing will change until someone acts.
          variant={parked ? 'filled' : 'outlined'}
          icon={<ErrorOutlineIcon />}
          label={parked ? t.attachments.rejected : t.attachments.uploadFailed}
        />
        {error && (
          <Typography
            variant="caption"
            color="error"
            component="div"
            sx={{
              mt: 0.5,
              // The two that matter: wrap instead of clipping, and keep the server's own line
              // breaks. `user-select` because the first thing anyone does with a server error
              // is copy it into a message to whoever can fix it.
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              userSelect: 'text'
            }}
          >
            {error}
          </Typography>
        )}
      </Box>
    )
  }
  return <Chip size="small" variant="outlined" icon={<CloudQueueIcon />} label={t.attachments.pending} />
}
