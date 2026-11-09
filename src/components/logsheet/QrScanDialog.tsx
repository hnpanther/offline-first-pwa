import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography
} from '@mui/material'
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner'
import {
  startQrScan,
  type CodeFamily,
  type QrScanSession,
  type QrScanStats
} from '@/services/scan/qrScanner'
import { scanInstruction, scanTitle, wrongKindMessage } from '@/services/scan/scanDialogText'

interface QrScanDialogProps {
  open: boolean
  /** Called with the decoded payload — the asset's tag id, exactly as the sticker carries it. */
  onDetected: (value: string) => void
  onClose: () => void
  /**
   * What to look for. Defaults to QR, which is what an asset sticker carries. A field whose
   * administrator allowed `BARCODE` passes that too, and only then does the camera session ask
   * the platform decoder for the linear symbologies.
   */
  families?: CodeFamily[]
  /** Overrides the title, for a dialog reading a field rather than identifying an asset. */
  title?: string
}

/** How long a camera may show nothing before the operator is told what is being tried. */
const DIAGNOSTIC_DELAY_MS = 4000

/**
 * The camera, while the operator aims it at a sticker.
 *
 * <h3>Why the session is owned here and not by the page</h3>
 *
 * A camera track that outlives its dialog keeps the sensor powered and the indicator light on.
 * On a tablet that stays on one screen for a whole shift that is both a battery cost and
 * something an operator reasonably reads as the app watching them. So the session starts when
 * this dialog opens and is stopped by its cleanup — on close, on a successful read, and on
 * unmount, including the unmount that a navigation causes.
 *
 * <h3>Why the video element comes from the service</h3>
 *
 * The decoder reads frames from an element it already holds, so handing React a ref to a
 * *different* element would mean two: one being decoded and one being shown. The service's
 * element is mounted into this container instead, which keeps exactly one.
 *
 * <h3>Why it reports on itself after a few seconds</h3>
 *
 * Because "the camera is on and nothing is happening" used to be the end of the story, and it
 * is the one state where the operator cannot tell a blurry label from a broken decoder. After
 * {@link DIAGNOSTIC_DELAY_MS} the dialog says which decoder is running, how many frames it has
 * looked at, and the last error if there was one. A frame count of zero means the camera; a
 * rising count with no result means aim, light or focus. That line is what turns the next
 * report from a plant into something answerable.
 */
