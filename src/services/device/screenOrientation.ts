/**
 * Locking the app to an orientation on phones and tablets.
 *
 * This is a **device preference, not an account one**: the right answer depends on how the
 * tablet is mounted on that trolley, so it lives in local settings and never syncs. A shared
 * account signing in on a wall-mounted tablet and a hand-held phone should not drag one
 * device's choice onto the other.
 *
 * ## Why every failure is swallowed
 * `screen.orientation.lock()` is unevenly supported and refuses for reasons that are not the
 * operator's problem: desktop browsers have no orientation to lock, iOS Safari does not
 * implement it at all, and Chrome rejects it outside an installed (standalone/fullscreen) PWA.
 * A rejection means "this device rotates freely", which is precisely the Auto behaviour — so
 * there is nothing to report and nothing for anyone to do. Surfacing an error here would put a
 * scary red banner in front of an operator over a setting that simply does not apply to the
 * browser they happen to be using.
 */

export type ScreenOrientationMode = 'auto' | 'portrait' | 'landscape'

export const SCREEN_ORIENTATION_MODES: ScreenOrientationMode[] = ['auto', 'portrait', 'landscape']

export function isScreenOrientationMode(value: unknown): value is ScreenOrientationMode {
  return typeof value === 'string' && (SCREEN_ORIENTATION_MODES as string[]).includes(value)
}

/**
 * The lock type passed to the platform.
 *
 * `portrait` / `landscape` rather than `portrait-primary` / `landscape-primary`: the primary
 * variants pin one specific way up, so a tablet rotated 180° in its cradle would show an
 * upside-down app. The looser value keeps the axis while letting the device pick the way up.
 */
type OrientationLockType = 'portrait' | 'landscape'

/**
 * The parts of `screen.orientation` we use, both optional.
 *
 * Not `extends ScreenOrientation`: the DOM lib declares `unlock` as always present, which is a
 * promise the runtime does not keep — iOS Safari has no `lock`/`unlock` at all. Describing what
 * may actually be there is what lets the guards below be real checks rather than decoration.
 */
type LockableOrientation = {
  lock?: (orientation: OrientationLockType) => Promise<void>
  unlock?: () => void
}

function orientationApi(): LockableOrientation | null {
  if (typeof screen === 'undefined') return null
  const api = screen.orientation as unknown as LockableOrientation | undefined
  return api ?? null
}

/** Whether this browser exposes orientation locking at all — used only to explain the UI. */
export function isOrientationLockSupported(): boolean {
  const api = orientationApi()
  return !!api && typeof api.lock === 'function'
}

/**
 * Applies the stored preference. Safe to call repeatedly and on every settings change.
 *
 * @returns true when a lock was actually applied; false when the device rotates freely,
 *          whether because Auto was chosen or because locking is unavailable
 */
export async function applyScreenOrientation(mode: ScreenOrientationMode): Promise<boolean> {
  const api = orientationApi()
  if (!api) return false

  if (mode === 'auto') {
    // Releasing a lock that was never taken is harmless, and this is what makes switching
    // back to Auto take effect without a reload.
    try {
      api.unlock?.()
    } catch {
      /* Nothing to release, or the platform does not allow it. Either way: free rotation. */
    }
    return false
  }

  if (typeof api.lock !== 'function') return false

  try {
    await api.lock(mode)
    return true
  } catch {
    // Not installed as a PWA, unsupported browser, or refused by the platform. The app keeps
    // working and simply rotates with the device.
    return false
  }
}
