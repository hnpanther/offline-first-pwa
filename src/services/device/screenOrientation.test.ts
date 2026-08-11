import { describe, it, expect, vi, afterEach } from 'vitest'
import { applyScreenOrientation, isOrientationLockSupported } from './screenOrientation'

/**
 * The orientation lock is the one setting that talks to a browser API the target devices
 * implement unevenly, so what matters is that every refusal degrades to "the device rotates
 * freely" rather than to an error in front of an operator.
 */
function stubOrientation(api: unknown) {
  Object.defineProperty(globalThis, 'screen', {
    value: api === null ? {} : { orientation: api },
    configurable: true,
    writable: true
  })
}

afterEach(() => {
  Object.defineProperty(globalThis, 'screen', { value: {}, configurable: true, writable: true })
})

describe('applyScreenOrientation', () => {
  it('locks to the chosen axis', async () => {
    const lock = vi.fn().mockResolvedValue(undefined)
    stubOrientation({ lock, unlock: vi.fn() })

    await expect(applyScreenOrientation('portrait')).resolves.toBe(true)
    // The loose axis, not portrait-primary: a tablet upside-down in its cradle must not end
    // up showing an upside-down app.
    expect(lock).toHaveBeenCalledWith('portrait')

    await applyScreenOrientation('landscape')
    expect(lock).toHaveBeenCalledWith('landscape')
  })

  it('releases the lock for auto rather than leaving the last one in place', async () => {
    const unlock = vi.fn()
    stubOrientation({ lock: vi.fn(), unlock })

    await expect(applyScreenOrientation('auto')).resolves.toBe(false)
    // Without this, switching back to Auto would do nothing until the app was relaunched.
    expect(unlock).toHaveBeenCalled()
  })

  it('reports free rotation when the platform refuses the lock', async () => {
    // Chrome rejects outside an installed PWA. That is not an error the operator can act on.
    stubOrientation({ lock: vi.fn().mockRejectedValue(new Error('not supported')), unlock: vi.fn() })

    await expect(applyScreenOrientation('portrait')).resolves.toBe(false)
  })

  it('does nothing when the browser has no lock at all', async () => {
    // iOS Safari: screen.orientation exists but cannot lock.
    stubOrientation({})

    await expect(applyScreenOrientation('landscape')).resolves.toBe(false)
    expect(isOrientationLockSupported()).toBe(false)
  })

  it('survives a browser with no screen.orientation whatsoever', async () => {
    stubOrientation(null)

    await expect(applyScreenOrientation('portrait')).resolves.toBe(false)
    await expect(applyScreenOrientation('auto')).resolves.toBe(false)
  })

  it('does not throw when unlock itself is rejected by the platform', async () => {
    stubOrientation({ lock: vi.fn(), unlock: vi.fn(() => { throw new Error('denied') }) })

    await expect(applyScreenOrientation('auto')).resolves.toBe(false)
  })
})
