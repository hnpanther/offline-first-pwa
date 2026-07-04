/**
 * DynamicClassForm — renders a set of form fields driven by FieldDefinition[]
 * and wires up react-hook-form validation from FieldDefinition.validation.
 *
 * Usage pattern:
 *   const form = useForm<Record<string, unknown>>()
 *   const { fields } = useFieldDefinitions(classId)
 *   <DynamicClassForm fields={fields} control={form.control} errors={form.formState.errors} />
 *
 * For LogSheet (multiple assets in one form), pass a fieldPrefix so field
 * names are namespaced and don't collide:
 *   <DynamicClassForm
 *     fields={fields}
 *     control={form.control}
 *     errors={form.formState.errors}
 *     fieldPrefix={entry.assetId}
 *   />
 * This produces field names like "asset-uuid.temperature" in the form values.
 */

import { Box, Typography, Alert } from '@mui/material'
import type { Control, FieldErrors, RegisterOptions } from 'react-hook-form'
import { DynamicFormField } from './DynamicFormField'
import type { FieldDefinition } from '@/types/sync'
import type { FormField } from '@/types'
import { normalizeFieldOptions, resolveOptionLabel } from '@/utils/fieldOptions'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Translate a FieldDefinition into the FormField shape that DynamicFormField
 * understands. This is the adapter between the two representations.
 */
function toFormField(def: FieldDefinition, nameOverride?: string): FormField {
  return {
    name: nameOverride ?? def.key,
    label: def.label,
    type: def.dataType,
    required: def.required,
    unit: def.unit,
    min: def.validation?.min,
    max: def.validation?.max,
    options: normalizeFieldOptions(def.validation?.options),
    helperText: def.unit ? `واحد: ${def.unit}` : undefined,
  }
}

function formatReadOnlyValue(def: FieldDefinition, val: unknown): { value: string; unit?: string } {
  if (val === undefined || val === null || val === '') {
    return { value: '—' }
  }

  const options = normalizeFieldOptions(def.validation?.options)

  if (def.dataType === 'checkbox') {
    return { value: val ? 'بله' : 'خیر' }
  }

  if (def.dataType === 'select' || def.dataType === 'multiselect') {
    return { value: resolveOptionLabel(options, val) }
  }

  const text = Array.isArray(val) ? val.join('، ') : String(val)
  if (def.unit) {
    return { value: text, unit: def.unit }
  }
  return { value: text }
}

/**
 * Build react-hook-form RegisterOptions from a FieldDefinition.
 * This is the single source of truth for dynamic validation rules.
 * All constraints come from FieldDefinition.validation — not hardcoded.
 */
export function buildValidationRules(def: FieldDefinition): RegisterOptions {
  const v = def.validation ?? {}
  return {
    required: def.required ? 'این فیلد الزامی است' : false,

    ...(v.min !== undefined && {
      min: { value: v.min, message: `مقدار نباید کمتر از ${v.min} باشد` },
    }),
    ...(v.max !== undefined && {
      max: { value: v.max, message: `مقدار نباید بیشتر از ${v.max} باشد` },
    }),
    ...(v.minLength !== undefined && {
      minLength: { value: v.minLength, message: `حداقل ${v.minLength} کاراکتر لازم است` },
    }),
    ...(v.maxLength !== undefined && {
      maxLength: { value: v.maxLength, message: `حداکثر ${v.maxLength} کاراکتر مجاز است` },
    }),
    ...(v.pattern && {
      pattern: {
        value: new RegExp(v.pattern),
        message: 'فرمت وارد شده معتبر نیست',
      },
    }),
  }
}

/**
 * Read the validation error message for a (possibly nested) field name.
 * Handles flat names ("temperature") and dot-namespaced names ("assetId.temperature").
 */
function getError(errors: FieldErrors | undefined, fieldName: string): string | undefined {
  if (!errors) return undefined
  const parts = fieldName.split('.')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = errors
  for (const part of parts) {
    if (!node || typeof node !== 'object') return undefined
    node = node[part]
  }
  return typeof node?.message === 'string' ? node.message : undefined
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DynamicClassFormProps {
  /** Pre-loaded field definitions, sorted by order. Use useFieldDefinitions(classId). */
  fields: FieldDefinition[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control: Control<any>
  errors?: FieldErrors
  /**
   * Optional prefix for field names in the react-hook-form value tree.
   * Use this when rendering multiple assets in a single form (LogSheet):
   *   fieldPrefix="asset-uuid" → field name becomes "asset-uuid.temperature"
   */
  fieldPrefix?: string
  /** When true, fields render as read-only display (no validation, no input). */
  readOnly?: boolean
  /** Values map for read-only display. Keys are FieldDefinition.key. */
  readOnlyValues?: Record<string, unknown>
}

export function DynamicClassForm({
  fields,
  control,
  errors,
  fieldPrefix,
  readOnly = false,
  readOnlyValues,
}: DynamicClassFormProps) {
  const sorted = [...fields].sort((a, b) => a.order - b.order)

  if (sorted.length === 0) {
    return (
      <Alert severity="info" sx={{ my: 1 }}>
        این کلاس هیچ پارامتری ندارد.
      </Alert>
    )
  }

  if (readOnly && readOnlyValues) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {sorted.map(def => {
          const { value, unit } = formatReadOnlyValue(def, readOnlyValues[def.key])

          return (
            <Box
              key={def.key}
              sx={{
                py: 1.25,
                px: 0.5,
                borderBottom: '1px solid',
                borderColor: 'divider',
                '&:last-child': { borderBottom: 'none' }
              }}
            >
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.75 }}>
                {def.label}
                {def.required ? ' *' : ''}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, flexWrap: 'wrap' }}>
                <Typography variant="body1" fontWeight={600} component="span">
                  {value}
                </Typography>
                {unit && (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    component="span"
                    sx={{ borderRight: 1, borderColor: 'divider', pr: 2 }}
                  >
                    {unit}
                  </Typography>
                )}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, py: 0.5, px: 0.5 }}>
      {sorted.map(def => {
        const fieldName = fieldPrefix ? `${fieldPrefix}.${def.key}` : def.key
        const formField = toFormField(def, fieldName)
        const rules = buildValidationRules(def)
        const error = getError(errors, fieldName)

        return (
          <DynamicFormField
            key={fieldName}
            field={formField}
            control={control}
            error={error}
            rules={rules}
          />
        )
      })}
    </Box>
  )
}
