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
  Radio,
  RadioGroup,
  FormLabel,
  Box
} from '@mui/material'
import { Controller, type Control } from 'react-hook-form'
import type { FormField } from '@/types'

interface DynamicFormFieldProps {
  field: FormField
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control: Control<any>
  error?: string
}

export function DynamicFormField({ field, control, error }: DynamicFormFieldProps) {
  const label = field.required ? `${field.label} *` : field.label

  switch (field.type) {
    case 'text':
    case 'number':
    case 'textarea':
      return (
        <Controller
          name={field.name}
          control={control}
          defaultValue={field.defaultValue ?? ''}
          render={({ field: f }) => (
            <TextField
              {...f}
              label={label}
              type={field.type === 'number' ? 'number' : 'text'}
              multiline={field.type === 'textarea'}
              rows={field.type === 'textarea' ? 3 : undefined}
              placeholder={field.placeholder}
              error={!!error}
              helperText={error ?? field.helperText}
              fullWidth
              size="medium"
              inputProps={{
                min: field.min,
                max: field.max,
                minLength: field.minLength,
                maxLength: field.maxLength
              }}
            />
          )}
        />
      )

    case 'select':
      return (
        <Controller
          name={field.name}
          control={control}
          defaultValue={field.defaultValue ?? ''}
          render={({ field: f }) => (
            <FormControl fullWidth error={!!error}>
              <InputLabel>{label}</InputLabel>
              <Select {...f} label={label}>
                {field.options?.map(opt => (
                  <MenuItem key={opt.value} value={opt.value}>
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
          render={({ field: f }) => (
            <FormControlLabel
              control={<Checkbox {...f} checked={!!f.value} />}
              label={field.label}
            />
          )}
        />
      )

    case 'radio':
      return (
        <Controller
          name={field.name}
          control={control}
          defaultValue={field.defaultValue ?? ''}
          render={({ field: f }) => (
            <FormControl error={!!error}>
              <FormLabel>{label}</FormLabel>
              <RadioGroup {...f} row>
                {field.options?.map(opt => (
                  <FormControlLabel
                    key={opt.value}
                    value={opt.value}
                    control={<Radio />}
                    label={opt.label}
                  />
                ))}
              </RadioGroup>
              {(error ?? field.helperText) && (
                <FormHelperText>{error ?? field.helperText}</FormHelperText>
              )}
            </FormControl>
          )}
        />
      )

    case 'multiselect':
      return (
        <Controller
          name={field.name}
          control={control}
          defaultValue={field.defaultValue ?? []}
          render={({ field: f }) => (
            <FormControl component="fieldset" error={!!error} fullWidth>
              <FormLabel component="legend">{label}</FormLabel>
              <FormGroup>
                {field.options?.map(opt => (
                  <FormControlLabel
                    key={opt.value}
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
