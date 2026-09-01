/**
 * Whether this build is running inside the packaged app, rather than in a browser.
 *
 * <h2>Why the app has to know</h2>
 *
 * The same bundle ships two ways: served by nginx and opened in Chrome, or packaged by
 * Capacitor. Almost nothing needs to tell them apart — that is the point of shipping one bundle
 * — but the few places that talk about *installing*, or that reach for a native capability the
 * browser provides differently, do.
 *
 * `display-mode: standalone` does **not** answer this. A Capacitor WebView reports
 * `display-mode: browser`: there is no manifest being applied and no browser UI to hide, so
 * every check written for "is this an installed PWA" comes back false, and the install banner
 * appears to somebody who installed the app a minute ago.
 *
 * <h2>Read from the global, not imported</h2>
 *
 * Capacitor injects `window.Capacitor` into the WebView it creates, and defines it nowhere else.
 * Reading the global keeps `@capacitor/core` out of the web bundle entirely, so the `dist/` that
 * goes on nginx is byte-for-byte what it was before the packaged app existed — worth more than
 * the typing an import would buy.
 */

interface CapacitorPluginMap {
  [name: string]: unknown
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
  Plugins?: CapacitorPluginMap
}

function capacitor(): CapacitorGlobal | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor
}

/** True only inside the packaged app. False in every browser, including an installed PWA. */
export function isNativeApp(): boolean {
  return capacitor()?.isNativePlatform?.() === true
}

/**
 * `'android'`, `'ios'`, or `'web'` — the last for anything that is not the packaged app.
 *
 * Defaults to `'web'` rather than throwing: a browser has no Capacitor global at all, and that
 * is the ordinary case rather than an error.
 */
export function currentPlatform(): string {
  return capacitor()?.getPlatform?.() ?? 'web'
}

/**
 * One registered native plugin, or undefined when it is not there.
 *
 * <p>Undefined is a normal answer, not a failure: in a browser there are no plugins at all, and
 * a packaged build may ship without one this code knows about. Callers decide what to do
 * without it — `services/nfc` falls back to Web NFC, for instance — so this never throws.
 */
export function nativePlugin<T>(name: string): T | undefined {
  if (!isNativeApp()) return undefined
  return capacitor()?.Plugins?.[name] as T | undefined
}
