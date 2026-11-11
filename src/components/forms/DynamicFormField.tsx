import {
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  FormHelperText,
  OutlinedInput,
  Checkbox,
  FormControlLabel,
  FormGroup,
  FormLabel,
  Box,
  InputAdornment,
  IconButton
} from '@mui/material'
import { useMemo, useState } from 'react'
import { Controller, useWatch, type Control, type RegisterOptions, type ControllerRenderProps } from 'react-hook-form'
import type { FormField } from '@/types'
import { normalizeFieldOptions } from '@/utils/fieldOptions'
import {
  evaluateFieldSeverity,
  evaluateOptionSeverity,
  hasStateCondition,
  optionSeverityMessage,
  optionSeveritySummaryFa,
  severityMessage,
  stateConditionSummaryFa,
  validationSummaryFa,
  filterNumericInput,
  formatNumericDisplay,
  normalizeNumericOnBlur,
  toggleNumericSign,
  type FieldValidationSeverity
} from '@/utils/fieldValidation'
import type { FieldValidation } from '@/types/sync'
import type { ScanFieldConfig } from '@/services/scan/scanFieldFill'
import { ScanFieldAdornment } from './ScanFieldAdornment'

interface DynamicFormFieldProps {
  field: FormField
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control: Control<any>
  error?: string
  /**
   * Override react-hook-form validation rules.
   * When provided (e.g. from DynamicClassForm), these replace the default
   * required-only rule that was inferred from field.required.
   */
  rules?: RegisterOptions
  /** Numeric warning/danger ranges from FieldDefinition.validation */
  rangeValidation?: FieldValidation
  /**
   * The siblings this field's state condition reads: the form names to watch, paired with the
   * definition keys to report them under.
   *
   * A gated field's thresholds apply only while a sibling says so — «the current band applies
   * only while the status reads running» — so colouring it needs more than its own value.
   *
   * **Exactly the named sources, never the whole entry.** `useWatch` with no `name` sets
   * react-hook-form's `watchAll` on the control, which makes every change anywhere in the form
   * a re-render; with a prefix it would also be wrong, since both of this app's forms name their
   * fields at the root. Watching the one or two parameters a gate actually reads means only the
   * gated field re-renders, and only when its gate's parameter changes. Empty or absent for
   * every field with no condition, which is all of them until somebody configures one.
   *
   * `gateSources[i]` is the react-hook-form name; `gateKeys[i]` is the key the evaluation sees.
   * The parent resolves the pairing because it is the one that holds the field list, and the
   * match has to be case-insensitive — the server's key uniqueness is case-folded, so a gate
   * written as `Status` must still find `status`.
   */
  gateSources?: string[]
  gateKeys?: string[]
  /**
   * How this field may be read off a label instead of typed.
   *
   * Rendered as small icons **inside** the input, so the field keeps its label, helper text,
   * severity colouring and validation — a scanned value is simply the value, arriving by a
   * different route. Only `text` and `number` can carry one; every other branch ignores it.
   */
  scan?: ScanFieldConfig
}

/**
 * The outline colour for a control whose chosen value carries a severity.
 *
 * MUI's `error` prop is for a validation failure — a field that cannot be submitted — and a
 * dangerous reading is not that: it is perfectly valid data about equipment in a bad state. So
 * the outline is coloured directly, leaving `error` to mean what it means everywhere else.
 */
/** Which MUI palette a checkbox uses when its own option carries an alert. */
function checkboxColor(severity: FieldValidationSeverity): 'error' | 'warning' | 'primary' {
  if (severity === 'danger') return 'error'
  if (severity === 'warning') return 'warning'
  return 'primary'
}

function choiceOutlineSx(severity: FieldValidationSeverity) {
  if (severity === 'ok') return undefined
  const color = severity === 'danger' ? 'error.main' : 'warning.main'
  return {
    '& .MuiOutlinedInput-notchedOutline': { borderColor: color, borderWidth: 2 },
    '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: color }
  }
}

function rangeFeedbackColor(severity: FieldValidationSeverity): 'warning.main' | 'error.main' | undefined {
  if (severity === 'warning') return 'warning.main'
  if (severity === 'danger') return 'error.main'
  return undefined
}

