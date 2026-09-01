import { afterEach, describe, expect, it } from 'vitest'
import { currentPlatform, isNativeApp, nativePlugin } from '@/services/device/nativeApp'

/**
 * Telling the packaged app apart from a browser.
 *
 * <h2>The bug this closes</h2>
 *
 * `InstallPwaPrompt` hid itself on `display-mode: standalone`, which is the right test for an
 * installed PWA and the wrong one for the packaged app: a Capacitor WebView reports
 * `display-mode: browser`, because no manifest is applied and there is no browser chrome to
 * hide. So an operator who had just installed the APK was shown instructions for installing it.
 *
 * <h2>Why a global rather than an import</h2>
 *
 * Capacitor injects `window.Capacitor` into the WebView and nowhere else. Reading it keeps
 * `@capacitor/core` out of the web bundle, so the `dist/` served by nginx is unchanged by the
 * packaged app existing at all — which is what these cases pin: **absent must mean web**, not
 * throw and not guess.
 *
 * <p>The suite runs on `environment: 'node'`, so `window` is assembled here rather than assumed.
 * That is not a workaround: it is the only way to exercise the "no window at all" branch, which
 * is what a module-scope evaluation during a build would hit.
 */

type Cap = {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
  Plugins?: Record<string, unknown>
}

function withWindow(capacitor?: Cap): void {
  ;(globalThis as { window?: unknown }).window = capacitor ? { Capacitor: capacitor } : {}
}

const native = (extra: Partial<Cap> = {}): Cap => ({
  isNativePlatform: () => true,
  getPlatform: () => 'android',
  ...extra
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('isNativeApp', () => {
  /** No `window` at all — module scope during a build, or any non-browser evaluation. */
  it('is false where there is no window', () => {
    expect(isNativeApp()).toBe(false)
  })

  it('is false in a browser, where there is no Capacitor global', () => {
    withWindow()

    expect(isNativeApp()).toBe(false)
  })

  it('is true inside the packaged app', () => {
    withWindow(native())

    expect(isNativeApp()).toBe(true)
  })

  /**
   * Capacitor's own web build defines the global and answers false. An installed PWA is still a
   * browser: the install prompt stays hidden there for the *standalone* reason, not this one,
   * and conflating the two would hide it in plain Chrome as well.
   */
  it('is false when Capacitor is present but running on the web', () => {
    withWindow({ isNativePlatform: () => false, getPlatform: () => 'web' })

    expect(isNativeApp()).toBe(false)
  })

  /** A global of an unexpected shape must not throw on a page that is otherwise fine. */
  it('survives a Capacitor global missing the method', () => {
    withWindow({})

    expect(isNativeApp()).toBe(false)
  })
})

describe('currentPlatform', () => {
  it('reports web when nothing is injected', () => {
    withWindow()

    expect(currentPlatform()).toBe('web')
  })

  it('reports the platform the app is packaged for', () => {
    withWindow(native())

    expect(currentPlatform()).toBe('android')
  })
})

describe('nativePlugin', () => {
  it('hands back a registered plugin', () => {
    const nfc = { startScan: () => {} }
    withWindow(native({ Plugins: { Nfc: nfc } }))

    expect(nativePlugin('Nfc')).toBe(nfc)
  })

  it('is undefined for a plugin this build does not ship', () => {
    withWindow(native({ Plugins: {} }))

    expect(nativePlugin('Nfc')).toBeUndefined()
  })

  /**
   * Never hand a plugin to the web. Capacitor's web build can define `Plugins` with browser
   * stand-ins; treating those as native would send `services/nfc` down the plugin path in
   * Chrome, where Web NFC is the only thing that actually works.
   */
  it('is undefined on the web even when Plugins exists', () => {
    withWindow({ isNativePlatform: () => false, Plugins: { Nfc: {} } })

    expect(nativePlugin('Nfc')).toBeUndefined()
  })

  it('is undefined when there is no window', () => {
    expect(nativePlugin('Nfc')).toBeUndefined()
  })
})
