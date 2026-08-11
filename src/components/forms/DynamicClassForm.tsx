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
import { Controller } from 'react-hook-form'
import type { Control, FieldErrors, RegisterOptions } from 'react-hook-form'
import { DynamicFormField } from './DynamicFormField'
import { AttachmentFieldInput } from './AttachmentFieldInput'
import { LocationFieldInput } from './LocationFieldInput'
import { formatCoordinate, parseCoordinate } from '@/services/device/geolocation'
import { attachmentIdsOf, attachmentKindForDataType } from '@/services/storage/attachments'
import type { FieldDefinition } from '@/types/sync'
import type { FormField } from '@/types'
import { normalizeFieldOptions, resolveOptionLabel } from '@/utils/fieldOptions'
import {
  evaluateNumericSeverity,
  severityMessage,
  type FieldValidationSeverity
} from '@/utils/fieldValidation'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A `location` class field — matched the same way the server does, case-insensitively. */
function isLocationDataType(dataType: string | undefined): boolean {
  return (dataType ?? '').trim().toLowerCase() === 'location'
}

/**
 * Translate a FieldDefinition into the FormField shape that DynamicFormField
 * understands. This is the adapter between the two representations.
 */
function toFormField(def: FieldDefinition, nameOverride?: string): FormField {
  const helperParts = [def.unit ? `واحد: ${def.unit}` : null].filter(Boolean)
  return {
    name: nameOverride ?? def.key,
    label: def.label,
    type: def.dataType,
    required: def.required,
    unit: def.unit,
    options: normalizeFieldOptions(def.validation?.options),
    helperText: helperParts.length > 0 ? helperParts.join(' · ') : undefined
  }
}

