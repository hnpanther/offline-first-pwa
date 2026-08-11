import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  applyScreenOrientation,
  isInstalledDisplayMode,
  isOrientationLockSupported
} from './screenOrientation'

/**
 * The orientation lock is the one setting that talks to a browser API the target devices
 * implement unevenly, so what matters is that every refusal degrades to "the device rotates
 * freely" rather than to an error in front of an operator — while still naming the reason,
 * because an administrator staring at a tablet that keeps rotating has nothing else to go on.
 */
function stubOrientation(api: unknown) {
  Object.defineProperty(globalThis, 'screen', {
    value: api === null ? {} : { orientation: api },
    configurable: true,
    writable: true
  })
}

/**
 * Chrome refuses to lock a page running in a tab, so the tests must control this.
 * These run under the `node` environment, so `window` has to be supplied outright.
 */
function stubDisplayMode(installed: boolean) {
  Object.defineProperty(globalThis, 'window', {
    value: {
      matchMedia: (query: string) => ({ matches: installed && query.includes('standalone') })
    },
    configurable: true,
    writable: true
  })
}

afterEach(() => {
  Object.defineProperty(globalThis, 'screen', { value: {}, configurable: true, writable: true })
  Reflect.deleteProperty(globalThis, 'window')
  vi.unstubAllGlobals()
})

describe('applyScreenOrientation', () => {
  it('locks to the chosen axis', async () => {
    const lock = vi.fn().mockResolvedValue(undefined)
    stubOrientation({ lock, unlock: vi.fn() })

    await expect(applyScreenOrientation('portrait')).resolves.toEqual({ applied: true })
    // The loose axis, not portrait-primary: a tablet upside-down in its cradle must not end
    // up showing an upside-down app.
    expect(lock).toHaveBeenCalledWith('portrait')

    await applyScreenOrientation('landscape')
    expect(lock).toHaveBeenCalledWith('landscape')
  })

  it('releases the lock for auto rather than leaving the last one in place', async () => {
    const unlock = vi.fn()
    stubOrientation({ lock: vi.fn(), unlock })

    await expect(applyScreenOrientation('auto')).resolves.toEqual({
      applied: false,
      reason: 'auto'
    })
    // Without this, switching back to Auto would do nothing until the app was relaunched.
    expect(unlock).toHaveBeenCalled()
  })

  it('blames the browser tab when the lock is refused outside an installed app', async () => {
    // The most common cause by far, and the only one with a fix the person can carry out:
    // Chrome refuses to lock a page opened in a tab no matter what the manifest says.
    stubOrientation({ lock: vi.fn().mockRejectedValue(new Error('not supported')), unlock: vi.fn() })
    stubDisplayMode(false)

    await expect(applyScreenOrientation('portrait')).resolves.toEqual({
      applied: false,
      reason: 'notInstalled'
    })
  })

  it('reports the platform reason when an installed app is still refused', async () => {
    // Installed and still refused means the device itself said no — a different message,
    // because telling someone to install an app they already installed helps nobody.
    const err = new DOMException('locking not available', 'NotSupportedError')
    stubOrientation({ lock: vi.fn().mockRejectedValue(err), unlock: vi.fn() })
    stubDisplayMode(true)

    const outcome = await applyScreenOrientation('landscape')
    expect(outcome.applied).toBe(false)
    expect(outcome).toMatchObject({ reason: 'refused' })
    // The raw platform text is kept so a support conversation has something concrete in it.
    expect((outcome as { detail?: string }).detail).toContain('NotSupportedError')
  })

  it('does nothing when the browser has no lock at all', async () => {
    // iOS Safari: screen.orientation exists but cannot lock.
    stubOrientation({})

    await expect(applyScreenOrientation('landscape')).resolves.toEqual({
      applied: false,
      reason: 'unsupported'
    })
    expect(isOrientationLockSupported()).toBe(false)
  })

  it('survives a browser with no screen.orientation whatsoever', async () => {
    stubOrientation(null)

    await expect(applyScreenOrientation('portrait')).resolves.toEqual({
      applied: false,
      reason: 'unsupported'
    })
    await expect(applyScreenOrientation('auto')).resolves.toEqual({
      applied: false,
      reason: 'unsupported'
    })
  })

  it('does not throw when unlock itself is rejected by the platform', async () => {
    stubOrientation({ lock: vi.fn(), unlock: vi.fn(() => { throw new Error('denied') }) })

    await expect(applyScreenOrientation('auto')).resolves.toEqual({
      applied: false,
      reason: 'auto'
    })
  })
})

describe('isInstalledDisplayMode', () => {
  it('recognises an installed app', () => {
    stubDisplayMode(true)
    expect(isInstalledDisplayMode()).toBe(true)
  })

  it('recognises a plain browser tab', () => {
    // "Add to Home screen" can produce a shortcut that still opens a tab, which looks
    // installed to whoever did it and is exactly the case this has to catch.
    stubDisplayMode(false)
    expect(isInstalledDisplayMode()).toBe(false)
  })
})
