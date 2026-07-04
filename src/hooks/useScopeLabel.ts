import { useEffect, useState } from 'react'
import { formatScopeSummary } from '@/utils/scopeLabels'

export function useScopeLabel(scopeSummary: string | undefined, templateId?: string): string {
  const [label, setLabel] = useState(scopeSummary?.trim() || '—')

  useEffect(() => {
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
  }, [scopeSummary, templateId])

  return label
}