export function QrScanDialog({
  open,
  onDetected,
  onClose,
  families,
  title
}: QrScanDialogProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [stats, setStats] = useState<QrScanStats | null>(null)
  // The session is polled from the start, so a code of the wrong kind is explained the moment it
  // is seen; only the general diagnostics line waits, because on a scan that works it is noise.
  const [showDiagnostics, setShowDiagnostics] = useState(false)

  // `families` is an array literal at most call sites, so a new identity on every render. Keyed
  // on its content instead: including the array itself would restart the camera continuously.
  const familyKey = (families ?? ['qr']).join(',')

  useEffect(() => {
    if (!open) return
    let session: QrScanSession | null = null
    let cancelled = false
    let diagnosticTimer: ReturnType<typeof setInterval> | null = null
    let diagnosticDelay: ReturnType<typeof setTimeout> | null = null
    setError(null)
    setStats(null)
    setShowDiagnostics(false)
    setStarting(true)

    void (async () => {
      try {
        session = await startQrScan({ families: familyKey.split(',') as CodeFamily[] })
        if (cancelled) {
          session.stop()
          return
        }
        const container = containerRef.current
        if (container) {
          session.video.style.width = '100%'
          session.video.style.borderRadius = '8px'
          container.replaceChildren(session.video)
        }
        setStarting(false)

        const live = session
        diagnosticTimer = setInterval(() => {
          if (!cancelled) setStats(live.stats())
        }, 500)
        diagnosticDelay = setTimeout(() => {
          if (!cancelled) setShowDiagnostics(true)
        }, DIAGNOSTIC_DELAY_MS)

        const value = await session.result
        if (!cancelled) onDetected(value)
      } catch (err) {
        if (cancelled) return
        setStarting(false)
        setError(
          err instanceof Error && err.message
            ? err.message
            : 'دوربین باز نشد. دسترسی دوربین را بررسی کنید.'
        )
      }
    })()

    return () => {
      cancelled = true
      if (diagnosticDelay) clearTimeout(diagnosticDelay)
      if (diagnosticTimer) clearInterval(diagnosticTimer)
      session?.stop()
    }
    // `onDetected` is deliberately out: the page re-creates it on every render, and including it
    // would restart the camera between frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, familyKey])

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <QrCodeScannerIcon fontSize="small" color="primary" />
        {title ?? scanTitle(families)}
      </DialogTitle>
      <DialogContent>
        {error ? (
          <Alert severity="error">{error}</Alert>
        ) : (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              {scanInstruction(families)}
            </Typography>
            {/* Two elements, and they must stay two.

                The video is a DOM node this component inserts by hand, so the element it goes
                into has to be one React never renders children into — `containerRef`'s Box is
                deliberately empty in JSX. Putting the spinner inside it crashed the whole app:
                `replaceChildren` deleted the <CircularProgress> React had rendered there, and
                React's next attempt to remove that child threw NotFoundError, which is an
                unhandled render error and therefore a white screen. See AGENTS.md #169. */}
            <Box
              sx={{
                position: 'relative',
                minHeight: 200,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: 'action.hover',
                borderRadius: 1,
                overflow: 'hidden'
              }}
            >
              <Box ref={containerRef} sx={{ width: '100%', display: 'flex' }} />
              {starting && (
                <CircularProgress
                  size={28}
                  sx={{ position: 'absolute', top: '50%', left: '50%', mt: '-14px', ml: '-14px' }}
                />
              )}
            </Box>
            {stats?.ignoredFamily && (
              <Alert severity="warning" sx={{ mt: 1.5 }} data-testid="scan-wrong-kind">
                {wrongKindMessage(stats.ignoredFamily)}
              </Alert>
            )}
            {showDiagnostics && stats && <ScanDiagnostics stats={stats} />}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>انصراف</Button>
      </DialogActions>
    </Dialog>
  )
}

const DECODER_LABEL: Record<QrScanStats['decoder'], string> = {
  native: 'رمزگشای دستگاه',
  jsqr: 'رمزگشای داخلی برنامه',
  'native-app': 'اسکنر نیتیو'
}

/**
 * The line that makes a failed scan answerable.
 *
 * Deliberately plain and deliberately specific: a frame count that stays at zero is a camera
 * problem, a rising one with no result is aim, light or focus, and a `lastError` is the decoder
 * itself. Those three were indistinguishable before, which is why a real fault in the platform
 * decoder read to everyone — including this author — as "QR does not work".
 */
function ScanDiagnostics({ stats }: { stats: QrScanStats }) {
  const noFrames = stats.framesTried === 0
  return (
    <Alert severity={noFrames || stats.lastError ? 'warning' : 'info'} sx={{ mt: 1.5 }}>
      <Typography variant="caption" component="div">
        {DECODER_LABEL[stats.decoder]} — {stats.framesTried} فریم بررسی شد
      </Typography>
      {noFrames && (
        <Typography variant="caption" component="div">
          دوربین هنوز تصویری نداده است؛ دسترسی دوربین را بررسی کنید.
        </Typography>
      )}
      {!noFrames && !stats.lastError && (
        <Typography variant="caption" component="div">
          کد خوانده نشد: فاصله، نور و تمیزی برچسب را بررسی کنید.
        </Typography>
      )}
      {stats.lastError && (
        <Typography variant="caption" component="div" sx={{ direction: 'ltr' }}>
          {stats.lastError}
        </Typography>
      )}
    </Alert>
  )
}
