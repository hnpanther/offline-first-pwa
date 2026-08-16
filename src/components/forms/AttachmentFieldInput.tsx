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
  deleteAttachment,
  getAttachmentsByIds,
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
  type VideoRecorderHandle
} from '@/utils/mediaCapture'
import { getSettings } from '@/services/storage'
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

  const ids = attachmentIdsOf(value)

  const releaseUrls = useCallback(() => {
    objectUrls.current.forEach(url => URL.revokeObjectURL(url))
    objectUrls.current = []
  }, [])

  const refresh = useCallback(async () => {
    const rows = await getAttachmentsByIds(ids)
    setItems(rows)

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
  }, [ids.join(','), releaseUrls]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // Elapsed-time readout while recording, so the operator can see the cap approaching.
  useEffect(() => {
    if (!recorder && !videoRecorder) return
    const started = Date.now()
    const id = setInterval(() => setRecordingMs(Date.now() - started), 250)
    return () => clearInterval(id)
  }, [recorder, videoRecorder])

  /** Ceiling for this field's kind, straight from the server's settings. */
  const maxCount =
    kind === 'IMAGE'
      ? limits.maxImagesPerField
      : kind === 'AUDIO'
        ? limits.maxAudiosPerField
        : limits.maxVideosPerField

  const maxDurationMs =
    kind === 'AUDIO' ? limits.maxAudioSeconds * 1000 : limits.maxVideoSeconds * 1000

  // Counted from the stored rows rather than from `ids`, so a reference left dangling by a
  // deleted row cannot silently consume a slot the operator can never free.
  const atLimit = items.length >= maxCount

  const persist = async (attachment: LocalAttachment) => {
    await saveAttachment(attachment)
    onChange(buildAttachmentRef([...ids, attachment.id]))
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

      setRecorder(await startAudioRecording(maxDurationMs))
    } catch (err) {
      const failure = describeMediaError(err, (await getMicrophonePermission()) === 'denied')
      setMicBlocked(failure.needsManualGrant)
      setError(failure.message)
    }
  }

  const handleStopRecording = async () => {
    if (!recorder) return
    setBusy(true)
    try {
      const { blob, mimeType, durationMs, truncated } = await recorder.stop()
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
      if (truncated) setError(t.attachments.truncatedBySize)
    } catch (err) {
      setError(err instanceof Error ? err.message : t.attachments.captureFailed)
    } finally {
      setRecorder(null)
      setRecordingMs(0)
      setBusy(false)
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
      setVideoRecorder(await startVideoRecording(maxDurationMs))
    } catch (err) {
      const failure = describeMediaError(err, (await getMicrophonePermission()) === 'denied')
      setMicBlocked(failure.needsManualGrant)
      setError(failure.message)
    }
  }

  const handleStopVideo = async () => {
    if (!videoRecorder) return
    setBusy(true)
    try {
      const { blob, mimeType, durationMs, width, height, truncated } = await videoRecorder.stop()
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
      // Said out loud rather than hidden: the operator needs to know the clip is short because
      // the size ceiling cut it, not because the camera failed.
      if (truncated) setError(t.attachments.truncatedBySize)
    } catch (err) {
      setError(err instanceof Error ? err.message : t.attachments.captureFailed)
    } finally {
      setVideoRecorder(null)
      setRecordingMs(0)
      setBusy(false)
    }
  }

  const handleRetry = async (id: string) => {
    await retryFailedAttachment(id)
    await refresh()
  }

  const handleRemove = async (id: string) => {
    // Local-only removal. The server copy (if any) is left alone deliberately: a submitted
    // sheet's evidence should not vanish because someone tidied their device.
    await deleteAttachment(id)
    onChange(buildAttachmentRef(ids.filter(existing => existing !== id)))
  }

  return (
    <Box sx={{ mb: 2 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <Typography variant="body2" fontWeight={600}>
          {label}
        </Typography>
        <Typography variant="caption" color={atLimit ? 'warning.main' : 'text.secondary'}>
          {items.length} / {maxCount}
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
      <Chip
        size="small"
        color="error"
        // A parked row reads differently from a retrying one: filled rather than outlined, and
        // labelled as a refusal, because nothing will change until someone acts.
        variant={parked ? 'filled' : 'outlined'}
        icon={<ErrorOutlineIcon />}
        label={
          parked
            ? `${t.attachments.rejected}${error ? ` — ${error}` : ''}`
            : error || t.attachments.uploadFailed
        }
      />
    )
  }
  return <Chip size="small" variant="outlined" icon={<CloudQueueIcon />} label={t.attachments.pending} />
}
