import { useState, useCallback, useEffect } from 'react'
import {
  getAllLocations,
  getLocation,
  saveLocation,
  updateLocation,
  deleteLocation,
  getAllPlantSystems,
  getPlantSystem,
  savePlantSystem,
  updatePlantSystem,
  deletePlantSystem,
  getAllMainFunctions,
  getMainFunction,
  saveMainFunction,
  updateMainFunction,
  deleteMainFunction,
  getAllSubFunctions,
  getSubFunction,
  saveSubFunction,
  updateSubFunction,
  deleteSubFunction
} from '@/services/storage'
import type { Location, PlantSystem, MainFunction, SubFunction } from '@/types'

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export function useLocations() {
  const [locations, setLocations] = useState<Location[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setLocations(await getAllLocations())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addLocation = useCallback(
    async (data: Omit<Location, 'id' | 'createdAt' | 'updatedAt'>) => {
      const result = await saveLocation(data)
      await refresh()
      return result
    },
    [refresh]
  )

  const editLocation = useCallback(
    async (id: string, updates: Partial<Omit<Location, 'id' | 'createdAt'>>) => {
      await updateLocation(id, updates)
      await refresh()
    },
    [refresh]
  )

  const removeLocation = useCallback(
    async (id: string) => {
      await deleteLocation(id)
      await refresh()
    },
    [refresh]
  )

  return { locations, loading, refresh, addLocation, editLocation, removeLocation }
}

// ---------------------------------------------------------------------------
// Plant Systems
// ---------------------------------------------------------------------------

export function usePlantSystems() {
  const [systems, setSystems] = useState<PlantSystem[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setSystems(await getAllPlantSystems())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addSystem = useCallback(
    async (data: Omit<PlantSystem, 'id' | 'createdAt' | 'updatedAt'>) => {
      const result = await savePlantSystem(data)
      await refresh()
      return result
    },
    [refresh]
  )

  const editSystem = useCallback(
    async (id: string, updates: Partial<Omit<PlantSystem, 'id' | 'createdAt'>>) => {
      await updatePlantSystem(id, updates)
      await refresh()
    },
    [refresh]
  )

  const removeSystem = useCallback(
    async (id: string) => {
      await deletePlantSystem(id)
      await refresh()
    },
    [refresh]
  )

  return { systems, loading, refresh, addSystem, editSystem, removeSystem }
}

// ---------------------------------------------------------------------------
// Main Functions
// ---------------------------------------------------------------------------

export function useMainFunctions() {
  const [mainFunctions, setMainFunctions] = useState<MainFunction[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setMainFunctions(await getAllMainFunctions())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addMainFunction = useCallback(
    async (data: Omit<MainFunction, 'id' | 'createdAt' | 'updatedAt'>) => {
      const result = await saveMainFunction(data)
      await refresh()
      return result
    },
    [refresh]
  )

  const editMainFunction = useCallback(
    async (id: string, updates: Partial<Omit<MainFunction, 'id' | 'createdAt'>>) => {
      await updateMainFunction(id, updates)
      await refresh()
    },
    [refresh]
  )

  const removeMainFunction = useCallback(
    async (id: string) => {
      await deleteMainFunction(id)
      await refresh()
    },
    [refresh]
  )

  return { mainFunctions, loading, refresh, addMainFunction, editMainFunction, removeMainFunction }
}

// ---------------------------------------------------------------------------
// Sub Functions
// ---------------------------------------------------------------------------

export function useSubFunctions() {
  const [subFunctions, setSubFunctions] = useState<SubFunction[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setSubFunctions(await getAllSubFunctions())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addSubFunction = useCallback(
    async (data: Omit<SubFunction, 'id' | 'createdAt' | 'updatedAt'>) => {
      const result = await saveSubFunction(data)
      await refresh()
      return result
    },
    [refresh]
  )

  const editSubFunction = useCallback(
    async (id: string, updates: Partial<Omit<SubFunction, 'id' | 'createdAt'>>) => {
      await updateSubFunction(id, updates)
      await refresh()
    },
    [refresh]
  )

  const removeSubFunction = useCallback(
    async (id: string) => {
      await deleteSubFunction(id)
      await refresh()
    },
    [refresh]
  )

  return { subFunctions, loading, refresh, addSubFunction, editSubFunction, removeSubFunction }
}

// ---------------------------------------------------------------------------
// Filtered sub functions by parent
// ---------------------------------------------------------------------------

export function useSubFunctionsByParent(
  mainFunctionId?: string,
  systemId?: string,
  locationId?: string
) {
  const { subFunctions, loading, refresh } = useSubFunctions()

  const filtered = subFunctions.filter(sf => {
    if (mainFunctionId) return sf.mainFunctionId === mainFunctionId
    if (systemId) return sf.systemId === systemId
    if (locationId) return sf.locationId === locationId
    return true
  })

  return { subFunctions: filtered, loading, refresh }
}

// Re-export getters for one-off lookups
export { getLocation, getPlantSystem, getMainFunction, getSubFunction }
