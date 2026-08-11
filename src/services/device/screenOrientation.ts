/**
 * Locking the app to an orientation on phones and tablets.
 *
 * This is a **device preference, not an account one**: the right answer depends on how the
 * tablet is mounted on that trolley, so it lives in local settings and never syncs. A shared
 * account signing in on a wall-mounted tablet and a hand-held phone should not drag one
 * device's choice onto the other.
 *
 * ## Why failures are reported rather than swallowed
 * `screen.orientation.lock()` is unevenly supported and refuses for reasons that are not the
 * operator's problem: desktop browsers have no orientation to lock, iOS Safari does not
 * implement it at all, and Chrome rejects it outside an installed (standalone/fullscreen) PWA.
 * The app keeps working in every case — it simply rotates freely — so nothing here ever throws.
 *
 * But swallowing the reason entirely was a mistake: an administrator who picks Landscape and
 * watches the tablet keep rotating has no way to tell a browser that cannot lock from a setting
 * that did not save. So the outcome is returned, and the Settings screen states it plainly.
 * The distinction that matters most is `notInstalled`: Chrome refuses to lock a page opened in
 * a normal tab, and "open the app from its installed icon" is something a person can actually
 * act on — whereas a bare "locking failed" invites a support call nobody can answer.
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
 * Whether the app is running as an installed PWA rather than in a browser tab.
 *
 * This is the gate Chrome actually applies: `lock()` is refused for a page in a normal tab no
 * matter how the manifest is written. Installing from the Chrome menu usually produces a
 * standalone window, but "Add to Home screen" can produce a plain shortcut that still opens a
 * tab — which looks installed to the person who did it and is not.
 */
export function isInstalledDisplayMode(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  const standalone = ['standalone', 'fullscreen', 'minimal-ui'].some(
    mode => window.matchMedia(`(display-mode: ${mode})`).matches
  )
  // iOS reports installation only through this non-standard flag.
  const iosStandalone =
    typeof navigator !== 'undefined' && (navigator as { standalone?: boolean }).standalone === true
  return standalone || iosStandalone
}

export type OrientationOutcome =
  /** A lock is in force. */
  | { applied: true }
  /** The device rotates freely, for the stated reason. */
  | { applied: false; reason: 'auto' | 'unsupported' | 'notInstalled' | 'refused'; detail?: string }

/**
 * Applies the stored preference. Safe to call repeatedly and on every settings change.
 *
 * Never throws: a device that will not lock is a device that rotates, which the app handles.
 * The outcome is returned so the Settings screen can say which of those happened.
 */
export async function applyScreenOrientation(mode: ScreenOrientationMode): Promise<OrientationOutcome> {
  const api = orientationApi()
  if (!api) return { applied: false, reason: 'unsupported' }

  if (mode === 'auto') {
    // Releasing a lock that was never taken is harmless, and this is what makes switching
    // back to Auto take effect without a reload.
    try {
      api.unlock?.()
    } catch {
      /* Nothing to release, or the platform does not allow it. Either way: free rotation. */
    }
    return { applied: false, reason: 'auto' }
  }

  if (typeof api.lock !== 'function') return { applied: false, reason: 'unsupported' }

  try {
    await api.lock(mode)
    return { applied: true }
  } catch (err) {
    // Report the reason the person can act on ahead of the raw platform error: running in a
    // tab is by far the most common cause and the only one with a fix.
    if (!isInstalledDisplayMode()) return { applied: false, reason: 'notInstalled' }
    return {
      applied: false,
      reason: 'refused',
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    }
  }
}
