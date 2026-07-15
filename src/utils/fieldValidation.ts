import type { FieldValidation } from '@/types/sync'

export interface NumericRange {
  min?: number
  max?: number
}

export type FieldValidationSeverity = 'ok' | 'warning' | 'danger'

export const FIELD_VALIDATION_MESSAGES = {
  warning: 'خارج از بازه هشدار است.',
  danger: 'خارج از بازه خطر است.'
} as const

function toNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const n = Number(String(value).trim())
  return Number.isFinite(n) ? n : null
}

function nestedRange(
  validation: Record<string, unknown> | undefined,
  rangeKey: string
): NumericRange | null {
  if (!validation || !(rangeKey in validation)) return null
  const raw = validation[rangeKey]
  if (!raw || typeof raw !== 'object') return null
  const map = raw as Record<string, unknown>
  return {
    min: toNumber(map.min) ?? undefined,
    max: toNumber(map.max) ?? undefined
  }
}

function isEmptyRange(range: NumericRange | null | undefined): boolean {
  return range == null || (range.min == null && range.max == null)
}

function contains(range: NumericRange, value: number): boolean {
  if (range.min != null && value < range.min) return false
  if (range.max != null && value > range.max) return false
  return true
}

/** Mirrors backend FieldValidationSupport.warningRange (incl. legacy flat min/max). */
export function warningRange(validation?: FieldValidation | Record<string, unknown>): NumericRange {
  const v = validation as Record<string, unknown> | undefined
  const nested = nestedRange(v, 'warning')
  if (nested && !isEmptyRange(nested)) return nested
  if (v && ('min' in v || 'max' in v)) {
    return {
      min: toNumber(v.min) ?? undefined,
      max: toNumber(v.max) ?? undefined
    }
  }
  return {}
}

/** Mirrors backend FieldValidationSupport.dangerRange. */
export function dangerRange(validation?: FieldValidation | Record<string, unknown>): NumericRange {
  const nested = nestedRange(validation as Record<string, unknown> | undefined, 'danger')
  return nested && !isEmptyRange(nested) ? nested : {}
}

function appendRangeSummary(parts: string[], label: string, range: NumericRange): void {
  if (isEmptyRange(range)) return
  if (range.min != null && range.max != null) {
    parts.push(`${label}: ${range.min}–${range.max}`)
  } else if (range.min != null) {
    parts.push(`${label}: ≥ ${range.min}`)
  } else if (range.max != null) {
    parts.push(`${label}: ≤ ${range.max}`)
  }
}

/** Static hint shown under numeric fields — same format as backend summaryFa. */
export function validationSummaryFa(validation?: FieldValidation | Record<string, unknown>): string | null {
  const parts: string[] = []
  appendRangeSummary(parts, 'هشدار', warningRange(validation))
  appendRangeSummary(parts, 'خطر', dangerRange(validation))
  return parts.length > 0 ? parts.join(' · ') : null
}

export function evaluateNumericSeverity(
  value: unknown,
  validation?: FieldValidation | Record<string, unknown>
): FieldValidationSeverity {
  const numeric = toNumber(value)
  if (numeric == null) return 'ok'

  const danger = dangerRange(validation)
  if (!isEmptyRange(danger) && !contains(danger, numeric)) return 'danger'

  const warning = warningRange(validation)
  if (!isEmptyRange(warning) && !contains(warning, numeric)) return 'warning'

  return 'ok'
}

export function severityMessage(severity: FieldValidationSeverity): string | null {
  if (severity === 'warning') return FIELD_VALIDATION_MESSAGES.warning
  if (severity === 'danger') return FIELD_VALIDATION_MESSAGES.danger
  return null
}

/** Whether a numeric field should accept negative values (± toggle + signed input). */
export function allowsNegative(validation?: FieldValidation | Record<string, unknown>): boolean {
  const v = validation as Record<string, unknown> | undefined
  if (v?.allowNegative === true) return true
  if (v?.allowNegative === false) return false

  const wr = warningRange(validation)
  const dr = dangerRange(validation)
  if (wr.min != null && wr.min < 0) return true
  if (dr.min != null && dr.min < 0) return true
  if (v && 'min' in v) {
    const legacyMin = toNumber(v.min)
    if (legacyMin != null && legacyMin < 0) return true
  }
  return false
}

const UNSIGNED_NUMERIC_INPUT = /^\d*\.?\d*$/
const SIGNED_NUMERIC_INPUT = /^-?\d*\.?\d*$/

/** Restrict keystrokes/paste to a valid in-progress decimal literal. */
export function filterNumericInput(raw: string, allowNegative: boolean): string {
  const trimmed = raw.replace(/\s/g, '')
  if (!trimmed) return ''

  const pattern = allowNegative ? SIGNED_NUMERIC_INPUT : UNSIGNED_NUMERIC_INPUT
  let result = ''
  for (const ch of trimmed) {
    const candidate = result + ch
    if (pattern.test(candidate)) result = candidate
  }
  return result
}

export function formatNumericDisplay(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : ''
  }
  return String(value)
}

/** Normalize partial input on blur — drop lone "-" or trailing "." */
export function normalizeNumericOnBlur(raw: string, allowNegative: boolean): string {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '-' || trimmed === '.' || trimmed === '-.') return ''
  if (!allowNegative && trimmed.startsWith('-')) return trimmed.replace(/^-/, '')
  if (trimmed.endsWith('.')) return trimmed.slice(0, -1)
  return trimmed
}

/** Flip sign for ± control — keeps absolute value, toggles leading minus. */
export function toggleNumericSign(value: unknown): string {
  const text = formatNumericDisplay(value).trim()
  if (!text || text === '-' || text === '.' || text === '-.') return text.startsWith('-') ? '' : '-'
  if (text.startsWith('-')) return text.slice(1)
  return `-${text}`
}
