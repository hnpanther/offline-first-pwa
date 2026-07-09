import { useEffect, useState } from 'react'
import { formatScopeSummary } from '@/utils/scopeLabels'

export function useScopeLabel(
  scopeSummary: string | undefined,
  templateId?: string,
  scopeDisplayLabel?: string
): string {
  const prefilled = scopeDisplayLabel?.trim()
  const [label, setLabel] = useState(prefilled || scopeSummary?.trim() || '—')

  useEffect(() => {
    if (prefilled) {
      setLabel(prefilled)
      return
    }
    if (!scopeSummary?.trim()) {
      setLabel('—')
      return
    }
    let cancelled = false
    void formatScopeSummary(scopeSummary, templateId).then(resolved => {
      if (!cancelled) setLabel(resolved)
    })
    return () => {
      cancelled = true
    }
  }, [scopeSummary, templateId, prefilled])

  return label
}
