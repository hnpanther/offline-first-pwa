import { useState, useCallback, useEffect } from 'react'
import {
  getAllAssetTypes,
  getAssetType,
  saveAssetType,
  updateAssetType,
  deleteAssetType,
  getAllAssetEntries,
  getAssetEntryByTagId,
  saveAssetEntry,
  updateAssetEntry,
  deleteAssetEntry
} from '@/services/storage'
import type { AssetType, AssetEntry } from '@/types'

// ---------------------------------------------------------------------------
// Asset Types
// ---------------------------------------------------------------------------

export function useAssetTypes() {
  const [assetTypes, setAssetTypes] = useState<AssetType[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setAssetTypes(await getAllAssetTypes())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addAssetType = useCallback(
    async (data: Omit<AssetType, 'id' | 'createdAt' | 'updatedAt'>) => {
      const result = await saveAssetType(data)
      await refresh()
      return result
    },
    [refresh]
  )

  const editAssetType = useCallback(
    async (id: string, updates: Partial<Omit<AssetType, 'id' | 'createdAt'>>) => {
      await updateAssetType(id, updates)
      await refresh()
    },
    [refresh]
  )

  const removeAssetType = useCallback(
    async (id: string) => {
      await deleteAssetType(id)
      await refresh()
    },
    [refresh]
  )

  const findAssetType = useCallback(
    (id: string) => assetTypes.find(t => t.id === id),
    [assetTypes]
  )

  return { assetTypes, loading, refresh, addAssetType, editAssetType, removeAssetType, findAssetType }
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
): Promise<{ entry: AssetEntry; assetType: AssetType } | null> {
  const entry = await getAssetEntryByTagId(nfcTagId)
  if (!entry) return null
  const assetType = await getAssetType(entry.assetTypeId)
  if (!assetType) return null
  return { entry, assetType }
}
