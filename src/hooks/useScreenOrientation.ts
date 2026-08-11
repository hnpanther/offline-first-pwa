import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { applyScreenOrientation, type OrientationOutcome } from '@/services/device/screenOrientation'

/**
 * Keeps the device's orientation lock in step with the stored preference.
 *
 * Mounted once near the root so the lock is applied on every launch, not only when someone
 * happens to open Settings — the requirement is that the choice survives closing and
 * reopening the app, and a lock does not persist across launches by itself.
 *
 * Waits for `settingsLoaded`: applying the default before the stored row arrives would
 * unlock a device that had asked to stay locked, for the moment it takes Dexie to answer.
 *
 * Re-applies when the app returns to the foreground. Android drops the lock when a PWA is
 * backgrounded and restored from the task switcher, and that is the ordinary way an operator
 * uses the app all shift — without this the setting appears to work once and then stop.
 *
 * @returns the last outcome, so Settings can say whether the lock actually took hold
 */
export function useScreenOrientation(): OrientationOutcome | null {
  const settingsLoaded = useAppStore(s => s.settingsLoaded)
  const mode = useAppStore(s => s.settings.screenOrientation)
  const [outcome, setOutcome] = useState<OrientationOutcome | null>(null)

  useEffect(() => {
    if (!settingsLoaded) return

    let cancelled = false
    const apply = () => {
      void applyScreenOrientation(mode ?? 'auto').then(result => {
        if (!cancelled) setOutcome(result)
      })
    }

    apply()

    const onVisible = () => {
      if (document.visibilityState === 'visible') apply()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [settingsLoaded, mode])

  return outcome
}
