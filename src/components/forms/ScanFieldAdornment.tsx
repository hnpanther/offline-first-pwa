import { useEffect, useRef, useState } from 'react'
import { CircularProgress, IconButton, Stack, Tooltip } from '@mui/material'
import NfcIcon from '@mui/icons-material/Nfc'
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner'
import { QrScanDialog } from '@/components/logsheet/QrScanDialog'
import { qrScanSupport } from '@/services/scan/qrScanner'
import { claimNextTagForField } from '@/services/scan/nfcFieldCapture'
import { scannedFieldValue, type ScanFieldConfig } from '@/services/scan/scanFieldFill'
import { resolveNfcTagId } from '@/services/nfc'
import { isNFCSupported } from '@/services/nfc'
import { useNFC } from '@/hooks/useNFC'

interface ScanFieldAdornmentProps {
  config: ScanFieldConfig
  /** Receives the trimmed payload, and writes it into the field the operator would have typed. */
  onValue: (value: string) => void
  /** Surfaced beside the input rather than thrown, so a failed read does not lose the form. */
  onError: (message: string | null) => void
}

/**
 * The small scan buttons that live **inside** a text or number input.
 *
 * <h3>Why it is an adornment and not a block above the field</h3>
 *
 * It was a block once, and the field lost its label: a row of large buttons with the input
 * underneath reads as a control of its own rather than as "this field, which you may also
 * scan". Sitting in the input's `endAdornment` the field keeps its label, its helper text, its
 * severity colouring and its validation — everything that makes it look like every other field
 * on the form — and the scan is one small icon at the end of it.
 *
 * <h3>What a scan does, and what it carefully does not</h3>
 *
 * It writes the payload into the same react-hook-form value the operator would have typed, so
 * the field's own rules still judge it: a `number` field still refuses `ABC-123`. It does
 * **not** touch `filledVia` — that records how the *asset* was reached, and a field scanned on
 * an asset the operator already opened says nothing about that.
 *
 * <h3>The NFC claim</h3>
 *
 * There is one reader and one `lastScannedTag` in the store, and the fill page is also
 * listening in order to answer "which asset is this?". A nameplate tag is deliberately not an
 * asset on this round, so without a claim the page would reject the very scan that just
 * succeeded. {@link claimNextTagForField} makes the page stand down for exactly one read, and
 * the claim is released on unmount as well as after use.
 */
export function ScanFieldAdornment({ config, onValue, onError }: ScanFieldAdornmentProps) {
  const [qrOpen, setQrOpen] = useState(false)
  const [awaitingTag, setAwaitingTag] = useState(false)
  const [qrSupport] = useState(() => qrScanSupport())
  const [nfcSupported] = useState(() => isNFCSupported())
  const { startScan, stopScan } = useNFC()
  const releaseClaim = useRef<(() => void) | null>(null)

  // A claim that outlives its component would leave the page deaf to tags for good.
  useEffect(() => {
    return () => {
      releaseClaim.current?.()
      releaseClaim.current = null
    }
  }, [])

  const take = (payload: string | null | undefined) => {
    const value = scannedFieldValue(payload)
    if (!value) {
      onError('چیزی خوانده نشد؛ دوباره تلاش کنید.')
      return
    }
    onError(null)
    onValue(value)
  }

  const offersNfc = config.sources.includes('NFC') && nfcSupported
  // QR and 1-D barcode share one camera session: the platform decoder is asked for the formats
  // it supports, and the bundled fallback reads QR. One button for both, labelled by what the
  // field actually allows.
  const offersCamera = config.sources.includes('QR') || config.sources.includes('BARCODE')
  const cameraLabel =
    config.sources.includes('QR') && config.sources.includes('BARCODE')
      ? 'اسکن QR یا بارکد'
      : config.sources.includes('QR')
        ? 'اسکن QR'
        : 'اسکن بارکد'

  const beginNfc = () => {
    onError(null)
    setAwaitingTag(true)
    releaseClaim.current?.()
    releaseClaim.current = claimNextTagForField(tag => {
      setAwaitingTag(false)
      releaseClaim.current = null
      stopScan()
      // Record 1's payload, decoded exactly as the asset path decodes it — one reader of a
      // tag, so a tag cannot mean two things depending on which control asked.
      take(resolveNfcTagId(tag))
    })
    void startScan()
  }

  const cancelNfc = () => {
    releaseClaim.current?.()
    releaseClaim.current = null
    setAwaitingTag(false)
    stopScan()
  }

  return (
    <Stack direction="row" spacing={0.25} alignItems="center">
      {offersNfc && (
        <Tooltip title={awaitingTag ? 'در انتظار تگ — برای لغو بزنید' : 'خواندن از تگ NFC'}>
          <IconButton
            size="small"
            edge="end"
            color={awaitingTag ? 'primary' : 'default'}
            onClick={awaitingTag ? cancelNfc : beginNfc}
          >
            {awaitingTag ? <CircularProgress size={16} /> : <NfcIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      )}

      {offersCamera && (
        <Tooltip
          title={qrSupport === 'available' ? cameraLabel : 'دوربین در دسترس نیست'}
        >
          {/* A span, because MUI cannot attach a tooltip to a disabled button. */}
          <span>
            <IconButton
              size="small"
              edge="end"
              disabled={qrSupport !== 'available'}
              onClick={() => {
                onError(null)
                setQrOpen(true)
              }}
            >
              <QrCodeScannerIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      )}

      <QrScanDialog
        open={qrOpen}
        onDetected={value => {
          setQrOpen(false)
          take(value)
        }}
        onClose={() => setQrOpen(false)}
      />
    </Stack>
  )
}
