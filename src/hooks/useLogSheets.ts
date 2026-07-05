import { useState, useCallback, useEffect } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useAppStore } from '@/store'
import {
  getAllLogSheetTemplates,
  saveLogSheetTemplate,
  updateLogSheetTemplate,
  deleteLogSheetTemplate,
  getAllLogSheets,
  saveLogSheet,
  updateLogSheet,
  deleteLogSheet
} from '@/services/storage'
import type { LogSheetTemplate, LogSheet } from '@/types'

// ---------------------------------------------------------------------------
// Log Sheet Templates
// ---------------------------------------------------------------------------

export function useLogSheetTemplates() {
  const [templates, setTemplates] = useState<LogSheetTemplate[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setTemplates(await getAllLogSheetTemplates())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addTemplate = useCallback(
    async (data: Omit<LogSheetTemplate, 'id' | 'createdAt' | 'updatedAt'>) => {
      const result = await saveLogSheetTemplate(data)
      await refresh()
      return result
    },
    [refresh]
  )

  const editTemplate = useCallback(
    async (id: string, updates: Partial<Omit<LogSheetTemplate, 'id' | 'createdAt'>>) => {
      await updateLogSheetTemplate(id, updates)
      await refresh()
    },
    [refresh]
  )

  const removeTemplate = useCallback(
    async (id: string) => {
      await deleteLogSheetTemplate(id)
      await refresh()
    },
    [refresh]
  )

  return { templates, loading, refresh, addTemplate, editTemplate, removeTemplate }
}

// ---------------------------------------------------------------------------
// Log Sheets
// ---------------------------------------------------------------------------

export function useLogSheets() {
  const [logs, setLogs] = useState<LogSheet[]>([])
  const [loading, setLoading] = useState(false)
  const lastSyncAt = useAppStore(s => s.lastSyncAt)
  const inboxLastSyncAt = useAppStore(s => s.inboxLastSyncAt)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setLogs(await getAllLogSheets())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (lastSyncAt != null) void refresh()
  }, [lastSyncAt, refresh])

  useEffect(() => {
    if (inboxLastSyncAt != null) void refresh()
  }, [inboxLastSyncAt, refresh])

  const addLogSheet = useCallback(
    async (data: Omit<LogSheet, 'id' | 'localId' | 'createdAt' | 'updatedAt' | 'syncStatus'>) => {
      const result = await saveLogSheet({ ...data, localId: uuidv4() })
      await refresh()
      return result
    },
    [refresh]
  )

  const editLogSheet = useCallback(
    async (localId: string, updates: Partial<LogSheet>) => {
      await updateLogSheet(localId, updates)
      await refresh()
    },
    [refresh]
  )

  const removeLogSheet = useCallback(
    async (localId: string) => {
      await deleteLogSheet(localId)
      await refresh()
    },
    [refresh]
  )

  return { logs, loading, refresh, addLogSheet, editLogSheet, removeLogSheet }
}
