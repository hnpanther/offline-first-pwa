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
import { useMemo } from 'react'
import { Controller, useWatch } from 'react-hook-form'
import type { Control, FieldErrors, RegisterOptions } from 'react-hook-form'
import { DynamicFormField } from './DynamicFormField'
import { AttachmentFieldInput } from './AttachmentFieldInput'
import { SignatureFieldInput } from './SignatureFieldInput'
import {
  coveredFingerprint,
  scopeOfField,
  scopeOfValue,
  signatureKey,
  signatureVerdict
} from '@/utils/signatureVerdict'
import { LocationFieldInput } from './LocationFieldInput'
import { scanFieldConfig } from '@/services/scan/scanFieldFill'
import { formatCoordinate, parseCoordinate } from '@/services/device/geolocation'
import { attachmentIdsOf, attachmentKindForDataType } from '@/services/storage/attachments'
import type { FieldDefinition } from '@/types/sync'
import type { FormField, LogSheetEntryData } from '@/types'
import { normalizeFieldOptions, resolveOptionLabel } from '@/utils/fieldOptions'
import { isListedOption } from './choiceControl'
import {
  evaluateFieldSeverity,
  optionSeverityMessage,
  supportsSeverity,
  severityMessage,
  type FieldValidationSeverity
} from '@/utils/fieldValidation'
// Its own module because it IS the «does this field subscribe, and to what» decision, and that
// decision was wrong once in a way no test here could see. See gateSources.ts.
import { resolveGateSources, type GateWatchPlan } from './gateSources'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A `signature` field (backend roadmap §32) — matched case-insensitively, like the server. */
function isSignatureDataType(dataType: string | undefined): boolean {
  return (dataType ?? '').trim().toLowerCase() === 'signature'
}

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
    helperText: helperParts.length > 0 ? helperParts.join(' · ') : undefined,
    allowCustom: def.validation?.allowCustom === true
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
    // A typed answer (roadmap §31) is marked «دستی», as the panel marks it, so a reader can tell
    // what was chosen from the list from what an operator wrote in. Only with a vocabulary to
    // be outside of — a choice field with no options accepts anything.
    if (options.length > 0) {
      const items = Array.isArray(val) ? val : [val]
      const text = items
        .filter(v => v !== undefined && v !== null && String(v).trim() !== '')
        .map(v => (isListedOption(options, v) ? resolveOptionLabel(options, v) : `${String(v).trim()} · دستی`))
        .join('، ')
      return { value: text || '—' }
    }
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
    /**
     * Absent for the round's own questions — those belong to the sheet rather than to any asset
     * on it, and so does any photo answering one. Present for every per-asset form.
     */
    assetId?: string
  }
  /**
   * Where this form's signatures stand (backend roadmap §32): the server's verdicts and this
   * device's baselines, keyed by `owner` — `"sheet"` for the round's own questions, the asset id
   * for an asset's form — plus every asset's stored answers, which a ROUND-scope signature on the
   * round's questions also covers. Absent where nothing is known; the field then shows no verdict.
   */
  signatureContext?: SignatureContext
}

export interface SignatureContext {
  owner: string
  states?: Record<string, string>
  baselines?: Record<string, string>
  roundEntries?: LogSheetEntryData[]
}

/**
 * One signature field, with its verdict worked out from the answers **as they are in this form
 * right now** — so an answer changed in the same dialog after signing shows the warning before
 * anything is saved.
 *
 * Its own component because it watches the whole form (`useWatch` with no name), which
 * re-renders whatever does the watching on every keystroke. Kept here, that is this one small
 * component — never the form, and never a field that is not a signature.
 */
