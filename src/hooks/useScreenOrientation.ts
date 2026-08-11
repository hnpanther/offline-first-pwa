import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { applyScreenOrientation } from '@/services/device/screenOrientation'

/**
 * Keeps the device's orientation lock in step with the stored preference.
 *
 * Mounted once near the root so the lock is applied on every launch, not only when someone
 * happens to open Settings — the requirement is that the choice survives closing and
 * reopening the app, and a lock does not persist across launches by itself.
 *
 * Waits for `settingsLoaded`: applying the default before the stored row arrives would
 * unlock a device that had asked to stay locked, for the moment it takes Dexie to answer.
 */
export function useScreenOrientation(): void {
  const settingsLoaded = useAppStore(s => s.settingsLoaded)
  const mode = useAppStore(s => s.settings.screenOrientation)

  useEffect(() => {
    if (!settingsLoaded) return
    void applyScreenOrientation(mode ?? 'auto')
  }, [settingsLoaded, mode])
}
