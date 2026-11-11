import type { FieldStateCondition, FieldStateGate, FieldValidation } from '@/types/sync'

export interface NumericRange {
  min?: number
  max?: number
}

export type FieldValidationSeverity = 'ok' | 'warning' | 'danger'

export const FIELD_VALIDATION_MESSAGES = {
  warning: 'خارج از بازه هشدار است.',
  danger: 'خارج از بازه خطر است.'
} as const

/**
 * The same two verdicts for a CHOICE rather than a range.
 *
 * Separate wording because the polarity is the opposite: a number is out of its band, an option
 * *is* the alert. Telling an operator a chosen option is "outside the warning range" would be
 * describing a rule that does not exist.
 */
export const FIELD_OPTION_MESSAGES = {
  warning: 'این گزینه هشدار محسوب می‌شود.',
  danger: 'این گزینه خطر محسوب می‌شود.'
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

/**
 * Static hint shown under numeric fields — same format as backend summaryFa.
 *
 * The gate is part of it, not beside it. A band shown on its own IS the rule as far as the
 * person reading it is concerned, so an operator standing at a stopped pump would see
 * «خطر: ≥ 4.5» against a true reading of 0 and either re-read the meter or type something the
 * instrument never said.
 */
export function validationSummaryFa(validation?: FieldValidation | Record<string, unknown>): string | null {
  const conditions = stateConditions(validation)
  if (conditions.length === 0) return thresholdSummaryFa(validation)

  const parts: string[] = []
  for (const condition of conditions) {
    const gate = gateSummaryFa(condition.when)
    if (!gate) {
      parts.push('شرط نامعتبر')
      continue
    }
    const bands = thresholdSummaryFa(declaredThresholds(validation, condition) ?? validation)
    parts.push(bands ? `فقط وقتی ${gate} → ${bands}` : `فقط وقتی ${gate}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

/** The bands alone, with nothing said about when they apply. */
export function thresholdSummaryFa(
  validation?: FieldValidation | Record<string, unknown>
): string | null {
  const parts: string[] = []
  appendRangeSummary(parts, 'هشدار', warningRange(validation))
  appendRangeSummary(parts, 'خطر', dangerRange(validation))
  return parts.length > 0 ? parts.join(' · ') : null
}

// ---------------------------------------------------------------------------------------------
// State conditions — WHEN the thresholds apply.
//
// This block mirrors the server's `FieldValidationSupport` exactly, and the mirror is the point:
// the device paints a reading the instant it is typed and the server stamps `max_severity` when
// it arrives, so any disagreement shows up as the app calling a reading red that the exception
// report calls clean. Nothing here throws, and nothing matches by accident: a malformed gate, an
// operator this build does not know, a sibling with no answer — each is "does not hold", which
// falls through to the next condition and, failing that, suppresses the field. The opposite
// default would turn an unreadable blob into an alert.
// ---------------------------------------------------------------------------------------------

const GATE_OPTION_OPS = new Set(['in', 'notIn'])
const GATE_NUMBER_OPS = new Set(['gt', 'gte', 'lt', 'lte'])
const GATE_OPS = new Set([...GATE_OPTION_OPS, ...GATE_NUMBER_OPS, 'answered', 'notAnswered'])
const THRESHOLD_KEYS = ['warning', 'danger', 'warningOptions', 'dangerOptions'] as const

/** The conditions as stored, read defensively: anything else is "no conditions". */
export function stateConditions(
  validation?: FieldValidation | Record<string, unknown>
): FieldStateCondition[] {
  const raw = (validation as Record<string, unknown> | undefined)?.conditions
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (c): c is FieldStateCondition => c != null && typeof c === 'object' && !Array.isArray(c)
  )
}

/** Whether this field's thresholds are gated at all. */
export function hasStateCondition(
  validation?: FieldValidation | Record<string, unknown>
): boolean {
  return stateConditions(validation).length > 0
}

/**
 * The distinct sibling keys this field's conditions read, in order of first appearance.
 *
 * **This is what makes the live colouring cheap and correct.** A gate needs one other answer,
 * not the whole entry: the form watches exactly these names, so only the gated field re-renders
 * when its gate's parameter changes, and nothing sets react-hook-form's `watchAll`. Watching the
 * whole entry instead would re-render all 22 of an asset's fields on every keystroke.
 *
 * Returned as the keys the gates *name*; the caller resolves each to the field it actually has,
 * case-insensitively, because the server's key uniqueness is case-folded.
 */
export function stateConditionFieldKeys(
  validation?: FieldValidation | Record<string, unknown>
): string[] {
  const out: string[] = []
  for (const condition of stateConditions(validation)) {
    const field = condition.when?.field
    if (typeof field !== 'string') continue
    const trimmed = field.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/** Whether an answer is present at all. A blank string is ABSENT, not an answer of "". */
function isAnswered(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  return true
}

/** Whether one gate holds for this entry's answers. */
export function gateHolds(
  gate: FieldStateGate | undefined,
  siblings: Record<string, unknown> | undefined | null
): boolean {
  if (!gate || !siblings) return false
  const field = typeof gate.field === 'string' ? gate.field.trim() : ''
  const op = typeof gate.op === 'string' ? gate.op.trim() : ''
  if (!field || !GATE_OPS.has(op)) return false

  // Case-insensitive, as the server's key uniqueness already is. A case-sensitive lookup would
  // make a correctly configured danger gate silently never match, which turns a danger band
  // into a parameter nothing judges.
  const wanted = field.toLowerCase()
  let answer: unknown
  for (const key of Object.keys(siblings)) {
    if (key.toLowerCase() === wanted) {
      answer = siblings[key]
      break
    }
  }
  const answered = isAnswered(answer)

  if (op === 'answered') return answered
  if (op === 'notAnswered') return !answered
  // «We do not know» is never «it was in this state».
  if (!answered) return false

  if (GATE_OPTION_OPS.has(op)) {
    const values = Array.isArray(gate.values)
      ? gate.values.filter(v => v != null).map(v => String(v).trim()).filter(Boolean)
      : []
    if (values.length === 0) return false
    const chosen = (Array.isArray(answer) ? answer : [answer])
      .filter(v => v != null)
      .map(v => String(v).trim())
    // Trimmed and case-SENSITIVE, exactly as evaluateOptionSeverity compares.
    const any = chosen.some(c => values.includes(c))
    return op === 'in' ? any : !any
  }

  const actual = toNumber(answer)
  const bound = toNumber(gate.value)
  if (actual == null || bound == null) return false
  if (op === 'gt') return actual > bound
  if (op === 'gte') return actual >= bound
  if (op === 'lt') return actual < bound
  return actual <= bound
}

/**
 * The condition's own thresholds over the field's non-threshold keys, or null when it has none.
 *
 * A condition that declares any of the four states them COMPLETELY: one it omits is absent in
 * this state rather than inherited, because a state the administrator described as «danger
 * only» has no warning band, and inheriting one meant for the other state would alert on
 * readings this state calls normal. (An asset override is the opposite — it is a layer, not a
 * state — and `sheetFieldDefinitions.ts` keeps the class's band where the override is silent.)
 */
function declaredThresholds(
  validation: FieldValidation | Record<string, unknown> | undefined,
  condition: FieldStateCondition
): Record<string, unknown> | null {
  const declares = THRESHOLD_KEYS.some(k => k in condition)
  if (!declares) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries((validation ?? {}) as Record<string, unknown>)) {
    if (k === 'conditions' || k === 'min' || k === 'max') continue
    if ((THRESHOLD_KEYS as readonly string[]).includes(k)) continue
    out[k] = v
  }
  for (const k of THRESHOLD_KEYS) {
    const value = (condition as Record<string, unknown>)[k]
    if (k in condition && value != null) out[k] = value
  }
  return out
}

/**
 * The thresholds in force for this reading, or **null** when the field is suppressed.
 *
 * Returns the same object for the overwhelmingly common ungated field, so nothing is copied per
 * keystroke.
 */
export function thresholdsFor(
  validation: FieldValidation | Record<string, unknown> | undefined,
  siblings: Record<string, unknown> | undefined | null
): FieldValidation | Record<string, unknown> | undefined | null {
  const conditions = stateConditions(validation)
  if (conditions.length === 0) return validation
  for (const condition of conditions) {
    if (!gateHolds(condition.when, siblings)) continue
    return declaredThresholds(validation, condition) ?? validation
  }
  return null
}

/** One gate in words — «status یکی از: روشن» — or null when it cannot be read. */
export function gateSummaryFa(gate: FieldStateGate | undefined): string | null {
  if (!gate) return null
  const field = typeof gate.field === 'string' ? gate.field.trim() : ''
  const op = typeof gate.op === 'string' ? gate.op.trim() : ''
  if (!field || !GATE_OPS.has(op)) return null

  const label = GATE_OPERATOR_LABELS[op]
  if (GATE_OPTION_OPS.has(op)) {
    const values = Array.isArray(gate.values)
      ? gate.values.filter(v => v != null).map(v => String(v).trim()).filter(Boolean)
      : []
    if (values.length === 0) return null
    return `${field} ${label}: ${values.join('، ')}`
  }
  if (GATE_NUMBER_OPS.has(op)) {
    const bound = toNumber(gate.value)
    if (bound == null) return null
    return `${field} ${label} ${bound}`
  }
  return `${field} ${label}`
}

/**
 * «فقط وقتی status یکی از: روشن» — the condition alone, for a surface that renders the
 * thresholds separately (a choice field, whose severities are a list rather than a range).
 */
export function stateConditionSummaryFa(
  validation?: FieldValidation | Record<string, unknown>
): string | null {
  const parts: string[] = []
  for (const condition of stateConditions(validation)) {
    const gate = gateSummaryFa(condition.when)
    if (gate) parts.push(`فقط وقتی ${gate}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

/** The same Persian labels the panel's dropdown shows — `FieldGateOperators`. */
const GATE_OPERATOR_LABELS: Record<string, string> = {
  in: 'یکی از',
  notIn: 'هیچ‌کدام از',
  gt: 'بیشتر از',
  gte: 'بیشتر یا مساوی',
  lt: 'کمتر از',
  lte: 'کمتر یا مساوی',
  answered: 'پاسخ داده شده باشد',
  notAnswered: 'پاسخ داده نشده باشد'
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

/**
 * The severity of a chosen option, or of the worst of several.
 *
 * Mirrors the backend's `FieldValidationSupport.evaluateOptionValue`, including the two things
 * that are easy to get wrong and invisible when wrong:
 *
 *  - a `multiselect` reading is an array and takes the **worst** of what was chosen, so one
 *    dangerous tick among five safe ones is a danger;
 *  - the comparison is trimmed but **case-sensitive**, because the server's submit-time
 *    allow-list is. A looser rule here tells an operator a reading is fine that the server
 *    then stores as a danger.
 *
 * A field that names no severities is never an alert, so adding a vocabulary cannot raise one
 * on its own.
 */
export function evaluateOptionSeverity(
  value: unknown,
  validation?: FieldValidation | Record<string, unknown>
): FieldValidationSeverity {
  if (value == null || !validation) return 'ok'
  const dangers = optionList(validation, 'dangerOptions')
  const warnings = optionList(validation, 'warningOptions')
  if (dangers.length === 0 && warnings.length === 0) return 'ok'

  const chosen = (Array.isArray(value) ? value : [value])
    .filter(v => v != null)
    .map(v => String(v).trim())
    .filter(Boolean)

  let warned = false
  for (const option of chosen) {
    if (dangers.includes(option)) return 'danger'
    if (warnings.includes(option)) warned = true
  }
  return warned ? 'warning' : 'ok'
}

/** One stored severity list, tolerating the shapes JSON can hand back. */
export function optionList(
  validation: FieldValidation | Record<string, unknown> | undefined,
  key: 'warningOptions' | 'dangerOptions' | 'options'
): string[] {
  const raw = (validation as Record<string, unknown> | undefined)?.[key]
  if (!Array.isArray(raw)) return []
  return raw
    .filter(v => v != null)
    .map(v => String(v).trim())
    .filter(Boolean)
}

/**
 * The severity of one reading, chosen by the field's type — the single entry point.
 *
 * `evaluateNumericSeverity` answers `ok` for anything that is not a number, so a select field
 * could never be anything but fine however it was configured. The backend dispatches the same
 * way (`FieldValidationSupport.evaluateValue`); a type with no notion of severity is `ok`,
 * because a photo and a note are not in or out of range.
 */
export function evaluateFieldSeverity(
  dataType: string | undefined,
  value: unknown,
  validation?: FieldValidation | Record<string, unknown>,
  siblings?: Record<string, unknown> | null
): FieldValidationSeverity {
  // `siblings` is every answer on this entry, so a state condition can be judged. Omitting it
  // cannot match a gate, so a gated field read without them resolves to `ok` — the safe
  // direction for an alert (a missed colour beats a plant full of false red), and what every
  // caller that genuinely has no entry in hand should get.
  const thresholds = thresholdsFor(validation, siblings)
  if (thresholds == null && hasStateCondition(validation)) return 'ok'
  const effective = thresholds ?? undefined
  if (isChoiceType(dataType)) return evaluateOptionSeverity(value, effective)
  if (dataType === 'number') return evaluateNumericSeverity(value, effective)
  return 'ok'
}

/** A field that offers a vocabulary, and therefore has option severities rather than a range. */
export function isChoiceType(dataType: string | undefined): boolean {
  return dataType === 'select' || dataType === 'multiselect'
}

/**
 * Whether this type has any notion of being in or out of range.
 *
 * **Exported so the component that decides whether to PASS a field's validation down and the
 * function that decides what to DO with it cannot disagree.** They did: the form only handed
 * `validation` to a field whose type was `number`, so a select never received its own
 * thresholds and nothing coloured while the operator was choosing — the severity only appeared
 * once the entry had been saved and reopened, which is a different code path (the read-only
 * review) that reads `def.validation` directly. Two type lists, one of them narrower, and the
 * gap between them was the bug.
 */
export function supportsSeverity(dataType: string | undefined): boolean {
  return dataType === 'number' || isChoiceType(dataType)
}

/** The alerting options as a reader should see them, or null when there are none. */
export function optionSeveritySummaryFa(
  validation?: FieldValidation | Record<string, unknown>
): string | null {
  const parts: string[] = []
  const warnings = optionList(validation, 'warningOptions')
  const dangers = optionList(validation, 'dangerOptions')
  if (warnings.length > 0) parts.push(`هشدار: ${warnings.join('، ')}`)
  if (dangers.length > 0) parts.push(`خطر: ${dangers.join('، ')}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** The message for a chosen option, which is worded differently from a range breach. */
export function optionSeverityMessage(severity: FieldValidationSeverity): string | null {
  if (severity === 'warning') return FIELD_OPTION_MESSAGES.warning
  if (severity === 'danger') return FIELD_OPTION_MESSAGES.danger
  return null
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
