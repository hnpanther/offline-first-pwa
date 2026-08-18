import { useState } from 'react'
import { Box, Button, Typography, Alert, Stack, Chip } from '@mui/material'
import MyLocationIcon from '@mui/icons-material/MyLocation'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import {
  captureCurrentLocation,
  formatCoordinate,
  isGeolocationSupported,
  parseCoordinate,
  LocationCaptureError
} from '@/services/device/geolocation'
import { FONT_MONO } from '@/theme'

interface Props {
  label: string
  value: unknown
  onChange: (value: unknown) => void
  readOnly?: boolean
  required?: boolean
  error?: string
  helperText?: string
}

/**
 * A `location` class field: the operator's position, read from the device.
 *
 * Deliberately capture-only, with no latitude/longitude boxes. On the web panel a supervisor
 * types coordinates in because there is no device position to read; here there is one, and a
 * typed coordinate would be an unverifiable claim about where somebody stood — exactly what
 * this field exists to avoid. Clearing is allowed, because a wrong fix must be removable.
 *
 * Permission is requested by the browser on first capture, the same way the camera and
 * microphone fields work; there is nothing to pre-authorise.
 */
export function LocationFieldInput({
  label,
  value,
  onChange,
  readOnly = false,
  required = false,
  error,
  helperText
}: Props) {
  const [busy, setBusy] = useState(false)
  const [captureError, setCaptureError] = useState<string | null>(null)

  const coordinate = parseCoordinate(value)
  const supported = isGeolocationSupported()

  const capture = async () => {
    setBusy(true)
    setCaptureError(null)
    try {
      onChange(await captureCurrentLocation())
    } catch (err) {
      // A refusal is not a crash: keep whatever was already recorded and say what happened.
      setCaptureError(
        err instanceof LocationCaptureError ? err.message : 'دریافت موقعیت مکانی ناموفق بود.'
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Box>
      <Typography variant="body2" fontWeight={600} gutterBottom>
        {label}
        {required && <Typography component="span" color="error.main"> *</Typography>}
      </Typography>

      {coordinate ? (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Chip
            icon={<MyLocationIcon />}
            label={formatCoordinate(coordinate)}
            color="primary"
            variant="outlined"
            sx={{ fontFamily: FONT_MONO, fontVariantNumeric: 'tabular-nums', direction: 'ltr' }}
          />
          {!readOnly && (
            <Button
              size="small"
              color="inherit"
              startIcon={<DeleteOutlineIcon />}
              onClick={() => { onChange(null); setCaptureError(null) }}
            >
              حذف
            </Button>
          )}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary">
          ثبت نشده
        </Typography>
      )}

      {!readOnly && (
        <Box sx={{ mt: 1 }}>
          <Button
            variant="outlined"
            size="small"
            startIcon={<MyLocationIcon />}
            onClick={capture}
            disabled={busy || !supported}
          >
            {busy ? 'در حال دریافت موقعیت…' : coordinate ? 'ثبت دوباره موقعیت' : 'ثبت موقعیت فعلی'}
          </Button>
        </Box>
      )}

      {!readOnly && !supported && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          این دستگاه یا مرورگر امکان دریافت موقعیت مکانی را ندارد.
        </Alert>
      )}

      {captureError && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {captureError}
        </Alert>
      )}

      {(error || helperText) && (
        <Typography variant="caption" color={error ? 'error.main' : 'text.secondary'} sx={{ display: 'block', mt: 0.5 }}>
          {error || helperText}
        </Typography>
      )}
    </Box>
  )
}
