import { FormHelperText } from '@mui/material'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker'
import { AdapterDateFnsJalali } from '@mui/x-date-pickers/AdapterDateFnsJalaliV3'
import { faIR } from 'date-fns-jalali/locale/fa-IR'
import {
  canonicalDateTime,
  parseDateTimeEpoch,
  type DateTimeValue
} from '@/utils/dateTimeValue'

interface DateTimeFieldInputProps {
  label: string
  required?: boolean
  value: unknown
  onChange: (next: DateTimeValue | null) => void
  error?: string
}

/**
 * Jalali date+time picker for a `datetime` field.
 *
 * Stores `{ type: 'datetime', epochMs }` — the same shape the server validates and keeps.
 * Wrapped in its own LocalizationProvider so the rest of the app does not need a jalali adapter.
 * `AdapterDateFnsJalaliV3` is the adapter that speaks date-fns-jalali 4; the unsuffixed one
 * still imports `date-fns-jalali/_lib/...`, which that package no longer exposes.
 */
export function DateTimeFieldInput({
  label,
  required,
  value,
  onChange,
  error
}: DateTimeFieldInputProps) {
  const epoch = parseDateTimeEpoch(value)
  const selected = epoch == null ? null : new Date(epoch)

  return (
    <LocalizationProvider dateAdapter={AdapterDateFnsJalali} adapterLocale={faIR}>
      <DateTimePicker
        label={label + (required ? ' *' : '')}
        value={selected}
        ampm={false}
        onChange={next => {
          if (next == null || Number.isNaN(next.getTime())) {
            onChange(null)
            return
          }
          const canonical = canonicalDateTime(next.getTime())
          onChange(canonical ?? null)
        }}
        slotProps={{
          textField: {
            fullWidth: true,
            size: 'medium',
            error: !!error,
            helperText: error
          }
        }}
      />
      {!error && <FormHelperText>تاریخ و ساعت شمسی</FormHelperText>}
    </LocalizationProvider>
  )
}
