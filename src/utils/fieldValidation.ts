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
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  // A string that is only whitespace is *absent*, not zero. `Number('')` is 0 in JavaScript, so
  // the earlier `value === ''` check let '   ' through as a reading of 0 — which against a band
  // of 5–25 is a DANGER. The backend's `Double.parseDouble` throws on the same input and yields
  // null, so the two disagreed: this app would paint a field red that the server's stored
  // max_severity calls clean. The same correction applies to a blank *bound*, which now means
  // "no bound" rather than "bounded at zero", again matching the backend.
  const text = String(value).trim()
  if (text === '') return null
  const n = Number(text)
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

/**
 * A number field is signed. Always.
 *
 * There used to be an `allowsNegative(validation)` here that decided per field, and it decided
 * wrongly: a minus sign was accepted only when the warning or danger range happened to have a
 * negative minimum. Nothing else about the field mattered — not its unit, not its meaning. So a
 * temperature below zero, a vacuum pressure or a level under datum could not be entered at all
 * unless somebody had configured a negative threshold first, and the operator standing in front
 * of the equipment had no way to record the reading except to type a wrong one.
 *
 * The explicit `validation.allowNegative` escape hatch was worse than useless. The backend has no
 * such concept anywhere, the web panel cannot set it, and `FieldValidationSupport.build(...)`
 * constructs a fresh map holding only `options`, `warning` and `danger` on every save — so a key
 * added by hand to the database was erased the next time anyone edited that field.
 *
 * Ranges decide **severity**, not what may be typed. A negative value below `warning.min` is
 * flagged as a breach exactly as it should be, by the same code that judges every other reading —
 * see {@link evaluateNumericSeverity}, which mirrors the backend's `evaluateNumeric`. A field that
 * genuinely cannot go below zero is expressed as a danger range with `min: 0`, which surfaces the
 * mistake instead of silently swallowing the keystroke.
 *
 * The web panel's fill form has always accepted negatives — a bare `<input type="number">` with no
 * `min` — so this also ends a disagreement between two clients of the same system.
 */
const NUMERIC_INPUT = /^-?\d*\.?\d*$/

/**
 * Restrict keystrokes/paste to a valid in-progress decimal literal.
 *
 * Character by character rather than testing the whole string, so a paste of `12x.5` yields
 * `12.5` instead of being rejected outright, and a partial `-` or `1.` survives while the
 * operator is still typing. {@link normalizeNumericOnBlur} tidies those up afterwards.
 */
export function filterNumericInput(raw: string): string {
  const trimmed = raw.replace(/\s/g, '')
  if (!trimmed) return ''

  let result = ''
  for (const ch of trimmed) {
    const candidate = result + ch
    if (NUMERIC_INPUT.test(candidate)) result = candidate
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

/**
 * Normalize partial input on blur — drop a lone "-" or a trailing ".".
 *
 * These are states the operator passes *through* while typing, so they must be legal during
 * input and gone once the field is left; `-` alone or `1.` would otherwise be submitted as a
 * value. It no longer strips a leading minus: the sign is the operator's answer, not a mistake.
 */
export function normalizeNumericOnBlur(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '-' || trimmed === '.' || trimmed === '-.') return ''
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
