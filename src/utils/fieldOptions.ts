import type { FormFieldOption } from '@/types'

type RawOption = string | { value?: string; label?: string } | null | undefined

/** Backend may send options as string[] or { value, label }[]. */
export function normalizeFieldOptions(raw: unknown): FormFieldOption[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((opt: RawOption, index) => {
      if (typeof opt === 'string') {
        const trimmed = opt.trim()
        if (!trimmed) return null
        return { value: trimmed, label: trimmed }
      }
      if (opt && typeof opt === 'object') {
        const value = opt.value != null ? String(opt.value) : String(index)
        const label =
          opt.label != null && String(opt.label).trim()
            ? String(opt.label)
            : value
        return { value, label }
      }
      return null
    })
    .filter((o): o is FormFieldOption => o != null)
}

export function resolveOptionLabel(
  options: FormFieldOption[] | undefined,
  value: unknown
): string {
  if (value === undefined || value === null || value === '') return '—'
  if (Array.isArray(value)) {
    return value.map(v => resolveOptionLabel(options, v)).join('، ')
  }
  const str = String(value)
  const match = options?.find(o => o.value === str)
  return match?.label ?? str
}
