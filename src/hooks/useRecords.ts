import { useEffect, useCallback } from 'react'
import { useAppStore } from '@/store'
import { getAllRecords, saveRecord, deleteRecord, approveRecord, updateRecord } from '@/services/storage'
import type { DataRecord } from '@/types'

export function useRecords() {
  const records = useAppStore(s => s.records)
  const isLoading = useAppStore(s => s.recordsLoading)
  const setRecords = useAppStore(s => s.setRecords)
  const setLoading = useAppStore(s => s.setRecordsLoading)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const all = await getAllRecords()
      setRecords(all)
    } finally {
      setLoading(false)
    }
  }, [setRecords, setLoading])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addRecord = useCallback(
    async (data: Omit<DataRecord, 'id' | 'localId' | 'createdAt' | 'updatedAt' | 'syncStatus'>) => {
      const record = await saveRecord(data)
      await refresh()
      return record
    },
    [refresh]
  )

  const removeRecord = useCallback(
    async (localId: string) => {
      await deleteRecord(localId)
      await refresh()
    },
    [refresh]
  )

  const confirmRecord = useCallback(
    async (localId: string) => {
      await approveRecord(localId)
      await refresh()
    },
    [refresh]
  )

  const editRecord = useCallback(
    async (localId: string, updates: Partial<DataRecord>) => {
      await updateRecord(localId, updates)
      await refresh()
    },
    [refresh]
  )

  return { records, isLoading, refresh, addRecord, removeRecord, confirmRecord, editRecord }
}
