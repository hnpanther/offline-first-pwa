import { useEffect, useState } from 'react'
import { Alert, Button, Typography, Collapse } from '@mui/material'
import GetAppIcon from '@mui/icons-material/GetApp'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent)
}

function isMobile(): boolean {
  return isIos() || isAndroid()
}

export function InstallPwaPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [isStandalone, setIsStandalone] = useState(false)
  const [showHelp, setShowHelp] = useState(false)

  const secureContext = window.isSecureContext
  const mobile = isMobile()
  const ios = isIos()

  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    setIsStandalone(standalone)

    const onBip = (e: Event) => {
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onBip)
    return () => window.removeEventListener('beforeinstallprompt', onBip)
  }, [])

  if (isStandalone || dismissed) return null

  const onDevPort = window.location.port === '5173'

  // Chrome install banner (trusted HTTPS + engagement criteria)
  if (deferred) {
    return (
      <Alert
        severity="info"
        sx={{ mb: 2 }}
        icon={<GetAppIcon />}
        action={
          <Button
            color="inherit"
            size="small"
            onClick={() => {
              void deferred.prompt().then(() => setDismissed(true))
            }}
          >
            نصب
          </Button>
        }
        onClose={() => setDismissed(true)}
      >
        این اپ را روی دستگاه نصب کنید تا آفلاین و مثل برنامه بومی اجرا شود.
      </Alert>
    )
  }

  // Mobile / dev: manual install guidance (beforeinstallprompt often missing with self-signed HTTPS)
  if (!mobile) return null

  if (onDevPort) {
    return (
      <Alert severity="warning" sx={{ mb: 2 }} onClose={() => setDismissed(true)}>
        <Typography variant="body2" fontWeight={600} gutterBottom>
          نصب از dev (5173) آفلاین کار نمی‌کند
        </Typography>
        <Typography variant="body2" component="div">
          برای PWA آفلاین: روی PC اجرا کنید{' '}
          <strong>npm run build:mobile</strong> و <strong>npm run preview:mobile</strong>، سپس از{' '}
          <strong>:4173</strong> نصب کنید.
        </Typography>
      </Alert>
    )
  }

  return (
    <Alert
      severity="info"
      sx={{ mb: 2 }}
      icon={<GetAppIcon />}
      onClose={() => setDismissed(true)}
    >
      <Typography variant="body2" fontWeight={600} gutterBottom>
        نصب اپ روی گوشی
      </Typography>
      {ios ? (
        <Typography variant="body2" component="div">
          در Safari: دکمه <strong>Share (اشتراک‌گذاری)</strong> →{' '}
          <strong>Add to Home Screen (افزودن به صفحه اصلی)</strong>
        </Typography>
      ) : (
        <Typography variant="body2" component="div">
          در Chrome: منوی ⋮ → <strong>Install app</strong> یا{' '}
          <strong>افزودن به صفحه اصلی</strong>
        </Typography>
      )}
      {!secureContext && (
        <Typography variant="caption" color="warning.main" display="block" sx={{ mt: 1 }}>
          با گواهی self-signed، مرورگر معمولاً دکمه نصب خودکار نشان نمی‌دهد. هشدار SSL را
          بپذیرید یا برای توسعه از mkcert استفاده کنید.
        </Typography>
      )}
      <Button
        size="small"
        startIcon={<InfoOutlinedIcon />}
        sx={{ mt: 1, p: 0, minWidth: 0 }}
        onClick={() => setShowHelp(v => !v)}
      >
        {showHelp ? 'بستن راهنما' : 'راهنمای گواهی dev'}
      </Button>
      <Collapse in={showHelp}>
        <Typography variant="caption" component="div" sx={{ mt: 1, lineHeight: 1.6 }}>
          برای نصب خودکار PWA، HTTPS باید <strong>مورد اعتماد دستگاه</strong> باشد:
          <br />
          ۱) روی PC: <code>mkcert</code> و ساخت cert برای IP
          <br />
          ۲) فایل root CA را روی گوشی نصب کنید (Android: Settings → Security → Install
          certificate)
          <br />
          ۳) یا از <code>npm run build</code> + <code>npm run preview</code> روی سرور با SSL
          واقعی استفاده کنید
          <br />
          فقط «ادامه با خطر» در مرورگر برای نصب PWA کافی نیست — CA باید trusted باشد.
        </Typography>
      </Collapse>
    </Alert>
  )
}
