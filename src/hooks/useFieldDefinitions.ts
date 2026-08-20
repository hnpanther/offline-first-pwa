import { useState, useCallback, useEffect } from 'react'
import { getFieldsForClass } from '@/services/storage/fieldDefinitions'
import type { FieldDefinition } from '@/types/sync'
import { toIdString } from '@/utils/ids'

/**
 * A single asset class's field definitions, as this device currently holds them.
 *
 * Read-only: field definitions are server-owned and arrive inside a log-sheet bundle. The hook
 * used to expose `addField`/`editField`/`removeField`/`reorderFields` for a class editor that
 * this app does not have and should not have — no screen ever called them, and the writes they
 * wrapped queued outbox rows for a push endpoint that was never built.
 */
export function useFieldDefinitions(classId: string | undefined) {
  const [fields, setFields] = useState<FieldDefinition[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    const normalizedId = classId ? toIdString(classId) : ''
    if (!normalizedId) {
      setFields([])
      return
    }
    setLoading(true)
    try {
      setFields(await getFieldsForClass(normalizedId))
    } finally {
      setLoading(false)
    }
  }, [classId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { fields, loading, refresh }
}
