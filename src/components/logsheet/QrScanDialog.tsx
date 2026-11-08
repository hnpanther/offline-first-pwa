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
import { startQrScan, type QrScanSession } from '@/services/scan/qrScanner'

interface QrScanDialogProps {
  open: boolean
  /** Called with the decoded payload — the asset's tag id, exactly as the sticker carries it. */
  onDetected: (value: string) => void
  onClose: () => void
}

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
 */
export function QrScanDialog({ open, onDetected, onClose }: QrScanDialogProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    if (!open) return
    let session: QrScanSession | null = null
    let cancelled = false
    setError(null)
    setStarting(true)

    void (async () => {
      try {
        session = await startQrScan()
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
      session?.stop()
    }
    // `onDetected` is deliberately out: the page re-creates it on every render, and including it
    // would restart the camera between frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <QrCodeScannerIcon fontSize="small" color="primary" />
        اسکن QR Code
      </DialogTitle>
      <DialogContent>
        {error ? (
          <Alert severity="error">{error}</Alert>
        ) : (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              دوربین را روی برچسب QR دارایی بگیرید.
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
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>انصراف</Button>
      </DialogActions>
    </Dialog>
  )
}