function SignatureFieldWithVerdict({
  def,
  fields,
  control,
  value,
  readOnly,
  readOnlyValues,
  attachmentContext,
  signatureContext,
  label,
  onChange
}: {
  def: FieldDefinition
  fields: FieldDefinition[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control: Control<any>
  value: unknown
  readOnly: boolean
  readOnlyValues?: Record<string, unknown>
  attachmentContext: NonNullable<DynamicClassFormProps['attachmentContext']>
  signatureContext?: SignatureContext
  label: string
  onChange: (value: unknown) => void
}) {
  const live = useWatch({ control, disabled: readOnly }) as Record<string, unknown> | undefined
  const answers = readOnly ? readOnlyValues : live
  const ownKeys = useMemo(
    () => fields.filter(f => f.dataType !== 'signature').map(f => f.key),
    [fields]
  )
  const scope = scopeOfValue(value, scopeOfField(def))
  const roundEntries = signatureContext?.roundEntries
  const fingerprint = () => coveredFingerprint(scope, answers, ownKeys, roundEntries)
  const key = signatureContext ? signatureKey(signatureContext.owner, def.key) : null
  const verdict = key
    ? signatureVerdict({
        scope,
        serverState: signatureContext?.states?.[key],
        localFingerprint: (value as { localFingerprint?: string } | null)?.localFingerprint,
        baseline: signatureContext?.baselines?.[key],
        current: fingerprint()
      })
    : undefined
  return (
    <SignatureFieldInput
      label={label}
      value={value}
      readOnly={readOnly}
      logSheetLocalId={attachmentContext.logSheetLocalId}
      logSheetServerId={attachmentContext.logSheetServerId}
      assetId={attachmentContext.assetId}
      fieldKey={def.key}
      onChange={onChange}
      scope={scopeOfField(def)}
      verdict={verdict}
      // The scope the field declares now — a fresh drawing is judged under today's definition.
      coveredFingerprint={() => coveredFingerprint(scopeOfField(def), answers, ownKeys, roundEntries)}
    />
  )
}

export function DynamicClassForm({
  fields,
  control,
  errors,
  fieldPrefix,
  readOnly = false,
  readOnlyValues,
  attachmentContext,
  signatureContext,
}: DynamicClassFormProps) {
  // Memoised, and that is load-bearing rather than tidy: `DynamicFormField` watches an ARRAY of
  // names built from the gate plan, and react-hook-form keys its subscription effect on that
  // array by reference. A plan rebuilt on every render would tear down and re-create one
  // subscription per gated field on every keystroke in the form.
  const sorted = useMemo(() => [...fields].sort((a, b) => a.order - b.order), [fields])
  const gatePlans = useMemo(() => {
    const out = new Map<string, GateWatchPlan | undefined>()
    for (const def of sorted) {
      if (def.key) out.set(def.key, resolveGateSources(def, sorted, fieldPrefix))
    }
    return out
  }, [sorted, fieldPrefix])

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

          if (isSignatureDataType(def.dataType) && attachmentContext) {
            return (
              <Box key={def.key} sx={{ py: 1.25, px: 0.5, borderBottom: '1px solid', borderColor: 'divider' }}>
                <SignatureFieldWithVerdict
                  def={def}
                  fields={sorted}
                  control={control}
                  value={rawValue}
                  readOnly
                  readOnlyValues={readOnlyValues}
                  attachmentContext={attachmentContext}
                  signatureContext={signatureContext}
                  label={def.label}
                  onChange={() => {}}
                />
              </Box>
            )
          }

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
          // Type-aware: a chosen option can be the alert, so gating this on 'number' left a
          // read-only review showing a dangerous state in the same colour as a normal one.
          // `readOnlyValues` is the whole entry, so a state condition resolves here exactly as
          // the server resolved it at write time. Without it this review would redden a reading
          // the exception report calls clean — and a disagreement between the two reads as a bug
          // in the report, which is the surface people trust.
          const rangeSeverity = def.validation
            ? evaluateFieldSeverity(def.dataType, rawValue, def.validation, readOnlyValues)
            : 'ok'
          const isChoice = def.dataType === 'select' || def.dataType === 'multiselect'
          const rangeFeedback = isChoice
            ? optionSeverityMessage(rangeSeverity)
            : severityMessage(rangeSeverity)
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
        const gate = gatePlans.get(def.key)

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

        // Before the attachment branch: a signature IS an image for storage, and that branch
        // would hand the operator a camera for a field that wants a pen.
        if (isSignatureDataType(def.dataType) && attachmentContext) {
          return (
            <Controller
              key={fieldName}
              name={fieldName}
              control={control}
              rules={rules}
              render={({ field }) => (
                <SignatureFieldWithVerdict
                  def={def}
                  fields={sorted}
                  control={control}
                  value={field.value}
                  readOnly={false}
                  attachmentContext={attachmentContext}
                  signatureContext={signatureContext}
                  label={def.label + (def.required ? ' *' : '')}
                  onChange={field.onChange}
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
            // Every type that HAS a threshold, not just numbers. Gating this on 'number'
            // meant a select was handed no validation at all, so nothing coloured until
            // the entry was saved and reopened through the read-only path.
            rangeValidation={supportsSeverity(def.dataType) ? def.validation : undefined}
            // The siblings this field's condition reads, resolved HERE because this is the
            // component that holds the field list — and resolved case-insensitively, since the
            // server's key uniqueness is case-folded. Undefined for every ungated field.
            gateSources={gate?.names}
            gateKeys={gate?.keys}
            // Passed in rather than wrapped around: the scan icons belong inside the input so
            // the field keeps its label and its validation. An earlier version wrapped the
            // whole thing in a second Controller for the same name, which registered the field
            // twice and left it with no label at all.
            scan={readOnly ? undefined : (scanFieldConfig(def) ?? undefined)}
          />
        )
      })}
    </Box>
  )
}