function resolveRangeValidation(
  field: FormField,
  rangeValidation?: FieldValidation
): FieldValidation | undefined {
  if (rangeValidation) return rangeValidation
  // A choice field keeps its thresholds only in `validation` — there is no min/max to
  // synthesise one from — so if the caller passed none, it passed none for a reason and
  // nothing is coloured. `supportsSeverity` is what decides that, on the caller's side.
  if (field.type !== 'number' || (field.min == null && field.max == null)) return undefined
  return { min: field.min, max: field.max }
}

interface NumericFieldInputProps {
  field: FormField
  label: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  f: ControllerRenderProps<any, string>
  error?: string
  rangeSeverity: FieldValidationSeverity
  helper: { text: string; color?: 'warning.main' | 'error.main' } | null
  scan?: ScanFieldConfig
  onScanError: (message: string | null) => void
}

function NumericFieldInput({
  field,
  label,
  f,
  error,
  rangeSeverity,
  helper,
  scan,
  onScanError
}: NumericFieldInputProps) {
  return (
    <TextField
      name={f.name}
      inputRef={f.ref}
      onBlur={() => {
        const normalized = normalizeNumericOnBlur(formatNumericDisplay(f.value))
        if (normalized !== formatNumericDisplay(f.value)) {
          f.onChange(normalized)
        }
        f.onBlur()
      }}
      value={formatNumericDisplay(f.value)}
      onChange={e => {
        f.onChange(filterNumericInput(e.target.value))
      }}
      label={label}
      type="text"
      placeholder={field.placeholder}
      error={!!error || rangeSeverity === 'danger'}
      helperText={helper?.text}
      FormHelperTextProps={
        helper?.color ? { sx: { color: helper.color, fontWeight: 600 } } : undefined
      }
      fullWidth
      size="medium"
      inputProps={{
        // Keeps the on-screen keyboard numeric. `decimal` gives digits and a separator; most
        // Android keyboards offer no minus key in that layout, which is precisely what the ±
        // button beside the field is for. Do not "fix" this by widening it to text — that hands
        // an operator a full QWERTY for a pressure reading.
        inputMode: 'decimal',
        dir: 'ltr',
        autoComplete: 'off'
      }}
      // Scan-only means the keyboard is not the way in. The scan buttons stay live, because
      // they are the only way in — disabling the whole control would make the field unfillable.
      disabled={scan != null && !scan.manual}
      InputProps={{
        endAdornment: (
          <InputAdornment position="end">
            {/* Composed, not replaced: the ± button is on every number field unconditionally
                (see fieldValidation.ts) because the decimal keyboard has no minus key, so a
                negative reading would otherwise be unrecordable. */}
            {scan && (
              <ScanFieldAdornment config={scan} onValue={f.onChange} onError={onScanError} />
            )}
            <IconButton
              aria-label="تغییر علامت عدد"
              edge="end"
              size="small"
              tabIndex={-1}
              onMouseDown={e => e.preventDefault()}
              onClick={() => f.onChange(toggleNumericSign(f.value))}
              sx={{ fontWeight: 700, fontSize: '1.1rem', minWidth: 36 }}
            >
              ±
            </IconButton>
          </InputAdornment>
        )
      }}
      sx={{
        '& .MuiOutlinedInput-root': { overflow: 'visible' },
        '& input': { textAlign: 'left' },
        ...(rangeSeverity === 'warning' && {
          '& .MuiOutlinedInput-notchedOutline': { borderColor: 'warning.main' }
        }),
        ...(rangeSeverity === 'danger' && {
          '& .MuiOutlinedInput-notchedOutline': { borderColor: 'error.main' }
        })
      }}
    />
  )
}

