import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Stack,
  Typography
} from '@mui/material'
import NfcIcon from '@mui/icons-material/Nfc'
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera'
import VideocamIcon from '@mui/icons-material/Videocam'
import MicIcon from '@mui/icons-material/Mic'
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner'
import MyLocationIcon from '@mui/icons-material/MyLocation'
import StorageIcon from '@mui/icons-material/Storage'
import { isNFCSupported, startNFCScan, stopNFCScan, resolveNfcTagId } from '@/services/nfc'
import { decoderReport, qrScanSupport, startQrScan } from '@/services/scan/qrScanner'
import { getStorageStatus } from '@/utils/storageQuota'

/**
 * «بررسی سخت‌افزار دستگاه» — an administrator standing next to a tablet, finding out which of
 * its capabilities actually work.
 *
 * <h3>Why this page exists</h3>
 *
 * An operator says «اسکن کار نمی‌کند» and there has been no way to tell, on that device,
 * whether NFC is switched off in Android settings, the WebView lacks Web NFC, camera permission
 * was denied six months ago, or location is off. Every one of those looks identical in the
 * field: a button that does nothing useful, and a support call that starts by guessing.
 *
 * <h3>Three rules it follows</h3>
 *
 * **It reports; it does not fix.** Nothing here changes a setting. A page that quietly asked
 * for every permission on load would teach an operator to press «رد» — so each row asks only
 * when its own button is pressed, and never on mount.
 *
 * **It shows the raw answer, not a verdict.** «NFC در دسترس نیست» sends somebody to the wrong
 * place half the time; «`NDEFReader` تعریف نشده» names what to do about it. The reader is an
 * administrator who can act on a specific fact.
 *
 * **It never talks to the server.** Every check is local to the device, so it works on a tablet
 * that cannot reach the plant network — which is exactly the tablet somebody is most likely to
 * be standing next to with a complaint.
 */

type Outcome =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ok'; detail: string }
  | { state: 'fail'; detail: string }

const IDLE: Outcome = { state: 'idle' }

/**
 * One line about this device's decoder, for an administrator standing next to a tablet.
 *
 * <p>It leads with the only thing that can go wrong now — whether the WebAssembly file loaded —
 * and names its URL when it did not, because the one realistic cause is that the install is
 * missing it (a service worker that precached everything else, or an APK built before the decoder
 * was bundled). That is a fact somebody can act on; «اسکن کار نمی‌کند» is not.
 *
 * <p>What `BarcodeDetector` claims is reported **last and as context only**. Nothing in the scan
 * path consults it any more, and on the devices this decoder was introduced for it is actively
 * misleading: it answers with a plausible list of formats and then reads nothing at all. It is
 * here so that a tablet whose history includes that failure can still be recognised.
 */
function describeDecoder(report: Awaited<ReturnType<typeof decoderReport>>): string {
  const platform =
    report.platformDetectorFormats === null
      ? 'BarcodeDetector موجود نیست (بی‌اهمیت؛ استفاده نمی‌شود)'
      : report.platformDetectorFormats.length === 0
        ? 'BarcodeDetector فهرست خالی داد (بی‌اهمیت؛ استفاده نمی‌شود)'
        : `BarcodeDetector: ${report.platformDetectorFormats.join(', ')} (استفاده نمی‌شود)`

  if (report.loaded === false) {
    return (
      `رمزگشا بارگذاری نشد — فایل ${report.wasmUrl} در این نسخهٔ نصب‌شده نیست.` +
      ` علت: ${report.error ?? 'نامشخص'} — ${platform}`
    )
  }

  return (
    `رمزگشا: ${report.decoder}${report.loaded === true ? ` ${report.version}` : ''}` +
    ` — می‌خواند: ${report.families.join(' + ')} — ${platform}`
  )
}

function OutcomeChip({ outcome }: { outcome: Outcome }) {
  if (outcome.state === 'idle') return <Chip size="small" variant="outlined" label="آزمایش نشده" />
  if (outcome.state === 'running') return <Chip size="small" color="info" label="در حال آزمایش…" />
  if (outcome.state === 'ok') return <Chip size="small" color="success" label="سالم" />
  return <Chip size="small" color="error" label="مشکل دارد" />
}

interface CheckRowProps {
  icon: React.ReactNode
  title: string
  hint: string
  outcome: Outcome
  actionLabel: string
  onRun: () => void
  onCancel?: () => void
  /** A second, cheaper check beside the main one — one that needs no permission. */
  secondaryLabel?: string
  onSecondary?: () => void
  children?: React.ReactNode
}

