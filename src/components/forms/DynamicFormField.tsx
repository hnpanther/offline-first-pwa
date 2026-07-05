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
  Box
} from '@mui/material'
import { Controller, useWatch, type Control, type RegisterOptions } from 'react-hook-form'
import type { FormField } from '@/types'
import { normalizeFieldOptions } from '@/utils/fieldOptions'
import {
  evaluateNumericSeverity,
  severityMessage,
  validationSummaryFa,
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

function rangeFeedbackColor(severity: FieldValidationSeverity): 'warning.main' | 'error.main' | undefined {
  if (severity === 'warning') return 'warning.main'
  if (severity === 'danger') return 'error.main'
  return undefined
}

export function DynamicFormField({ field, control, error, rules, rangeValidation }: DynamicFormFieldProps) {
  const label = field.required ? `${field.label} *` : field.label
  const options = normalizeFieldOptions(field.options)
  const watchedValue = useWatch({ control, name: field.name, disabled: field.type !== 'number' || !rangeValidation })
  const rangeSummary = field.type === 'number' ? validationSummaryFa(rangeValidation) : null
  const rangeSeverity =
    field.type === 'number' && rangeValidation
      ? evaluateNumericSeverity(watchedValue, rangeValidation)
      : 'ok'
  const rangeFeedback = severityMessage(rangeSeverity)

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
    case 'text':
    case 'number':
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
                type={field.type === 'number' ? 'number' : 'text'}
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
              {(error ?? field.helperText) && (
                <FormHelperText>{error ?? field.helperText}</FormHelperText>
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
              {(error ?? field.helperText) && (
                <FormHelperText>{error ?? field.helperText}</FormHelperText>
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
