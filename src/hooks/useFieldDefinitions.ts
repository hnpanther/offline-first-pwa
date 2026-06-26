import { useState, useCallback, useEffect } from 'react'
import {
  getFieldsForClass,
  saveFieldDefinition,
  updateFieldDefinition,
  deleteFieldDefinition,
  reorderFieldDefinitions,
} from '@/services/storage/fieldDefinitions'
import type { FieldDefinition } from '@/types/sync'

/**
 * Hook for managing field definitions of a single AssetClass.
 *
 * Usage in AdminPage (class editor):
 *   const { fields, addField, editField, removeField } = useFieldDefinitions(cls.id)
 *
 * Usage in LogSheetFillPage (read-only):
 *   const { fields, loading } = useFieldDefinitions(entry.classId)
 */
export function useFieldDefinitions(classId: string | undefined) {
  const [fields, setFields] = useState<FieldDefinition[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!classId) {
      setFields([])
      return
    }
    setLoading(true)
    try {
      setFields(await getFieldsForClass(classId))
    } finally {
      setLoading(false)
    }
  }, [classId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addField = useCallback(
    async (data: Omit<FieldDefinition, 'id' | 'createdAt' | 'updatedAt' | 'version' | 'deleted' | 'synced'>) => {
      if (!classId) throw new Error('classId is required')
      const result = await saveFieldDefinition({ ...data, classId })
      await refresh()
      return result
    },
    [classId, refresh]
  )

  const editField = useCallback(
    async (id: string, updates: Partial<Omit<FieldDefinition, 'id' | 'createdAt' | 'version' | 'synced'>>) => {
      await updateFieldDefinition(id, updates)
      await refresh()
    },
    [refresh]
  )

  const removeField = useCallback(
    async (id: string) => {
      await deleteFieldDefinition(id)
      await refresh()
    },
    [refresh]
  )

  const reorderFields = useCallback(
    async (orderedIds: string[]) => {
      if (!classId) return
      await reorderFieldDefinitions(classId, orderedIds)
      await refresh()
    },
    [classId, refresh]
  )

  return { fields, loading, refresh, addField, editField, removeField, reorderFields }
}