function CheckRow({
  icon,
  title,
  hint,
  outcome,
  actionLabel,
  onRun,
  onCancel,
  secondaryLabel,
  onSecondary,
  children
}: CheckRowProps) {
  const running = outcome.state === 'running'
  return (
    <Card variant="outlined">
      <CardContent sx={{ pb: '12px !important' }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
          {icon}
          <Typography variant="subtitle2" fontWeight={700} sx={{ flexGrow: 1 }}>
            {title}
          </Typography>
          <OutcomeChip outcome={outcome} />
        </Stack>

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          {hint}
        </Typography>

        {(outcome.state === 'ok' || outcome.state === 'fail') && (
          <Alert
            severity={outcome.state === 'ok' ? 'success' : 'error'}
            sx={{ mb: 1, py: 0.25, '& .MuiAlert-message': { fontSize: '0.78rem', wordBreak: 'break-word' } }}
          >
            {outcome.detail}
          </Alert>
        )}

        {children}

        <Stack direction="row" spacing={1}>
          <Button
            size="small"
            variant="outlined"
            fullWidth
            onClick={running && onCancel ? onCancel : onRun}
            disabled={running && !onCancel}
          >
            {running && onCancel ? 'لغو' : actionLabel}
          </Button>
          {secondaryLabel && onSecondary && (
            <Button
              size="small"
              variant="text"
              fullWidth
              onClick={onSecondary}
              disabled={running}
            >
              {secondaryLabel}
            </Button>
          )}
        </Stack>
      </CardContent>
    </Card>
  )
}

export function DeviceCheckPage() {
  const [nfc, setNfc] = useState<Outcome>(IDLE)
  const [camera, setCamera] = useState<Outcome>(IDLE)
  const [video, setVideo] = useState<Outcome>(IDLE)
  const [mic, setMic] = useState<Outcome>(IDLE)
  const [scan, setScan] = useState<Outcome>(IDLE)
  const [gps, setGps] = useState<Outcome>(IDLE)
  const [storage, setStorage] = useState<Outcome>(IDLE)

  const scanContainer = useRef<HTMLDivElement | null>(null)
  const stopScanSession = useRef<(() => void) | null>(null)

  // Nothing may outlive the page: a camera track or an NFC reader left running keeps the
  // sensor powered and its indicator lit, which an operator reasonably reads as being watched.
  useEffect(() => {
    return () => {
      stopScanSession.current?.()
      stopNFCScan()
    }
  }, [])

  const runNfc = async () => {
    if (!isNFCSupported()) {
      setNfc({
        state: 'fail',
        detail: 'NDEFReader تعریف نشده — این مرورگر یا WebView از Web NFC پشتیبانی نمی‌کند. '
          + 'روی اندروید، Chrome یا نسخهٔ نصب‌شدهٔ اپ را امتحان کنید.'
      })
      return
    }
    setNfc({ state: 'running' })
    await startNFCScan(result => {
      if (!result.success || !result.tagData) {
        setNfc({ state: 'fail', detail: result.error ?? 'تگ خوانده نشد.' })
        stopNFCScan()
        return
      }
      const tagId = resolveNfcTagId(result.tagData) ?? '—'
      const serial = result.tagData.serialNumber ?? '—'
      setNfc({ state: 'ok', detail: `شناسه (رکورد ۱): ${tagId} · سریال سخت‌افزاری: ${serial}` })
      stopNFCScan()
    })
  }

  const cancelNfc = () => {
    stopNFCScan()
    setNfc(IDLE)
  }

  /** One helper for the three getUserMedia checks: they differ only in constraints and wording. */
  const runMedia = async (
    constraints: MediaStreamConstraints,
    set: (o: Outcome) => void,
    describe: (tracks: MediaStreamTrack[]) => string
  ) => {
    set({ state: 'running' })
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      const tracks = stream.getTracks()
      const detail = describe(tracks)
      // Released immediately — this is a permission and presence check, not a recording.
      tracks.forEach(t => t.stop())
      set({ state: 'ok', detail })
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error'
      const message = err instanceof Error ? err.message : String(err)
      set({
        state: 'fail',
        detail:
          name === 'NotAllowedError'
            ? 'دسترسی رد شده است. از تنظیمات مرورگر/اپ، اجازه را برای این آدرس فعال کنید.'
            : name === 'NotFoundError'
              ? 'چنین دستگاهی پیدا نشد.'
              : `${name}: ${message}`
      })
    }
  }

  const runScan = async () => {
    const support = qrScanSupport()
    if (support !== 'available') {
      setScan({
        state: 'fail',
        detail: support === 'noDecoder'
          ? 'هیچ رابط دوربینی در دسترس نیست (navigator.mediaDevices تعریف نشده).'
          : 'دوربینی پیدا نشد.'
      })
      return
    }
    setScan({ state: 'running' })
    try {
      // Whether the decoder loaded, before the camera opens. The question this answers has got
      // much smaller than it used to be: the decoder ships inside the app, so there is no longer
      // a platform module whose absence silently removes linear barcodes — just one file that
      // either loaded or did not, and a reason when it did not.
      const readable = describeDecoder(await decoderReport())

      // Both families, because an admin wants to know what this tablet can do, not what one
      // field happens to ask for.
      const session = await startQrScan({ families: ['qr', 'barcode'] })
      stopScanSession.current = session.stop
      scanContainer.current?.replaceChildren(session.video)
      session.video.style.width = '100%'
      const value = await session.result
      session.stop()
      stopScanSession.current = null
      scanContainer.current?.replaceChildren()
      setScan({ state: 'ok', detail: `خوانده شد: ${value} — ${readable}` })
    } catch (err) {
      stopScanSession.current?.()
      stopScanSession.current = null
      scanContainer.current?.replaceChildren()
      setScan({
        state: 'fail',
        detail: err instanceof Error ? `${err.name}: ${err.message}` : 'اسکن ناموفق بود.'
      })
    }
  }

  /** The decoder answer on its own, with no camera opened and no permission requested. */
  const runDecoderProbe = async () => {
    setScan({ state: 'running' })
    try {
      const report = await decoderReport()
      setScan({
        // A decoder that did not load is a fault, not a report: it means the WebAssembly file is
        // missing from this install, and no amount of aiming the camera will fix it.
        state: report.loaded === false ? 'fail' : 'ok',
        detail: describeDecoder(report)
      })
    } catch (err) {
      setScan({
        state: 'fail',
        detail: err instanceof Error ? `${err.name}: ${err.message}` : 'بررسی رمزگشا ناموفق بود.'
      })
    }
  }

  const cancelScan = () => {
    stopScanSession.current?.()
    stopScanSession.current = null
    scanContainer.current?.replaceChildren()
    setScan(IDLE)
  }

  const runGps = () => {
    if (!navigator.geolocation) {
      setGps({ state: 'fail', detail: 'navigator.geolocation تعریف نشده است.' })
      return
    }
    setGps({ state: 'running' })
    const began = Date.now()
    navigator.geolocation.getCurrentPosition(
      pos => {
        const seconds = ((Date.now() - began) / 1000).toFixed(1)
        setGps({
          state: 'ok',
          detail: `دقت: ${Math.round(pos.coords.accuracy)} متر · زمان دریافت: ${seconds} ثانیه`
        })
      },
      err => setGps({ state: 'fail', detail: `${err.code}: ${err.message}` }),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    )
  }

  const runStorage = async () => {
    setStorage({ state: 'running' })
    try {
      const status = await getStorageStatus()
      if (status.usage == null || status.quota == null) {
        // `navigator.storage.estimate` is absent, or declined to answer. Reported as its own
        // fact rather than as zero bytes used, which would read as a healthy empty device.
        setStorage({ state: 'fail', detail: 'این مرورگر سهمیهٔ حافظه را گزارش نمی‌کند.' })
        return
      }
      const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(0)
      const detail = `مصرف‌شده: ${mb(status.usage)} مگابایت از ${mb(status.quota)} مگابایت`
      setStorage(
        status.low
          ? { state: 'fail', detail: `${detail} — فضا رو به اتمام است؛ ضبط پیوست رد می‌شود.` }
          : { state: 'ok', detail }
      )
    } catch (err) {
      setStorage({
        state: 'fail',
        detail: err instanceof Error ? err.message : 'وضعیت حافظه خوانده نشد.'
      })
    }
  }

  return (
    <Box sx={{ p: 2, maxWidth: 680, mx: 'auto' }}>
      <Typography variant="h6" fontWeight={700} gutterBottom>
        بررسی سخت‌افزار دستگاه
      </Typography>
      <Alert severity="info" sx={{ mb: 2, py: 0.5 }}>
        این صفحه فقط همین دستگاه را آزمایش می‌کند و چیزی به سرور نمی‌فرستد. هیچ تنظیمی را هم
        تغییر نمی‌دهد — فقط گزارش می‌دهد. هر آزمایش وقتی اجرا می‌شود که دکمه‌اش را بزنید.
      </Alert>

      <Stack spacing={1.5}>
        <CheckRow
          icon={<NfcIcon fontSize="small" color="primary" />}
          title="تگ NFC"
          hint="یک تگ را به پشت دستگاه نزدیک کنید. شناسهٔ رکورد ۱ و سریال سخت‌افزاری نمایش داده می‌شود."
          outcome={nfc}
          actionLabel="خواندن یک تگ"
          onRun={() => void runNfc()}
          onCancel={cancelNfc}
        />

        <CheckRow
          icon={<PhotoCameraIcon fontSize="small" color="primary" />}
          title="دوربین (عکس)"
          hint="فقط دسترسی و وجود دوربین را بررسی می‌کند؛ عکسی گرفته و ذخیره نمی‌شود."
          outcome={camera}
          actionLabel="آزمایش دوربین"
          onRun={() =>
            void runMedia({ video: { facingMode: 'environment' } }, setCamera, tracks =>
              `دوربین باز شد: ${tracks[0]?.label || 'بدون نام'}`)
          }
        />

        <CheckRow
          icon={<VideocamIcon fontSize="small" color="primary" />}
          title="ویدئو (تصویر + صدا)"
          hint="هر دو مجوز با هم گرفته می‌شود، همان‌طور که ضبط ویدئو نیاز دارد."
          outcome={video}
          actionLabel="آزمایش ویدئو"
          onRun={() =>
            void runMedia({ video: true, audio: true }, setVideo, tracks =>
              `${tracks.filter(t => t.kind === 'video').length} مسیر تصویر و `
              + `${tracks.filter(t => t.kind === 'audio').length} مسیر صدا`)
          }
        />

        <CheckRow
          icon={<MicIcon fontSize="small" color="primary" />}
          title="میکروفن"
          hint="برای یادداشت صوتی لازم است."
          outcome={mic}
          actionLabel="آزمایش میکروفن"
          onRun={() =>
            void runMedia({ audio: true }, setMic, tracks =>
              `میکروفن باز شد: ${tracks[0]?.label || 'بدون نام'}`)
          }
        />

        <CheckRow
          icon={<QrCodeScannerIcon fontSize="small" color="primary" />}
          title="اسکن QR و بارکد"
          hint="دوربین را روی یک برچسب QR یا بارکد خطی بگیرید. مقدار خوانده‌شده نمایش داده می‌شود و هیچ‌جا ذخیره نمی‌شود. «رمزگشا» دوربین را باز نمی‌کند و فقط می‌گوید رمزگشای داخلی برنامه بارگذاری می‌شود یا نه — این تنها چیزی است که می‌تواند اشکال داشته باشد، چون رمزگشا دیگر به گوگل پلی سرویس و به شبکه نیازی ندارد."
          outcome={scan}
          actionLabel="آزمایش اسکن"
          onRun={() => void runScan()}
          onCancel={cancelScan}
          secondaryLabel="رمزگشا"
          onSecondary={() => void runDecoderProbe()}
        >
          {/* React renders nothing into this element; the scanner puts its <video> here by
              hand. Mixing the two crashed the app once — see AGENTS.md #169. */}
          <Box ref={scanContainer} sx={{ mb: scan.state === 'running' ? 1 : 0 }} />
        </CheckRow>

        <CheckRow
          icon={<MyLocationIcon fontSize="small" color="primary" />}
          title="موقعیت مکانی (GPS)"
          hint="یک موقعیت می‌گیرد و دقت و زمان دریافت آن را نشان می‌دهد. مختصات ذخیره نمی‌شود."
          outcome={gps}
          actionLabel="گرفتن موقعیت"
          onRun={runGps}
        />

        <CheckRow
          icon={<StorageIcon fontSize="small" color="primary" />}
          title="فضای ذخیره‌سازی"
          hint="همان سنجه‌ای که ضبط پیوست را در فضای کم متوقف می‌کند."
          outcome={storage}
          actionLabel="بررسی فضا"
          onRun={() => void runStorage()}
        />
      </Stack>
    </Box>
  )
}