function formatReadOnlyValue(def: FieldDefinition, val: unknown): { value: string; unit?: string } {
  if (val === undefined || val === null || val === '') {
    return { value: '—' }
  }

  // A media value is a reference object, not something to stringify. This is the fallback for
  // read-only rendering without attachment context; with context the field renders previews.
  if (attachmentKindForDataType(def.dataType)) {
    const count = attachmentIdsOf(val).length
    return { value: count === 0 ? '—' : `${count} پیوست` }
  }

  if (isLocationDataType(def.dataType)) {
    return { value: formatCoordinate(val) || '—' }
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

function readOnlyValueColor(severity: FieldValidationSeverity): string | undefined {
  if (severity === 'warning') return 'warning.main'
  if (severity === 'danger') return 'error.main'
  return undefined
}

/**
 * Build react-hook-form RegisterOptions from a FieldDefinition.
 * This is the single source of truth for dynamic validation rules.
 * All constraints come from FieldDefinition.validation — not hardcoded.
 */
export function buildValidationRules(def: FieldDefinition): RegisterOptions {
  const v = def.validation ?? {}

  // `required` cannot be used for media: the value is always an object once the control has
  // rendered, and an object is truthy even when it holds no ids. Count the ids instead.
  if (attachmentKindForDataType(def.dataType)) {
    return def.required
      ? { validate: value => attachmentIdsOf(value).length > 0 || 'این فیلد الزامی است' }
      : {}
  }

  // Same reason as media: a coordinate is an object, and an object is truthy even when it
  // holds nothing usable. Judge it by whether it parses into a real position.
  if (isLocationDataType(def.dataType)) {
    return def.required
      ? { validate: value => parseCoordinate(value) != null || 'این فیلد الزامی است' }
      : {}
  }

  return {
    required: def.required ? 'این فیلد الزامی است' : false,

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
  /**
   * Context an attachment field needs to bind captured media to the right place.
   * Absent for forms outside a log sheet — image/audio fields then render as read-only.
   */
  attachmentContext?: {
    logSheetLocalId: string
    logSheetServerId?: string
    assetId: string
  }
}

export function DynamicClassForm({
  fields,
  control,
  errors,
  fieldPrefix,
  readOnly = false,
  readOnlyValues,
  attachmentContext,
}: DynamicClassFormProps) {
  const sorted = [...fields].sort((a, b) => a.order - b.order)

  if (sorted.length === 0) {
    return (
      <Alert severity="info" sx={{ my: 1 }}>
        پارامتری برای این کلاس روی دستگاه یافت نشد. از منوی تنظیمات «همگام‌سازی پیکربندی» را
        اجرا کنید یا چند لحظه صبر کنید تا داده از سرور دریافت شود.
      </Alert>
    )
  }

  if (readOnly && readOnlyValues) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {sorted.map(def => {
          const rawValue = readOnlyValues[def.key]

          const readOnlyKind = attachmentKindForDataType(def.dataType)
          if (readOnlyKind && attachmentContext) {
            return (
              <Box key={def.key} sx={{ py: 1.25, px: 0.5, borderBottom: '1px solid', borderColor: 'divider' }}>
                <AttachmentFieldInput
                  kind={readOnlyKind}
                  label={def.label}
                  value={rawValue}
                  readOnly
                  logSheetLocalId={attachmentContext.logSheetLocalId}
                  logSheetServerId={attachmentContext.logSheetServerId}
                  assetId={attachmentContext.assetId}
                  fieldKey={def.key}
                  onChange={() => {}}
                />
              </Box>
            )
          }

          if (isLocationDataType(def.dataType)) {
            return (
              <Box key={def.key} sx={{ py: 1.25, px: 0.5, borderBottom: '1px solid', borderColor: 'divider' }}>
                <LocationFieldInput
                  label={def.label}
                  value={rawValue}
                  onChange={() => {}}
                  readOnly
                />
              </Box>
            )
          }

          const { value, unit } = formatReadOnlyValue(def, rawValue)
          const rangeSeverity =
            def.dataType === 'number' && def.validation
              ? evaluateNumericSeverity(rawValue, def.validation)
              : 'ok'
          const rangeFeedback = severityMessage(rangeSeverity)
          const valueColor = readOnlyValueColor(rangeSeverity)

          return (
            <Box
              key={def.key}
              sx={{
                py: 1.25,
                px: 0.5,
                borderBottom: '1px solid',
                borderColor: 'divider',
                borderRight: rangeSeverity !== 'ok' ? 3 : 0,
                borderRightColor:
                  rangeSeverity === 'danger'
                    ? 'error.main'
                    : rangeSeverity === 'warning'
                      ? 'warning.main'
                      : undefined,
                '&:last-child': { borderBottom: 'none' }
              }}
            >
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.75 }}>
                {def.label}
                {def.required ? ' *' : ''}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, flexWrap: 'wrap' }}>
                <Typography
                  variant="body1"
                  fontWeight={600}
                  component="span"
                  sx={{ color: valueColor }}
                >
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
              {rangeFeedback && (
                <Typography
                  variant="caption"
                  sx={{ color: valueColor, fontWeight: 600, display: 'block', mt: 0.5 }}
                >
                  {rangeFeedback}
                </Typography>
              )}
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

        // Neither media nor location goes through DynamicFormField: both hold an object
        // rather than a scalar, and both are captured from the device rather than typed.
        if (isLocationDataType(def.dataType)) {
          return (
            <Controller
              key={fieldName}
              name={fieldName}
              control={control}
              rules={rules}
              render={({ field: f }) => (
                <LocationFieldInput
                  label={def.label}
                  required={def.required}
                  value={f.value}
                  onChange={f.onChange}
                  error={error}
                />
              )}
            />
          )
        }

        const attachmentKind = attachmentKindForDataType(def.dataType)
        if (attachmentKind && attachmentContext) {
          return (
            <Controller
              key={fieldName}
              name={fieldName}
              control={control}
              rules={rules}
              render={({ field }) => (
                <AttachmentFieldInput
                  kind={attachmentKind}
                  label={def.label + (def.required ? ' *' : '')}
                  value={field.value}
                  logSheetLocalId={attachmentContext.logSheetLocalId}
                  logSheetServerId={attachmentContext.logSheetServerId}
                  assetId={attachmentContext.assetId}
                  fieldKey={def.key}
                  onChange={field.onChange}
                />
              )}
            />
          )
        }

        return (
          <DynamicFormField
            key={fieldName}
            field={formField}
            control={control}
            error={error}
            rules={rules}
            rangeValidation={def.dataType === 'number' ? def.validation : undefined}
          />
        )
      })}
    </Box>
  )
}
