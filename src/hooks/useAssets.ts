import { useState, useCallback, useEffect } from 'react'
import {
  getAllAssetClasses,
  getAssetClass,
  saveAssetClass,
  updateAssetClass,
  deleteAssetClass,
  getAllAssetEntries,
  getAssetEntryByTagId,
  saveAssetEntry,
  updateAssetEntry,
  deleteAssetEntry
} from '@/services/storage'
import type { AssetClass, AssetEntry } from '@/types'

// ---------------------------------------------------------------------------
// Asset Classes (was useAssetTypes)
// ---------------------------------------------------------------------------

export function useAssetClasses() {
  const [assetClasses, setAssetClasses] = useState<AssetClass[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setAssetClasses(await getAllAssetClasses())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addAssetClass = useCallback(
    async (data: Omit<AssetClass, 'id' | 'createdAt' | 'updatedAt'>) => {
      const result = await saveAssetClass(data)
      await refresh()
      return result
    },
    [refresh]
  )

  const editAssetClass = useCallback(
    async (id: string, updates: Partial<Omit<AssetClass, 'id' | 'createdAt'>>) => {
      await updateAssetClass(id, updates)
      await refresh()
    },
    [refresh]
  )

  const removeAssetClass = useCallback(
    async (id: string) => {
      await deleteAssetClass(id)
      await refresh()
    },
    [refresh]
  )

  const findAssetClass = useCallback(
    (id: string) => assetClasses.find(c => c.id === id),
    [assetClasses]
  )

  return { assetClasses, loading, refresh, addAssetClass, editAssetClass, removeAssetClass, findAssetClass }
}

// ---------------------------------------------------------------------------
// Asset Entries
// ---------------------------------------------------------------------------

export function useAssetEntries() {
  const [assetEntries, setAssetEntries] = useState<AssetEntry[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setAssetEntries(await getAllAssetEntries())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addAssetEntry = useCallback(
    async (data: Omit<AssetEntry, 'id' | 'createdAt' | 'updatedAt'>) => {
      const result = await saveAssetEntry(data)
      await refresh()
      return result
    },
    [refresh]
  )

  const editAssetEntry = useCallback(
    async (id: string, updates: Partial<Omit<AssetEntry, 'id' | 'createdAt'>>) => {
      await updateAssetEntry(id, updates)
      await refresh()
    },
    [refresh]
  )

  const removeAssetEntry = useCallback(
    async (id: string) => {
      await deleteAssetEntry(id)
      await refresh()
    },
    [refresh]
  )

  return { assetEntries, loading, refresh, addAssetEntry, editAssetEntry, removeAssetEntry }
}

// ---------------------------------------------------------------------------
// Lookup by tag ID (used in CollectPage)
// ---------------------------------------------------------------------------

export async function lookupTag(
  nfcTagId: string
): Promise<{ entry: AssetEntry; assetClass: AssetClass } | null> {
  const entry = await getAssetEntryByTagId(nfcTagId)
  if (!entry) return null
  const assetClass = await getAssetClass(entry.classId)
  if (!assetClass) return null
  return { entry, assetClass }
}
