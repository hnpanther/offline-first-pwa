import { useEffect, useCallback } from 'react'
import { useAppStore } from '@/store'
import { getSettings, saveSettings } from '@/services/storage'
import type { AppSettings } from '@/types'

export function useSettings() {
  const settings = useAppStore(s => s.settings)
  const settingsLoaded = useAppStore(s => s.settingsLoaded)
  const setSettings = useAppStore(s => s.setSettings)
  const setSettingsLoaded = useAppStore(s => s.setSettingsLoaded)

  useEffect(() => {
    if (settingsLoaded) return
    getSettings().then(s => {
      setSettings(s)
      setSettingsLoaded(true)
    })
  }, [settingsLoaded, setSettings, setSettingsLoaded])

  const updateSettings = useCallback(
    async (updates: Partial<AppSettings>) => {
      const merged = { ...settings, ...updates }
      await saveSettings(merged)
      setSettings(merged)
    },
    [settings, setSettings]
  )

  return { settings, settingsLoaded, updateSettings }
}
