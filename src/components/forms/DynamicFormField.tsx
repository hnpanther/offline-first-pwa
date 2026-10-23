import {
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  FormHelperText,
  Checkbox,
  FormControlLabel,
  FormGroup,
  FormLabel,
  Box,
  InputAdornment,
  IconButton
} from '@mui/material'
import { Controller, useWatch, type Control, type RegisterOptions, type ControllerRenderProps } from 'react-hook-form'
import type { FormField } from '@/types'
import { normalizeFieldOptions } from '@/utils/fieldOptions'
import {
  evaluateFieldSeverity,
  evaluateOptionSeverity,
  optionSeverityMessage,
  optionSeveritySummaryFa,
  severityMessage,
  validationSummaryFa,
  filterNumericInput,
  formatNumericDisplay,
  normalizeNumericOnBlur,
  toggleNumericSign,
  type FieldValidationSeverity
} from '@/utils/fieldValidation'
import type { FieldValidation } from '@/types/sync'

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
  // A choice field's thresholds live only in `validation`, never in min/max, so when the
  // caller passed none there is nothing to synthesise and nothing to colour by.
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
}

function NumericFieldInput({
  field,
  label,
  f,
  error,
  rangeSeverity,
  helper
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
      InputProps={{
        // Every number field, unconditionally — see fieldValidation.ts. The keyboard this field
        // asks for has no minus key, so without this button a negative reading is unrecordable.
        endAdornment: (
          <InputAdornment position="end">
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

export function DynamicFormField({ field, control, error, rules, rangeValidation }: DynamicFormFieldProps) {
  const label = field.required ? `${field.label} *` : field.label
  const options = normalizeFieldOptions(field.options)
  const effectiveRangeValidation = resolveRangeValidation(field, rangeValidation)
  // A choice carries severity too, so the watch has to cover it. Leaving the old
  // `field.type !== 'number'` gate here kept the subscription disabled for a select and the
  // colour never changed, however the field was configured.
  const isChoice = field.type === 'select' || field.type === 'multiselect'
  const watchedValue = useWatch({
    control,
    name: field.name,
    disabled: (field.type !== 'number' && !isChoice) || !effectiveRangeValidation
  })
  const rangeSummary = field.type === 'number'
    ? validationSummaryFa(effectiveRangeValidation)
    : isChoice ? optionSeveritySummaryFa(effectiveRangeValidation) : null
  const rangeSeverity = effectiveRangeValidation
    ? evaluateFieldSeverity(field.type, watchedValue, effectiveRangeValidation)
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
                helperText={helper?.text}
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
              <InputLabel id={`${field.name}-label`}>{label}</InputLabel>
              <Select
                {...f}
                labelId={`${field.name}-label`}
                label={label}
                displayEmpty={!field.required}
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
