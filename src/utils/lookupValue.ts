/**
 * The answer of a `lookup` / `lookupmulti` field (backend roadmap §31 Phase 2).
 *
 * Stored by the server as `{ code, label, state }` — one, or an array of them. The device sends
 * `{ code, label }` and the server decides the rest: a known code takes the list's label (a label
 * cannot be forged for a real person), and `state` says whether the code was `ACTIVE`, `INACTIVE`
 * (retired before the answer arrived) or `UNKNOWN` (not in the list — typed in code-only mode).
 * Neither of the last two is refused: an operator cannot repair a refused offline submission.
 *
 * Mirrors the backend's `LookupValues`. Reading is lenient — a bare code is a choice — because an
 * answer this build cannot fully read must survive a save, never vanish from it.
 */

export type LookupState = 'ACTIVE' | 'INACTIVE' | 'UNKNOWN'

export interface LookupChoiceValue {
  code: string
  label?: string
  state?: LookupState
}

/** Mirrors the server's ceiling (`LookupValues.MAX_CHOICES`). */
export const MAX_LOOKUP_CHOICES = 50

export function isLookupDataType(dataType: string | undefined): boolean {
  return dataType === 'lookup' || dataType === 'lookupmulti'
}

export function isLookupMulti(dataType: string | undefined): boolean {
  return dataType === 'lookupmulti'
}

/** Persian and Arabic-Indic digits to Latin, as the server's code normaliser does. */
export function latinDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
}

/** A code as the list keys it, or null when it could never be one (blank, a space, too long). */
export function normalizeLookupCode(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  const code = latinDigits(String(raw).trim())
  if (!code || code.length > 100 || /[\s\p{Cc}\p{Cf}]/u.test(code)) return null
  return code
}

/** The chosen items of a value, whatever shape it arrived in, duplicates (by code) collapsed. */
export function lookupChoices(value: unknown): LookupChoiceValue[] {
  if (value === undefined || value === null || value === '') return []
  const items = Array.isArray(value) ? value : [value]
  const out: LookupChoiceValue[] = []
  const seen = new Set<string>()
  for (const item of items) {
    let choice: LookupChoiceValue | null = null
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>
      const code = normalizeLookupCode(record.code)
      if (code) {
        choice = {
          code,
          ...(typeof record.label === 'string' && record.label.trim() ? { label: record.label.trim() } : {}),
          ...(record.state === 'ACTIVE' || record.state === 'INACTIVE' || record.state === 'UNKNOWN'
            ? { state: record.state as LookupState }
            : {})
        }
      }
    } else if (typeof item === 'string' || typeof item === 'number') {
      const code = normalizeLookupCode(item)
      if (code) choice = { code }
    }
    if (choice && !seen.has(choice.code.toLowerCase())) {
      seen.add(choice.code.toLowerCase())
      out.push(choice)
    }
  }
  return out
}

/** The value to store in the form: one object (or null), or an array, as the type says. */
export function toLookupValue(choices: LookupChoiceValue[], multi: boolean): unknown {
  if (multi) return choices.length ? choices : []
  return choices[0] ?? null
}

/** «علی رضایی (1234)», with the server's verdict beside it when it is not the ordinary case. */
export function lookupChoiceText(choice: LookupChoiceValue): string {
  const base = choice.label && choice.label !== choice.code ? `${choice.label} (${choice.code})` : choice.code
  if (choice.state === 'INACTIVE') return `${base} · غیرفعال`
  if (choice.state === 'UNKNOWN') return `${base} · خارج از فهرست`
  return base
}

/** Every choice of a value as a reader sees it, or null for no answer. */
export function lookupDisplayValue(value: unknown): string | null {
  const choices = lookupChoices(value)
  return choices.length ? choices.map(lookupChoiceText).join('، ') : null
}