export function DynamicFormField({
  field,
  control,
  error,
  rules,
  rangeValidation,
  gateSources,
  gateKeys,
  scan
}: DynamicFormFieldProps) {
  const label = field.required ? `${field.label} *` : field.label
  // A failed read belongs beside the field it failed for, not in a toast that outlives it.
  const [scanError, setScanError] = useState<string | null>(null)
  const options = normalizeFieldOptions(field.options)
  const effectiveRangeValidation = resolveRangeValidation(field, rangeValidation)
  // A choice carries severity too, so the watch has to cover it. Leaving the old
  // `field.type !== 'number'` gate here kept the subscription disabled for a select and the
  // colour never changed, however the field was configured.
  const isChoice = field.type === 'select' || field.type === 'multiselect'
  // ONE subscription, this field's value first and its gate's parameters after it.
  //
  // Two separate `useWatch` calls would be two subscriptions per field, and in react-hook-form
  // `disabled` does NOT prevent subscribing — it only suppresses the re-render (`refreshValue`
  // returns early), so the callback still runs on every value change. A 22-parameter asset would
  // have paid 44 no-op callbacks per keystroke for a feature almost no field uses. Merged, the
  // count is exactly what it was before state conditions existed.
  //
  // `name` is an ARRAY and never undefined, which is the other half of the cost: a bare
  // `useWatch()` sets `watchAll` on the control and turns every change anywhere in the form into
  // a re-render of whatever watched it.
  const watchNames = useMemo(
    () => [field.name, ...(gateSources ?? [])],
    [field.name, gateSources]
  )
  const watched = useWatch({
    control,
    name: watchNames,
    disabled: (field.type !== 'number' && !isChoice) || !effectiveRangeValidation
  })
  const watchedValues = Array.isArray(watched) ? watched : []
  const watchedValue = watchedValues[0]
  // The gate's parameters, read out of the same watch — element 0 is this field's own value, so
  // the siblings start at 1, in `gateKeys` order.
  const gated = hasStateCondition(effectiveRangeValidation)
    && !!gateSources && gateSources.length > 0
  const siblings = useMemo(() => {
    if (!gated || !gateKeys) return undefined
    const out: Record<string, unknown> = {}
    gateKeys.forEach((key, i) => { out[key] = watchedValues[i + 1] })
    return out
    // watchedValues is derived from `watched` each render; depending on it directly is what
    // makes the colour follow the sibling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gated, gateKeys, watched])
  const rangeSummary = field.type === 'number'
    ? validationSummaryFa(effectiveRangeValidation)
    : isChoice
      ? [
          optionSeveritySummaryFa(effectiveRangeValidation),
          stateConditionSummaryFa(effectiveRangeValidation)
        ].filter(Boolean).join(' · ') || null
      : null
  const rangeSeverity = effectiveRangeValidation
    ? evaluateFieldSeverity(field.type, watchedValue, effectiveRangeValidation, siblings)
    : 'ok'
  const rangeFeedback = isChoice
    ? optionSeverityMessage(rangeSeverity)
    : severityMessage(rangeSeverity)

  const buildHelperParts = (): { text: string; color?: 'warning.main' | 'error.main' } | null => {
    if (error) return { text: error }
    if (rangeFeedback) return { text: rangeFeedback, color: rangeFeedbackColor(rangeSeverity) }
    const parts = [field.helperText, rangeSummary].filter(Boolean)
    if (parts.length === 0) return null
    return { text: parts.join(' · ') }
  }

  const helper = buildHelperParts()

  // If caller passes explicit rules (from DynamicClassForm), use them.
  // Otherwise fall back to a simple required check from field.required.
  const effectiveRules: RegisterOptions = rules ?? (
    field.required ? { required: 'این فیلد الزامی است' } : {}
  )

  switch (field.type) {
    case 'number':
      return (
        <Controller
          name={field.name}
          control={control}
          defaultValue={field.defaultValue ?? ''}
          rules={effectiveRules}
          render={({ field: f }) => (
            <Box>
              <NumericFieldInput
                field={field}
                label={label}
                f={f}
                error={error}
                rangeSeverity={rangeSeverity}
                helper={helper}
                scan={scan}
                onScanError={setScanError}
              />
            </Box>
          )}
        />
      )

    case 'text':
    case 'textarea':
      return (
        <Controller
          name={field.name}
          control={control}
          defaultValue={field.defaultValue ?? ''}
          rules={effectiveRules}
          render={({ field: f }) => (
            <Box>
              <TextField
                {...f}
                label={label}
                type="text"
                multiline={field.type === 'textarea'}
                rows={field.type === 'textarea' ? 3 : undefined}
                placeholder={field.placeholder}
                error={!!error || rangeSeverity === 'danger'}
                // Scan-only: the keyboard is not the way in, but the icons beside it are, so
                // only the text entry is disabled and the field stays fillable.
                disabled={scan != null && !scan.manual}
                InputProps={
                  scan
                    ? {
                        endAdornment: (
                          <InputAdornment position="end">
                            <ScanFieldAdornment
                              config={scan}
                              onValue={f.onChange}
                              onError={setScanError}
                            />
                          </InputAdornment>
                        )
                      }
                    : undefined
                }
                helperText={helper?.text ?? scanError ?? undefined}
                FormHelperTextProps={
                  helper?.color
                    ? { sx: { color: helper.color, fontWeight: 600 } }
                    : undefined
                }
                fullWidth
                size="medium"
                sx={{
                  '& .MuiOutlinedInput-root': { overflow: 'visible' },
                  ...(rangeSeverity === 'warning' && {
                    '& .MuiOutlinedInput-notchedOutline': { borderColor: 'warning.main' }
                  }),
                  ...(rangeSeverity === 'danger' && {
                    '& .MuiOutlinedInput-notchedOutline': { borderColor: 'error.main' }
                  })
                }}
              />
            </Box>
          )}
        />
      )

    case 'select':
      return (
        <Controller
          name={field.name}
          control={control}
          defaultValue={field.defaultValue ?? ''}
          rules={effectiveRules}
          render={({ field: f }) => (
            <FormControl fullWidth error={!!error} sx={{ mt: 0.5 }}>
              {/*
                `shrink` and `notched` are forced, and must stay forced.

                MUI decides whether a label floats from whether it thinks the input is filled.
                With `displayEmpty` the placeholder «— انتخاب کنید —» is painted INSIDE the
                control while the value is still empty, so MUI left the label sitting on the
                same line and the two overlapped — unreadably, for a long question like «صدای
                غیرعادی دارد؟» — until the operator picked something and the label jumped up.

                Pinning both gives the control ONE rendering state instead of two, so the
                label is never a function of the value. `notched` goes with `shrink`: without
                it the floated label would sit across an uncut outline.
              */}
              <InputLabel id={`${field.name}-label`} shrink>{label}</InputLabel>
              <Select
                {...f}
                labelId={`${field.name}-label`}
                displayEmpty={!field.required}
                input={<OutlinedInput label={label} notched />}
                sx={choiceOutlineSx(rangeSeverity)}
              >
                {!field.required && (
                  <MenuItem key={`${field.name}-empty`} value="">
                    <em>— انتخاب کنید —</em>
                  </MenuItem>
                )}
                {options.map((opt, idx) => (
                  <MenuItem key={`${field.name}-${opt.value}-${idx}`} value={opt.value}>
                    {opt.label}
                  </MenuItem>
                ))}
              </Select>
              {helper && (
                <FormHelperText sx={helper.color ? { color: helper.color, fontWeight: 600 } : undefined}>
                  {helper.text}
                </FormHelperText>
              )}
            </FormControl>
          )}
        />
      )

    case 'checkbox':
      return (
        <Controller
          name={field.name}
          control={control}
          defaultValue={field.defaultValue ?? false}
          rules={effectiveRules}
          render={({ field: f }) => (
            <FormControlLabel
              control={<Checkbox {...f} checked={!!f.value} />}
              label={field.label}
            />
          )}
        />
      )

    case 'multiselect':
      return (
        <Controller
          name={field.name}
          control={control}
          defaultValue={field.defaultValue ?? []}
          rules={effectiveRules}
          render={({ field: f }) => (
            <FormControl component="fieldset" error={!!error} fullWidth>
              <FormLabel component="legend">{label}</FormLabel>
              <FormGroup sx={{ pl: 0.5 }}>
                {options.map((opt, idx) => (
                  <FormControlLabel
                    key={`${field.name}-${opt.value}-${idx}`}
                    control={
                      <Checkbox
                        checked={Array.isArray(f.value) && f.value.includes(opt.value)}
                        // Coloured per OPTION, not per field: a multiselect shows several
                        // choices at once, and "one of these five is the dangerous one" is the
                        // thing an operator needs to see. The helper below still reports the
                        // worst of what is actually ticked.
                        color={checkboxColor(
                          evaluateOptionSeverity(opt.value, effectiveRangeValidation)
                        )}
                        onChange={e => {
                          const current: string[] = Array.isArray(f.value) ? f.value : []
                          f.onChange(
                            e.target.checked
                              ? [...current, opt.value]
                              : current.filter(v => v !== opt.value)
                          )
                        }}
                      />
                    }
                    label={opt.label}
                  />
                ))}
              </FormGroup>
              {helper && (
                <FormHelperText sx={helper.color ? { color: helper.color, fontWeight: 600 } : undefined}>
                  {helper.text}
                </FormHelperText>
              )}
            </FormControl>
          )}
        />
      )

    default:
      return (
        <Box>
          <TextField
            label={label}
            disabled
            value="نوع فیلد پشتیبانی نمی‌شود"
            fullWidth
          />
        </Box>
      )
  }
}
