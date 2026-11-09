import { useEffect, useState } from 'react'
import { Alert, Box, Button, CircularProgress, Stack, TextField, Typography } from '@mui/material'
import PhonelinkLockIcon from '@mui/icons-material/PhonelinkLock'
import { ApiError } from '@/services/api/client'
import {
  completeEnrollment,
  pendingRequestNumber,
  restartEnrollment,
  startEnrollment,
  type DeviceGate
} from '@/services/device/deviceAuth'
import { deviceCryptoAvailable } from '@/services/device/deviceIdentity'
import { deviceErrorCode } from '@/types/device'
import { t } from '@/i18n'
import { FONT_MONO } from '@/theme'

interface DeviceEnrollmentCardProps {
  /** What stopped the login. Decides whether this resumes, starts, or starts over. */
  gate: DeviceGate
  /** The server approved this device; the login can be tried again. */
  onApproved: () => void
}

type Step =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  /** No request yet: ask for one. */
  | { kind: 'request' }
  /** The key was revoked or is unknown: a new key, a new request. */
  | { kind: 'renew' }
  /** A request exists: show its number and take the code. */
  | { kind: 'code'; requestId: number }

/**
 * Enrolling this tablet, shown under the login form when the device — not the password — is what
 * stopped the login.
 *
 * <h3>Why it sits under the form rather than replacing it</h3>
 *
 * The form keeps the username and password the operator already typed. Once the device is
 * approved they press «ورود» once more and are in, instead of typing both again.
 *
 * <h3>The steps</h3>
 *
 * 1. «درخواست ثبت» — the tablet sends its public key and shows a request number.
 * 2. The operator reads that number to an approver, at the desk or on the phone, and is given an
 *    eight-digit code.
 * 3. The code goes back signed by this tablet's key, so it works here and on no other device.
 *
 * A request already made is resumed — the number is kept on the device — so closing the app
 * between steps 1 and 3 does not start over. «بررسی دوباره» re-asks the server, which answers an
 * already-approved key with "approved": the case of a response that was lost on the way back.
 */
export function DeviceEnrollmentCard({ gate, onApproved }: DeviceEnrollmentCardProps) {
  const [step, setStep] = useState<Step>({ kind: 'loading' })
  const [label, setLabel] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!deviceCryptoAvailable()) {
        setStep({ kind: 'unsupported' })
        return
      }
      if (gate === 'revoked' || gate === 'unknown') {
        setStep({ kind: 'renew' })
        return
      }
      const pending = await pendingRequestNumber()
      if (cancelled) return
      setStep(pending !== null ? { kind: 'code', requestId: pending } : { kind: 'request' })
    })()
    return () => {
      cancelled = true
    }
  }, [gate])

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (err) {
      const deviceCode = err instanceof ApiError ? deviceErrorCode(err.body) : null
      // The request this tablet held is gone: start a new one rather than ask for a code that
      // can no longer be issued for it.
      if (deviceCode === 'REQUEST_EXPIRED' || deviceCode === 'REQUEST_UNKNOWN') {
        setStep({ kind: 'request' })
      } else if (deviceCode === 'DEVICE_REVOKED') {
        setStep({ kind: 'renew' })
      }
      const attemptsLeft =
        err instanceof ApiError ? (err.body as { attemptsLeft?: unknown } | undefined)?.attemptsLeft : undefined
      const message = err instanceof Error ? err.message : 'خطا در ثبت دستگاه'
      setError(typeof attemptsLeft === 'number' ? `${message} ${t.device.attemptsLeft(attemptsLeft)}` : message)
    } finally {
      setBusy(false)
    }
  }

  const request = (renew: boolean) =>
    run(async () => {
      const view = renew ? await restartEnrollment(label) : await startEnrollment(label)
      if (view.status === 'APPROVED') {
        onApproved()
        return
      }
      setCode('')
      setStep({ kind: 'code', requestId: view.requestId })
    })

  const confirm = () =>
    run(async () => {
      const view = await completeEnrollment(code)
      if (view.status === 'APPROVED') onApproved()
    })

  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'warning.light',
        borderRadius: 2,
        p: 1.75,
        bgcolor: '#fffaf2',
        display: 'flex',
        flexDirection: 'column',
        gap: 1.25
      }}
      data-testid="device-enrollment"
    >
      <Stack direction="row" spacing={1} alignItems="center">
        <PhonelinkLockIcon fontSize="small" color="warning" />
        <Typography variant="subtitle2" fontWeight={700}>
          {t.device.title}
        </Typography>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ py: 0.25 }}>
          {error}
        </Alert>
      )}

      {step.kind === 'loading' && <CircularProgress size={20} sx={{ alignSelf: 'center' }} />}

      {step.kind === 'unsupported' && (
        <Typography variant="body2" color="text.secondary">
          {t.device.unsupported}
        </Typography>
      )}

      {(step.kind === 'request' || step.kind === 'renew') && (
        <>
          <Typography variant="body2" color="text.secondary">
            {step.kind === 'renew' ? t.device.renewIntro : t.device.intro}
          </Typography>
          <TextField
            label={t.device.labelField}
            helperText={t.device.labelHint}
            size="small"
            value={label}
            onChange={e => setLabel(e.target.value)}
            disabled={busy}
            inputProps={{ maxLength: 120 }}
          />
          <Button
            variant="contained"
            color="warning"
            disabled={busy}
            onClick={() => void request(step.kind === 'renew')}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {busy ? t.device.requesting : step.kind === 'renew' ? t.device.renew : t.device.request}
          </Button>
        </>
      )}

      {step.kind === 'code' && (
        <>
          <Box sx={{ textAlign: 'center' }}>
            <Typography variant="caption" color="text.secondary">
              {t.device.requestNumber}
            </Typography>
            <Typography
              variant="h4"
              fontWeight={800}
              dir="ltr"
              sx={{ fontFamily: FONT_MONO, fontVariantNumeric: 'tabular-nums', letterSpacing: 2 }}
              data-testid="device-request-number"
            >
              {step.requestId}
            </Typography>
          </Box>
          <Typography variant="body2" color="text.secondary">
            {t.device.codeIntro}
          </Typography>
          <TextField
            label={t.device.codeField}
            size="small"
            value={code}
            onChange={e => setCode(e.target.value)}
            disabled={busy}
            autoComplete="one-time-code"
            inputProps={{ inputMode: 'numeric', dir: 'ltr', maxLength: 24, style: { letterSpacing: 3 } }}
          />
          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              color="warning"
              fullWidth
              disabled={busy || code.trim().length === 0}
              onClick={() => void confirm()}
              startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
            >
              {busy ? t.device.confirming : t.device.confirm}
            </Button>
            <Button variant="text" disabled={busy} onClick={() => void request(false)}>
              {t.device.checkAgain}
            </Button>
          </Stack>
        </>
      )}
    </Box>
  )
}
